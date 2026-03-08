const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const logger = require("../utils/logger");

/**
 * Video Transformation Service
 *
 * Re-encodes videos to bypass Instagram's 2025 SSCD fingerprinting algorithm.
 * SSCD detects reposted content with 70%+ visual similarity and suppresses reach.
 * These transforms keep the video visually identical to humans while changing
 * enough pixel/audio/metadata data to evade fingerprint matching.
 */

// Intensity presets — higher = more aggressive transforms
const PRESETS = {
  light: {
    bitrateVariance: 0.03,    // ±3%
    cropPercent: [0.5, 1.0],  // 0.5–1% crop
    brightness: [-0.01, 0.01],
    contrast: [0.99, 1.01],
    saturation: [0.98, 1.02],
    audioBitrateVariance: 0.03,
    blackFrames: 1,
  },
  medium: {
    bitrateVariance: 0.05,    // ±5%
    cropPercent: [1.0, 2.0],  // 1–2% crop
    brightness: [-0.02, 0.02],
    contrast: [0.98, 1.02],
    saturation: [0.97, 1.03],
    audioBitrateVariance: 0.05,
    blackFrames: 2,
  },
  heavy: {
    bitrateVariance: 0.08,    // ±8%
    cropPercent: [1.5, 3.0],  // 1.5–3% crop
    brightness: [-0.03, 0.03],
    contrast: [0.97, 1.03],
    saturation: [0.95, 1.05],
    audioBitrateVariance: 0.08,
    blackFrames: 2,
  },
};

/**
 * Random float in range [min, max]
 */
function rand(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * Random integer in range [min, max]
 */
function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

/**
 * Probe video to get width, height, duration, video bitrate, audio bitrate
 */
function probeVideo(inputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      inputPath,
    ];
    const proc = spawn("ffprobe", args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      try {
        const info = JSON.parse(stdout);
        const videoStream = (info.streams || []).find((s) => s.codec_type === "video");
        const audioStream = (info.streams || []).find((s) => s.codec_type === "audio");
        resolve({
          width: videoStream ? parseInt(videoStream.width, 10) : 1080,
          height: videoStream ? parseInt(videoStream.height, 10) : 1920,
          duration: parseFloat(info.format?.duration || "0"),
          videoBitrate: videoStream?.bit_rate ? parseInt(videoStream.bit_rate, 10) : 2500000,
          audioBitrate: audioStream?.bit_rate ? parseInt(audioStream.bit_rate, 10) : 128000,
          fps: videoStream?.r_frame_rate || "30/1",
        });
      } catch (e) {
        reject(new Error(`Failed to parse ffprobe output: ${e.message}`));
      }
    });
    proc.on("error", (err) => reject(new Error(`ffprobe not found or failed: ${err.message}`)));
  });
}

/**
 * Run an ffmpeg command and return a promise
 */
function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg ${label} exited with code ${code}: ${stderr.slice(-500)}`));
      resolve();
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg not found or failed: ${err.message}`)));
  });
}

/**
 * Generate a short black video with silence (for prepending frames)
 */
async function generateBlackSegment(outputPath, width, height, fps, numFrames, audioBitrate) {
  const duration = numFrames / parseFps(fps);
  const args = [
    "-y",
    "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${fps}:d=${duration}`,
    "-f", "lavfi", "-i", `anullsrc=channel_layout=stereo:sample_rate=44100`,
    "-t", String(duration),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
    "-c:a", "aac", "-b:a", `${Math.round(audioBitrate / 1000)}k`,
    "-pix_fmt", "yuv420p",
    "-shortest",
    outputPath,
  ];
  await runFfmpeg(args, "black-segment");
}

/**
 * Parse fps string like "30/1" or "29.97" into a number
 */
function parseFps(fpsStr) {
  if (typeof fpsStr === "number") return fpsStr;
  if (fpsStr.includes("/")) {
    const [num, den] = fpsStr.split("/").map(Number);
    return den ? num / den : 30;
  }
  return parseFloat(fpsStr) || 30;
}

/**
 * Transform a video to bypass Instagram SSCD fingerprinting.
 *
 * @param {string} inputPath - Path to the source video file
 * @param {object} options
 * @param {boolean} options.enabled - Whether to transform (default true)
 * @param {'light'|'medium'|'heavy'} options.intensity - Transform intensity (default 'medium')
 * @returns {Promise<string>} Path to the transformed video file
 */
