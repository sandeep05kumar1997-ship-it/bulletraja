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
