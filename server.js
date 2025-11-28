require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Brevo = require("@getbrevo/brevo");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());
app.use(cors());

// Trust proxy so req.ip works correctly behind Render / reverse proxies
app.set("trust proxy", true);

/* ===========================
   CONSTANTS
   =========================== */

const FROM_NAME = process.env.FROM_NAME || "Shore Roleplay";
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@shoreroleplay.xyz";
const HAS_BREVO_KEY = !!process.env.BREVO_API_KEY;

/* ===========================
   BREVO INITIALIZATION
   =========================== */

let brevoApi = null;
if (HAS_BREVO_KEY) {
  try {
    const client = Brevo.ApiClient.instance;
    client.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;
    client.basePath = "https://api.brevo.com/v3";
    brevoApi = new Brevo.TransactionalEmailsApi();
    console.log("✅ Brevo email client ready");
  } catch (err) {
    console.error("❌ Brevo init failed", err);
    brevoApi = null;
  }
} else {
  console.warn("⚠️ Missing BREVO_API_KEY (emails disabled)");
}

/* ===========================
   MONGODB CONNECTION
   =========================== */

if (!process.env.MONGO_URI) {
  console.error("❌ MONGO_URI missing in .env");
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

initDB().catch((err) => {
  console.error("❌ Mongo init error:", err);
  process.exit(1);
});

/* ===========================
   EMAIL TEMPLATES
   =========================== */

const { acceptedEmail, deniedEmail } = require("./emailTemplates");

/* ===========================
   EMAIL SENDER
   =========================== */

async function sendDecisionEmail(status, user) {
  const html =
    status === "accepted"
      ? acceptedEmail({ username: user.username })
      : deniedEmail({ username: user.username });

  const subject =
    status === "accepted"
      ? "Your Shore Roleplay Application Has Been Approved"
      : "Your Shore Roleplay Application Status";

  if (!brevoApi) {
    console.log("📧 [DEV MODE] Skipped email:", { to: user.email, subject });
    return;
  }

  try {
    const email = new Brevo.SendSmtpEmail();
    email.sender = { name: FROM_NAME, email: FROM_EMAIL };
    email.to = [{ email: user.email, name: user.username }];
    email.subject = subject;
    email.htmlContent = html;

    await brevoApi.sendTransacEmail(email);
    console.log(`📧 Email sent → ${user.email}`);
  } catch (err) {
    console.error("❌ Email error:", err.response?.body || err);
  }
}

/* ===========================
   HELPERS
   =========================== */

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    hwid: user.hwid,
    banned: !!user.banned,
    lastIP: user.lastIP || null,
    createdAt: user.createdAt || null,
    lastLoginAt: user.lastLoginAt || null,
  };
}

/* ===========================
   ROUTES
   =========================== */

// HEALTH CHECK
app.get("/", (req, res) => res.send("Shore Roleplay Backend Online 🚀"));

/* ===========================
   APPLICATION ROUTES
   =========================== */

