const axios = require("axios");
const logger = require("../utils/logger");

const TIKWM_API = "https://www.tikwm.com/api";

const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "application/json",
};

// ── Niche multipliers for earnings estimation ──
const NICHE_MULTIPLIERS = {
  fitness: 1.5,
  tech: 1.3,
  beauty: 1.4,
  food: 1.1,
  travel: 1.2,
  finance: 1.8,
  gaming: 1.1,
  fashion: 1.3,
  education: 1.2,
  entertainment: 1.0,
  cars: 1.3,
  motivation: 1.1,
  anime: 1.0,
  music: 1.0,
  art: 1.1,
  comedy: 1.0,
  pets: 1.1,
  sports: 1.2,
  crypto: 1.7,
  luxury: 1.6,
  health: 1.4,
  "real estate": 1.7,
  lifestyle: 1.2,
  general: 1.0,
};

// ── Influencer tier classification ──
function classifyTier(followers) {
  if (followers >= 1000000) return { tier: "mega", label: "Mega Influencer (1M+)" };
  if (followers >= 100000) return { tier: "macro", label: "Macro Influencer (100K-1M)" };
  if (followers >= 10000) return { tier: "mid", label: "Mid-Tier Influencer (10K-100K)" };
  if (followers >= 1000) return { tier: "micro", label: "Micro Influencer (1K-10K)" };
  return { tier: "nano", label: "Nano Influencer (<1K)" };
}

// ── Base CPM rates by tier (USD per 1000 followers) ──
function getBaseCPM(tier) {
  const rates = {
    nano: { sponsored: 10, payout: 0.02, affiliate: 5 },
    micro: { sponsored: 25, payout: 0.03, affiliate: 12 },
    mid: { sponsored: 75, payout: 0.04, affiliate: 30 },
    macro: { sponsored: 250, payout: 0.05, affiliate: 80 },
    mega: { sponsored: 800, payout: 0.06, affiliate: 200 },
  };
  return rates[tier] || rates.nano;
}

// ── Platform payout multipliers ──
function getPlatformMultiplier(platform) {
  const multipliers = {
    tiktok: { sponsored: 1.0, payout: 1.0, affiliate: 1.0 },
    instagram: { sponsored: 1.3, payout: 0.5, affiliate: 1.2 },
    youtube: { sponsored: 1.5, payout: 2.0, affiliate: 1.5 },
    twitter: { sponsored: 0.7, payout: 0.3, affiliate: 0.6 },
  };
  return multipliers[platform] || multipliers.tiktok;
}

/**
 * Calculate estimated earnings for a creator
 */
