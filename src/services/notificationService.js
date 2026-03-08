const axios = require("axios");
const logger = require("../utils/logger");

/**
 * Send Discord webhook notification
 */
async function sendDiscord(webhookUrl, { title, message, color = 0x6366f1, fields = [] }) {
  if (!webhookUrl) return;
  try {
    await axios.post(webhookUrl, {
      embeds: [{
        title,
        description: message,
        color,
        fields: fields.map(f => ({ name: f.name, value: String(f.value), inline: f.inline !== false })),
        timestamp: new Date().toISOString(),
        footer: { text: "ReelFlow" },
      }],
    }, { timeout: 10000 });
  } catch (err) {
    logger.error("Discord notification failed", { error: err.message });
  }
}

/**
 * Send Telegram bot notification
 */
async function sendTelegram(botToken, chatId, { title, message, fields = [] }) {
  if (!botToken || !chatId) return;
  try {
    let text = `<b>${title}</b>\n\n${message}`;
    if (fields.length > 0) {
      text += "\n\n" + fields.map(f => `<b>${f.name}:</b> ${f.value}`).join("\n");
    }
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }, { timeout: 10000 });
  } catch (err) {
    logger.error("Telegram notification failed", { error: err.message });
  }
}

/**
 * Send Slack webhook notification
 */
async function sendSlack(webhookUrl, { title, message, fields = [] }) {
  if (!webhookUrl) return;
  try {
    const blocks = [
      { type: "header", text: { type: "plain_text", text: title } },
      { type: "section", text: { type: "mrkdwn", text: message } },
    ];

    if (fields.length > 0) {
      blocks.push({
        type: "section",
        fields: fields.map(f => ({
          type: "mrkdwn",
          text: `*${f.name}*\n${f.value}`,
        })),
      });
    }

    await axios.post(webhookUrl, { blocks }, { timeout: 10000 });
  } catch (err) {
    logger.error("Slack notification failed", { error: err.message });
  }
}

/**
 * Notify user about an event
 */
async function notify(user, event, data = {}) {
  const { notifications } = user;
  if (!notifications) return;

  const eventConfig = {
    post_success: {
      enabled: true,
      title: "Video Posted Successfully",
      message: `Posted to @${data.username}: ${data.caption?.slice(0, 100) || "No caption"}`,
      color: 0x059669,
    },
    post_failed: {
      enabled: notifications.postFailure,
      title: "Post Failed",
      message: `Failed for @${data.username}: ${data.error || "Unknown error"}`,
      color: 0xdc2626,
    },
    account_error: {
      enabled: notifications.postFailure,
      title: "Account Error",
      message: `@${data.username} encountered an error: ${data.error}`,
      color: 0xd97706,
    },
    queue_complete: {
      enabled: true,
      title: "Queue Processing Complete",
      message: `${data.count} videos processed for @${data.username}`,
      color: 0x6366f1,
    },
    daily_summary: {
      enabled: notifications.weeklyDigest,
      title: "Daily Summary",
      message: data.message || "Your daily posting summary",
      color: 0x6366f1,
    },
  };

  const config = eventConfig[event];
  if (!config || !config.enabled) return;

  const payload = {
    title: config.title,
    message: config.message,
    color: config.color,
    fields: data.fields || [],
  };

  // Send to all configured channels
  const promises = [];
  if (notifications.discordWebhook) promises.push(sendDiscord(notifications.discordWebhook, payload));
  if (notifications.slackWebhook) promises.push(sendSlack(notifications.slackWebhook, payload));
  if (notifications.telegramBotToken && notifications.telegramChatId) {
    promises.push(sendTelegram(notifications.telegramBotToken, notifications.telegramChatId, payload));
  }

  await Promise.allSettled(promises);
}

module.exports = { sendDiscord, sendSlack, sendTelegram, notify };
