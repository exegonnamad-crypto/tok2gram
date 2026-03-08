const instagramService = require("./instagram");
const tiktokPoster = require("./tiktokPoster");
const logger = require("../utils/logger");

/**
 * Route video posting to the correct platform (Instagram & TikTok only)
 */
async function postVideo(account, videoPath, caption) {
  const platform = account.platform || "instagram";

  logger.info(`Posting to ${platform} @${account.username}`);

  switch (platform) {
    case "instagram":
      return instagramService.postReel(
        account.sessionData,
        videoPath,
        caption,
        String(account._id)
      );

    case "tiktok":
      return tiktokPoster.postVideo(
        account.sessionData,
        videoPath,
        caption
      );

    default:
      throw new Error(`Platform not supported: ${platform}. Only Instagram and TikTok are supported.`);
  }
}

/**
 * Get OAuth URL for platform account connection
 */
function getOAuthUrl(platform, state) {
  const redirectBase = process.env.BACKEND_URL || "http://localhost:3001";
  const redirectUri = `${redirectBase}/api/accounts/oauth/callback`;

  switch (platform) {
    case "tiktok":
      return tiktokPoster.getOAuthUrl(
        process.env.TIKTOK_CLIENT_KEY,
        redirectUri,
        state
      );

    default:
      return null;
  }
}

module.exports = { postVideo, getOAuthUrl };
