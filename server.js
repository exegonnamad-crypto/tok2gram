const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const cron = require("node-cron");
const { HttpsProxyAgent } = require("https-proxy-agent");
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
  encryptedPassword: { type: String, default: "" }, // AES encrypted, for auto-reconnect
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
  proxyMode: { type: String, default: "rotate", enum: ["none", "fixed", "rotate"] },
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

    else if (event === "reconnected" && user.notifyOnConnect) {
      message =
        `🔄 <b>Account Auto-Reconnected!</b>\n\n` +
        `👤 Instagram: <b>@${data.username}</b>\n` +
        `🕐 Time: ${timeStr} — ${dateStr}\n\n` +
        `✅ ReelFlow automatically restored the session. Posting resumed.`;
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
    const result = await igLogin(username, password);
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
  const result = await igLoginWithSession(pending.username, pending.password, pending.tempSession, pending.proxyUrl || "", pending.tempAccountId || "");

  if (result.success) {
    pendingAuthorizations.delete(sessionKey);
    try {
      const { niche, postsPerDay, hashtags, captionStyle, customCaption, autoRequeue, postingTimes } = pending.accountData;

      // Reconnect — update existing account
      if (pending.reconnectId) {
        const acc = await Account.findOneAndUpdate(
          { _id: pending.reconnectId, userId: req.user.id },
          {
            sessionData: result.sessionData || "",
            sessionSavedAt: new Date(),
            igUserId: result.userId || "",
            igPassword: await bcrypt.hash(pending.password, 10),
            encryptedPassword: encryptPassword(pending.password),
            status: "active",
          },
          { new: true }
        );
        if (!acc) return res.status(404).json({ error: "Account not found" });
        await logActivity(req.user.id, acc._id, acc.username, "reconnected", `🔄 @${acc.username} reconnected via phone auth`);
        return res.json({ authorized: true, account: acc });
      }

      // New account
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
      await logActivity(req.user.id, acc._id, acc.username, "connected", `✅ @${acc.username} connected via phone auth`);
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

    const loginResult = await igLogin(username, password);

    if (loginResult.needsCode) return res.status(400).json({ error: "Code was incorrect, please try again" });
    if (!loginResult.success) return res.status(400).json({ error: `Login failed: ${loginResult.error}` });

    const acc = await Account.create({
      userId: req.user.id,
      username: (loginResult.username || username || "").replace("@", "").toLowerCase().trim(),
      igUserId: loginResult.userId || "",
      igPassword: password ? await bcrypt.hash(password, 10) : "",
        encryptedPassword: password ? encryptPassword(password) : "",
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
    const { username, password, igPassword, niche, postsPerDay, hashtags, captionStyle, customCaption, appendHashtags, autoRequeue, postingTimes, proxyUrl, proxyMode, reconnectId } = req.body;
    const igPass = password || igPassword;

    if (!igPass) return res.status(400).json({ error: "Password required" });
    if (!username) return res.status(400).json({ error: "Instagram username required" });

    const loginResult = await igLogin(username, igPass, proxyUrl || "", reconnectId || "");

    // Instagram requires phone authorization
    if (loginResult.pending) {
      const sessionKey = `${req.user.id}:${username}:${Date.now()}`;
      pendingAuthorizations.set(sessionKey, {
        status: "pending",
        username, password: igPass,
        tempSession: loginResult.tempSession || "{}",
        proxyUrl: proxyUrl || "",
        tempAccountId: reconnectId || sessionKey,
        reconnectId: reconnectId || null,
        accountData: { niche, postsPerDay, hashtags, captionStyle, customCaption, autoRequeue, postingTimes, proxyUrl },
        userId: req.user.id,
        createdAt: Date.now(),
      });
      setTimeout(() => pendingAuthorizations.delete(sessionKey), 300000);
      return res.json({ pending: true, sessionKey, message: "Check your phone and tap 'This was me' to authorize" });
    }

    if (!loginResult.success) return res.status(400).json({ error: `Instagram login failed: ${loginResult.error}` });

    // If reconnecting — update existing account session instead of creating new
    if (reconnectId) {
      const acc = await Account.findOneAndUpdate(
        { _id: reconnectId, userId: req.user.id },
        {
          sessionData: loginResult.sessionData || "",
          sessionSavedAt: new Date(),
          igUserId: loginResult.userId || "",
          igPassword: await bcrypt.hash(igPass, 10),
      encryptedPassword: encryptPassword(igPass),
          status: "active",
        },
        { new: true }
      );
      if (!acc) return res.status(404).json({ error: "Account not found" });
      await logActivity(req.user.id, acc._id, acc.username, "reconnected", `🔄 @${acc.username} reconnected`);
      return res.json({ ...acc.toObject(), igPassword: "***", sessionData: undefined });
    }

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
    notifyUser(req.user.id, "connected", { username: acc.username, niche: acc.niche, postsPerDay: acc.postsPerDay });
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

    // Fetch profile using instagram-private-api
    let result = { success: false, error: "Could not fetch profile" };
    try {
      const { ig } = createIgClient(acc._id.toString());
      ig.state.generateDevice(acc.username);
      applyProxy(ig, getProxy(acc));
      await ig.state.deserialize(JSON.parse(acc.sessionData));
      const info = await ig.account.currentUser();
      result = {
        success: true,
        username: info.username,
        fullName: info.full_name || "",
        bio: info.biography || "",
        followers: info.follower_count || 0,
        following: info.following_count || 0,
        posts: info.media_count || 0,
        profilePic: info.profile_pic_url || "",
        isVerified: info.is_verified || false,
      };
    } catch (e) {
      result = { success: false, error: e.message };
    }

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

// Get proxy for account based on proxyMode
// - "none"   → no proxy (direct connection)
// - "fixed"  → always use account's own proxyUrl
// - "rotate" → pick next proxy from pool each time (default)
function getProxy(account) {
  const mode = account?.proxyMode || "rotate";
  if (mode === "none") return "";
  if (mode === "fixed") return account?.proxyUrl || "";
  // rotate mode — use account's proxy if set, otherwise take next from pool
  return account?.proxyUrl || proxyPool.next();
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

// ── INSTAGRAM PRIVATE API (replaces Python/instagrapi) ───────────────────────
let IgApiClient, IgCheckpointError, IgLoginBadPasswordError, IgLoginInvalidUserError,
    IgNotFoundError, IgActionSpamError, IgResponseError;
try {
  const igPkg = require("instagram-private-api");
  IgApiClient = igPkg.IgApiClient;
  IgCheckpointError = igPkg.IgCheckpointError;
  IgLoginBadPasswordError = igPkg.IgLoginBadPasswordError;
  IgLoginInvalidUserError = igPkg.IgLoginInvalidUserError;
  IgNotFoundError = igPkg.IgNotFoundError;
  IgActionSpamError = igPkg.IgActionSpamError;
  IgResponseError = igPkg.IgResponseError;
  console.log("✅ instagram-private-api loaded");
} catch (e) {
  console.error("❌ instagram-private-api NOT installed:", e.message);
  console.error("Run: npm install instagram-private-api");
}
const { promisify } = require("util");
const readFileAsync = promisify(require("fs").readFile);

// ── DEVICE FINGERPRINT GENERATOR ─────────────────────────────────────────────
const ANDROID_DEVICES = [
  { manufacturer: "Samsung",  model: "SM-G991B",  device: "o1s",      android_version: "12", android_release: "12" },
  { manufacturer: "Samsung",  model: "SM-A536B",  device: "a53x",     android_version: "12", android_release: "12" },
  { manufacturer: "OnePlus",  model: "CPH2399",   device: "op535",    android_version: "12", android_release: "12" },
  { manufacturer: "Xiaomi",   model: "2201123G",  device: "cupid",    android_version: "12", android_release: "12" },
  { manufacturer: "Xiaomi",   model: "220733SG",  device: "munch",    android_version: "12", android_release: "12" },
  { manufacturer: "Realme",   model: "RMX3563",   device: "RM6785",   android_version: "11", android_release: "11" },
  { manufacturer: "Oppo",     model: "CPH2387",   device: "OP52C1L1", android_version: "12", android_release: "12" },
  { manufacturer: "Vivo",     model: "V2109",     device: "vivo1920", android_version: "11", android_release: "11" },
  { manufacturer: "Motorola", model: "XT2201-3",  device: "tesla",    android_version: "12", android_release: "12" },
  { manufacturer: "Nokia",    model: "TA-1428",   device: "NokiaX30", android_version: "12", android_release: "12" },
];

function seedRandom(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = Math.imul(31, h) + str.charCodeAt(i) | 0; }
  return Math.abs(h);
}

function getDeviceForAccount(accountId) {
  const seed = seedRandom(accountId.toString());
  return ANDROID_DEVICES[seed % ANDROID_DEVICES.length];
}

// Create a fresh IgApiClient with device fingerprint seeded from accountId
function createIgClient(accountId = "default") {
  const ig = new IgApiClient();
  const device = getDeviceForAccount(accountId);
  // instagram-private-api generates device from username seed — we override after
  return { ig, device };
}

// Apply proxy to ig client
function applyProxy(ig, proxyUrl) {
  if (!proxyUrl) return;
  try {
    ig.state.proxyUrl = proxyUrl;
  } catch {}
}

// Simulate human-like delay
const humanDelay = (min = 2000, max = 6000) =>
  new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

// ── LOGIN ─────────────────────────────────────────────────────────────────────
const pendingAuthorizations = new Map();

async function igLogin(username, password, proxyUrl = "", accountId = "") {
  if (!IgApiClient) {
    return { success: false, error: "instagram-private-api not installed on server. Run: npm install" };
  }
  const { ig } = createIgClient(accountId || username);
  ig.state.generateDevice(username); // deterministic device per username
  applyProxy(ig, proxyUrl);

  // Wipe any existing session from DB before logging in fresh
  // This prevents "multiple sessions" error — Instagram sees it as same device re-logging in
  if (accountId) {
    try { await Account.findByIdAndUpdate(accountId, { sessionData: null, sessionSavedAt: null }); } catch {}
  }

  try {
    await humanDelay(2000, 4000); // wait before login attempt
    await ig.simulate.preLoginFlow();
    const loggedInUser = await ig.account.login(username, password);
    await humanDelay(1000, 3000);
    await ig.simulate.postLoginFlow();
    const session = await ig.state.serialize();
    delete session.constants; // don't store constants
    return {
      success: true,
      userId: loggedInUser.pk.toString(),
      username: loggedInUser.username,
      sessionData: JSON.stringify(session),
    };
  } catch (e) {
    if (e instanceof IgCheckpointError) {
      // Instagram wants phone/email challenge — this is normal, handle it
      try {
        await ig.challenge.auto(true); // request SMS/push challenge
        const session = await ig.state.serialize();
        delete session.constants;
        return {
          pending: true,
          tempSession: JSON.stringify(session),
          challengeUrl: ig.state.checkpoint?.challenge?.api_path,
        };
      } catch (ce) {
        return { pending: true, tempSession: "{}" };
      }
    }
    if (e instanceof IgLoginBadPasswordError) {
      return { success: false, error: "Wrong password — please double-check and try again" };
    }
    if (e instanceof IgLoginInvalidUserError) {
      // This can fire for blocked IPs too, not just missing accounts
      return { success: false, error: "Login blocked — Instagram rejected this request. Try switching proxy or wait 10 minutes." };
    }
    if (e instanceof IgActionSpamError) {
      return { success: false, error: "Instagram rate limited — wait 10 minutes and try again" };
    }
    const msg = (e.message || "").toLowerCase();
    const json = (() => { try { return JSON.stringify(e.response?.body || {}); } catch { return ""; } })();

    console.error(`igLogin error for @${username}: ${e.constructor?.name} — ${e.message}`, json);

    if (msg.includes("challenge") || msg.includes("checkpoint") || msg.includes("verify")) {
      return { pending: true, tempSession: "{}" };
    }
    if (msg.includes("feedback") || msg.includes("automated") || msg.includes("suspicious") || msg.includes("spam")) {
      return { success: false, error: "Instagram flagged this login as suspicious. Open Instagram on your phone, then try again in 5 minutes." };
    }
    if (msg.includes("bad_password") || msg.includes("invalid_credentials")) {
      return { success: false, error: "Wrong password — please double-check and try again" };
    }
    if (msg.includes("invalid_user") || msg.includes("user_not_found") || msg.includes("no_user")) {
      return { success: false, error: "Login blocked by Instagram — this usually means the IP/proxy is blocked. Try a different proxy." };
    }
    if (msg.includes("network") || msg.includes("econnrefused") || msg.includes("timeout") || msg.includes("econnreset")) {
      return { success: false, error: "Proxy connection failed — check your proxy is working and try again." };
    }
    return { success: false, error: `Instagram login failed: ${e.message || "Unknown error"}. Check Railway logs for details.` };
  }
}

// Poll after user taps "This was me" on phone
async function igLoginWithSession(username, password, tempSessionStr, proxyUrl = "", accountId = "") {
  const { ig } = createIgClient(accountId || username);
  ig.state.generateDevice(username);
  applyProxy(ig, proxyUrl);

  // Restore saved state if available
  if (tempSessionStr && tempSessionStr !== "{}") {
    try {
      await ig.state.deserialize(JSON.parse(tempSessionStr));
    } catch {}
  }

  try {
    await ig.simulate.preLoginFlow();
    const loggedInUser = await ig.account.login(username, password);
    await humanDelay(1000, 2000);
    await ig.simulate.postLoginFlow();
    const session = await ig.state.serialize();
    delete session.constants;
    return {
      success: true,
      userId: loggedInUser.pk.toString(),
      username: loggedInUser.username,
      sessionData: JSON.stringify(session),
    };
  } catch (e) {
    if (e instanceof IgCheckpointError) {
      try {
        // Check if checkpoint was already resolved (user tapped approve)
        await ig.challenge.auto(true);
        const session = await ig.state.serialize();
        delete session.constants;
        // Still pending — user hasn't tapped yet
        return { pending: true, tempSession: JSON.stringify(session) };
      } catch {
        return { pending: true, tempSession: tempSessionStr };
      }
    }
    if (e instanceof IgLoginBadPasswordError) {
      return { success: false, error: "Wrong password" };
    }
    const msg = e.message?.toLowerCase() || "";
    if (msg.includes("challenge") || msg.includes("checkpoint") || msg.includes("verify")) {
      return { pending: true, tempSession: tempSessionStr };
    }
    return { success: false, error: e.message || "Login failed" };
  }
}

// ── POST TO INSTAGRAM ─────────────────────────────────────────────────────────
async function igPost(sessionData, videoPath, caption, proxyUrl = "", accountId = "") {
  if (!sessionData) return { success: false, error: "No session — please reconnect account" };

  const { ig } = createIgClient(accountId);
  ig.state.generateDevice(accountId || "default");
  applyProxy(ig, proxyUrl);

  try {
    await ig.state.deserialize(JSON.parse(sessionData));
  } catch (e) {
    return { success: false, error: "Invalid session — please reconnect account" };
  }

  try {
    await humanDelay(2000, 5000);

    const videoBuffer = await readFileAsync(videoPath);

    // Upload as reel (clip)
    const publishResult = await ig.publish.video({
      video: videoBuffer,
      coverImage: videoBuffer, // instagram-private-api extracts frame automatically
      caption: caption,
    });

    // Save updated session
    let newSession = "";
    try {
      const updated = await ig.state.serialize();
      delete updated.constants;
      newSession = JSON.stringify(updated);
    } catch {}

    return {
      success: true,
      mediaId: publishResult.media?.pk?.toString() || publishResult.media?.id || "",
      sessionData: newSession,
    };
  } catch (e) {
    const msg = e.message?.toLowerCase() || "";

    if (msg.includes("login_required") || msg.includes("not authorized") || msg.includes("checkpoint")) {
      return { success: false, error: "Session expired — please reconnect account" };
    }
    if (msg.includes("feedback") || msg.includes("spam") || msg.includes("action_blocked")) {
      return { success: false, error: "Instagram blocked this action — wait 30 minutes and retry" };
    }
    if (msg.includes("transcode") || msg.includes("video") || msg.includes("upload")) {
      return { success: false, error: `Video upload failed: ${e.message}` };
    }
    return { success: false, error: e.message || "Post failed" };
  }
}

// ── DOWNLOAD PIPELINE ─────────────────────────────────────────────────────────
async function downloadFile(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const response = await axios({ url, method: "GET", responseType: "stream", timeout: 120000,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

async function downloadVideo(videoId, videoUrl) {
  try {
    await Video.findByIdAndUpdate(videoId, { status: "downloading" });
    const dir = path.join(__dirname, "downloads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const localPath = path.join(dir, `${videoId}.mp4`);

    let downloadUrl = videoUrl;
    try {
      const apiRes = await axios.get(`https://tikwm.com/api/?url=${encodeURIComponent(videoUrl)}&hd=1`,
        { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0" } });
      if (apiRes.data?.data?.play) downloadUrl = apiRes.data.data.play;
      else if (apiRes.data?.data?.hdplay) downloadUrl = apiRes.data.data.hdplay;
    } catch {}

    await downloadFile(downloadUrl, localPath);

    let cloudinaryUrl = "";
    try {
      const upload = await cloudinary.uploader.upload(localPath, {
        resource_type: "video", folder: "reelflow",
        public_id: `video_${videoId}`, overwrite: true,
      });
      cloudinaryUrl = upload.secure_url;
    } catch (ce) { console.error("Cloudinary upload error:", ce.message); }

    await Video.findByIdAndUpdate(videoId, {
      status: "downloaded", localPath, cloudinaryUrl,
      downloadedAt: new Date(), error: "",
    });
  } catch (e) {
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: e.message });
    console.error(`Download failed for ${videoId}:`, e.message);
  }
}

// ── CAPTION BUILDER ───────────────────────────────────────────────────────────
function buildCaption(video, account) {
  let caption = video.caption || "";
  if (account.hashtags?.trim()) {
    caption = caption ? `${caption}\n\n${account.hashtags.trim()}` : account.hashtags.trim();
  }
  return caption;
}

// ── POST TO INSTAGRAM (orchestrator) ─────────────────────────────────────────
async function postToInstagram(videoId) {
  const video = await Video.findById(videoId).populate("accountId");
  if (!video?.accountId) return;
  const account = video.accountId;

  if (!account.sessionData) {
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: "No session — please reconnect account" });
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
    const result = await igPost(account.sessionData, videoPath, caption, getProxy(account), account._id.toString());

    if (!result.success) throw new Error(result.error);

    if (result.sessionData) {
      await Account.findByIdAndUpdate(account._id, { sessionData: result.sessionData, sessionSavedAt: new Date() });
    }

    const updatedAccount = await Account.findByIdAndUpdate(
      account._id, { $inc: { totalPosted: 1 }, lastPostedAt: new Date(), status: "active" }, { new: true }
    );

    await Video.findByIdAndUpdate(videoId, { status: "posted", postedAt: new Date(), igPostId: result.mediaId || "", error: "" });
    await User.findByIdAndUpdate(account.userId, { $inc: { videosPublished: 1 } });
    if (video.workflowId) await Workflow.findByIdAndUpdate(video.workflowId, { $inc: { videosProcessed: 1 } });
    await logActivity(account.userId, account._id, account.username, "posted", `✅ Posted reel to @${account.username}`);
    console.log(`🎉 Posted to @${account.username}`);

    notifyUser(account.userId, "posted", {
      username: account.username, igPostId: result.mediaId || "",
      totalPosted: updatedAccount?.totalPosted || account.totalPosted + 1, caption,
    });

    if (account.autoRequeue) {
      await Video.findByIdAndUpdate(videoId, { status: "downloaded", postedAt: null, igPostId: null });
    }
    if (videoPath.includes("post_")) fs.unlink(videoPath, () => {});

  } catch (e) {
    const v2 = await Video.findById(videoId);
    const isSessionError = e.message.includes("login") || e.message.includes("session") || e.message.includes("reconnect");
    if (v2 && v2.retryCount < 2 && !isSessionError) {
      await Video.findByIdAndUpdate(videoId, { status: "downloaded", $inc: { retryCount: 1 } });
      setTimeout(() => postToInstagram(videoId), 120000);
      return;
    }
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: e.message });
    if (isSessionError) await Account.findByIdAndUpdate(account._id, { status: "error" });
    await logActivity(account.userId, account._id, account.username, "failed", `❌ Post failed @${account.username}: ${e.message}`);
    console.error(`❌ Post failed @${account.username}: ${e.message}`);
    notifyUser(account.userId, "failed", { username: account.username, error: e.message });
  }
}

// ── ANALYTICS ─────────────────────────────────────────────────────────────────
app.get("/api/analytics", auth, async (req, res) => {
  try {
    const accounts = await Account.find({ userId: req.user.id });
    const accountIds = accounts.map(a => a._id);
    const now = new Date();
    const day7 = new Date(now - 7 * 86400000);
    const day30 = new Date(now - 30 * 86400000);
    const [posted7, posted30, failed7, totalPosted, queueSize] = await Promise.all([
      Video.countDocuments({ accountId: { $in: accountIds }, status: "posted", postedAt: { $gte: day7 } }),
      Video.countDocuments({ accountId: { $in: accountIds }, status: "posted", postedAt: { $gte: day30 } }),
      Video.countDocuments({ accountId: { $in: accountIds }, status: "failed", createdAt: { $gte: day7 } }),
      Video.countDocuments({ accountId: { $in: accountIds }, status: "posted" }),
      Video.countDocuments({ accountId: { $in: accountIds }, status: { $in: ["queued", "downloaded"] } }),
    ]);
    const daily = [];
    for (let i = 6; i >= 0; i--) {
      const start = new Date(now); start.setDate(start.getDate() - i); start.setHours(0,0,0,0);
      const end = new Date(start); end.setHours(23,59,59,999);
      const count = await Video.countDocuments({ accountId: { $in: accountIds }, status: "posted", postedAt: { $gte: start, $lte: end } });
      daily.push({ date: start.toISOString().slice(0,10), count });
    }
    const accountStats = await Promise.all(accounts.map(async (acc) => ({
      username: acc.username, status: acc.status, totalPosted: acc.totalPosted || 0,
      postsPerDay: acc.postsPerDay, lastPostedAt: acc.lastPostedAt,
      queueSize: await Video.countDocuments({ accountId: acc._id, status: { $in: ["queued", "downloaded"] } }),
    })));
    res.json({ posted7, posted30, failed7, totalPosted, queueSize, daily, accountStats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SCRAPER ROUTES ────────────────────────────────────────────────────────────
app.get("/api/scrapers", auth, async (req, res) => {
  try {
    const scrapers = await Scraper.find({ userId: req.user.id }).populate("accountId", "username");
    res.json(scrapers);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/scrapers", auth, async (req, res) => {
  try {
    const { type, query, accountId, interval, maxPerRun, skipDuplicates } = req.body;
    if (!query || !accountId) return res.status(400).json({ error: "Query and account required" });
    const acc = await Account.findOne({ _id: accountId, userId: req.user.id });
    if (!acc) return res.status(404).json({ error: "Account not found" });
    const scraper = await Scraper.create({
      userId: req.user.id, accountId, type: type || "username", query: query.replace(/^[@#]/, ""),
      interval: interval || 60, maxPerRun: maxPerRun || 5,
      skipDuplicates: skipDuplicates !== false, status: "active", nextRun: new Date(),
    });
    res.json(scraper);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/scrapers/:id/toggle", auth, async (req, res) => {
  try {
    const s = await Scraper.findOne({ _id: req.params.id, userId: req.user.id });
    if (!s) return res.status(404).json({ error: "Not found" });
    s.status = s.status === "active" ? "paused" : "active";
    if (s.status === "active") s.nextRun = new Date();
    await s.save();
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/scrapers/:id/run", auth, async (req, res) => {
  try {
    const s = await Scraper.findOne({ _id: req.params.id, userId: req.user.id });
    if (!s) return res.status(404).json({ error: "Not found" });
    runScraper(s._id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/scrapers/:id", auth, async (req, res) => {
  try {
    await Scraper.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI CAPTION ────────────────────────────────────────────────────────────────
app.post("/api/caption/generate", auth, async (req, res) => {
  try {
    const { niche, style } = req.body;
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return res.status(400).json({ error: "GROQ_API_KEY not set" });
    const prompt = `Write a short Instagram Reels caption for a ${niche || "general"} page. Style: ${style || "engaging"}. Include 3-5 relevant hashtags at the end. Max 150 chars before hashtags. Return only the caption, nothing else.`;
    const groqRes = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama3-8b-8192",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200, temperature: 0.8,
    }, { headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" }, timeout: 15000 });
    const caption = groqRes.data.choices?.[0]?.message?.content?.trim() || "";
    res.json({ caption });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SMART SCHEDULE & SHADOWBAN ROUTES ───────────────────────────────────────
app.get("/api/accounts/:id/smart-schedule", auth, async (req, res) => {
  try {
    const acc = await Account.findOne({ _id: req.params.id, userId: req.user.id });
    if (!acc) return res.status(404).json({ error: "Not found" });
    // Niche-based optimal posting times
    const nicheSchedules = {
      "Motivation":  ["06:00","08:00","12:00","18:00","21:00"],
      "Fitness":     ["06:00","07:00","12:00","17:00","20:00"],
      "Crypto":      ["08:00","12:00","16:00","20:00","22:00"],
      "Anime":       ["12:00","15:00","18:00","20:00","22:00"],
      "Cars":        ["09:00","12:00","17:00","19:00","21:00"],
      "Luxury":      ["10:00","13:00","17:00","19:00","21:00"],
      "General":     ["09:00","12:00","15:00","18:00","21:00"],
    };
    const times = nicheSchedules[acc.niche] || nicheSchedules["General"];
    res.json({ niche: acc.niche, suggestedTimes: times.slice(0, acc.postsPerDay) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/accounts/:id/apply-smart-schedule", auth, async (req, res) => {
  try {
    const acc = await Account.findOne({ _id: req.params.id, userId: req.user.id });
    if (!acc) return res.status(404).json({ error: "Not found" });
    const nicheSchedules = {
      "Motivation":  ["06:00","08:00","12:00","18:00","21:00"],
      "Fitness":     ["06:00","07:00","12:00","17:00","20:00"],
      "Crypto":      ["08:00","12:00","16:00","20:00","22:00"],
      "Anime":       ["12:00","15:00","18:00","20:00","22:00"],
      "Cars":        ["09:00","12:00","17:00","19:00","21:00"],
      "Luxury":      ["10:00","13:00","17:00","19:00","21:00"],
      "General":     ["09:00","12:00","15:00","18:00","21:00"],
    };
    const times = (nicheSchedules[acc.niche] || nicheSchedules["General"]).slice(0, acc.postsPerDay);
    await Account.findByIdAndUpdate(acc._id, { postingTimes: times });
    res.json({ success: true, postingTimes: times });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-video AI caption
app.post("/api/videos/:id/ai-caption", auth, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.user.id }).populate("accountId");
    if (!video) return res.status(404).json({ error: "Not found" });
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return res.status(400).json({ error: "GROQ_API_KEY not set" });
    const niche = video.accountId?.niche || "general";
    const prompt = `Write a short viral Instagram Reels caption for a ${niche} page. Max 100 chars. Include 3-5 hashtags. Return only the caption.`;
    const groqRes = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama3-8b-8192",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150, temperature: 0.9,
    }, { headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" }, timeout: 15000 });
    const caption = groqRes.data.choices?.[0]?.message?.content?.trim() || "";
    await Video.findByIdAndUpdate(video._id, { caption });
    res.json({ caption });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Plan management
app.get("/api/me/plan", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("plan trialEndsAt createdAt email");
    res.json({ plan: user?.plan || "free", trialEndsAt: user?.trialEndsAt, email: user?.email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// ── AUTO-RECONNECT HELPER ─────────────────────────────────────────────────────
const crypto = require("crypto");
const RECON_SECRET = (process.env.JWT_SECRET || "reelflow").slice(0, 32).padEnd(32, "0");

function encryptPassword(plain) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(RECON_SECRET), iv);
  return iv.toString("hex") + ":" + Buffer.concat([cipher.update(plain), cipher.final()]).toString("hex");
}

function decryptPassword(enc) {
  try {
    const [ivHex, dataHex] = enc.split(":");
    const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(RECON_SECRET), Buffer.from(ivHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString();
  } catch { return null; }
}

async function tryAutoReconnect(acc) {
  if (!acc.encryptedPassword) return false;
  const plain = decryptPassword(acc.encryptedPassword);
  if (!plain) return false;
  console.log(`🔄 Auto-reconnecting @${acc.username}...`);
  try {
    const proxy = getProxy(acc);
    const result = await igLogin(acc.username, plain, proxy, acc._id.toString());
    if (result.success && result.sessionData) {
      await Account.findByIdAndUpdate(acc._id, {
        sessionData: result.sessionData,
        sessionSavedAt: new Date(),
        status: "active",
      });
      await logActivity(acc.userId, acc._id, acc.username, "reconnected", `🔄 @${acc.username} auto-reconnected successfully`);
      await notifyUser(acc.userId, "reconnected", { username: acc.username });
      console.log(`✅ Auto-reconnected @${acc.username}`);
      return true;
    }
    // Needs phone approval — can't auto-approve, notify user
    return false;
  } catch (e) {
    console.error(`Auto-reconnect failed for @${acc.username}:`, e.message);
    return false;
  }
}

// Session health check every 2 hours — tries auto-reconnect, falls back to Telegram alert
cron.schedule("0 */2 * * *", async () => {
  try {
    const accounts = await Account.find({ status: "active" });
    for (const acc of accounts) {
      const healthy = await checkSessionHealth(acc._id);
      if (!healthy) {
        console.log(`⚠️ Session dead: @${acc.username} — attempting auto-reconnect`);
        const reconnected = await tryAutoReconnect(acc);
        if (!reconnected) {
          await Account.findByIdAndUpdate(acc._id, { status: "error" });
          await logActivity(acc.userId, acc._id, acc.username, "session_error", `⚠️ Session expired for @${acc.username} — reconnect needed`);
          // Telegram notification with instructions
          const user = await User.findById(acc.userId).select("telegramBotToken telegramChatId");
          if (user?.telegramBotToken && user?.telegramChatId) {
            const msg = `⚠️ *ReelFlow Alert*\n\n@${acc.username} session expired and auto-reconnect failed.\n\n👉 Go to Accounts → tap *Reconnect* on @${acc.username} → enter password → approve on phone.\n\nPosting is paused for this account until reconnected.`;
            await sendTelegram(user.telegramBotToken, user.telegramChatId, msg);
          }
          console.log(`❌ Auto-reconnect failed for @${acc.username} — user notified`);
        }
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
