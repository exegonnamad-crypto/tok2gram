const express = require("express");
const { auth } = require("../middleware/auth");
const { checkPlan } = require("../middleware/planLimits");
const { verifyLimiter } = require("../middleware/rateLimiter");
const Account = require("../models/Account");
const Video = require("../models/Video");
const instagramService = require("../services/instagram");
const { encrypt } = require("../utils/crypto");
const { logActivity } = require("../services/scheduler");
const logger = require("../utils/logger");

const router = express.Router();

// ── List accounts ──
router.get("/", auth, async (req, res, next) => {
  try {
    const accounts = await Account.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(accounts.map(a => ({
      ...a.toObject(),
      igPassword: a.igPassword ? "***" : "",
      sessionData: undefined,
    })));
  } catch (err) { next(err); }
});

// ── Get single account ──
router.get("/:id", auth, async (req, res, next) => {
  try {
    const account = await Account.findOne({ _id: req.params.id, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });
    res.json({
      ...account.toObject(),
      igPassword: account.igPassword ? "***" : "",
      sessionData: undefined,
    });
  } catch (err) { next(err); }
});

// ── Verify Instagram credentials ──
router.post("/verify", auth, verifyLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });

    const result = await instagramService.login(username, password);
    if (result.success) {
      res.json({
        success: true,
        userId: result.userId,
        username: result.username,
        profilePic: result.profilePic || "",
      });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (err) { next(err); }
});

// ── Add account ──
router.post("/", auth, checkPlan("accounts"), async (req, res, next) => {
  try {
    const {
      username, igPassword, niche, postsPerDay, hashtags,
      captionStyle, customCaption, captionTemplate, appendHashtags,
      autoRequeue, postingTimes, platform, removeWatermark,
    } = req.body;

    if (!username || !igPassword) {
      return res.status(400).json({ error: "Instagram username and password required" });
    }

    // Check for duplicate
    const existing = await Account.findOne({ userId: req.user.id, username: username.toLowerCase(), platform: platform || "instagram" });
    if (existing) return res.status(409).json({ error: "Account already connected" });

    // Verify credentials
    const loginResult = await instagramService.login(username, igPassword);
    if (!loginResult.success) {
      return res.status(400).json({ error: `Instagram login failed: ${loginResult.error}` });
    }

    const account = await Account.create({
      userId: req.user.id,
      platform: platform || "instagram",
      username: loginResult.username || username,
      igUserId: loginResult.userId || "",
      igPassword: encrypt(igPassword),
      profilePic: loginResult.profilePic || "",
      sessionData: loginResult.sessionData ? encrypt(loginResult.sessionData) : "",
      sessionSavedAt: new Date(),
      niche: niche || "General",
      postsPerDay: postsPerDay || 5,
      hashtags: hashtags || "",
      captionStyle: captionStyle || "original",
      customCaption: customCaption || "",
      captionTemplate: captionTemplate || "",
      appendHashtags: appendHashtags !== false,
      autoRequeue: autoRequeue || false,
      removeWatermark: removeWatermark !== false,
      postingTimes: postingTimes || ["09:00", "12:00", "15:00", "18:00", "21:00"],
    });

    await logActivity(req.user.id, account._id, account.username, "connected",
      `@${account.username} connected`);

    res.status(201).json({
      ...account.toObject(),
      igPassword: "***",
      sessionData: undefined,
    });
  } catch (err) { next(err); }
});

