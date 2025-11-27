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
   BREVO API INITIALIZATION
   =========================== */
const brevoClient = new Brevo.TransactionalEmailsApi();
brevoClient.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY // <-- Set this in .env
);

const FROM_NAME = process.env.FROM_NAME || "Shore Roleplay";
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@shoreroleplay.xyz";

/* ===========================
   HELPERS
   =========================== */

// Reads and writes applications.json
const dbFile = path.join(__dirname, "applications.json");
function readDB() {
  return JSON.parse(fs.readFileSync(dbFile, "utf8"));
}
function writeDB(data) {
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
}

// Import email templates
const { acceptedEmail, deniedEmail } = require("./emailTemplates");

/* ===========================
   EMAIL SENDER VIA BREVO
   =========================== */

async function sendDecisionEmail(status, user) {
  const html = status === "accepted"
    ? acceptedEmail({ username: user.username })
    : deniedEmail({ username: user.username });

  const subject = status === "accepted"
    ? "Your Shore Roleplay Application Has Been Approved"
    : "Your Shore Roleplay Application Status";

  const email = {
    sender: { name: FROM_NAME, email: FROM_EMAIL },
    to: [{ email: user.email, name: user.username }],
    subject,
    htmlContent: html
  };

  await brevoClient.sendTransacEmail(email);
  console.log(`📧 Brevo email sent to ${user.email}`);
}

/* ===========================
   API ROUTES
   =========================== */

// Fetch all applications
app.get("/applications", (req, res) => {
  res.json(readDB());
});

// Accept / Deny endpoint
app.post("/applications/:id/decision", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const db = readDB();
  const appIndex = db.findIndex(a => a.id === id);

  if (appIndex === -1) return res.status(404).json({ error: "Not found" });

  db[appIndex].status = status;
  writeDB(db);

  try {
    await sendDecisionEmail(status, db[appIndex]);
    res.json({ success: true, status });
  } catch (err) {
    console.error("❌ Error sending Brevo email:", err);
    res.status(500).json({ error: "Email failed" });
  }
});

// Homepage check
app.get("/", (req, res) => {
  res.send("Shore Roleplay Backend Online 🚀");
});

/* ===========================
   START SERVER
   =========================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Backend running at http://localhost:${PORT}`)
);
