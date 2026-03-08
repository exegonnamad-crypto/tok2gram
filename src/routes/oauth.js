const express = require("express");
const { auth } = require("../middleware/auth");
const tiktokPoster = require("../services/tiktokPoster");
const youtubePoster = require("../services/youtubePoster");
const facebookPoster = require("../services/facebookPoster");
const Account = require("../models/Account");
const { encrypt } = require("../utils/crypto");
const logger = require("../utils/logger");

const router = express.Router();

// ── Get OAuth URL for a platform ──
router.get("/oauth/url/:platform", auth, async (req, res, next) => {
  try {
    const { platform } = req.params;
    const state = Buffer.from(JSON.stringify({ userId: req.user.id, platform })).toString("base64");

    const redirectBase = process.env.BACKEND_URL || "http://localhost:3001";
    const redirectUri = `${redirectBase}/api/accounts/oauth/callback`;

    let url;
    switch (platform) {
      case "tiktok":
        url = tiktokPoster.getOAuthUrl(process.env.TIKTOK_CLIENT_KEY, redirectUri, state);
        break;
      case "youtube":
        url = youtubePoster.getOAuthUrl(process.env.GOOGLE_CLIENT_ID, redirectUri, state);
        break;
      case "facebook":
        url = facebookPoster.getOAuthUrl(process.env.FACEBOOK_APP_ID, redirectUri, state);
        break;
      default:
        return res.status(400).json({ error: "Instagram uses username/password, not OAuth" });
    }

    if (!url) return res.status(500).json({ error: `Missing API keys for ${platform}` });
    res.json({ url });
  } catch (err) { next(err); }
});

// ── OAuth callback (redirected from platform) ──
router.get("/oauth/callback", async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code or state");

    const { userId, platform } = JSON.parse(Buffer.from(state, "base64").toString());
    const redirectBase = process.env.BACKEND_URL || "http://localhost:3001";
    const redirectUri = `${redirectBase}/api/accounts/oauth/callback`;

    let tokenResult;
    let username = "";
    let profilePic = "";

    switch (platform) {
      case "tiktok":
        tokenResult = await tiktokPoster.getAccessToken(
          code, process.env.TIKTOK_CLIENT_KEY, process.env.TIKTOK_CLIENT_SECRET, redirectUri
        );
        if (tokenResult.success) username = tokenResult.openId || "tiktok_user";
        break;

      case "youtube":
        tokenResult = await youtubePoster.getAccessToken(
          code, process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri
        );
        if (tokenResult.success) username = "youtube_user";
        break;

      case "facebook":
        tokenResult = await facebookPoster.getAccessToken(
          code, process.env.FACEBOOK_APP_ID, process.env.FACEBOOK_APP_SECRET, redirectUri
        );
        if (tokenResult.success) {
          // Get pages
          const pagesResult = await facebookPoster.getPages(tokenResult.accessToken);
          if (pagesResult.success && pagesResult.pages.length > 0) {
            const page = pagesResult.pages[0];
            username = page.name;
            tokenResult.accessToken = page.accessToken;
            tokenResult.pageId = page.id;
          }
        }
        break;
    }

    if (!tokenResult?.success) {
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      return res.redirect(`${frontendUrl}/accounts?error=${encodeURIComponent(tokenResult?.error || "OAuth failed")}`);
    }

    // Create or update account
    const existing = await Account.findOne({ userId, platform, username });
    if (existing) {
      existing.sessionData = encrypt(JSON.stringify({
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        pageId: tokenResult.pageId,
      }));
      existing.sessionSavedAt = new Date();
      existing.status = "active";
      await existing.save();
    } else {
      await Account.create({
        userId,
        platform,
        username,
        profilePic,
        sessionData: encrypt(JSON.stringify({
          accessToken: tokenResult.accessToken,
          refreshToken: tokenResult.refreshToken,
          pageId: tokenResult.pageId,
        })),
        sessionSavedAt: new Date(),
        status: "active",
      });
    }

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    res.redirect(`${frontendUrl}/accounts?connected=${platform}`);
  } catch (err) {
    logger.error("OAuth callback error", { error: err.message });
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    res.redirect(`${frontendUrl}/accounts?error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