function calculateEarnings({ platform = "tiktok", followers, engagementRate, postsPerWeek, niche = "general" }) {
  if (!followers || followers <= 0) {
    return { success: false, error: "Followers count is required and must be positive" };
  }

  const cleanNiche = niche.toLowerCase().trim();
  const nicheMultiplier = NICHE_MULTIPLIERS[cleanNiche] || 1.0;
  const tierInfo = classifyTier(followers);
  const baseCPM = getBaseCPM(tierInfo.tier);
  const platformMult = getPlatformMultiplier(platform);

  const effectiveEngagement = Math.min(engagementRate || 3.0, 20);
  const engagementMultiplier = effectiveEngagement / 3.0; // 3% is baseline
  const effectivePostsPerWeek = Math.min(postsPerWeek || 3, 30);

  // ── Per-post earnings by revenue stream ──
  const sponsoredPerPost = (followers / 1000) * baseCPM.sponsored * nicheMultiplier * platformMult.sponsored * engagementMultiplier / 100;
  const payoutPerPost = followers * baseCPM.payout * platformMult.payout * engagementMultiplier / 100;
  const affiliatePerPost = (followers / 1000) * baseCPM.affiliate * nicheMultiplier * platformMult.affiliate * engagementMultiplier / 100;

  const totalPerPost = sponsoredPerPost + payoutPerPost + affiliatePerPost;

  // ── Monthly & yearly (assume ~4.3 weeks/month) ──
  const postsPerMonth = effectivePostsPerWeek * 4.3;
  const monthlyEarnings = totalPerPost * postsPerMonth;
  const yearlyEarnings = monthlyEarnings * 12;

  // ── Growth projections (assuming 10% monthly follower growth) ──
  const monthlyGrowthRate = 0.10;
  const projections = [];
  let projectedFollowers = followers;
  for (let month = 1; month <= 12; month++) {
    projectedFollowers = Math.round(projectedFollowers * (1 + monthlyGrowthRate));
    const projTier = classifyTier(projectedFollowers);
    const projCPM = getBaseCPM(projTier.tier);
    const projSponsored = (projectedFollowers / 1000) * projCPM.sponsored * nicheMultiplier * platformMult.sponsored * engagementMultiplier / 100;
    const projPayout = projectedFollowers * projCPM.payout * platformMult.payout * engagementMultiplier / 100;
    const projAffiliate = (projectedFollowers / 1000) * projCPM.affiliate * nicheMultiplier * platformMult.affiliate * engagementMultiplier / 100;
    const projTotal = (projSponsored + projPayout + projAffiliate) * postsPerMonth;
    projections.push({
      month,
      followers: projectedFollowers,
      tier: projTier.tier,
      estimatedMonthly: Math.round(projTotal * 100) / 100,
    });
  }

  return {
    success: true,
    input: {
      platform,
      followers,
      engagementRate: effectiveEngagement,
      postsPerWeek: effectivePostsPerWeek,
      niche: cleanNiche,
    },
    tier: tierInfo,
    nicheMultiplier,
    earnings: {
      perPost: {
        total: Math.round(totalPerPost * 100) / 100,
        sponsored: Math.round(sponsoredPerPost * 100) / 100,
        platformPayout: Math.round(payoutPerPost * 100) / 100,
        affiliate: Math.round(affiliatePerPost * 100) / 100,
      },
      monthly: {
        total: Math.round(monthlyEarnings * 100) / 100,
        sponsored: Math.round(sponsoredPerPost * postsPerMonth * 100) / 100,
        platformPayout: Math.round(payoutPerPost * postsPerMonth * 100) / 100,
        affiliate: Math.round(affiliatePerPost * postsPerMonth * 100) / 100,
        postsPerMonth: Math.round(postsPerMonth),
      },
      yearly: {
        total: Math.round(yearlyEarnings * 100) / 100,
        sponsored: Math.round(sponsoredPerPost * postsPerMonth * 12 * 100) / 100,
        platformPayout: Math.round(payoutPerPost * postsPerMonth * 12 * 100) / 100,
        affiliate: Math.round(affiliatePerPost * postsPerMonth * 12 * 100) / 100,
      },
    },
    growthProjections: projections,
  };
}

/**
 * Analyze a competitor's TikTok profile and content
 */
