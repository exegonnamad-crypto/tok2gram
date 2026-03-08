const mongoose = require("mongoose");

const accountSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

  // Platform info
  platform: { type: String, default: "instagram", enum: ["instagram", "tiktok", "youtube", "facebook"] },
  username: { type: String, required: true, trim: true },

  // Credentials (encrypted)
  igPassword: { type: String, default: "" },
  igUserId: { type: String, default: "" },
  profilePic: { type: String, default: "" },

  // Session management
  sessionData: { type: String, default: "" },
  sessionSavedAt: Date,
  sessionExpiresAt: Date,

  // Posting configuration
  niche: { type: String, default: "General" },
  postsPerDay: { type: Number, default: 5, min: 1, max: 25 },
  postingTimes: { type: [String], default: ["09:00", "12:00", "15:00", "18:00", "21:00"] },
  timezone: { type: String, default: "UTC" },

  // Caption configuration
  captionStyle: { type: String, default: "original", enum: ["original", "custom", "none", "ai"] },
  customCaption: { type: String, default: "", maxlength: 2200 },
  captionTemplate: { type: String, default: "" },
  appendHashtags: { type: Boolean, default: true },
  hashtags: { type: String, default: "", maxlength: 2200 },

  // Advanced settings
  autoRequeue: { type: Boolean, default: false },
  requeueDelay: { type: Number, default: 24 },
  removeWatermark: { type: Boolean, default: true },

  // Posting delays (to appear human)
  minPostDelay: { type: Number, default: 60 },
  maxPostDelay: { type: Number, default: 300 },

  // Status & stats
  status: { type: String, default: "active", enum: ["active", "paused", "error", "pending_verification"] },
  errorMessage: { type: String, default: "" },
  totalPosted: { type: Number, default: 0 },
  totalFailed: { type: Number, default: 0 },
  lastPostedAt: Date,
  lastErrorAt: Date,
  consecutiveErrors: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

accountSchema.index({ userId: 1, platform: 1 });
accountSchema.index({ status: 1 });
accountSchema.pre("save", function () { this.updatedAt = new Date(); });

module.exports = mongoose.model("Account", accountSchema);
