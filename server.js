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
  .then(async () => {
    console.log("✅ MongoDB connected");
    // Ensure admin account is always set
    await User.updateOne({ email: "v1amp@proton.me" }, { $set: { role: "admin" } });
    console.log("✅ Admin role ensured for v1amp@proton.me");
  })
  .catch(e => console.error("❌ DB Error:", e.message));

// ── SCHEMAS ───────────────────────────────────────────────────────────────────
const User = mongoose.model("User", new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, unique: true, lowercase: true, trim: true },
  password: String,
  role: { type: String, default: "user" },
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
  status: { type: String, default: "active", enum: ["active", "paused", "error", "shadowbanned"] },
  proxyUrl: { type: String, default: "" },
  // ── Warm-up system ──
  warmupEnabled: { type: Boolean, default: true },
  warmupDay: { type: Number, default: 0 },         // how many days old this account is
  warmupComplete: { type: Boolean, default: false },
  // ── Smart scheduling ──
  useSmartSchedule: { type: Boolean, default: true },
  randomTimes: { type: Boolean, default: false },
  // ── Shadowban detection ──
  shadowbanScore: { type: Number, default: 0 },    // 0-100, higher = more likely shadowbanned
  shadowbanCheckedAt: Date,
  // ── Reach tracking ──
  avgLikesPerPost: { type: Number, default: 0 },
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
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, plan: user.plan, role: user.role, trialEndsAt: user.trialEndsAt } });
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
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, plan: user.plan, role: user.role, trialEndsAt: user.trialEndsAt } });
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
  const { username, password } = req.body;
  try {
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const result = await instagrapiLogin(username, password);
    if (result.success) res.json({ success: true, userId: result.userId, username: result.username });
    else res.status(400).json({ success: false, error: result.error });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── ACCOUNT ROUTES ────────────────────────────────────────────────────────────
// ── AUTHORIZE POLLING ─────────────────────────────────────────────────────────
app.get("/api/accounts/authorize-status/:sessionKey", auth, async (req, res) => {
  const { sessionKey } = req.params;
  const pending = pendingAuthorizations.get(sessionKey);
  if (!pending) return res.status(404).json({ error: "Session expired — please try again" });
  if (pending.userId !== req.user.id) return res.status(403).json({ error: "Unauthorized" });

  // Try login again with saved temp session
  const result = await instagrapiLoginWithTempSession(pending.username, pending.password, pending.tempSession, pending.proxyUrl || "", pending.tempAccountId || "");

  if (result.success) {
    pendingAuthorizations.delete(sessionKey);
    // Create the account
    try {
      const { niche, postsPerDay, hashtags, captionStyle, customCaption, autoRequeue, postingTimes } = pending.accountData;
      const acc = await Account.create({
        userId: req.user.id,
        username: (result.username || pending.username || "").replace("@", "").toLowerCase().trim(),
        igUserId: result.userId || "",
        igPassword: pending.password ? await bcrypt.hash(pending.password, 10) : "",
        sessionData: result.sessionData || "",
        sessionSavedAt: new Date(),
        niche: niche || "General",
        postsPerDay: postsPerDay || 5,
        postingTimes: postingTimes || ["09:00","12:00","15:00","18:00","21:00"],
        hashtags: hashtags || "",
        captionStyle: captionStyle || "original",
        customCaption: customCaption || "",
        autoRequeue: autoRequeue || false,
        status: "active",
        proxyUrl: pending.proxyUrl || "",
      });
      await logActivity(req.user.id, acc._id, "account_connected", `@${acc.username} connected via authorization`);
      await notifyUser(req.user.id, "connected", { username: acc.username, niche: acc.niche });
      return res.json({ authorized: true, account: acc });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (result.pending) {
    // Update temp session if we got a new one
    if (result.tempSession) pending.tempSession = result.tempSession;
    return res.json({ pending: true, message: "Still waiting... tap 'This was me' on your phone" });
  }

  // Hard failure
  pendingAuthorizations.delete(sessionKey);
  return res.status(400).json({ error: result.error || "Authorization failed" });
});

// ── VERIFY CODE (legacy) ──────────────────────────────────────────────────────
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
    const { username, password, igPassword, niche, postsPerDay, hashtags, captionStyle, customCaption, appendHashtags, autoRequeue, postingTimes, proxyUrl } = req.body;
    const igPass = password || igPassword;

    if (!igPass) return res.status(400).json({ error: "Password required" });
    if (!username) return res.status(400).json({ error: "Instagram username required" });

    const loginResult = await instagrapiLogin(username, igPass, proxyUrl || "");

    // Instagram requires phone authorization
    if (loginResult.pending) {
      const sessionKey = `${req.user.id}:${username}:${Date.now()}`;
      pendingAuthorizations.set(sessionKey, {
        status: "pending",
        username, password: igPass,
        tempSession: loginResult.tempSession || "{}",
        proxyUrl: proxyUrl || "",
        accountData: { niche, postsPerDay, hashtags, captionStyle, customCaption, autoRequeue, postingTimes, proxyUrl },
        userId: req.user.id,
        createdAt: Date.now(),
      });
      // Clean up after 5 minutes
      setTimeout(() => pendingAuthorizations.delete(sessionKey), 300000);
      return res.json({ pending: true, sessionKey, message: "Check your phone and tap 'This was me' to authorize" });
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
      proxyUrl: proxyUrl || "",
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
    delete update.sessionData;
    delete update.sessionId;
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

    // Return cached profile if fresh (less than 10 minutes old)
    if (acc.profileCachedAt && (Date.now() - new Date(acc.profileCachedAt).getTime()) < 600000 && acc.profilePic) {
      return res.json({
        success: true, username: acc.username, fullName: acc.fullName || "", bio: acc.bio || "",
        followers: acc.followers || 0, following: acc.following || 0, posts: acc.totalPosted || 0,
        profilePic: acc.profilePic, isVerified: false,
      });
    }

    if (!acc.sessionData) return res.status(400).json({ error: "No session data" });

    const result = await new Promise((resolve) => {
      const script = `
import sys, json
try:
    from instagrapi import Client
    cl = Client()
    settings = json.loads('''${acc.sessionData.replace(/'/g, "\\'")}''')
    cl.set_settings(settings)
    try:
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
    except Exception as e1:
        # Fallback for newer IG API fields
        try:
            uid = str(cl.user_id)
            info2 = cl.user_info(uid)
            print(json.dumps({
                "success": True,
                "username": str(info2.username),
                "fullName": str(info2.full_name or ""),
                "bio": str(info2.biography or ""),
                "followers": int(info2.follower_count or 0),
                "following": int(info2.following_count or 0),
                "posts": int(info2.media_count or 0),
                "profilePic": str(info2.profile_pic_url or ""),
                "isVerified": bool(info2.is_verified),
            }))
        except Exception as e2:
            print(json.dumps({"success": False, "error": str(e2)}))
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
    // cache profile data on account
    if (result.profilePic) await Account.findByIdAndUpdate(acc._id, {
      profilePic: result.profilePic,
      fullName: result.fullName,
      bio: result.bio,
      followers: result.followers,
      following: result.following,
      profileCachedAt: new Date(),
    });
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

// ── PROXY POOL MANAGER ────────────────────────────────────────────────────────
const DEFAULT_PROXIES = [
  "http://ksafvqcs:p6tr4fo7n0m6@31.59.20.176:6754",
  "http://ksafvqcs:p6tr4fo7n0m6@23.95.150.145:6114",
  "http://ksafvqcs:p6tr4fo7n0m6@198.23.239.134:6540",
  "http://ksafvqcs:p6tr4fo7n0m6@45.38.107.97:6014",
  "http://ksafvqcs:p6tr4fo7n0m6@107.172.163.27:6543",
  "http://ksafvqcs:p6tr4fo7n0m6@198.105.121.200:6462",
  "http://ksafvqcs:p6tr4fo7n0m6@64.137.96.74:6641",
  "http://ksafvqcs:p6tr4fo7n0m6@216.10.27.159:6837",
  "http://ksafvqcs:p6tr4fo7n0m6@142.111.67.146:5611",
  "http://ksafvqcs:p6tr4fo7n0m6@191.96.254.138:6185",
];

const proxyPool = {
  proxies: [
    ...DEFAULT_PROXIES,
    ...(process.env.PROXY_LIST || "").split("\n").map(p => p.trim()).filter(Boolean),
  ],
  index: 0,
  next() {
    if (this.proxies.length === 0) return "";
    const proxy = this.proxies[this.index % this.proxies.length];
    this.index++;
    return proxy;
  },
  add(proxyUrl) {
    if (!this.proxies.includes(proxyUrl)) this.proxies.push(proxyUrl);
  },
  remove(proxyUrl) {
    this.proxies = this.proxies.filter(p => p !== proxyUrl);
  },
};

// Get proxy for account: use account's own proxy if set, else rotate from pool
function getProxy(account) {
  if (account?.proxyUrl) return account.proxyUrl;
  return proxyPool.next();
}

// Admin: manage proxy pool
// ── PROXY MANAGEMENT ROUTES ──────────────────────────────────────────────────
app.get("/api/admin/proxies", auth, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  res.json({ proxies: proxyPool.proxies, count: proxyPool.proxies.length });
});

app.post("/api/admin/proxies", auth, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const { proxies } = req.body;
  if (!Array.isArray(proxies)) return res.status(400).json({ error: "proxies must be array" });
  proxies.forEach(p => p.trim() && proxyPool.add(p.trim()));
  res.json({ success: true, count: proxyPool.proxies.length });
});

app.delete("/api/admin/proxies", auth, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const { proxyUrl } = req.body;
  proxyPool.remove(proxyUrl);
  res.json({ success: true, count: proxyPool.proxies.length });
});

app.post("/api/accounts/:id/proxy", auth, async (req, res) => {
  try {
    const { proxyUrl } = req.body;
    const acc = await Account.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { proxyUrl: proxyUrl || "" },
      { new: true }
    );
    if (!acc) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, proxyUrl: acc.proxyUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test single proxy — real IP + Instagram reachability
app.post("/api/proxy/test", auth, async (req, res) => {
  const { proxyUrl } = req.body;
  if (!proxyUrl) return res.status(400).json({ error: "proxyUrl required" });
  try {
    const { HttpsProxyAgent } = require("https-proxy-agent");
    const agent = new HttpsProxyAgent(proxyUrl);
    const start = Date.now();
    const ipRes = await axios.get("https://api.ipify.org?format=json", {
      httpsAgent: agent, proxy: false, timeout: 10000,
    });
    let igReachable = false;
    try {
      await axios.get("https://www.instagram.com/", {
        httpsAgent: agent, proxy: false, timeout: 8000,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      igReachable = true;
    } catch {}
    res.json({ success: true, ip: ipRes.data.ip, igReachable, ms: Date.now() - start });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Bulk test all proxies
app.get("/api/proxy/test-all", auth, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const results = await Promise.all(proxyPool.proxies.map(async (proxyUrl) => {
    try {
      const { HttpsProxyAgent } = require("https-proxy-agent");
      const agent = new HttpsProxyAgent(proxyUrl);
      const start = Date.now();
      const ipRes = await axios.get("https://api.ipify.org?format=json", {
        httpsAgent: agent, proxy: false, timeout: 8000,
      });
      return { proxyUrl, status: "alive", ip: ipRes.data.ip, ms: Date.now() - start };
    } catch (e) {
      return { proxyUrl, status: "dead", ip: null, ms: null, error: e.message };
    }
  }));
  res.json(results);
});

// ── SHARED PYTHON HELPERS ─────────────────────────────────────────────────────
// ── DEVICE FINGERPRINT GENERATOR ─────────────────────────────────────────────
// Each account gets its own unique persistent Android device fingerprint
// seeded from account ID so it's always the same device for that account
const ANDROID_DEVICES = [
  { manufacturer: "Samsung",  model: "SM-G991B",  device: "o1s",       cpu: "exynos2100",  android: 31, release: "12",   dpi: "480dpi",  res: "1080x2340" },
  { manufacturer: "Samsung",  model: "SM-A536B",  device: "a53x",      cpu: "exynos1280",  android: 31, release: "12",   dpi: "400dpi",  res: "1080x2408" },
  { manufacturer: "OnePlus",  model: "CPH2399",   device: "op535",     cpu: "qcom",        android: 31, release: "12",   dpi: "450dpi",  res: "1080x2400" },
  { manufacturer: "Xiaomi",   model: "2201123G",  device: "cupid",     cpu: "qcom",        android: 32, release: "12",   dpi: "460dpi",  res: "1080x2400" },
  { manufacturer: "Xiaomi",   model: "220733SG",  device: "munch",     cpu: "qcom",        android: 31, release: "12",   dpi: "440dpi",  res: "1080x2400" },
  { manufacturer: "Realme",   model: "RMX3563",   device: "RM6785",    cpu: "mt6785",      android: 30, release: "11",   dpi: "400dpi",  res: "1080x2400" },
  { manufacturer: "Oppo",     model: "CPH2387",   device: "OP52C1L1",  cpu: "mt6877",      android: 31, release: "12",   dpi: "400dpi",  res: "1080x2400" },
  { manufacturer: "Vivo",     model: "V2109",     device: "vivo1920",  cpu: "mt6768",      android: 30, release: "11",   dpi: "400dpi",  res: "1080x2400" },
  { manufacturer: "Motorola", model: "XT2201-3",  device: "tesla",     cpu: "qcom",        android: 31, release: "12",   dpi: "400dpi",  res: "1080x2400" },
  { manufacturer: "Nokia",    model: "TA-1428",   device: "NokiaX30",  cpu: "qcom",        android: 31, release: "12",   dpi: "400dpi",  res: "1080x2340" },
];

const IG_APP_VERSIONS = [
  { version: "269.0.0.18.75", code: "301484483" },
  { version: "271.0.0.19.87", code: "303748645" },
  { version: "275.0.0.27.98", code: "307866453" },
  { version: "278.0.0.18.87", code: "310924460" },
  { version: "281.0.0.20.101","code": "313884060" },
];

function getDeviceFingerprint(accountId) {
  // Seed from accountId — always same device for same account
  const seed = accountId.toString();
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  const abs = Math.abs(hash);
  const device = ANDROID_DEVICES[abs % ANDROID_DEVICES.length];
  const appVer = IG_APP_VERSIONS[abs % IG_APP_VERSIONS.length];

  // Generate deterministic UUIDs from seed
  const uuidFromSeed = (extra) => {
    let h = abs + extra;
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      h = ((h << 5) - h) + c.charCodeAt(0); h |= 0;
      const v = c === 'x' ? (Math.abs(h) % 16) : ((Math.abs(h) % 4) + 8);
      return v.toString(16);
    });
  };

  return {
    device,
    appVersion: appVer.version,
    versionCode: appVer.code,
    phoneId: uuidFromSeed(1),
    uuid: uuidFromSeed(2),
    clientSessionId: uuidFromSeed(3),
    advertisingId: uuidFromSeed(4),
    deviceId: `android-${Math.abs(abs * 7 + 13).toString(16).slice(0, 16)}`,
    userAgent: `Instagram ${appVer.version} Android (${device.android}/${device.release}; ${device.dpi}; ${device.res}; ${device.manufacturer}; ${device.model}; ${device.device}; ${device.cpu}; en_US; ${appVer.code})`,
  };
}

const pySetup = (proxyUrl = "", accountId = "") => {
  const fp = accountId ? getDeviceFingerprint(accountId) : getDeviceFingerprint("default");
  return `
import sys, json, time, uuid, random, hashlib

DEVICE_SETTINGS = {
    "app_version": "${fp.appVersion}",
    "android_version": ${fp.device.android},
    "android_release": "${fp.device.release}",
    "dpi": "${fp.device.dpi}",
    "resolution": "${fp.device.res}",
    "manufacturer": "${fp.device.manufacturer}",
    "device": "${fp.device.device}",
    "model": "${fp.device.model}",
    "cpu": "${fp.device.cpu}",
    "version_code": "${fp.versionCode}",
}

UUIDS = {
    "phone_id": "${fp.phoneId}",
    "uuid": "${fp.uuid}",
    "client_session_id": "${fp.clientSessionId}",
    "advertising_id": "${fp.advertisingId}",
    "device_id": "${fp.deviceId}",
}

USER_AGENT = "${fp.userAgent}"

def make_client(proxy_url=None, saved_settings=None):
    from instagrapi import Client
    cl = Client()
    cl.delay_range = [3, 7]

    if proxy_url:
        cl.set_proxy(proxy_url)

    if saved_settings:
        try:
            cl.set_settings(saved_settings)
            # Always enforce our device fingerprint even on restored sessions
            cl.set_device(DEVICE_SETTINGS)
            cl.set_uuids(UUIDS)
            cl.user_agent = USER_AGENT
        except:
            pass
    else:
        # Fresh session — apply full fingerprint
        cl.set_device(DEVICE_SETTINGS)
        cl.set_uuids(UUIDS)
        cl.user_agent = USER_AGENT

    # ── Auto-handle ALL challenge types ──────────────────────────────────────
    def challenge_handler(username, choice):
        try:
            cl.challenge_resolve(cl.last_json)
        except:
            pass
        time.sleep(2)
        return 0

    cl.challenge_code_handler = challenge_handler

    # ── Auto-dismiss "automated behavior" / feedback_required popup ──────────
    original_request = cl._send_private_request

    def patched_request(endpoint, **kwargs):
        try:
            return original_request(endpoint, **kwargs)
        except Exception as e:
            err = str(e)
            if "feedback_required" in err or "automated" in err.lower():
                try:
                    cl.private_request("consent/existing_user_flow/", data={
                        "current_screen_key": "qp_intro",
                        "updates": json.dumps({"existing_user_flow_intro_key": "seen"})
                    })
                    time.sleep(random.uniform(3, 5))
                    return original_request(endpoint, **kwargs)
                except:
                    pass
            raise

    cl._send_private_request = patched_request

    return cl

proxy_url = ${proxyUrl ? `"${proxyUrl}"` : 'None'}
`;
};


// ── INSTAGRAPI — PASSWORD LOGIN ───────────────────────────────────────────────
// In-memory store for pending authorizations
const pendingAuthorizations = new Map();

async function instagrapiLogin(username, password, proxyUrl = "", accountId = "") {
  return new Promise((resolve) => {
    const setup = pySetup(proxyUrl, accountId);
    const script = `
${setup}
try:
    from instagrapi.exceptions import ChallengeRequired, LoginRequired, FeedbackRequired

    cl = make_client(proxy_url)

    def try_login(cl, username, password, attempt=1):
        try:
            cl.login(username, password)
            return {"success": True}
        except FeedbackRequired as fe:
            # "We suspect automated behavior" — auto-dismiss and retry
            err = str(fe)
            try:
                # Acknowledge the popup
                cl.private_request("consent/existing_user_flow/", data={
                    "current_screen_key": "qp_intro",
                    "updates": json.dumps({"existing_user_flow_intro_key": "seen"})
                })
                time.sleep(random.uniform(4, 7))
            except:
                pass
            if attempt < 3:
                time.sleep(random.uniform(5, 10))
                return try_login(cl, username, password, attempt + 1)
            return {"success": False, "error": "Instagram flagged this login. Try again in a few minutes or use a proxy."}
        except ChallengeRequired:
            return {"pending": True}
        except Exception as e:
            err = str(e)
            if "challenge" in err.lower() or "verify" in err.lower() or "feedback" in err.lower() or "wait" in err.lower() or "automated" in err.lower():
                if attempt < 2:
                    time.sleep(random.uniform(5, 10))
                    return try_login(cl, username, password, attempt + 1)
                return {"pending": True}
            return {"success": False, "error": err}

    result = try_login(cl, '${username}', '${password}')

    if result.get("success"):
        session = json.dumps(cl.get_settings())
        user_id = str(cl.user_id)
        print(json.dumps({"success": True, "userId": user_id, "username": "${username}", "sessionData": session}))
    elif result.get("pending"):
        try:
            temp = json.dumps(cl.get_settings())
        except:
            temp = "{}"
        print(json.dumps({"pending": True, "tempSession": temp}))
    else:
        print(json.dumps({"success": False, "error": result.get("error", "Unknown error")}))

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
            if (parsed && typeof parsed === "object" && ("success" in parsed || "pending" in parsed)) {
              resolve(parsed); return;
            }
          } catch {}
        }
        resolve({ success: false, error: errOutput || "Python/Instagrapi not available" });
      } catch {
        resolve({ success: false, error: errOutput || "Python/Instagrapi not available" });
      }
    });
    setTimeout(() => { py.kill(); resolve({ success: false, error: "Login timeout — please try again" }); }, 180000);
  });
}

