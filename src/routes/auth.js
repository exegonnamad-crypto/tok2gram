const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const config = require("../config");
const User = require("../models/User");
const Account = require("../models/Account");
const Video = require("../models/Video");
const Workflow = require("../models/Workflow");
const ActivityLog = require("../models/ActivityLog");
const { auth } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimiter");
const emailService = require("../services/emailService");
const { logActivity } = require("../services/scheduler");
const logger = require("../utils/logger");

const router = express.Router();

// ── Register ──
router.post("/register", authLimiter, async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email, and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(409).json({ error: "Email already registered" });

    const hash = await bcrypt.hash(password, 12);
    const emailVerifyToken = crypto.randomBytes(32).toString("hex");

    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hash,
      emailVerifyToken,
      emailVerifyExpires: new Date(Date.now() + 24 * 3600000),
    });

    const token = jwt.sign({ id: user._id }, config.jwtSecret, { expiresIn: "30d" });

    // Send verification email (non-blocking)
    emailService.sendVerificationEmail(user.email, user.name, emailVerifyToken).catch(() => {});

    await logActivity(user._id, null, "", "register", "Account created");

    res.status(201).json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        plan: user.plan,
        trialEndsAt: user.trialEndsAt,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
      },
    });
  } catch (err) { next(err); }
});

// ── Login ──
router.post("/login", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    if (!user.isActive) return res.status(403).json({ error: "Account is disabled" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });

    const token = jwt.sign({ id: user._id }, config.jwtSecret, { expiresIn: "30d" });

    // Update login stats
    await User.findByIdAndUpdate(user._id, {
      lastLoginAt: new Date(),
      $inc: { loginCount: 1 },
    });

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        plan: user.plan,
        trialEndsAt: user.trialEndsAt,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
      },
    });
  } catch (err) { next(err); }
});

// ── Get current user ──
router.get("/me", auth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select("-password -emailVerifyToken -resetToken");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) { next(err); }
});

// ── Update profile ──
router.put("/me", auth, async (req, res, next) => {
  try {
    const { name, timezone, notifications } = req.body;
    const update = {};
    if (name) update.name = name.trim();
    if (timezone) update.timezone = timezone;
    if (notifications) update.notifications = notifications;

    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true })
      .select("-password -emailVerifyToken -resetToken");
    res.json(user);
  } catch (err) { next(err); }
});

// ── Change password ──
router.put("/me/password", auth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" });
    }

    const user = await User.findById(req.user.id);
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: "Current password is incorrect" });

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    res.json({ message: "Password updated" });
  } catch (err) { next(err); }
});

// ── Verify email ──
router.post("/verify-email", async (req, res, next) => {
  try {
    const { token } = req.body;
    const user = await User.findOne({
      emailVerifyToken: token,
      emailVerifyExpires: { $gt: new Date() },
    });
    if (!user) return res.status(400).json({ error: "Invalid or expired verification link" });

    user.emailVerified = true;
    user.emailVerifyToken = undefined;
    user.emailVerifyExpires = undefined;
    await user.save();

    res.json({ message: "Email verified successfully" });
  } catch (err) { next(err); }
});

// ── Forgot password ──
router.post("/forgot-password", authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email: email?.toLowerCase() });

    // Always return success to prevent email enumeration
    if (!user) return res.json({ message: "If that email exists, a reset link has been sent" });

    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetToken = resetToken;
    user.resetTokenExpires = new Date(Date.now() + 3600000); // 1 hour
    await user.save();

    await emailService.sendResetEmail(user.email, user.name, resetToken);
    res.json({ message: "If that email exists, a reset link has been sent" });
  } catch (err) { next(err); }
});

// ── Reset password ──
router.post("/reset-password", async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: "Token and password required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const user = await User.findOne({
      resetToken: token,
      resetTokenExpires: { $gt: new Date() },
    });
    if (!user) return res.status(400).json({ error: "Invalid or expired reset link" });

    user.password = await bcrypt.hash(password, 12);
    user.resetToken = undefined;
    user.resetTokenExpires = undefined;
    await user.save();

    res.json({ message: "Password reset successfully" });
  } catch (err) { next(err); }
});

// ── Generate API key ──
router.post("/api-key", auth, async (req, res, next) => {
  try {
    const apiKey = `rf_${crypto.randomBytes(32).toString("hex")}`;
    await User.findByIdAndUpdate(req.user.id, { apiKey, apiKeyCreatedAt: new Date() });
    res.json({ apiKey });
  } catch (err) { next(err); }
});

// ── Delete account ──
router.delete("/me", auth, async (req, res, next) => {
  try {
    await Video.deleteMany({ userId: req.user.id });
    await Account.deleteMany({ userId: req.user.id });
    await Workflow.deleteMany({ userId: req.user.id });
    await ActivityLog.deleteMany({ userId: req.user.id });
    await User.findByIdAndDelete(req.user.id);
    res.json({ message: "Account deleted" });
  } catch (err) { next(err); }
});

module.exports = router;
