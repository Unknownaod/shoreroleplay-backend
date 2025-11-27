require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "applications.json");

// ---------- CORS ----------
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || "*",
    credentials: false
  })
);

app.use(express.json());

// ---------- JSON FILE HELPERS ----------
function readApplications() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw || "[]");
  } catch (err) {
    console.error("Error reading applications.json:", err);
    return [];
  }
}

function writeApplications(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ---------- SMTP TRANSPORT (BREVO) ----------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

function baseTemplate({ title, badgeText, badgeColor, subtitle, bodyHtml }) {
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

function acceptedEmail(app) {
  return baseTemplate({
    title: "APPLICATION APPROVED",
    badgeText: "Approved",
    badgeColor: "#22c55e",
    subtitle: `Your application to Shore Roleplay – ${app.department} has been approved.`,
    bodyHtml: `
      <p>Hi ${app.fullName || "there"},</p>
      <p>
        Congratulations – your application for the
        <strong>${app.department}</strong> department at
        <strong>Shore Roleplay</strong> has been <strong>accepted</strong>.
      </p>
      <p>
        Please join our Discord and follow the onboarding instructions in the
        designated channels.
      </p>
      <p style="margin:18px 0;" align="center">
        <a href="https://discord.gg/YOUR_INVITE_HERE"
           style="display:inline-block;padding:11px 26px;border-radius:999px;background:#1f75ff;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">
          Join Shore Roleplay Discord
        </a>
      </p>
      <p>
        Welcome aboard,<br/>
        <strong>Shore Roleplay Staff Team</strong>
      </p>
    `
  });
}

function deniedEmail(app) {
  return baseTemplate({
    title: "APPLICATION REVIEWED",
    badgeText: "Not Approved",
    badgeColor: "#ef4444",
    subtitle: `Your application to Shore Roleplay – ${app.department} has been reviewed.`,
    bodyHtml: `
      <p>Hi ${app.fullName || "there"},</p>
      <p>
        Thank you for applying to the
        <strong>${app.department}</strong> department at
        <strong>Shore Roleplay</strong>.
      </p>
      <p>
        After careful review, we are unfortunately not able to approve your
        application at this time.
      </p>
      <p>
        You are welcome to reapply after <strong>30 days</strong> if your
        experience or availability has changed.
      </p>
      <p>
        Respectfully,<br/>
        <strong>Shore Roleplay Staff Team</strong>
      </p>
    `
  });
}

async function sendDecisionEmail(app, decision) {
  const html =
    decision === "accepted" ? acceptedEmail(app) : deniedEmail(app);

  const subject =
    decision === "accepted"
      ? "Shore Roleplay Application Approved"
      : "Shore Roleplay Application Result";

  if (!app.email) return;

  await transporter.sendMail({
    from: process.env.FROM_EMAIL,
    to: app.email,
    subject,
    html
  });
}

// ---------- PUBLIC: SUBMIT APPLICATION ----------
app.post("/api/apply", (req, res) => {
  const {
    fullName,
    email,
    discord,
    department,
    age,
    timezone,
    experience,
    certifications,
    backgroundConsent,
    motivation,
    availability
  } = req.body;

  if (!fullName || !email || !discord || !department || !motivation) {
    return res.status(400).json({
      error:
        "Missing required fields (fullName, email, discord, department, motivation)."
    });
  }

  const apps = readApplications();

  const entry = {
    id: Date.now().toString(),
    fullName,
    email,
    discord,
    department,
    age: age || null,
    timezone: timezone || null,
    experience: experience || null,
    certifications: certifications || null,
    backgroundConsent: backgroundConsent || null,
    motivation,
    availability: availability || null,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  apps.push(entry);
  writeApplications(apps);

  res.json({ ok: true, id: entry.id });
});

// ---------- STAFF: GET ALL APPLICATIONS ----------
app.get("/api/applications", (req, res) => {
  const key = req.query.key;
  if (key !== process.env.STAFF_PANEL_PASSWORD) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const apps = readApplications();
  res.json(apps);
});

// ---------- STAFF: MAKE DECISION ----------
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
  const idx = apps.findIndex((a) => a.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: "Application not found" });
  }

  const appEntry = apps[idx];
  apps[idx] = {
    ...appEntry,
    status: decision,
    updatedAt: new Date().toISOString()
  };
  writeApplications(apps);

  try {
    await sendDecisionEmail(appEntry, decision);
  } catch (err) {
    console.error("Error sending decision email:", err);
    // still return OK for now
  }

  res.json({ ok: true });
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`Shore Roleplay backend listening on port ${PORT}`);
});
