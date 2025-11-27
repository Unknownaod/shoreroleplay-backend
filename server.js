require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "applications.json");

// ---- CORS (allow your Vercel site) ----
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN,
  credentials: false
}));

app.use(express.json());

// ---- Helpers for JSON file ----
function readApplications() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw || "[]");
  } catch (e) {
    console.error("Error reading applications.json:", e);
    return [];
  }
}

function writeApplications(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ---- Mailer setup ----
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

function baseTemplate({ title, subtitle, bodyHtml, badgeColor, badgeText }) {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f7fb;padding:40px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 8px 25px rgba(15,23,42,0.12);">
            <tr>
              <td align="center" style="padding:28px 24px 8px 24px;background:#ffffff;">
                <div style="width:72px;height:72px;border-radius:999px;background:#1f75ff;display:flex;align-items:center;justify-content:center;margin-bottom:14px;">
                  <span style="font-size:34px;font-weight:800;color:#ffffff;">SR</span>
                </div>
                <h1 style="margin:0;font-size:22px;letter-spacing:3px;text-transform:uppercase;color:#1f75ff;">
                  ${title}
                </h1>
                ${
                  badgeText
                    ? `<div style="margin-top:10px;padding:4px 11px;border-radius:999px;background:${badgeColor};color:#fff;font-size:11px;display:inline-block;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">
                         ${badgeText}
                       </div>`
                    : ""
                }
                <p style="margin:22px 0 0 0;font-size:14px;color:#6c757d;max-width:480px;line-height:1.6;">
                  ${subtitle}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:22px 32px 30px 32px;font-size:14px;color:#1f2933;line-height:1.6;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:18px 24px 24px 24px;background:#f5f7fb;border-top:1px solid #e2e6f0;font-size:12px;color:#6c757d;">
                <div style="margin-bottom:6px;">
                  Sent from <strong>Shore Roleplay</strong>
                </div>
                <div style="opacity:0.75;">
                  If you did not expect this email, you can safely ignore it.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
}

function acceptedEmail(username) {
  return baseTemplate({
    title: "APPLICATION APPROVED",
    subtitle: "Your application to Shore Roleplay has been reviewed and approved.",
    badgeColor: "#22c55e",
    badgeText: "Approved",
    bodyHtml: `
      <p style="margin:0 0 12px 0;">
        Hi${username ? " " + username : ""},
      </p>
      <p style="margin:0 0 12px 0;">
        Congratulations – your application to <strong>Shore Roleplay</strong> has been <strong>accepted</strong>.
      </p>
      <p style="margin:0 0 18px 0;">
        To get started, please join our Discord and follow the onboarding channels.
      </p>
      <p style="margin:0 0 24px 0;" align="center">
        <a href="https://discord.gg/YOUR_INVITE_HERE"
           style="display:inline-block;padding:11px 26px;border-radius:999px;background:#1f75ff;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">
          Join Shore Roleplay Discord
        </a>
      </p>
      <p style="margin:0;">
        Welcome aboard,<br/>
        <strong>Shore Roleplay Staff Team</strong>
      </p>
    `
  });
}

function deniedEmail(username) {
  return baseTemplate({
    title: "APPLICATION REVIEWED",
    subtitle: "Your application to Shore Roleplay has been reviewed.",
    badgeColor: "#ef4444",
    badgeText: "Not Approved",
    bodyHtml: `
      <p style="margin:0 0 12px 0;">
        Hi${username ? " " + username : ""},
      </p>
      <p style="margin:0 0 12px 0;">
        Thank you for taking the time to apply to <strong>Shore Roleplay</strong>. 
        After careful review, we are unfortunately not able to approve your application at this time.
      </p>
      <p style="margin:0 0 12px 0;">
        You are welcome to re-apply after <strong>30 days</strong> if your experience or availability has changed.
      </p>
      <p style="margin:0;">
        Respectfully,<br/>
        <strong>Shore Roleplay Staff Team</strong>
      </p>
    `
  });
}

async function sendDecisionEmail({ email, name, status }) {
  const html = status === "accepted"
    ? acceptedEmail(name)
    : deniedEmail(name);

  const subject = status === "accepted"
    ? "Shore Roleplay Application Approved"
    : "Shore Roleplay Application Result";

  await transporter.sendMail({
    from: `Shore Roleplay <${process.env.FROM_EMAIL}>`,
    to: email,
    subject,
    html
  });
}

// ---------- ROUTES ----------

// Public: create application
app.post("/api/apply", (req, res) => {
  const { name, email, age, discord, about } = req.body;

  if (!name || !email || !about) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const applications = readApplications();

  const appEntry = {
    id: Date.now().toString(),
    name,
    email,
    age: age || null,
    discord: discord || null,
    about,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  applications.push(appEntry);
  writeApplications(applications);

  res.json({ ok: true, id: appEntry.id });
});

// Staff: list applications (requires simple password in query)
app.get("/api/applications", (req, res) => {
  const key = req.query.key;
  if (key !== process.env.STAFF_PANEL_PASSWORD) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const apps = readApplications();
  res.json(apps);
});

// Staff: decide application
app.post("/api/applications/:id/decision", async (req, res) => {
  const key = req.query.key;
  if (key !== process.env.STAFF_PANEL_PASSWORD) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { id } = req.params;
  const { decision } = req.body;

  if (!["accepted", "denied"].includes(decision)) {
    return res.status(400).json({ error: "Invalid decision" });
  }

  const apps = readApplications();
  const idx = apps.findIndex(a => a.id === id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const appEntry = apps[idx];
  apps[idx] = {
    ...appEntry,
    status: decision,
    updatedAt: new Date().toISOString()
  };
  writeApplications(apps);

  try {
    await sendDecisionEmail({
      email: appEntry.email,
      name: appEntry.name,
      status: decision
    });
  } catch (e) {
    console.error("Error sending mail:", e);
    // Still return success for now
  }

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("Shore Staff Backend running on port", PORT);
});
