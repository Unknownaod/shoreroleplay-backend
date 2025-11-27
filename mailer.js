const brevo = require("@getbrevo/brevo");
const { acceptedEmail, deniedEmail } = require("./emailTemplates");

// Load from ENV so you can change later if needed
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@shoreroleplay.xyz";
const FROM_NAME = process.env.FROM_NAME || "Shore Roleplay";

// Create Brevo Transactional client
const client = new brevo.TransactionalEmailsApi();
client.setApiKey(
  brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

/**
 * Send acceptance or denial email
 * status: "accepted" | "denied"
 * data: { email, username }
 */
async function sendApplicationEmail(status, data) {
  const { email, username } = data;

  const html = status === "accepted"
    ? acceptedEmail({ username })
    : deniedEmail({ username });

  const subject = status === "accepted"
    ? "Your Shore Roleplay Application Has Been Approved"
    : "Your Shore Roleplay Application Status";

  try {
    await client.sendTransacEmail({
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      to: [{ email }],
      subject,
      htmlContent: html
    });

    console.log(`📧 Brevo email sent successfully → ${email}`);
  } catch (err) {
    console.error("❌ Brevo email error:", err.message);
  }
}

module.exports = { sendApplicationEmail };
