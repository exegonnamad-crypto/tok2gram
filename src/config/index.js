require("dotenv").config();

module.exports = {
  port: process.env.PORT || 3001,
  nodeEnv: process.env.NODE_ENV || "development",
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY || "default_dev_key_change_in_production_64chars",
  geminiApiKey: process.env.GEMINI_API_KEY,

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },

  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },

  // Platform OAuth
  tiktok: {
    clientKey: process.env.TIKTOK_CLIENT_KEY,
    clientSecret: process.env.TIKTOK_CLIENT_SECRET,
  },

  nowpayments: {
    apiKey: process.env.NOWPAYMENTS_API_KEY,
    ipnSecret: process.env.NOWPAYMENTS_IPN_SECRET,
  },

  frontendUrls: [
    "https://reelflow.pages.dev",
    "https://t2g.pages.dev",
    "http://localhost:5173",
    "http://localhost:4173",
    "http://localhost:4174",
    "http://localhost:3000",
    process.env.FRONTEND_URL,
  ].filter(Boolean),

  // Plan limits
  plans: {
    free: {
      maxAccounts: 2,
      maxPostsPerDay: 10,
      maxVideosInQueue: 50,
      maxBulkUpload: 10,
      maxWorkflows: 2,
      features: ["basic_scheduling", "basic_captions", "ai_captions"],
    },
    pro: {
      maxAccounts: 25,
      maxPostsPerDay: 100,
      maxVideosInQueue: 5000,
      maxBulkUpload: 100,
      maxWorkflows: 50,
      features: ["basic_scheduling", "basic_captions", "ai_captions", "multi_platform", "priority_queue", "analytics", "webhooks", "api_access"],
    },
    agency: {
      maxAccounts: 100,
      maxPostsPerDay: 500,
      maxVideosInQueue: 20000,
      maxBulkUpload: 500,
      maxWorkflows: 200,
      features: ["basic_scheduling", "basic_captions", "ai_captions", "multi_platform", "priority_queue", "analytics", "webhooks", "api_access", "team", "white_label"],
    },
  },

  // Supported source platforms (where videos are downloaded from)
  platforms: {
    tiktok: { name: "TikTok", patterns: ["tiktok.com"] },
    instagram: { name: "Instagram Reels", patterns: ["instagram.com/reel", "instagram.com/p/"] },
    twitter: { name: "Twitter/X", patterns: ["twitter.com", "x.com"] },
  },

  // Supported destination platforms (where videos are posted to)
  destinations: ["instagram", "tiktok"],

  // Niches
  niches: [
    "General", "Fitness", "Cars", "Motivation", "Anime", "Gaming",
    "Finance", "Fashion", "Food", "Travel", "Music", "Art",
    "Comedy", "Education", "Tech", "Pets", "Sports", "Crypto",
    "Luxury", "Beauty", "Health", "Real Estate", "Lifestyle",
  ],
};
