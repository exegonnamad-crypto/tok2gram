const axios = require("axios");
const fs = require("fs");
const logger = require("../utils/logger");

const GRAPH_API = "https://graph.facebook.com/v19.0";

/**
 * Post a Reel to Facebook via Graph API
 * Requires page access token with publish_video permission
 */
async function postReel(accessToken, pageId, videoPath, caption) {
  if (!accessToken || !pageId) {
    return {
      success: false,
      error: "Facebook access token and page ID required. Connect your Facebook page via OAuth.",
    };
  }

  if (!fs.existsSync(videoPath)) {
    return { success: false, error: "Video file not found" };
  }

  try {
    // Step 1: Initialize Reel upload
    const initRes = await axios.post(
      `${GRAPH_API}/${pageId}/video_reels`,
      { upload_phase: "start" },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30000,
      }
    );

    const videoId = initRes.data?.video_id;
    if (!videoId) throw new Error("Failed to initialize Facebook Reel upload");

    // Step 2: Upload video binary
    const fileSize = fs.statSync(videoPath).size;
    const fileStream = fs.createReadStream(videoPath);

    await axios.post(
      `${GRAPH_API}/${videoId}`,
      fileStream,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "video/mp4",
          "Content-Length": fileSize,
          file_url: undefined,
        },
        params: { upload_phase: "transfer", start_offset: 0 },
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    // Step 3: Finish and publish
    const finishRes = await axios.post(
      `${GRAPH_API}/${pageId}/video_reels`,
      {
        upload_phase: "finish",
        video_id: videoId,
        video_state: "PUBLISHED",
        description: caption || "",
      },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30000,
      }
    );

    const reelId = finishRes.data?.id || videoId;
    const postUrl = `https://www.facebook.com/reel/${reelId}`;

    logger.info("Facebook Reel posted", { reelId });
    return {
      success: true,
      reelId,
      postUrl,
    };
  } catch (err) {
    logger.error("Facebook post failed", { error: err.message });
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message || "Facebook posting failed",
    };
  }
}

/**
 * Get Facebook OAuth URL
 */
function getOAuthUrl(appId, redirectUri, state) {
  const scope = "pages_manage_posts,pages_read_engagement,publish_video";
  return `https://www.facebook.com/v19.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}&response_type=code`;
}

/**
 * Exchange auth code for access token
 */
async function getAccessToken(code, appId, appSecret, redirectUri) {
  try {
    const { data } = await axios.get(`${GRAPH_API}/oauth/access_token`, {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      },
    });

    return {
      success: true,
      accessToken: data.access_token,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get user's Facebook pages
 */
async function getPages(userAccessToken) {
  try {
    const { data } = await axios.get(`${GRAPH_API}/me/accounts`, {
      headers: { Authorization: `Bearer ${userAccessToken}` },
    });

    return {
      success: true,
      pages: (data.data || []).map(p => ({
        id: p.id,
        name: p.name,
        accessToken: p.access_token,
      })),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { postReel, getOAuthUrl, getAccessToken, getPages };
