const express = require("express");
const { auth } = require("../middleware/auth");
const { calculateEarnings, analyzeCompetitor } = require("../services/creatorTools");

const router = express.Router();

// ── Earnings Calculator ──
router.post("/earnings-calculator", auth, async (req, res, next) => {
  try {
    const { platform, followers, engagementRate, postsPerWeek, niche } = req.body;

    if (!followers) {
      return res.status(400).json({ error: "followers is required" });
    }

    const result = calculateEarnings({
      platform,
      followers: parseInt(followers),
      engagementRate: parseFloat(engagementRate),
      postsPerWeek: parseInt(postsPerWeek),
      niche,
    });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json(result);
  } catch (err) { next(err); }
});

// ── Competitor Spy ──
router.get("/competitor-spy/:username", auth, async (req, res, next) => {
  try {
    const { username } = req.params;
    const platform = req.query.platform || "tiktok";

    if (!username) {
      return res.status(400).json({ error: "username is required" });
    }

    const result = await analyzeCompetitor(username, platform);

    if (!result.success) {
      return res.status(result.error === "Creator not found" ? 404 : 400).json({ error: result.error });
    }

    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
