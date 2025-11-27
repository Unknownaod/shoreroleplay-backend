const BRAND_COLOR = "#4EA3FF";
const BG = "#0a0e14";
const TEXT = "#d8e0ea";

function emailWrapper(content, titleColor) {
  return `
  <div style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;background:${BG};padding:40px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:650px;margin:auto;background:#11161f;border-radius:12px;overflow:hidden;">
      <tr>
        <td style="padding:30px 35px;background:${BRAND_COLOR};color:white;font-size:26px;font-weight:700;">
          Shore Roleplay Application Status
        </td>
      </tr>
      <tr>
        <td style="padding:35px;color:${TEXT};font-size:16px;line-height:1.6;">
          ${content}
        </td>
      </tr>
      <tr>
        <td style="padding:25px;text-align:center;color:#6f7b88;font-size:12px;background:#0d1117;">
          This email was sent automatically by Shore Roleplay.<br>
          <span style="opacity:.6">Do not reply to this message.</span>
        </td>
      </tr>
    </table>
  </div>
  `;
}

function acceptedEmail({ username }) {
  return emailWrapper(`
    <h2 style="color:#2ecc71;margin-top:0;">Congratulations, ${username}!</h2>
    <p>Your application to join <strong>Shore Roleplay</strong> has been reviewed and <strong>APPROVED</strong>.</p>
    <p>You are now officially cleared to join and participate in our community’s roleplay environment.</p>
    <p style="margin-top:15px;">Please ensure you’ve joined our Discord server and reviewed all operational guidelines.</p>
    <a href="https://discord.gg/" style="display:inline-block;margin-top:20px;padding:14px 28px;background:#2ecc71;color:white;text-decoration:none;border-radius:6px;font-weight:600;">
      Join Discord
    </a>
  `);
}

function deniedEmail({ username }) {
  return emailWrapper(`
    <h2 style="color:#e74c3c;margin-top:0;">Hello ${username},</h2>
    <p>We appreciate your interest in <strong>Shore Roleplay</strong>, however your application has not met the required criteria and has been <strong>DENIED</strong>.</p>
    <p>You may reapply after improving your responses and ensuring you understand our guidelines.</p>
    <a href="https://shoreroleplay.xyz/apply" style="display:inline-block;margin-top:20px;padding:14px 28px;background:#e74c3c;color:white;text-decoration:none;border-radius:6px;font-weight:600;">
      Reapply
    </a>
  `);
}

module.exports = { acceptedEmail, deniedEmail };