async function instagrapiLoginWithTempSession(username, password, tempSession, proxyUrl = "", accountId = "") {
  return new Promise((resolve) => {
    const safeTempSession = (tempSession || "{}").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const setup = pySetup(proxyUrl, accountId);
    const script = `
${setup}
try:
    from instagrapi.exceptions import ChallengeRequired, FeedbackRequired

    saved = None
    try:
        saved = json.loads('${safeTempSession}')
    except:
        pass

    cl = make_client(proxy_url, saved_settings=saved)

    try:
        cl.login('${username}', '${password}')
        session = json.dumps(cl.get_settings())
        user_id = str(cl.user_id)
        print(json.dumps({"success": True, "userId": user_id, "username": "${username}", "sessionData": session}))
    except FeedbackRequired:
        try:
            cl.private_request("consent/existing_user_flow/", data={
                "current_screen_key": "qp_intro",
                "updates": json.dumps({"existing_user_flow_intro_key": "seen"})
            })
            time.sleep(random.uniform(4, 7))
            cl.login('${username}', '${password}')
            session = json.dumps(cl.get_settings())
            user_id = str(cl.user_id)
            print(json.dumps({"success": True, "userId": user_id, "username": "${username}", "sessionData": session}))
        except ChallengeRequired:
            print(json.dumps({"pending": True}))
        except:
            print(json.dumps({"pending": True}))
    except ChallengeRequired:
        print(json.dumps({"pending": True}))
    except Exception as e2:
        err = str(e2)
        if "challenge" in err.lower() or "verify" in err.lower() or "feedback" in err.lower() or "automated" in err.lower():
            print(json.dumps({"pending": True}))
        else:
            print(json.dumps({"success": False, "error": err}))

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
            if (parsed && typeof parsed === "object" && ("success" in parsed || "pending" in parsed)) {
              resolve(parsed); return;
            }
          } catch {}
        }
        resolve({ success: false, error: errOutput || "No response" });
      } catch {
        resolve({ success: false, error: "Python error" });
      }
    });
    setTimeout(() => { py.kill(); resolve({ pending: true }); }, 60000);
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
  // Always use original TikTok caption — no rewriting
  let caption = video.caption || "";
  // Optionally append account hashtags at the end
  if (account.hashtags && account.hashtags.trim()) {
    caption = caption ? `${caption}\n\n${account.hashtags.trim()}` : account.hashtags.trim();
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
    const result = await postViaInstagrapi(account.sessionData, videoPath, caption, getProxy(account), account._id.toString());

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

async function postViaInstagrapi(sessionData, videoPath, caption, proxyUrl = "", accountId = "") {
  return new Promise((resolve) => {
    if (!sessionData) {
      resolve({ success: false, error: "No session — please reconnect your Instagram account" });
      return;
    }
    const escapedCaption = caption.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
    const escapedPath = videoPath.replace(/\\/g, "/");
    const setup = pySetup(proxyUrl, accountId);
    const safeSession = sessionData.replace(/'/g, "\\'");
    const script = `
${setup}
try:
    from instagrapi.exceptions import LoginRequired, PleaseWaitFewMinutes, FeedbackRequired

    settings = json.loads('''${safeSession}''')
    cl = make_client(proxy_url, saved_settings=settings)

    # Re-inject session cookie
    cookies = settings.get("cookies", {})
    session_id = cookies.get("sessionid", "")
    if session_id:
        try:
            cl.login_by_sessionid(session_id)
        except FeedbackRequired:
            # Auto-dismiss "automated behavior" popup and continue
            try:
                cl.private_request("consent/existing_user_flow/", data={
                    "current_screen_key": "qp_intro",
                    "updates": json.dumps({"existing_user_flow_intro_key": "seen"})
                })
                time.sleep(random.uniform(3, 5))
                cl.login_by_sessionid(session_id)
            except Exception as dismiss_err:
                # Continue anyway — session might still be valid
                pass
        except Exception:
            pass

    # Human-like delay before posting
    time.sleep(random.uniform(3, 6))

    def do_upload():
        return cl.clip_upload('${escapedPath}', caption='${escapedCaption}')

    # Try upload — auto-handle feedback_required during upload too
    try:
        media = do_upload()
    except FeedbackRequired:
        try:
            cl.private_request("consent/existing_user_flow/", data={
                "current_screen_key": "qp_intro",
                "updates": json.dumps({"existing_user_flow_intro_key": "seen"})
            })
            time.sleep(random.uniform(5, 8))
            media = do_upload()
        except Exception as fe2:
            raise Exception(f"Feedback required after dismiss: {str(fe2)}")

    try:
        new_session = json.dumps(cl.get_settings())
    except:
        new_session = ""

    print(json.dumps({"success": True, "mediaId": str(media.pk), "sessionData": new_session}))

except LoginRequired:
    print(json.dumps({"success": False, "error": "Session expired — please reconnect your account"}))
except PleaseWaitFewMinutes:
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
    const setup = pySetup(getProxy(acc), acc._id.toString());
    const safeSession = acc.sessionData.replace(/'/g, "\\'");
    const script = `
${setup}
try:
    settings = json.loads(\'\'\'${safeSession}\'\'\')
    cl = make_client(proxy_url, saved_settings=settings)
    # Use a lightweight API call instead of timeline feed (less suspicious)
    cl.user_info(str(cl.user_id))
    print(json.dumps({"ok": True}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;
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

// ── BULK TIKTOK IMPORT ────────────────────────────────────────────────────────
app.post("/api/tiktok/import", auth, async (req, res) => {
  try {
    const { query, type, accountId, limit = 50 } = req.body;
    // type: "hashtag" or "username"
    if (!query) return res.status(400).json({ error: "Query required" });
    if (!accountId) return res.status(400).json({ error: "Account required" });

    const account = await Account.findOne({ _id: accountId, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });

    const cleanQuery = query.replace(/^[@#]/, "").trim();
    const cap = Math.min(parseInt(limit) || 50, 150);

    let videoUrls = [];
    let fetched = 0;
    let cursor = 0;

    // Paginate tikwm until we have enough
    while (fetched < cap) {
      const batch = Math.min(cap - fetched, 35);
      let apiUrl;
      if (type === "username") {
        apiUrl = `https://tikwm.com/api/user/posts?unique_id=${encodeURIComponent(cleanQuery)}&count=${batch}&cursor=${cursor}`;
      } else {
        apiUrl = `https://tikwm.com/api/feed/search?keywords=${encodeURIComponent(cleanQuery)}&count=${batch}&cursor=${cursor}`;
      }

      const resp = await axios.get(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 });
      if (resp.data.code !== 0 || !resp.data.data?.videos?.length) break;

      const videos = resp.data.data.videos;
      for (const v of videos) {
        const url = type === "username"
          ? `https://www.tiktok.com/@${cleanQuery}/video/${v.video_id}`
          : `https://www.tiktok.com/@${v.author?.unique_id}/video/${v.video_id}`;
        videoUrls.push(url);
      }
      fetched += videos.length;
      cursor = resp.data.data.cursor || 0;
      if (!resp.data.data.hasMore) break;
    }

    if (videoUrls.length === 0) return res.status(404).json({ error: `No videos found for ${type === "hashtag" ? "#" : "@"}${cleanQuery}` });

    // Deduplicate against existing
    const existing = new Set(
      (await Video.find({ accountId, videoUrl: { $in: videoUrls } }).select("videoUrl")).map(v => v.videoUrl)
    );
    const newUrls = videoUrls.filter(u => !existing.has(u));

    if (newUrls.length === 0) return res.json({ added: 0, skipped: videoUrls.length, message: "All videos already in queue" });

    const created = await Video.insertMany(newUrls.map(url => ({
      userId: req.user.id,
      accountId,
      videoUrl: url,
      hashtags: account.hashtags || "",
      status: "queued",
    })));

    // Stagger downloads 3s apart to not hammer the API
    created.forEach((v, i) => setTimeout(() => downloadVideo(v._id, v.videoUrl), i * 3000));

    await logActivity(req.user.id, accountId, account.username, "imported",
      `📥 Imported ${created.length} videos from ${type === "hashtag" ? "#" : "@"}${cleanQuery}`);

    res.json({
      added: created.length,
      skipped: existing.size,
      total: videoUrls.length,
      message: `✅ ${created.length} videos importing now!`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SCHEDULER ─────────────────────────────────────────────────────────────────
// Generate random posting times for an account — spread across day with jitter
function generateRandomPostingTimes(postsPerDay) {
  // Spread posts between 7am and 11pm (16hr window)
  const startHour = 7;
  const endHour = 23;
  const window = endHour - startHour;
  const times = [];
  for (let i = 0; i < postsPerDay; i++) {
    // Evenly distributed + random ±30min jitter
    const baseHour = startHour + (window / postsPerDay) * i;
    const jitter = (Math.random() - 0.5) * 1; // ±30min
    const totalHour = Math.max(startHour, Math.min(endHour - 1, baseHour + jitter));
    const h = Math.floor(totalHour);
    // Random minute within the hour
    const m = Math.floor(Math.random() * 60);
    times.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  return [...new Set(times)].sort(); // deduplicate + sort
}

// Randomize posting times for all active accounts daily at midnight
cron.schedule("0 0 * * *", async () => {
  try {
    const accounts = await Account.find({ status: { $in: ["active", "paused"] }, randomTimes: true });
    for (const acc of accounts) {
      const newTimes = generateRandomPostingTimes(acc.postsPerDay);
      await Account.findByIdAndUpdate(acc._id, { postingTimes: newTimes });
      console.log(`🎲 Randomized times for @${acc.username}: ${newTimes.join(", ")}`);
    }
  } catch (e) { console.error("Time randomizer error:", e.message); }
});

app.post("/api/accounts/:id/randomize-times", auth, async (req, res) => {
  try {
    const acc = await Account.findOne({ _id: req.params.id, userId: req.user.id });
    if (!acc) return res.status(404).json({ error: "Not found" });
    const times = generateRandomPostingTimes(acc.postsPerDay);
    await Account.findByIdAndUpdate(acc._id, { postingTimes: times, randomTimes: true });
    res.json({ success: true, postingTimes: times });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
app.get("/", (req, res) => res.json({ status: "✅ ReelFlow API v5.0 — Phone Authorization", version: "5.0.0", uptime: process.uptime() }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
const adminAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "No token" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin only" });
    req.user = decoded;
    next();
  } catch { res.status(401).json({ error: "Invalid token" }); }
};

app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const [totalUsers, totalAccounts, totalVideos, postedToday, activeAccounts] = await Promise.all([
      User.countDocuments(),
      Account.countDocuments(),
      Video.countDocuments(),
      Video.countDocuments({ status: "posted", postedAt: { $gte: new Date(Date.now() - 86400000) } }),
      Account.countDocuments({ status: "active" }),
    ]);
    res.json({ totalUsers, totalAccounts, totalVideos, postedToday, activeAccounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/users", adminAuth, async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 });
    const usersWithStats = await Promise.all(users.map(async (u) => {
      const [accounts, videos, posted] = await Promise.all([
        Account.countDocuments({ userId: u._id }),
        Video.countDocuments({ userId: u._id }),
        Video.countDocuments({ userId: u._id, status: "posted" }),
      ]);
      return { ...u.toObject(), accounts, videos, posted };
    }));
    res.json(usersWithStats);
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

app.patch("/api/admin/users/:id", adminAuth, async (req, res) => {
  try {
    const { role, plan } = req.body;
    await User.findByIdAndUpdate(req.params.id, { role, plan });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3001, () => console.log(`🚀 ReelFlow v5.0 on port ${process.env.PORT || 3001}`));
