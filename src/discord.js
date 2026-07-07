/**
 * discord.js — Discord webhook integration
 * Sends activity reports to a Discord channel via webhook.
 * Reports are sent as plain text (no bot token needed — just webhook URL).
 */

const axios = require("axios");
const db = require("./database");
const { getActiveSessions } = require("./tracker");
const { fmtHours } = require("./commands");

const REPORT_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const COMMAND_WEBHOOK_URL =
  process.env.COMMAND_WEBHOOK_URL || REPORT_WEBHOOK_URL;
const HELP_WEBHOOK_URL = process.env.HELP_WEBHOOK_URL || COMMAND_WEBHOOK_URL;
const JOIN_LEAVE_WEBHOOK_URL = process.env.JOIN_LEAVE_WEBHOOK_URL || "";
const JOIN_LEAVE_ENABLED = process.env.JOIN_LEAVE_WEBHOOK === "true";

function sanitizeDiscordText(text) {
  return String(text || "")
    .replace(/@/g, "@\u200b")
    .replace(/\[b\]/gi, "**")
    .replace(/\[\/b\]/gi, "**")
    .replace(/\[i\]/gi, "*")
    .replace(/\[\/i\]/gi, "*")
    .replace(/\[u\]/gi, "__")
    .replace(/\[\/u\]/gi, "__")
    .replace(/```/g, "`\u200b``");
}

function truncateDiscordMessage(content) {
  if (content.length <= 1950) return content;
  return `${content.slice(0, 1947)}...`;
}

async function postWebhook(
  content,
  webhookUrl = REPORT_WEBHOOK_URL,
  label = "report",
) {
  if (!webhookUrl) {
    console.warn(`[Discord] No ${label} webhook URL configured; skipping.`);
    return;
  }

  try {
    await axios.post(webhookUrl, { content }, { timeout: 10_000 });
    console.log(`[Discord] ${label} webhook sent (${content.length} chars).`);
  } catch (err) {
    console.error(
      `[Discord] ${label} webhook error:`,
      err.response?.data || err.message,
    );
  }
}

async function sendCommandResultNotification(
  commandName,
  text,
  reply,
  invokerNick,
) {
  if (process.env.MIRROR_COMMAND_RESULTS_TO_DISCORD === "false") return;
  if (!commandName || !reply) return;

  const isHelp = commandName === "help";
  const webhookUrl = isHelp ? HELP_WEBHOOK_URL : COMMAND_WEBHOOK_URL;
  const label = isHelp ? "help" : "command";
  const discordMsg = [
    `**${sanitizeDiscordText(invokerNick)}** used \`${sanitizeDiscordText(text)}\` in TeamSpeak`,
    "",
    sanitizeDiscordText(reply),
  ].join("\n");

  await postWebhook(truncateDiscordMessage(discordMsg), webhookUrl, label);
}

// Hourly report - top 10 all-time + currently online count
async function sendHourlyReport() {
  const rows = await db.allAsync(
    "SELECT username, total_time FROM users WHERE total_time > 0 ORDER BY total_time DESC LIMIT 10",
  );

  const online = getActiveSessions().size;
  const now = new Date().toLocaleString("en-GB", {
    timeZone: process.env.TZ || "UTC",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  });

  const lines = [
    `🕐 **Hourly Activity Update** — ${now}`,
    `🟢 **${online}** user(s) currently online`,
    "```",
    "🏆  All-Time Leaderboard (Top 10)",
    "─────────────────────────────────",
  ];

  if (rows.length === 0) {
    lines.push("  No activity recorded yet!");
  } else {
    rows.forEach((u, i) => {
      const medal = ["🥇", "🥈", "🥉"][i] || `${String(i + 1).padStart(2)}.`;
      lines.push(
        `${medal}  ${u.username.padEnd(20)} ${fmtHours(u.total_time)}`,
      );
    });
  }

  lines.push("```");
  await postWebhook(lines.join("\n"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily report — top 10 for TODAY + most active user badge
// ─────────────────────────────────────────────────────────────────────────────
async function sendDailyReport() {
  const rows = await db.allAsync(
    "SELECT username, daily_time, total_time FROM users WHERE daily_time > 0 ORDER BY daily_time DESC LIMIT 10",
  );

  const today = new Date().toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const lines = [
    `📅 **Daily Leaderboard** — ${today}`,
    "```",
    "Most Active Today",
    "─────────────────────────────────",
  ];

  if (rows.length === 0) {
    lines.push("  No activity today!");
  } else {
    rows.forEach((u, i) => {
      const medal = ["🥇", "🥈", "🥉"][i] || `${String(i + 1).padStart(2)}.`;
      lines.push(
        `${medal}  ${u.username.padEnd(20)} ${fmtHours(u.daily_time).padEnd(10)}  (all-time: ${fmtHours(u.total_time)})`,
      );
    });
  }

  lines.push("```");

  if (rows[0]) {
    lines.push(
      `🌟 **Most active today:** ${rows[0].username} with **${fmtHours(rows[0].daily_time)}** online!`,
    );
  }

  await postWebhook(lines.join("\n"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly report — weekly leaderboard + all-time top 10
// ─────────────────────────────────────────────────────────────────────────────
async function sendWeeklyReport() {
  const weeklyRows = await db.allAsync(
    "SELECT username, weekly_time FROM users WHERE weekly_time > 0 ORDER BY weekly_time DESC LIMIT 10",
  );
  const allTimeRows = await db.allAsync(
    "SELECT username, total_time FROM users WHERE total_time > 0 ORDER BY total_time DESC LIMIT 10",
  );

  const lines = [
    "📊 **Weekly Summary Report**",
    "",
    "**📅 This Week's Leaderboard:**",
    "```",
  ];

  if (weeklyRows.length === 0) {
    lines.push("  No activity this week!");
  } else {
    weeklyRows.forEach((u, i) => {
      const medal = ["🥇", "🥈", "🥉"][i] || `${String(i + 1).padStart(2)}.`;
      lines.push(
        `${medal}  ${u.username.padEnd(20)} ${fmtHours(u.weekly_time)}`,
      );
    });
  }

  lines.push("```");
  lines.push("");
  lines.push("**🏆 All-Time Leaderboard:**");
  lines.push("```");

  if (allTimeRows.length === 0) {
    lines.push("  No activity recorded!");
  } else {
    allTimeRows.forEach((u, i) => {
      const medal = ["🥇", "🥈", "🥉"][i] || `${String(i + 1).padStart(2)}.`;
      lines.push(
        `${medal}  ${u.username.padEnd(20)} ${fmtHours(u.total_time)}`,
      );
    });
  }

  lines.push("```");
  await postWebhook(lines.join("\n"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Join/Leave notification (optional — controlled by JOIN_LEAVE_WEBHOOK env)
// ─────────────────────────────────────────────────────────────────────────────
async function postActivityWebhook(content) {
  if (!JOIN_LEAVE_ENABLED) return;
  await postWebhook(content, JOIN_LEAVE_WEBHOOK_URL, "join/leave");
}

async function sendJoinNotification(username, channelName) {
  await postActivityWebhook(
    `**${sanitizeDiscordText(username)}** joined **${sanitizeDiscordText(channelName || "Unknown channel")}**`,
  );
}

async function sendLeaveNotification(username, channelName) {
  await postActivityWebhook(
    `**${sanitizeDiscordText(username)}** left **${sanitizeDiscordText(channelName || "the server")}**`,
  );
}

async function sendMoveNotification(username, fromChannel, toChannel) {
  await postActivityWebhook(
    `**${sanitizeDiscordText(username)}** moved from **${sanitizeDiscordText(fromChannel || "Unknown channel")}** to **${sanitizeDiscordText(toChannel || "Unknown channel")}**`,
  );
}

module.exports = {
  postWebhook,
  sendCommandResultNotification,
  sendHourlyReport,
  sendDailyReport,
  sendWeeklyReport,
  sendJoinNotification,
  sendLeaveNotification,
  sendMoveNotification,
};
