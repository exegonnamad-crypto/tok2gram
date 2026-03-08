const fs = require("fs");
const logger = require("../utils/logger");
const config = require("../config");
const Video = require("../models/Video");

let cloudinary = null;

function getCloudinary() {
  if (!cloudinary) {
    cloudinary = require("cloudinary").v2;
    cloudinary.config({
      cloud_name: config.cloudinary.cloudName,
      api_key: config.cloudinary.apiKey,
      api_secret: config.cloudinary.apiSecret,
    });
  }
  return cloudinary;
}

/**
 * Upload video to Cloudinary
 */
async function uploadVideo(videoId, filePath) {
  try {
    const cl = getCloudinary();
    const result = await cl.uploader.upload(filePath, {
      resource_type: "video",
      folder: "reelflow",
      timeout: 180000,
      chunk_size: 10000000,
    });

    await Video.findByIdAndUpdate(videoId, {
      cloudinaryUrl: result.secure_url,
      cloudinaryPublicId: result.public_id,
      fileSize: result.bytes || 0,
      width: result.width || 0,
      height: result.height || 0,
      duration: result.duration || 0,
    });

    // Clean up local file
    fs.unlink(filePath, () => {});
    logger.info(`Cloudinary upload done: ${videoId}`);
    return result;
  } catch (err) {
    logger.error(`Cloudinary upload failed: ${videoId}`, { error: err.message });
    await Video.findByIdAndUpdate(videoId, {
      error: `Cloudinary upload failed: ${err.message}`,
    });
    return null;
  }
}

/**
 * Delete video from Cloudinary
 */
async function deleteVideo(publicId) {
  if (!publicId) return;
  try {
    const cl = getCloudinary();
    await cl.uploader.destroy(publicId, { resource_type: "video" });
    logger.info(`Cloudinary deleted: ${publicId}`);
  } catch (err) {
    logger.error(`Cloudinary delete failed: ${publicId}`, { error: err.message });
  }
}

/**
 * Get storage usage stats
 */
async function getUsageStats() {
  try {
    const cl = getCloudinary();
    const result = await cl.api.usage();
    return {
      storage: result.storage?.usage || 0,
      bandwidth: result.bandwidth?.usage || 0,
      transformations: result.transformations?.usage || 0,
      limit: result.storage?.limit || 0,
    };
  } catch {
    return null;
  }
}

module.exports = { uploadVideo, deleteVideo, getUsageStats };
