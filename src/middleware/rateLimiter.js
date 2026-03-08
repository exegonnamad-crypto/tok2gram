const rateLimit = require("express-rate-limit");

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  message: { error: "Too many requests — please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth endpoints — stricter but reasonable
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Too many login attempts — please try again in 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown',
});

// Bulk upload — moderate
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { error: "Upload rate limit reached — wait a moment" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Instagram verify — strict (to prevent abuse)
const verifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: "Too many verification attempts — try again in an hour" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Post-now — moderate
const postNowLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Posting too fast — wait a moment" },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { apiLimiter, authLimiter, uploadLimiter, verifyLimiter, postNowLimiter };
