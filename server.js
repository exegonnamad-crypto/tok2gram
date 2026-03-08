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
const crypto = require("crypto");
const { spawn } = require("child_process");
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

const ADMIN_EMAIL = "v1amp@proton.me";
const PLANS = {
  free:   { postsPerDay: 1,   maxAccounts: 1,  price: 0  },
  trial:  { postsPerDay: 1,   maxAccounts: 1,  price: 0  },
  pro:    { postsPerDay: 999, maxAccounts: 5,  price: 12 },
  agency: { postsPerDay: 999, maxAccounts: 25, price: 39 },
  admin:  { postsPerDay: 999, maxAccounts: 999,price: 0  },
};

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
  plan: { type: String, default: "trial" },
  planExpiresAt: Date,
  videosPublished: { type: Number, default: 0 },
  trialEndsAt: { type: Date, default: () => new Date(Date.now() + 14 * 86400000) },
  isAdmin: { type: Boolean, default: false },
  telegramBotToken: { type: String, default: "" },
  telegramChatId: { type: String, default: "" },
  notifyOnPost: { type: Boolean, default: false },
  notifyOnError: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
}));

const Account = mongoose.model("Account", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  username: { type: String, trim: true },
  igPassword: { type: String, default: "" },
  igUserId: { type: String, default: "" },
  sessionData: { type: String, default: "" },
  sessionSavedAt: Date,
  niche: { type: String, default: "General" },
  postsPerDay: { type: Number, default: 5, min: 1, max: 25 },
  postingTimes: { type: [String], default: ["09:00", "12:00", "15:00", "18:00", "21:00"] },
  captionStyle: { type: String, default: "original", enum: ["original", "custom", "none"] },
  customCaption: { type: String, default: "" },
  hashtags: { type: String, default: "" },
  firstComment: { type: String, default: "" },
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
  autoPublish: { type: Boolean, default: true },
  status: { type: String, default: "active" },
  videosProcessed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
}));

const Video = mongoose.model("Video", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", index: true },
  workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "Workflow" },
  videoUrl: String,
  videoAuthor: { type: String, default: "" },
  videoId: { type: String, default: "" },
  cloudinaryUrl: String,
  localPath: { type: String, default: "" },
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

const Payment = mongoose.model("Payment", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, index: true },
  paymentId: String,
  orderId: String,
  plan: String,
  amount: Number,
  currency: String,
  status: { type: String, default: "pending" },
  createdAt: { type: Date, default: Date.now },
}));

// ── HELPERS ───────────────────────────────────────────────────────────────────
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

const adminAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user?.isAdmin) return res.status(403).json({ error: "Admin only" });
    req.user = decoded;
    req.adminUser = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

const isValidUrl = (str) => {
  try { new URL(str); return true; } catch { return false; }
};

async function logActivity(userId, accountId, accountUsername, action, message) {
  try { await ActivityLog.create({ userId, accountId, accountUsername, action, message }); } catch {}
}

function getPlanLimits(plan) {
  return PLANS[plan] || PLANS.free;
}

// ── TELEGRAM ──────────────────────────────────────────────────────────────────
async function sendTelegram(botToken, chatId, message) {
  if (!botToken || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
    }, { timeout: 10000 });
  } catch (e) {
    console.error("❌ Telegram error:", e.message);
  }
}

