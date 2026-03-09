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
  // ── Telegram ──
  telegramBotToken: { type: String, default: "" },
  telegramChatId: { type: String, default: "" },
  notifyOnPost: { type: Boolean, default: true },
  notifyOnError: { type: Boolean, default: true },
  notifyOnConnect: { type: Boolean, default: true },
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

const Scraper = mongoose.model("Scraper", new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true },
  type: { type: String, enum: ["username", "hashtag"], default: "username" },
  query: { type: String, required: true },
  interval: { type: Number, default: 60 },
  maxPerRun: { type: Number, default: 5 },
  skipDuplicates: { type: Boolean, default: true },
  status: { type: String, default: "active", enum: ["active", "paused"] },
  totalScraped: { type: Number, default: 0 },
  lastRun: Date,
  nextRun: Date,
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

// ── TELEGRAM HELPER ───────────────────────────────────────────────────────────
async function sendTelegram(botToken, chatId, message) {
  if (!botToken || !chatId) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      },
      { timeout: 10000 }
    );
  } catch (e) {
    console.error("Telegram send error:", e.message);
  }
}

async function notifyUser(userId, event, data = {}) {
  try {
    const user = await User.findById(userId).select("telegramBotToken telegramChatId notifyOnPost notifyOnError notifyOnConnect");
    if (!user?.telegramBotToken || !user?.telegramChatId) return;

    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
    const dateStr = now.toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });

    let message = "";

    if (event === "posted" && user.notifyOnPost) {
      const igUrl = data.igPostId
        ? `https://www.instagram.com/p/${data.igPostId}/`
        : `https://www.instagram.com/${data.username}/`;
      message =
        `✅ <b>Reel Posted Successfully!</b>\n\n` +
        `👤 Account: <b>@${data.username}</b>\n` +
        `🕐 Time: ${timeStr} — ${dateStr}\n` +
        `🎬 Total Posted: ${data.totalPosted}\n` +
        (data.caption ? `📝 Caption: ${data.caption.slice(0, 80)}${data.caption.length > 80 ? "..." : ""}\n` : "") +
        `\n🔗 <a href="${igUrl}">View on Instagram</a>`;
    }

    else if (event === "failed" && user.notifyOnError) {
      message =
        `❌ <b>Post Failed</b>\n\n` +
        `👤 Account: <b>@${data.username}</b>\n` +
        `🕐 Time: ${timeStr} — ${dateStr}\n` +
        `⚠️ Error: <code>${(data.error || "Unknown error").slice(0, 200)}</code>\n\n` +
        `💡 Check your session cookie — it may need to be refreshed.`;
    }

    else if (event === "connected" && user.notifyOnConnect) {
      message =
        `🔗 <b>Account Connected!</b>\n\n` +
        `👤 Instagram: <b>@${data.username}</b>\n` +
        `🕐 Time: ${timeStr} — ${dateStr}\n` +
        `🎯 Niche: ${data.niche || "General"}\n` +
        `📅 Posts/Day: ${data.postsPerDay || 5}\n\n` +
        `ReelFlow is now managing this account automatically.`;
    }

    else if (event === "test") {
      message =
        `🤖 <b>ReelFlow Notifications Active!</b>\n\n` +
        `✅ Your Telegram bot is connected and working.\n` +
        `🕐 Tested at: ${timeStr} — ${dateStr}\n\n` +
        `You'll receive alerts for:\n` +
        `${user.notifyOnPost ? "✅" : "❌"} Successful posts (with Instagram link)\n` +
        `${user.notifyOnError ? "✅" : "❌"} Failed posts & errors\n` +
        `${user.notifyOnConnect ? "✅" : "❌"} New account connections`;
    }

    if (message) {
      await sendTelegram(user.telegramBotToken, user.telegramChatId, message);
    }
  } catch (e) {
    console.error("notifyUser error:", e.message);
  }
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

