const cron = require("node-cron");
const fs = require("fs");
const logger = require("../utils/logger");
const { currentTimeUTC, todayStartUTC, daysAgo, sleep } = require("../utils/helpers");
const Video = require("../models/Video");
const Account = require("../models/Account");
const User = require("../models/User");
const Workflow = require("../models/Workflow");
const ActivityLog = require("../models/ActivityLog");
const instagramService = require("./instagram");
const platformRouter = require("./platformRouter");
const downloader = require("./downloader");
const captionService = require("./captionService");
const notificationService = require("./notificationService");
const { transformVideo } = require("./videoTransformService");

/**
 * Post a video to Instagram
 */
async function postToInstagram(videoId) {
  const video = await Video.findById(videoId).populate("accountId");
  if (!video?.accountId) return;
  const account = video.accountId;

  if (!account.sessionData) {
    await Video.findByIdAndUpdate(videoId, {
      status: "failed",
      error: "No session — please reconnect your Instagram account",
    });
    return;
  }

  try {
    await Video.findByIdAndUpdate(videoId, { status: "posting", error: "" });

    // Get local file — download from Cloudinary if needed
    let videoPath = video.localPath;
    if (!videoPath || !fs.existsSync(videoPath)) {
      if (!video.cloudinaryUrl) throw new Error("No video file available");
      videoPath = await downloader.downloadFromCloudinary(videoId, video.cloudinaryUrl);
    }

    // Transform video to bypass Instagram SSCD fingerprinting
    if (video.transformVideo) {
      try {
        logger.info(`Transforming video before posting`, { videoId });
        const transformedPath = await transformVideo(videoPath, { enabled: true, intensity: "medium" });
        if (transformedPath !== videoPath) {
          videoPath = transformedPath;
          await Video.findByIdAndUpdate(videoId, {
            transformed: true,
            transformedPath: transformedPath,
          });
        }
      } catch (transformErr) {
        // Non-fatal: if transform fails, post the original video
        logger.warn(`Video transform failed, posting original`, { videoId, error: transformErr.message });
      }
    }

    // Build caption
    const workflow = video.workflowId ? await Workflow.findById(video.workflowId) : null;
    const caption = await captionService.buildCaption(video, account, workflow);

    // Post via platform router (supports Instagram, TikTok, YouTube, Facebook)
    const result = await platformRouter.postVideo(account, videoPath, caption);

    if (!result.success) throw new Error(result.error);

    // Save updated session
    if (result.sessionData) {
      const { encrypt } = require("../utils/crypto");
      await Account.findByIdAndUpdate(account._id, {
        sessionData: encrypt(result.sessionData),
        sessionSavedAt: new Date(),
        consecutiveErrors: 0,
        status: "active",
      });
    }

    // Update video
    await Video.findByIdAndUpdate(videoId, {
      status: "posted",
      postedAt: new Date(),
      igPostId: result.mediaId || "",
      postUrl: result.postUrl || "",
      error: "",
    });

    // Post first comment (e.g. hashtags) if configured — Instagram only
    if (video.firstComment && video.firstComment.trim() && account.platform !== "tiktok") {
      try {
        const commentResult = await instagramService.addFirstComment(
          account.sessionData,
          result.mediaId,
          video.firstComment.trim(),
          account._id
        );
        if (commentResult.success) {
          logger.info(`First comment posted on @${account.username}`, { videoId, commentId: commentResult.commentId });
        } else {
          logger.warn(`First comment failed on @${account.username}: ${commentResult.error}`, { videoId });
        }
      } catch (commentErr) {
        logger.warn(`First comment error on @${account.username}: ${commentErr.message}`, { videoId });
      }
    }

    // Update account stats
    await Account.findByIdAndUpdate(account._id, {
      $inc: { totalPosted: 1 },
      lastPostedAt: new Date(),
      status: "active",
      errorMessage: "",
      consecutiveErrors: 0,
    });

    // Update user stats
    await User.findByIdAndUpdate(account.userId, { $inc: { videosPublished: 1 } });

    // Update workflow stats
    if (video.workflowId) {
      await Workflow.findByIdAndUpdate(video.workflowId, {
        $inc: { videosProcessed: 1 },
        lastProcessedAt: new Date(),
      });
    }

    // Log activity
    await logActivity(account.userId, account._id, account.username, "posted",
      `Posted reel to @${account.username}`, { videoId, postUrl: result.postUrl });

    logger.info(`Posted to @${account.username}`, { videoId, mediaId: result.mediaId });

    // Notify user
    const user = await User.findById(account.userId);
    if (user) {
      await notificationService.notify(user, "post_success", {
        username: account.username,
        caption: caption.slice(0, 100),
      });
    }

    // Auto-requeue if enabled
    if (account.autoRequeue) {
      const delay = (account.requeueDelay || 24) * 3600000;
      await Video.findByIdAndUpdate(videoId, {
        status: "downloaded",
        postedAt: null,
        igPostId: null,
        postUrl: null,
        scheduledFor: new Date(Date.now() + delay),
      });
    }

    // Clean up temp file
    if (videoPath.includes("post_") || videoPath.includes("temp") || videoPath.includes("_transformed")) {
      fs.unlink(videoPath, () => {});
    }

  } catch (err) {
    logger.error(`Post failed @${account.username}`, { videoId, error: err.message });

    // Retry logic
    const v = await Video.findById(videoId);
    if (v && v.retryCount < v.maxRetries) {
      await Video.findByIdAndUpdate(videoId, {
        status: "downloaded",
        $inc: { retryCount: 1 },
        lastRetryAt: new Date(),
        error: `Retry ${v.retryCount + 1}/${v.maxRetries}: ${err.message}`,
      });
      const retryDelay = Math.min(120000 * Math.pow(2, v.retryCount), 600000); // Exponential backoff, max 10min
      setTimeout(() => postToInstagram(videoId), retryDelay);
      return;
    }

    // Mark as permanently failed
    await Video.findByIdAndUpdate(videoId, { status: "failed", error: err.message });
    await Account.findByIdAndUpdate(account._id, {
      $inc: { totalFailed: 1, consecutiveErrors: 1 },
      lastErrorAt: new Date(),
      errorMessage: err.message,
    });

    // Auto-pause account after 5 consecutive errors
    const updatedAccount = await Account.findById(account._id);
    if (updatedAccount.consecutiveErrors >= 5) {
      await Account.findByIdAndUpdate(account._id, { status: "error" });
      await logActivity(account.userId, account._id, account.username, "account_error",
        `Account auto-paused after 5 consecutive errors`);
    }

    await logActivity(account.userId, account._id, account.username, "failed",
      `Post failed: ${err.message}`, { videoId });

    // Notify user
    const user = await User.findById(account.userId);
    if (user) {
      await notificationService.notify(user, "post_failed", {
        username: account.username,
        error: err.message,
      });
    }
  }
}

