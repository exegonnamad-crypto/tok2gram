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
const { exec, spawn } = require("child_process");
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
  plan: { type: String, default: "free" },
  videosPublished: { type: Number, default: 0 },
  trialEndsAt: { type: Date, default: () => new Date(Date.now() + 14 * 86400000) },
  createdAt: { type: Date, default: Date.now },
}));

const Account = mongoose.model("Account", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  username: { type: String, trim: true },
  igPassword: { type: String, default: "" },
  igUserId: { type: String, default: "" },
  profilePic: { type: String, default: "" },
  sessionData: { type: String, default: "" },
  sessionSavedAt: Date,
  niche: { type: String, default: "General" },
  postsPerDay: { type: Number, default: 5, min: 1, max: 25 },
  postingTimes: { type: [String], default: ["09:00", "12:00", "15:00", "18:00", "21:00"] },
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
  videoUrl: { type: String },
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

const isValidUrl = (str) => {
  try { new URL(str); return true; } catch { return false; }
};

async function logActivity(userId, accountId, accountUsername, action, message) {
  try { await ActivityLog.create({ userId, accountId, accountUsername, action, message }); } catch {}
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });
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

app.delete("/api/me", auth, async (req, res) => {
  try {
    await Video.deleteMany({ userId: req.user.id });
    await Account.deleteMany({ userId: req.user.id });
    await Workflow.deleteMany({ userId: req.user.id });
    await ActivityLog.deleteMany({ userId: req.user.id });
    await User.findByIdAndDelete(req.user.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── INSTAGRAM VERIFY ──────────────────────────────────────────────────────────
app.post("/api/instagram/verify", auth, async (req, res) => {
  const { username, password, sessionId } = req.body;
  try {
    let result;
    if (sessionId) {
      result = await instagrapiLoginWithCookie(sessionId.trim());
    } else {
      if (!username || !password) return res.status(400).json({ error: "Username and password required" });
      result = await instagrapiLogin(username, password);
    }
    if (result.success) res.json({ success: true, userId: result.userId, username: result.username });
    else res.status(400).json({ success: false, error: result.error });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
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
    const { username, igPassword, sessionId, niche, postsPerDay, hashtags, captionStyle, customCaption, appendHashtags, autoRequeue, postingTimes } = req.body;

    if (!username) return res.status(400).json({ error: "Instagram username required" });
    if (!sessionId && !igPassword) return res.status(400).json({ error: "Session cookie or password required" });

    let loginResult;
    if (sessionId) {
      loginResult = await instagrapiLoginWithCookie(sessionId.trim());
    } else {
      loginResult = await instagrapiLogin(username, igPassword);
    }

    if (!loginResult.success) return res.status(400).json({ error: `Instagram login failed: ${loginResult.error}` });

    const acc = await Account.create({
      userId: req.user.id,
      username: (loginResult.username || username).replace("@", "").toLowerCase().trim(),
      igUserId: loginResult.userId || "",
      igPassword: igPassword ? await bcrypt.hash(igPassword, 10) : "",
      sessionData: loginResult.sessionData || "",
      sessionSavedAt: new Date(),
      niche: niche || "General",
      postsPerDay: postsPerDay || 5,
      hashtags: hashtags || "",
      captionStyle: captionStyle || "original",
      customCaption: customCaption || "",
      appendHashtags: appendHashtags !== false,
      autoRequeue: autoRequeue || false,
      postingTimes: postingTimes || ["09:00", "12:00", "15:00", "18:00", "21:00"],
    });

    await logActivity(req.user.id, acc._id, acc.username, "connected", `✅ @${acc.username} connected`);
    res.json({ ...acc.toObject(), igPassword: "***", sessionData: undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/accounts/:id", auth, async (req, res) => {
  try {
    const update = { ...req.body };
    if (!update.igPassword || update.igPassword === "***") {
      delete update.igPassword;
    } else {
      update.igPassword = await bcrypt.hash(update.igPassword, 10);
    }
    // If new sessionId provided, re-login with cookie and refresh session
    if (update.sessionId) {
      const loginResult = await instagrapiLoginWithCookie(update.sessionId.trim());
      if (!loginResult.success) return res.status(400).json({ error: `Cookie login failed: ${loginResult.error}` });
      update.sessionData = loginResult.sessionData;
      update.sessionSavedAt = new Date();
      update.igUserId = loginResult.userId || "";
      update.username = (loginResult.username || update.username || "").replace("@", "").toLowerCase().trim();
      delete update.sessionId;
    } else {
      delete update.sessionData;
      delete update.sessionId;
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
    const { links, accountId, workflowId, scheduledFor } = req.body;
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
        workflowId: workflowId || null,
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
    const video = await Video.findOne({ _id: req.params.id, userId: req.user.id, status: "downloaded" });
    if (!video) return res.status(404).json({ error: "Video not ready (must be downloaded first)" });
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
      trialEndsAt: user?.trialEndsAt,
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

// ── INSTAGRAPI — COOKIE LOGIN ─────────────────────────────────────────────────
async function instagrapiLoginWithCookie(sessionId) {
  return new Promise((resolve) => {
    const cleanId = sessionId.replace(/["']/g, "").trim();
    const script = `
import sys, json
try:
    from instagrapi import Client
    cl = Client()
    cl.delay_range = [2, 5]
    cl.login_by_sessionid("${cleanId}")
    session = json.dumps(cl.get_settings())
    uid = str(cl.user_id)
    info = cl.account_info()
    uname = str(info.username)
    print(json.dumps({"success": True, "userId": uid, "username": uname, "sessionData": session}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const py = spawn("python3", ["-c", script]);
    let output = "", errOutput = "";
    py.stdout.on("data", d => output += d.toString());
    py.stderr.on("data", d => errOutput += d.toString());
    py.on("close", () => {
      try {
        const lines = output.trim().split("\n").reverse();
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed && "success" in parsed) { resolve(parsed); return; }
          } catch {}
        }
        resolve({ success: false, error: errOutput || "No response" });
      } catch {
        resolve({ success: false, error: errOutput || "Python error" });
      }
    });
    setTimeout(() => { py.kill(); resolve({ success: false, error: "Timeout (60s)" }); }, 60000);
  });
}

// ── INSTAGRAPI — PASSWORD LOGIN ───────────────────────────────────────────────
async function instagrapiLogin(username, password, existingSession = null) {
  return new Promise((resolve) => {
    const script = `
import sys
import json
try:
    from instagrapi import Client
    cl = Client()
    cl.delay_range = [2, 5]
    ${existingSession ? `
    try:
        cl.load_settings(json.loads('''${existingSession}'''))
        cl.login('${username}', '${password}')
    except:
        cl = Client()
        cl.delay_range = [2, 5]
        cl.login('${username}', '${password}')
    ` : `cl.login('${username}', '${password}')`}
    session = json.dumps(cl.get_settings())
    user_id = str(cl.user_id)
    print(json.dumps({"success": True, "userId": user_id, "username": "${username}", "sessionData": session}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const py = spawn("python3", ["-c", script]);
    let output = "", errOutput = "";
    py.stdout.on("data", d => output += d.toString());
    py.stderr.on("data", d => errOutput += d.toString());
    py.on("close", () => {
      try {
        const lines = output.trim().split("\n").reverse();
        let result = null;
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed && typeof parsed === "object" && "success" in parsed) { result = parsed; break; }
          } catch {}
        }
        resolve(result || { success: false, error: errOutput || "Python/Instagrapi not available" });
      } catch {
        resolve({ success: false, error: errOutput || "Python/Instagrapi not available" });
      }
    });
    setTimeout(() => { py.kill(); resolve({ success: false, error: "Login timeout" }); }, 60000);
  });
}

// ── DOWNLOAD PIPELINE ─────────────────────────────────────────────────────────
async function getVideoInfo(videoUrl) {
  if (videoUrl.includes("tiktok.com")) {
    const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(videoUrl)}&hd=1`;
    const response = await axios.get(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 });
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
        file.close(); fs.unlink(dest, () => {});
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
      status: "downloaded", localPath: out,
      caption: info.caption, videoAuthor: info.author,
      videoId: info.videoId, thumbnailUrl: info.thumbnail, duration: info.duration,
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
    const result = await cloudinary.uploader.upload(filePath, { resource_type: "video", folder: "reelflow", timeout: 120000 });
    await Video.findByIdAndUpdate(videoId, { cloudinaryUrl: result.secure_url });
    fs.unlink(filePath, () => {});
    console.log(`☁️ Cloudinary done: ${videoId}`);
  } catch (e) {
    console.error("❌ Cloudinary error:", e.message);
    await Video.findByIdAndUpdate(videoId, { error: `Cloudinary: ${e.message}` });
  }
}

// ── CAPTION BUILDER ───────────────────────────────────────────────────────────
function buildCaption(video, account) {
  let caption = "";
  if (account.captionStyle === "original") caption = video.caption || "";
  else if (account.captionStyle === "custom") caption = account.customCaption || "";
  if (account.appendHashtags && account.hashtags) {
    caption = caption ? `${caption}\n\n${account.hashtags}` : account.hashtags;
  }
  return caption.trim().slice(0, 2200);
}

// ── POST TO INSTAGRAM ─────────────────────────────────────────────────────────
async function postToInstagram(videoId) {
  const video = await Video.findById(videoId).populate("accountId");
  if (!video?.accountId) return;
  const account = video.accountId;

  if (!account.sessionData) {
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: "No session — please reconnect account with your cookie" });
    return;
  }

  try {
    await Video.findByIdAndUpdate(videoId, { status: "posting", error: "" });

    let videoPath = video.localPath;
    if (!videoPath || !fs.existsSync(videoPath)) {
      if (!video.cloudinaryUrl) throw new Error("No video file available");
      const dir = path.join(__dirname, "downloads");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      videoPath = path.join(dir, `post_${videoId}.mp4`);
      await downloadFile(video.cloudinaryUrl, videoPath);
    }

    const caption = buildCaption(video, account);
    const result = await postViaInstagrapi(account.sessionData, videoPath, caption);

    if (!result.success) throw new Error(result.error);

    if (result.sessionData) {
      await Account.findByIdAndUpdate(account._id, { sessionData: result.sessionData, sessionSavedAt: new Date() });
    }

    await Video.findByIdAndUpdate(videoId, { status: "posted", postedAt: new Date(), igPostId: result.mediaId || "", error: "" });
    await Account.findByIdAndUpdate(account._id, { $inc: { totalPosted: 1 }, lastPostedAt: new Date(), status: "active" });
    await User.findByIdAndUpdate(account.userId, { $inc: { videosPublished: 1 } });
    if (video.workflowId) await Workflow.findByIdAndUpdate(video.workflowId, { $inc: { videosProcessed: 1 } });
    await logActivity(account.userId, account._id, account.username, "posted", `✅ Posted reel to @${account.username}`);
    console.log(`🎉 Posted to @${account.username}`);

    if (account.autoRequeue) {
      await Video.findByIdAndUpdate(videoId, { status: "downloaded", postedAt: null, igPostId: null });
    }
    if (videoPath.includes("post_")) fs.unlink(videoPath, () => {});

  } catch (e) {
    const v2 = await Video.findById(videoId);
    const isSessionError = e.message.includes("login") || e.message.includes("LoginRequired") || e.message.includes("session");
    if (v2 && v2.retryCount < 2 && !isSessionError) {
      await Video.findByIdAndUpdate(videoId, { status: "downloaded", $inc: { retryCount: 1 } });
      setTimeout(() => postToInstagram(videoId), 120000);
      return;
    }
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: e.message });
    if (isSessionError) await Account.findByIdAndUpdate(account._id, { status: "error" });
    await logActivity(account.userId, account._id, account.username, "failed", `❌ Post failed @${account.username}: ${e.message}`);
    console.error(`❌ Post failed @${account.username}: ${e.message}`);
  }
}

async function postViaInstagrapi(sessionData, videoPath, caption) {
  return new Promise((resolve) => {
    if (!sessionData) {
      resolve({ success: false, error: "No session — please reconnect your Instagram account" });
      return;
    }
    const escapedCaption = caption.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
    const escapedPath = videoPath.replace(/\\/g, "/");
    const script = `
import sys, json
try:
    from instagrapi import Client
    cl = Client()
    cl.delay_range = [1, 3]
    settings = json.loads('''${sessionData.replace(/'/g, "\\'")}''')
    cl.set_settings(settings)
    cl.get_timeline_feed()
    media = cl.clip_upload('${escapedPath}', caption='${escapedCaption}')
    try:
        new_session = json.dumps(cl.get_settings())
    except:
        new_session = ""
    print(json.dumps({"success": True, "mediaId": str(media.pk), "sessionData": new_session}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const py = spawn("python3", ["-c", script]);
    let output = "", errOutput = "";
    py.stdout.on("data", d => output += d.toString());
    py.stderr.on("data", d => errOutput += d.toString());
    py.on("close", () => {
      try {
        const lines = output.trim().split("\n").reverse();
        let result = null;
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed && typeof parsed === "object" && "success" in parsed) { result = parsed; break; }
          } catch {}
        }
        resolve(result || { success: false, error: errOutput || output || "No valid response" });
      } catch {
        resolve({ success: false, error: errOutput || "Instagrapi error" });
      }
    });
    setTimeout(() => { py.kill(); resolve({ success: false, error: "Post timeout (120s)" }); }, 120000);
  });
}

// ── SCHEDULER ─────────────────────────────────────────────────────────────────
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
      const posting = await Video.countDocuments({ accountId: acc._id, status: "posting" });
      if (posting > 0) continue;
      const next = await Video.findOne({ accountId: acc._id, status: "downloaded" }).sort({ createdAt: 1 });
      if (!next) continue;
      console.log(`⏰ Auto-posting for @${acc.username}`);
      postToInstagram(next._id);
    }
  } catch (e) { console.error("Scheduler error:", e.message); }
});

cron.schedule("*/30 * * * *", async () => {
  try {
    const failed = await Video.find({ status: "failed", retryCount: { $lt: 3 }, cloudinaryUrl: null });
    for (const v of failed) {
      await Video.findByIdAndUpdate(v._id, { status: "queued", retryCount: v.retryCount + 1 });
      setTimeout(() => downloadVideo(v._id, v.videoUrl), 2000);
    }
  } catch (e) { console.error("Retry cron error:", e.message); }
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "✅ ReelFlow API v5.0 — Cookie Auth", version: "5.0.0", uptime: process.uptime() }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(process.env.PORT || 3001, () => console.log(`🚀 ReelFlow v5.0 on port ${process.env.PORT || 3001}`));
