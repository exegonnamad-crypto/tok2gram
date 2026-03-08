const Video = require("../models/Video");
const Account = require("../models/Account");
const logger = require("../utils/logger");

/**
 * Analyze posting patterns and suggest best times to post
 * Based on when previously posted content got the most engagement
 */
async function getBestTimes(userId, accountId, days = 30) {
  try {
    const since = new Date(Date.now() - days * 24 * 3600000);

    const filter = { userId, status: "posted", postedAt: { $gte: since } };
    if (accountId) filter.accountId = accountId;

    const postedVideos = await Video.find(filter)
      .select("postedAt likes comments shares views accountId")
      .lean();

    if (postedVideos.length < 3) {
      return {
        bestTimes: getDefaultBestTimes(),
        confidence: "low",
        dataPoints: postedVideos.length,
        message: "Not enough data yet. Using industry best practices.",
      };
    }

    // Analyze by hour of day
    const hourStats = {};
    for (let h = 0; h < 24; h++) {
      hourStats[h] = { count: 0, totalEngagement: 0, totalViews: 0 };
    }

    for (const v of postedVideos) {
      if (!v.postedAt) continue;
      const hour = new Date(v.postedAt).getUTCHours();
      const engagement = (v.likes || 0) + (v.comments || 0) * 2 + (v.shares || 0) * 3;
      hourStats[hour].count++;
      hourStats[hour].totalEngagement += engagement;
      hourStats[hour].totalViews += v.views || 0;
    }

    // Calculate average engagement per hour
    const hourScores = Object.entries(hourStats)
      .map(([hour, stats]) => ({
        hour: parseInt(hour),
        avgEngagement: stats.count > 0 ? stats.totalEngagement / stats.count : 0,
        avgViews: stats.count > 0 ? stats.totalViews / stats.count : 0,
        posts: stats.count,
      }))
      .sort((a, b) => b.avgEngagement - a.avgEngagement);

    // Analyze by day of week
    const dayStats = {};
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    for (let d = 0; d < 7; d++) {
      dayStats[d] = { count: 0, totalEngagement: 0 };
    }

    for (const v of postedVideos) {
      if (!v.postedAt) continue;
      const day = new Date(v.postedAt).getUTCDay();
      const engagement = (v.likes || 0) + (v.comments || 0) * 2 + (v.shares || 0) * 3;
      dayStats[day].count++;
      dayStats[day].totalEngagement += engagement;
    }

    const dayScores = Object.entries(dayStats)
      .map(([day, stats]) => ({
        day: parseInt(day),
        dayName: dayNames[parseInt(day)],
        avgEngagement: stats.count > 0 ? stats.totalEngagement / stats.count : 0,
        posts: stats.count,
      }))
      .sort((a, b) => b.avgEngagement - a.avgEngagement);

    // Top 5 best hours
    const bestHours = hourScores
      .filter(h => h.posts > 0)
      .slice(0, 5)
      .map(h => ({
        time: `${String(h.hour).padStart(2, "0")}:00`,
        hour: h.hour,
        avgEngagement: Math.round(h.avgEngagement),
        avgViews: Math.round(h.avgViews),
        posts: h.posts,
      }));

    // Top 3 best days
    const bestDays = dayScores
      .filter(d => d.posts > 0)
      .slice(0, 3)
      .map(d => ({
        day: d.dayName,
        avgEngagement: Math.round(d.avgEngagement),
        posts: d.posts,
      }));

    // Generate recommended posting schedule
    const recommendedTimes = bestHours.slice(0, 3).map(h => h.time);

    return {
      bestTimes: recommendedTimes,
      bestHours,
      bestDays,
      confidence: postedVideos.length >= 20 ? "high" : postedVideos.length >= 10 ? "medium" : "low",
      dataPoints: postedVideos.length,
      hourlyBreakdown: hourScores,
      message: `Analysis based on ${postedVideos.length} posts from the last ${days} days.`,
    };
  } catch (err) {
    logger.error("Smart scheduler analysis failed", { error: err.message });
    return {
      bestTimes: getDefaultBestTimes(),
      confidence: "low",
      dataPoints: 0,
      message: "Analysis failed. Using defaults.",
    };
  }
}

/**
 * Auto-optimize an account's posting schedule based on data
 */
async function optimizeSchedule(userId, accountId) {
  const analysis = await getBestTimes(userId, accountId);

  if (analysis.confidence === "low") {
    return { optimized: false, message: analysis.message, analysis };
  }

  // Update account with best times
  const account = await Account.findOne({ _id: accountId, userId });
  if (!account) return { optimized: false, message: "Account not found" };

  const newTimes = analysis.bestTimes.length > 0 ? analysis.bestTimes : account.postingTimes;

  await Account.findByIdAndUpdate(accountId, { postingTimes: newTimes });

  return {
    optimized: true,
    previousTimes: account.postingTimes,
    newTimes,
    analysis,
    message: `Schedule optimized! Best times: ${newTimes.join(", ")}`,
  };
}

/**
 * Get engagement score for a specific video
 */
async function getVideoScore(videoId) {
  const video = await Video.findById(videoId).lean();
  if (!video) return null;

  const likes = video.likes || 0;
  const comments = video.comments || 0;
  const shares = video.shares || 0;
  const views = video.views || 1;

  const engagementRate = ((likes + comments * 2 + shares * 3) / views) * 100;

  return {
    videoId,
    likes,
    comments,
    shares,
    views,
    engagementRate: Math.round(engagementRate * 100) / 100,
    score: likes + comments * 2 + shares * 3,
  };
}

/**
 * Default best times based on industry data
 */
function getDefaultBestTimes() {
  return ["09:00", "12:00", "17:00", "19:00", "21:00"];
}

module.exports = { getBestTimes, optimizeSchedule, getVideoScore, getDefaultBestTimes };
