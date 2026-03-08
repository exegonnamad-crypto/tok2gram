const axios = require("axios");
const logger = require("../utils/logger");
const Video = require("../models/Video");
const ContentSource = require("../models/ContentSource");
const downloader = require("./downloader");

const TIKWM_API = "https://www.tikwm.com/api";

const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "application/json",
};

function mapVideo(v, fallbackAuthor) {
  const author = v.author?.unique_id || v.author?.nickname || fallbackAuthor || "unknown";
  return {
    videoId: v.video_id || String(v.id),
    videoUrl: `https://www.tiktok.com/@${author}/video/${v.video_id || v.id}`,
    downloadUrl: v.hdplay || v.play || v.wmplay,
    caption: v.title || "",
    author,
    views: v.play_count || 0,
    likes: v.digg_count || 0,
    comments: v.comment_count || 0,
    shares: v.share_count || 0,
    duration: v.duration || 0,
    createTime: v.create_time ? new Date(v.create_time * 1000) : null,
    thumbnail: v.cover || v.origin_cover || "",
  };
}

/**
 * Fetch trending TikTok videos
 */
async function fetchTrending(count = 20) {
  try {
    const { data } = await axios.post(
      `${TIKWM_API}/feed/list`,
      new URLSearchParams({
        count: String(Math.min(count, 30)),
        region: "US",
      }),
      { headers: HEADERS, timeout: 15000 }
    );

    if (data?.code !== 0 || !data?.data) {
      return { success: false, error: data?.msg || "Failed to fetch trending", videos: [] };
    }

    const videoList = Array.isArray(data.data) ? data.data : data.data.videos || [];
    const videos = videoList.map(v => mapVideo(v));

    return { success: true, videos };
  } catch (err) {
    logger.error("Fetch trending failed", { error: err.message });
    return { success: false, error: err.message, videos: [] };
  }
}

/**
 * Search for creators by keyword
 */
async function searchCreators(keyword, count = 10) {
  try {
    const cleanKeyword = keyword.replace("@", "").trim();

    const { data } = await axios.post(
      `${TIKWM_API}/user/search`,
      new URLSearchParams({
        keywords: cleanKeyword,
        count: String(Math.min(count, 20)),
        cursor: "0",
      }),
      { headers: HEADERS, timeout: 15000 }
    );

    if (data?.code !== 0 || !data?.data?.user_list) {
      return { success: false, error: data?.msg || "No creators found", creators: [] };
    }

    const creators = data.data.user_list.map(item => {
      const u = item.user || item;
      return {
        userId: u.id || u.uid,
        username: u.uniqueId || u.unique_id || "",
        nickname: u.nickname || "",
        avatar: u.avatarThumb || u.avatar_thumb || "",
        signature: u.signature || "",
        verified: u.verified || false,
        followers: u.followerCount || item.follower_count || 0,
        following: u.followingCount || item.following_count || 0,
        likes: u.heartCount || u.heart_count || item.total_favorited || 0,
        videos: u.videoCount || u.video_count || 0,
      };
    });

    return { success: true, creators };
  } catch (err) {
    logger.error("Search creators failed", { keyword, error: err.message });
    return { success: false, error: err.message, creators: [] };
  }
}

/**
 * Get creator info
 */
