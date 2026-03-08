const User = require("../models/User");
const Video = require("../models/Video");
const Account = require("../models/Account");
const logger = require("../utils/logger");

// ── XP Actions ──
const XP_ACTIONS = {
  post_video: 10,
  post_streak_bonus: 5,
  first_post: 50,
  ten_posts: 100,
  hundred_posts: 500,
  connect_account: 25,
  create_workflow: 15,
  use_ai_caption: 5,
  viral_score_check: 3,
  train_brand_voice: 30,
  refer_user: 200,
};

// ── Levels ──
const LEVELS = [
  { level: 1, xpRequired: 0, title: "Rookie" },
  { level: 2, xpRequired: 100, title: "Creator" },
  { level: 3, xpRequired: 300, title: "Rising Star" },
  { level: 4, xpRequired: 600, title: "Influencer" },
  { level: 5, xpRequired: 1000, title: "Viral Master" },
  { level: 6, xpRequired: 2000, title: "Content King" },
  { level: 7, xpRequired: 4000, title: "Social Legend" },
  { level: 8, xpRequired: 7000, title: "Digital Empire" },
  { level: 9, xpRequired: 12000, title: "Hall of Fame" },
  { level: 10, xpRequired: 20000, title: "ReelFlow God" },
];

// ── Achievements ──
const ACHIEVEMENTS = [
  { id: "first_post", name: "First Blood", description: "Post your first video", icon: "rocket", xpReward: 50 },
  { id: "streak_3", name: "Warming Up", description: "3-day posting streak", icon: "flame", xpReward: 30 },
  { id: "streak_7", name: "On Fire", description: "7-day posting streak", icon: "fire", xpReward: 75 },
  { id: "streak_30", name: "Unstoppable", description: "30-day posting streak", icon: "zap", xpReward: 300 },
  { id: "posts_10", name: "Getting Started", description: "Post 10 videos", icon: "play", xpReward: 50 },
  { id: "posts_50", name: "Content Machine", description: "Post 50 videos", icon: "clapperboard", xpReward: 150 },
  { id: "posts_100", name: "Century Club", description: "Post 100 videos", icon: "trophy", xpReward: 300 },
  { id: "posts_500", name: "Factory Mode", description: "Post 500 videos", icon: "factory", xpReward: 750 },
  { id: "accounts_3", name: "Multi-Platform", description: "Connect 3 accounts", icon: "users", xpReward: 50 },
  { id: "accounts_10", name: "Account Hoarder", description: "Connect 10 accounts", icon: "crown", xpReward: 200 },
  { id: "ai_master", name: "AI Whisperer", description: "Use AI features 50 times", icon: "sparkles", xpReward: 100 },
  { id: "brand_voice", name: "Voice Found", description: "Train your brand voice", icon: "mic", xpReward: 50 },
  { id: "viral_hit", name: "Viral Hit", description: "Get a Viral Score of 90+", icon: "star", xpReward: 100 },
  { id: "ab_tester", name: "Data Driven", description: "Complete 5 A/B tests", icon: "flask", xpReward: 75 },
  { id: "night_owl", name: "Night Owl", description: "Post between 12am-5am", icon: "moon", xpReward: 25 },
  { id: "early_bird", name: "Early Bird", description: "Post between 5am-7am", icon: "sunrise", xpReward: 25 },
];

/**
 * Calculate level from XP
 */
function getLevelFromXP(xp) {
  let current = LEVELS[0];
  for (const lvl of LEVELS) {
    if (xp >= lvl.xpRequired) current = lvl;
    else break;
  }
  return current;
}

/**
 * Award XP to a user for an action
 */
async function awardXP(userId, action) {
  const xpGained = XP_ACTIONS[action];
  if (!xpGained) {
    logger.warn("Unknown XP action", { action });
    return null;
  }

  const user = await User.findById(userId);
  if (!user) return null;

  const oldLevel = user.level || 1;
  const newXP = (user.xp || 0) + xpGained;
  const levelInfo = getLevelFromXP(newXP);
  const leveledUp = levelInfo.level > oldLevel;

  user.xp = newXP;
  user.level = levelInfo.level;
  await user.save();

  if (leveledUp) {
    logger.info("User leveled up!", { userId, newLevel: levelInfo.level, title: levelInfo.title });
  }

  return {
    xpGained,
    newXP,
    newLevel: levelInfo.level,
    leveledUp,
    levelTitle: levelInfo.title,
  };
}

/**
 * Update posting streak for a user
 */