/**
 * Log activity helper
 */
async function logActivity(userId, accountId, accountUsername, action, message, metadata = {}) {
  try {
    await ActivityLog.create({ userId, accountId, accountUsername, action, message, metadata });
  } catch {}
}

/**
 * Initialize all cron jobs
 */
function startScheduler() {
  // ── Auto-post every minute ──
  cron.schedule("* * * * *", async () => {
    try {
      const time = currentTimeUTC();
      const activeAccounts = await Account.find({ status: "active" });

      for (const acc of activeAccounts) {
        if (!acc.postingTimes.includes(time)) continue;

        const todayStart = todayStartUTC();
        const postedToday = await Video.countDocuments({
          accountId: acc._id,
          status: "posted",
          postedAt: { $gte: todayStart },
        });
        if (postedToday >= acc.postsPerDay) continue;

        const currentlyPosting = await Video.countDocuments({
          accountId: acc._id,
          status: "posting",
        });
        if (currentlyPosting > 0) continue;

        const nextVideo = await Video.findOne({
          accountId: acc._id,
          status: "downloaded",
        }).sort({ priority: -1, createdAt: 1 });

        if (!nextVideo) continue;

        // Random delay to appear more human (30-300 seconds)
        const delay = Math.floor(Math.random() * (acc.maxPostDelay - acc.minPostDelay + 1) + acc.minPostDelay) * 1000;
        logger.info(`Scheduling auto-post for @${acc.username} in ${delay / 1000}s`);
        setTimeout(() => postToInstagram(nextVideo._id), delay);
      }
    } catch (err) {
      logger.error("Scheduler error", { error: err.message });
    }
  });

  // ── Process scheduled videos ──
  cron.schedule("* * * * *", async () => {
    try {
      const now = new Date();
      const scheduledVideos = await Video.find({
        status: "scheduled",
        scheduledFor: { $lte: now },
      }).limit(10);

      for (const video of scheduledVideos) {
        await Video.findByIdAndUpdate(video._id, { status: "queued" });
        setTimeout(() => downloader.processVideo(video._id, video.videoUrl), 1000);
      }
    } catch (err) {
      logger.error("Scheduled video processor error", { error: err.message });
    }
  });

  // ── Auto-retry failed downloads every 30 minutes ──
  cron.schedule("*/30 * * * *", async () => {
    try {
      const failedVideos = await Video.find({
        status: "failed",
        retryCount: { $lt: 3 },
        cloudinaryUrl: { $in: [null, ""] },
      }).limit(20);

      for (let i = 0; i < failedVideos.length; i++) {
        const v = failedVideos[i];
        await Video.findByIdAndUpdate(v._id, {
          status: "queued",
          $inc: { retryCount: 1 },
          error: "",
        });
        setTimeout(() => downloader.processVideo(v._id, v.videoUrl), i * 3000);
      }

      if (failedVideos.length > 0) {
        logger.info(`Auto-retrying ${failedVideos.length} failed downloads`);
      }
    } catch (err) {
      logger.error("Retry cron error", { error: err.message });
    }
  });

  // ── Clean up stale "downloading" or "posting" videos (stuck for >10 min) ──
  cron.schedule("*/5 * * * *", async () => {
    try {
      const staleTime = new Date(Date.now() - 10 * 60000);
      const stale = await Video.updateMany(
        { status: { $in: ["downloading", "posting"] }, updatedAt: { $lt: staleTime } },
        { status: "failed", error: "Timed out — stuck in processing" }
      );
      if (stale.modifiedCount > 0) {
        logger.warn(`Reset ${stale.modifiedCount} stale videos`);
      }
    } catch (err) {
      logger.error("Stale cleanup error", { error: err.message });
    }
  });

  // ── Daily cleanup: old temp files ──
  cron.schedule("0 3 * * *", async () => {
    try {
      const fs = require("fs");
      const path = require("path");
      const tempDir = path.join(downloader.DOWNLOAD_DIR, "temp");
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        let cleaned = 0;
        for (const file of files) {
          const filePath = path.join(tempDir, file);
          const stat = fs.statSync(filePath);
          if (Date.now() - stat.mtimeMs > 24 * 3600000) {
            fs.unlinkSync(filePath);
            cleaned++;
          }
        }
        if (cleaned > 0) logger.info(`Cleaned ${cleaned} temp files`);
      }
    } catch (err) {
      logger.error("Temp cleanup error", { error: err.message });
    }
  });

  // ── Weekly digest emails (Sunday 9 AM UTC) ──
  cron.schedule("0 9 * * 0", async () => {
    try {
      const emailService = require("./emailService");
      const users = await User.find({ "notifications.weeklyDigest": true, isActive: true });

      for (const user of users) {
        const weekStart = daysAgo(7);
        const stats = {
          posted: await Video.countDocuments({ userId: user._id, status: "posted", postedAt: { $gte: weekStart } }),
          failed: await Video.countDocuments({ userId: user._id, status: "failed", createdAt: { $gte: weekStart } }),
          queued: await Video.countDocuments({ userId: user._id, status: { $in: ["queued", "downloaded", "scheduled"] } }),
          activeAccounts: await Account.countDocuments({ userId: user._id, status: "active" }),
        };
        await emailService.sendWeeklyDigest(user.email, user.name, stats);
        await sleep(1000); // Don't blast emails
      }
    } catch (err) {
      logger.error("Weekly digest error", { error: err.message });
    }
  });

  // ── Auto-import from content sources every 2 hours ──
  cron.schedule("0 */2 * * *", async () => {
    try {
      const ContentSource = require("../models/ContentSource");
      const contentDiscovery = require("./contentDiscovery");

      const sources = await ContentSource.find({
        status: "active",
        autoImport: true,
      }).limit(50);

      let totalImported = 0;
      for (let i = 0; i < sources.length; i++) {
        const result = await contentDiscovery.processSource(sources[i]);
        totalImported += result.imported || 0;
        // Delay between sources to avoid rate limiting
        if (i < sources.length - 1) await sleep(5000);
      }

      if (totalImported > 0) {
        logger.info(`Auto-import: ${totalImported} videos from ${sources.length} sources`);
      }
    } catch (err) {
      logger.error("Auto-import cron error", { error: err.message });
    }
  });

  logger.info("All schedulers started");
}

module.exports = { postToInstagram, logActivity, startScheduler };
