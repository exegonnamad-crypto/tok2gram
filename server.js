const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(cors({
  origin: [
    "https://t2g.pages.dev",
    "https://reelflow.pages.dev",
    "http://localhost:5173",
    "http://localhost:3000",
    process.env.FRONTEND_URL,
  ].filter(Boolean),
  credentials: true,
}));

// ── DATABASE ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log("✅ MongoDB connected"))
  .catch(e => console.error("❌ DB Error:", e.message));

// ── SCHEMAS ───────────────────────────────────────────────────────────────────

const User = mongoose.model("User", new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, unique: true, lowercase: true, trim: true },
  password: String,
  plan: { type: String, default: "free" }, // free | starter | pro | agency
  videosPublished: { type: Number, default: 0 },
  trialEndsAt: { type: Date, default: () => new Date(Date.now() + 14 * 86400000) },
  createdAt: { type: Date, default: Date.now },
}));

const Account = mongoose.model("Account", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  username: { type: String, trim: true },
  igUserId: String,
  profilePic: { type: String, default: "" },
  accessToken: String,
  tokenExpiry: Date,
  niche: { type: String, default: "General" },
  postsPerDay: { type: Number, default: 5, min: 1, max: 25 },
  postingTimes: { type: [String], default: ["09:00", "12:00", "15:00", "18:00", "21:00"] },
  timezone: { type: String, default: "UTC" },
  captionStyle: { type: String, default: "original", enum: ["original", "custom", "none"] },
  customCaption: { type: String, default: "" },
  appendHashtags: { type: Boolean, default: true },
  hashtags: { type: String, default: "" },
  autoRequeue: { type: Boolean, default: false },
  status: { type: String, default: "active", enum: ["active", "paused", "error"] },
  totalPosted: { type: Number, default: 0 },
  lastPostedAt: Date,
  createdAt: { type: Date, default: Date.now },
}));

const Workflow = mongoose.model("Workflow", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  name: String,
  destinationAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
  captionStyle: { type: String, default: "original" },
  customCaption: { type: String, default: "" },
  hashtags: { type: String, default: "" },
  appendHashtags: { type: Boolean, default: true },
  autoPublish: { type: Boolean, default: true },
  status: { type: String, default: "active" },
  videosProcessed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
}));

const Video = mongoose.model("Video", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", index: true },
  workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "Workflow" },
  videoUrl: { type: String }, // renamed from tiktokUrl — generic
  videoAuthor: { type: String, default: "" },
  videoId: { type: String, default: "" },
  cloudinaryUrl: String,
  thumbnailUrl: { type: String, default: "" },
  caption: { type: String, default: "" },
  hashtags: { type: String, default: "" },
  duration: { type: Number, default: 0 },
  scheduledFor: Date,
  status: {
    type: String,
    enum: ["queued", "downloading", "downloaded", "scheduled", "posting", "posted", "failed"],
    default: "queued",
    index: true,
  },
  postedAt: Date,
  igPostId: String,
  error: { type: String, default: "" },
  retryCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
}));

const ActivityLog = mongoose.model("ActivityLog", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, index: true },
  accountId: mongoose.Schema.Types.ObjectId,
  accountUsername: String,
  action: String,
  message: String,
  createdAt: { type: Date, default: Date.now },
}));

const OAuthState = mongoose.model("OAuthState", new mongoose.Schema({
  state: String,
  userId: String,
  createdAt: { type: Date, default: Date.now, expires: 600 },
}));

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

