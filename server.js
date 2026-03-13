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
  origin: ["https://t2g.pages.dev","https://reelflow.pages.dev","http://localhost:5173","http://localhost:3000",process.env.FRONTEND_URL].filter(Boolean),
  credentials: true,
}));

mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 45000 })
  .then(async () => {
    console.log("✅ MongoDB connected");
    await User.updateOne({ email: "v1amp@proton.me" }, { $set: { role: "admin" } });
    console.log("✅ Admin role ensured for v1amp@proton.me");
  })
  .catch(e => console.error("❌ DB Error:", e.message));

const User = mongoose.model("User", new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, unique: true, lowercase: true, trim: true },
  password: String,
  role: { type: String, default: "user" },
  plan: { type: String, default: "free" },
  videosPublished: { type: Number, default: 0 },
  trialEndsAt: { type: Date, default: () => new Date(Date.now() + 14 * 86400000) },
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
  postingTimes: { type: [String], default: ["09:00","12:00","15:00","18:00","21:00"] },
  captionStyle: { type: String, default: "original", enum: ["original","custom","none"] },
  customCaption: { type: String, default: "" },
  appendHashtags: { type: Boolean, default: true },
  hashtags: { type: String, default: "" },
  autoRequeue: { type: Boolean, default: false },
  status: { type: String, default: "active", enum: ["active","paused","error","shadowbanned"] },
  proxyUrl: { type: String, default: "" },
  proxyMode: { type: String, default: "rotate", enum: ["none","fixed","rotate"] },
  warmupEnabled: { type: Boolean, default: true },
  warmupDay: { type: Number, default: 0 },
  warmupComplete: { type: Boolean, default: false },
  useSmartSchedule: { type: Boolean, default: true },
  randomTimes: { type: Boolean, default: false },
  shadowbanScore: { type: Number, default: 0 },
  shadowbanCheckedAt: Date,
  avgLikesPerPost: { type: Number, default: 0 },
  totalPosted: { type: Number, default: 0 },
  lastPostedAt: Date,
  // ── Profile cache ──
  fullName: { type: String, default: "" },
  bio: { type: String, default: "" },
  followers: { type: Number, default: 0 },
  following: { type: Number, default: 0 },
  profileCachedAt: Date,
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
  status: { type: String, enum: ["queued","downloading","downloaded","scheduled","posting","posted","failed"], default: "queued", index: true },
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
  type: { type: String, enum: ["username","hashtag"], default: "username" },
  query: { type: String, required: true },
  interval: { type: Number, default: 60 },
  maxPerRun: { type: Number, default: 5 },
  skipDuplicates: { type: Boolean, default: true },
  status: { type: String, default: "active", enum: ["active","paused"] },
  totalScraped: { type: Number, default: 0 },
  lastRun: Date,
  nextRun: Date,
  createdAt: { type: Date, default: Date.now },
}));

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Invalid or expired token" }); }
};

const isValidUrl = (str) => { try { new URL(str); return true; } catch { return false; } };

async function logActivity(userId, accountId, accountUsername, action, message) {
  try { await ActivityLog.create({ userId, accountId, accountUsername, action, message }); } catch {}
}

