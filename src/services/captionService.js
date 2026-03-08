const { truncate } = require("../utils/helpers");
const logger = require("../utils/logger");

/**
 * Build final caption for posting based on video's captionMode (per-video override)
 * or fall back to workflow/account captionStyle.
 */
async function buildCaption(video, account, workflow = null) {
  // Per-video captionMode takes priority; fall back to workflow/account captionStyle
  const mode = video.captionMode || (workflow || account).captionStyle || "original";
  let caption = "";

  switch (mode) {
    case "original":
      caption = video.originalCaption || video.caption || "";
      break;

    case "ai":
      caption = await _buildAICaption(video, account);
      break;

    case "template":
      caption = await _buildTemplateCaption(video, account, workflow);
      break;

    case "custom":
      caption = video.customCaption || "";
      break;

    case "none":
      caption = "";
      break;

    default:
      caption = video.originalCaption || "";
  }

  // Append hashtags from workflow or account
  const settings = workflow || account;
  const hashtags = settings.hashtags || (settings.appendHashtags && account.hashtags) || "";
  if (hashtags) {
    caption = caption ? `${caption}\n\n${hashtags}` : hashtags;
  }

  return truncate(caption.trim(), 2200);
}

/**
 * AI caption mode: call aiService.generateCaption, fall back to original on failure
 */
async function _buildAICaption(video, account) {
  try {
    const aiService = require("./aiService");
    const result = await aiService.generateCaption({
      originalCaption: video.originalCaption || video.caption || "",
      platform: "Instagram",
      niche: account.niche || "General",
      tone: "viral",
      language: "English",
    });
    if (result && typeof result === "string" && result.trim().length > 0) {
      return result.trim();
    }
    throw new Error("Empty AI caption result");
  } catch (err) {
    logger.warn("AI caption generation failed, falling back to original", { error: err.message, videoId: video._id });
    return video.originalCaption || video.caption || "";
  }
}

/**
 * Template caption mode: load the template from workflow or templateId, apply variable substitution
 */
async function _buildTemplateCaption(video, account, workflow) {
  let templateSource = workflow;

  // If video has a specific templateId that differs from the workflow, load it
  if (video.templateId && (!workflow || String(video.templateId) !== String(workflow._id))) {
    try {
      const Workflow = require("../models/Workflow");
      templateSource = await Workflow.findById(video.templateId);
    } catch (err) {
      logger.warn("Failed to load template workflow", { error: err.message, templateId: video.templateId });
    }
  }

  if (!templateSource) {
    logger.warn("No template source found, falling back to original caption", { videoId: video._id });
    return video.originalCaption || video.caption || "";
  }

  const template = templateSource.captionTemplate || templateSource.customCaption || "";
  if (!template) {
    return video.originalCaption || video.caption || "";
  }

  return applyTemplate(template, video, account);
}

/**
 * Apply template variables to caption
 * Supported: {original_caption}, {author}, {niche}, {username}, {date}, {day}, {platform}
 */
function applyTemplate(template, video, account) {
  if (!template) return "";

  const now = new Date();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  return template
    .replace(/{original_caption}/gi, video.originalCaption || video.caption || "")
    .replace(/{author}/gi, video.videoAuthor || "")
    .replace(/{niche}/gi, account.niche || "")
    .replace(/{username}/gi, account.username || "")
    .replace(/{date}/gi, now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))
    .replace(/{day}/gi, days[now.getDay()])
    .replace(/{platform}/gi, video.sourcePlatform || "")
    .trim();
}

/**
 * Generate hashtags based on niche
 */
function generateNicheHashtags(niche) {
  const nicheHashtags = {
    General: "#explore #viral #trending #foryou #fyp",
    Fitness: "#fitness #gym #workout #fitnessmotivation #gains #bodybuilding",
    Cars: "#cars #automotive #supercars #carsofinstagram #carlifestyle",
    Motivation: "#motivation #mindset #success #grind #hustle #inspire",
    Anime: "#anime #manga #otaku #animeedit #weeb #animefans",
    Gaming: "#gaming #gamer #esports #gamingcommunity #gameplay",
    Finance: "#finance #investing #money #wealth #trading #stocks",
    Fashion: "#fashion #style #ootd #fashionista #streetwear",
    Food: "#food #foodie #cooking #recipe #delicious #chef",
    Travel: "#travel #wanderlust #adventure #explore #travelphotography",
    Music: "#music #musician #newmusic #hiphop #beats #producer",
    Art: "#art #artist #artwork #creative #digitalart #illustration",
    Comedy: "#comedy #funny #memes #humor #laugh #lol",
    Education: "#education #learn #knowledge #study #tips",
    Tech: "#tech #technology #innovation #ai #coding #startup",
    Pets: "#pets #dogs #cats #animals #puppy #cute",
    Sports: "#sports #football #basketball #soccer #athlete",
    Crypto: "#crypto #bitcoin #ethereum #blockchain #web3 #defi",
    Luxury: "#luxury #lifestyle #premium #rich #luxurylife",
    Beauty: "#beauty #makeup #skincare #beautytips #glowup",
    Health: "#health #wellness #healthy #nutrition #selfcare",
    "Real Estate": "#realestate #property #home #investment #realtor",
    Lifestyle: "#lifestyle #daily #vibes #aesthetic #inspo",
  };

  return nicheHashtags[niche] || nicheHashtags.General;
}

module.exports = { buildCaption, applyTemplate, generateNicheHashtags };
