const express = require("express");
const { auth } = require("../middleware/auth");
const ContentSource = require("../models/ContentSource");
const contentDiscovery = require("../services/contentDiscovery");
const logger = require("../utils/logger");

const router = express.Router();

// ── Browse trending videos ──
router.get("/trending", auth, async (req, res, next) => {
  try {
    const { count } = req.query;
    const result = await contentDiscovery.fetchTrending(parseInt(count) || 20);
    res.json(result);
  } catch (err) { next(err); }
});

// ── Search creators ──
router.get("/creators/search", auth, async (req, res, next) => {
  try {
    const { q, count } = req.query;
    if (!q) return res.status(400).json({ error: "Search query required" });
    const result = await contentDiscovery.searchCreators(q, parseInt(count) || 10);
    res.json(result);
  } catch (err) { next(err); }
});

// ── Get creator info ──
router.get("/creators/:username", auth, async (req, res, next) => {
  try {
    const result = await contentDiscovery.getCreatorInfo(req.params.username);
    res.json(result);
  } catch (err) { next(err); }
});

// ── Search creator videos (may be limited) ──
router.get("/creator/:username", auth, async (req, res, next) => {
  try {
    const { count } = req.query;
    const result = await contentDiscovery.fetchCreatorVideos(req.params.username, parseInt(count) || 10);
    res.json(result);
  } catch (err) { next(err); }
});

// ── Search hashtag videos ──
router.get("/hashtag/:tag", auth, async (req, res, next) => {
  try {
    const { count } = req.query;
    const result = await contentDiscovery.fetchHashtagVideos(req.params.tag, parseInt(count) || 10);
    res.json(result);
  } catch (err) { next(err); }
});

// ── List content sources ──
router.get("/sources", auth, async (req, res, next) => {
  try {
    const sources = await ContentSource.find({ userId: req.user.id })
      .populate("destinationAccountId", "username platform")
      .sort({ createdAt: -1 });
    res.json(sources);
  } catch (err) { next(err); }
});

// ── Create content source ──
router.post("/sources", auth, async (req, res, next) => {
  try {
    const { type, platform, identifier, destinationAccountId, autoImport, maxPerDay,
            minViews, minLikes, captionStyle, customCaption, appendHashtags,
            keywords, excludeKeywords } = req.body;

    if (!type || !identifier) {
      return res.status(400).json({ error: "Type and identifier required" });
    }
    if (!destinationAccountId) {
      return res.status(400).json({ error: "Destination account required" });
    }

    const count = await ContentSource.countDocuments({ userId: req.user.id });
    const limits = { free: 3, pro: 20, agency: 100 };
    const userPlan = req.user.plan || "free";
    if (count >= (limits[userPlan] || limits.free)) {
      return res.status(403).json({ error: `Source limit reached for ${userPlan} plan` });
    }

    const source = await ContentSource.create({
      userId: req.user.id,
      type,
      platform: platform || "tiktok",
      identifier,
      destinationAccountId,
      autoImport: autoImport !== false,
      maxPerDay: Math.min(maxPerDay || 5, 50),
      minViews: minViews || 0,
      minLikes: minLikes || 0,
      captionStyle: captionStyle || "original",
      customCaption: customCaption || "",
      appendHashtags: appendHashtags || "",
      keywords: keywords || [],
      excludeKeywords: excludeKeywords || [],
    });

    res.status(201).json(source);
  } catch (err) { next(err); }
});

// ── Update content source ──
router.put("/sources/:id", auth, async (req, res, next) => {
  try {
    const allowed = ["autoImport", "maxPerDay", "minViews", "minLikes", "captionStyle",
                     "customCaption", "appendHashtags", "keywords", "excludeKeywords",
                     "destinationAccountId"];
    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    const source = await ContentSource.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      update,
      { new: true }
    );
    if (!source) return res.status(404).json({ error: "Source not found" });
    res.json(source);
  } catch (err) { next(err); }
});

// ── Toggle content source ──
router.post("/sources/:id/toggle", auth, async (req, res, next) => {
  try {
    const source = await ContentSource.findOne({ _id: req.params.id, userId: req.user.id });
    if (!source) return res.status(404).json({ error: "Source not found" });

    source.status = source.status === "active" ? "paused" : "active";
    await source.save();
    res.json(source);
  } catch (err) { next(err); }
});

// ── Delete content source ──
router.delete("/sources/:id", auth, async (req, res, next) => {
  try {
    const source = await ContentSource.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (!source) return res.status(404).json({ error: "Source not found" });
    res.json({ message: "Source deleted" });
  } catch (err) { next(err); }
});

// ── Manually trigger import from a source ──
router.post("/sources/:id/import", auth, async (req, res, next) => {
  try {
    const source = await ContentSource.findOne({ _id: req.params.id, userId: req.user.id });
    if (!source) return res.status(404).json({ error: "Source not found" });

    const result = await contentDiscovery.processSource(source);
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
