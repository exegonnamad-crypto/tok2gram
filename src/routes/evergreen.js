const express = require("express");
const { auth } = require("../middleware/auth");
const Video = require("../models/Video");
const logger = require("../utils/logger");

const router = express.Router();

// ── Mark video as evergreen ──
router.post("/mark/:videoId", auth, async (req, res, next) => {
  try {
    const video = await Video.findOne({ _id: req.params.videoId, userId: req.user.id });
    if (!video) return res.status(404).json({ error: "Video not found" });

    video.isEvergreen = true;
    video.evergreenConfig = {
      recycleDays: req.body.recycleDays || 7,
      maxRecycles: req.body.maxRecycles || 0,
      timesRecycled: video.evergreenConfig?.timesRecycled || 0,
      lastRecycledAt: video.evergreenConfig?.lastRecycledAt || null,
    };
    await video.save();

    logger.info("Video marked as evergreen", { videoId: video._id, userId: req.user.id });
    res.json({ success: true, video });
  } catch (err) { next(err); }
});

// ── Unmark evergreen ──
router.delete("/unmark/:videoId", auth, async (req, res, next) => {
  try {
    const video = await Video.findOne({ _id: req.params.videoId, userId: req.user.id });
    if (!video) return res.status(404).json({ error: "Video not found" });

    video.isEvergreen = false;
    await video.save();

    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── List all evergreen videos ──
router.get("/", auth, async (req, res, next) => {
  try {
    const videos = await Video.find({ userId: req.user.id, isEvergreen: true })
      .populate("accountId", "username platform profilePic niche")
      .sort({ createdAt: -1 });
    res.json(videos);
  } catch (err) { next(err); }
});

// ── Manually recycle an evergreen video ──
router.post("/recycle/:videoId", auth, async (req, res, next) => {
  try {
    const original = await Video.findOne({ _id: req.params.videoId, userId: req.user.id, isEvergreen: true });
    if (!original) return res.status(404).json({ error: "Evergreen video not found" });

    // Check max recycles
    if (original.evergreenConfig.maxRecycles > 0 &&
        original.evergreenConfig.timesRecycled >= original.evergreenConfig.maxRecycles) {
      return res.status(400).json({ error: "Max recycles reached" });
    }

    // Create a new queued video from the evergreen source
    const newVideo = new Video({
      userId: original.userId,
      accountId: original.accountId,
      workflowId: original.workflowId,
      videoUrl: original.videoUrl,
      sourcePlatform: original.sourcePlatform,
      videoAuthor: original.videoAuthor,
      videoId: original.videoId,
      originalCaption: original.originalCaption,
      caption: original.caption,
      hashtags: original.hashtags,
      localPath: original.localPath,
      cloudinaryUrl: original.cloudinaryUrl,
      cloudinaryPublicId: original.cloudinaryPublicId,
      thumbnailUrl: original.thumbnailUrl,
      duration: original.duration,
      fileSize: original.fileSize,
      width: original.width,
      height: original.height,
      status: original.cloudinaryUrl ? "downloaded" : "queued",
      priority: 1,
    });
    await newVideo.save();

    // Update evergreen stats
    original.evergreenConfig.timesRecycled = (original.evergreenConfig.timesRecycled || 0) + 1;
    original.evergreenConfig.lastRecycledAt = new Date();
    await original.save();

    logger.info("Evergreen video recycled", { originalId: original._id, newId: newVideo._id });
    res.json({ success: true, newVideo, original });
  } catch (err) { next(err); }
});

// ── Toggle evergreen on/off ──
router.post("/:id/toggle", auth, async (req, res, next) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.user.id, isEvergreen: true });
    if (!video) return res.status(404).json({ error: "Evergreen video not found" });
    video.evergreenConfig.paused = !video.evergreenConfig?.paused;
    await video.save();
    res.json({ success: true, paused: video.evergreenConfig.paused });
  } catch (err) { next(err); }
});

// ── Update evergreen config ──
router.put("/:id", auth, async (req, res, next) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.user.id, isEvergreen: true });
    if (!video) return res.status(404).json({ error: "Evergreen video not found" });
    if (req.body.recycleDays) video.evergreenConfig.recycleDays = req.body.recycleDays;
    if (req.body.maxRecycles !== undefined) video.evergreenConfig.maxRecycles = req.body.maxRecycles;
    await video.save();
    res.json({ success: true, video });
  } catch (err) { next(err); }
});

// ── Remove from evergreen (alias) ──
router.delete("/:id", auth, async (req, res, next) => {
  try {
    const video = await Video.findOne({ _id: req.params.id, userId: req.user.id });
    if (!video) return res.status(404).json({ error: "Video not found" });
    video.isEvergreen = false;
    await video.save();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Recycle by ID (alias for /recycle/:videoId) ──
router.post("/:id/recycle", auth, async (req, res, next) => {
  req.params.videoId = req.params.id;
  // Delegate to the existing recycle handler logic
  try {
    const original = await Video.findOne({ _id: req.params.id, userId: req.user.id, isEvergreen: true });
    if (!original) return res.status(404).json({ error: "Evergreen video not found" });
    if (original.evergreenConfig.maxRecycles > 0 &&
        original.evergreenConfig.timesRecycled >= original.evergreenConfig.maxRecycles) {
      return res.status(400).json({ error: "Max recycles reached" });
    }
    const newVideo = new Video({
      userId: original.userId, accountId: original.accountId, workflowId: original.workflowId,
      videoUrl: original.videoUrl, sourcePlatform: original.sourcePlatform,
      videoAuthor: original.videoAuthor, videoId: original.videoId,
      originalCaption: original.originalCaption, caption: original.caption, hashtags: original.hashtags,
      localPath: original.localPath, cloudinaryUrl: original.cloudinaryUrl,
      cloudinaryPublicId: original.cloudinaryPublicId, thumbnailUrl: original.thumbnailUrl,
      duration: original.duration, fileSize: original.fileSize, width: original.width, height: original.height,
      status: original.cloudinaryUrl ? "downloaded" : "queued", priority: 1,
    });
    await newVideo.save();
    original.evergreenConfig.timesRecycled = (original.evergreenConfig.timesRecycled || 0) + 1;
    original.evergreenConfig.lastRecycledAt = new Date();
    await original.save();
    logger.info("Evergreen video recycled via /:id/recycle", { originalId: original._id, newId: newVideo._id });
    res.json({ success: true, newVideo, original });
  } catch (err) { next(err); }
});

module.exports = router;