async function notifyUser(userId, message) {
  try {
    const user = await User.findById(userId);
    if (!user) return;
    if (user.telegramBotToken && user.telegramChatId) {
      await sendTelegram(user.telegramBotToken, user.telegramChatId, message);
    }
  } catch {}
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (await User.findOne({ email: email.toLowerCase() })) return res.status(400).json({ error: "Email already exists" });
    const hash = await bcrypt.hash(password, 12);
    const isAdmin = email.toLowerCase() === ADMIN_EMAIL;
    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase(),
      password: hash,
      isAdmin,
      plan: isAdmin ? "admin" : "trial",
    });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, plan: user.plan, isAdmin: user.isAdmin } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(400).json({ error: "Invalid email or password" });
    // Auto-upgrade admin email
    if (email.toLowerCase() === ADMIN_EMAIL && !user.isAdmin) {
      await User.findByIdAndUpdate(user._id, { isAdmin: true, plan: "admin" });
      user.isAdmin = true; user.plan = "admin";
    }
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, plan: user.plan, isAdmin: user.isAdmin } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/me/notifications", auth, async (req, res) => {
  try {
    const { telegramBotToken, telegramChatId, notifyOnPost, notifyOnError } = req.body;
    const user = await User.findByIdAndUpdate(req.user.id, {
      telegramBotToken, telegramChatId, notifyOnPost, notifyOnError,
    }, { new: true }).select("-password");
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/me/test-telegram", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user.telegramBotToken || !user.telegramChatId)
      return res.status(400).json({ error: "Telegram not configured" });
    await sendTelegram(user.telegramBotToken, user.telegramChatId, "✅ <b>ReelFlow</b> — Telegram notifications working!");
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PYTHON / INSTAGRAPI ───────────────────────────────────────────────────────
function runPython(script) {
  return new Promise((resolve) => {
    const py = spawn("python3", ["-c", script]);
    let out = "", err = "";
    py.stdout.on("data", d => out += d.toString());
    py.stderr.on("data", d => err += d.toString());
    py.on("close", () => {
      console.log(`🐍 Python stdout: ${out.slice(0, 300)}`);
      if (err) console.log(`🐍 Python stderr: ${err.slice(0, 200)}`);
      try { resolve(JSON.parse(out.trim())); }
      catch { resolve({ success: false, error: err || out || "Python error" }); }
    });
    setTimeout(() => { py.kill(); resolve({ success: false, error: "Timeout" }); }, 120000);
  });
}

async function instagrapiLogin(username, password) {
  const script = `
import sys, json
try:
    from instagrapi import Client
    cl = Client()
    cl.delay_range = [2, 5]
    cl.login("${username.replace(/"/g, '')}", "${password.replace(/"/g, '')}")
    session = json.dumps(cl.get_settings())
    uid = str(cl.user_id)
    print(json.dumps({"success": True, "userId": uid, "username": "${username}", "sessionData": session}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
  return runPython(script);
}

// ── INSTAGRAM VERIFY ──────────────────────────────────────────────────────────
app.post("/api/instagram/verify", auth, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  const result = await instagrapiLogin(username, password);
  if (result.success) res.json({ success: true, userId: result.userId, username: result.username });
  else res.status(400).json({ success: false, error: result.error });
});

// ── ACCOUNT ROUTES ────────────────────────────────────────────────────────────
app.get("/api/accounts", auth, async (req, res) => {
  try {
    const accounts = await Account.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(accounts.map(a => ({ ...a.toObject(), igPassword: a.igPassword ? "***" : "", sessionData: undefined })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/accounts", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const limits = getPlanLimits(user.plan);
    const accountCount = await Account.countDocuments({ userId: req.user.id });
    if (accountCount >= limits.maxAccounts && !user.isAdmin)
      return res.status(403).json({ error: `Your ${user.plan} plan allows max ${limits.maxAccounts} account(s). Upgrade to add more.` });

    const { username, igPassword, niche, postsPerDay, hashtags, captionStyle, customCaption, autoRequeue, postingTimes, firstComment } = req.body;
    if (!username || !igPassword) return res.status(400).json({ error: "Instagram username and password required" });

    const loginResult = await instagrapiLogin(username, igPassword);
    if (!loginResult.success) return res.status(400).json({ error: `Instagram login failed: ${loginResult.error}` });

    const acc = await Account.create({
      userId: req.user.id,
      username: username.replace("@", "").toLowerCase().trim(),
      igUserId: loginResult.userId || "",
      igPassword,
      sessionData: loginResult.sessionData || "",
      sessionSavedAt: new Date(),
      niche: niche || "General",
      postsPerDay: postsPerDay || 5,
      hashtags: hashtags || "",
      captionStyle: captionStyle || "original",
      customCaption: customCaption || "",
      autoRequeue: autoRequeue || false,
      postingTimes: postingTimes || ["09:00", "12:00", "15:00", "18:00", "21:00"],
      firstComment: firstComment || "",
    });

    await logActivity(req.user.id, acc._id, acc.username, "connected", `✅ @${acc.username} connected`);
    await notifyUser(req.user.id, `✅ <b>@${acc.username}</b> connected to ReelFlow!`);
    res.json({ ...acc.toObject(), igPassword: "***", sessionData: undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/accounts/:id", auth, async (req, res) => {
  try {
    const update = { ...req.body };
    if (update.igPassword && update.igPassword !== "***") {
      const loginResult = await instagrapiLogin(update.username || "", update.igPassword);
      if (!loginResult.success) return res.status(400).json({ error: `Instagram login failed: ${loginResult.error}` });
      update.igUserId = loginResult.userId || "";
      update.sessionData = loginResult.sessionData || "";
      update.sessionSavedAt = new Date();
    } else {
      delete update.igPassword;
    }
    const acc = await Account.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      update,
      { new: true }
    );
    if (!acc) return res.status(404).json({ error: "Account not found" });
    res.json({ ...acc.toObject(), igPassword: "***", sessionData: undefined });
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

// ── WORKFLOW ROUTES ───────────────────────────────────────────────────────────
app.get("/api/workflows", auth, async (req, res) => {
  try {
    const workflows = await Workflow.find({ userId: req.user.id })
      .populate("destinationAccountId", "username")
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
    const w = await Workflow.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, req.body, { new: true });
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
    const { links, accountId, scheduledFor } = req.body;
    if (!links || !Array.isArray(links) || links.length === 0)
      return res.status(400).json({ error: "No links provided" });
    if (!accountId) return res.status(400).json({ error: "Account ID required" });

    const account = await Account.findOne({ _id: accountId, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });

    const cleanLinks = links.map(l => l.trim()).filter(l => isValidUrl(l));
    if (cleanLinks.length === 0) return res.status(400).json({ error: "No valid URLs provided" });

    const existingUrls = (await Video.find({ accountId, videoUrl: { $in: cleanLinks } })).map(v => v.videoUrl);
    const newLinks = cleanLinks.filter(l => !existingUrls.includes(l));
    if (newLinks.length === 0) return res.json({ added: 0, skipped: cleanLinks.length, message: "All links already queued!" });

    const videos = await Video.insertMany(
      newLinks.map(url => ({
        userId: req.user.id,
        accountId,
        videoUrl: url,
        hashtags: account.hashtags || "",
        scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
        status: scheduledFor ? "scheduled" : "queued",
      }))
    );

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
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    res.json(await Video.find(filter).populate("accountId", "username").sort({ createdAt: -1 }).limit(limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/videos/:id", auth, async (req, res) => {
  try {
    await Video.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/videos/clear-failed", auth, async (req, res) => {
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
    const video = await Video.findOne({ _id: req.params.id, userId: req.user.id });
    if (!video) return res.status(404).json({ error: "Video not found" });
    if (!["downloaded", "failed", "scheduled"].includes(video.status))
      return res.status(400).json({ error: "Video must be downloaded first" });
    postToInstagram(video._id);
    res.json({ message: "Posting now..." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CALENDAR ──────────────────────────────────────────────────────────────────
app.get("/api/calendar", auth, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: "start and end required" });
    const videos = await Video.find({
      userId: req.user.id,
      $or: [
        { status: "scheduled", scheduledFor: { $gte: new Date(start), $lte: new Date(end) } },
        { status: "posted", postedAt: { $gte: new Date(start), $lte: new Date(end) } },
      ],
    }).populate("accountId", "username").sort({ scheduledFor: 1, postedAt: 1 });
    res.json(videos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STATS & ACTIVITY ──────────────────────────────────────────────────────────
app.get("/api/stats", auth, async (req, res) => {
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);
    const [accounts, user] = await Promise.all([
      Account.find({ userId: req.user.id }),
      User.findById(req.user.id),
    ]);
    const limits = getPlanLimits(user.plan);
    const accountStats = await Promise.all(accounts.map(async acc => ({
      id: acc._id,
      username: acc.username,
      niche: acc.niche,
      status: acc.status,
      postingTimes: acc.postingTimes,
      postsPerDay: acc.postsPerDay,
      totalPosted: acc.totalPosted,
      lastPostedAt: acc.lastPostedAt,
      queued: await Video.countDocuments({ accountId: acc._id, status: { $in: ["queued", "downloaded", "scheduled"] } }),
      todayPosted: await Video.countDocuments({ accountId: acc._id, status: "posted", postedAt: { $gte: todayStart } }),
    })));
    res.json({
      accounts: accounts.length,
      totalPosted: await Video.countDocuments({ userId: req.user.id, status: "posted" }),
      totalQueued: await Video.countDocuments({ userId: req.user.id, status: { $in: ["queued", "downloaded", "scheduled"] } }),
      totalFailed: await Video.countDocuments({ userId: req.user.id, status: "failed" }),
      todayPosted: await Video.countDocuments({ userId: req.user.id, status: "posted", postedAt: { $gte: todayStart } }),
      weekPosted: await Video.countDocuments({ userId: req.user.id, status: "posted", postedAt: { $gte: weekStart } }),
      plan: user?.plan,
      planLimits: limits,
      trialEndsAt: user?.trialEndsAt,
      planExpiresAt: user?.planExpiresAt,
      accountStats,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/activity", auth, async (req, res) => {
  try {
    const logs = await ActivityLog.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50);
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PAYMENTS (NOWPayments) ────────────────────────────────────────────────────
app.post("/api/payments/create", auth, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!["pro", "agency"].includes(plan)) return res.status(400).json({ error: "Invalid plan" });
    const planDetails = PLANS[plan];
    const user = await User.findById(req.user.id);

    const response = await axios.post("https://api.nowpayments.io/v1/payment", {
      price_amount: planDetails.price,
      price_currency: "usd",
      pay_currency: "usdttrc20",
      order_id: `${req.user.id}_${plan}_${Date.now()}`,
      order_description: `ReelFlow ${plan} plan - 30 days`,
      ipn_callback_url: `${process.env.BACKEND_URL || "https://tok2gram-production.up.railway.app"}/api/payments/webhook`,
    }, {
      headers: {
        "x-api-key": process.env.NOWPAYMENTS_API_KEY,
        "Content-Type": "application/json",
      },
    });

    const payment = response.data;
    await Payment.create({
      userId: req.user.id,
      paymentId: payment.payment_id,
      orderId: payment.order_id,
      plan,
      amount: planDetails.price,
      currency: "usd",
      status: "pending",
    });

    res.json({
      paymentId: payment.payment_id,
      payAddress: payment.pay_address,
      payAmount: payment.pay_amount,
      payCurrency: payment.pay_currency,
      status: payment.payment_status,
      plan,
      price: planDetails.price,
    });
  } catch (e) {
    console.error("Payment error:", e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

app.post("/api/payments/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const sig = req.headers["x-nowpayments-sig"];
    const secret = process.env.NOWPAYMENTS_IPN_SECRET;
    if (secret && sig) {
      const body = req.body.toString();
      const hmac = crypto.createHmac("sha512", secret).update(body).digest("hex");
      if (hmac !== sig) return res.status(401).json({ error: "Invalid signature" });
    }

    const data = JSON.parse(req.body.toString());
    const { payment_id, payment_status, order_id } = data;

    if (payment_status === "finished" || payment_status === "confirmed") {
      const payment = await Payment.findOneAndUpdate(
        { paymentId: payment_id },
        { status: "completed" },
        { new: true }
      );
      if (payment) {
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await User.findByIdAndUpdate(payment.userId, {
          plan: payment.plan,
          planExpiresAt: expiresAt,
        });
        await notifyUser(payment.userId, `🎉 <b>Payment confirmed!</b>\nYour ReelFlow <b>${payment.plan}</b> plan is now active for 30 days.`);
        await logActivity(payment.userId, null, null, "payment", `✅ ${payment.plan} plan activated via crypto payment`);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Webhook error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/payments/status/:paymentId", auth, async (req, res) => {
  try {
    const response = await axios.get(`https://api.nowpayments.io/v1/payment/${req.params.paymentId}`, {
      headers: { "x-api-key": process.env.NOWPAYMENTS_API_KEY },
    });
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const [totalUsers, totalVideos, totalPosted, totalAccounts, payments] = await Promise.all([
      User.countDocuments(),
      Video.countDocuments(),
      Video.countDocuments({ status: "posted" }),
      Account.countDocuments(),
      Payment.find({ status: "completed" }),
    ]);
    const revenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const planBreakdown = await User.aggregate([{ $group: { _id: "$plan", count: { $sum: 1 } } }]);
    res.json({ totalUsers, totalVideos, totalPosted, totalAccounts, revenue, planBreakdown });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/users", adminAuth, async (req, res) => {
  try {
    const { search, plan } = req.query;
    const filter = {};
    if (search) filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
    if (plan) filter.plan = plan;
    const users = await User.find(filter).select("-password").sort({ createdAt: -1 }).limit(100);
    const usersWithStats = await Promise.all(users.map(async u => ({
      ...u.toObject(),
      accountCount: await Account.countDocuments({ userId: u._id }),
      totalPosted: await Video.countDocuments({ userId: u._id, status: "posted" }),
    })));
    res.json(usersWithStats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/admin/users/:id", adminAuth, async (req, res) => {
  try {
    const { plan, planExpiresAt } = req.body;
    const user = await User.findByIdAndUpdate(req.params.id, { plan, planExpiresAt }, { new: true }).select("-password");
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/users/:id", adminAuth, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    await Account.deleteMany({ userId: req.params.id });
    await Video.deleteMany({ userId: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/logs", adminAuth, async (req, res) => {
  try {
    const logs = await ActivityLog.find().sort({ createdAt: -1 }).limit(200);
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: post on behalf of any user
app.post("/api/admin/post/:videoId", adminAuth, async (req, res) => {
  try {
    const video = await Video.findById(req.params.videoId);
    if (!video) return res.status(404).json({ error: "Video not found" });
    postToInstagram(video._id);
    res.json({ message: "Posting now..." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DOWNLOAD PIPELINE ─────────────────────────────────────────────────────────
async function getVideoInfo(videoUrl) {
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
        author: data.data.author?.nickname || "",
        videoId: data.data.id || "",
        thumbnail: data.data.cover || "",
        duration: data.data.duration || 0,
      };
    }
    throw new Error("Video unavailable — may be private or deleted");
  }
  return { videoUrl, caption: "", author: "", videoId: "", thumbnail: "", duration: 0 };
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
    const stats = fs.statSync(out);
    if (stats.size < 1000) throw new Error("File too small — invalid video");
    await Video.findByIdAndUpdate(videoId, {
      status: "downloaded",
      localPath: out,
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
  }
}

// ── CAPTION BUILDER ───────────────────────────────────────────────────────────
function buildCaption(video, account) {
  let caption = "";
  if (account.captionStyle === "original") caption = video.caption || "";
  else if (account.captionStyle === "custom") caption = account.customCaption || "";
  if (account.hashtags) {
    caption = caption ? `${caption}\n\n${account.hashtags}` : account.hashtags;
  }
  return caption.trim().slice(0, 2200);
}

// ── POST TO INSTAGRAM ─────────────────────────────────────────────────────────
async function postToInstagram(videoId) {
  const video = await Video.findById(videoId).populate("accountId");
  if (!video?.accountId) return;
  const account = video.accountId;

  // Check plan limits
  const user = await User.findById(account.userId);
  if (user && !user.isAdmin) {
    const limits = getPlanLimits(user.plan);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayPosted = await Video.countDocuments({
      userId: account.userId,
      status: "posted",
      postedAt: { $gte: todayStart },
    });
    if (todayPosted >= limits.postsPerDay) {
      await Video.findByIdAndUpdate(videoId, {
        status: "failed",
        error: `Daily limit reached (${limits.postsPerDay}/day on ${user.plan} plan). Upgrade to post more.`,
      });
      await notifyUser(account.userId, `⚠️ Daily post limit reached on your <b>${user.plan}</b> plan. Upgrade to post more!`);
      return;
    }
  }

  if (!account.sessionData) {
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: "No Instagram session — please reconnect account" });
    return;
  }

  try {
    await Video.findByIdAndUpdate(videoId, { status: "posting", error: "" });
    console.log(`📤 Posting for @${account.username}...`);

    let videoPath = video.localPath;
    if (!videoPath || !fs.existsSync(videoPath)) {
      if (!video.cloudinaryUrl) throw new Error("No video file available");
      const dir = path.join(__dirname, "downloads");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      videoPath = path.join(dir, `post_${videoId}.mp4`);
      await downloadFile(video.cloudinaryUrl, videoPath);
    }

    const caption = buildCaption(video, account);
    const sessionFile = path.join(__dirname, "downloads", `session_${videoId}.json`);
    fs.writeFileSync(sessionFile, account.sessionData);

    const firstComment = account.firstComment || "";
    const script = `
import sys, json
try:
    from instagrapi import Client
    cl = Client()
    cl.delay_range = [1, 3]
    with open("${sessionFile.replace(/\\/g, "/")}", "r") as f:
        settings = json.load(f)
    cl.set_settings(settings)
    cl.get_timeline_feed()
    media = cl.clip_upload(
        "${videoPath.replace(/\\/g, "/")}",
        caption=${JSON.stringify(caption)}
    )
    media_id = str(media.pk)
    first_comment_result = None
    ${firstComment ? `
    try:
        cl.media_comment(media_id, ${JSON.stringify(firstComment)})
        first_comment_result = True
    except Exception as ce:
        first_comment_result = str(ce)
    ` : ""}
    try:
        new_session = json.dumps(cl.get_settings())
    except:
        new_session = ""
    print(json.dumps({"success": True, "mediaId": media_id, "sessionData": new_session, "firstComment": first_comment_result}))
except Exception as e:
    err = str(e)
    print(json.dumps({"success": False, "error": err}))
`;

    const result = await runPython(script);
    fs.unlink(sessionFile, () => {});

    if (!result.success) throw new Error(result.error);

    if (result.sessionData) {
      await Account.findByIdAndUpdate(account._id, {
        sessionData: result.sessionData,
        sessionSavedAt: new Date(),
      });
    }

    await Account.findByIdAndUpdate(account._id, {
      $inc: { totalPosted: 1 },
      lastPostedAt: new Date(),
      status: "active",
    });

    await Video.findByIdAndUpdate(videoId, {
      status: "posted",
      postedAt: new Date(),
      igPostId: result.mediaId || "",
      error: "",
    });

    await User.findByIdAndUpdate(account.userId, { $inc: { videosPublished: 1 } });
    if (video.workflowId) await Workflow.findByIdAndUpdate(video.workflowId, { $inc: { videosProcessed: 1 } });
    await logActivity(account.userId, account._id, account.username, "posted", `✅ Posted reel to @${account.username}`);

    // Telegram notification
    if (user?.notifyOnPost) {
      await notifyUser(account.userId, `✅ <b>Reel posted!</b>\nAccount: @${account.username}\nCaption: ${caption.slice(0, 100)}`);
    }

    console.log(`🎉 Posted to @${account.username}`);

    if (account.autoRequeue) {
      await Video.findByIdAndUpdate(videoId, { status: "downloaded", postedAt: null, igPostId: null });
    }
    if (videoPath.includes("post_")) fs.unlink(videoPath, () => {});

  } catch (e) {
    console.error(`❌ Post failed @${account.username}: ${e.message}`);
    const v2 = await Video.findById(videoId);
    const isSessionError = e.message.includes("login") || e.message.includes("LoginRequired") || e.message.includes("session");
    if (v2 && v2.retryCount < 2 && !isSessionError) {
      await Video.findByIdAndUpdate(videoId, { status: "downloaded", $inc: { retryCount: 1 } });
      setTimeout(() => postToInstagram(videoId), 120000);
      return;
    }
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: e.message });
    if (isSessionError) await Account.findByIdAndUpdate(account._id, { status: "error" });
    await logActivity(account.userId, account._id, account.username, "failed", `❌ Post failed: ${e.message}`);

    // Telegram error notification
    if (user?.notifyOnError) {
      await notifyUser(account.userId, `❌ <b>Post failed!</b>\nAccount: @${account.username}\nError: ${e.message.slice(0, 200)}`);
    }
  }
}

// ── SCHEDULER ─────────────────────────────────────────────────────────────────
cron.schedule("* * * * *", async () => {
  try {
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    for (const acc of await Account.find({ status: "active" })) {
      if (!acc.postingTimes.includes(t)) continue;
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const posted = await Video.countDocuments({ accountId: acc._id, status: "posted", postedAt: { $gte: todayStart } });

      // Check user plan limit
      const user = await User.findById(acc.userId);
      const limits = getPlanLimits(user?.plan || "free");
      const dailyLimit = user?.isAdmin ? 999 : Math.min(acc.postsPerDay, limits.postsPerDay);
      if (posted >= dailyLimit) continue;

      const posting = await Video.countDocuments({ accountId: acc._id, status: "posting" });
      if (posting > 0) continue;
      const next = await Video.findOne({ accountId: acc._id, status: "downloaded" }).sort({ createdAt: 1 });
      if (!next) continue;
      console.log(`⏰ Scheduler posting for @${acc.username}`);
      postToInstagram(next._id);
    }
  } catch (e) { console.error("Scheduler error:", e.message); }
});

// Auto-expire plans daily
cron.schedule("0 0 * * *", async () => {
  try {
    const expired = await User.find({
      plan: { $in: ["pro", "agency"] },
      planExpiresAt: { $lt: new Date() },
    });
    for (const u of expired) {
      await User.findByIdAndUpdate(u._id, { plan: "free" });
      await notifyUser(u._id, `⚠️ Your ReelFlow <b>${u.plan}</b> plan has expired. Renew to continue posting unlimited reels.`);
      await logActivity(u._id, null, null, "plan_expired", `Plan expired, downgraded to free`);
    }
    console.log(`✅ Checked ${expired.length} expired plans`);
  } catch (e) { console.error("Plan expiry error:", e.message); }
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "✅ ReelFlow API v6.0", version: "6.0.0", uptime: process.uptime() }));
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3001, () => console.log(`🚀 ReelFlow v6.0 on port ${process.env.PORT || 3001}`));
