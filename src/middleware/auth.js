const jwt = require("jsonwebtoken");
const config = require("../config");
const User = require("../models/User");

/**
 * JWT auth middleware — validates Bearer token
 */
async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired — please login again" });
    }
    res.status(401).json({ error: "Invalid token" });
  }
}

/**
 * Optional auth — sets req.user if token present, but doesn't block
 */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return next();
  try {
    req.user = jwt.verify(header.split(" ")[1], config.jwtSecret);
  } catch {}
  next();
}

/**
 * Admin-only middleware
 */
async function adminOnly(req, res, next) {
  try {
    const user = await User.findById(req.user.id);
    if (!user || user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    req.adminUser = user;
    next();
  } catch {
    res.status(403).json({ error: "Access denied" });
  }
}

/**
 * API key auth — for programmatic access
 */
async function apiKeyAuth(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return auth(req, res, next);

  try {
    const user = await User.findOne({ apiKey, isActive: true });
    if (!user) return res.status(401).json({ error: "Invalid API key" });

    const planConfig = config.plans[user.plan];
    if (!planConfig?.features?.includes("api_access")) {
      return res.status(403).json({ error: "API access requires Pro plan or above" });
    }

    req.user = { id: user._id.toString() };
    next();
  } catch {
    res.status(401).json({ error: "Invalid API key" });
  }
}

module.exports = { auth, optionalAuth, adminOnly, apiKeyAuth };
