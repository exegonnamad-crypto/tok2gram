const express = require("express");
const { auth } = require("../middleware/auth");
const User = require("../models/User");
const Account = require("../models/Account");
const Video = require("../models/Video");
const ActivityLog = require("../models/ActivityLog");

const router = express.Router();

// ── Dashboard stats ──
router.get("/stats", auth, async (req, res, next) => {
  try {
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(); monthStart.setDate(monthStart.getDate() - 30);

    const [accounts, user] = await Promise.all([
      Account.find({ userId: req.user.id }),
      User.findById(req.user.id).select("-password"),
    ]);

    // Per-account stats
    const accountStats = await Promise.all(accounts.map(async acc => {
      const [queued, todayPosted, weekPosted] = await Promise.all([
        Video.countDocuments({ accountId: acc._id, status: { $in: ["queued", "downloaded", "scheduled"] } }),
        Video.countDocuments({ accountId: acc._id, status: "posted", postedAt: { $gte: todayStart } }),
        Video.countDocuments({ accountId: acc._id, status: "posted", postedAt: { $gte: weekStart } }),
      ]);
      return {
        id: acc._id,
        username: acc.username,
        platform: acc.platform,
        niche: acc.niche,
        status: acc.status,
        profilePic: acc.profilePic,
        postingTimes: acc.postingTimes,
        postsPerDay: acc.postsPerDay,
        totalPosted: acc.totalPosted,
        lastPostedAt: acc.lastPostedAt,
        errorMessage: acc.errorMessage,
        queued,
        todayPosted,
        weekPosted,
      };
    }));

    // Global stats
    const [totalPosted, totalQueued, totalFailed, todayPosted, weekPosted, monthPosted, totalDownloading] = await Promise.all([
      Video.countDocuments({ userId: req.user.id, status: "posted" }),
      Video.countDocuments({ userId: req.user.id, status: { $in: ["queued", "downloaded", "scheduled"] } }),
      Video.countDocuments({ userId: req.user.id, status: "failed" }),
      Video.countDocuments({ userId: req.user.id, status: "posted", postedAt: { $gte: todayStart } }),
      Video.countDocuments({ userId: req.user.id, status: "posted", postedAt: { $gte: weekStart } }),
      Video.countDocuments({ userId: req.user.id, status: "posted", postedAt: { $gte: monthStart } }),
      Video.countDocuments({ userId: req.user.id, status: { $in: ["downloading", "posting"] } }),
    ]);

    res.json({
      accounts: accounts.length,
      activeAccounts: accounts.filter(a => a.status === "active").length,
      totalPosted,
      totalQueued,
      totalFailed,
      totalDownloading,
      todayPosted,
      weekPosted,
      monthPosted,
      plan: user?.plan,
      trialEndsAt: user?.trialEndsAt,
      videosPublished: user?.videosPublished || 0,
      accountStats,
    });
  } catch (err) { next(err); }
});

// ── Activity feed ──
router.get("/activity", auth, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const skip = (page - 1) * limit;

    const filter = { userId: req.user.id };
    if (req.query.action) filter.action = req.query.action;
    if (req.query.accountId) filter.accountId = req.query.accountId;

    const logs = await ActivityLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    res.json(logs);
  } catch (err) { next(err); }
});

// ── Calendar data ──
router.get("/calendar", auth, async (req, res, next) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: "start and end query params required" });

    const videos = await Video.find({
      userId: req.user.id,
      $or: [
        { status: "scheduled", scheduledFor: { $gte: new Date(start), $lte: new Date(end) } },
        { status: "posted", postedAt: { $gte: new Date(start), $lte: new Date(end) } },
      ],
    })
      .populate("accountId", "username profilePic")
      .sort({ scheduledFor: 1, postedAt: 1 })
      .limit(500);

    res.json(videos);
  } catch (err) { next(err); }
});

// ── Analytics: posting history (for charts) ──
router.get("/analytics", auth, async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setUTCHours(0, 0, 0, 0);

    // Posts per day for the period
    const postsPerDay = await Video.aggregate([
      {
        $match: {
          userId: require("mongoose").Types.ObjectId.createFromHexString(req.user.id),
          status: "posted",
          postedAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$postedAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Posts per account
    const postsPerAccount = await Video.aggregate([
      {
        $match: {
          userId: require("mongoose").Types.ObjectId.createFromHexString(req.user.id),
          status: "posted",
          postedAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: "$accountId",
          count: { $sum: 1 },
        },
      },
    ]);

    // Failure rate
    const [totalAttempted, totalFailed] = await Promise.all([
      Video.countDocuments({ userId: req.user.id, createdAt: { $gte: startDate } }),
      Video.countDocuments({ userId: req.user.id, status: "failed", createdAt: { $gte: startDate } }),
    ]);

    // Best posting times (which times get the most successful posts)
    const bestTimes = await Video.aggregate([
      {
        $match: {
          userId: require("mongoose").Types.ObjectId.createFromHexString(req.user.id),
          status: "posted",
          postedAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: { $hour: "$postedAt" },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Platform breakdown
    const platformBreakdown = await Video.aggregate([
      {
        $match: {
          userId: require("mongoose").Types.ObjectId.createFromHexString(req.user.id),
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: "$sourcePlatform",
          total: { $sum: 1 },
          posted: { $sum: { $cond: [{ $eq: ["$status", "posted"] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        },
      },
    ]);

    res.json({
      period: { days, start: startDate },
      postsPerDay,
      postsPerAccount,
      bestTimes,
      platformBreakdown,
      successRate: totalAttempted > 0 ? ((totalAttempted - totalFailed) / totalAttempted * 100).toFixed(1) : 100,
      totalAttempted,
      totalFailed,
    });
  } catch (err) { next(err); }
});

// ── Smart Scheduling ──
const smartScheduler = require("../services/smartScheduler");

// Get best posting times
router.get("/smart-schedule", auth, async (req, res, next) => {
  try {
    const { accountId, days } = req.query;
    const analysis = await smartScheduler.getBestTimes(
      req.user.id,
      accountId || null,
      parseInt(days) || 30
    );
    res.json(analysis);
  } catch (err) { next(err); }
});

// Auto-optimize account schedule
router.post("/smart-schedule/optimize/:accountId", auth, async (req, res, next) => {
  try {
    const result = await smartScheduler.optimizeSchedule(req.user.id, req.params.accountId);
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
