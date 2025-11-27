require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const Brevo = require("@getbrevo/brevo");

const app = express();
app.use(express.json());
app.use(cors());

/* ===========================
   CONSTANTS
   =========================== */

const FROM_NAME = process.env.FROM_NAME || "Shore Roleplay";
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@shoreroleplay.xyz";
const HAS_BREVO_KEY = !!process.env.BREVO_API_KEY;

/* ===========================
   BREVO INITIALIZATION (FIXED)
   =========================== */

let brevoApi = null;

if (HAS_BREVO_KEY) {
  try {
    const client = Brevo.ApiClient.instance;

    // CORRECT AUTH FIELD
    client.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;

    // ABSOLUTELY REQUIRED FOR PRODUCTION DELIVERY
    client.basePath = "https://api.brevo.com/v3";

    brevoApi = new Brevo.TransactionalEmailsApi();

    console.log("✅ Brevo email client initialized and ready");
  } catch (err) {
    console.error("❌ Failed to initialize Brevo client:", err);
    brevoApi = null;
  }
} else {
  console.warn("⚠️ BREVO_API_KEY missing — emails will be logged only");
}

/* ===========================
   DATABASE
   =========================== */

const dbFile = path.join(__dirname, "applications.json");

function readDB() {
  if (!fs.existsSync(dbFile)) return [];
  return JSON.parse(fs.readFileSync(dbFile, "utf8"));
}

function writeDB(data) {
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
}

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
    console.log("📧 [DEV MODE] Email skipped:", { to: user.email, subject });
    return;
  }

  try {
    const email = new Brevo.SendSmtpEmail();
    email.sender = { name: FROM_NAME, email: FROM_EMAIL };
    email.to = [{ email: user.email, name: user.username }];
    email.subject = subject;
    email.htmlContent = html;

    await brevoApi.sendTransacEmail(email);

    console.log(`📧 Brevo email sent to ${user.email}`);
  } catch (err) {
    console.error("❌ EMAIL SEND ERROR:", err.response?.body || err);
    throw err;
  }
}

/* ===========================
   ROUTES
   =========================== */

// HEALTH CHECK
app.get("/", (req, res) => res.send("Shore Roleplay Backend Online 🚀"));

// GET ALL APPLICATIONS
app.get("/applications", (req, res) => res.json(readDB()));

// STAFF AUTH
app.post("/staff-auth", (req, res) => {
  const { password } = req.body;

  if (!process.env.STAFF_PANEL_PASSWORD)
    return res.status(500).json({ error: "Staff password not configured" });

  if (password === process.env.STAFF_PANEL_PASSWORD)
    return res.json({ success: true });

  res.status(401).json({ error: "Invalid password" });
});

/* ===========================
   APPLICATION SUBMISSION
   =========================== */

app.post("/apply", (req, res) => {
  try {
    const { id, username, email, department, reason, agreedLogging, agreedDiscord } = req.body;

    if (!id || typeof id !== "string")
      return res.status(400).json({ error: "Invalid or missing application ID" });

    if (!username || username.trim().length < 3)
      return res.status(400).json({ error: "Invalid username" });

    if (!email || !email.includes("@"))
      return res.status(400).json({ error: "Invalid email" });

    if (!department)
      return res.status(400).json({ error: "Department not selected" });

    if (!reason || reason.trim().length < 100)
      return res.status(400).json({ error: "Reason must be at least 100 characters" });

    if (!agreedLogging || !agreedDiscord)
      return res.status(400).json({ error: "Required agreements not accepted" });

    let db = readDB();

    if (db.some(a => a.id === id))
      return res.status(409).json({ error: "Duplicate application ID" });

    if (db.some(a => a.email.toLowerCase() === email.toLowerCase()))
      return res.status(409).json({ error: "Application already exists for this email" });

    db.push({
      id,
      username: username.trim(),
      email: email.toLowerCase().trim(),
      department,
      reason: reason.trim(),
      agreedLogging: true,
      agreedDiscord: true,
      status: "pending",
      submittedAt: new Date().toISOString()
    });

    writeDB(db);
    res.json({ success: true, message: "Application received" });
  } catch (err) {
    console.error("❌ Application Submit Error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

/* ===========================
   DECISION HANDLER
   =========================== */

app.post("/applications/:id/decision", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["accepted", "denied"].includes(status))
      return res.status(400).json({ error: "Invalid status" });

    const db = readDB();
    const idx = db.findIndex(a => a.id === id);

    if (idx === -1)
      return res.status(404).json({ error: "Application not found" });

    db[idx].status = status;
    writeDB(db);

    await sendDecisionEmail(status, db[idx]);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Decision error:", err);
    res.status(500).json({ error: "Email failed" });
  }
});

/* ===========================
   DELETE APPLICATION
   =========================== */

app.delete("/applications/:id", (req, res) => {
  try {
    const { id } = req.params;
    const db = readDB();

    const index = db.findIndex(a => a.id === id);
    if (index === -1)
      return res.status(404).json({ error: "Application not found" });

    db.splice(index, 1);
    writeDB(db);

    res.json({ success: true, message: "Application deleted" });
  } catch (err) {
    console.error("❌ Delete error:", err);
    res.status(500).json({ error: "Internal delete failure" });
  }
});

/* ===========================
   START SERVER
   =========================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Shore Roleplay backend running on port ${PORT}`)
);