async function sendTelegram(botToken, chatId, message) {
  if (!botToken || !chatId) return;
  try { await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text: message, parse_mode: "HTML", disable_web_page_preview: false }, { timeout: 10000 }); }
  catch (e) { console.error("Telegram send error:", e.message); }
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
      const igUrl = data.igPostId ? `https://www.instagram.com/p/${data.igPostId}/` : `https://www.instagram.com/${data.username}/`;
      message = `✅ <b>Reel Posted!</b>\n\n👤 @${data.username}\n🕐 ${timeStr} — ${dateStr}\n🎬 Total: ${data.totalPosted}\n${data.caption ? `📝 ${data.caption.slice(0,80)}...\n` : ""}\n🔗 <a href="${igUrl}">View on Instagram</a>`;
    } else if (event === "failed" && user.notifyOnError) {
      message = `❌ <b>Post Failed</b>\n\n👤 @${data.username}\n🕐 ${timeStr} — ${dateStr}\n⚠️ <code>${(data.error||"Unknown").slice(0,200)}</code>`;
    } else if (event === "connected" && user.notifyOnConnect) {
      message = `🔗 <b>Account Connected!</b>\n\n👤 @${data.username}\n🕐 ${timeStr} — ${dateStr}\n🎯 Niche: ${data.niche||"General"}\n📅 Posts/Day: ${data.postsPerDay||5}`;
    } else if (event === "test") {
      message = `🤖 <b>ReelFlow Notifications Active!</b>\n\n✅ Telegram connected.\n🕐 ${timeStr} — ${dateStr}`;
    }
    if (message) await sendTelegram(user.telegramBotToken, user.telegramChatId, message);
  } catch (e) { console.error("notifyUser error:", e.message); }
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
    if (!user || !await bcrypt.compare(password, user.password)) return res.status(400).json({ error: "Invalid email or password" });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, plan: user.plan, role: user.role, trialEndsAt: user.trialEndsAt } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/me", auth, async (req, res) => {
  try { const user = await User.findById(req.user.id).select("-password"); if (!user) return res.status(404).json({ error: "User not found" }); res.json(user); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/me", auth, async (req, res) => {
  try {
    await Video.deleteMany({ userId: req.user.id }); await Account.deleteMany({ userId: req.user.id });
    await Workflow.deleteMany({ userId: req.user.id }); await ActivityLog.deleteMany({ userId: req.user.id });
    await User.findByIdAndDelete(req.user.id); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/me/plan", auth, async (req, res) => {
  try { const user = await User.findById(req.user.id).select("plan trialEndsAt email"); res.json({ plan: user?.plan || "free", trialEndsAt: user?.trialEndsAt, email: user?.email }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/me/notifications", auth, async (req, res) => {
  try {
    const { telegramBotToken, telegramChatId, notifyOnPost, notifyOnError, notifyOnConnect } = req.body;
    const user = await User.findByIdAndUpdate(req.user.id, { telegramBotToken, telegramChatId, notifyOnPost, notifyOnError, notifyOnConnect: notifyOnConnect !== false }, { new: true }).select("-password");
    res.json({ success: true, user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/me/test-telegram", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user?.telegramBotToken || !user?.telegramChatId) return res.status(400).json({ error: "Please save your Bot Token and Chat ID first" });
    await notifyUser(req.user.id, "test"); res.json({ success: true, message: "Test message sent!" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/instagram/verify", auth, async (req, res) => {
  const { username, password } = req.body;
  try {
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    const result = await playwrightLogin(username, password);
    if (result.success) res.json({ success: true, userId: result.userId, username: result.username });
    else res.status(400).json({ success: false, error: result.error });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── PROXY POOL ────────────────────────────────────────────────────────────────
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
  proxies: [...DEFAULT_PROXIES, ...(process.env.PROXY_LIST || "").split("\n").map(p => p.trim()).filter(Boolean)],
  index: 0,
  next() { if (!this.proxies.length) return ""; const p = this.proxies[this.index % this.proxies.length]; this.index++; return p; },
  add(p) { if (!this.proxies.includes(p)) this.proxies.push(p); },
  remove(p) { this.proxies = this.proxies.filter(x => x !== p); },
};

function getProxy(account) {
  if (!account) return proxyPool.next();
  const mode = account.proxyMode || "rotate";
  if (mode === "none") return "";
  if (mode === "fixed") return account.proxyUrl || "";
  return account.proxyUrl || proxyPool.next();
}

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
  proxyPool.remove(req.body.proxyUrl);
  res.json({ success: true, count: proxyPool.proxies.length });
});

app.post("/api/accounts/:id/proxy", auth, async (req, res) => {
  try {
    const acc = await Account.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, { proxyUrl: req.body.proxyUrl || "" }, { new: true });
    if (!acc) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, proxyUrl: acc.proxyUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/proxy/test", auth, async (req, res) => {
  const { proxyUrl } = req.body;
  if (!proxyUrl) return res.status(400).json({ error: "proxyUrl required" });
  try {
    const { HttpsProxyAgent } = require("https-proxy-agent");
    const agent = new HttpsProxyAgent(proxyUrl);
    const start = Date.now();
    const ipRes = await axios.get("https://api.ipify.org?format=json", { httpsAgent: agent, proxy: false, timeout: 10000 });
    let igReachable = false;
    try { await axios.get("https://www.instagram.com/", { httpsAgent: agent, proxy: false, timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } }); igReachable = true; } catch {}
    res.json({ success: true, ip: ipRes.data.ip, igReachable, ms: Date.now() - start });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

app.get("/api/proxy/test-all", auth, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  const results = await Promise.all(proxyPool.proxies.map(async (proxyUrl) => {
    try {
      const { HttpsProxyAgent } = require("https-proxy-agent");
      const agent = new HttpsProxyAgent(proxyUrl);
      const start = Date.now();
      const ipRes = await axios.get("https://api.ipify.org?format=json", { httpsAgent: agent, proxy: false, timeout: 8000 });
      return { proxyUrl, status: "alive", ip: ipRes.data.ip, ms: Date.now() - start };
    } catch (e) { return { proxyUrl, status: "dead", ip: null, ms: null, error: e.message }; }
  }));
  res.json(results);
});

// ── PLAYWRIGHT BROWSER ENGINE ─────────────────────────────────────────────────
const { chromium } = require("playwright");

// One browser instance per account, keyed by accountId
const browserSessions = new Map();

async function getBrowser(accountId) {
  if (browserSessions.has(accountId)) {
    const s = browserSessions.get(accountId);
    try { await s.page.evaluate(() => document.title); return s; } catch {}
    browserSessions.delete(accountId);
  }
  return null;
}

async function launchBrowser(accountId, sessionData = null) {
  // Kill existing
  const old = browserSessions.get(accountId);
  if (old) { try { await old.browser.close(); } catch {} browserSessions.delete(accountId); }

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,800",
    ],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/New_York",
    storageState: sessionData ? JSON.parse(sessionData) : undefined,
  });

  // Stealth patches
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  const session = { browser, context, page, accountId, createdAt: Date.now() };
  browserSessions.set(accountId, session);
  return session;
}

async function humanDelay(min = 800, max = 2000) {
  const ms = Math.floor(Math.random() * (max - min)) + min;
  await new Promise(r => setTimeout(r, ms));
}

async function humanType(page, selector, text) {
  await page.click(selector);
  await humanDelay(200, 500);
  for (const char of text) {
    await page.keyboard.type(char, { delay: Math.floor(Math.random() * 80) + 30 });
  }
}

// ── PLAYWRIGHT LOGIN ───────────────────────────────────────────────────────────
const pendingAuthorizations = new Map();

async function playwrightLogin(username, password, accountId = "") {
  const cleanUser = username.replace("@", "").toLowerCase().trim();
  console.log(`🌐 Playwright login @${cleanUser}`);

  let session;
  try {
    session = await launchBrowser(accountId || cleanUser);
    const { page } = session;

    await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await humanDelay(2000, 4000);

    // Dismiss cookie banner if present
    try {
      const cookieBtn = await page.waitForSelector('button:has-text("Allow all cookies")', { timeout: 4000 });
      await cookieBtn.click();
      await humanDelay(1000, 2000);
    } catch {}

    // Fill username
    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await humanType(page, 'input[name="username"]', cleanUser);
    await humanDelay(400, 900);

    // Fill password
    await humanType(page, 'input[name="password"]', password);
    await humanDelay(500, 1200);

    // Click login
    await page.click('button[type="submit"]');
    await humanDelay(3000, 5000);

    // Check what happened
    const url = page.url();

    // Wrong password
    if (await page.$('text="Sorry, your password was incorrect"') ||
        await page.$('text="The password you entered is incorrect"')) {
      await session.browser.close();
      browserSessions.delete(accountId || cleanUser);
      return { success: false, error: "Wrong password — please check and try again" };
    }

    // Account not found
    if (await page.$('text="The username you entered"') ||
        await page.$('text="Find your account"')) {
      await session.browser.close();
      browserSessions.delete(accountId || cleanUser);
      return { success: false, error: "Account not found — check the username" };
    }

    // 2FA / challenge
    if (url.includes("/challenge") || url.includes("/two_factor") ||
        await page.$('input[name="verificationCode"]') ||
        await page.$('input[name="security_code"]')) {
      // Save temp session state
      const storageState = await session.context.storageState();
      return { pending: true, tempSession: JSON.stringify(storageState) };
    }

    // Suspicious login popup
    if (await page.$('text="Was It You?"') || await page.$('text="Unusual Login Attempt"')) {
      try {
        const confirmBtn = await page.$('button:has-text("This Was Me")');
        if (confirmBtn) { await confirmBtn.click(); await humanDelay(2000, 3000); }
      } catch {}
    }

    // Save info / not now popups
    try {
      const notNow = await page.waitForSelector('button:has-text("Not Now")', { timeout: 5000 });
      await notNow.click(); await humanDelay(1000, 2000);
    } catch {}
    try {
      const notNow2 = await page.waitForSelector('button:has-text("Not now")', { timeout: 3000 });
      await notNow2.click(); await humanDelay(1000, 2000);
    } catch {}

    // Verify we're logged in
    await page.waitForURL(/instagram\.com\/(accounts\/onetap|$|\?|\/direct)/, { timeout: 15000 }).catch(() => {});
    const finalUrl = page.url();

    if (finalUrl.includes("instagram.com") && !finalUrl.includes("/accounts/login")) {
      // Get cookies + storage state as our "session"
      const storageState = await session.context.storageState();
      const cookies = storageState.cookies || [];
      const sessionCookie = cookies.find(c => c.name === "sessionid");
      const userId = cookies.find(c => c.name === "ds_user_id")?.value || "";

      if (!sessionCookie) {
        return { success: false, error: "Login appeared to succeed but no session cookie found. Try again." };
      }

      return {
        success: true,
        userId,
        username: cleanUser,
        sessionData: JSON.stringify(storageState),
      };
    }

    return { success: false, error: "Login failed — Instagram may be blocking this. Try again in a few minutes." };

  } catch (e) {
    console.error(`❌ Playwright login error @${cleanUser}:`, e.message);
    if (session) { try { await session.browser.close(); } catch {} browserSessions.delete(accountId || cleanUser); }
    return { success: false, error: `Browser error: ${e.message}` };
  }
}

async function playwrightVerify2FA(accountId, code, tempSession) {
  const cleanId = accountId.toString();
  console.log(`🔑 2FA verify for ${cleanId}`);

  let session = await getBrowser(cleanId);
  if (!session) {
    // Relaunch with saved state
    session = await launchBrowser(cleanId, tempSession);
    await session.page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded", timeout: 20000 });
    await humanDelay(2000, 3000);
  }

  const { page } = session;
  try {
    const codeInput = await page.waitForSelector('input[name="verificationCode"], input[name="security_code"]', { timeout: 10000 });
    await codeInput.fill("");
    await humanType(page, 'input[name="verificationCode"], input[name="security_code"]', code);
    await humanDelay(500, 1000);
    await page.keyboard.press("Enter");
    await humanDelay(3000, 5000);

    // Handle popups
    try { const n = await page.$('button:has-text("Not Now")'); if (n) { await n.click(); await humanDelay(1000, 2000); } } catch {}
    try { const n = await page.$('button:has-text("Not now")'); if (n) { await n.click(); await humanDelay(1000, 2000); } } catch {}

    const finalUrl = page.url();
    if (finalUrl.includes("instagram.com") && !finalUrl.includes("/challenge") && !finalUrl.includes("/two_factor")) {
      const storageState = await session.context.storageState();
      const cookies = storageState.cookies || [];
      const sessionCookie = cookies.find(c => c.name === "sessionid");
      const userId = cookies.find(c => c.name === "ds_user_id")?.value || "";
      if (sessionCookie) {
        return { success: true, userId, sessionData: JSON.stringify(storageState) };
      }
    }
    return { success: false, error: "Invalid code or verification failed" };
  } catch (e) {
    return { success: false, error: `2FA error: ${e.message}` };
  }
}

// ── POST TO INSTAGRAM (Playwright) ────────────────────────────────────────────
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
    const result = await postViaPlaywright(account._id.toString(), account.sessionData, videoPath, caption);
    if (!result.success) throw new Error(result.error);
    if (result.sessionData) await Account.findByIdAndUpdate(account._id, { sessionData: result.sessionData, sessionSavedAt: new Date() });
    const updatedAccount = await Account.findByIdAndUpdate(account._id, { $inc: { totalPosted: 1 }, lastPostedAt: new Date(), status: "active" }, { new: true });
    await Video.findByIdAndUpdate(videoId, { status: "posted", postedAt: new Date(), igPostId: result.mediaId || "", error: "" });
    await User.findByIdAndUpdate(account.userId, { $inc: { videosPublished: 1 } });
    if (video.workflowId) await Workflow.findByIdAndUpdate(video.workflowId, { $inc: { videosProcessed: 1 } });
    await logActivity(account.userId, account._id, account.username, "posted", `✅ Posted reel to @${account.username}`);
    console.log(`🎉 Posted to @${account.username}`);
    notifyUser(account.userId, "posted", { username: account.username, igPostId: result.mediaId || "", totalPosted: updatedAccount?.totalPosted || account.totalPosted + 1, caption });
    if (account.autoRequeue) await Video.findByIdAndUpdate(videoId, { status: "downloaded", postedAt: null, igPostId: null });
    if (videoPath.includes("post_")) fs.unlink(videoPath, () => {});
  } catch (e) {
    const v2 = await Video.findById(videoId);
    const isSessionError = e.message.includes("session") || e.message.includes("login") || e.message.includes("reconnect");
    if (v2 && v2.retryCount < 2 && !isSessionError) {
      await Video.findByIdAndUpdate(videoId, { status: "downloaded", $inc: { retryCount: 1 } });
      setTimeout(() => postToInstagram(videoId), 120000);
      return;
    }
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: e.message });
    if (isSessionError) await Account.findByIdAndUpdate(account._id, { status: "error" });
    await logActivity(account.userId, account._id, account.username, "failed", `❌ Post failed @${account.username}: ${e.message}`);
    notifyUser(account.userId, "failed", { username: account.username, error: e.message });
  }
}

async function postViaPlaywright(accountId, sessionData, videoPath, caption) {
  console.log(`📤 Playwright posting for account ${accountId}`);
  let session;
  try {
    session = await launchBrowser(accountId, sessionData);
    const { page, context } = session;

    // Go to Instagram
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await humanDelay(2000, 3000);

    // Check if still logged in
    const url = page.url();
    if (url.includes("/accounts/login")) {
      await session.browser.close();
      browserSessions.delete(accountId);
      return { success: false, error: "Session expired — please reconnect your account" };
    }

    // Click the Create/+ button
    let createBtn = await page.$('svg[aria-label="New post"]');
    if (!createBtn) createBtn = await page.$('[aria-label="New post"]');
    if (!createBtn) {
      // Try finding via nav
      const navLinks = await page.$$('a[href="/create/style/"]');
      if (navLinks.length) createBtn = navLinks[0];
    }
    if (!createBtn) {
      // Click the + icon in nav
      await page.click('a[href*="create"]');
    } else {
      await createBtn.click();
    }
    await humanDelay(1500, 2500);

    // Select "Post" from menu if shown
    try {
      const postOpt = await page.waitForSelector('button:has-text("Post"), span:has-text("Post")', { timeout: 5000 });
      await postOpt.click();
      await humanDelay(1000, 2000);
    } catch {}

    // Upload file
    const [fileChooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 15000 }),
      page.click('button:has-text("Select from computer"), input[type="file"]').catch(async () => {
        // Try clicking the upload area
        await page.click('[role="button"]:has-text("Select"), .x1n2onr6 button').catch(() => {});
      }),
    ]);
    await fileChooser.setFiles(videoPath);
    await humanDelay(3000, 5000);

    // Handle "OK" / crop dialog
    try {
      const okBtn = await page.waitForSelector('button:has-text("OK")', { timeout: 8000 });
      await okBtn.click(); await humanDelay(1500, 2500);
    } catch {}

    // Click Next (may need multiple times through crop/filter steps)
    for (let i = 0; i < 3; i++) {
      try {
        const nextBtn = await page.waitForSelector('button:has-text("Next"), div[role="button"]:has-text("Next")', { timeout: 8000 });
        await nextBtn.click(); await humanDelay(1500, 2500);
      } catch { break; }
    }

    // Add caption
    try {
      const captionBox = await page.waitForSelector('[aria-label="Write a caption..."], textarea[aria-label*="caption"]', { timeout: 10000 });
      await captionBox.click();
      await humanDelay(300, 600);
      // Type caption in chunks to avoid issues
      for (const chunk of caption.match(/.{1,50}/g) || []) {
        await page.keyboard.type(chunk, { delay: 20 });
        await humanDelay(100, 300);
      }
    } catch (e) { console.log("Caption field not found:", e.message); }

    await humanDelay(1000, 2000);

    // Click Share
    const shareBtn = await page.waitForSelector('button:has-text("Share"), div[role="button"]:has-text("Share")', { timeout: 10000 });
    await shareBtn.click();
    await humanDelay(5000, 10000);

    // Wait for success
    try {
      await page.waitForSelector('span:has-text("Your reel has been shared"), span:has-text("Post shared")', { timeout: 30000 });
    } catch {
      // Check URL changed (also means success)
      await humanDelay(3000, 5000);
    }

    // Save updated session
    const newState = await context.storageState();

    return { success: true, mediaId: "", sessionData: JSON.stringify(newState) };

  } catch (e) {
    console.error(`❌ Playwright post error:`, e.message);
    if (session) {
      try { await session.browser.close(); } catch {}
      browserSessions.delete(accountId);
    }
    return { success: false, error: e.message };
  }
}

