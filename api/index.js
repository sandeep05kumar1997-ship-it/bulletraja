import express from "express";
import { MongoClient } from "mongodb";

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// MongoDB connection (cached for Vercel)
const uri = process.env.MONGODB_URI;

let client;
let db;

async function connectDB() {
  if (db) return db;

  client = new MongoClient(uri);
  await client.connect();
  db = client.db("webrtcapp");

  console.log("✅ MongoDB Connected");
  return db;
}
// USERS
app.post("/api/users", async (req, res) => {
  try {
    const database = await connectDB();
    const users = database.collection("users");

    const { deviceId, name, role } = req.body;

    if (!deviceId || !name) {
      return res.status(400).json({ error: "deviceId and name required" });
    }

    await users.updateOne(
      { deviceId },
      {
        $set: {
          deviceId,
          name,
          role: role || "user",
          lastSeen: new Date()
        }
      },
      { upsert: true }
    );

    console.log("👤 User registered:", deviceId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});
// GET /api/calls — list all calls (admin)
app.get("/api/calls", async (req, res) => {
  try {
    const database = await connectDB();
    const calls = database.collection("calls");
    const { status } = req.query;
    const filter = status ? { status } : {};
    const data = await calls.find(filter).sort({ createdAt: -1 }).limit(50).toArray();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});
// Heartbeat — marks user online
app.patch("/api/users/heartbeat", async (req, res) => {
  try {
    const database = await connectDB();
    const { deviceId } = req.body;
    await database.collection("users").updateOne(
      { deviceId },
      { $set: { isOnline: true, lastSeen: new Date() } }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Mark offline
app.patch("/api/users/offline", async (req, res) => {
  try {
    const database = await connectDB();
    const { deviceId } = req.body;
    await database.collection("users").updateOne(
      { deviceId },
      { $set: { isOnline: false, lastSeen: new Date() } }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Store call logs
app.post("/api/calllogs", async (req, res) => {
  try {
    const database = await connectDB();
    const { deviceId, logs } = req.body;
    if (!deviceId || !logs) return res.status(400).json({ error: "Missing fields" });

    // Upsert each log by deviceId + timestamp to avoid duplicates
    const ops = logs.map(log => ({
      updateOne: {
        filter: { deviceId, timestamp: log.timestamp },
        update: { $set: { deviceId, ...log, syncedAt: new Date() } },
        upsert: true
      }
    }));

    if (ops.length > 0) {
      await database.collection("calllogs").bulkWrite(ops);
    }

    res.json({ success: true, count: logs.length });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Incoming call alert
app.post("/api/call/incoming", async (req, res) => {
  try {
    const database = await connectDB();
    const { deviceId, phoneNumber, callerName, timestamp } = req.body;
    await database.collection("incomingcalls").insertOne({
      deviceId, phoneNumber, callerName,
      status: "ringing",
      timestamp: new Date(timestamp),
      createdAt: new Date()
    });
    console.log(`📱 Incoming call on ${deviceId} from ${phoneNumber}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Call ended
app.post("/api/call/ended", async (req, res) => {
  try {
    const database = await connectDB();
    const { deviceId, phoneNumber } = req.body;
    await database.collection("incomingcalls").updateOne(
      { deviceId, phoneNumber, status: "ringing" },
      { $set: { status: "ended", endedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Admin: get call logs for a specific user
app.get("/api/calllogs/:deviceId", async (req, res) => {
  try {
    const database = await connectDB();
    const { deviceId } = req.params;
    const logs = await database.collection("calllogs")
      .find({ deviceId })
      .sort({ timestamp: -1 })
      .limit(100)
      .toArray();
    res.json(logs);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Admin: get active incoming calls (for alerting admin)
app.get("/api/call/incoming/active", async (req, res) => {
  try {
    const database = await connectDB();
    const calls = await database.collection("incomingcalls")
      .find({ status: "ringing" })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(calls);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.get("/api/users", async (req, res) => {
  try {
    const database = await connectDB();
    const users = database.collection("users");

    const data = await users.find({}).toArray();

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});
// Add this to your existing index.js

// Store admin FCM token
app.post("/api/admin/token", async (req, res) => {
  try {
    const database = await connectDB();
    const { fcmToken } = req.body;
    await database.collection("admin").updateOne(
      { type: "admin" },
      { $set: { fcmToken, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// START CALL
app.post("/api/call/start", async (req, res) => {
  try {
    const database = await connectDB();
    const calls = database.collection("calls");

    const { callId, callerId, receiverId } = req.body;

    if (!callId || !callerId || !receiverId) {
      return res.status(400).json({ error: "Missing fields" });
    }

    await calls.insertOne({
      callId,
      callerId,
      receiverId,
      offer: null,
      answer: null,
      candidates: [],
      status: "active",
      createdAt: new Date()
    });

    console.log("📞 Call started:", callId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// OFFER
app.post("/api/call/offer", async (req, res) => {
  try {
    const database = await connectDB();
    const calls = database.collection("calls");

    const { callId, offer } = req.body;

    await calls.updateOne(
      { callId },
      { $set: { offer } }
    );

    console.log("📡 Offer stored:", callId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ANSWER
app.post("/api/call/answer", async (req, res) => {
  try {
    const database = await connectDB();
    const calls = database.collection("calls");

    const { callId, answer } = req.body;

    await calls.updateOne(
      { callId },
      { $set: { answer } }
    );

    console.log("📡 Answer stored:", callId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ICE CANDIDATE
app.post("/api/call/candidate", async (req, res) => {
  try {
    const database = await connectDB();
    const calls = database.collection("calls");

    const { callId, candidate } = req.body;

    await calls.updateOne(
      { callId },
      { $push: { candidates: candidate } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// FETCH CALL DATA
app.get("/api/call/data", async (req, res) => {
  try {
    const database = await connectDB();
    const calls = database.collection("calls");

    const { callId } = req.query;

    const data = await calls.findOne({ callId });

    res.json(data || {});
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// END CALL
app.patch("/api/call/end", async (req, res) => {
  try {
    const database = await connectDB();
    const calls = database.collection("calls");

    const { callId } = req.body;

    await calls.updateOne(
      { callId },
      {
        $set: {
          status: "ended",
          endTime: new Date()
        }
      }
    );

    console.log("📴 Call ended:", callId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

export default app;