// GET ALL APPLICATIONS
app.get("/applications", async (req, res) => {
  try {
    const apps = await Applications.find({}).toArray();
    res.json(apps);
  } catch (err) {
    console.error("❌ /applications error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// STAFF AUTH (for main staff panel)
app.post("/staff-auth", (req, res) => {
  if (!process.env.STAFF_PANEL_PASSWORD)
    return res.status(500).json({ error: "Staff password not set" });

  if (req.body.password === process.env.STAFF_PANEL_PASSWORD) {
    return res.json({ success: true });
  }
  return res.status(401).json({ error: "Invalid password" });
});

// HA AUTH (for HA tab)
app.post("/staff-ha-auth", (req, res) => {
  if (!process.env.STAFF_HA_PASSWORD) {
    return res.status(500).json({ error: "HA password not set" });
  }
  if (req.body.password === process.env.STAFF_HA_PASSWORD) {
    return res.json({ success: true });
  }
  return res.status(401).json({ error: "Invalid HA password" });
});

/* APPLICATION SUBMISSION */
app.post("/apply", async (req, res) => {
  try {
    const {
      id,
      username,
      email,
      department,
      reason,
      agreedLogging,
      agreedDiscord,
    } = req.body;

    if (!id || typeof id !== "string")
      return res.status(400).json({ error: "Invalid ID" });
    if (!username || username.length < 3)
      return res.status(400).json({ error: "Invalid username" });
    if (!email || !email.includes("@"))
      return res.status(400).json({ error: "Invalid email" });
    if (!department)
      return res.status(400).json({ error: "Select a department" });
    if (!reason || reason.length < 100)
      return res.status(400).json({ error: "Reason too short" });
    if (!agreedLogging || !agreedDiscord)
      return res.status(400).json({ error: "Agreements required" });

    const exists = await Applications.findOne({
      $or: [{ id }, { email }],
    });
    if (exists)
      return res.status(409).json({ error: "Application already exists" });

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

    res.json({ success: true, message: "Application received" });
  } catch (err) {
    console.error("❌ Apply Error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/* APPLICATION DECISION */
app.post("/applications/:id/decision", async (req, res) => {
  try {
    const { status } = req.body;
    if (!["accepted", "denied"].includes(status))
      return res.status(400).json({ error: "Invalid status" });

    const appData = await Applications.findOne({ id: req.params.id });
    if (!appData) return res.status(404).json({ error: "Not found" });

    await Applications.updateOne(
      { id: req.params.id },
      { $set: { status } }
    );
    await sendDecisionEmail(status, appData);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Decision Error:", err);
    res.status(500).json({ error: "Decision processing failed" });
  }
});

/* DELETE APPLICATION */
app.delete("/applications/:id", async (req, res) => {
  try {
    const result = await Applications.deleteOne({ id: req.params.id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json({ success: true, message: "Application deleted" });
  } catch (err) {
    console.error("❌ Delete application error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/* ===========================
   USER ROUTES
   =========================== */

/* USER REGISTRATION */
app.post("/users/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || username.length < 3)
      return res.status(400).json({ error: "Bad username" });
    if (!email || !email.includes("@"))
      return res.status(400).json({ error: "Bad email" });
    if (!password || password.length < 6)
      return res.status(400).json({ error: "Bad password" });

    const exists = await Users.findOne({ email });
    if (exists) return res.status(409).json({ error: "Email used" });

    const now = new Date().toISOString();

    await Users.insertOne({
      id: crypto.randomUUID(),
      username,
      email,
      password, // TODO: hash later
      role: "user",
      hwid: crypto.randomUUID(), // "hardware id" for banning
      banned: false,
      createdAt: now,
      lastLoginAt: null,
      lastIP: null,
    });

    res.json({ success: true, message: "Account created" });
  } catch (err) {
    console.error("❌ Register Error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

/* USER LOGIN (capture IP + check banned) */
app.post("/users/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await Users.findOne({ email, password });

    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (user.banned)
      return res.status(403).json({ error: "Account is banned" });

    const now = new Date().toISOString();
    const ip = req.ip;

    await Users.updateOne(
      { _id: user._id },
      { $set: { lastIP: ip, lastLoginAt: now } }
    );

    // reflect updates in the object we're returning
    user.lastIP = ip;
    user.lastLoginAt = now;

    res.json({
      success: true,
      message: "Login OK",
      user: sanitizeUser(user),
    });
  } catch (err) {
    console.error("❌ Login Error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

/* HA: GET ALL USERS (for HA tab) */
app.get("/users", async (req, res) => {
  try {
    const raw = await Users.find({}, { projection: { password: 0 } }).toArray();
    res.json(raw.map(sanitizeUser));
  } catch (err) {
    console.error("❌ /users list error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/* HA: BAN USER (flag) */
app.post("/users/:id/ban", async (req, res) => {
  try {
    const result = await Users.updateOne(
      { id: req.params.id },
      { $set: { banned: true } }
    );
    if (result.matchedCount === 0)
      return res.status(404).json({ error: "User not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Ban user error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/* HA: UNBAN USER */
app.post("/users/:id/unban", async (req, res) => {
  try {
    const result = await Users.updateOne(
      { id: req.params.id },
      { $set: { banned: false } }
    );
    if (result.matchedCount === 0)
      return res.status(404).json({ error: "User not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Unban user error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/* HA: DELETE USER (and optionally their apps) */
app.delete("/users/:id", async (req, res) => {
  try {
    const user = await Users.findOne({ id: req.params.id });
    if (!user) return res.status(404).json({ error: "User not found" });

    await Users.deleteOne({ id: req.params.id });

    // Optional: also delete all applications from this email
    await Applications.deleteMany({ email: user.email });

    res.json({ success: true, message: "User (and apps) deleted" });
  } catch (err) {
    console.error("❌ Delete user error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/* ===========================
   START SERVER
   =========================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on ${PORT}`));
