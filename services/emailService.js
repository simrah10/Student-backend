const { Resend } = require("resend");

// In-memory capture for test verification
let lastSentEmail = null;
let testEmailHook = null;

/**
 * Configure or get the Resend client instance
 */
const getResendClient = () => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.trim() === "" || apiKey === "re_your_resend_api_key_here") {
    return null;
  }
  return new Resend(apiKey.trim());
};

/**
 * Send password reset email via Resend
 * @param {Object} params
 * @param {string} params.to - Recipient email address
 * @param {string} params.name - User's full name
 * @param {string} params.resetUrl - Frontend password reset URL with token
 * @param {string} params.resetToken - Raw reset token (held in memory only for test hook)
 * @returns {Promise<{success: boolean, id?: string, simulated?: boolean, error?: string}>}
 */
const sendPasswordResetEmail = async ({ to, name, resetUrl, resetToken }) => {
  // Store sent email metadata for testing (in memory only, never logged or exposed via API)
  lastSentEmail = {
    to,
    name,
    resetUrl,
    resetToken,
    sentAt: new Date()
  };

  // If a test hook is configured (e.g. during unit/integration tests), execute it
  if (typeof testEmailHook === "function") {
    return await testEmailHook({ to, name, resetUrl, resetToken });
  }

  const resend = getResendClient();
  const fromEmail = process.env.RESEND_FROM_EMAIL || "StudentFlow <onboarding@resend.dev>";

  if (!resend) {
    // In environments without RESEND_API_KEY (e.g. local dev without credentials), log a safe warning
    console.warn(`[EMAIL] RESEND_API_KEY is not configured in environment. Email to ${to} was not dispatched.`);
    return {
      success: false,
      simulated: true,
      message: "RESEND_API_KEY not configured"
    };
  }

  const subject = "Reset your StudentFlow password";
  const recipientName = name ? name.trim() : "Student";

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset your StudentFlow password</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b; }
    .container { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
    .header { background: #4f46e5; padding: 28px; text-align: center; color: #ffffff; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
    .content { padding: 32px; line-height: 1.6; font-size: 15px; }
    .btn-container { text-align: center; margin: 32px 0; }
    .btn { display: inline-block; background-color: #4f46e5; color: #ffffff !important; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 15px; }
    .alert-box { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 4px; font-size: 14px; color: #92400e; margin: 20px 0; }
    .footer { padding: 20px 32px; background: #f1f5f9; font-size: 13px; color: #64748b; text-align: center; line-height: 1.5; }
    .url-fallback { word-break: break-all; color: #4f46e5; font-size: 13px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎓 StudentFlow</h1>
    </div>
    <div class="content">
      <p>Hello <strong>${recipientName}</strong>,</p>
      <p>We received a request to reset the password for your StudentFlow account. Click the button below to set a new password:</p>
      <div class="btn-container">
        <a href="${resetUrl}" class="btn" target="_blank" rel="noopener noreferrer">Reset Password</a>
      </div>
      <div class="alert-box">
        ⏱️ This link is valid for <strong>15 minutes</strong> and can only be used once.
      </div>
      <p>If you did not request a password reset, you can safely ignore this email. Your account remains secure and your password will not be changed.</p>
      <div class="url-fallback">
        <p>If the button above does not work, copy and paste this link into your browser:<br><a href="${resetUrl}">${resetUrl}</a></p>
      </div>
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} StudentFlow Productivity System. All rights reserved.</p>
    </div>
  </div>
</body>
</html>`;

  const text = `Hello ${recipientName},\n\nWe received a request to reset the password for your StudentFlow account.\n\nPlease use the link below to set a new password:\n${resetUrl}\n\nThis link is valid for 15 minutes and can only be used once.\n\nIf you did not request a password reset, you can safely ignore this email.\n\n- The StudentFlow Team`;

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: [to],
      subject,
      html,
      text
    });

    if (error) {
      console.error(`[EMAIL ERROR] Resend failed to send password reset email to ${to}:`, error.message);
      return { success: false, error: error.message };
    }

    return { success: true, id: data ? data.id : null };
  } catch (error) {
    console.error(`[EMAIL ERROR] Network error sending email via Resend to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendPasswordResetEmail,
  getLastSentEmail: () => lastSentEmail,
  clearLastSentEmail: () => { lastSentEmail = null; },
  setTestEmailHook: (fn) => { testEmailHook = fn; }
};
