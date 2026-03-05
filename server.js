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
app.use(express.json());
app.use(cors({ origin: ["https://t2g.pages.dev", "http://localhost:5173"], credentials: true }));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(e => console.log("❌ DB Error:", e.message));

// ── SCHEMAS ───────────────────────────────────────────────────────────────────

const User = mongoose.model("User", new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  plan: { type: String, default: "free" },
  createdAt: { type: Date, default: Date.now },
}));

const Account = mongoose.model("Account", new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  username: String,
  niche: String,
  accessToken: String,
  igUserId: String,
  postsPerDay: { type: Number, default: 5 },
  postingTimes: { type: [String], default: ["09:00","12:00","15:00","18:00","21:00"] },
  hashtags: { type: String, default: "" },
  captionStyle: { type: String, default: "tiktok" }, // tiktok | custom | none
  customCaption: { type: String, default: "" },
  appendHashtags: { type: Boolean, default: true },
  autoRequeue: { type: Boolean, default: false },
  status: { type: String, default: "active" }, // active | paused
  totalPosted: { type: Number, default: 0 },
  lastPostedAt: Date,
  createdAt: { type: Date, default: Date.now },
}));

const Video = mongoose.model("Video", new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
  tiktokUrl: String,
  tiktokAuthor: { type: String, default: "" },
  localPath: String,
  cloudinaryUrl: String,
  thumbnailUrl: { type: String, default: "" },
  caption: { type: String, default: "" },
  hashtags: { type: String, default: "" },
  duration: { type: Number, default: 0 },
  status: { type: String, enum: ["queued","downloading","downloaded","posting","posted","failed"], default: "queued" },
  postedAt: Date,
  igPostId: String,
  error: String,
  retryCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
}));

const ActivityLog = mongoose.model("ActivityLog", new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  accountId: mongoose.Schema.Types.ObjectId,
  accountUsername: String,
  action: String,
  message: String,
  createdAt: { type: Date, default: Date.now },
}));

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Invalid token" }); }
};

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────

app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (await User.findOne({ email })) return res.status(400).json({ error: "Email already exists" });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hash });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name, email, plan: user.plan } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(400).json({ error: "Invalid credentials" });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name: user.name, email, plan: user.plan } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/me", auth, async (req, res) => {
  const user = await User.findById(req.user.id).select("-password");
  res.json(user);
});

// ── ACCOUNT ROUTES ────────────────────────────────────────────────────────────

app.get("/api/accounts", auth, async (req, res) => {
  const accounts = await Account.find({ userId: req.user.id });
  res.json(accounts.map(a => ({ ...a.toObject(), accessToken: "***" })));
});

