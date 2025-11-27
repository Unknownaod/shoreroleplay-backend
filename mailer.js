const nodemailer = require("nodemailer");
const { acceptedEmail, deniedEmail } = require("./emailTemplates");

// Use values from ENV for flexibility
const FROM_NAME = process.env.FROM_NAME || "Shore Roleplay";
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@shoreroleplay.xyz";

/**
 * Configure SMTP Transport
 * Brevo requires STARTTLS on port 587
 */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: true, // Brevo requires SSL on 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false // prevents certificate issues on Render
  }
});

/**
 * Send acceptance or denial email
 * status: "accepted" | "denied"
 * data: { email, username }
 */
async function sendApplicationEmail(status, data) {
  const { email, username } = data;

  const isAccepted = status === "accepted";

  const html = isAccepted
    ? acceptedEmail({ username })
    : deniedEmail({ username });

  const subject = isAccepted
    ? "Your Shore Roleplay Application Has Been Approved"
    : "Your Shore Roleplay Application Status";

  await transporter.sendMail({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: email,
    replyTo: FROM_EMAIL, // Proper reply address
    subject,
    html
  });

  console.log(`📧 Email sent to ${email} (${status})`);
}

module.exports = { sendApplicationEmail };