async function transformVideo(inputPath, options = {}) {
  const { enabled = true, intensity = "medium" } = options;

  // If disabled, return original path
  if (!enabled) {
    logger.debug("Video transform disabled, returning original", { inputPath });
    return inputPath;
  }

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input video not found: ${inputPath}`);
  }

  const preset = PRESETS[intensity] || PRESETS.medium;
  const ext = path.extname(inputPath) || ".mp4";
  const baseName = path.basename(inputPath, ext);
  const outputDir = path.dirname(inputPath);
  const outputPath = path.join(outputDir, `${baseName}_transformed${ext}`);
  const tempFiles = [];

  try {
    logger.info("Starting video transform", { inputPath, intensity });

    // Step 1: Probe original video
    const probe = await probeVideo(inputPath);
    logger.debug("Video probed", probe);

    // Step 2: Calculate transform parameters
    const bitrateMultiplier = 1 + rand(-preset.bitrateVariance, preset.bitrateVariance);
    const newVideoBitrate = Math.round(probe.videoBitrate * bitrateMultiplier);
    const audioBitrateMultiplier = 1 + rand(-preset.audioBitrateVariance, preset.audioBitrateVariance);
    const newAudioBitrate = Math.round(probe.audioBitrate * audioBitrateMultiplier);

    // Crop: random 1-2% from edges
    const cropPct = rand(preset.cropPercent[0], preset.cropPercent[1]) / 100;
    const cropX = Math.round(probe.width * cropPct);
    const cropY = Math.round(probe.height * cropPct);
    const cropW = probe.width - 2 * cropX;
    const cropH = probe.height - 2 * cropY;

    // Color adjustments
    const brightness = rand(preset.brightness[0], preset.brightness[1]);
    const contrast = rand(preset.contrast[0], preset.contrast[1]);
    const saturation = rand(preset.saturation[0], preset.saturation[1]);

    // Step 3: Generate black frames segment
    const blackSegPath = path.join(outputDir, `${baseName}_black_${Date.now()}.mp4`);
    tempFiles.push(blackSegPath);
    const numBlackFrames = randInt(1, preset.blackFrames);
    await generateBlackSegment(blackSegPath, cropW, cropH, probe.fps, numBlackFrames, newAudioBitrate);

    // Step 4: Re-encode the main video with all transforms applied
    const mainTransformed = path.join(outputDir, `${baseName}_main_${Date.now()}.mp4`);
    tempFiles.push(mainTransformed);

    // Build video filter chain:
    // crop -> scale back to even dimensions -> color adjustments
    const vf = [
      `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
      `eq=brightness=${brightness.toFixed(4)}:contrast=${contrast.toFixed(4)}:saturation=${saturation.toFixed(4)}`,
      // Ensure dimensions are even (required by libx264)
      `scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    ].join(",");

    const mainArgs = [
      "-y",
      "-i", inputPath,
      "-map_metadata", "-1",          // Strip all metadata
      "-vf", vf,
      "-c:v", "libx264",
      "-b:v", `${Math.round(newVideoBitrate / 1000)}k`,
      "-preset", "medium",
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", `${Math.round(newAudioBitrate / 1000)}k`,
      "-ar", "44100",
      "-movflags", "+faststart",
      mainTransformed,
    ];

    await runFfmpeg(mainArgs, "main-transform");

    // Step 5: Concatenate black frames + transformed video
    const concatListPath = path.join(outputDir, `${baseName}_concat_${Date.now()}.txt`);
    tempFiles.push(concatListPath);

    // ffmpeg concat demuxer requires forward slashes or escaped backslashes
    const safeBlack = blackSegPath.replace(/\\/g, "/");
    const safeMain = mainTransformed.replace(/\\/g, "/");
    const concatContent = `file '${safeBlack}'\nfile '${safeMain}'\n`;
    fs.writeFileSync(concatListPath, concatContent);

    const concatArgs = [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c", "copy",
      "-map_metadata", "-1",
      "-movflags", "+faststart",
      outputPath,
    ];

    await runFfmpeg(concatArgs, "concat");

    // Step 6: Verify output exists
    if (!fs.existsSync(outputPath)) {
      throw new Error("Transform completed but output file not found");
    }

    const outputStat = fs.statSync(outputPath);
    logger.info("Video transform complete", {
      inputPath,
      outputPath,
      intensity,
      originalSize: fs.statSync(inputPath).size,
      transformedSize: outputStat.size,
      videoBitrate: `${Math.round(newVideoBitrate / 1000)}k`,
      audioBitrate: `${Math.round(newAudioBitrate / 1000)}k`,
      crop: `${cropW}x${cropH}`,
      brightness: brightness.toFixed(4),
      contrast: contrast.toFixed(4),
      saturation: saturation.toFixed(4),
      blackFrames: numBlackFrames,
    });

    // Cleanup temp files
    cleanupFiles(tempFiles);

    return outputPath;

  } catch (err) {
    logger.error("Video transform failed", { inputPath, intensity, error: err.message });

    // Cleanup temp files on failure
    cleanupFiles(tempFiles);

    // Also clean up partial output
    if (fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch {}
    }

    throw err;
  }
}

/**
 * Clean up temporary files (best effort)
 */
function cleanupFiles(files) {
  for (const f of files) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (e) {
      logger.debug("Failed to clean up temp file", { file: f, error: e.message });
    }
  }
}

module.exports = { transformVideo };