app.post("/api/accounts", auth, async (req, res) => {
  try {
    const acc = await Account.create({ userId: req.user.id, ...req.body });
    await logActivity(req.user.id, acc._id, acc.username, "queued", `Account @${acc.username} connected`);
    res.json({ ...acc.toObject(), accessToken: "***" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/accounts/:id", auth, async (req, res) => {
  try {
    const acc = await Account.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id }, req.body, { new: true }
    );
    res.json({ ...acc.toObject(), accessToken: "***" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/accounts/:id", auth, async (req, res) => {
  await Account.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  await Video.deleteMany({ accountId: req.params.id });
  res.json({ success: true });
});

// Pause / Resume account
app.post("/api/accounts/:id/toggle", auth, async (req, res) => {
  try {
    const acc = await Account.findOne({ _id: req.params.id, userId: req.user.id });
    if (!acc) return res.status(404).json({ error: "Not found" });
    acc.status = acc.status === "active" ? "paused" : "active";
    await acc.save();
    res.json({ status: acc.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update posting times
app.put("/api/accounts/:id/times", auth, async (req, res) => {
  try {
    const { postingTimes } = req.body;
    const acc = await Account.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { postingTimes },
      { new: true }
    );
    res.json({ postingTimes: acc.postingTimes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── VIDEO ROUTES ──────────────────────────────────────────────────────────────

app.post("/api/videos/bulk", auth, async (req, res) => {
  try {
    const { links, accountId } = req.body;
    const account = await Account.findOne({ _id: accountId, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });

    // Skip duplicates
    const existingUrls = (await Video.find({ accountId, tiktokUrl: { $in: links } })).map(v => v.tiktokUrl);
    const newLinks = links.filter(l => !existingUrls.includes(l.trim()));
    if (newLinks.length === 0) return res.json({ added: 0, skipped: links.length, message: "All links already queued!" });

    const videos = await Video.insertMany(
      newLinks.map(url => ({ userId: req.user.id, accountId, tiktokUrl: url.trim(), hashtags: account.hashtags }))
    );
    videos.forEach((v, i) => setTimeout(() => downloadVideo(v._id, v.tiktokUrl), i * 3000));
    await logActivity(req.user.id, accountId, account.username, "queued", `${videos.length} videos added to queue`);
    res.json({ added: videos.length, skipped: existingUrls.length, message: `${videos.length} videos queued!` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/videos", auth, async (req, res) => {
  const filter = { userId: req.user.id };
  if (req.query.accountId) filter.accountId = req.query.accountId;
  if (req.query.status) filter.status = req.query.status;
  const limit = parseInt(req.query.limit) || 100;
  res.json(await Video.find(filter).sort({ createdAt: -1 }).limit(limit));
});

// Delete single video
app.delete("/api/videos/:id", auth, async (req, res) => {
  await Video.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  res.json({ success: true });
});

// Delete all failed videos
app.delete("/api/videos/failed/all", auth, async (req, res) => {
  const r = await Video.deleteMany({ userId: req.user.id, status: "failed" });
  res.json({ deleted: r.deletedCount });
});

// Retry failed video
app.post("/api/videos/:id/retry", auth, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.user.id });
    if (!video) return res.status(404).json({ error: "Not found" });
    await Video.findByIdAndUpdate(video._id, { status: "queued", error: "", retryCount: video.retryCount + 1 });
    setTimeout(() => downloadVideo(video._id, video.tiktokUrl), 1000);
    res.json({ message: "Retrying..." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Post video immediately
app.post("/api/videos/:id/post-now", auth, async (req, res) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.user.id, status: "downloaded" });
    if (!video) return res.status(404).json({ error: "Video not ready to post" });
    postToInstagram(video._id);
    res.json({ message: "Posting now..." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STATS + ACTIVITY ──────────────────────────────────────────────────────────

app.get("/api/stats", auth, async (req, res) => {
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);
  const accounts = await Account.find({ userId: req.user.id });

  const accountStats = await Promise.all(accounts.map(async (acc) => ({
    id: acc._id,
    username: acc.username,
    niche: acc.niche,
    status: acc.status,
    postingTimes: acc.postingTimes,
    postsPerDay: acc.postsPerDay,
    totalPosted: acc.totalPosted,
    lastPostedAt: acc.lastPostedAt,
    queued: await Video.countDocuments({ accountId: acc._id, status: { $in: ["queued","downloaded"] } }),
    failed: await Video.countDocuments({ accountId: acc._id, status: "failed" }),
    todayPosted: await Video.countDocuments({ accountId: acc._id, status: "posted", postedAt: { $gte: todayStart } }),
  })));

  res.json({
    accounts: accounts.length,
    totalPosted: await Video.countDocuments({ userId: req.user.id, status: "posted" }),
    totalQueued: await Video.countDocuments({ userId: req.user.id, status: { $in: ["queued","downloaded"] } }),
    totalFailed: await Video.countDocuments({ userId: req.user.id, status: "failed" }),
    todayPosted: await Video.countDocuments({ userId: req.user.id, status: "posted", postedAt: { $gte: todayStart } }),
    weekPosted: await Video.countDocuments({ userId: req.user.id, status: "posted", postedAt: { $gte: weekStart } }),
    accountStats,
  });
});

app.get("/api/activity", auth, async (req, res) => {
  const logs = await ActivityLog.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50);
  res.json(logs);
});

// ── HELPER: LOG ───────────────────────────────────────────────────────────────

async function logActivity(userId, accountId, accountUsername, action, message) {
  try { await ActivityLog.create({ userId, accountId, accountUsername, action, message }); }
  catch(e) { /* silent */ }
}

// ── DOWNLOAD PIPELINE ─────────────────────────────────────────────────────────

async function getTikTokInfo(tiktokUrl) {
  const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}&hd=1`;
  const response = await axios.get(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 });
  const data = response.data;
  if (data.code === 0 && data.data) {
    return {
      videoUrl: data.data.play || data.data.wmplay,
      caption: data.data.title || "",
      author: data.data.author?.nickname || data.data.author?.unique_id || "",
      thumbnail: data.data.cover || "",
      duration: data.data.duration || 0,
    };
  }
  throw new Error("TikTok API failed");
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
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => { fs.unlink(dest, () => {}); reject(err); });
  });
}

async function downloadVideo(videoId, url) {
  await Video.findByIdAndUpdate(videoId, { status: "downloading" });
  const dir = path.join(__dirname, "downloads");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${videoId}.mp4`);
  try {
    const info = await getTikTokInfo(url);
    await downloadFile(info.videoUrl, out);
    await Video.findByIdAndUpdate(videoId, {
      status: "downloaded",
      localPath: out,
      caption: info.caption,
      tiktokAuthor: info.author,
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
    const result = await cloudinary.uploader.upload(filePath, { resource_type: "video", folder: "tok2gram" });
    await Video.findByIdAndUpdate(videoId, { cloudinaryUrl: result.secure_url });
    fs.unlink(filePath, () => {});
    console.log(`☁️ Cloudinary done: ${videoId}`);
  } catch (e) { console.error("❌ Cloudinary error:", e.message); }
}

// ── INSTAGRAM POSTING ─────────────────────────────────────────────────────────

function buildCaption(video, account) {
  let caption = "";
  if (account.captionStyle === "tiktok") caption = video.caption || "";
  else if (account.captionStyle === "custom") caption = account.customCaption || "";
  // else "none" = ""
  if (account.appendHashtags && account.hashtags) {
    caption = caption ? `${caption}\n\n${account.hashtags}` : account.hashtags;
  }
  return caption.trim();
}

async function postToInstagram(videoId) {
  const video = await Video.findById(videoId).populate("accountId");
  if (!video?.accountId) return;
  const account = video.accountId;
  const { accessToken, igUserId, username } = account;
  try {
    await Video.findByIdAndUpdate(videoId, { status: "posting" });
    if (!video.cloudinaryUrl) throw new Error("No public video URL");
    const caption = buildCaption(video, account);

    const r1 = await fetch(`https://graph.facebook.com/v18.0/${igUserId}/media`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_type: "REELS", video_url: video.cloudinaryUrl, caption, access_token: accessToken }),
    });
    const container = await r1.json();
    if (container.error) throw new Error(container.error.message);

    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const r2 = await fetch(`https://graph.facebook.com/v18.0/${container.id}?fields=status_code&access_token=${accessToken}`);
      const s = await r2.json();
      if (s.status_code === "FINISHED") break;
      if (s.status_code === "ERROR") throw new Error("IG container failed");
    }

    const r3 = await fetch(`https://graph.facebook.com/v18.0/${igUserId}/media_publish`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: container.id, access_token: accessToken }),
    });
    const published = await r3.json();
    if (published.error) throw new Error(published.error.message);

    await Video.findByIdAndUpdate(videoId, { status: "posted", postedAt: new Date(), igPostId: published.id });
    await Account.findByIdAndUpdate(account._id, { $inc: { totalPosted: 1 }, lastPostedAt: new Date() });
    await logActivity(account.userId, account._id, username, "posted", `✅ Posted reel to @${username}`);
    console.log(`🎉 Posted to @${username}`);

    if (account.autoRequeue) {
      await Video.findByIdAndUpdate(videoId, { status: "downloaded", postedAt: null, igPostId: null });
    }
  } catch (e) {
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: e.message });
    await logActivity(account.userId, account._id, username, "failed", `❌ Post failed @${username}: ${e.message}`);
    console.error(`❌ Post failed @${username}: ${e.message}`);
  }
}

// ── SCHEDULER ─────────────────────────────────────────────────────────────────

cron.schedule("* * * * *", async () => {
  const now = new Date();
  const t = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  for (const acc of await Account.find({ status: "active" })) {
    if (!acc.postingTimes.includes(t)) continue;
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const posted = await Video.countDocuments({ accountId: acc._id, status: "posted", postedAt: { $gte: todayStart } });
    if (posted >= acc.postsPerDay) continue;
    const next = await Video.findOne({ accountId: acc._id, status: "downloaded" }).sort({ createdAt: 1 });
    if (!next) { console.log(`⚠️ No ready videos for @${acc.username}`); continue; }
    console.log(`⏰ Auto-posting for @${acc.username}`);
    postToInstagram(next._id);
  }
});

// Auto-retry failed videos every 30 mins (max 3 retries)
cron.schedule("*/30 * * * *", async () => {
  const failed = await Video.find({ status: "failed", retryCount: { $lt: 3 } });
  for (const v of failed) {
    await Video.findByIdAndUpdate(v._id, { status: "queued", retryCount: v.retryCount + 1 });
    setTimeout(() => downloadVideo(v._id, v.tiktokUrl), 2000);
  }
  if (failed.length > 0) console.log(`🔄 Auto-retrying ${failed.length} failed videos`);
});

app.get("/", (req, res) => res.json({ status: "✅ Tok2Gram API running!", version: "2.0" }));
app.listen(process.env.PORT || 3001, () => console.log("🚀 Tok2Gram v2.0 on port 3001"));
