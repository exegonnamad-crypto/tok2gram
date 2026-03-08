const config = require("../config");
const User = require("../models/User");
const Account = require("../models/Account");
const Video = require("../models/Video");
const Workflow = require("../models/Workflow");

/**
 * Check if user's plan allows the action
 */
function checkPlan(limitType) {
  return async (req, res, next) => {
    try {
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ error: "User not found" });

      const plan = config.plans[user.plan] || config.plans.free;

      // Check trial expiry for free users
      if (user.plan === "free" && user.trialEndsAt && new Date() > user.trialEndsAt) {
        // Trial expired — still allow limited access but restrict some features
      }

      switch (limitType) {
        case "accounts": {
          const count = await Account.countDocuments({ userId: req.user.id });
          if (count >= plan.maxAccounts) {
            return res.status(403).json({
              error: `Your ${user.plan} plan allows up to ${plan.maxAccounts} accounts. Upgrade to add more.`,
              limit: plan.maxAccounts,
              current: count,
              upgrade: true,
            });
          }
          break;
        }

        case "videos": {
          const queueCount = await Video.countDocuments({
            userId: req.user.id,
            status: { $in: ["queued", "downloading", "downloaded", "scheduled"] },
          });
          if (queueCount >= plan.maxVideosInQueue) {
            return res.status(403).json({
              error: `Queue limit reached (${plan.maxVideosInQueue} videos). Upgrade for more capacity.`,
              limit: plan.maxVideosInQueue,
              current: queueCount,
              upgrade: true,
            });
          }
          break;
        }

        case "bulk_upload": {
          const { links } = req.body;
          if (links && links.length > plan.maxBulkUpload) {
            return res.status(403).json({
              error: `Your plan allows up to ${plan.maxBulkUpload} links per upload. You sent ${links.length}.`,
              limit: plan.maxBulkUpload,
              upgrade: true,
            });
          }
          break;
        }

        case "workflows": {
          const count = await Workflow.countDocuments({ userId: req.user.id });
          if (count >= plan.maxWorkflows) {
            return res.status(403).json({
              error: `Your ${user.plan} plan allows up to ${plan.maxWorkflows} workflows. Upgrade for more.`,
              limit: plan.maxWorkflows,
              current: count,
              upgrade: true,
            });
          }
          break;
        }

        case "feature": {
          const feature = req.requiredFeature;
          if (feature && !plan.features.includes(feature)) {
            return res.status(403).json({
              error: `This feature requires a Pro plan or above.`,
              feature,
              upgrade: true,
            });
          }
          break;
        }
      }

      req.userPlan = plan;
      req.userDoc = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Require a specific feature
 */
function requireFeature(feature) {
  return (req, res, next) => {
    req.requiredFeature = feature;
    checkPlan("feature")(req, res, next);
  };
}

module.exports = { checkPlan, requireFeature };
