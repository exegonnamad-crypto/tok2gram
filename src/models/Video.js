const mongoose = require("mongoose");

const videoSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account", required: true, index: true },
  workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "Workflow" },

  // Source info
  videoUrl: { type: String, required: true },
  sourcePlatform: { type: String, default: "tiktok", enum: ["tiktok", "instagram", "twitter", "upload", "unknown"] },
  videoAuthor: { type: String, default: "" },
  videoId: { type: String, default: "" },
  originalCaption: { type: String, default: "" },

  // Storage
  localPath: { type: String, default: "" },
  cloudinaryUrl: { type: String, default: "" },
  cloudinaryPublicId: { type: String, default: "" },
  thumbnailUrl: { type: String, default: "" },

  // Video metadata
  duration: { type: Number, default: 0 },
  fileSize: { type: Number, default: 0 },
  width: { type: Number, default: 0 },
  height: { type: Number, default: 0 },

  // Caption (what gets posted)
  captionMode: { type: String, default: "original", enum: ["original", "ai", "template", "custom", "none"] },
  caption: { type: String, default: "", maxlength: 2200 },
  customCaption: { type: String, default: "" },
  templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Workflow" },
  hashtags: { type: String, default: "" },
  firstComment: { type: String, default: "" },

  // Scheduling
  scheduledFor: Date,
  priority: { type: Number, default: 0 },

  // Status tracking
  status: {
    type: String,
    enum: ["queued", "downloading", "downloaded", "scheduled", "posting", "posted", "failed", "cancelled"],
    default: "queued",
    index: true,
  },

  // Post result
  postedAt: Date,
  igPostId: { type: String, default: "" },
  postUrl: { type: String, default: "" },

  // Error handling
  error: { type: String, default: "" },
  retryCount: { type: Number, default: 0 },
  maxRetries: { type: Number, default: 3 },
  lastRetryAt: Date,

  // Analytics (post-publish tracking)
  analytics: {
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    shares: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    lastFetchedAt: Date,
  },

  // Viral Score
  viralScore: {
    overall: { type: Number, default: 0 },
    hook: { type: Number, default: 0 },
    caption: { type: Number, default: 0 },
    hashtags: { type: Number, default: 0 },
    timing: { type: Number, default: 0 },
    tier: { type: String, enum: ["low", "medium", "high", "viral", ""], default: "" },
    suggestions: [String],
    analyzedAt: Date,
  },

  // Video transformation (SSCD fingerprint bypass)
  transformVideo: { type: Boolean, default: true },
  transformed: { type: Boolean, default: false },
  transformedPath: { type: String, default: "" },

  // Evergreen
  isEvergreen: { type: Boolean, default: false },
  evergreenConfig: {
    recycleDays: { type: Number, default: 7 },
    maxRecycles: { type: Number, default: 0 },
    timesRecycled: { type: Number, default: 0 },
    lastRecycledAt: Date,
  },

  // A/B Testing
  abTest: {
    testId: String,
    variant: { type: String, enum: ["A", "B", "C", ""] , default: "" },
    isWinner: { type: Boolean, default: false },
  },

  // Performance score (calculated)
  performanceScore: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

videoSchema.index({ userId: 1, status: 1 });
videoSchema.index({ accountId: 1, status: 1 });
videoSchema.index({ scheduledFor: 1, status: 1 });
videoSchema.index({ createdAt: -1 });
videoSchema.pre("save", function () { this.updatedAt = new Date(); });

module.exports = mongoose.model("Video", videoSchema);
