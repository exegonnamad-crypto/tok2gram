const mongoose = require("mongoose");

const contentSourceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

  // Source type
  type: {
    type: String,
    required: true,
    enum: ["creator", "hashtag", "trending"]
  },

  // Source identifier
  platform: { type: String, default: "tiktok", enum: ["tiktok", "youtube", "instagram"] },
  identifier: { type: String, required: true, trim: true }, // @username or #hashtag

  // Destination
  destinationAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },

  // Auto-import settings
  autoImport: { type: Boolean, default: true },
  maxPerDay: { type: Number, default: 5, min: 1, max: 50 },
  minViews: { type: Number, default: 0 },
  minLikes: { type: Number, default: 0 },

  // Caption handling
  captionStyle: { type: String, default: "original", enum: ["original", "custom", "ai", "none"] },
  customCaption: { type: String, default: "" },
  appendHashtags: { type: String, default: "" },

  // Filtering
  keywords: [{ type: String }], // only import if contains these words
  excludeKeywords: [{ type: String }], // skip if contains these words

  // Status
  status: { type: String, default: "active", enum: ["active", "paused"] },
  lastCheckedAt: Date,
  lastImportedAt: Date,
  totalImported: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

contentSourceSchema.index({ userId: 1, status: 1 });
contentSourceSchema.index({ status: 1, lastCheckedAt: 1 });
contentSourceSchema.pre("save", function () { this.updatedAt = new Date(); });

module.exports = mongoose.model("ContentSource", contentSourceSchema);
