const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 255 },
  password: { type: String, required: true },

  // Plan & billing
  plan: { type: String, default: "free", enum: ["free", "pro", "agency"] },
  trialEndsAt: { type: Date, default: () => new Date(Date.now() + 14 * 86400000) },
  planExpiresAt: Date,
  paymentProvider: { type: String, default: "none", enum: ["none", "crypto"] },
  lastPaymentId: String,
  lastPaymentAt: Date,
  autoRenew: { type: Boolean, default: true },

  // Stats
  videosPublished: { type: Number, default: 0 },
  totalUploaded: { type: Number, default: 0 },

  // Email verification
  emailVerified: { type: Boolean, default: false },
  emailVerifyToken: String,
  emailVerifyExpires: Date,

  // Password reset
  resetToken: String,
  resetTokenExpires: Date,

  // Preferences
  timezone: { type: String, default: "UTC" },
  notifications: {
    postFailure: { type: Boolean, default: true },
    tokenExpiry: { type: Boolean, default: true },
    weeklyDigest: { type: Boolean, default: false },
    discordWebhook: { type: String, default: "" },
    slackWebhook: { type: String, default: "" },
    telegramBotToken: { type: String, default: "" },
    telegramChatId: { type: String, default: "" },
  },

  // API access
  apiKey: { type: String, unique: true, sparse: true },
  apiKeyCreatedAt: Date,

  // Admin
  role: { type: String, default: "user", enum: ["user", "admin"] },
  isActive: { type: Boolean, default: true },
  lastLoginAt: Date,
  loginCount: { type: Number, default: 0 },

  // AI Brand Voice
  brandVoice: { type: Object, default: null },

  // Gamification
  streaks: {
    current: { type: Number, default: 0 },
    longest: { type: Number, default: 0 },
    lastPostDate: Date,
  },
  achievements: [{ type: String }],
  xp: { type: Number, default: 0 },
  level: { type: Number, default: 1 },

  createdAt: { type: Date, default: Date.now },
});

userSchema.index({ role: 1 });

module.exports = mongoose.model("User", userSchema);