// ── TELEGRAM SETTINGS ROUTES ──────────────────────────────────────────────────
app.put("/api/me/notifications", auth, async (req, res) => {
  try {
    const { telegramBotToken, telegramChatId, notifyOnPost, notifyOnError, notifyOnConnect } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { telegramBotToken, telegramChatId, notifyOnPost, notifyOnError, notifyOnConnect: notifyOnConnect !== false },
      { new: true }
    ).select("-password");
    res.json({ success: true, user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/me/test-telegram", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user?.telegramBotToken || !user?.telegramChatId)
      return res.status(400).json({ error: "Please save your Bot Token and Chat ID first" });
    await notifyUser(req.user.id, "test");
    res.json({ success: true, message: "Test message sent!" });
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
// ── VERIFY CODE (2FA / EMAIL CHALLENGE) ──────────────────────────────────────
app.post("/api/accounts/verify-code", auth, async (req, res) => {
  try {
    const { username, password, verificationCode, tempSession, niche, postsPerDay, hashtags, captionStyle, customCaption, autoRequeue, postingTimes } = req.body;
    if (!verificationCode) return res.status(400).json({ error: "Verification code required" });

    const loginResult = await instagrapiLogin(username, password, verificationCode, tempSession);

    if (loginResult.needsCode) return res.status(400).json({ error: "Code was incorrect, please try again" });
    if (!loginResult.success) return res.status(400).json({ error: `Login failed: ${loginResult.error}` });

    const acc = await Account.create({
      userId: req.user.id,
      username: (loginResult.username || username || "").replace("@", "").toLowerCase().trim(),
      igUserId: loginResult.userId || "",
      igPassword: password ? await bcrypt.hash(password, 10) : "",
      sessionData: loginResult.sessionData || "",
      sessionSavedAt: new Date(),
      niche: niche || "General",
      postsPerDay: postsPerDay || 5,
      postingTimes: postingTimes || ["09:00", "12:00", "15:00", "18:00", "21:00"],
      hashtags: hashtags || "",
      captionStyle: captionStyle || "original",
      customCaption: customCaption || "",
      autoRequeue: autoRequeue || false,
      status: "active",
    });

    await logActivity(req.user.id, acc._id, "account_connected", `@${acc.username} connected via password+code`);
    await notifyUser(req.user.id, "connected", { username: acc.username, niche: acc.niche });
    res.json({ success: true, account: acc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/accounts", auth, async (req, res) => {
  try {
    const accounts = await Account.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(accounts.map(a => ({ ...a.toObject(), igPassword: a.igPassword ? "***" : "", sessionData: undefined })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/accounts", auth, async (req, res) => {
  try {
    const { username, password, igPassword, sessionId, niche, postsPerDay, hashtags, captionStyle, customCaption, appendHashtags, autoRequeue, postingTimes } = req.body;
    const igPass = password || igPassword;

    if (!sessionId && !igPass) return res.status(400).json({ error: "Session cookie or password required" });
    if (!sessionId && !username) return res.status(400).json({ error: "Instagram username required when using password login" });

    let loginResult;
    if (sessionId) {
      loginResult = await instagrapiLoginWithCookie(sessionId.trim());
    } else {
      loginResult = await instagrapiLogin(username, igPass);
    }

    // Instagram requires verification code
    if (loginResult.needsCode) {
      return res.status(200).json({
        needsCode: true,
        tempSession: loginResult.tempSession || "",
        message: "Instagram sent a verification code to your email/phone. Please enter it.",
      });
    }

    if (!loginResult.success) return res.status(400).json({ error: `Instagram login failed: ${loginResult.error}` });

    const acc = await Account.create({
      userId: req.user.id,
      username: (loginResult.username || username || "").replace("@", "").toLowerCase().trim(),
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

    // 🔔 Telegram: account connected
    notifyUser(req.user.id, "connected", {
      username: acc.username,
      niche: acc.niche,
      postsPerDay: acc.postsPerDay,
    });

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

app.get("/api/accounts/:id/profile", auth, async (req, res) => {
  try {
    const acc = await Account.findOne({ _id: req.params.id, userId: req.user.id });
    if (!acc) return res.status(404).json({ error: "Account not found" });
    if (!acc.sessionData) return res.status(400).json({ error: "No session data" });

    const result = await new Promise((resolve) => {
      const script = `
import sys, json
try:
    from instagrapi import Client
    cl = Client()
    settings = json.loads('''${acc.sessionData.replace(/'/g, "\\'")}''')
    cl.set_settings(settings)
    info = cl.account_info()
    print(json.dumps({
        "success": True,
        "username": str(info.username),
        "fullName": str(info.full_name or ""),
        "bio": str(info.biography or ""),
        "followers": int(info.follower_count or 0),
        "following": int(info.following_count or 0),
        "posts": int(info.media_count or 0),
        "profilePic": str(info.profile_pic_url or ""),
        "isVerified": bool(info.is_verified),
    }))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
      const { spawn } = require("child_process");
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
          resolve({ success: false, error: "Python error" });
        }
      });
      setTimeout(() => { py.kill(); resolve({ success: false, error: "Timeout" }); }, 30000);
    });

    if (!result.success) return res.status(400).json({ error: result.error });
    // cache profile pic on account
    if (result.profilePic) await Account.findByIdAndUpdate(acc._id, { profilePic: result.profilePic });
    res.json(result);
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
    const cleanId = decodeURIComponent(sessionId.replace(/["']/g, "").trim());
    const script = `
import sys, json, uuid, random
try:
    from instagrapi import Client

    seed = "${cleanId}"[:8]
    random.seed(seed)

    phone_id = str(uuid.UUID(int=random.getrandbits(128)))
    device_id = "android-" + hex(random.getrandbits(64))[2:]
    uuid_val = str(uuid.UUID(int=random.getrandbits(128)))
    adv_id = str(uuid.UUID(int=random.getrandbits(128)))

    cl = Client()
    cl.delay_range = [3, 7]

    cl.set_settings({
        "uuids": {
            "phone_id": phone_id,
            "uuid": uuid_val,
            "client_session_id": str(uuid.UUID(int=random.getrandbits(128))),
            "advertising_id": adv_id,
            "device_id": device_id,
        },
        "device_settings": {
            "app_version": "269.0.0.18.75",
            "android_version": 26,
            "android_release": "8.0.0",
            "dpi": "480dpi",
            "resolution": "1080x1920",
            "manufacturer": "OnePlus",
            "device": "devitron",
            "model": "6T Dev",
            "cpu": "qcom",
            "version_code": "301484483",
        },
        "user_agent": "Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; OnePlus; 6T Dev; devitron; qcom; en_US; 301484483)",
        "cookies": {"sessionid": "${cleanId}"},
    })

    cl.login_by_sessionid("${cleanId}")

    uid = str(cl.user_id)

    # Safely get account info - handle missing fields in newer IG API
    try:
        info = cl.account_info()
        uname = str(info.username)
    except Exception:
        # Fallback: get username from user info
        try:
            user_info = cl.user_info(uid)
            uname = str(user_info.username)
        except Exception:
            uname = "unknown"

    session = json.dumps(cl.get_settings())
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
async function instagrapiLogin(username, password, verificationCode = null, tempSession = null) {
  return new Promise((resolve) => {
    const script = `
import sys, json
try:
    from instagrapi import Client
    from instagrapi.exceptions import ChallengeRequired, TwoFactorRequired

    cl = Client()
    cl.delay_range = [2, 5]

    ${tempSession ? `
    # Resume session for verification code
    try:
        cl.set_settings(json.loads('''${tempSession}'''))
    except:
        pass
    ` : ''}

    def challenge_code_handler(username, choice):
        # Signal that we need a code
        print(json.dumps({"needsCode": True, "tempSession": json.dumps(cl.get_settings())}), flush=True)
        sys.exit(42)

    cl.challenge_code_handler = challenge_code_handler

    ${verificationCode ? `
    # Submit verification code
    try:
        cl.challenge_resolve(cl.last_json, "${verificationCode}")
    except Exception:
        cl.login('${username}', '${password}', verification_code="${verificationCode}")
    ` : `
    cl.login('${username}', '${password}')
    `}

    session = json.dumps(cl.get_settings())
    user_id = str(cl.user_id)
    print(json.dumps({"success": True, "userId": user_id, "username": "${username}", "sessionData": session}))

except SystemExit as e:
    if e.code != 42:
        print(json.dumps({"success": False, "error": "System exit"}))
except Exception as e:
    err = str(e)
    # Check if it's a challenge error not caught by handler
    if "challenge" in err.lower() or "verify" in err.lower() or "code" in err.lower():
        print(json.dumps({"needsCode": True, "tempSession": json.dumps(cl.get_settings() if cl else {}), "error": err}))
    else:
        print(json.dumps({"success": False, "error": err}))
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
            if (parsed && typeof parsed === "object" && ("success" in parsed || "needsCode" in parsed)) { result = parsed; break; }
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

    const updatedAccount = await Account.findByIdAndUpdate(
      account._id,
      { $inc: { totalPosted: 1 }, lastPostedAt: new Date(), status: "active" },
      { new: true }
    );

    await Video.findByIdAndUpdate(videoId, { status: "posted", postedAt: new Date(), igPostId: result.mediaId || "", error: "" });
    await User.findByIdAndUpdate(account.userId, { $inc: { videosPublished: 1 } });
    if (video.workflowId) await Workflow.findByIdAndUpdate(video.workflowId, { $inc: { videosProcessed: 1 } });
    await logActivity(account.userId, account._id, account.username, "posted", `✅ Posted reel to @${account.username}`);
    console.log(`🎉 Posted to @${account.username}`);

    // 🔔 Telegram: post success
    notifyUser(account.userId, "posted", {
      username: account.username,
      igPostId: result.mediaId || "",
      totalPosted: updatedAccount?.totalPosted || account.totalPosted + 1,
      caption: caption,
    });

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

    // 🔔 Telegram: post failed
    notifyUser(account.userId, "failed", {
      username: account.username,
      error: e.message,
    });
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
import sys, json, time, random
try:
    from instagrapi import Client
    from instagrapi.exceptions import LoginRequired, PleaseWaitFewMinutes

    cl = Client()
    # Use longer human-like delays to avoid detection
    cl.delay_range = [3, 6]

    # Restore exact saved session including device fingerprint
    settings = json.loads('''${sessionData.replace(/'/g, "\\'")}''')
    cl.set_settings(settings)

    # Re-inject session cookie from saved settings
    cookies = settings.get("cookies", {})
    session_id = cookies.get("sessionid", "")
    if session_id:
        cl.login_by_sessionid(session_id)

    # Small human-like delay before posting
    time.sleep(random.uniform(2, 4))

    # Upload reel directly - no timeline feed call (that triggers security checks)
    media = cl.clip_upload('${escapedPath}', caption='${escapedCaption}')

    # Save updated session
    try:
        new_session = json.dumps(cl.get_settings())
    except:
        new_session = ""

    print(json.dumps({"success": True, "mediaId": str(media.pk), "sessionData": new_session}))

except LoginRequired as e:
    print(json.dumps({"success": False, "error": "LoginRequired: session expired — please reconnect with a fresh cookie"}))
except PleaseWaitFewMinutes as e:
    print(json.dumps({"success": False, "error": "Instagram rate limited — will retry in a few minutes"}))
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

// ── ANALYTICS ─────────────────────────────────────────────────────────────────
app.get("/api/analytics", auth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 86400000);

    const [posted, failed, accounts] = await Promise.all([
      Video.find({ userId: req.user.id, status: "posted", postedAt: { $gte: since } }),
      Video.countDocuments({ userId: req.user.id, status: "failed", createdAt: { $gte: since } }),
      Account.find({ userId: req.user.id }),
    ]);

    const total = posted.length;
    const successRate = total + failed > 0 ? Math.round((total / (total + failed)) * 100) : 100;

    // Daily breakdown
    const dailyMap = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().split("T")[0];
      dailyMap[key] = 0;
    }
    posted.forEach(v => {
      const key = new Date(v.postedAt).toISOString().split("T")[0];
      if (dailyMap[key] !== undefined) dailyMap[key]++;
    });
    const dailyPosts = Object.entries(dailyMap).map(([date, count]) => ({ date, count }));

    // Hourly breakdown
    const hourly = Array(24).fill(0).map((_, i) => ({ hour: i, count: 0 }));
    posted.forEach(v => { hourly[new Date(v.postedAt).getHours()].count++; });

    // Top accounts
    const accMap = {};
    posted.forEach(v => {
      const id = v.accountId?.toString();
      if (id) accMap[id] = (accMap[id] || 0) + 1;
    });
    const topAccounts = Object.entries(accMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([id, count]) => {
        const acc = accounts.find(a => a._id.toString() === id);
        return { id, username: acc?.username || "unknown", posted: count };
      });

    res.json({
      totalPosted: total,
      avgPerDay: (total / days).toFixed(1),
      activeAccounts: accounts.filter(a => a.status === "active").length,
      successRate,
      dailyPosts,
      hourlyBreakdown: hourly,
      topAccounts,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SCRAPER ROUTES ────────────────────────────────────────────────────────────
app.get("/api/scrapers", auth, async (req, res) => {
  try {
    const scrapers = await Scraper.find({ userId: req.user.id })
      .populate("accountId", "username")
      .sort({ createdAt: -1 });
    res.json(scrapers);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/scrapers", auth, async (req, res) => {
  try {
    const { type, query, accountId, interval, maxPerRun, skipDuplicates } = req.body;
    if (!query) return res.status(400).json({ error: "Query required" });
    if (!accountId) return res.status(400).json({ error: "Account required" });
    const acc = await Account.findOne({ _id: accountId, userId: req.user.id });
    if (!acc) return res.status(404).json({ error: "Account not found" });
    const scraper = await Scraper.create({
      userId: req.user.id, accountId, type: type || "username",
      query: query.replace(/^[@#]/, "").trim(),
      interval: interval || 60, maxPerRun: maxPerRun || 5,
      skipDuplicates: skipDuplicates !== false,
      nextRun: new Date(),
    });
    res.json(await scraper.populate("accountId", "username"));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/scrapers/:id/toggle", auth, async (req, res) => {
  try {
    const s = await Scraper.findOne({ _id: req.params.id, userId: req.user.id });
    if (!s) return res.status(404).json({ error: "Not found" });
    s.status = s.status === "active" ? "paused" : "active";
    if (s.status === "active") s.nextRun = new Date();
    await s.save();
    res.json({ status: s.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/scrapers/:id", auth, async (req, res) => {
  try {
    await Scraper.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/scrapers/:id/run", auth, async (req, res) => {
  try {
    const s = await Scraper.findOne({ _id: req.params.id, userId: req.user.id });
    if (!s) return res.status(404).json({ error: "Not found" });
    runScraper(s._id);
    res.json({ message: "Scraper started" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI CAPTION ────────────────────────────────────────────────────────────────
app.post("/api/videos/:id/ai-caption", auth, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.user.id });
    if (!video) return res.status(404).json({ error: "Video not found" });

    const original = (video.caption || "").trim();
    const account = await Account.findById(video.accountId);
    const niche = account?.niche || "General";
    const existingHashtags = (account?.hashtags || "").trim();

    const prompt = `You are an Instagram Reels caption expert.

Original TikTok caption: "${original || "(no caption)"}"
Account niche: ${niche}

Your job:
1. Rewrite the caption to be more engaging and punchy for Instagram Reels. Keep the same meaning but make it catchier, add personality, use 1-3 relevant emojis naturally. Keep it under 180 characters.
2. Generate 8-12 highly relevant hashtags for this content and niche. Mix popular (#reels, #viral) with niche-specific ones. Do NOT repeat any of these existing hashtags: ${existingHashtags}

Respond ONLY in this exact JSON format, nothing else:
{"caption": "your rewritten caption here", "hashtags": "#tag1 #tag2 #tag3"}`;

    const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama3-8b-8192",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }, {
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    });

    const raw = response.data.choices[0].message.content.trim();
    let caption = original;
    let hashtags = existingHashtags;

    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      caption = parsed.caption || original;
      // Merge new hashtags with existing ones, deduplicated
      const existingSet = new Set(existingHashtags.split(/\s+/).filter(Boolean));
      const newTags = (parsed.hashtags || "").split(/\s+/).filter(t => t.startsWith("#") && !existingSet.has(t));
      hashtags = [...existingSet, ...newTags].join(" ").trim();
    } catch {
      // fallback: use raw as caption if JSON parse fails
      caption = raw.slice(0, 200);
    }

    await Video.findByIdAndUpdate(video._id, { caption, hashtags });
    res.json({ caption, hashtags });
  } catch (e) {
    console.error("AI caption error:", e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── SESSION HEALTH CHECK ──────────────────────────────────────────────────────
async function checkSessionHealth(accountId) {
  const acc = await Account.findById(accountId);
  if (!acc || !acc.sessionData) return false;

  return new Promise((resolve) => {
    const script = `
import json
try:
    from instagrapi import Client
    cl = Client()
    settings = json.loads('''${acc.sessionData.replace(/'/g, "\\'")}''')
    cl.set_settings(settings)
    cl.get_timeline_feed()
    print(json.dumps({"ok": True}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;
    const { spawn } = require("child_process");
    const py = spawn("python3", ["-c", script]);
    let output = "";
    py.stdout.on("data", d => output += d.toString());
    py.on("close", () => {
      try {
        const lines = output.trim().split("\n").reverse();
        for (const line of lines) {
          try { const r = JSON.parse(line); if ("ok" in r) { resolve(r.ok); return; } } catch {}
        }
        resolve(false);
      } catch { resolve(false); }
    });
    setTimeout(() => { py.kill(); resolve(false); }, 30000);
  });
}

// ── SCRAPER ENGINE ────────────────────────────────────────────────────────────
async function runScraper(scraperId) {
  const scraper = await Scraper.findById(scraperId).populate("accountId");
  if (!scraper || scraper.status !== "active") return;

  console.log(`🔍 Running scraper: ${scraper.type} "${scraper.query}"`);
  await Scraper.findByIdAndUpdate(scraperId, { lastRun: new Date(), nextRun: new Date(Date.now() + scraper.interval * 60000) });

  try {
    let videoUrls = [];
    if (scraper.type === "username") {
      const apiUrl = `https://tikwm.com/api/user/posts?unique_id=${encodeURIComponent(scraper.query)}&count=${scraper.maxPerRun}&cursor=0`;
      const res = await axios.get(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 });
      if (res.data.code === 0 && res.data.data?.videos) {
        videoUrls = res.data.data.videos.map((v) => `https://www.tiktok.com/@${scraper.query}/video/${v.video_id}`);
      }
    } else {
      const apiUrl = `https://tikwm.com/api/feed/search?keywords=${encodeURIComponent(scraper.query)}&count=${scraper.maxPerRun}&cursor=0`;
      const res = await axios.get(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 });
      if (res.data.code === 0 && res.data.data?.videos) {
        videoUrls = res.data.data.videos.map((v) => `https://www.tiktok.com/@${v.author?.unique_id}/video/${v.video_id}`);
      }
    }

    if (videoUrls.length === 0) { console.log("Scraper: no videos found"); return; }

    let toAdd = videoUrls;
    if (scraper.skipDuplicates) {
      const existing = (await Video.find({ accountId: scraper.accountId._id, videoUrl: { $in: videoUrls } })).map(v => v.videoUrl);
      toAdd = videoUrls.filter(u => !existing.includes(u));
    }

    if (toAdd.length === 0) { console.log("Scraper: all duplicates, skipping"); return; }

    const videos = await Video.insertMany(toAdd.map(url => ({
      userId: scraper.userId,
      accountId: scraper.accountId._id,
      videoUrl: url,
      hashtags: scraper.accountId.hashtags || "",
      status: "queued",
    })));

    videos.forEach((v, i) => setTimeout(() => downloadVideo(v._id, v.videoUrl), i * 3000));
    await Scraper.findByIdAndUpdate(scraperId, { $inc: { totalScraped: videos.length } });
    await logActivity(scraper.userId, scraper.accountId._id, scraper.accountId.username, "scraped", `🔍 Scraped ${videos.length} videos from ${scraper.type === "hashtag" ? "#" : "@"}${scraper.query}`);
    console.log(`✅ Scraper added ${videos.length} videos`);
  } catch (e) {
    console.error("Scraper error:", e.message);
  }
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

// Run scrapers on schedule
cron.schedule("* * * * *", async () => {
  try {
    const now = new Date();
    const dueScrapers = await Scraper.find({ status: "active", nextRun: { $lte: now } });
    for (const s of dueScrapers) {
      runScraper(s._id);
    }
  } catch (e) { console.error("Scraper cron error:", e.message); }
});

// Session health check every 2 hours
cron.schedule("0 */2 * * *", async () => {
  try {
    const accounts = await Account.find({ status: "active" });
    for (const acc of accounts) {
      const healthy = await checkSessionHealth(acc._id);
      if (!healthy) {
        await Account.findByIdAndUpdate(acc._id, { status: "error" });
        await logActivity(acc.userId, acc._id, acc.username, "session_error", `⚠️ Session expired for @${acc.username} — reconnect needed`);
        notifyUser(acc.userId, "failed", {
          username: acc.username,
          error: "Session cookie expired. Please reconnect your account with a fresh cookie.",
        });
        console.log(`⚠️ Session dead: @${acc.username}`);
      }
    }
  } catch (e) { console.error("Health check error:", e.message); }
});


// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "✅ ReelFlow API v5.0 — Cookie Auth", version: "5.0.0", uptime: process.uptime() }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(process.env.PORT || 3001, () => console.log(`🚀 ReelFlow v5.0 on port ${process.env.PORT || 3001}`));