async function checkSessionHealth(accountId) {
  const acc = await Account.findById(accountId);
  if (!acc?.sessionData) return false;
  try {
    const session = await launchBrowser(accountId.toString(), acc.sessionData);
    await session.page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 20000 });
    const url = session.page.url();
    const ok = url.includes("instagram.com") && !url.includes("/accounts/login");
    await session.browser.close();
    browserSessions.delete(accountId.toString());
    return ok;
  } catch { return false; }
}



// ── ACCOUNT ROUTES ────────────────────────────────────────────────────────────

app.get("/api/accounts/authorize-status/:sessionKey", auth, async (req, res) => {
  const { sessionKey } = req.params;
  const pending = pendingAuthorizations.get(sessionKey);
  if (!pending) return res.status(404).json({ error: "Session expired — please try again" });
  if (pending.userId !== req.user.id) return res.status(403).json({ error: "Unauthorized" });
  if (pending.done && pending.result) {
    const result = pending.result;
    pendingAuthorizations.delete(sessionKey);
    try {
      const { niche, postsPerDay, hashtags, captionStyle, customCaption, autoRequeue, postingTimes, proxyUrl, proxyMode } = pending.accountData;
      const acc = await Account.create({
        userId: req.user.id,
        username: (result.username || pending.username || "").replace("@","").toLowerCase().trim(),
        igUserId: result.userId || "",
        igPassword: pending.password ? await bcrypt.hash(pending.password,10) : "",
        sessionData: result.sessionData || "",
        sessionSavedAt: new Date(),
        niche: niche||"General", postsPerDay: postsPerDay||5,
        postingTimes: postingTimes||["09:00","12:00","15:00","18:00","21:00"],
        hashtags: hashtags||"", captionStyle: captionStyle||"original",
        customCaption: customCaption||"", autoRequeue: autoRequeue||false,
        status: "active", proxyUrl: proxyUrl||"", proxyMode: proxyMode||"rotate",
      });
      await logActivity(req.user.id, acc._id, acc.username, "account_connected", `@${acc.username} connected`);
      await notifyUser(req.user.id, "connected", { username: acc.username, niche: acc.niche });
      return res.json({ authorized: true, account: acc });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  return res.json({ pending: true, message: "Enter the 2FA code sent to your phone or email" });
});

app.post("/api/accounts/verify-code", auth, async (req, res) => {
  try {
    const { username, password, verificationCode, tempSession, sessionKey,
      niche, postsPerDay, hashtags, captionStyle, customCaption, autoRequeue, postingTimes, proxyUrl, proxyMode, reconnectId } = req.body;
    if (!verificationCode) return res.status(400).json({ error: "Verification code required" });
    const pending = sessionKey ? pendingAuthorizations.get(sessionKey) : null;
    const accountId = pending?.tempAccountId || reconnectId || username;
    const loginResult = await playwrightVerify2FA(accountId, verificationCode, tempSession || pending?.tempSession);
    if (!loginResult.success) return res.status(400).json({ error: loginResult.error || "Code was incorrect, please try again" });
    if (pending) {
      pending.done = true;
      pending.result = { ...loginResult, username: username };
      return res.json({ success: true, message: "Verified! Account connected." });
    }
    const cleanUser = (loginResult.username || username || "").replace("@","").toLowerCase().trim();
    if (reconnectId) {
      const existing = await Account.findOne({ _id: reconnectId, userId: req.user.id });
      if (existing) {
        await Account.findByIdAndUpdate(reconnectId, { sessionData: loginResult.sessionData||"", sessionSavedAt: new Date(), status: "active", igPassword: password ? await bcrypt.hash(password,10) : existing.igPassword });
        const updated = await Account.findById(reconnectId);
        return res.json({ success: true, account: { ...updated.toObject(), igPassword: "***", sessionData: undefined } });
      }
    }
    const acc = await Account.create({
      userId: req.user.id, username: cleanUser, igUserId: loginResult.userId||"",
      igPassword: password ? await bcrypt.hash(password,10) : "",
      sessionData: loginResult.sessionData||"", sessionSavedAt: new Date(),
      niche: niche||"General", postsPerDay: postsPerDay||5,
      postingTimes: postingTimes||["09:00","12:00","15:00","18:00","21:00"],
      hashtags: hashtags||"", captionStyle: captionStyle||"original",
      customCaption: customCaption||"", autoRequeue: autoRequeue||false, status: "active",
      proxyUrl: proxyUrl||"", proxyMode: proxyMode||"rotate",
    });
    await logActivity(req.user.id, acc._id, acc.username, "account_connected", `@${acc.username} connected via 2FA`);
    await notifyUser(req.user.id, "connected", { username: acc.username, niche: acc.niche });
    res.json({ success: true, account: { ...acc.toObject(), igPassword: "***", sessionData: undefined } });
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
    const { username, password, igPassword, niche, postsPerDay, hashtags, captionStyle, customCaption,
      appendHashtags, autoRequeue, postingTimes, proxyUrl, proxyMode, reconnectId } = req.body;
    const igPass = password || igPassword;
    if (!igPass) return res.status(400).json({ error: "Password required" });
    if (!username) return res.status(400).json({ error: "Instagram username required" });
    const loginResult = await playwrightLogin(username, igPass, reconnectId || username);
    if (loginResult.pending) {
      const sessionKey = `${req.user.id}:${username}:${Date.now()}`;
      pendingAuthorizations.set(sessionKey, {
        username, password: igPass, tempSession: loginResult.tempSession||"",
        tempAccountId: reconnectId || username,
        accountData: { niche, postsPerDay, hashtags, captionStyle, customCaption, autoRequeue, postingTimes, proxyUrl: proxyUrl||"", proxyMode: proxyMode||"rotate" },
        userId: req.user.id, createdAt: Date.now(), done: false, result: null,
      });
      setTimeout(() => pendingAuthorizations.delete(sessionKey), 300000);
      return res.json({ pending: true, sessionKey, tempSession: loginResult.tempSession, message: "2FA required — enter the code sent to your phone or email" });
    }
    if (!loginResult.success) return res.status(400).json({ error: loginResult.error || "Instagram login failed" });
    if (reconnectId) {
      const existing = await Account.findOne({ _id: reconnectId, userId: req.user.id });
      if (existing) {
        await Account.findByIdAndUpdate(reconnectId, {
          sessionData: loginResult.sessionData||"", sessionSavedAt: new Date(), status: "active",
          igPassword: igPass ? await bcrypt.hash(igPass,10) : existing.igPassword,
          proxyUrl: proxyUrl||existing.proxyUrl, proxyMode: proxyMode||existing.proxyMode,
        });
        const updated = await Account.findById(reconnectId);
        return res.json({ ...updated.toObject(), igPassword: "***", sessionData: undefined });
      }
    }
    const acc = await Account.create({
      userId: req.user.id,
      username: (loginResult.username || username || "").replace("@","").toLowerCase().trim(),
      igUserId: loginResult.userId||"",
      igPassword: igPass ? await bcrypt.hash(igPass,10) : "",
      sessionData: loginResult.sessionData||"", sessionSavedAt: new Date(),
      niche: niche||"General", postsPerDay: postsPerDay||5, hashtags: hashtags||"",
      captionStyle: captionStyle||"original", customCaption: customCaption||"",
      appendHashtags: appendHashtags!==false, autoRequeue: autoRequeue||false,
      postingTimes: postingTimes||["09:00","12:00","15:00","18:00","21:00"],
      proxyUrl: proxyUrl||"", proxyMode: proxyMode||"rotate",
    });
    await logActivity(req.user.id, acc._id, acc.username, "connected", `✅ @${acc.username} connected`);
    notifyUser(req.user.id, "connected", { username: acc.username, niche: acc.niche, postsPerDay: acc.postsPerDay });
    res.json({ ...acc.toObject(), igPassword: "***", sessionData: undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/accounts/:id", auth, async (req, res) => {
  try {
    const update = { ...req.body };
    if (!update.igPassword || update.igPassword === "***") delete update.igPassword;
    else update.igPassword = await bcrypt.hash(update.igPassword, 10);
    delete update.sessionData; delete update.sessionId;
    const acc = await Account.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, update, { new: true });
    if (!acc) return res.status(404).json({ error: "Account not found" });
    res.json({ ...acc.toObject(), igPassword: "***", sessionData: undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/accounts/:id", auth, async (req, res) => {
  try {
    const s = browserSessions.get(req.params.id);
    if (s) { try { await s.browser.close(); } catch {} browserSessions.delete(req.params.id); }
    await Account.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    await Video.deleteMany({ accountId: req.params.id, userId: req.user.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/accounts/:id/profile", auth, async (req, res) => {
  try {
    const acc = await Account.findOne({ _id: req.params.id, userId: req.user.id });
    if (!acc) return res.status(404).json({ error: "Account not found" });
    if (acc.profileCachedAt && (Date.now() - new Date(acc.profileCachedAt).getTime()) < 600000 && acc.profilePic) {
      return res.json({ success: true, username: acc.username, fullName: acc.fullName||"", bio: acc.bio||"", followers: acc.followers||0, following: acc.following||0, posts: acc.totalPosted||0, profilePic: acc.profilePic, isVerified: false });
    }
    if (!acc.sessionData) return res.status(400).json({ error: "No session — please reconnect account" });
    try {
      const session = await launchBrowser(acc._id.toString(), acc.sessionData);
      await session.page.goto(`https://www.instagram.com/${acc.username}/`, { waitUntil: "domcontentloaded", timeout: 20000 });
      await humanDelay(1500, 2500);
      const profileData = await session.page.evaluate(() => {
        const pic = document.querySelector('header img')?.src || "";
        const counts = document.querySelectorAll('ul li');
        const getNum = (t) => { if (!t) return 0; return parseInt(t.replace(/[^0-9]/g,""))||0; };
        return { profilePic: pic, followers: getNum(counts[1]?.querySelector('span')?.title || counts[1]?.textContent), following: getNum(counts[2]?.textContent) };
      });
      await session.browser.close(); browserSessions.delete(acc._id.toString());
      await Account.findByIdAndUpdate(acc._id, { profilePic: profileData.profilePic||acc.profilePic||"", followers: profileData.followers||acc.followers||0, following: profileData.following||acc.following||0, profileCachedAt: new Date() });
      return res.json({ success: true, username: acc.username, fullName: acc.fullName||"", bio: acc.bio||"", followers: profileData.followers||0, following: profileData.following||0, posts: acc.totalPosted||0, profilePic: profileData.profilePic||acc.profilePic||"", isVerified: false });
    } catch (e) {
      console.error("Profile fetch error:", e.message);
      return res.json({ success: true, username: acc.username, fullName: acc.fullName||"", bio: "", followers: acc.followers||0, following: acc.following||0, posts: acc.totalPosted||0, profilePic: acc.profilePic||"", isVerified: false });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/accounts/:id/toggle", auth, async (req, res) => {
  try {
    const acc = await Account.findOne({ _id: req.params.id, userId: req.user.id });
    if (!acc) return res.status(404).json({ error: "Not found" });
    const newStatus = acc.status === "active" ? "paused" : "active";
    await Account.findByIdAndUpdate(acc._id, { status: newStatus });
    res.json({ success: true, status: newStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/accounts/:id/randomize-times", auth, async (req, res) => {
  try {
    const acc = await Account.findOne({ _id: req.params.id, userId: req.user.id });
    if (!acc) return res.status(404).json({ error: "Not found" });
    const nicheSchedules = { "Fitness":["06:00","09:00","12:00","17:00","20:00"],"Fashion":["09:00","12:00","15:00","19:00","21:00"],"Food":["08:00","12:00","15:00","18:00","20:00"],"Travel":["07:00","10:00","14:00","18:00","21:00"],"Gaming":["12:00","15:00","18:00","20:00","22:00"],"Tech":["08:00","11:00","14:00","17:00","20:00"],"Finance":["07:00","09:00","12:00","16:00","19:00"],"Comedy":["10:00","13:00","16:00","19:00","22:00"],"Music":["10:00","13:00","16:00","19:00","22:00"],"Sports":["07:00","12:00","17:00","19:00","21:00"],"Beauty":["09:00","12:00","15:00","18:00","21:00"],"Cars":["09:00","12:00","17:00","19:00","21:00"],"Luxury":["10:00","13:00","17:00","19:00","21:00"],"General":["09:00","12:00","15:00","18:00","21:00"] };
    const times = (nicheSchedules[acc.niche]||nicheSchedules["General"]).slice(0, acc.postsPerDay);
    await Account.findByIdAndUpdate(acc._id, { postingTimes: times });
    res.json({ success: true, postingTimes: times });
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
      const res = await axios.get(`https://tikwm.com/api/user/posts?unique_id=${encodeURIComponent(scraper.query)}&count=${scraper.maxPerRun}&cursor=0`, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 });
      if (res.data.code === 0 && res.data.data?.videos) videoUrls = res.data.data.videos.map(v => `https://www.tiktok.com/@${scraper.query}/video/${v.video_id}`);
    } else {
      const res = await axios.get(`https://tikwm.com/api/feed/search?keywords=${encodeURIComponent(scraper.query)}&count=${scraper.maxPerRun}&cursor=0`, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 });
      if (res.data.code === 0 && res.data.data?.videos) videoUrls = res.data.data.videos.map(v => `https://www.tiktok.com/@${v.author?.unique_id}/video/${v.video_id}`);
    }
    if (!videoUrls.length) return;
    let toAdd = videoUrls;
    if (scraper.skipDuplicates) { const existing = (await Video.find({ accountId: scraper.accountId._id, videoUrl: { $in: videoUrls } })).map(v => v.videoUrl); toAdd = videoUrls.filter(u => !existing.includes(u)); }
    if (!toAdd.length) return;
    const videos = await Video.insertMany(toAdd.map(url => ({ userId: scraper.userId, accountId: scraper.accountId._id, videoUrl: url, hashtags: scraper.accountId.hashtags || "", status: "queued" })));
    videos.forEach((v, i) => setTimeout(() => downloadVideo(v._id, v.videoUrl), i * 3000));
    await Scraper.findByIdAndUpdate(scraperId, { $inc: { totalScraped: videos.length } });
    await logActivity(scraper.userId, scraper.accountId._id, scraper.accountId.username, "scraped", `🔍 Scraped ${videos.length} videos from ${scraper.type === "hashtag" ? "#" : "@"}${scraper.query}`);
  } catch (e) { console.error("Scraper error:", e.message); }
}

// ── BULK TIKTOK IMPORT ────────────────────────────────────────────────────────
app.post("/api/tiktok/import", auth, async (req, res) => {
  try {
    const { query, type, accountId, limit = 50 } = req.body;
    if (!query) return res.status(400).json({ error: "Query required" });
    if (!accountId) return res.status(400).json({ error: "Account required" });
    const account = await Account.findOne({ _id: accountId, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });
    const cleanQuery = query.replace(/^[@#]/, "").trim();
    const cap = Math.min(parseInt(limit) || 50, 150);
    let videoUrls = [], fetched = 0, cursor = 0;
    while (fetched < cap) {
      const batch = Math.min(cap - fetched, 35);
      const apiUrl = type === "username" ? `https://tikwm.com/api/user/posts?unique_id=${encodeURIComponent(cleanQuery)}&count=${batch}&cursor=${cursor}` : `https://tikwm.com/api/feed/search?keywords=${encodeURIComponent(cleanQuery)}&count=${batch}&cursor=${cursor}`;
      const resp = await axios.get(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 });
      if (resp.data.code !== 0 || !resp.data.data?.videos?.length) break;
      for (const v of resp.data.data.videos) videoUrls.push(type === "username" ? `https://www.tiktok.com/@${cleanQuery}/video/${v.video_id}` : `https://www.tiktok.com/@${v.author?.unique_id}/video/${v.video_id}`);
      fetched += resp.data.data.videos.length;
      cursor = resp.data.data.cursor || 0;
      if (!resp.data.data.hasMore) break;
    }
    if (!videoUrls.length) return res.status(404).json({ error: `No videos found for ${type === "hashtag" ? "#" : "@"}${cleanQuery}` });
    const existing = new Set((await Video.find({ accountId, videoUrl: { $in: videoUrls } }).select("videoUrl")).map(v => v.videoUrl));
    const newUrls = videoUrls.filter(u => !existing.has(u));
    if (!newUrls.length) return res.json({ added: 0, skipped: videoUrls.length, message: "All videos already in queue" });
    const created = await Video.insertMany(newUrls.map(url => ({ userId: req.user.id, accountId, videoUrl: url, hashtags: account.hashtags || "", status: "queued" })));
    created.forEach((v, i) => setTimeout(() => downloadVideo(v._id, v.videoUrl), i * 3000));
    await logActivity(req.user.id, accountId, account.username, "imported", `📥 Imported ${created.length} videos from ${type === "hashtag" ? "#" : "@"}${cleanQuery}`);
    res.json({ added: created.length, skipped: existing.size, total: videoUrls.length, message: `✅ ${created.length} videos importing now!` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SCHEDULER ─────────────────────────────────────────────────────────────────
function generateRandomPostingTimes(postsPerDay) {
  const startHour = 7, endHour = 23, window = endHour - startHour;
  const times = [];
  for (let i = 0; i < postsPerDay; i++) {
    const baseHour = startHour + (window / postsPerDay) * i;
    const jitter = (Math.random() - 0.5) * 1;
    const totalHour = Math.max(startHour, Math.min(endHour - 1, baseHour + jitter));
    const h = Math.floor(totalHour), m = Math.floor(Math.random() * 60);
    times.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  return [...new Set(times)].sort();
}

cron.schedule("0 0 * * *", async () => {
  try { const accounts = await Account.find({ status: { $in: ["active","paused"] }, randomTimes: true }); for (const acc of accounts) { const newTimes = generateRandomPostingTimes(acc.postsPerDay); await Account.findByIdAndUpdate(acc._id, { postingTimes: newTimes }); } }
  catch (e) { console.error("Time randomizer error:", e.message); }
});

cron.schedule("* * * * *", async () => {
  try {
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const activeAccounts = await Account.find({ status: "active" });
    for (const acc of activeAccounts) {
      if (!acc.postingTimes.includes(t)) continue;
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
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
  try { const failed = await Video.find({ status: "failed", retryCount: { $lt: 3 }, cloudinaryUrl: null }); for (const v of failed) { await Video.findByIdAndUpdate(v._id, { status: "queued", retryCount: v.retryCount + 1 }); setTimeout(() => downloadVideo(v._id, v.videoUrl), 2000); } }
  catch (e) { console.error("Retry cron error:", e.message); }
});

cron.schedule("* * * * *", async () => {
  try { const now = new Date(); const dueScrapers = await Scraper.find({ status: "active", nextRun: { $lte: now } }); for (const s of dueScrapers) runScraper(s._id); }
  catch (e) { console.error("Scraper cron error:", e.message); }
});

cron.schedule("0 */2 * * *", async () => {
  try {
    const accounts = await Account.find({ status: "active" });
    for (const acc of accounts) {
      const healthy = await checkSessionHealth(acc._id);
      if (!healthy) { await Account.findByIdAndUpdate(acc._id, { status: "error" }); await logActivity(acc.userId, acc._id, acc.username, "session_error", `⚠️ Session expired for @${acc.username}`); notifyUser(acc.userId, "failed", { username: acc.username, error: "Session expired. Please reconnect." }); }
    }
  } catch (e) { console.error("Health check error:", e.message); }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────
const adminAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "No token" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin only" });
    req.user = decoded; next();
  } catch { res.status(401).json({ error: "Invalid token" }); }
};

app.get("/api/admin/stats", adminAuth, async (req, res) => {
  try {
    const [totalUsers, totalAccounts, totalVideos, postedToday, activeAccounts] = await Promise.all([User.countDocuments(), Account.countDocuments(), Video.countDocuments(), Video.countDocuments({ status: "posted", postedAt: { $gte: new Date(Date.now() - 86400000) } }), Account.countDocuments({ status: "active" })]);
    res.json({ totalUsers, totalAccounts, totalVideos, postedToday, activeAccounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/users", adminAuth, async (req, res) => {
  try {
    const users = await User.find().select("-password").sort({ createdAt: -1 });
    const usersWithStats = await Promise.all(users.map(async (u) => { const [accounts, videos, posted] = await Promise.all([Account.countDocuments({ userId: u._id }), Video.countDocuments({ userId: u._id }), Video.countDocuments({ userId: u._id, status: "posted" })]); return { ...u.toObject(), accounts, videos, posted }; }));
    res.json(usersWithStats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/admin/users/:id", adminAuth, async (req, res) => {
  try { await User.findByIdAndDelete(req.params.id); await Account.deleteMany({ userId: req.params.id }); await Video.deleteMany({ userId: req.params.id }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/admin/users/:id", adminAuth, async (req, res) => {
  try { const { role, plan } = req.body; await User.findByIdAndUpdate(req.params.id, { role, plan }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUTO-RECONNECT HELPER ─────────────────────────────────────────────────────
// Tries to re-login accounts in "error" state using stored (hashed) password
// Not called automatically — can be triggered via admin or manually
async function tryAutoReconnect(accountId) {
  const acc = await Account.findById(accountId);
  if (!acc || !acc.igPassword || acc.status !== "error") return false;
  // We can't decrypt bcrypt — auto-reconnect only works if we have raw session refresh
  // Instead just mark for user attention
  console.log(`⚠️ Account @${acc.username} needs manual reconnect`);
  return false;
}

// ── TEST PYTHON ───────────────────────────────────────────────────────────────
app.get("/api/test-browser", auth, async (req, res) => {
  try {
    const b = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"] });
    const p = await b.newPage();
    await p.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 15000 });
    const title = await p.title();
    await b.close();
    res.json({ ok: true, title, message: "Playwright browser working ✅" });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/test-python", auth, async (req, res) => {
  try {
    const result = await new Promise((resolve) => {
      const py = spawn("python3", ["-c", "import instagrapi; print('instagrapi ok'); import sys; print(sys.version)"]);
      let stdout = "", stderr = "";
      py.stdout.on("data", d => stdout += d.toString());
      py.stderr.on("data", d => stderr += d.toString());
      py.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
      setTimeout(() => { py.kill(); resolve({ code: -1, stdout, stderr: stderr + " (timeout)" }); }, 15000);
    });
    res.json({ pythonWorks: result.code === 0, stdout: result.stdout, stderr: result.stderr, error: result.code !== 0 ? `Exit code ${result.code}` : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.get("/", (req, res) => res.json({ status: "✅ ReelFlow API v5.0", version: "5.0.0", uptime: process.uptime() }));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.use((err, req, res, next) => { console.error("Unhandled error:", err.message); res.status(500).json({ error: "Internal server error" }); });

app.listen(process.env.PORT || 3001, () => {
  console.log(`🚀 ReelFlow v5.0 on port ${process.env.PORT || 3001}`);
  exec('python3 -c "import instagrapi; print(\'✅ instagrapi ok\')"', { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) console.error("❌ instagrapi NOT available:", stderr || err.message);
    else console.log(stdout.trim());
  });
  exec("python3 --version", (err, stdout, stderr) => { console.log("Python:", stdout.trim() || stderr.trim()); });
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close(); return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) { file.close(); fs.unlink(dest, () => {}); return reject(new Error(`HTTP ${response.statusCode}`)); }
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => { fs.unlink(dest, () => {}); reject(err); });
  });
}

async function getVideoInfo(url) {
  const tiktokMatch = url.match(/tiktok\.com\/.+\/video\/(\d+)/);
  if (tiktokMatch) {
    const videoId = tiktokMatch[1];
    const apis = [
      `https://tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`,
      `https://api.tikmate.app/api/lookup?url=${encodeURIComponent(url)}`,
    ];
    for (const api of apis) {
      try {
        const res = await axios.get(api, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 });
        const data = res.data;
        if (data.code === 0 && data.data) {
          const d = data.data;
          const videoUrl = d.hdplay || d.play || d.wmplay;
          if (videoUrl) return { videoUrl, caption: d.title || "", author: d.author?.nickname || "", videoId: d.id || videoId, thumbnail: d.cover || "", duration: d.duration || 0 };
        }
        if (data.token) {
          const dl = await axios.get(`https://api.tikmate.app/api/download?token=${data.token}&type=mp4_hd`, { timeout: 15000 });
          if (dl.data?.url) return { videoUrl: dl.data.url, caption: "", author: "", videoId, thumbnail: "", duration: 0 };
        }
      } catch {}
    }
    throw new Error("Video unavailable — may be private or deleted");
  }
  return { videoUrl: url, caption: "", author: "", videoId: "", thumbnail: "", duration: 0 };
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
    await Video.findByIdAndUpdate(videoId, { status: "downloaded", localPath: out, caption: info.caption, videoAuthor: info.author, videoId: info.videoId, thumbnailUrl: info.thumbnail, duration: info.duration });
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
    cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
    const result = await cloudinary.uploader.upload(filePath, { resource_type: "video", folder: "reelflow", timeout: 120000 });
    await Video.findByIdAndUpdate(videoId, { cloudinaryUrl: result.secure_url });
    fs.unlink(filePath, () => {});
    console.log(`☁️  Cloudinary done: ${videoId}`);
  } catch (e) { console.error("❌ Cloudinary error:", e.message); }
}

function buildCaption(video, account) {
  let caption = video.caption || "";
  if (account.hashtags && account.hashtags.trim()) {
    caption = caption ? `${caption}\n\n${account.hashtags.trim()}` : account.hashtags.trim();
  }
  return caption.trim().slice(0, 2200);
}

// ── WORKFLOW ROUTES ───────────────────────────────────────────────────────────
app.get("/api/workflows", auth, async (req, res) => {
  try { res.json(await Workflow.find({ userId: req.user.id }).populate("destinationAccountId", "username profilePic").sort({ createdAt: -1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/workflows", auth, async (req, res) => {
  try { res.json(await Workflow.create({ userId: req.user.id, ...req.body })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put("/api/workflows/:id", auth, async (req, res) => {
  try { res.json(await Workflow.findOneAndUpdate({ _id: req.params.id, userId: req.user.id }, req.body, { new: true })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/workflows/:id", auth, async (req, res) => {
  try { await Workflow.findOneAndDelete({ _id: req.params.id, userId: req.user.id }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/workflows/:id/toggle", auth, async (req, res) => {
  try {
    const w = await Workflow.findOne({ _id: req.params.id, userId: req.user.id });
    if (!w) return res.status(404).json({ error: "Not found" });
    const updated = await Workflow.findByIdAndUpdate(w._id, { status: w.status === "active" ? "paused" : "active" }, { new: true });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── VIDEO ROUTES ──────────────────────────────────────────────────────────────
app.post("/api/videos/bulk", auth, async (req, res) => {
  try {
    const { urls, accountId, workflowId } = req.body;
    if (!urls?.length) return res.status(400).json({ error: "No URLs provided" });
    const account = await Account.findOne({ _id: accountId, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });
    const created = await Video.insertMany(urls.map(url => ({
      userId: req.user.id, accountId, workflowId: workflowId || null,
      videoUrl: url, hashtags: account.hashtags || "", status: "queued",
    })));
    created.forEach((v, i) => setTimeout(() => downloadVideo(v._id, v.videoUrl), i * 2000));
    res.json({ added: created.length, videos: created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/videos", auth, async (req, res) => {
  try {
    const { accountId, status, page = 1, limit = 50 } = req.query;
    const filter = { userId: req.user.id };
    if (accountId) filter.accountId = accountId;
    if (status) filter.status = status;
    const videos = await Video.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
    const total = await Video.countDocuments(filter);
    res.json({ videos, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/videos/:id", auth, async (req, res) => {
  try {
    const v = await Video.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (v?.localPath) fs.unlink(v.localPath, () => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/videos/clear-failed", auth, async (req, res) => {
  try {
    const { accountId } = req.body;
    const filter = { userId: req.user.id, status: "failed" };
    if (accountId) filter.accountId = accountId;
    const result = await Video.deleteMany(filter);
    res.json({ success: true, deleted: result.deletedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/videos/:id/retry", auth, async (req, res) => {
  try {
    const v = await Video.findOne({ _id: req.params.id, userId: req.user.id });
    if (!v) return res.status(404).json({ error: "Not found" });
    await Video.findByIdAndUpdate(v._id, { status: "queued", retryCount: 0, error: "" });
    setTimeout(() => downloadVideo(v._id, v.videoUrl), 100);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/videos/:id/post-now", auth, async (req, res) => {
  try {
    const v = await Video.findOne({ _id: req.params.id, userId: req.user.id });
    if (!v) return res.status(404).json({ error: "Not found" });
    if (v.status !== "downloaded") return res.status(400).json({ error: "Video must be downloaded first" });
    postToInstagram(v._id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/calendar", auth, async (req, res) => {
  try {
    const { accountId } = req.query;
    const filter = { userId: req.user.id, status: { $in: ["scheduled", "downloaded", "posted"] } };
    if (accountId) filter.accountId = accountId;
    const videos = await Video.find(filter).populate("accountId", "username profilePic postingTimes postsPerDay").sort({ scheduledFor: 1 }).limit(200);
    res.json(videos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STATS & ACTIVITY ──────────────────────────────────────────────────────────
app.get("/api/stats", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [accounts, totalVideos, postedVideos, failedVideos, queuedVideos, recentActivity] = await Promise.all([
      Account.find({ userId }),
      Video.countDocuments({ userId }),
      Video.countDocuments({ userId, status: "posted" }),
      Video.countDocuments({ userId, status: "failed" }),
      Video.countDocuments({ userId, status: { $in: ["queued", "downloaded"] } }),
      ActivityLog.find({ userId }).sort({ createdAt: -1 }).limit(10),
    ]);
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const postedToday = await Video.countDocuments({ userId, status: "posted", postedAt: { $gte: todayStart } });
    const activeAccounts = accounts.filter(a => a.status === "active").length;
    const errorAccounts = accounts.filter(a => a.status === "error").length;
    res.json({ accounts: accounts.length, activeAccounts, errorAccounts, totalVideos, postedVideos, failedVideos, queuedVideos, postedToday, recentActivity });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/activity", auth, async (req, res) => {
  try {
    const { accountId, limit = 50 } = req.query;
    const filter = { userId: req.user.id };
    if (accountId) filter.accountId = accountId;
    const logs = await ActivityLog.find(filter).sort({ createdAt: -1 }).limit(parseInt(limit));
    res.json(logs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/analytics", auth, async (req, res) => {
  try {
    const { accountId, days = 30 } = req.query;
    const since = new Date(Date.now() - days * 86400000);
    const filter = { userId: req.user.id, status: "posted", postedAt: { $gte: since } };
    if (accountId) filter.accountId = accountId;
    const posted = await Video.find(filter).sort({ postedAt: 1 });
    const byDay = {};
    for (const v of posted) {
      const d = v.postedAt?.toISOString().slice(0, 10);
      if (d) byDay[d] = (byDay[d] || 0) + 1;
    }
    const chart = Object.entries(byDay).map(([date, count]) => ({ date, count }));
    const accounts = await Account.find({ userId: req.user.id }).select("username totalPosted followers status");
    res.json({ chart, accounts, totalPosted: posted.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SCRAPER ROUTES ────────────────────────────────────────────────────────────
app.get("/api/scrapers", auth, async (req, res) => {
  try { res.json(await Scraper.find({ userId: req.user.id }).populate("accountId", "username profilePic").sort({ createdAt: -1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/scrapers", auth, async (req, res) => {
  try {
    const { accountId, type, query, interval, maxPerRun, skipDuplicates } = req.body;
    const account = await Account.findOne({ _id: accountId, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });
    const s = await Scraper.create({ userId: req.user.id, accountId, type: type||"username", query, interval: interval||60, maxPerRun: maxPerRun||5, skipDuplicates: skipDuplicates!==false, nextRun: new Date() });
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/scrapers/:id/toggle", auth, async (req, res) => {
  try {
    const s = await Scraper.findOne({ _id: req.params.id, userId: req.user.id });
    if (!s) return res.status(404).json({ error: "Not found" });
    const updated = await Scraper.findByIdAndUpdate(s._id, { status: s.status === "active" ? "paused" : "active" }, { new: true });
    res.json(updated);
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
  try { await Scraper.findOneAndDelete({ _id: req.params.id, userId: req.user.id }); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI CAPTION ────────────────────────────────────────────────────────────────
app.post("/api/caption/generate", auth, async (req, res) => {
  try {
    const { original, niche, existingHashtags } = req.body;
    if (!process.env.GROQ_API_KEY) return res.status(400).json({ error: "GROQ_API_KEY not configured" });
    const prompt = `Original TikTok caption: "${original || "(no caption)"}"
Account niche: ${niche || "General"}
Rewrite for Instagram Reels, under 180 chars, add 8-12 hashtags. Don't repeat: ${existingHashtags || ""}
Respond ONLY in JSON: {"caption": "...", "hashtags": "#tag1 #tag2"}`;
    const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama3-8b-8192", max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }, { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 15000 });
    const text = response.data.choices[0].message.content.trim();
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    res.json({ success: true, caption: parsed.caption || "", hashtags: parsed.hashtags || "" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
