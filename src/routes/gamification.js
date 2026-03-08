const express = require("express");
const { auth } = require("../middleware/auth");
const gamification = require("../services/gamification");
const User = require("../models/User");

const router = express.Router();

// ── GET /api/gamification/progress — user's full gamification progress ──
router.get("/progress", auth, async (req, res, next) => {
  try {
    const progress = await gamification.getProgress(req.user.id);
    if (!progress) return res.status(404).json({ error: "User not found" });
    res.json(progress);
  } catch (err) { next(err); }
});

// ── GET /api/gamification/achievements — all achievements with user's unlock status ──
router.get("/achievements", auth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select("achievements");
    const userAchievements = user?.achievements || [];

    // Also run a check in case new ones were unlocked
    const newlyUnlocked = await gamification.checkAchievements(req.user.id);

    const all = gamification.ACHIEVEMENTS.map(a => ({
      ...a,
      unlocked: userAchievements.includes(a.id) || newlyUnlocked.some(n => n.id === a.id),
    }));

    res.json({
      achievements: all,
      newlyUnlocked: newlyUnlocked.map(a => a.id),
      total: all.length,
      unlocked: all.filter(a => a.unlocked).length,
    });
  } catch (err) { next(err); }
});

// ── GET /api/gamification/leaderboard — public leaderboard top 50 ──
router.get("/leaderboard", auth, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const leaderboard = await gamification.getLeaderboard(limit);

    // Find current user's rank
    const user = await User.findById(req.user.id).select("xp name");
    const userRank = await User.countDocuments({ xp: { $gt: user?.xp || 0 } }) + 1;

    res.json({
      leaderboard,
      currentUser: {
        rank: userRank,
        name: user?.name,
        xp: user?.xp || 0,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/gamification/claim/:achievementId — claim achievement XP reward ──
router.post("/claim/:achievementId", auth, async (req, res, next) => {
  try {
    const { achievementId } = req.params;
    const achievement = gamification.ACHIEVEMENTS.find(a => a.id === achievementId);
    if (!achievement) {
      return res.status(404).json({ error: "Achievement not found" });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Check if user has unlocked this achievement
    if (!user.achievements?.includes(achievementId)) {
      return res.status(400).json({ error: "Achievement not unlocked yet" });
    }

    // Check if already claimed (use a simple metadata approach — store claimed ones)
    // We'll store claimed achievements as "claimed_<id>" in the achievements array
    const claimedKey = `claimed_${achievementId}`;
    if (user.achievements.includes(claimedKey)) {
      return res.status(400).json({ error: "Achievement reward already claimed" });
    }

    // Award XP
    const oldXP = user.xp || 0;
    const newXP = oldXP + achievement.xpReward;
    const levelInfo = gamification.getLevelFromXP(newXP);
    const leveledUp = levelInfo.level > (user.level || 1);

    user.xp = newXP;
    user.level = levelInfo.level;
    user.achievements.push(claimedKey);
    await user.save();

    res.json({
      success: true,
      xpGained: achievement.xpReward,
      newXP,
      newLevel: levelInfo.level,
      leveledUp,
      levelTitle: levelInfo.title,
    });
  } catch (err) { next(err); }
});

module.exports = router;
