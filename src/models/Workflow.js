const mongoose = require("mongoose");

const workflowSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, default: "", maxlength: 500 },

  // Destination
  destinationAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },

  // Content settings
  captionStyle: { type: String, default: "original", enum: ["original", "custom", "none", "ai"] },
  customCaption: { type: String, default: "", maxlength: 2200 },
  captionTemplate: { type: String, default: "" },
  hashtags: { type: String, default: "" },
  appendHashtags: { type: Boolean, default: true },

  // Automation
  autoPublish: { type: Boolean, default: true },
  autoRequeue: { type: Boolean, default: false },
  removeWatermark: { type: Boolean, default: true },

  // Schedule override
  postingTimes: [String],
  postsPerDay: Number,

  // Status & stats
  status: { type: String, default: "active", enum: ["active", "paused"] },
  videosProcessed: { type: Number, default: 0 },
  lastProcessedAt: Date,

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

workflowSchema.index({ userId: 1, status: 1 });
workflowSchema.pre("save", function () { this.updatedAt = new Date(); });

module.exports = mongoose.model("Workflow", workflowSchema);