// ── VALIDATION HELPERS ────────────────────────────────────────────────────────
const isValidUrl = (str) => {
  try { new URL(str); return true; } catch { return false; }
};

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "All fields are required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (await User.findOne({ email: email.toLowerCase() })) return res.status(400).json({ error: "Email already exists" });
    const hash = await bcrypt.hash(password, 12);
    const user = await User.create({ name: name.trim(), email: email.toLowerCase(), password: hash });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, plan: user.plan, trialEndsAt: user.trialEndsAt } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(400).json({ error: "Invalid email or password" });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, plan: user.plan, trialEndsAt: user.trialEndsAt } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/me", auth, async (req, res) => {
  try {
    const { name, email } = req.body;
    const update = {};
    if (name) update.name = name.trim();
    if (email) update.email = email.toLowerCase();
    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true }).select("-password");
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/me", auth, async (req, res) => {
  try {
    await Video.deleteMany({ userId: req.user.id });
    await Account.deleteMany({ userId: req.user.id });
    await Workflow.deleteMany({ userId: req.user.id });
    await ActivityLog.deleteMany({ userId: req.user.id });
    await User.findByIdAndDelete(req.user.id);
    res.json({ success: true, message: "Account and all data deleted" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── INSTAGRAM OAUTH ───────────────────────────────────────────────────────────
app.get("/api/oauth/instagram/url", auth, async (req, res) => {
  try {
    if (!process.env.META_APP_ID || !process.env.META_REDIRECT_URI)
      return res.status(500).json({ error: "OAuth not configured" });
    const state = Math.random().toString(36).substring(2) + Date.now();
    await OAuthState.create({ state, userId: req.user.id });
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      redirect_uri: process.env.META_REDIRECT_URI,
      scope: "instagram_business_basic,instagram_content_publish",
      response_type: "code",
      state,
    });
    res.json({ url: `https://www.instagram.com/oauth/authorize?${params}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/oauth/instagram/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "https://t2g.pages.dev";
  if (error) return res.redirect(`${frontendUrl}/?error=oauth_denied`);
  try {
    const oauthState = await OAuthState.findOne({ state });
    if (!oauthState) return res.redirect(`${frontendUrl}/?error=invalid_state`);

    // Exchange code for short-lived token (Instagram Business Login)
    const tokenRes = await axios.post("https://api.instagram.com/oauth/access_token",
      new URLSearchParams({
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: process.env.META_REDIRECT_URI,
        code,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const shortToken = tokenRes.data.access_token;
    const igUserId = String(tokenRes.data.user_id);

    // Exchange for long-lived token (60 days)
    const longTokenRes = await axios.get("https://graph.instagram.com/access_token", {
      params: {
        grant_type: "ig_exchange_token",
        client_secret: process.env.META_APP_SECRET,
        access_token: shortToken,
      },
    });

    const longToken = longTokenRes.data.access_token;
    const expiresIn = longTokenRes.data.expires_in || 5184000;

    // Get Instagram account info
    const igInfoRes = await axios.get(`https://graph.instagram.com/v18.0/${igUserId}`, {
      params: { fields: "id,username,profile_picture_url", access_token: longToken },
    });

    const igAccount = igInfoRes.data;
    if (!igAccount?.id) return res.redirect(`${frontendUrl}/?error=no_instagram`);

    const existing = await Account.findOne({ userId: oauthState.userId, igUserId: igAccount.id });
    if (existing) {
      await Account.findByIdAndUpdate(existing._id, {
        accessToken: longToken,
        tokenExpiry: new Date(Date.now() + expiresIn * 1000),
        username: igAccount.username,
        profilePic: igAccount.profile_picture_url || "",
        status: "active",
      });
    } else {
      await Account.create({
        userId: oauthState.userId,
        igUserId: igAccount.id,
        username: igAccount.username,
        profilePic: igAccount.profile_picture_url || "",
        accessToken: longToken,
        tokenExpiry: new Date(Date.now() + expiresIn * 1000),
      });
    }

    await OAuthState.deleteOne({ state });
    await logActivity(oauthState.userId, null, igAccount.username, "connected", `✅ @${igAccount.username} connected via OAuth`);
    res.redirect(`${frontendUrl}/?success=connected&username=${igAccount.username}`);
  } catch (e) {
    console.error("OAuth error:", e.message);
    res.redirect(`${process.env.FRONTEND_URL || "https://t2g.pages.dev"}/?error=oauth_failed`);
  }
});

// ── ACCOUNT ROUTES ────────────────────────────────────────────────────────────
app.get("/api/accounts", auth, async (req, res) => {
  try {
    const accounts = await Account.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(accounts.map(a => ({ ...a.toObject(), accessToken: "***" })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/accounts", auth, async (req, res) => {
  try {
    const { username, igUserId, accessToken, niche, postsPerDay, hashtags, captionStyle, customCaption, appendHashtags, autoRequeue } = req.body;
    if (!username || !igUserId || !accessToken) return res.status(400).json({ error: "username, igUserId and accessToken are required" });
    const acc = await Account.create({
      userId: req.user.id, username, igUserId, accessToken, niche,
      postsPerDay, hashtags, captionStyle, customCaption, appendHashtags, autoRequeue,
    });
    await logActivity(req.user.id, acc._id, acc.username, "connected", `@${acc.username} connected`);
    res.json({ ...acc.toObject(), accessToken: "***" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/accounts/:id", auth, async (req, res) => {
  try {
    const update = { ...req.body };
    if (!update.accessToken || update.accessToken === "***") delete update.accessToken;
    const acc = await Account.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      update,
      { new: true }
    );
    if (!acc) return res.status(404).json({ error: "Account not found" });
    res.json({ ...acc.toObject(), accessToken: "***" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/accounts/:id", auth, async (req, res) => {
  try {
    await Account.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    await Video.deleteMany({ accountId: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/accounts/:id/toggle", auth, async (req, res) => {
  try {
    const acc = await Account.findOne({ _id: req.params.id, userId: req.user.id });
    if (!acc) return res.status(404).json({ error: "Not found" });
    acc.status = acc.status === "active" ? "paused" : "active";
    await acc.save();
    res.json({ status: acc.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/accounts/:id/times", auth, async (req, res) => {
  try {
    const acc = await Account.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { postingTimes: req.body.postingTimes },
      { new: true }
    );
    if (!acc) return res.status(404).json({ error: "Account not found" });
    res.json({ postingTimes: acc.postingTimes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WORKFLOW ROUTES ───────────────────────────────────────────────────────────
app.get("/api/workflows", auth, async (req, res) => {
  try {
    const workflows = await Workflow.find({ userId: req.user.id })
      .populate("destinationAccountId", "username profilePic")
      .sort({ createdAt: -1 });
    res.json(workflows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/workflows", auth, async (req, res) => {
  try {
    const w = await Workflow.create({ userId: req.user.id, ...req.body });
    res.json(w);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/workflows/:id", auth, async (req, res) => {
  try {
    const w = await Workflow.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      req.body,
      { new: true }
    );
    res.json(w);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/workflows/:id", auth, async (req, res) => {
  try {
    await Workflow.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/workflows/:id/toggle", auth, async (req, res) => {
  try {
    const w = await Workflow.findOne({ _id: req.params.id, userId: req.user.id });
    if (!w) return res.status(404).json({ error: "Not found" });
    w.status = w.status === "active" ? "paused" : "active";
    await w.save();
    res.json({ status: w.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── VIDEO ROUTES ──────────────────────────────────────────────────────────────
app.post("/api/videos/bulk", auth, async (req, res) => {
  try {
    const { links, accountId, workflowId, scheduledFor } = req.body;
    if (!links || !Array.isArray(links) || links.length === 0)
      return res.status(400).json({ error: "No links provided" });
    if (!accountId) return res.status(400).json({ error: "Account ID required" });

    const account = await Account.findOne({ _id: accountId, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });

    // FIX: Accept ANY valid URL, not just tiktok.com
    const cleanLinks = links.map(l => l.trim()).filter(l => isValidUrl(l));
    if (cleanLinks.length === 0) return res.status(400).json({ error: "No valid URLs provided" });

    const existingUrls = (await Video.find({ accountId, videoUrl: { $in: cleanLinks } })).map(v => v.videoUrl);
    const newLinks = cleanLinks.filter(l => !existingUrls.includes(l));

    if (newLinks.length === 0) return res.json({ added: 0, skipped: cleanLinks.length, message: "All links already queued!" });

    const videos = await Video.insertMany(
      newLinks.map(url => ({
        userId: req.user.id,
        accountId,
        workflowId: workflowId || null,
        videoUrl: url,
        hashtags: account.hashtags || "",
        scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
        status: scheduledFor ? "scheduled" : "queued",
      }))
    );

    // Start downloads with staggered delays
    videos.filter(v => v.status === "queued").forEach((v, i) =>
      setTimeout(() => downloadVideo(v._id, v.videoUrl), i * 3000)
    );

    await logActivity(req.user.id, accountId, account.username, "queued", `${videos.length} videos added to queue`);
    res.json({ added: videos.length, skipped: existingUrls.length, message: `${videos.length} videos queued!` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/videos", auth, async (req, res) => {
  try {
    const filter = { userId: req.user.id };
    if (req.query.accountId) filter.accountId = req.query.accountId;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.workflowId) filter.workflowId = req.query.workflowId;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    res.json(await Video.find(filter).sort({ createdAt: -1 }).limit(limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/videos/:id", auth, async (req, res) => {
  try {
    await Video.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/videos/failed/all", auth, async (req, res) => {
  try {
    const r = await Video.deleteMany({ userId: req.user.id, status: "failed" });
    res.json({ deleted: r.deletedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/videos/:id/retry", auth, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.user.id });
    if (!video) return res.status(404).json({ error: "Not found" });
    await Video.findByIdAndUpdate(video._id, { status: "queued", error: "", retryCount: video.retryCount + 1 });
    setTimeout(() => downloadVideo(video._id, video.videoUrl), 1000);
    res.json({ message: "Retrying..." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/videos/:id/post-now", auth, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.user.id, status: "downloaded" });
    if (!video) return res.status(404).json({ error: "Video not ready to post (must be in downloaded state)" });
    postToInstagram(video._id);
    res.json({ message: "Posting now..." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/videos/:id/schedule", auth, async (req, res) => {
  try {
    const { scheduledFor } = req.body;
    if (!scheduledFor) return res.status(400).json({ error: "scheduledFor date required" });
    await Video.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { scheduledFor: new Date(scheduledFor), status: "scheduled" }
    );
    res.json({ message: "Scheduled!" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CALENDAR ──────────────────────────────────────────────────────────────────
app.get("/api/calendar", auth, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: "start and end dates required" });
    const videos = await Video.find({
      userId: req.user.id,
      $or: [
        { status: "scheduled", scheduledFor: { $gte: new Date(start), $lte: new Date(end) } },
        { status: "posted", postedAt: { $gte: new Date(start), $lte: new Date(end) } },
      ],
    }).populate("accountId", "username profilePic").sort({ scheduledFor: 1, postedAt: 1 });
    res.json(videos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STATS & ACTIVITY ──────────────────────────────────────────────────────────
app.get("/api/stats", auth, async (req, res) => {
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const [accounts, user] = await Promise.all([
      Account.find({ userId: req.user.id }),
      User.findById(req.user.id),
    ]);

    const accountStats = await Promise.all(accounts.map(async acc => ({
      id: acc._id,
      username: acc.username,
      profilePic: acc.profilePic,
      niche: acc.niche,
      status: acc.status,
      postingTimes: acc.postingTimes,
      postsPerDay: acc.postsPerDay,
      totalPosted: acc.totalPosted,
      lastPostedAt: acc.lastPostedAt,
      tokenExpiry: acc.tokenExpiry,
      queued: await Video.countDocuments({ accountId: acc._id, status: { $in: ["queued", "downloaded", "scheduled"] } }),
      failed: await Video.countDocuments({ accountId: acc._id, status: "failed" }),
      todayPosted: await Video.countDocuments({ accountId: acc._id, status: "posted", postedAt: { $gte: todayStart } }),
      weekPosted: await Video.countDocuments({ accountId: acc._id, status: "posted", postedAt: { $gte: weekStart } }),
    })));

    res.json({
      accounts: accounts.length,
      totalPosted: await Video.countDocuments({ userId: req.user.id, status: "posted" }),
      totalQueued: await Video.countDocuments({ userId: req.user.id, status: { $in: ["queued", "downloaded", "scheduled"] } }),
      totalFailed: await Video.countDocuments({ userId: req.user.id, status: "failed" }),
      todayPosted: await Video.countDocuments({ userId: req.user.id, status: "posted", postedAt: { $gte: todayStart } }),
      weekPosted: await Video.countDocuments({ userId: req.user.id, status: "posted", postedAt: { $gte: weekStart } }),
      monthPosted: await Video.countDocuments({ userId: req.user.id, status: "posted", postedAt: { $gte: monthStart } }),
      workflows: await Workflow.countDocuments({ userId: req.user.id }),
      plan: user?.plan,
      trialEndsAt: user?.trialEndsAt,
      videosPublished: user?.videosPublished,
      accountStats,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/activity", auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const logs = await ActivityLog.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(limit);
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function logActivity(userId, accountId, accountUsername, action, message) {
  try { await ActivityLog.create({ userId, accountId, accountUsername, action, message }); } catch {}
}

// ── DOWNLOAD PIPELINE ─────────────────────────────────────────────────────────
async function getVideoInfo(videoUrl) {
  // Try tikwm.com API for TikTok URLs
  if (videoUrl.includes("tiktok.com")) {
    const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(videoUrl)}&hd=1`;
    const response = await axios.get(apiUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 15000,
    });
    const data = response.data;
    if (data.code === 0 && data.data) {
      return {
        videoUrl: data.data.play || data.data.wmplay,
        caption: data.data.title || "",
        author: data.data.author?.nickname || data.data.author?.unique_id || "",
        videoId: data.data.id || "",
        thumbnail: data.data.cover || "",
        duration: data.data.duration || 0,
      };
    }
    throw new Error("Video API failed — video may be private or deleted");
  }

  // For non-TikTok URLs — treat the URL itself as the direct video URL
  return {
    videoUrl: videoUrl,
    caption: "",
    author: "",
    videoId: "",
    thumbnail: "",
    duration: 0,
  };
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => { fs.unlink(dest, () => {}); reject(err); });
  });
}

async function downloadVideo(videoId, url) {
  await Video.findByIdAndUpdate(videoId, { status: "downloading", error: "" });
  const dir = path.join(__dirname, "downloads");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${videoId}.mp4`);
  try {
    const info = await getVideoInfo(url);
    await downloadFile(info.videoUrl, out);

    // Verify file was actually downloaded
    const stats = fs.statSync(out);
    if (stats.size < 1000) throw new Error("Downloaded file too small — likely invalid");

    await Video.findByIdAndUpdate(videoId, {
      status: "downloaded",
      caption: info.caption,
      videoAuthor: info.author,
      videoId: info.videoId,
      thumbnailUrl: info.thumbnail,
      duration: info.duration,
    });
    console.log(`✅ Downloaded: ${videoId}`);
    uploadToCloudinary(videoId, out);
  } catch (err) {
    console.error(`❌ Download failed: ${err.message}`);
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: err.message });
  }
}

async function uploadToCloudinary(videoId, filePath) {
  try {
    const cloudinary = require("cloudinary").v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: "video",
      folder: "reelflow",
      timeout: 120000,
    });
    await Video.findByIdAndUpdate(videoId, { cloudinaryUrl: result.secure_url });
    fs.unlink(filePath, () => {});
    console.log(`☁️ Cloudinary done: ${videoId}`);
  } catch (e) {
    console.error("❌ Cloudinary error:", e.message);
    await Video.findByIdAndUpdate(videoId, { error: `Cloudinary: ${e.message}` });
  }
}

// ── INSTAGRAM POSTING ─────────────────────────────────────────────────────────
function buildCaption(video, account) {
  let caption = "";
  if (account.captionStyle === "original") caption = video.caption || "";
  else if (account.captionStyle === "custom") caption = account.customCaption || "";
  // "none" = empty caption
  if (account.appendHashtags && account.hashtags) {
    caption = caption ? `${caption}\n\n${account.hashtags}` : account.hashtags;
  }
  return caption.trim().slice(0, 2200);
}

async function postToInstagram(videoId) {
  const video = await Video.findById(videoId).populate("accountId");
  if (!video?.accountId) {
    console.error(`❌ No account found for video ${videoId}`);
    return;
  }
  const account = video.accountId;
  const { accessToken, igUserId, username } = account;

  if (!accessToken || !igUserId) {
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: "Account missing token or Instagram ID" });
    return;
  }

  try {
    await Video.findByIdAndUpdate(videoId, { status: "posting", error: "" });
    if (!video.cloudinaryUrl) throw new Error("No public video URL — still uploading to cloud");

    const caption = buildCaption(video, account);

    // Step 1: Create media container
    const r1 = await fetch(`https://graph.facebook.com/v18.0/${igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: "REELS",
        video_url: video.cloudinaryUrl,
        caption,
        access_token: accessToken,
      }),
    });
    const container = await r1.json();
    if (container.error) throw new Error(container.error.message);
    if (!container.id) throw new Error("No container ID returned from Instagram");

    // Step 2: Poll until ready (max 2 minutes)
    let ready = false;
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const r2 = await fetch(
        `https://graph.facebook.com/v18.0/${container.id}?fields=status_code,status&access_token=${accessToken}`
      );
      const s = await r2.json();
      if (s.status_code === "FINISHED") { ready = true; break; }
      if (s.status_code === "ERROR") throw new Error(`Instagram container error: ${s.status}`);
      console.log(`⏳ Container status: ${s.status_code} (attempt ${i + 1}/12)`);
    }
    if (!ready) throw new Error("Instagram container timed out after 2 minutes");

    // Step 3: Publish
    const r3 = await fetch(`https://graph.facebook.com/v18.0/${igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: container.id, access_token: accessToken }),
    });
    const published = await r3.json();
    if (published.error) throw new Error(published.error.message);

    await Video.findByIdAndUpdate(videoId, { status: "posted", postedAt: new Date(), igPostId: published.id, error: "" });
    await Account.findByIdAndUpdate(account._id, { $inc: { totalPosted: 1 }, lastPostedAt: new Date() });
    await User.findByIdAndUpdate(account.userId, { $inc: { videosPublished: 1 } });
    if (video.workflowId) await Workflow.findByIdAndUpdate(video.workflowId, { $inc: { videosProcessed: 1 } });
    await logActivity(account.userId, account._id, username, "posted", `✅ Posted reel to @${username}`);
    console.log(`🎉 Posted to @${username}`);

    if (account.autoRequeue) {
      await Video.findByIdAndUpdate(videoId, { status: "downloaded", postedAt: null, igPostId: null });
    }
  } catch (e) {
    const v2 = await Video.findById(videoId);
    const isTransient = e.message.includes("transient") || e.message.includes("timeout") || e.message.includes("timed out");
    if (v2 && v2.retryCount < 3 && isTransient) {
      await Video.findByIdAndUpdate(videoId, { status: "downloaded", $inc: { retryCount: 1 } });
      setTimeout(() => postToInstagram(videoId), 60000);
      console.log(`🔄 Retrying post for ${videoId} in 60s (attempt ${v2.retryCount + 1})`);
      return;
    }
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: e.message });
    await logActivity(account.userId, account._id, username, "failed", `❌ Post failed @${username}: ${e.message}`);
    console.error(`❌ Post failed @${username}: ${e.message}`);
  }
}

// ── SCHEDULER ─────────────────────────────────────────────────────────────────
// Auto-post at scheduled times (runs every minute)
cron.schedule("* * * * *", async () => {
  try {
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const activeAccounts = await Account.find({ status: "active" });
    for (const acc of activeAccounts) {
      if (!acc.postingTimes.includes(t)) continue;
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const posted = await Video.countDocuments({ accountId: acc._id, status: "posted", postedAt: { $gte: todayStart } });
      if (posted >= acc.postsPerDay) continue;
      // Check nothing is currently posting for this account
      const posting = await Video.countDocuments({ accountId: acc._id, status: "posting" });
      if (posting > 0) continue;
      const next = await Video.findOne({ accountId: acc._id, status: "downloaded" }).sort({ createdAt: 1 });
      if (!next) { console.log(`⚠️ No ready videos for @${acc.username}`); continue; }
      console.log(`⏰ Auto-posting for @${acc.username}`);
      postToInstagram(next._id);
    }
  } catch (e) { console.error("Scheduler error:", e.message); }
});

// Post scheduled videos (specific datetime)
cron.schedule("* * * * *", async () => {
  try {
    const now = new Date();
    const scheduled = await Video.find({ status: "scheduled", scheduledFor: { $lte: now } }).populate("accountId");
    for (const v of scheduled) {
      if (v.cloudinaryUrl && v.accountId) {
        console.log(`📅 Posting scheduled video for @${v.accountId?.username}`);
        postToInstagram(v._id);
      }
    }
  } catch (e) { console.error("Schedule runner error:", e.message); }
});

// Auto-retry failed downloads every 30 mins
cron.schedule("*/30 * * * *", async () => {
  try {
    const failed = await Video.find({ status: "failed", retryCount: { $lt: 3 }, cloudinaryUrl: null });
    for (const v of failed) {
      await Video.findByIdAndUpdate(v._id, { status: "queued", retryCount: v.retryCount + 1 });
      setTimeout(() => downloadVideo(v._id, v.videoUrl), 2000);
    }
    if (failed.length > 0) console.log(`🔄 Auto-retrying ${failed.length} failed downloads`);
  } catch (e) { console.error("Retry cron error:", e.message); }
});

// Token expiry warning — daily at 9am UTC
cron.schedule("0 9 * * *", async () => {
  try {
    const soon = new Date(Date.now() + 7 * 86400000);
    const expiring = await Account.find({ tokenExpiry: { $lte: soon }, status: "active" });
    for (const acc of expiring) {
      await logActivity(acc.userId, acc._id, acc.username, "warning",
        `⚠️ @${acc.username} token expires soon — please reconnect`);
    }
  } catch (e) { console.error("Token check error:", e.message); }
});

// ── HEALTH & ROOT ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "✅ ReelFlow API v3.0", version: "3.0.0", uptime: process.uptime() }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime(), timestamp: new Date().toISOString() }));

// ── ERROR HANDLER ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(process.env.PORT || 3001, () => console.log(`🚀 ReelFlow v3.0 running on port ${process.env.PORT || 3001}`));
