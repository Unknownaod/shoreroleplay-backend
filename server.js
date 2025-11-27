require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const brevo = require("@getbrevo/brevo"); // <-- single import

const app = express();
app.use(express.json());
app.use(cors());

/* ===========================
   CONSTANTS
   =========================== */

const FROM_NAME = process.env.FROM_NAME || "Shore Roleplay";
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@shoreroleplay.xyz";
const HAS_BREVO_KEY =
  !!process.env.BREVO_API_KEY &&
  process.env.BREVO_API_KEY !== "brevo_test_key";

/* ===========================
   BREVO INITIALIZATION (FIXED)
   =========================== */

let brevoApi = null;

if (HAS_BREVO_KEY) {
  try {
    const Brevo = require("@getbrevo/brevo");
    const client = Brevo.ApiClient.instance;

    // THIS IS THE CORRECT AUTH FIELD NAME
    client.authentications["api-key"].apiKey = process.env.BREVO_API_KEY;

    brevoApi = new Brevo.TransactionalEmailsApi();

    console.log("✅ Brevo email client initialized");
  } catch (err) {
    console.error("❌ Failed to initialize Brevo client:", err);
    brevoApi = null;
  }
} else {
  console.warn("⚠️ BREVO_API_KEY not set – emails will only be logged, not actually sent");
}


/* ===========================
   “DATABASE” (applications.json)
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
   EMAIL SENDER VIA BREVO
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

  // No Brevo? Just log what we *would* send.
  if (!brevoApi) {
    console.log("📧 [DEV] Would send Brevo email:", {
      to: user.email,
      subject,
    });
    return;
  }

  const email = new brevo.SendSmtpEmail();
  email.sender = { name: FROM_NAME, email: FROM_EMAIL };
  email.to = [{ email: user.email, name: user.username }];
  email.subject = subject;
  email.htmlContent = html;

  await brevoApi.sendTransacEmail(email);
  console.log(`📧 Brevo email sent to ${user.email}`);
}

/* ===========================
   API ROUTES
   =========================== */

// Get all applications
app.get("/applications", (req, res) => {
  res.json(readDB());
});

// Accept / Deny application
app.post("/applications/:id/decision", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!["accepted", "denied"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const db = readDB();
  const idx = db.findIndex((a) => a.id === id);

  if (idx === -1) {
    return res.status(404).json({ error: "Application not found" });
  }

  db[idx].status = status;
  writeDB(db);

  try {
    await sendDecisionEmail(status, db[idx]);
    res.json({ success: true, status });
  } catch (err) {
    console.error("❌ Error sending Brevo email:", err);
    res.status(500).json({ error: "Email failed" });
  }
});

// Simple health check
app.get("/", (req, res) => {
  res.send("Shore Roleplay Backend Online 🚀");
});

/* ===========================
   START SERVER
   =========================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
