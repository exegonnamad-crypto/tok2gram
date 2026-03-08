const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const BioPage = require("../models/BioPage");
const { v4: uuidv4 } = require("uuid");

// ── Helper: generate simple ID ──
const genId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ════════════════════════════════════════════════════════════
// AUTHENTICATED ROUTES
// ════════════════════════════════════════════════════════════

// GET /api/bio — Get current user's bio page
router.get("/", auth, async (req, res) => {
  try {
    const page = await BioPage.findOne({ userId: req.user.id });
    if (!page) return res.json(null);
    res.json(page);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch bio page" });
  }
});

// POST /api/bio — Create bio page
router.post("/", auth, async (req, res) => {
  try {
    const existing = await BioPage.findOne({ userId: req.user.id });
    if (existing) return res.status(400).json({ error: "Bio page already exists. Use PUT to update." });

    const { username, displayName, bio, avatar, theme, customColors, socialLinks, settings } = req.body;

    if (username) {
      const taken = await BioPage.findOne({ username: username.toLowerCase() });
      if (taken) return res.status(400).json({ error: "Username is already taken" });
    }

    const page = new BioPage({
      userId: req.user.id,
      username: username?.toLowerCase(),
      displayName,
      bio,
      avatar,
      theme,
      customColors,
      socialLinks,
      settings,
      links: [],
      blocks: [],
    });

    await page.save();
    res.status(201).json(page);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: "Username is already taken" });
    }
    res.status(500).json({ error: err.message || "Failed to create bio page" });
  }
});

// PUT /api/bio — Update bio page
router.put("/", auth, async (req, res) => {
  try {
    const page = await BioPage.findOne({ userId: req.user.id });
    if (!page) return res.status(404).json({ error: "Bio page not found. Create one first." });

    const { username, displayName, bio, avatar, theme, customColors, socialLinks, settings, isPublished } = req.body;

    // Check username uniqueness if changed
    if (username && username.toLowerCase() !== page.username) {
      const taken = await BioPage.findOne({ username: username.toLowerCase() });
      if (taken) return res.status(400).json({ error: "Username is already taken" });
      page.username = username.toLowerCase();
    }

    if (displayName !== undefined) page.displayName = displayName;
    if (bio !== undefined) page.bio = bio;
    if (avatar !== undefined) page.avatar = avatar;
    if (theme !== undefined) page.theme = theme;
    if (customColors !== undefined) page.customColors = { ...page.customColors, ...customColors };
    if (socialLinks !== undefined) page.socialLinks = { ...page.socialLinks, ...socialLinks };
    if (settings !== undefined) page.settings = { ...page.settings, ...settings };
    if (isPublished !== undefined) page.isPublished = isPublished;

    await page.save();
    res.json(page);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: "Username is already taken" });
    }
    res.status(500).json({ error: err.message || "Failed to update bio page" });
  }
});

// POST /api/bio/links — Add a link
router.post("/links", auth, async (req, res) => {
  try {
    const page = await BioPage.findOne({ userId: req.user.id });
    if (!page) return res.status(404).json({ error: "Bio page not found" });

    const { title, url, icon } = req.body;
    if (!title || !url) return res.status(400).json({ error: "Title and URL are required" });

    const link = {
      id: genId(),
      title,
      url,
      icon: icon || "",
      clicks: 0,
      isActive: true,
    };

    page.links.push(link);
    await page.save();
    res.status(201).json(link);
  } catch (err) {
    res.status(500).json({ error: "Failed to add link" });
  }
});

// PUT /api/bio/links/:linkId — Update a link
router.put("/links/:linkId", auth, async (req, res) => {
  try {
    const page = await BioPage.findOne({ userId: req.user.id });
    if (!page) return res.status(404).json({ error: "Bio page not found" });

    const link = page.links.find((l) => l.id === req.params.linkId);
    if (!link) return res.status(404).json({ error: "Link not found" });

    const { title, url, icon, isActive } = req.body;
    if (title !== undefined) link.title = title;
    if (url !== undefined) link.url = url;
    if (icon !== undefined) link.icon = icon;
    if (isActive !== undefined) link.isActive = isActive;

    await page.save();
    res.json(link);
  } catch (err) {
    res.status(500).json({ error: "Failed to update link" });
  }
});

// DELETE /api/bio/links/:linkId — Delete a link
router.delete("/links/:linkId", auth, async (req, res) => {
  try {
    const page = await BioPage.findOne({ userId: req.user.id });
    if (!page) return res.status(404).json({ error: "Bio page not found" });

    page.links = page.links.filter((l) => l.id !== req.params.linkId);
    await page.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete link" });
  }
});

