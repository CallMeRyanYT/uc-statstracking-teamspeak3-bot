/**
 * commands.js — All !command handlers for TS3 chat
 *
 * Each handler receives (args, senderUid, senderNick, ts3) and returns
 * a string to send back to the channel, or null to stay silent.
 */

const db = require("./database");
const { getActiveSessions } = require("./tracker");

const PREFIX = process.env.COMMAND_PREFIX || "#";
const HOURS_PER_TICK =
  (parseInt(process.env.POLL_INTERVAL_MS, 10) || 60_000) / 3_600_000;

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────
function fmtHours(hours) {
  if (hours === null || hours === undefined || isNaN(hours)) return "0h 0m";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}h ${m}m`;
}

function fmtDate(iso) {
  if (!iso) return "Never";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function rankEmoji(i) {
  return ["🥇", "🥈", "🥉"][i] || `#${i + 1}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// !help
// ─────────────────────────────────────────────────────────────────────────────
async function cmdHelp() {
  const p = PREFIX;
  return [
    "═══════════════════════════════",
    "  📊 UC Stats Bot — Commands",
    "═══════════════════════════════",
    `${p}stats [name]   — Your full stats card (or someone else's)`,
    `${p}rank [name]    — Your leaderboard rank`,
    `${p}top            — All-time top 10`,
    `${p}today          — Today's top 10`,
    `${p}week           — This week's top 10`,
    `${p}month          — This month's top 10`,
    `${p}online         — Currently online users`,
    `${p}session        — Your current session time`,
    `${p}peak           — Your most active hours`,
    `${p}channels       — Your top channels`,
    `${p}history        — Your last 5 sessions`,
    `${p}afk [name]     — AFK time stats`,
    `${p}server         — Server-wide stats`,
    `${p}help           — This message`,
    "═══════════════════════════════",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// !stats [name]
// ─────────────────────────────────────────────────────────────────────────────
async function cmdStats(args, senderUid) {
  let user;
  if (args.length > 0) {
    const name = args.join(" ");
    user = await db.getAsync(
      "SELECT * FROM users WHERE username LIKE ? ORDER BY total_time DESC LIMIT 1",
      [`%${name}%`],
    );
    if (!user) return `❌ No user found matching "${name}".`;
  } else {
    user = await db.getAsync("SELECT * FROM users WHERE uid = ?", [senderUid]);
    if (!user)
      return `❌ No stats found for you yet — join a channel and wait a minute!`;
  }

  const rank = await db.getAsync(
    "SELECT COUNT(*) AS r FROM users WHERE total_time > ?",
    [user.total_time],
  );
  const position = (rank?.r ?? 0) + 1;

  const sessions = await db.getAsync(
    "SELECT AVG(duration_hours) AS avg, MAX(duration_hours) AS max FROM sessions WHERE uid = ? AND session_end IS NOT NULL",
    [user.uid],
  );

  const status = user.is_online
    ? user.is_afk
      ? "🟡 Online (AFK)"
      : "🟢 Online"
    : "🔴 Offline";

  return [
    `╔══════════════════════════════╗`,
    `  📊 Stats for [b]${user.username}[/b]`,
    `╚══════════════════════════════╝`,
    `  Status       : ${status}`,
    `  Rank          : #${position}`,
    `  Total Time    : ${fmtHours(user.total_time)}`,
    `  Today         : ${fmtHours(user.daily_time)}`,
    `  This Week     : ${fmtHours(user.weekly_time)}`,
    `  This Month    : ${fmtHours(user.monthly_time)}`,
    `  AFK Time      : ${fmtHours(user.afk_time)}`,
    `  Sessions      : ${user.session_count}`,
    `  Avg Session   : ${fmtHours(sessions?.avg || 0)}`,
    `  Longest Session: ${fmtHours(sessions?.max || 0)}`,
    `  First Seen    : ${fmtDate(user.first_seen)}`,
    `  Last Seen     : ${fmtDate(user.last_seen)}`,
    user.current_channel ? `  Current Chan  : ${user.current_channel}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// !rank [name]
// ─────────────────────────────────────────────────────────────────────────────
async function cmdRank(args, senderUid) {
  let uid = senderUid;
  let username;

  if (args.length > 0) {
    const name = args.join(" ");
    const u = await db.getAsync(
      "SELECT uid, username, total_time FROM users WHERE username LIKE ? ORDER BY total_time DESC LIMIT 1",
      [`%${name}%`],
    );
    if (!u) return `❌ No user found matching "${name}".`;
    uid = u.uid;
    username = u.username;
  } else {
    const u = await db.getAsync("SELECT username FROM users WHERE uid = ?", [
      uid,
    ]);
    username = u?.username || "You";
  }

  const user = await db.getAsync("SELECT total_time FROM users WHERE uid = ?", [
    uid,
  ]);
  if (!user) return `❌ No stats yet.`;

  const rank = await db.getAsync(
    "SELECT COUNT(*) AS r FROM users WHERE total_time > ?",
    [user.total_time],
  );
  const total = await db.getAsync("SELECT COUNT(*) AS c FROM users");
  const position = (rank?.r ?? 0) + 1;

  return `🏆 [b]${username}[/b] is ranked [b]#${position}[/b] out of ${total?.c || 1} players with [b]${fmtHours(user.total_time)}[/b] total time.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic leaderboard builder
// ─────────────────────────────────────────────────────────────────────────────
async function buildLeaderboard(title, col, limit = 10) {
  const rows = await db.allAsync(
    `SELECT username, ${col} as t FROM users WHERE ${col} > 0 ORDER BY ${col} DESC LIMIT ?`,
    [limit],
  );
  if (!rows || rows.length === 0)
    return `📊 ${title}\n\nNo activity recorded yet!`;

  const lines = [`📊 [b]${title}[/b]`, "─────────────────────────────"];
  rows.forEach((u, i) => {
    lines.push(`${rankEmoji(i)}  [b]${u.username}[/b] — ${fmtHours(u.t)}`);
  });
  return lines.join("\n");
}

// !top
async function cmdTop() {
  return buildLeaderboard("All-Time Leaderboard", "total_time");
}

// !today
async function cmdToday() {
  return buildLeaderboard("Today's Leaderboard", "daily_time");
}

// !week
async function cmdWeek() {
  return buildLeaderboard("This Week's Leaderboard", "weekly_time");
}

// !month
async function cmdMonth() {
  return buildLeaderboard("This Month's Leaderboard", "monthly_time");
}

// ─────────────────────────────────────────────────────────────────────────────
// !online
// ─────────────────────────────────────────────────────────────────────────────
async function cmdOnline() {
  const sessions = getActiveSessions();
  if (sessions.size === 0) return "😴 Nobody is currently online.";

  const now = Date.now();
  const lines = ["🟢 [b]Currently Online[/b]", "─────────────────────────"];
  let i = 1;
  for (const [uid, sess] of sessions) {
    const sessionHours = (now - sess.start.getTime()) / 3_600_000;
    const row = await db.getAsync(
      "SELECT username, is_afk FROM users WHERE uid = ?",
      [uid],
    );
    const nick = row?.username || uid;
    const afkTag = row?.is_afk ? " 🟡[AFK]" : "";
    lines.push(
      `${i++}. [b]${nick}[/b]${afkTag} — session: ${fmtHours(sessionHours)} — in: ${sess.channelName}`,
    );
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// !session
// ─────────────────────────────────────────────────────────────────────────────
async function cmdSession(args, senderUid, senderNick) {
  const sessions = getActiveSessions();
  const sess = sessions.get(senderUid);
  if (!sess)
    return `⏸ You don't have an active session right now, ${senderNick}.`;
  const hours = (Date.now() - sess.start.getTime()) / 3_600_000;
  return `⏱ [b]${senderNick}[/b] — Current session: [b]${fmtHours(hours)}[/b] in [b]${sess.channelName}[/b].`;
}

// ─────────────────────────────────────────────────────────────────────────────
// !peak
// ─────────────────────────────────────────────────────────────────────────────
async function cmdPeak(args, senderUid) {
  const uid = senderUid;
  const rows = await db.allAsync(
    `SELECT hour_of_day, SUM(ticks) AS t
       FROM hourly_activity WHERE uid = ?
      GROUP BY hour_of_day ORDER BY t DESC LIMIT 5`,
    [uid],
  );
  if (!rows || rows.length === 0)
    return "📈 Not enough data for peak hours yet.";

  const lines = ["📈 [b]Your Peak Hours[/b]", "──────────────────────"];
  rows.forEach((r, i) => {
    const h = r.hour_of_day;
    const peakHours = r.t * HOURS_PER_TICK;
    const label = `${String(h).padStart(2, "0")}:00 – ${String(h + 1).padStart(2, "0")}:00`;
    lines.push(`${i + 1}. ${label} — ${fmtHours(peakHours)}`);
  });
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// !channels
// ─────────────────────────────────────────────────────────────────────────────
async function cmdChannels(args, senderUid) {
  const rows = await db.allAsync(
    `SELECT channel_name, total_time, visit_count
       FROM channel_time WHERE uid = ?
      ORDER BY total_time DESC LIMIT 5`,
    [senderUid],
  );
  if (!rows || rows.length === 0) return "📡 No channel data yet.";

  const lines = ["📡 [b]Your Top Channels[/b]", "────────────────────────"];
  rows.forEach((r, i) => {
    lines.push(
      `${i + 1}. [b]${r.channel_name}[/b] — ${fmtHours(r.total_time)} (${r.visit_count} visits)`,
    );
  });
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// !history
// ─────────────────────────────────────────────────────────────────────────────
async function cmdHistory(args, senderUid) {
  const rows = await db.allAsync(
    `SELECT session_start, session_end, duration_hours, channel_name
       FROM sessions WHERE uid = ? AND session_end IS NOT NULL
      ORDER BY session_start DESC LIMIT 5`,
    [senderUid],
  );
  if (!rows || rows.length === 0)
    return "📜 No completed sessions recorded yet.";

  const lines = [
    "📜 [b]Your Last 5 Sessions[/b]",
    "──────────────────────────────",
  ];
  rows.forEach((r, i) => {
    const start = fmtDate(r.session_start);
    lines.push(
      `${i + 1}. ${start} — ${fmtHours(r.duration_hours)} in [b]${r.channel_name || "?"}[/b]`,
    );
  });
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// !afk [name]
// ─────────────────────────────────────────────────────────────────────────────
async function cmdAfk(args, senderUid) {
  let user;
  if (args.length > 0) {
    const name = args.join(" ");
    user = await db.getAsync(
      "SELECT username, afk_time, total_time FROM users WHERE username LIKE ? ORDER BY total_time DESC LIMIT 1",
      [`%${name}%`],
    );
    if (!user) return `❌ No user found matching "${name}".`;
  } else {
    user = await db.getAsync(
      "SELECT username, afk_time, total_time FROM users WHERE uid = ?",
      [senderUid],
    );
    if (!user) return "❌ No stats for you yet.";
  }

  const pct =
    user.total_time > 0
      ? ((user.afk_time / (user.total_time + user.afk_time)) * 100).toFixed(1)
      : "0.0";

  return `🟡 [b]${user.username}[/b] — AFK time: [b]${fmtHours(user.afk_time)}[/b] (${pct}% of total presence)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// !server
// ─────────────────────────────────────────────────────────────────────────────
async function cmdServer() {
  const stats = await db.getAsync(
    `SELECT COUNT(*) AS users,
            SUM(total_time) AS total,
            SUM(session_count) AS sessions,
            MAX(total_time) AS top_time
     FROM users`,
  );
  const topUser = await db.getAsync(
    "SELECT username, total_time FROM users ORDER BY total_time DESC LIMIT 1",
  );
  const online = getActiveSessions().size;

  return [
    "🌐 [b]Server Stats[/b]",
    "──────────────────────────────",
    `  Tracked Users  : ${stats?.users || 0}`,
    `  Currently Online: ${online}`,
    `  Total Sessions  : ${stats?.sessions || 0}`,
    `  All-Time Hours  : ${fmtHours(stats?.total || 0)}`,
    `  Top Player      : ${topUser ? `${topUser.username} (${fmtHours(topUser.total_time)})` : "N/A"}`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Command router — parses a raw chat message, returns reply string or null
// ─────────────────────────────────────────────────────────────────────────────
async function handleMessage(rawText, senderUid, senderNick) {
  if (!rawText.startsWith(PREFIX)) return null;

  const parts = rawText.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  try {
    switch (cmd) {
      case "help":
        return await cmdHelp();
      case "stats":
        return await cmdStats(args, senderUid);
      case "rank":
        return await cmdRank(args, senderUid);
      case "top":
      case "leaderboard":
        return await cmdTop();
      case "today":
        return await cmdToday();
      case "week":
        return await cmdWeek();
      case "month":
        return await cmdMonth();
      case "online":
        return await cmdOnline();
      case "session":
        return await cmdSession(args, senderUid, senderNick);
      case "peak":
        return await cmdPeak(args, senderUid);
      case "channels":
        return await cmdChannels(args, senderUid);
      case "history":
        return await cmdHistory(args, senderUid);
      case "afk":
        return await cmdAfk(args, senderUid);
      case "server":
        return await cmdServer();
      default:
        return null; // Unknown command — stay silent
    }
  } catch (err) {
    console.error(`[Commands] Error in !${cmd}:`, err);
    return `⚠️ An error occurred running !${cmd}. Check bot logs.`;
  }
}

module.exports = { handleMessage, fmtHours, rankEmoji };
