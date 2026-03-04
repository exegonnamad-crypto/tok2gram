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

const User = mongoose.model("User", new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
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
  captionStyle: { type: String, default: "energetic" },
  status: { type: String, default: "active" },
  createdAt: { type: Date, default: Date.now },
}));

const Video = mongoose.model("Video", new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
  tiktokUrl: String,
  localPath: String,
  cloudinaryUrl: String,
  caption: { type: String, default: "" },
  hashtags: { type: String, default: "" },
  status: { type: String, enum: ["queued","downloading","downloaded","posting","posted","failed"], default: "queued" },
  postedAt: Date,
  igPostId: String,
  error: String,
  createdAt: { type: Date, default: Date.now },
}));

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Invalid token" }); }
};

app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (await User.findOne({ email })) return res.status(400).json({ error: "Email already exists" });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hash });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name, email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(400).json({ error: "Invalid credentials" });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id, name: user.name, email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/accounts", auth, async (req, res) => {
  const accounts = await Account.find({ userId: req.user.id });
  res.json(accounts.map(a => ({ ...a.toObject(), accessToken: "***" })));
});

app.post("/api/accounts", auth, async (req, res) => {
  try {
    const acc = await Account.create({ userId: req.user.id, ...req.body });
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
  res.json({ success: true });
});

app.post("/api/videos/bulk", auth, async (req, res) => {
  try {
    const { links, accountId } = req.body;
    const account = await Account.findOne({ _id: accountId, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });
    const videos = await Video.insertMany(
      links.map(url => ({ userId: req.user.id, accountId, tiktokUrl: url.trim(), hashtags: account.hashtags }))
    );
    videos.forEach(v => downloadVideo(v._id, v.tiktokUrl));
    res.json({ added: videos.length, message: "Videos queued!" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/videos", auth, async (req, res) => {
  const filter = { userId: req.user.id };
  if (req.query.accountId) filter.accountId = req.query.accountId;
  if (req.query.status) filter.status = req.query.status;
  res.json(await Video.find(filter).sort({ createdAt: -1 }).limit(100));
});

app.get("/api/stats", auth, async (req, res) => {
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  res.json({
    accounts: await Account.countDocuments({ userId: req.user.id }),
    totalPosted: await Video.countDocuments({ userId: req.user.id, status: "posted" }),
    totalQueued: await Video.countDocuments({ userId: req.user.id, status: { $in: ["queued","downloaded"] } }),
    todayPosted: await Video.countDocuments({ userId: req.user.id, status: "posted", postedAt: { $gte: todayStart } }),
  });
});

// ✅ Pure Node.js TikTok downloader - NO Python, NO yt-dlp needed!
async function getTikTokVideoUrl(tiktokUrl) {
  try {
    const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}&hd=1`;
    const response = await axios.get(apiUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 15000
    });
    const data = response.data;
    if (data.code === 0 && data.data) {
      return {
        videoUrl: data.data.play || data.data.wmplay,
        caption: data.data.title || ""
      };
    }
    throw new Error("TikTok API failed: " + JSON.stringify(data));
  } catch (e) {
    throw new Error("Failed to get TikTok video: " + e.message);
  }
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
    }).on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function downloadVideo(videoId, url) {
  await Video.findByIdAndUpdate(videoId, { status: "downloading" });
  const dir = path.join(__dirname, "downloads");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${videoId}.mp4`);

  try {
    console.log(`📥 Getting TikTok video URL for: ${url}`);
    const { videoUrl, caption } = await getTikTokVideoUrl(url);
    console.log(`⬇️ Downloading video from: ${videoUrl}`);
    await downloadFile(videoUrl, out);
    await Video.findByIdAndUpdate(videoId, {
      status: "downloaded",
      localPath: out,
      caption: caption
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
      api_secret: process.env.CLOUDINARY_API_SECRET
    });
    const result = await cloudinary.uploader.upload(filePath, { resource_type: "video", folder: "tok2gram" });
    await Video.findByIdAndUpdate(videoId, { cloudinaryUrl: result.secure_url });
    fs.unlink(filePath, () => {});
    console.log(`✅ Cloudinary upload done: ${videoId}`);
  } catch (e) { console.error("❌ Cloudinary error:", e.message); }
}

async function postToInstagram(videoId) {
  const video = await Video.findById(videoId).populate("accountId");
  if (!video?.accountId) return;
  const { accessToken, igUserId, username } = video.accountId;
  try {
    await Video.findByIdAndUpdate(videoId, { status: "posting" });
    if (!video.cloudinaryUrl) throw new Error("No public video URL yet");
    const caption = `${video.caption || ""}\n\n${video.hashtags || ""}`.trim();
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
    console.log(`🎉 Posted to Instagram: @${username}`);
  } catch (e) {
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: e.message });
    console.error(`❌ Post failed: ${e.message}`);
  }
}

cron.schedule("* * * * *", async () => {
  const now = new Date();
  const t = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  for (const acc of await Account.find({ status: "active" })) {
    if (!acc.postingTimes.includes(t)) continue;
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const posted = await Video.countDocuments({ accountId: acc._id, status: "posted", postedAt: { $gte: todayStart } });
    if (posted >= acc.postsPerDay) continue;
    const next = await Video.findOne({ accountId: acc._id, status: "downloaded" }).sort({ createdAt: 1 });
    if (!next) continue;
    console.log(`⏰ Auto-posting for @${acc.username}`);
    postToInstagram(next._id);
  }
});

app.get("/", (req, res) => res.json({ status: "✅ Tok2Gram API running!" }));
app.listen(process.env.PORT || 3001, () => console.log("🚀 Server on port 3001"));