// POST /api/bio/links/reorder — Reorder links
router.post("/links/reorder", auth, async (req, res) => {
  try {
    const page = await BioPage.findOne({ userId: req.user.id });
    if (!page) return res.status(404).json({ error: "Bio page not found" });

    const { linkIds } = req.body;
    if (!Array.isArray(linkIds)) return res.status(400).json({ error: "linkIds must be an array" });

    const linkMap = new Map(page.links.map((l) => [l.id, l]));
    const reordered = [];
    for (const id of linkIds) {
      const link = linkMap.get(id);
      if (link) reordered.push(link);
    }
    // Add any links not in the reorder array at the end
    for (const link of page.links) {
      if (!linkIds.includes(link.id)) reordered.push(link);
    }

    page.links = reordered;
    await page.save();
    res.json(page.links);
  } catch (err) {
    res.status(500).json({ error: "Failed to reorder links" });
  }
});

// GET /api/bio/analytics — Get bio page analytics
router.get("/analytics", auth, async (req, res) => {
  try {
    const page = await BioPage.findOne({ userId: req.user.id });
    if (!page) return res.status(404).json({ error: "Bio page not found" });

    const totalClicks = page.links.reduce((sum, l) => sum + (l.clicks || 0), 0);
    const topLink = page.links.length
      ? page.links.reduce((top, l) => (l.clicks > (top.clicks || 0) ? l : top), page.links[0])
      : null;

    res.json({
      totalViews: page.analytics.totalViews,
      uniqueVisitors: page.analytics.uniqueVisitors,
      totalClicks,
      topLink: topLink ? { title: topLink.title, clicks: topLink.clicks } : null,
      lastViewedAt: page.analytics.lastViewedAt,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// POST /api/bio/check-username — Check username availability
router.post("/check-username", auth, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "Username is required" });

    const clean = username.toLowerCase().trim();
    if (!/^[a-z0-9_-]{3,30}$/.test(clean)) {
      return res.json({ available: false, reason: "Must be 3-30 characters (letters, numbers, underscore, hyphen)" });
    }

    // Reserved usernames
    const reserved = ["admin", "api", "app", "dashboard", "login", "register", "settings", "help", "support", "reelflow"];
    if (reserved.includes(clean)) {
      return res.json({ available: false, reason: "This username is reserved" });
    }

    const existing = await BioPage.findOne({ username: clean });
    // Allow if user already owns this username
    if (existing && existing.userId.toString() === req.user.id) {
      return res.json({ available: true });
    }

    res.json({ available: !existing });
  } catch (err) {
    res.status(500).json({ error: "Failed to check username" });
  }
});

// ════════════════════════════════════════════════════════════
// PUBLIC ROUTES (no auth)
// ════════════════════════════════════════════════════════════

// GET /api/bio/:username — Get public bio page
router.get("/:username", async (req, res) => {
  try {
    const page = await BioPage.findOne({
      username: req.params.username.toLowerCase(),
      isPublished: true,
    });

    if (!page) return res.status(404).json({ error: "Bio page not found" });

    // Increment view count
    page.analytics.totalViews = (page.analytics.totalViews || 0) + 1;
    page.analytics.uniqueVisitors = (page.analytics.uniqueVisitors || 0) + 1; // simplified — real unique tracking would need IP/fingerprint
    page.analytics.lastViewedAt = new Date();
    await page.save();

    // Return public-safe data
    res.json({
      username: page.username,
      displayName: page.displayName,
      bio: page.bio,
      avatar: page.avatar,
      theme: page.theme,
      customColors: page.customColors,
      links: page.links.filter((l) => l.isActive).map((l) => ({
        id: l.id,
        title: l.title,
        url: l.url,
        icon: l.icon,
      })),
      socialLinks: page.socialLinks,
      settings: page.settings,
      analytics: {
        totalViews: page.analytics.totalViews,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch bio page" });
  }
});

// POST /api/bio/:username/click/:linkId — Track link click
router.post("/:username/click/:linkId", async (req, res) => {
  try {
    const page = await BioPage.findOne({
      username: req.params.username.toLowerCase(),
      isPublished: true,
    });

    if (!page) return res.status(404).json({ error: "Bio page not found" });

    const link = page.links.find((l) => l.id === req.params.linkId);
    if (!link) return res.status(404).json({ error: "Link not found" });

    link.clicks = (link.clicks || 0) + 1;
    await page.save();

    res.json({ success: true, clicks: link.clicks });
  } catch (err) {
    res.status(500).json({ error: "Failed to track click" });
  }
});

module.exports = router;
