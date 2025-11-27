const nodemailer = require("nodemailer");
const { acceptedEmail, deniedEmail } = require("./emailTemplates");

// Email identity
const FROM_NAME = process.env.FROM_NAME || "Shore Roleplay";
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@shoreroleplay.xyz";

/**
 * SMTP Transport Configuration
 * Brevo works best on port 465 (SSL)
 * Port 587 is often blocked on free hosts like Render
 */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: true, // MUST be true when using port 465 (SSL)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false // helps avoid certificate errors on some hosts
  }
});

/**
 * Send acceptance or denial email to applicant
 * @param {"accepted"|"denied"} status
 * @param {{ email: string, username: string }} data
 */
async function sendApplicationEmail(status, data) {
  const { email, username } = data;
  const isAccepted = status === "accepted";

  const html = isAccepted
    ? acceptedEmail({ username })
    : deniedEmail({ username });

  const subject = isAccepted
    ? "Your Application to Shore Roleplay Has Been Accepted"
    : "Shore Roleplay Application Status";

  await transporter.sendMail({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: email,
    replyTo: FROM_EMAIL,
    subject,
    html
  });

  console.log(`📧 Decision email sent to: ${email} (${status.toUpperCase()})`);
}

module.exports = { sendApplicationEmail };
