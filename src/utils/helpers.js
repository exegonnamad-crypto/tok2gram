const config = require("../config");

/**
 * Validate URL format
 */
function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect source platform from URL
 */
function detectPlatform(url) {
  const lower = url.toLowerCase();
  for (const [key, platform] of Object.entries(config.platforms)) {
    if (platform.patterns.some(p => lower.includes(p))) return key;
  }
  return "unknown";
}

/**
 * Sanitize string for safe Python execution — prevent injection
 */
function sanitizeForPython(str) {
  if (!str) return "";
  return str
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
}

/**
 * Get start of today (UTC)
 */
function todayStartUTC() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Get start of N days ago
 */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Get current time as HH:MM string (UTC)
 */
function currentTimeUTC() {
  const now = new Date();
  return `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * Sleep for ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Truncate string to max length
 */
function truncate(str, max = 2200) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) : str;
}

module.exports = {
  isValidUrl,
  detectPlatform,
  sanitizeForPython,
  todayStartUTC,
  daysAgo,
  currentTimeUTC,
  sleep,
  truncate,
};
