const axios = require("axios");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const logger = require("../utils/logger");
const { detectPlatform } = require("../utils/helpers");
const Video = require("../models/Video");
const cloudinaryService = require("./cloudinaryService");

const DOWNLOAD_DIR = path.join(__dirname, "../../downloads");

/**
 * Get video info from various platforms
 */
async function getVideoInfo(videoUrl) {
  const platform = detectPlatform(videoUrl);

  switch (platform) {
    case "tiktok":
      return getTikTokInfo(videoUrl);
    case "youtube":
      return getYouTubeInfo(videoUrl);
    case "instagram":
      return getInstagramInfo(videoUrl);
    case "twitter":
      return getTwitterInfo(videoUrl);
    default:
      return { videoUrl, caption: "", author: "", videoId: "", thumbnail: "", duration: 0, platform: "unknown" };
  }
}

/**
 * TikTok video info via TikWM API (free)
 */
async function getTikTokInfo(url) {
  const apiUrl = `https://tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
  const response = await axios.get(apiUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    timeout: 15000,
  });

  const data = response.data;
  if (data.code === 0 && data.data) {
    return {
      videoUrl: data.data.hdplay || data.data.play || data.data.wmplay,
      caption: data.data.title || "",
      author: data.data.author?.nickname || data.data.author?.unique_id || "",
      videoId: data.data.id || "",
      thumbnail: data.data.cover || data.data.origin_cover || "",
      duration: data.data.duration || 0,
      platform: "tiktok",
      stats: {
        likes: data.data.digg_count || 0,
        comments: data.data.comment_count || 0,
        shares: data.data.share_count || 0,
        plays: data.data.play_count || 0,
      },
    };
  }
  throw new Error("Video unavailable — may be private or deleted");
}

/**
 * YouTube Shorts info (free via noembed)
 */
async function getYouTubeInfo(url) {
  // Extract video ID
  let videoId = "";
  const shortsMatch = url.match(/shorts\/([a-zA-Z0-9_-]+)/);
  const standardMatch = url.match(/[?&]v=([a-zA-Z0-9_-]+)/);
  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/);
  videoId = shortsMatch?.[1] || standardMatch?.[1] || shortMatch?.[1] || "";

  // Get metadata
  const noembed = await axios.get(`https://noembed.com/embed?url=${encodeURIComponent(url)}`, { timeout: 10000 }).catch(() => ({ data: {} }));

  return {
    videoUrl: url,
    caption: noembed.data?.title || "",
    author: noembed.data?.author_name || "",
    videoId,
    thumbnail: noembed.data?.thumbnail_url || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    duration: 0,
    platform: "youtube",
  };
}

/**
 * Instagram Reels info (basic)
 */
async function getInstagramInfo(url) {
  return {
    videoUrl: url,
    caption: "",
    author: "",
    videoId: "",
    thumbnail: "",
    duration: 0,
    platform: "instagram",
  };
}

/**
 * Twitter/X video info (basic)
 */
async function getTwitterInfo(url) {
  return {
    videoUrl: url,
    caption: "",
    author: "",
    videoId: "",
    thumbnail: "",
    duration: 0,
    platform: "twitter",
  };
}

/**
 * Download a file from URL to local path
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(path.dirname(dest))) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
    }

    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    proto.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      timeout: 60000,
    }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlink(dest, () => {});
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", (err) => { fs.unlink(dest, () => {}); reject(err); });
    }).on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

/**
 * Full download pipeline for a video
 */
async function processVideo(videoId, videoUrl) {
  try {
    await Video.findByIdAndUpdate(videoId, { status: "downloading", error: "" });

    if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const outPath = path.join(DOWNLOAD_DIR, `${videoId}.mp4`);

    // Get video info
    const info = await getVideoInfo(videoUrl);

    // Download the file
    if (info.platform === "tiktok" && info.videoUrl !== videoUrl) {
      await downloadFile(info.videoUrl, outPath);
    } else if (info.platform === "youtube") {
      // For YouTube, we'd need yt-dlp — mark as needing manual download
      await Video.findByIdAndUpdate(videoId, {
        status: "failed",
        error: "YouTube Shorts download requires yt-dlp setup on server",
        originalCaption: info.caption,
        videoAuthor: info.author,
        thumbnailUrl: info.thumbnail,
      });
      return;
    } else {
      await downloadFile(videoUrl, outPath);
    }

    // Validate file
    const stats = fs.statSync(outPath);
    if (stats.size < 1000) {
      fs.unlink(outPath, () => {});
      throw new Error("Downloaded file too small — invalid video");
    }

    // Update video record
    await Video.findByIdAndUpdate(videoId, {
      status: "downloaded",
      localPath: outPath,
      originalCaption: info.caption,
      caption: info.caption,
      videoAuthor: info.author,
      videoId: info.videoId,
      thumbnailUrl: info.thumbnail,
      duration: info.duration,
      fileSize: stats.size,
      sourcePlatform: info.platform,
    });

    logger.info(`Downloaded: ${videoId}`, { platform: info.platform });

    // Upload to Cloudinary in background
    cloudinaryService.uploadVideo(videoId, outPath);

  } catch (err) {
    logger.error(`Download failed: ${videoId}`, { error: err.message });
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: err.message });
  }
}

/**
 * Download from Cloudinary URL (for posting when local file is gone)
 */
async function downloadFromCloudinary(videoId, cloudinaryUrl) {
  const dir = path.join(DOWNLOAD_DIR, "temp");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `post_${videoId}.mp4`);
  await downloadFile(cloudinaryUrl, dest);
  return dest;
}

module.exports = { getVideoInfo, downloadFile, processVideo, downloadFromCloudinary, DOWNLOAD_DIR };
