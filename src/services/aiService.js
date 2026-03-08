const axios = require("axios");
const logger = require("../utils/logger");

// ── Provider selection: supports Groq (free) and Gemini ──
async function callAI(prompt, { temperature = 0.8, maxTokens = 1000, timeout = 25000, system } = {}) {
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  // Try Groq first (faster, more reliable free tier)
  if (groqKey) {
    try {
      const { data } = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
        model: "llama-3.3-70b-versatile",
        messages,
        temperature,
        max_tokens: maxTokens,
      }, {
        headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
        timeout,
      });
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error("Empty response from Groq");
      return text.trim();
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      logger.warn("Groq failed, trying Gemini fallback", { error: msg });
      // Fall through to Gemini
    }
  }

  // Gemini fallback
  if (geminiKey) {
    const keys = geminiKey.split(",").map(k => k.trim()).filter(Boolean);
    for (let i = 0; i < keys.length; i++) {
      try {
        const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
        const { data } = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${keys[i]}`,
          {
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: { temperature, maxOutputTokens: maxTokens },
          },
          { timeout }
        );
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error("Empty response from Gemini");
        return text.trim();
      } catch (err) {
        const status = err.response?.status;
        if (status === 429 && i < keys.length - 1) continue; // Try next key
        const msg = err.response?.data?.error?.message || err.message;
        logger.error("Gemini failed", { error: msg, keyIndex: i });
        throw new Error(msg || "AI generation failed");
      }
    }
  }

  throw new Error("No AI provider configured. Set GROQ_API_KEY or GEMINI_API_KEY in backend/.env");
}

// ── Parse JSON from AI response ──
function parseJSON(text) {
  // Strip markdown code blocks and any text before/after JSON
  let cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  // Find the first { or [ and last } or ]
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  const start = firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket);
  if (start > 0) cleaned = cleaned.slice(start);
  const lastBrace = cleaned.lastIndexOf("}");
  const lastBracket = cleaned.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);
  if (end > 0 && end < cleaned.length - 1) cleaned = cleaned.slice(0, end + 1);
  return JSON.parse(cleaned);
}

// ════════════════════════════════════════════════════════════════
// SYSTEM PROMPTS (expert-level personas)
// ════════════════════════════════════════════════════════════════

const SYSTEMS = {
  captionWriter: `You are an elite social media copywriter who has written captions for accounts with 1M+ followers. You understand platform algorithms deeply. Your captions consistently get 5-10x more engagement than average. You know exactly what makes people stop scrolling, read, and take action. You never use generic phrases — every word is intentional and earns its place.`,

  viralAnalyst: `You are a data-driven social media strategist who has analyzed 100,000+ viral posts across TikTok, Instagram, and YouTube. You understand the psychological triggers behind viral content: curiosity gaps, pattern interrupts, emotional resonance, social proof, and FOMO. Your analysis is specific, actionable, and backed by platform algorithm knowledge. You are brutally honest — you don't sugarcoat scores.`,

  hookExpert: `You are a scroll-stopping hook specialist. You've studied what makes the first 1-3 seconds of content irresistible. You understand that 80% of a post's success depends on the hook. Your hooks use proven psychological triggers: open loops, bold claims, pattern interrupts, "Wait what?" moments, and emotional spikes. Every hook you write would make someone stop mid-scroll.`,

  contentStrategist: `You are a content strategist who has built multiple accounts from 0 to 100K+ followers. You understand content pillars, posting cadence, audience psychology, and growth mechanics. Your content plans are strategic — each piece serves a specific purpose (attract, nurture, convert) and builds on the previous one. You plan for momentum, not just individual posts.`,

  voiceAnalyst: `You are a brand voice analyst and linguist who specializes in dissecting what makes a creator's writing style unique and recognizable. You notice patterns that others miss: rhythm, word choice, structural habits, emotional range, and cultural references. Your analysis helps creators understand their own voice so they can be intentionally consistent.`,
};

// ════════════════════════════════════════════════════════════════
// AI FUNCTIONS
// ════════════════════════════════════════════════════════════════

async function generateCaption({ originalCaption, platform, niche, tone, language }) {
  const toneInstructions = {
    viral: `Use a pattern-interrupt hook that creates a curiosity gap. Add power words (secret, insane, nobody talks about). Create urgency or FOMO. End with a compelling CTA that gives people a reason to engage.`,
    professional: `Lead with a clear value proposition. Use authority language without being stuffy. Include one insight that positions you as an expert. End with a thought-provoking question or actionable takeaway.`,
    funny: `Open with an unexpected observation or relatable frustration. Use conversational language like you're texting a friend. Add humor through exaggeration, self-deprecation, or unexpected twists. Keep the energy high.`,
    motivational: `Start with a bold statement that challenges conventional thinking. Build emotional momentum with short, punchy sentences. Use "you" language to make it personal. End with a line that makes people want to save the post.`,
    minimal: `Maximum 2 lines. Every word must earn its place. Create intrigue with what you DON'T say. Use whitespace as a tool. Think Apple-level copywriting — simple but impossible to ignore.`,
    storytelling: `Open with "I" + action verb to immediately pull people into a story. Use sensory details in the first sentence. Create a mini tension-resolution arc in 3-4 sentences. End with a universal truth or lesson learned.`,
  };

  const prompt = `Write a ${platform || "Instagram"} caption for this content.

ORIGINAL CONTEXT: "${originalCaption || "No caption provided — create something original"}"
NICHE: ${niche || "General"}
LANGUAGE: ${language || "English"}

STYLE DIRECTION:
${toneInstructions[tone] || toneInstructions.viral}

RULES:
- First line MUST be a hook that would make someone stop scrolling (this is non-negotiable)
- Include a specific CTA — not "like and follow" but something creative (ask a question, tell them to save, challenge them)
- 3-5 hashtags at the end — mix 1-2 broad ones (#reels #fyp) with 2-3 niche-specific ones
- Under 250 characters for the main text (before hashtags)
- NO asterisks, NO markdown, NO quotes around the output
- Write in ${language || "English"} naturally — not translated, but native-sounding
- Return ONLY the caption text, nothing else`;

  return await callAI(prompt, { temperature: 0.9, maxTokens: 500, system: SYSTEMS.captionWriter });
}

async function generateCaptionVariations({ originalCaption, platform, niche, count }) {
  const num = Math.min(count || 3, 5);
  const prompt = `Create ${num} completely different caption approaches for this ${platform || "Instagram"} content.

ORIGINAL: "${originalCaption || "Create original captions"}"
NICHE: ${niche || "General"}

Each variation MUST use a fundamentally different strategy:
1. HOOK-FIRST: Open with an irresistible hook that creates a curiosity gap. ("Nobody's talking about this but...")
2. QUESTION-LED: Start with a provocative question that forces people to engage. ("Why does everyone get this wrong?")
3. STORY-DRIVEN: Pull people in with a micro-story. Start with "I" + action verb. ("I spent 3 months testing this...")
${num >= 4 ? '4. BOLD CLAIM: Make a strong, specific statement that demands attention. ("This one change doubled my reach in 7 days")' : ""}
${num >= 5 ? '5. CONTRARIAN: Challenge popular opinion. ("Unpopular opinion: [common advice] is actually killing your growth")' : ""}

RULES:
- Each caption under 250 characters (before hashtags)
- Each gets 3-5 unique hashtags (don't repeat hashtags between variations)
- Each has a different CTA (question, save prompt, share prompt, tag someone, comment trigger)
- NO asterisks, NO markdown formatting
- Separate each caption with ---
- Return ONLY the captions, nothing else`;

  const text = await callAI(prompt, { temperature: 1.0, maxTokens: 1500, system: SYSTEMS.captionWriter });
  return text.split(/---+/).map(v => v.trim()).filter(v => v.length > 10);
}

async function translateCaption(caption, targetLanguage) {
  const prompt = `Translate this social media caption to ${targetLanguage}.

CRITICAL: Don't just translate word-for-word. Adapt it so it sounds like a native ${targetLanguage} speaker wrote it for their audience. Keep the same energy, tone, and intent. Adapt cultural references, slang, and idioms. Keep emojis. Adapt hashtags to be relevant and trending in ${targetLanguage}-speaking markets.

Caption: "${caption}"

Return ONLY the translated caption, nothing else.`;
  return await callAI(prompt, { temperature: 0.5, maxTokens: 500, system: SYSTEMS.captionWriter });
}

async function generateHashtags(niche, count) {
  const num = Math.min(count || 20, 30);
  const prompt = `Generate ${num} strategic Instagram/TikTok hashtags for the "${niche || "General"}" niche.

STRATEGY (use this exact mix):
- 30% HIGH VOLUME (1M+ posts): Broad discovery hashtags that maximize reach
- 40% MID VOLUME (100K-1M posts): Niche-specific hashtags where you can actually rank
- 20% LOW COMPETITION (10K-100K posts): Long-tail hashtags where you'll dominate
- 10% TRENDING: Current trends, challenges, or seasonal tags

Format: one hashtag per line, starting with #
Return ONLY the hashtags, no descriptions or categories.`;

  const text = await callAI(prompt, { temperature: 0.8, maxTokens: 500, system: SYSTEMS.captionWriter });
  return text.split(/\n/).map(h => h.trim()).filter(h => h.startsWith("#"));
}

async function viralScore({ caption, hashtags, niche, postingTime, platform, videoDuration, accountFollowers }) {
  const prompt = `Analyze this ${platform || "Instagram"} post and score its viral potential. Be specific and honest — don't inflate scores.

CONTENT TO ANALYZE:
- Caption: "${caption || "No caption"}"
- Hashtags: "${hashtags || "None"}"
- Niche: ${niche || "General"}
- Posting time: ${postingTime || "Not specified"}
- Video duration: ${videoDuration || "Unknown"}s
- Account size: ${accountFollowers || "Unknown"} followers

SCORING CRITERIA (be strict, most content should score 40-70):
- hookScore: Does the first line stop the scroll? Is there a curiosity gap, bold claim, or pattern interrupt? (Most captions with no clear hook = 20-40)
- captionScore: Is the caption structured for engagement? Does it have a CTA? Is the length optimal? (Generic captions = 30-50)
- hashtagScore: Right mix of broad and niche? Relevant? Not banned or oversaturated? No hashtags = 15. Random hashtags = 30-40.
- timingScore: Based on known peak times. Unknown = 50. Peak times (6-9AM, 12-2PM, 7-9PM) = 70-90.
- overallScore: Weighted average (hook 35%, caption 30%, hashtags 20%, timing 15%)

For hookAnalysis, captionAnalysis, hashtagAnalysis, timingAnalysis: Give specific, actionable feedback. Say exactly what's wrong and how to fix it. Not generic advice.

IMPORTANT: Return ONLY valid JSON, no markdown:
{
  "hookScore": <0-100>,
  "captionScore": <0-100>,
  "hashtagScore": <0-100>,
  "timingScore": <0-100>,
  "overallScore": <0-100>,
  "engagementTier": "<low|medium|high|viral>",
  "suggestions": ["specific actionable suggestion 1", "specific actionable suggestion 2", "specific actionable suggestion 3", "specific actionable suggestion 4", "specific actionable suggestion 5"],
  "hookAnalysis": "<what works/doesn't work about the hook, with a specific rewrite suggestion>",
  "captionAnalysis": "<structure analysis with specific improvement>",
  "hashtagAnalysis": "<strategy analysis — which tags help, which hurt>",
  "timingAnalysis": "<specific time recommendation based on niche and platform>",
  "predictedViews": "<realistic range based on follower count, e.g., 2K-8K for 10K followers>",
  "predictedEngagementRate": "<realistic rate, e.g., 3.2%>"
}`;

  const text = await callAI(prompt, { temperature: 0.3, maxTokens: 1200, system: SYSTEMS.viralAnalyst });
  return parseJSON(text);
}

async function generateHooks({ topic, niche, platform, tone }) {
  const toneContext = {
    viral: "Maximum scroll-stopping power. Bold, unexpected, creates FOMO.",
    professional: "Authoritative and credible. Leads with expertise.",
    funny: "Unexpected humor, relatable frustration, comedic timing.",
    motivational: "Emotionally charged, empowering, challenges limiting beliefs.",
    minimal: "Ultra-short, punchy, mysterious. 5-8 words max.",
    storytelling: "Pulls you into a story immediately. Creates an open loop.",
  };

  const prompt = `Generate 5 scroll-stopping hooks for a ${platform || "Instagram"} Reel about: "${topic || "General content"}"

NICHE: ${niche || "General"}
TONE: ${toneContext[tone] || toneContext.viral}

Each hook MUST use a different proven psychological trigger:
1. CURIOSITY GAP — Create an open loop the viewer MUST close ("I found out why 90% of [niche] accounts never grow past 10K")
2. BOLD/CONTROVERSIAL — Challenge a common belief ("Stop posting at 9am. Here's why that advice is wrong.")
3. STORY HOOK — Drop the viewer into the middle of a compelling story ("Day 47 of testing this and the results are insane")
4. DATA/PROOF — Use a specific number or result ("This 3-second change got me 400K views")
5. DIRECT CHALLENGE — Call out the viewer personally ("You're making this mistake right now and don't even know it")

CRITICAL: These are the FIRST WORDS the viewer sees/hears. They have 1.5 seconds to decide if they keep watching. Make every word count. Be specific to the topic — not generic hooks that could apply to anything.

Return ONLY valid JSON array, no markdown:
[
  {"hook": "<the actual hook text>", "style": "<Curiosity Gap|Bold Claim|Story Hook|Data Proof|Direct Challenge>", "whyItWorks": "<specific psychological reason this stops the scroll>"},
  {"hook": "<text>", "style": "<style>", "whyItWorks": "<reason>"},
  {"hook": "<text>", "style": "<style>", "whyItWorks": "<reason>"},
  {"hook": "<text>", "style": "<style>", "whyItWorks": "<reason>"},
  {"hook": "<text>", "style": "<style>", "whyItWorks": "<reason>"}
]`;

  const text = await callAI(prompt, { temperature: 0.95, maxTokens: 1200, system: SYSTEMS.hookExpert });
  return parseJSON(text);
}

async function generateContentSeries({ topic, niche, platform, days, tone, brandVoice }) {
  const numDays = days === 30 ? 30 : 7;
  const brandContext = brandVoice
    ? `BRAND VOICE TO MATCH: Tone "${brandVoice.tone}", ${brandVoice.avgLength} chars avg, emoji style "${brandVoice.emojiStyle}". ${brandVoice.voiceSummary || ""}`
    : "";

  const prompt = `Create a strategic ${numDays}-day content plan for ${platform || "Instagram"}.

TOPIC: ${topic || "Growing an audience"}
NICHE: ${niche || "General"}
TONE: ${tone || "viral"}
${brandContext}

CONTENT STRATEGY FRAMEWORK (follow this distribution):
- 40% VALUE POSTS: Teach something specific and actionable (tips, tutorials, how-tos)
- 20% ENGAGEMENT POSTS: Content designed to spark comments and saves (questions, polls, hot takes)
- 15% PERSONAL/RELATABLE: Behind-the-scenes, struggles, wins — builds connection
- 15% TRENDING: Ride current trends, sounds, or formats in the niche
- 10% PROMOTIONAL: Soft-sell your expertise or offering

Each day should build momentum. Don't repeat the same format two days in a row. Alternate between high-effort and quick posts.

For each day, provide:
- theme: A specific, compelling topic (not generic like "tips" — be specific like "The 80/20 rule of [niche] that nobody uses")
- contentType: educational | entertaining | personal | trending | promotional | engagement
- hook: The exact first line/text overlay (this is what stops the scroll)
- captionIdea: A complete, ready-to-use caption (2-3 sentences + CTA)
- hashtags: 5-8 strategic hashtags as a single space-separated string
- bestTimeToPost: Optimal time in HH:MM format based on typical ${platform} engagement patterns
- tip: A specific production/strategy tip for that particular post

IMPORTANT: Return ONLY valid JSON array, no markdown:
[
  {
    "day": 1,
    "theme": "<specific theme>",
    "contentType": "<type>",
    "hook": "<scroll-stopping first line>",
    "captionIdea": "<complete ready-to-use caption with CTA>",
    "hashtags": "<#tag1 #tag2 #tag3 #tag4 #tag5>",
    "bestTimeToPost": "<HH:MM>",
    "tip": "<specific actionable tip for this post>"
  }
]

Generate exactly ${numDays} entries.`;

  const text = await callAI(prompt, { temperature: 0.85, maxTokens: numDays === 30 ? 8000 : 3000, timeout: 45000, system: SYSTEMS.contentStrategist });
  return parseJSON(text);
}

async function trainBrandVoice(captions) {
  if (!captions || captions.length < 5) throw new Error("Provide at least 5 captions");
  const captionList = captions.slice(0, 20).map((c, i) => `${i + 1}. "${c}"`).join("\n");

  const prompt = `Deeply analyze these ${captions.length} captions to extract and codify this creator's unique brand voice.

CAPTIONS TO ANALYZE:
${captionList}

ANALYSIS FRAMEWORK:
1. TONE: What's the emotional temperature? (e.g., "Bold & irreverent" not just "casual")
2. FORMALITY: Where do they fall on the spectrum?
3. HUMOR: What kind? Sarcastic? Self-deprecating? Observational? None?
4. EMOJIS: Pattern of usage — which ones, where, how many?
5. STRUCTURE: Do they use short sentences? Long paragraphs? Bullet points? Line breaks?
6. VOCABULARY: Simple/conversational or sophisticated? Any signature words/phrases?
7. CTA PATTERN: How do they ask for engagement? Direct? Subtle? Question-based?
8. UNIQUE QUIRKS: What makes this voice recognizable? What patterns repeat?

Then generate a NEW sample caption that perfectly mimics their style — someone who follows them should think THEY wrote it.

IMPORTANT: Return ONLY valid JSON, no markdown:
{
  "tone": "<2-3 descriptive words>",
  "formality": "<casual|semi-formal|formal>",
  "humorLevel": "<none|subtle|moderate|heavy>",
  "emojiStyle": "<none|minimal|moderate|heavy>",
  "commonEmojis": ["emoji1","emoji2","emoji3"],
  "avgLength": <number of characters>,
  "sentenceStyle": "<short-punchy|medium|long-flowing>",
  "vocabulary": "<simple|moderate|sophisticated>",
  "ctaStyle": "<how they typically ask for engagement>",
  "hashtagStyle": "<how they use hashtags — count, type, placement>",
  "uniqueQuirks": ["specific pattern 1","specific pattern 2","specific pattern 3"],
  "voiceSummary": "<2-3 sentences that capture the essence of this voice — specific enough that someone could replicate it>",
  "sampleCaption": "<a new caption that perfectly mimics their style, about a generic topic in their niche>"
}`;

  const text = await callAI(prompt, { temperature: 0.4, maxTokens: 1200, system: SYSTEMS.voiceAnalyst });
  return parseJSON(text);
}

async function remixCaption({ viralCaption, targetNiche, tone, brandVoice }) {
  const brandContext = brandVoice
    ? `MATCH THIS BRAND VOICE: ${brandVoice.voiceSummary}. Tone: ${brandVoice.tone}. Emoji style: ${brandVoice.emojiStyle}.`
    : "";

  const prompt = `Take this viral caption and remix it for a completely different niche. Keep the psychological structure that made it go viral — just change the topic/context.

ORIGINAL VIRAL CAPTION: "${viralCaption}"

TARGET NICHE: ${targetNiche || "General"}
TONE: ${tone || "viral"}
${brandContext}

Create 3 remixes that:
- Preserve the PSYCHOLOGICAL TRIGGER (curiosity gap, social proof, contrarian take, etc.)
- Preserve the STRUCTURE (hook placement, CTA style, line breaks)
- Completely change the SUBJECT MATTER to fit ${targetNiche || "General"} niche
- Each remix should take a different angle on the niche

For "style", explain the viral psychology being preserved (not just "engaging" — be specific about the trigger).

IMPORTANT: Return ONLY valid JSON array, no markdown:
[
  {"caption": "<fully remixed caption with hashtags>", "style": "<specific viral psychology being used>"},
  {"caption": "<fully remixed caption with hashtags>", "style": "<specific viral psychology being used>"},
  {"caption": "<fully remixed caption with hashtags>", "style": "<specific viral psychology being used>"}
]`;

  const text = await callAI(prompt, { temperature: 0.9, maxTokens: 1200, system: SYSTEMS.captionWriter });
  return parseJSON(text);
}

module.exports = {
  generateCaption,
  generateCaptionVariations,
  translateCaption,
  generateHashtags,
  viralScore,
  generateHooks,
  generateContentSeries,
  trainBrandVoice,
  remixCaption,
};