async function getCreatorInfo(username) {
  try {
    const cleanUsername = username.replace("@", "").trim();

    const { data } = await axios.post(
      `${TIKWM_API}/user/info`,
      new URLSearchParams({ unique_id: cleanUsername }),
      { headers: HEADERS, timeout: 15000 }
    );

    if (data?.code !== 0 || !data?.data) {
      return { success: false, error: data?.msg || "Creator not found" };
    }

    const u = data.data.user || {};
    const s = data.data.stats || {};

    return {
      success: true,
      creator: {
        userId: u.id,
        username: u.uniqueId || cleanUsername,
        nickname: u.nickname || "",
        avatar: u.avatarThumb || u.avatarMedium || "",
        signature: u.signature || "",
        verified: u.verified || false,
        followers: s.followerCount || 0,
        following: s.followingCount || 0,
        likes: s.heartCount || s.heart || 0,
        videos: s.videoCount || 0,
      },
    };
  } catch (err) {
    logger.error("Get creator info failed", { username, error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Fetch hashtag videos (2-step: search challenge ID, then get posts)
 */
async function fetchHashtagVideos(hashtag, count = 10) {
  try {
    const cleanTag = hashtag.replace("#", "").trim();

    // Step 1: Search for the challenge to get its ID
    const { data: searchData } = await axios.post(
      `${TIKWM_API}/challenge/search`,
      new URLSearchParams({
        keywords: cleanTag,
        count: "5",
        cursor: "0",
      }),
      { headers: HEADERS, timeout: 15000 }
    );

    if (searchData?.code !== 0 || !searchData?.data?.challenge_list?.length) {
      return { success: false, error: "Hashtag not found", videos: [] };
    }

    // Find best match (exact or first)
    const challenges = searchData.data.challenge_list;
    const exactMatch = challenges.find(
      c => (c.cha_name || c.challenge_info?.cha_name || "").toLowerCase() === cleanTag.toLowerCase()
    );
    const challenge = exactMatch || challenges[0];
    const challengeId = challenge.id || challenge.cid;

    if (!challengeId) {
      return { success: false, error: "Could not resolve hashtag", videos: [] };
    }

    // Step 2: Get videos for this challenge
    const { data } = await axios.post(
      `${TIKWM_API}/challenge/posts`,
      new URLSearchParams({
        challenge_id: String(challengeId),
        count: String(Math.min(count, 30)),
        cursor: "0",
      }),
      { headers: HEADERS, timeout: 15000 }
    );

    if (data?.code !== 0 || !data?.data?.videos) {
      return { success: false, error: data?.msg || "No videos found for hashtag", videos: [] };
    }

    const videos = data.data.videos.map(v => mapVideo(v));

    return {
      success: true,
      videos,
      challengeInfo: {
        id: challengeId,
        name: challenge.cha_name || cleanTag,
        views: challenge.view_count || 0,
        posts: challenge.user_count || 0,
      },
    };
  } catch (err) {
    logger.error("Fetch hashtag videos failed", { hashtag, error: err.message });
    return { success: false, error: err.message, videos: [] };
  }
}

/**
 * Fetch videos from a TikTok creator (uses trending as fallback since user/posts is Cloudflare blocked)
 */
async function fetchCreatorVideos(username, count = 10) {
  try {
    const cleanUsername = username.replace("@", "").trim();

    // Try user/posts first (may be blocked)
    const { data } = await axios.post(
      `${TIKWM_API}/user/posts`,
      new URLSearchParams({
        unique_id: cleanUsername,
        count: String(Math.min(count, 30)),
        cursor: "0",
      }),
      { headers: HEADERS, timeout: 15000 }
    );

    if (data?.code === 0 && data?.data?.videos) {
      const videos = data.data.videos.map(v => mapVideo(v, cleanUsername));
      return { success: true, videos };
    }

    return { success: false, error: "Creator videos unavailable — use search to discover creators", videos: [] };
  } catch (err) {
    logger.error("Fetch creator videos failed", { username, error: err.message });
    return { success: false, error: "Creator videos unavailable — use search to discover creators", videos: [] };
  }
}

/**
 * Process a content source — check for new videos and auto-import
 */
async function processSource(source) {
  try {
    let result;

    switch (source.type) {
      case "creator":
        result = await fetchCreatorVideos(source.identifier, source.maxPerDay * 2);
        break;
      case "hashtag":
        result = await fetchHashtagVideos(source.identifier, source.maxPerDay * 2);
        break;
      case "trending":
        result = await fetchTrending(source.maxPerDay * 2);
        break;
      default:
        return { imported: 0 };
    }

    if (!result.success || !result.videos || result.videos.length === 0) {
      await ContentSource.findByIdAndUpdate(source._id, { lastCheckedAt: new Date() });
      return { imported: 0, error: result.error };
    }

    // Filter videos
    let filtered = result.videos;

    if (source.minViews > 0) {
      filtered = filtered.filter(v => v.views >= source.minViews);
    }
    if (source.minLikes > 0) {
      filtered = filtered.filter(v => v.likes >= source.minLikes);
    }

    if (source.keywords && source.keywords.length > 0) {
      filtered = filtered.filter(v =>
        source.keywords.some(kw => v.caption.toLowerCase().includes(kw.toLowerCase()))
      );
    }
    if (source.excludeKeywords && source.excludeKeywords.length > 0) {
      filtered = filtered.filter(v =>
        !source.excludeKeywords.some(kw => v.caption.toLowerCase().includes(kw.toLowerCase()))
      );
    }

    // Check for duplicates
    const videoUrls = filtered.map(v => v.videoUrl);
    const existing = await Video.find({
      userId: source.userId,
      videoUrl: { $in: videoUrls },
    }).select("videoUrl").lean();
    const existingUrls = new Set(existing.map(v => v.videoUrl));

    const newVideos = filtered.filter(v => !existingUrls.has(v.videoUrl));
    const toImport = newVideos.slice(0, source.maxPerDay);

    if (toImport.length === 0) {
      await ContentSource.findByIdAndUpdate(source._id, { lastCheckedAt: new Date() });
      return { imported: 0 };
    }

    const videos = await Video.insertMany(
      toImport.map((v, i) => ({
        userId: source.userId,
        accountId: source.destinationAccountId,
        videoUrl: v.videoUrl,
        sourcePlatform: source.platform || "tiktok",
        videoAuthor: v.author,
        videoId: v.videoId,
        originalCaption: v.caption,
        caption: source.captionStyle === "custom" ? source.customCaption : v.caption,
        hashtags: source.appendHashtags || "",
        thumbnailUrl: v.thumbnail,
        status: "queued",
        priority: toImport.length - i,
      }))
    );

    videos.forEach((v, i) => {
      setTimeout(() => downloader.processVideo(v._id, v.videoUrl), i * 5000);
    });

    await ContentSource.findByIdAndUpdate(source._id, {
      lastCheckedAt: new Date(),
      lastImportedAt: new Date(),
      $inc: { totalImported: toImport.length },
    });

    logger.info(`Auto-imported ${toImport.length} videos from ${source.type}:${source.identifier}`);
    return { imported: toImport.length };
  } catch (err) {
    logger.error("Process source failed", { sourceId: source._id, error: err.message });
    return { imported: 0, error: err.message };
  }
}

module.exports = {
  fetchCreatorVideos,
  fetchHashtagVideos,
  fetchTrending,
  searchCreators,
  getCreatorInfo,
  processSource,
};
