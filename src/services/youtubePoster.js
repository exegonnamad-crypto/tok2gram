const axios = require("axios");
const fs = require("fs");
const logger = require("../utils/logger");

/**
 * Upload a Short to YouTube via Data API v3
 * Requires OAuth2 access token with youtube.upload scope
 */
async function postShort(accessToken, videoPath, caption) {
  if (!accessToken) {
    return {
      success: false,
      error: "YouTube access token required. Connect your YouTube account via OAuth.",
    };
  }

  if (!fs.existsSync(videoPath)) {
    return { success: false, error: "Video file not found" };
  }

  try {
    // Step 1: Initialize resumable upload
    const title = (caption || "").split("\n")[0].slice(0, 100) || "Short video";
    const description = caption || "";
    const tags = description.match(/#\w+/g)?.map(t => t.replace("#", "")) || [];

    const initRes = await axios.post(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        snippet: {
          title: title + " #Shorts",
          description,
          tags: tags.slice(0, 15),
          categoryId: "22", // People & Blogs
        },
        status: {
          privacyStatus: "public",
          selfDeclaredMadeForKids: false,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": "video/mp4",
          "X-Upload-Content-Length": fs.statSync(videoPath).size,
        },
        timeout: 30000,
      }
    );

    const uploadUrl = initRes.headers.location;
    if (!uploadUrl) throw new Error("Failed to get upload URL from YouTube");

    // Step 2: Upload video data
    const fileStream = fs.createReadStream(videoPath);
    const uploadRes = await axios.put(uploadUrl, fileStream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": fs.statSync(videoPath).size,
      },
      timeout: 300000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const videoId = uploadRes.data?.id;
    const postUrl = videoId ? `https://youtube.com/shorts/${videoId}` : "";

    logger.info("YouTube Short posted", { videoId });
    return {
      success: true,
      videoId,
      postUrl,
    };
  } catch (err) {
    logger.error("YouTube post failed", { error: err.message });
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message || "YouTube posting failed",
    };
  }
}

/**
 * Get YouTube OAuth URL
 */
function getOAuthUrl(clientId, redirectUri, state) {
  const scope = "https://www.googleapis.com/auth/youtube.upload";
  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}&access_type=offline&prompt=consent`;
}

/**
 * Exchange auth code for access token
 */
async function getAccessToken(code, clientId, clientSecret, redirectUri) {
  try {
    const { data } = await axios.post("https://oauth2.googleapis.com/token", {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });

    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Refresh access token
 */
async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  try {
    const { data } = await axios.post("https://oauth2.googleapis.com/token", {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    return {
      success: true,
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { postShort, getOAuthUrl, getAccessToken, refreshAccessToken };
