/**
 * discord.js — Discord webhook integration
 * Sends activity reports to a Discord channel via webhook.
 * Reports are sent as plain text (no bot token needed — just webhook URL).
 */

const axios = require("axios");
const db = require("./database");
const { getActiveSessions } = require("./tracker");
const { fmtHours, rankEmoji } = require("./commands");

const WEBHOOK_URL =
  process.env.DISCORD_WEBHOOK_URL ||
  "https://discord.com/api/webhooks/1521648074139762829/U0axTr9CMsHLZEQ230HHTMk1kadu5whbBzqYbZkW8xmzQzsu6las6CkBNia9e7eiRc5h";

async function postWebhook(content) {
  if (!WEBHOOK_URL) {
    console.warn("[Discord] No webhook URL configured — skipping.");
    return;
  }
  try {
    await axios.post(WEBHOOK_URL, { content }, { timeout: 10_000 });
    console.log(`[Discord] Webhook sent (${content.length} chars).`);
  } catch (err) {
    console.error("[Discord] Webhook error:", err.response?.data || err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hourly report — top 10 all-time + currently online count
// ─────────────────────────────────────────────────────────────────────────────
async function sendHourlyReport() {
  const rows = await db.allAsync(
    "SELECT username, total_time FROM users WHERE total_time > 0 ORDER BY total_time DESC LIMIT 10"
  );

  const online = getActiveSessions().size;
  const now = new Date().toLocaleString("en-GB", {
    timeZone: process.env.TZ || "UTC",
    hour: "2-digit", minute: "2-digit",
    day: "2-digit", month: "short",
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
      lines.push(`${medal}  ${u.username.padEnd(20)} ${fmtHours(u.total_time)}`);
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
    "SELECT username, daily_time, total_time FROM users WHERE daily_time > 0 ORDER BY daily_time DESC LIMIT 10"
  );

  const today = new Date().toLocaleDateString("en-GB", {
    day: "2-digit", month: "long", year: "numeric",
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
      lines.push(`${medal}  ${u.username.padEnd(20)} ${fmtHours(u.daily_time).padEnd(10)}  (all-time: ${fmtHours(u.total_time)})`);
    });
  }

  lines.push("```");

  if (rows[0]) {
    lines.push(`🌟 **Most active today:** ${rows[0].username} with **${fmtHours(rows[0].daily_time)}** online!`);
  }

  await postWebhook(lines.join("\n"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly report — weekly leaderboard + all-time top 10
// ─────────────────────────────────────────────────────────────────────────────
async function sendWeeklyReport() {
  const weeklyRows = await db.allAsync(
    "SELECT username, weekly_time FROM users WHERE weekly_time > 0 ORDER BY weekly_time DESC LIMIT 10"
  );
  const allTimeRows = await db.allAsync(
    "SELECT username, total_time FROM users WHERE total_time > 0 ORDER BY total_time DESC LIMIT 10"
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
      lines.push(`${medal}  ${u.username.padEnd(20)} ${fmtHours(u.weekly_time)}`);
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
      lines.push(`${medal}  ${u.username.padEnd(20)} ${fmtHours(u.total_time)}`);
    });
  }

  lines.push("```");
  await postWebhook(lines.join("\n"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Join/Leave notification (optional — controlled by JOIN_LEAVE_WEBHOOK env)
// ─────────────────────────────────────────────────────────────────────────────
async function sendJoinNotification(username, channelName) {
  if (process.env.JOIN_LEAVE_WEBHOOK !== "true") return;
  await postWebhook(`🟢 **${username}** joined **${channelName}**`);
}

async function sendLeaveNotification(username) {
  if (process.env.JOIN_LEAVE_WEBHOOK !== "true") return;
  await postWebhook(`🔴 **${username}** left the server`);
}

module.exports = {
  sendHourlyReport,
  sendDailyReport,
  sendWeeklyReport,
  sendJoinNotification,
  sendLeaveNotification,
};
