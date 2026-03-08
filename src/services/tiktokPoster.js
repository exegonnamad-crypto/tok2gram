const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const logger = require("../utils/logger");

/**
 * Post video to TikTok
 * Note: TikTok's Content Posting API requires app approval.
 * This uses the Share to TikTok flow via Content Posting API (v2)
 * Requires TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET env vars
 */

async function initUpload(accessToken, videoPath) {
  const stats = fs.statSync(videoPath);
  const fileSize = stats.size;

  try {
    const { data } = await axios.post(
      "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/",
      {
        source_info: {
          source: "FILE_UPLOAD",
          video_size: fileSize,
          chunk_size: fileSize,
          total_chunk_count: 1,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    return data?.data?.publish_id || null;
  } catch (err) {
    logger.error("TikTok init upload failed", { error: err.message });
    return null;
  }
}

async function postVideo(accessToken, videoPath, caption) {
  if (!accessToken) {
    return {
      success: false,
      error: "TikTok access token required. Connect your TikTok account via OAuth.",
    };
  }

  if (!fs.existsSync(videoPath)) {
    return { success: false, error: "Video file not found" };
  }

  try {
    // Step 1: Initialize upload
    const publishId = await initUpload(accessToken, videoPath);
    if (!publishId) {
      return {
        success: false,
        error: "Failed to initialize TikTok upload. Token may be expired.",
      };
    }

    // Step 2: Upload video file
    const fileStream = fs.createReadStream(videoPath);
    const stats = fs.statSync(videoPath);

    await axios.put(
      `https://open.tiktokapis.com/v2/post/publish/inbox/video/upload/`,
      fileStream,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Range": `bytes 0-${stats.size - 1}/${stats.size}`,
          "Content-Type": "video/mp4",
          "X-Upload-Publish-Id": publishId,
        },
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    logger.info("TikTok video posted", { publishId });
    return {
      success: true,
      publishId,
      postUrl: "",
      note: "Video sent to TikTok inbox for publishing",
    };
  } catch (err) {
    logger.error("TikTok post failed", { error: err.message });
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message || "TikTok posting failed",
    };
  }
}

/**
 * Get TikTok OAuth URL for account connection
 */
function getOAuthUrl(clientKey, redirectUri, state) {
  const scope = "user.info.basic,video.publish,video.upload";
  return `https://www.tiktok.com/v2/auth/authorize/?client_key=${clientKey}&scope=${scope}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
}

/**
 * Exchange auth code for access token
 */
async function getAccessToken(code, clientKey, clientSecret, redirectUri) {
  try {
    const { data } = await axios.post(
      "https://open.tiktokapis.com/v2/oauth/token/",
      new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      openId: data.open_id,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { postVideo, getOAuthUrl, getAccessToken };