// ── Update account ──
router.put("/:id", auth, async (req, res, next) => {
  try {
    const update = { ...req.body };

    // Handle password update
    if (!update.igPassword || update.igPassword === "***") {
      delete update.igPassword;
    } else {
      // Re-verify and re-login with new password
      const account = await Account.findOne({ _id: req.params.id, userId: req.user.id });
      if (!account) return res.status(404).json({ error: "Account not found" });

      const loginResult = await instagramService.login(account.username, update.igPassword);
      if (!loginResult.success) {
        return res.status(400).json({ error: `Instagram login failed: ${loginResult.error}` });
      }

      update.igPassword = encrypt(update.igPassword);
      update.sessionData = loginResult.sessionData ? encrypt(loginResult.sessionData) : account.sessionData;
      update.sessionSavedAt = new Date();
    }

    // Never allow updating these via API
    delete update.sessionData;
    delete update.userId;
    delete update.totalPosted;
    delete update.totalFailed;

    const account = await Account.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      update,
      { new: true, runValidators: true }
    );
    if (!account) return res.status(404).json({ error: "Account not found" });

    res.json({
      ...account.toObject(),
      igPassword: "***",
      sessionData: undefined,
    });
  } catch (err) { next(err); }
});

// ── Toggle account status ──
router.post("/:id/toggle", auth, async (req, res, next) => {
  try {
    const account = await Account.findOne({ _id: req.params.id, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });

    const newStatus = account.status === "active" ? "paused" : "active";
    account.status = newStatus;
    if (newStatus === "active") {
      account.consecutiveErrors = 0;
      account.errorMessage = "";
    }
    await account.save();

    const action = newStatus === "active" ? "account_resumed" : "account_paused";
    await logActivity(req.user.id, account._id, account.username, action,
      `@${account.username} ${newStatus}`);

    res.json({ status: account.status });
  } catch (err) { next(err); }
});

// ── Reconnect account (re-login) ──
router.post("/:id/reconnect", auth, verifyLimiter, async (req, res, next) => {
  try {
    const { password } = req.body;
    const account = await Account.findOne({ _id: req.params.id, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });
    if (!password) return res.status(400).json({ error: "Password required" });

    const loginResult = await instagramService.login(account.username, password, account.sessionData);
    if (!loginResult.success) {
      return res.status(400).json({ error: `Re-login failed: ${loginResult.error}` });
    }

    await Account.findByIdAndUpdate(account._id, {
      igPassword: encrypt(password),
      sessionData: loginResult.sessionData ? encrypt(loginResult.sessionData) : "",
      sessionSavedAt: new Date(),
      status: "active",
      consecutiveErrors: 0,
      errorMessage: "",
    });

    res.json({ success: true, message: "Account reconnected" });
  } catch (err) { next(err); }
});

// ── Delete account ──
router.delete("/:id", auth, async (req, res, next) => {
  try {
    const account = await Account.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });

    // Delete associated videos
    await Video.deleteMany({ accountId: req.params.id, userId: req.user.id });

    await logActivity(req.user.id, account._id, account.username, "disconnected",
      `@${account.username} disconnected`);

    res.json({ message: "Account deleted" });
  } catch (err) { next(err); }
});

// ── Get account stats ──
router.get("/:id/stats", auth, async (req, res, next) => {
  try {
    const account = await Account.findOne({ _id: req.params.id, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });

    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);

    const [todayPosted, weekPosted, totalQueued, totalFailed, recentPosts] = await Promise.all([
      Video.countDocuments({ accountId: account._id, status: "posted", postedAt: { $gte: todayStart } }),
      Video.countDocuments({ accountId: account._id, status: "posted", postedAt: { $gte: weekStart } }),
      Video.countDocuments({ accountId: account._id, status: { $in: ["queued", "downloaded", "scheduled"] } }),
      Video.countDocuments({ accountId: account._id, status: "failed" }),
      Video.find({ accountId: account._id, status: "posted" }).sort({ postedAt: -1 }).limit(10)
        .select("caption postedAt postUrl thumbnailUrl analytics"),
    ]);

    res.json({
      todayPosted,
      weekPosted,
      totalPosted: account.totalPosted,
      totalQueued,
      totalFailed,
      lastPostedAt: account.lastPostedAt,
      recentPosts,
    });
  } catch (err) { next(err); }
});

module.exports = router;
