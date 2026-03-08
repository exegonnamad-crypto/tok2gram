const express = require("express");
const { auth, adminOnly } = require("../middleware/auth");
const User = require("../models/User");
const Account = require("../models/Account");
const Video = require("../models/Video");
const Workflow = require("../models/Workflow");
const ActivityLog = require("../models/ActivityLog");
const logger = require("../utils/logger");

const router = express.Router();

// All admin routes require auth + admin role
router.use(auth, adminOnly);

// ── System overview ──
router.get("/overview", async (req, res, next) => {
  try {
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(); monthStart.setDate(monthStart.getDate() - 30);

    const [
      totalUsers, activeUsers, proUsers,
      totalAccounts, activeAccounts,
      totalVideos, postedToday, postedWeek, postedMonth,
      queuedVideos, failedVideos,
      totalWorkflows,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ lastLoginAt: { $gte: weekStart } }),
      User.countDocuments({ plan: { $in: ["pro", "agency"] } }),
      Account.countDocuments(),
      Account.countDocuments({ status: "active" }),
      Video.countDocuments(),
      Video.countDocuments({ status: "posted", postedAt: { $gte: todayStart } }),
      Video.countDocuments({ status: "posted", postedAt: { $gte: weekStart } }),
      Video.countDocuments({ status: "posted", postedAt: { $gte: monthStart } }),
      Video.countDocuments({ status: { $in: ["queued", "downloaded", "scheduled"] } }),
      Video.countDocuments({ status: "failed" }),
      Workflow.countDocuments(),
    ]);

    // New users this week
    const newUsersWeek = await User.countDocuments({ createdAt: { $gte: weekStart } });

    // Users by plan
    const planBreakdown = await User.aggregate([
      { $group: { _id: "$plan", count: { $sum: 1 } } },
    ]);

    res.json({
      users: { total: totalUsers, active: activeUsers, pro: proUsers, newThisWeek: newUsersWeek, planBreakdown },
      accounts: { total: totalAccounts, active: activeAccounts },
      videos: { total: totalVideos, postedToday, postedWeek, postedMonth, queued: queuedVideos, failed: failedVideos },
      workflows: { total: totalWorkflows },
      server: {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        nodeVersion: process.version,
      },
    });
  } catch (err) { next(err); }
});

// ── List users ──
router.get("/users", async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = (page - 1) * limit;
    const search = req.query.search || "";
    const plan = req.query.plan || "";

    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }
    if (plan) filter.plan = plan;

    const [users, total] = await Promise.all([
      User.find(filter)
        .select("-password -emailVerifyToken -resetToken")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      User.countDocuments(filter),
    ]);

    // Enrich with account/video counts
    const enriched = await Promise.all(users.map(async u => {
      const [accountCount, videoCount, postedCount] = await Promise.all([
        Account.countDocuments({ userId: u._id }),
        Video.countDocuments({ userId: u._id }),
        Video.countDocuments({ userId: u._id, status: "posted" }),
      ]);
      return { ...u.toObject(), accountCount, videoCount, postedCount };
    }));

    res.json({ users: enriched, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

// ── Get user details ──
router.get("/users/:id", async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select("-password -emailVerifyToken -resetToken");
    if (!user) return res.status(404).json({ error: "User not found" });

    const [accounts, recentVideos, recentActivity] = await Promise.all([
      Account.find({ userId: user._id }).select("-sessionData -igPassword"),
      Video.find({ userId: user._id }).sort({ createdAt: -1 }).limit(20),
      ActivityLog.find({ userId: user._id }).sort({ createdAt: -1 }).limit(30),
    ]);

    res.json({ user, accounts, recentVideos, recentActivity });
  } catch (err) { next(err); }
});

// ── Update user (plan, status, role) ──
router.put("/users/:id", async (req, res, next) => {
  try {
    const { plan, isActive, role } = req.body;
    const update = {};
    if (plan) update.plan = plan;
    if (isActive !== undefined) update.isActive = isActive;
    if (role) update.role = role;

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true })
      .select("-password -emailVerifyToken -resetToken");
    if (!user) return res.status(404).json({ error: "User not found" });

    logger.info(`Admin updated user ${user.email}`, { update, adminId: req.user.id });
    res.json(user);
  } catch (err) { next(err); }
});

// ── System: recent errors ──
router.get("/errors", async (req, res, next) => {
  try {
    const recentErrors = await Video.find({ status: "failed" })
      .sort({ updatedAt: -1 })
      .limit(50)
      .populate("accountId", "username")
      .select("videoUrl error accountId status retryCount updatedAt");

    const accountErrors = await Account.find({ status: "error" })
      .select("username errorMessage consecutiveErrors lastErrorAt userId");

    res.json({ videoErrors: recentErrors, accountErrors });
  } catch (err) { next(err); }
});

// ── System: queue health ──
router.get("/queue-health", async (req, res, next) => {
  try {
    const statusCounts = await Video.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const staleProcessing = await Video.countDocuments({
      status: { $in: ["downloading", "posting"] },
      updatedAt: { $lt: new Date(Date.now() - 10 * 60000) },
    });

    res.json({ statusCounts, staleProcessing });
  } catch (err) { next(err); }
});

module.exports = router;
