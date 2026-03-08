const express = require("express");
const { auth, apiKeyAuth } = require("../middleware/auth");
const { checkPlan } = require("../middleware/planLimits");
const { uploadLimiter, postNowLimiter } = require("../middleware/rateLimiter");
const Video = require("../models/Video");
const Account = require("../models/Account");
const { isValidUrl, detectPlatform } = require("../utils/helpers");
const downloader = require("../services/downloader");
const { postToInstagram, logActivity } = require("../services/scheduler");
const logger = require("../utils/logger");

const router = express.Router();

// ── Bulk upload videos ──
router.post("/bulk", auth, uploadLimiter, checkPlan("bulk_upload"), checkPlan("videos"), async (req, res, next) => {
  try {
    const { links, accountId, workflowId, scheduledFor, firstComment, captionMode, customCaption, templateId } = req.body;

    // Validate captionMode
    const validModes = ["original", "ai", "template", "custom", "none"];
    const mode = validModes.includes(captionMode) ? captionMode : "original";
    if (mode === "custom" && !customCaption) {
      return res.status(400).json({ error: "customCaption is required when captionMode is 'custom'" });
    }
    if (mode === "template" && !templateId && !workflowId) {
      return res.status(400).json({ error: "templateId or workflowId is required when captionMode is 'template'" });
    }

    if (!links || !Array.isArray(links) || links.length === 0) {
      return res.status(400).json({ error: "No links provided" });
    }
    if (!accountId) return res.status(400).json({ error: "Account ID required" });

    const account = await Account.findOne({ _id: accountId, userId: req.user.id });
    if (!account) return res.status(404).json({ error: "Account not found" });

    // Clean and validate URLs
    const cleanLinks = links
      .map(l => l.trim())
      .filter(l => l.length > 0 && isValidUrl(l));

    if (cleanLinks.length === 0) return res.status(400).json({ error: "No valid URLs provided" });

    // Check for duplicates
    const existingUrls = (await Video.find({
      accountId,
      videoUrl: { $in: cleanLinks },
    })).map(v => v.videoUrl);

    const newLinks = cleanLinks.filter(l => !existingUrls.includes(l));
    if (newLinks.length === 0) {
      return res.json({ added: 0, skipped: cleanLinks.length, message: "All links already in queue" });
    }

    // Create video records
    const videos = await Video.insertMany(
      newLinks.map((url, i) => ({
        userId: req.user.id,
        accountId,
        workflowId: workflowId || null,
        videoUrl: url,
        sourcePlatform: detectPlatform(url),
        captionMode: mode,
        customCaption: mode === "custom" ? customCaption : "",
        templateId: mode === "template" ? (templateId || workflowId || null) : null,
        hashtags: account.hashtags || "",
        firstComment: firstComment || "",
        scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
        status: scheduledFor ? "scheduled" : "queued",
        priority: newLinks.length - i, // First link = highest priority
      }))
    );

    // Start downloading non-scheduled videos (staggered)
    videos
      .filter(v => v.status === "queued")
      .forEach((v, i) => {
        setTimeout(() => downloader.processVideo(v._id, v.videoUrl), i * 3000);
      });

    await logActivity(req.user.id, accountId, account.username, "bulk_upload",
      `${videos.length} videos added to queue`, { count: videos.length });

    res.json({
      added: videos.length,
      skipped: existingUrls.length,
      message: `${videos.length} video${videos.length !== 1 ? "s" : ""} queued!`,
    });
  } catch (err) { next(err); }
});

// ── List videos ──
router.get("/", auth, async (req, res, next) => {
  try {
    const filter = { userId: req.user.id };
    if (req.query.accountId) filter.accountId = req.query.accountId;
    if (req.query.status) {
      if (req.query.status.includes(",")) {
        filter.status = { $in: req.query.status.split(",") };
      } else {
        filter.status = req.query.status;
      }
    }
    if (req.query.platform) filter.sourcePlatform = req.query.platform;

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const skip = (page - 1) * limit;
    const sort = req.query.sort === "priority" ? { priority: -1, createdAt: -1 } : { createdAt: -1 };

    const [videos, total] = await Promise.all([
      Video.find(filter)
        .populate("accountId", "username profilePic")
        .sort(sort)
        .skip(skip)
        .limit(limit),
      Video.countDocuments(filter),
    ]);

    res.json({
      videos,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) { next(err); }
});

// ── Get single video ──
router.get("/:id", auth, async (req, res, next) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.user.id })
      .populate("accountId", "username profilePic");
    if (!video) return res.status(404).json({ error: "Video not found" });
    res.json(video);
  } catch (err) { next(err); }
});

