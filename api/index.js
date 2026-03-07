const express = require("express");
const { MongoClient } = require("mongodb");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;

let cachedClient = global.mongoClient;
let cachedDb = global.mongoDb;

async function connectDB() {
  if (cachedClient && cachedDb) return cachedDb;

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("bulletraja");

  global.mongoClient = client;
  global.mongoDb = db;

  cachedClient = client;
  cachedDb = db;

  return db;
}

app.get("/", async (req, res) => {
  res.json({ status: "BulletRaja API running" });
});

app.post("/api/users", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId, name, role } = req.body;

    if (!deviceId || !name) {
      return res.status(400).json({ success: false });
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
          registeredAt: new Date()
        }
      },
      { upsert: true }
    );

    res.json({ success: true });

  } catch (e) {
    res.status(500).json({ success: false });
  }
});

app.get("/api/users", async (req, res) => {
  try {
    const db = await connectDB();

    const users = await db
      .collection("users")
      .find({})
      .sort({ lastSeen: -1 })
      .toArray();

    res.json(users);

  } catch (e) {
    res.status(500).json({ error: true });
  }
});

app.patch("/api/users/heartbeat", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId } = req.body;

    await db.collection("users").updateOne(
      { deviceId },
      { $set: { isOnline: true, lastSeen: new Date() } }
    );

    res.json({ success: true });

  } catch {
    res.status(500).json({ error: true });
  }
});

app.patch("/api/users/offline", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId } = req.body;

    await db.collection("users").updateOne(
      { deviceId },
      { $set: { isOnline: false, lastSeen: new Date() } }
    );

    res.json({ success: true });

  } catch {
    res.status(500).json({ error: true });
  }
});

app.post("/api/calllogs", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId, logs } = req.body;

    if (!deviceId || !Array.isArray(logs)) {
      return res.status(400).json({ success: false });
    }

    if (logs.length === 0) {
      return res.json({ success: true });
    }

    const ops = logs.map(log => ({
      updateOne: {
        filter: { deviceId, timestamp: log.timestamp, number: log.number },
        update: { $set: { deviceId, ...log, syncedAt: new Date() } },
        upsert: true
      }
    }));

    await db.collection("calllogs").bulkWrite(ops);

    res.json({ success: true });

  } catch {
    res.status(500).json({ success: false });
  }
});

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

  } catch {
    res.status(500).json({ error: true });
  }
});

app.post("/api/call/incoming", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId, phoneNumber, callerName, timestamp } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: true });
    }

    await db.collection("incomingcalls").deleteMany({
      deviceId,
      status: "ringing"
    });

    await db.collection("incomingcalls").insertOne({
      deviceId,
      phoneNumber: phoneNumber || "Unknown",
      callerName: callerName || "",
      status: "ringing",
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      createdAt: new Date()
    });

    res.json({ success: true });

  } catch {
    res.status(500).json({ error: true });
  }
});

app.post("/api/call/ended", async (req, res) => {
  try {
    const db = await connectDB();
    const { deviceId } = req.body;

    await db.collection("incomingcalls").updateMany(
      { deviceId, status: "ringing" },
      { $set: { status: "ended", endedAt: new Date() } }
    );

    res.json({ success: true });

  } catch {
    res.status(500).json({ error: true });
  }
});

app.get("/api/call/incoming/active", async (req, res) => {
  try {
    const db = await connectDB();

    await db.collection("incomingcalls").updateMany(
      {
        status: "ringing",
        createdAt: { $lt: new Date(Date.now() - 60000) }
      },
      { $set: { status: "ended" } }
    );

    const calls = await db
      .collection("incomingcalls")
      .find({ status: "ringing" })
      .sort({ createdAt: -1 })
      .toArray();

    res.json(calls);

  } catch {
    res.status(500).json({ error: true });
  }
});

app.get("/api/debug", async (req, res) => {
  try {
    const db = await connectDB();

    const users = await db.collection("users").find({}).toArray();
    const logs = await db.collection("calllogs").countDocuments();
    const calls = await db.collection("incomingcalls").find({}).toArray();

    res.json({
      users,
      callLogCount: logs,
      incomingCalls: calls
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = app;
