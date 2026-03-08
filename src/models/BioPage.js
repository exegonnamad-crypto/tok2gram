const mongoose = require("mongoose");

const bioPageSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
  },
  username: {
    type: String,
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^[a-z0-9_-]{3,30}$/, "Username must be 3-30 characters (letters, numbers, underscore, hyphen)"],
  },
  displayName: { type: String, trim: true, maxlength: 60 },
  bio: { type: String, trim: true, maxlength: 300 },
  avatar: { type: String, default: "" },

  theme: {
    type: String,
    enum: ["midnight", "ocean", "sunset", "forest", "neon", "minimal", "gradient", "glass"],
    default: "midnight",
  },

  customColors: {
    bg: { type: String, default: "" },
    text: { type: String, default: "" },
    accent: { type: String, default: "" },
    cardBg: { type: String, default: "" },
  },

  links: [
    {
      id: { type: String, required: true },
      title: { type: String, required: true, maxlength: 80 },
      url: { type: String, required: true },
      icon: { type: String, default: "" },
      clicks: { type: Number, default: 0 },
      isActive: { type: Boolean, default: true },
    },
  ],

  socialLinks: {
    instagram: { type: String, default: "" },
    tiktok: { type: String, default: "" },
    youtube: { type: String, default: "" },
    twitter: { type: String, default: "" },
    spotify: { type: String, default: "" },
    github: { type: String, default: "" },
  },

  blocks: [
    {
      id: { type: String, required: true },
      type: {
        type: String,
        enum: ["link", "header", "video", "image", "email-capture", "text", "divider", "social-icons"],
        required: true,
      },
      content: { type: mongoose.Schema.Types.Mixed, default: {} },
      order: { type: Number, default: 0 },
      isActive: { type: Boolean, default: true },
    },
  ],

  settings: {
    showReelFlowBadge: { type: Boolean, default: true },
    customFont: { type: String, default: "" },
    animation: {
      type: String,
      enum: ["none", "fade", "slide", "bounce"],
      default: "fade",
    },
  },

  analytics: {
    totalViews: { type: Number, default: 0 },
    uniqueVisitors: { type: Number, default: 0 },
    lastViewedAt: { type: Date },
  },

  isPublished: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

bioPageSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

// Indexes already created via `unique: true` on username and userId fields

module.exports = mongoose.model("BioPage", bioPageSchema);