async function analyzeCompetitor(username, platform = "tiktok") {
  try {
    const cleanUsername = username.replace("@", "").trim();

    if (!cleanUsername) {
      return { success: false, error: "Username is required" };
    }

    if (platform !== "tiktok") {
      return { success: false, error: "Currently only TikTok competitor analysis is supported" };
    }

    // ── Fetch creator info ──
    const { data: infoData } = await axios.post(
      `${TIKWM_API}/user/info`,
      new URLSearchParams({ unique_id: cleanUsername }),
      { headers: HEADERS, timeout: 15000 }
    );

    if (infoData?.code !== 0 || !infoData?.data) {
      return { success: false, error: infoData?.msg || "Creator not found" };
    }

    const u = infoData.data.user || {};
    const s = infoData.data.stats || {};

    const creatorInfo = {
      username: u.uniqueId || cleanUsername,
      nickname: u.nickname || "",
      avatar: u.avatarThumb || u.avatarMedium || "",
      signature: u.signature || "",
      verified: u.verified || false,
      followers: s.followerCount || 0,
      following: s.followingCount || 0,
      likes: s.heartCount || s.heart || 0,
      videoCount: s.videoCount || 0,
    };

    // ── Fetch recent videos ──
    const { data: postsData } = await axios.post(
      `${TIKWM_API}/user/posts`,
      new URLSearchParams({
        unique_id: cleanUsername,
        count: "30",
        cursor: "0",
      }),
      { headers: HEADERS, timeout: 15000 }
    );

    let videos = [];
    if (postsData?.code === 0 && postsData?.data?.videos) {
      videos = postsData.data.videos;
    }

    // ── Calculate metrics ──
    let metrics = {
      avgViews: 0,
      avgLikes: 0,
      avgComments: 0,
      avgShares: 0,
      engagementRate: 0,
      postingFrequency: "unknown",
      postsPerWeek: 0,
      totalVideosAnalyzed: videos.length,
      mostUsedHashtags: [],
      bestPerformingContent: null,
      estimatedPostingTimes: [],
      contentBreakdown: { short: 0, medium: 0, long: 0 },
    };

    if (videos.length > 0) {
      const totalViews = videos.reduce((sum, v) => sum + (v.play_count || 0), 0);
      const totalLikes = videos.reduce((sum, v) => sum + (v.digg_count || 0), 0);
      const totalComments = videos.reduce((sum, v) => sum + (v.comment_count || 0), 0);
      const totalShares = videos.reduce((sum, v) => sum + (v.share_count || 0), 0);

      metrics.avgViews = Math.round(totalViews / videos.length);
      metrics.avgLikes = Math.round(totalLikes / videos.length);
      metrics.avgComments = Math.round(totalComments / videos.length);
      metrics.avgShares = Math.round(totalShares / videos.length);

      // Engagement rate = (likes + comments) / views * 100
      if (totalViews > 0) {
        metrics.engagementRate = Math.round((totalLikes + totalComments) / totalViews * 10000) / 100;
      }

      // ── Posting frequency ──
      const createTimes = videos
        .map(v => v.create_time)
        .filter(Boolean)
        .sort((a, b) => b - a);

      if (createTimes.length >= 2) {
        const newestTime = createTimes[0];
        const oldestTime = createTimes[createTimes.length - 1];
        const spanDays = Math.max(1, (newestTime - oldestTime) / 86400);
        const postsPerDay = videos.length / spanDays;
        metrics.postsPerWeek = Math.round(postsPerDay * 7 * 10) / 10;

        if (postsPerDay >= 2) metrics.postingFrequency = "multiple times daily";
        else if (postsPerDay >= 0.8) metrics.postingFrequency = "daily";
        else if (postsPerDay >= 0.4) metrics.postingFrequency = "every few days";
        else if (postsPerDay >= 0.14) metrics.postingFrequency = "weekly";
        else metrics.postingFrequency = "infrequent";
      }

      // ── Most used hashtags ──
      const hashtagCounts = {};
      videos.forEach(v => {
        const caption = v.title || "";
        const tags = caption.match(/#[\w\u00C0-\u024F]+/g) || [];
        tags.forEach(tag => {
          const lower = tag.toLowerCase();
          hashtagCounts[lower] = (hashtagCounts[lower] || 0) + 1;
        });
      });

      metrics.mostUsedHashtags = Object.entries(hashtagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([tag, count]) => ({ tag, count, percentage: Math.round(count / videos.length * 100) }));

      // ── Best performing content ──
      const bestVideo = videos.reduce((best, v) =>
        (v.play_count || 0) > (best.play_count || 0) ? v : best
      , videos[0]);

      if (bestVideo) {
        metrics.bestPerformingContent = {
          videoId: bestVideo.video_id || String(bestVideo.id),
          caption: bestVideo.title || "",
          views: bestVideo.play_count || 0,
          likes: bestVideo.digg_count || 0,
          comments: bestVideo.comment_count || 0,
          shares: bestVideo.share_count || 0,
          duration: bestVideo.duration || 0,
          thumbnail: bestVideo.cover || bestVideo.origin_cover || "",
        };
      }

      // ── Estimated posting times ──
      const hourCounts = {};
      createTimes.forEach(ts => {
        const hour = new Date(ts * 1000).getUTCHours();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      });

      metrics.estimatedPostingTimes = Object.entries(hourCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([hour, count]) => ({
          hourUTC: parseInt(hour),
          label: `${parseInt(hour).toString().padStart(2, "0")}:00 UTC`,
          count,
        }));

      // ── Content duration breakdown ──
      videos.forEach(v => {
        const dur = v.duration || 0;
        if (dur <= 15) metrics.contentBreakdown.short++;
        else if (dur <= 60) metrics.contentBreakdown.medium++;
        else metrics.contentBreakdown.long++;
      });
    }

    // ── Tier classification ──
    const tierInfo = classifyTier(creatorInfo.followers);

    return {
      success: true,
      competitor: {
        ...creatorInfo,
        tier: tierInfo,
      },
      metrics,
      analyzedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.error("Analyze competitor failed", { username, platform, error: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = {
  calculateEarnings,
  analyzeCompetitor,
};
