const nodemailer = require("nodemailer");
const config = require("../config");
const logger = require("../utils/logger");

let transporter = null;

function getTransporter() {
  if (!transporter && config.smtp.user && config.smtp.pass) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
    });
  }
  return transporter;
}

/**
 * Send email
 */
async function sendEmail(to, subject, html) {
  const t = getTransporter();
  if (!t) {
    logger.warn("Email not configured — skipping send", { to, subject });
    return false;
  }

  try {
    await t.sendMail({
      from: `"ReelFlow" <${config.smtp.user}>`,
      to,
      subject,
      html,
    });
    logger.info("Email sent", { to, subject });
    return true;
  } catch (err) {
    logger.error("Email send failed", { error: err.message, to });
    return false;
  }
}

/**
 * Send email verification
 */
async function sendVerificationEmail(email, name, token) {
  const verifyUrl = `${config.frontendUrls[0]}/verify-email?token=${token}`;
  const html = `
    <div style="font-family: 'Inter', sans-serif; max-width: 600px; margin: 0 auto; background: #0B0B0D; color: #F5F5F7; padding: 40px; border-radius: 12px;">
      <h1 style="color: #6366f1; margin-bottom: 8px;">ReelFlow</h1>
      <h2>Verify your email</h2>
      <p>Hey ${name},</p>
      <p>Click the button below to verify your email address:</p>
      <a href="${verifyUrl}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin: 16px 0;">Verify Email</a>
      <p style="color: #A7A7AD; font-size: 14px;">This link expires in 24 hours. If you didn't create an account, ignore this email.</p>
    </div>
  `;
  return sendEmail(email, "Verify your ReelFlow account", html);
}

/**
 * Send password reset email
 */
async function sendResetEmail(email, name, token) {
  const resetUrl = `${config.frontendUrls[0]}/reset-password?token=${token}`;
  const html = `
    <div style="font-family: 'Inter', sans-serif; max-width: 600px; margin: 0 auto; background: #0B0B0D; color: #F5F5F7; padding: 40px; border-radius: 12px;">
      <h1 style="color: #6366f1; margin-bottom: 8px;">ReelFlow</h1>
      <h2>Reset your password</h2>
      <p>Hey ${name},</p>
      <p>Click the button below to reset your password:</p>
      <a href="${resetUrl}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin: 16px 0;">Reset Password</a>
      <p style="color: #A7A7AD; font-size: 14px;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
    </div>
  `;
  return sendEmail(email, "Reset your ReelFlow password", html);
}

/**
 * Send weekly digest
 */
async function sendWeeklyDigest(email, name, stats) {
  const html = `
    <div style="font-family: 'Inter', sans-serif; max-width: 600px; margin: 0 auto; background: #0B0B0D; color: #F5F5F7; padding: 40px; border-radius: 12px;">
      <h1 style="color: #6366f1; margin-bottom: 8px;">ReelFlow</h1>
      <h2>Your Weekly Summary</h2>
      <p>Hey ${name}, here's how your accounts performed this week:</p>
      <div style="background: #1a1a1e; padding: 20px; border-radius: 8px; margin: 16px 0;">
        <p><strong>Videos Posted:</strong> ${stats.posted}</p>
        <p><strong>Videos Failed:</strong> ${stats.failed}</p>
        <p><strong>Videos in Queue:</strong> ${stats.queued}</p>
        <p><strong>Active Accounts:</strong> ${stats.activeAccounts}</p>
      </div>
      <p style="color: #A7A7AD; font-size: 14px;">Keep the content flowing!</p>
    </div>
  `;
  return sendEmail(email, `ReelFlow Weekly: ${stats.posted} videos posted`, html);
}

module.exports = { sendEmail, sendVerificationEmail, sendResetEmail, sendWeeklyDigest };
