require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const Brevo = require("@getbrevo/brevo");

const app = express();

/* ===========================
   CORE CONFIG
   =========================== */

app.use(express.json());
app.use(cors({
  origin: [
    "https://shoreroleplay.xyz",
    "https://www.shoreroleplay.xyz"
  ],
  credentials: true
}));

const dbFile = path.join(__dirname, "applications.json");
const STAFF_PASSWORD = process.env.STAFF_PANEL_PASSWORD;

/* ===========================
   BREVO EMAIL API
   =========================== */

const brevoClient = new Brevo.TransactionalEmailsApi();
brevoClient.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

const FROM_NAME = process.env.FROM_NAME || "Shore Roleplay";
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@shoreroleplay.xyz";

const { acceptedEmail, deniedEmail } = require("./emailTemplates");

/* ===========================
   FILE DATABASE HELPERS
   =========================== */

function readDB() {
  return JSON.parse(fs.readFileSync(dbFile, "utf8"));
}

function writeDB(data) {
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
}

/* ===========================
   EMAIL SENDING
   =========================== */

async function sendDecisionEmail(status, user) {
  const html = status === "accepted"
    ? acceptedEmail({ username: user.username })
    : deniedEmail({ username: user.username });

  const subject = status === "accepted"
    ? "Your Shore Roleplay Application Has Been Approved"
    : "Your Shore Roleplay Application Status";

  const payload = {
    sender: { name: FROM_NAME, email: FROM_EMAIL },
    to: [{ email: user.email, name: user.username }],
    subject,
    htmlContent: html
  };

  await brevoClient.sendTransacEmail(payload);
  console.log(`📧 Brevo email sent → ${user.email}`);
}

/* ===========================
   ROUTES
   =========================== */

app.get("/", (req, res) => {
  res.send("Shore Roleplay Backend Online 🚀");
});

/* === 1) SUBMIT APPLICATION === */
app.post("/apply", (req, res) => {
  const { username, email, department, reason } = req.body;

  if (!username || !email || !department || !reason)
    return res.status(400).json({ error: "Missing fields" });

  const db = readDB();
  const appData = {
    id: Date.now().toString(), // ensures consistent string ID usage
    username,
    email,
    department,
    reason,
    status: "pending"
  };

  db.push(appData);
  writeDB(db);

  console.log(`📝 Application received from ${username}`);
  res.json({ success: true });
});

/* === 2) STAFF PANEL LOGIN === */
app.post("/staff/login", (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Missing password" });

  if (password === STAFF_PASSWORD) {
    return res.json({ success: true });
  }

  res.status(403).json({ error: "Invalid staff password" });
});

/* === 3) GET ALL APPLICATIONS === */
app.get("/applications", (req, res) => {
  res.json(readDB());
});

/* === 4) ACCEPT / DENY === */
app.post("/applications/:id/decision", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!["accepted", "denied"].includes(status))
    return res.status(400).json({ error: "Invalid status" });

  const db = readDB();
  const appIndex = db.findIndex(a => a.id === id);

  if (appIndex === -1)
    return res.status(404).json({ error: "Application not found" });

  db[appIndex].status = status;
  writeDB(db);

  try {
    await sendDecisionEmail(status, db[appIndex]);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Email Error →", err);
    res.status(500).json({ error: "Email failed to send" });
  }
});

/* ===========================
   START SERVER
   =========================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🔥 ShoreRP Backend Running @ http://localhost:${PORT}`)
);
