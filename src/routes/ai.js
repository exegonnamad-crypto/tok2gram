const express = require("express");
const { auth } = require("../middleware/auth");
const { generateCaption, generateCaptionVariations, translateCaption, generateHashtags, viralScore, generateHooks, generateContentSeries, trainBrandVoice, remixCaption } = require("../services/aiService");
const User = require("../models/User");
const Video = require("../models/Video");
const logger = require("../utils/logger");

const router = express.Router();

// Rate limit AI requests — simple in-memory tracker
const aiUsage = new Map();
const AI_LIMITS = { free: 10, pro: 100, agency: 500 }; // per day

function checkAILimit(userId, plan) {
  const today = new Date().toDateString();
  const key = `${userId}_${today}`;
  const used = aiUsage.get(key) || 0;
  const limit = AI_LIMITS[plan] || AI_LIMITS.free;
  if (used >= limit) {
    throw new Error(`AI limit reached (${limit}/day). Upgrade your plan for more.`);
  }
  aiUsage.set(key, used + 1);

  // Clean old entries every 100 requests
  if (aiUsage.size > 1000) {
    for (const [k] of aiUsage) {
      if (!k.endsWith(today)) aiUsage.delete(k);
    }
  }
}

// ── Generate caption ──
router.post("/generate-caption", auth, async (req, res, next) => {
  try {
    const user = req.user;
    checkAILimit(user.id, user.plan || "free");

    const { originalCaption, platform, niche, tone, language } = req.body;
    const caption = await generateCaption({ originalCaption, platform, niche, tone, language });
    res.json({ caption });
  } catch (err) {
    if (err.message.includes("AI limit")) {
      return res.status(429).json({ error: err.message });
    }
    next(err);
  }
});

// ── Generate caption variations ──
router.post("/generate-variations", auth, async (req, res, next) => {
  try {
    const user = req.user;
    checkAILimit(user.id, user.plan || "free");

    const { originalCaption, platform, niche, count } = req.body;
    const variations = await generateCaptionVariations({ originalCaption, platform, niche, count });
    res.json({ variations });
  } catch (err) {
    if (err.message.includes("AI limit")) {
      return res.status(429).json({ error: err.message });
    }
    next(err);
  }
});

// ── Translate caption ──
router.post("/translate", auth, async (req, res, next) => {
  try {
    const user = req.user;
    checkAILimit(user.id, user.plan || "free");

    const { caption, targetLanguage } = req.body;
    if (!caption || !targetLanguage) {
      return res.status(400).json({ error: "Caption and target language required" });
    }
    const translated = await translateCaption(caption, targetLanguage);
    res.json({ caption: translated });
  } catch (err) {
    if (err.message.includes("AI limit")) {
      return res.status(429).json({ error: err.message });
    }
    next(err);
  }
});

// ── Generate hashtags ──
router.post("/hashtags", auth, async (req, res, next) => {
  try {
    const user = req.user;
    checkAILimit(user.id, user.plan || "free");

    const { niche, count } = req.body;
    const hashtags = await generateHashtags(niche, count);
    res.json({ hashtags });
  } catch (err) {
    if (err.message.includes("AI limit")) {
      return res.status(429).json({ error: err.message });
    }
    next(err);
  }
});

// ── Auto-generate caption for a video ──
router.post("/video/:id/generate", auth, async (req, res, next) => {
  try {
    const user = req.user;
    checkAILimit(user.id, user.plan || "free");

    const video = await Video.findOne({ _id: req.params.id, userId: user.id });
    if (!video) return res.status(404).json({ error: "Video not found" });

    const { tone, language } = req.body;
    const caption = await generateCaption({
      originalCaption: video.originalCaption || video.caption,
      platform: "Instagram",
      niche: req.body.niche || "General",
      tone: tone || "viral",
      language: language || "English",
    });

    // Optionally save to video
    if (req.body.save) {
      video.caption = caption;
      await video.save();
    }

    res.json({ caption, videoId: video._id });
  } catch (err) {
    if (err.message.includes("AI limit")) {
      return res.status(429).json({ error: err.message });
    }
    next(err);
  }
});

// ── Viral Score™ ──
router.post("/viral-score", auth, async (req, res, next) => {
  try {
    checkAILimit(req.user.id, req.user.plan || "free");
    const result = await viralScore(req.body);
    res.json(result);
  } catch (err) {
    if (err.message.includes("AI limit")) return res.status(429).json({ error: err.message });
    next(err);
  }
});

// ── Hook Generator ──
router.post("/hooks", auth, async (req, res, next) => {
  try {
    checkAILimit(req.user.id, req.user.plan || "free");
    const hooks = await generateHooks(req.body);
    res.json({ hooks });
  } catch (err) {
    if (err.message.includes("AI limit")) return res.status(429).json({ error: err.message });
    next(err);
  }
});

// ── Content Series Planner ──
router.post("/content-series", auth, async (req, res, next) => {
  try {
    checkAILimit(req.user.id, req.user.plan || "free");
    const user = await User.findById(req.user.id);
    const series = await generateContentSeries({
      ...req.body,
      brandVoice: user?.brandVoice || null,
    });
    res.json({ series });
  } catch (err) {
    if (err.message.includes("AI limit")) return res.status(429).json({ error: err.message });
    next(err);
  }
});

// ── Train Brand Voice ──
router.post("/train-brand-voice", auth, async (req, res, next) => {
  try {
    checkAILimit(req.user.id, req.user.plan || "free");
    const { captions } = req.body;
    if (!captions || !Array.isArray(captions)) {
      return res.status(400).json({ error: "Provide an array of captions" });
    }
    const profile = await trainBrandVoice(captions);
    res.json({ profile });
  } catch (err) {
    if (err.message.includes("AI limit")) return res.status(429).json({ error: err.message });
    next(err);
  }
});

// ── Save Brand Voice ──
router.post("/save-brand-voice", auth, async (req, res, next) => {
  try {
    const { profile } = req.body;
    if (!profile) return res.status(400).json({ error: "Profile required" });
    await User.findByIdAndUpdate(req.user.id, { brandVoice: profile });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Caption Remix ──
router.post("/remix-caption", auth, async (req, res, next) => {
  try {
    checkAILimit(req.user.id, req.user.plan || "free");
    const user = await User.findById(req.user.id);
    const remixed = await remixCaption({
      ...req.body,
      brandVoice: user?.brandVoice || null,
    });
    res.json({ variations: remixed });
  } catch (err) {
    if (err.message.includes("AI limit")) return res.status(429).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
