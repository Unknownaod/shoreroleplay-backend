/**
 * Application Accepted Email Template
 * Returns HTML string
 */
/**
 * Application Accepted Template
 */
function acceptedEmail({ username }) {
  return `
    <div style="font-family:Arial,sans-serif;padding:20px;background:#f6f8fb;">
      <h2 style="color:#2ecc71;">Your Application Has Been Approved!</h2>
      <p>Hello <strong>${username}</strong>,</p>
      <p>We're excited to welcome you to <strong>Shore Roleplay</strong>!</p>
      <p>Your whitelist application has been accepted. You may now join the server and begin roleplaying.</p>
      <br>
      <small>This is an automated email. Please do not reply.</small>
    </div>
  `;
}

/**
 * Application Denied Template
 */
function deniedEmail({ username }) {
  return `
    <div style="font-family:Arial,sans-serif;padding:20px;background:#f6f8fb;">
      <h2 style="color:#e74c3c;">Your Application Has Been Denied</h2>
      <p>Hello <strong>${username}</strong>,</p>
      <p>We regret to inform you that your whitelist application for <strong>Shore Roleplay</strong> was not approved.</p>
      <p>You may reapply in the future after reviewing our rules.</p>
      <br>
      <small>This is an automated email. Please do not reply.</small>
    </div>
  `;
}

module.exports = { acceptedEmail, deniedEmail };
