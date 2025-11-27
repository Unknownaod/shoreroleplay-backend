/**
 * Application Accepted Email Template
 * Returns HTML string
 */
function acceptedEmail({ username }) {
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px; background: #f6f8fb;">
      <h2 style="color:#2ecc71;">Your Application Has Been Approved!</h2>

      <p>Hello <strong>${username}</strong>,</p>

      <p>We're excited to inform you that your application to join 
      <strong>Shore Roleplay</strong> has been <span style="color:#2ecc71;font-weight:bold;">
      ACCEPTED</span>.</p>

      <p>You may now join the server and begin your roleplay journey. 
      Make sure you follow all community guidelines and respect other players.</p>

      <p style="margin-top:25px;">Welcome aboard, and we can't wait to see you in game!</p>

      <hr style="margin:30px 0; border: none; border-top: 1px solid #ddd;" />

      <small>This is an automated message. Please do not reply.</small>
    </div>
  `;
}

/**
 * Application Denied Email Template
 * Returns HTML string
 */
function deniedEmail({ username }) {
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px; background: #f6f8fb;">
      <h2 style="color:#e74c3c;">Application Status Update</h2>

      <p>Hello <strong>${username}</strong>,</p>

      <p>We regret to inform you that your application to join
      <strong>Shore Roleplay</strong> has been
      <span style="color:#e74c3c;font-weight:bold;">DENIED</span>.</p>

      <p>This decision may be based on incomplete answers, rule concerns, or other factors.
      You are welcome to review the rules and reapply in the future.</p>

      <p style="margin-top:25px;">Thank you for your interest in our community.</p>

      <hr style="margin:30px 0; border: none; border-top: 1px solid #ddd;" />

      <small>This is an automated message. Please do not reply.</small>
    </div>
  `;
}

module.exports = { acceptedEmail, deniedEmail };
