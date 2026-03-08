const express = require("express");
const { auth } = require("../middleware/auth");
const Video = require("../models/Video");
const { viralScore } = require("../services/aiService");
const logger = require("../utils/logger");
const crypto = require("crypto");

const router = express.Router();

// ── Create A/B Test ──
router.post("/create", auth, async (req, res, next) => {
  try {
    const { videoId, variations } = req.body;
    if (!videoId || !variations || variations.length < 1) {
      return res.status(400).json({ error: "videoId and at least 1 variation required" });
    }

    const original = await Video.findOne({ _id: videoId, userId: req.user.id });
    if (!original) return res.status(404).json({ error: "Video not found" });

    const testId = crypto.randomBytes(8).toString("hex");
    const variantLabels = ["A", "B", "C"];

    // Mark original as variant A
    original.abTest = { testId, variant: "A", isWinner: false };
    await original.save();

    // Create variation copies
    const createdVariants = [original];
    for (let i = 0; i < Math.min(variations.length, 2); i++) {
      const v = variations[i];
      const variant = new Video({
        userId: original.userId,
        accountId: original.accountId,
        workflowId: original.workflowId,
        videoUrl: original.videoUrl,
        sourcePlatform: original.sourcePlatform,
        videoAuthor: original.videoAuthor,
        videoId: original.videoId,
        originalCaption: original.originalCaption,
        caption: v.caption || original.caption,
        hashtags: v.hashtags || original.hashtags,
        localPath: original.localPath,
        cloudinaryUrl: original.cloudinaryUrl,
        cloudinaryPublicId: original.cloudinaryPublicId,
        thumbnailUrl: original.thumbnailUrl,
        duration: original.duration,
        fileSize: original.fileSize,
        width: original.width,
        height: original.height,
        status: original.cloudinaryUrl ? "downloaded" : "queued",
        abTest: { testId, variant: variantLabels[i + 1], isWinner: false },
      });
      await variant.save();
      createdVariants.push(variant);
    }

    logger.info("A/B test created", { testId, variants: createdVariants.length, userId: req.user.id });
    res.json({ testId, variants: createdVariants });
  } catch (err) { next(err); }
});

// ── List all A/B tests (MUST be before /:testId) ──
router.get("/", auth, async (req, res, next) => {
  try {
    const videos = await Video.find({
      userId: req.user.id,
      "abTest.testId": { $exists: true, $ne: "" },
    }).sort({ createdAt: -1 });

    const testsMap = {};
    videos.forEach(v => {
      const tid = v.abTest.testId;
      if (!testsMap[tid]) {
        testsMap[tid] = {
          testId: tid,
          createdAt: v.createdAt,
          variants: [],
          hasWinner: false,
          status: "running",
        };
      }
      const a = v.analytics || {};
      testsMap[tid].variants.push({
        _id: v._id,
        variant: v.abTest.variant,
        isWinner: v.abTest.isWinner,
        caption: v.caption?.substring(0, 100),
        status: v.status,
        views: a.views || 0,
        likes: a.likes || 0,
        comments: a.comments || 0,
      });
      if (v.abTest.isWinner) {
        testsMap[tid].hasWinner = true;
        testsMap[tid].status = "completed";
      }
    });

    const tests = Object.values(testsMap).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(tests);
  } catch (err) { next(err); }
});

// ── Get test results ──
router.get("/:testId", auth, async (req, res, next) => {
  try {
    const variants = await Video.find({
      userId: req.user.id,
      "abTest.testId": req.params.testId,
    }).populate("accountId", "username platform").sort({ "abTest.variant": 1 });

    if (!variants.length) return res.status(404).json({ error: "Test not found" });

    const results = variants.map(v => {
      const a = v.analytics || {};
      const total = (a.likes || 0) + (a.comments || 0) * 2 + (a.shares || 0) * 3 + (a.views || 0) * 0.01;
      return {
        _id: v._id,
        variant: v.abTest.variant,
        isWinner: v.abTest.isWinner,
        caption: v.caption,
        hashtags: v.hashtags,
        status: v.status,
        postedAt: v.postedAt,
        analytics: a,
        performanceScore: Math.round(total),
      };
    });

    res.json({ testId: req.params.testId, variants: results });
  } catch (err) { next(err); }
});

// ── Pick winner with AI ──
router.post("/:testId/pick-winner", auth, async (req, res, next) => {
  try {
    const variants = await Video.find({
      userId: req.user.id,
      "abTest.testId": req.params.testId,
    });

    if (!variants.length) return res.status(404).json({ error: "Test not found" });

    let bestIdx = 0;
    let bestScore = -1;

    variants.forEach((v, i) => {
      const a = v.analytics || {};
      const score = (a.views || 0) * 0.01 + (a.likes || 0) + (a.comments || 0) * 2 + (a.shares || 0) * 3;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    });

    for (let i = 0; i < variants.length; i++) {
      variants[i].abTest.isWinner = i === bestIdx;
      variants[i].performanceScore = (() => {
        const a = variants[i].analytics || {};
        return Math.round((a.views || 0) * 0.01 + (a.likes || 0) + (a.comments || 0) * 2 + (a.shares || 0) * 3);
      })();
      await variants[i].save();
    }

    const winner = variants[bestIdx];
    logger.info("A/B test winner picked", { testId: req.params.testId, winner: winner.abTest.variant });

    res.json({
      testId: req.params.testId,
      winner: {
        variant: winner.abTest.variant,
        caption: winner.caption,
        score: bestScore,
      },
      allVariants: variants.map(v => ({
        variant: v.abTest.variant,
        isWinner: v.abTest.isWinner,
        score: v.performanceScore,
      })),
    });
  } catch (err) { next(err); }
});

// ── Delete A/B Test ──
router.delete("/:testId", auth, async (req, res, next) => {
  try {
    const result = await Video.deleteMany({
      userId: req.user.id,
      "abTest.testId": req.params.testId,
    });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Test not found" });
    logger.info("A/B test deleted", { testId: req.params.testId, deleted: result.deletedCount });
    res.json({ deleted: result.deletedCount });
  } catch (err) { next(err); }
});

module.exports = router;