async function updateStreak(userId) {
  const user = await User.findById(userId);
  if (!user) return null;

  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];
  const lastPostDate = user.streaks?.lastPostDate;

  if (lastPostDate) {
    const lastStr = new Date(lastPostDate).toISOString().split("T")[0];

    // Already posted today
    if (lastStr === todayStr) {
      return {
        current: user.streaks.current,
        longest: user.streaks.longest,
        alreadyPostedToday: true,
      };
    }

    // Check if yesterday (consecutive)
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    if (lastStr === yesterdayStr) {
      // Consecutive day — increment streak
      user.streaks.current = (user.streaks.current || 0) + 1;
    } else {
      // Missed days — reset to 1
      user.streaks.current = 1;
    }
  } else {
    // First ever post
    user.streaks.current = 1;
  }

  user.streaks.lastPostDate = now;
  if (user.streaks.current > (user.streaks.longest || 0)) {
    user.streaks.longest = user.streaks.current;
  }

  await user.save();

  return {
    current: user.streaks.current,
    longest: user.streaks.longest,
    alreadyPostedToday: false,
  };
}

/**
 * Check and award achievements for a user
 */
async function checkAchievements(userId) {
  const user = await User.findById(userId);
  if (!user) return [];

  const existing = user.achievements || [];
  const newlyUnlocked = [];

  // Gather stats
  const [totalPosted, accountCount] = await Promise.all([
    Video.countDocuments({ userId, status: "posted" }),
    Account.countDocuments({ userId }),
  ]);

  const streak = user.streaks?.current || 0;
  const hasBrandVoice = !!user.brandVoice;

  // Check each achievement
  const checks = {
    first_post: totalPosted >= 1,
    posts_10: totalPosted >= 10,
    posts_50: totalPosted >= 50,
    posts_100: totalPosted >= 100,
    posts_500: totalPosted >= 500,
    streak_3: streak >= 3,
    streak_7: streak >= 7,
    streak_30: streak >= 30,
    accounts_3: accountCount >= 3,
    accounts_10: accountCount >= 10,
    brand_voice: hasBrandVoice,
  };

  // Time-based achievements (check last posted video time)
  const lastPostedVideo = await Video.findOne({ userId, status: "posted" })
    .sort({ postedAt: -1 })
    .select("postedAt");

  if (lastPostedVideo?.postedAt) {
    const hour = new Date(lastPostedVideo.postedAt).getUTCHours();
    checks.night_owl = hour >= 0 && hour < 5;
    checks.early_bird = hour >= 5 && hour < 7;
  }

  for (const [achievementId, condition] of Object.entries(checks)) {
    if (condition && !existing.includes(achievementId)) {
      existing.push(achievementId);
      const achievement = ACHIEVEMENTS.find(a => a.id === achievementId);
      if (achievement) {
        newlyUnlocked.push(achievement);
      }
    }
  }

  if (newlyUnlocked.length > 0) {
    user.achievements = existing;
    await user.save();
    logger.info("Achievements unlocked", { userId, achievements: newlyUnlocked.map(a => a.id) });
  }

  return newlyUnlocked;
}

/**
 * Get full gamification progress for a user
 */
async function getProgress(userId) {
  const user = await User.findById(userId).select("name xp level streaks achievements");
  if (!user) return null;

  const xp = user.xp || 0;
  const currentLevel = getLevelFromXP(xp);
  const nextLevel = LEVELS.find(l => l.level === currentLevel.level + 1);
  const xpToNext = nextLevel ? nextLevel.xpRequired - xp : 0;
  const xpInLevel = nextLevel
    ? xp - currentLevel.xpRequired
    : xp - currentLevel.xpRequired;
  const xpLevelTotal = nextLevel
    ? nextLevel.xpRequired - currentLevel.xpRequired
    : 1;

  // Recent XP activity (last 7 days of posts for approximate XP)
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const recentPosts = await Video.countDocuments({
    userId,
    status: "posted",
    postedAt: { $gte: weekAgo },
  });

  // Rank (how many users have more XP)
  const rank = await User.countDocuments({ xp: { $gt: xp } }) + 1;

  return {
    level: currentLevel.level,
    levelTitle: currentLevel.title,
    xp,
    xpInLevel,
    xpLevelTotal,
    xpToNext,
    progressPercent: nextLevel
      ? Math.round((xpInLevel / xpLevelTotal) * 100)
      : 100,
    streaks: {
      current: user.streaks?.current || 0,
      longest: user.streaks?.longest || 0,
      lastPostDate: user.streaks?.lastPostDate,
    },
    achievements: user.achievements || [],
    recentXP: recentPosts * XP_ACTIONS.post_video,
    rank,
  };
}

/**
 * Get leaderboard — top users by XP
 */
async function getLeaderboard(limit = 50) {
  const users = await User.find({ isActive: true })
    .select("name xp level streaks.current")
    .sort({ xp: -1 })
    .limit(limit)
    .lean();

  return users.map((u, i) => ({
    rank: i + 1,
    name: u.name,
    level: u.level || 1,
    levelTitle: getLevelFromXP(u.xp || 0).title,
    xp: u.xp || 0,
    streak: u.streaks?.current || 0,
  }));
}

module.exports = {
  XP_ACTIONS,
  LEVELS,
  ACHIEVEMENTS,
  awardXP,
  updateStreak,
  checkAchievements,
  getProgress,
  getLeaderboard,
  getLevelFromXP,
};
