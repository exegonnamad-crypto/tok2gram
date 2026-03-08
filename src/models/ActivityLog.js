const mongoose = require("mongoose");

const activityLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
  videoId: { type: mongoose.Schema.Types.ObjectId, ref: "Video" },

  accountUsername: { type: String, default: "" },
  action: { type: String, required: true, enum: [
    "connected", "disconnected", "posted", "failed", "queued",
    "downloaded", "scheduled", "retried", "cancelled",
    "login", "register", "password_reset",
    "account_paused", "account_resumed", "account_error",
    "workflow_created", "workflow_updated", "workflow_deleted",
    "plan_upgraded", "plan_downgraded",
    "bulk_upload", "clear_failed",
    "system_retry", "system_error",
  ]},
  message: { type: String, default: "" },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

  createdAt: { type: Date, default: Date.now },
});

activityLogSchema.index({ userId: 1, createdAt: -1 });
activityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 });

module.exports = mongoose.model("ActivityLog", activityLogSchema);