// ── Update video (caption, priority, schedule) ──
router.put("/:id", auth, async (req, res, next) => {
  try {
    const { caption, hashtags, firstComment, priority, scheduledFor } = req.body;
    const update = {};
    if (caption !== undefined) update.caption = caption;
    if (hashtags !== undefined) update.hashtags = hashtags;
    if (firstComment !== undefined) update.firstComment = firstComment;
    if (priority !== undefined) update.priority = priority;
    if (scheduledFor !== undefined) {
      update.scheduledFor = scheduledFor ? new Date(scheduledFor) : null;
      if (scheduledFor) update.status = "scheduled";
    }

    const video = await Video.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      update,
      { new: true }
    );
    if (!video) return res.status(404).json({ error: "Video not found" });
    res.json(video);
  } catch (err) { next(err); }
});

// ── Post now ──
router.post("/:id/post-now", auth, postNowLimiter, async (req, res, next) => {
  try {
    const video = await Video.findOne({
      _id: req.params.id,
      userId: req.user.id,
      status: { $in: ["downloaded", "scheduled"] },
    });
    if (!video) return res.status(404).json({ error: "Video not ready — must be downloaded first" });

    postToInstagram(video._id);
    res.json({ message: "Posting now..." });
  } catch (err) { next(err); }
});

// ── Retry failed video ──
router.post("/:id/retry", auth, async (req, res, next) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.user.id, status: "failed" });
    if (!video) return res.status(404).json({ error: "Video not found or not failed" });

    if (video.cloudinaryUrl || video.localPath) {
      // Has video file — retry posting
      await Video.findByIdAndUpdate(video._id, {
        status: "downloaded",
        error: "",
        $inc: { retryCount: 1 },
      });
      setTimeout(() => postToInstagram(video._id), 2000);
    } else {
      // No video file — retry download
      await Video.findByIdAndUpdate(video._id, {
        status: "queued",
        error: "",
        $inc: { retryCount: 1 },
      });
      setTimeout(() => downloader.processVideo(video._id, video.videoUrl), 1000);
    }

    await logActivity(req.user.id, video.accountId, "", "retried", `Video retried`);
    res.json({ message: "Retrying..." });
  } catch (err) { next(err); }
});

// ── Cancel / delete video ──
router.delete("/:id", auth, async (req, res, next) => {
  try {
    const video = await Video.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (!video) return res.status(404).json({ error: "Video not found" });

    // Clean up Cloudinary if uploaded
    if (video.cloudinaryPublicId) {
      const cloudinaryService = require("../services/cloudinaryService");
      cloudinaryService.deleteVideo(video.cloudinaryPublicId);
    }

    res.json({ message: "Video deleted" });
  } catch (err) { next(err); }
});

// ── Bulk delete failed videos ──
router.post("/clear-failed", auth, async (req, res, next) => {
  try {
    const result = await Video.deleteMany({ userId: req.user.id, status: "failed" });
    await logActivity(req.user.id, null, "", "clear_failed", `Cleared ${result.deletedCount} failed videos`);
    res.json({ deleted: result.deletedCount });
  } catch (err) { next(err); }
});

// ── Bulk retry failed videos ──
router.post("/retry-all-failed", auth, async (req, res, next) => {
  try {
    const failed = await Video.find({
      userId: req.user.id,
      status: "failed",
      retryCount: { $lt: 3 },
    }).limit(50);

    for (let i = 0; i < failed.length; i++) {
      const v = failed[i];
      if (v.cloudinaryUrl || v.localPath) {
        await Video.findByIdAndUpdate(v._id, { status: "downloaded", error: "", $inc: { retryCount: 1 } });
      } else {
        await Video.findByIdAndUpdate(v._id, { status: "queued", error: "", $inc: { retryCount: 1 } });
        setTimeout(() => downloader.processVideo(v._id, v.videoUrl), i * 3000);
      }
    }

    res.json({ retrying: failed.length });
  } catch (err) { next(err); }
});

// ── Reorder video priority ──
router.post("/reorder", auth, async (req, res, next) => {
  try {
    const { videoIds } = req.body; // Array of video IDs in desired order
    if (!Array.isArray(videoIds)) return res.status(400).json({ error: "videoIds array required" });

    const updates = videoIds.map((id, i) =>
      Video.findOneAndUpdate(
        { _id: id, userId: req.user.id },
        { priority: videoIds.length - i }
      )
    );
    await Promise.all(updates);
    res.json({ message: "Queue reordered" });
  } catch (err) { next(err); }
});

module.exports = router;
