require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Brevo = require("@getbrevo/brevo");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());
app.use(cors());

/* ===========================
   CONSTANTS
   =========================== */

const FROM_NAME = process.env.FROM_NAME || "Shore Roleplay";
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@shoreroleplay.xyz";

const STAFF_PASS = process.env.STAFF_PANEL_PASSWORD;
const HA_PASS = process.env.HEAD_ADMIN_PASSWORD; // 🔥 NEW

const HAS_BREVO_KEY = !!process.env.BREVO_API_KEY;

/* ===========================
   BREVO EMAIL INIT
   =========================== */

let brevoApi = null;
if (HAS_BREVO_KEY) {
  try {
    const client = Brevo.ApiClient.instance;
    client.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;
    client.basePath = "https://api.brevo.com/v3";
    brevoApi = new Brevo.TransactionalEmailsApi();
    console.log("📨 Brevo ready");
  } catch (err) {
    console.error("❌ Brevo failed", err);
  }
} else {
  console.warn("⚠ No BREVO_API_KEY set. Emails disabled.");
}

/* ===========================
   MONGO
   =========================== */

if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI missing");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGO_URI);
let db, Applications, Users;

async function initDB() {
  await client.connect();
  db = client.db("shoreRoleplay");
  Applications = db.collection("applications");
  Users = db.collection("users");
  console.log("📦 MongoDB connected");
}

initDB();

/* ===========================
   EMAIL TEMPLATES
   =========================== */
const { acceptedEmail, deniedEmail } = require("./emailTemplates");

/* ===========================
   EMAIL SENDER
   =========================== */

async function sendDecisionEmail(status, user) {
  const html = status === "accepted"
    ? acceptedEmail({ username: user.username })
    : deniedEmail({ username: user.username });

  const subject = status === "accepted"
    ? "Your Shore Roleplay Application Has Been Approved"
    : "Your Shore Roleplay Application Status";

  if (!brevoApi) {
    console.log("📧 [DEV MODE] Email skipped →", user.email);
    return;
  }

  try {
    const email = new Brevo.SendSmtpEmail();
    email.sender = { name: FROM_NAME, email: FROM_EMAIL };
    email.to = [{ email: user.email, name: user.username }];
    email.subject = subject;
    email.htmlContent = html;

    await brevoApi.sendTransacEmail(email);
    console.log("📧 Email sent to", user.email);
  } catch (err) {
    console.error("❌ Email error:", err.response?.body || err);
  }
}

/* ===========================
   ROUTES
   =========================== */

// ROOT
app.get("/", (_, res) => res.send("🏖️ Shore Roleplay Backend Online"));

// GET ALL APPLICATIONS
app.get("/applications", async (_, res) =>
  res.json(await Applications.find({}).toArray())
);

/* ===========================
   STAFF PANEL AUTH
   =========================== */
app.post("/staff-auth", (req, res) => {
  if (!STAFF_PASS) return res.status(500).json({ error: "Password not set" });
  req.body.password === STAFF_PASS
    ? res.json({ success: true })
    : res.status(401).json({ error: "Unauthorized" });
});

/* ===========================
   HEAD ADMIN AUTH (HA TAB)
   =========================== */
app.post("/ha-auth", (req, res) => {
  if (!HA_PASS) return res.status(500).json({ error: "HA password missing" });
  req.body.password === HA_PASS
    ? res.json({ success: true })
    : res.status(401).json({ error: "Unauthorized" });
});

/* ===========================
   SUBMIT APPLICATION
   =========================== */

app.post("/apply", async (req, res) => {
  try {
    const { id, username, email, department, reason, agreedLogging, agreedDiscord } = req.body;

    if (!id) return res.status(400).json({ error: "Missing ID" });
    if (!username || username.length < 3) return res.status(400).json({ error: "Bad username" });
    if (!email.includes("@")) return res.status(400).json({ error: "Bad email" });
    if (!reason || reason.length < 100) return res.status(400).json({ error: "Reason too short" });

    const exists = await Applications.findOne({ $or: [{ id }, { email }] });
    if (exists) return res.status(409).json({ error: "Already exists" });

    await Applications.insertOne({
      id,
      username,
      email,
      department,
      reason,
      agreedLogging: true,
      agreedDiscord: true,
      status: "pending",
      submittedAt: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ===========================
   APPLICATION DECISION
   =========================== */

app.post("/applications/:id/decision", async (req, res) => {
  const { status } = req.body;
  if (!["accepted", "denied"].includes(status))
    return res.status(400).json({ error: "Invalid status" });

  const appData = await Applications.findOne({ id: req.params.id });
  if (!appData) return res.status(404).json({ error: "Not found" });

  await Applications.updateOne({ id: req.params.id }, { $set: { status } });
  await sendDecisionEmail(status, appData);

  res.json({ success: true });
});

/* ===========================
   DELETE APPLICATION
   =========================== */

app.delete("/applications/:id", async (req, res) => {
  const result = await Applications.deleteOne({ id: req.params.id });
  result.deletedCount ? res.json({ success: true }) : res.status(404).json({ error: "Not found" });
});

/* ===========================
   USER REGISTRATION
   =========================== */

app.post("/users/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || username.length < 3) return res.status(400).json({ error: "Bad username" });
    if (!email.includes("@")) return res.status(400).json({ error: "Bad email" });
    if (!password || password.length < 6) return res.status(400).json({ error: "Bad password" });

    const exists = await Users.findOne({ email });
    if (exists) return res.status(409).json({ error: "Email in use" });

    await Users.insertOne({
      id: crypto.randomUUID(),
      username,
      email,
      password,
      role: "user",
      hwid: crypto.randomUUID(), // 🔥 HARDWARE ID
      banned: false,
      createdAt: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("REGISTER ERROR →", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

/* ===========================
   USER LOGIN
   =========================== */

app.post("/users/login", async (req, res) => {
  const user = await Users.findOne({ email: req.body.email, password: req.body.password });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  if (user.banned) return res.status(403).json({ error: "User banned" });

  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      hwid: user.hwid,
    },
  });
});

/* ===========================
   HEAD ADMIN USER CONTROL
   =========================== */

// GET ALL USERS
app.get("/users", async (_, res) => {
  res.json(await Users.find({}).toArray());
});

// BAN USER
app.post("/users/:id/ban", async (req, res) => {
  await Users.updateOne({ id: req.params.id }, { $set: { banned: true } });
  res.json({ success: true });
});

// UNBAN USER
app.post("/users/:id/unban", async (req, res) => {
  await Users.updateOne({ id: req.params.id }, { $set: { banned: false } });
  res.json({ success: true });
});

// DELETE USER
app.delete("/users/:id", async (req, res) => {
  await Users.deleteOne({ id: req.params.id });
  res.json({ success: true });
});

/* ===========================
   SERVER START
   =========================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend on ${PORT}`));
