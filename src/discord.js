const META_LAST_SENT = "discord_last_report_at";
const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 5;
const WEBHOOK_TIMEOUT_MS = 10_000;

const DISCORD_WEBHOOK_HOSTS = new Set([
  "discord.com",
  "www.discord.com",
  "canary.discord.com",
  "ptb.discord.com",
  "discordapp.com",
  "www.discordapp.com",
]);

function validateDiscordWebhookUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Discord webhook URL is not a valid URL.");
  }

  if (url.protocol !== "https:" || !DISCORD_WEBHOOK_HOSTS.has(url.hostname)) {
    throw new Error("Discord webhook must use an official Discord HTTPS host.");
  }

  if (!/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+\/?$/.test(url.pathname)) {
    throw new Error("Discord webhook URL does not contain a valid webhook ID and token.");
  }

  return url;
}

function validatePublicDashboardUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Public dashboard URL is not a valid URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Public dashboard URL must use HTTP or HTTPS.");
  }

  if (url.username || url.password) {
    throw new Error("Public dashboard URL cannot contain login credentials.");
  }

  if (url.toString().length > 500) {
    throw new Error("Public dashboard URL is too long.");
  }

  url.hash = "";
  return url.toString();
}

function parseIntervalMinutes(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(parsed, MIN_INTERVAL_MINUTES);
}

function formatHours(value) {
  const totalMinutes = Math.max(0, Math.round((Number(value) || 0) * 60));
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

function escapeDiscordMarkdown(value, maxLength = 80) {
  return String(value || "Unknown")
    .replace(/\s+/g, " ")
    .replace(/@/g, "@\u200b")
    .replace(/([\\`*_{}[\]()#+\-.!|>~])/g, "\\$1")
    .slice(0, maxLength);
}

async function readStatsSnapshot(db) {
  const [totals, leaderboard, channels] = await Promise.all([
    db.getAsync(
      `SELECT COUNT(*) AS users,
              COALESCE(SUM(total_time), 0) AS total_hours,
              (SELECT COUNT(*) FROM sessions) AS total_sessions,
              COALESCE(SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END), 0) AS online
       FROM users`,
    ),
    db.allAsync(
      `SELECT username, total_time, is_online, is_afk
       FROM users
       WHERE total_time > 0 OR is_online = 1
       ORDER BY total_time DESC
       LIMIT 10`,
    ),
    db.allAsync(
      `SELECT channel_name, SUM(total_time) AS total_time
       FROM channel_time
       WHERE total_time > 0
       GROUP BY channel_name
       ORDER BY total_time DESC
       LIMIT 3`,
    ),
  ]);

  return {
    totals: totals || { users: 0, total_hours: 0, total_sessions: 0, online: 0 },
    leaderboard: leaderboard || [],
    channels: channels || [],
  };
}

function buildDiscordPayload(snapshot, options = {}) {
  const dashboardUrl = options.dashboardUrl || null;
  const leaderboardText = snapshot.leaderboard.length
    ? snapshot.leaderboard
        .map(
          (user, index) => {
            const status = user.is_afk
              ? " (AFK)"
              : user.is_online
                ? " (online)"
                : "";
            return (
              `**${index + 1}.** ${escapeDiscordMarkdown(user.username, 48)} - ` +
              `\`${formatHours(user.total_time)}\`${status}`
            );
          },
        )
        .join("\n")
    : "No activity has been tracked yet.";

  const channelText = snapshot.channels.length
    ? snapshot.channels
        .map(
          (channel) =>
            `${escapeDiscordMarkdown(channel.channel_name, 48)} - ` +
            `\`${formatHours(channel.total_time)}\``,
        )
        .join("\n")
    : "No channel activity yet.";

  return {
    username: "Unknown Cyberia Stats",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: "Unknown Cyberia TeamSpeak Statistics",
        url: dashboardUrl || undefined,
        color: 0x9b7abb,
        description: leaderboardText,
        fields: [
          { name: "Users", value: String(snapshot.totals.users || 0), inline: true },
          { name: "Online", value: String(snapshot.totals.online || 0), inline: true },
          {
            name: "Tracked time",
            value: formatHours(snapshot.totals.total_hours),
            inline: true,
          },
          {
            name: "Sessions",
            value: String(snapshot.totals.total_sessions || 0),
            inline: true,
          },
          { name: "Top channels", value: channelText, inline: false },
          ...(dashboardUrl
            ? [
                {
                  name: "Website",
                  value: `<${dashboardUrl}>`,
                  inline: false,
                },
              ]
            : []),
        ],
        footer: {
          text:
            `Automatic report | Every ${options.intervalMinutes || DEFAULT_INTERVAL_MINUTES} minutes` +
            (dashboardUrl ? ` | ${dashboardUrl}` : ""),
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function createDiscordReporter(options) {
  const db = options.db;
  const fetchImpl = options.fetchImpl || global.fetch;
  const intervalMinutes = parseIntervalMinutes(options.intervalMinutes);
  const logger = options.logger || console;
  let webhookUrl = null;
  let dashboardUrl = null;
  let configError = null;
  let lastError = null;
  let lastAttemptAt = 0;
  let inFlight = null;

  try {
    webhookUrl = validateDiscordWebhookUrl(options.webhookUrl);
  } catch (error) {
    configError = error;
    logger.error(`[Discord] ${error.message}`);
  }

  try {
    dashboardUrl = validatePublicDashboardUrl(options.dashboardUrl);
  } catch (error) {
    logger.error(`[Discord] ${error.message}`);
  }

  async function getLastSentAt() {
    const row = await db.getAsync("SELECT value FROM app_meta WHERE key = ?", [
      META_LAST_SENT,
    ]);
    return row && row.value ? row.value : null;
  }

  async function setLastSentAt(value) {
    await db.runAsync(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [META_LAST_SENT, value],
    );
  }

  async function performSend() {
    if (configError) throw configError;
    if (!webhookUrl) throw new Error("Discord webhook is not configured.");
    if (typeof fetchImpl !== "function") {
      throw new Error("This Node.js version does not provide fetch().");
    }
    lastAttemptAt = Date.now();

    const snapshot = await readStatsSnapshot(db);
    const payload = buildDiscordPayload(snapshot, {
      intervalMinutes,
      dashboardUrl,
    });
    const endpoint = new URL(webhookUrl);
    endpoint.searchParams.set("wait", "true");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        throw new Error(
          `Discord webhook returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        );
      }

      const sentAt = new Date().toISOString();
      await setLastSentAt(sentAt);
      lastError = null;
      logger.log(`[Discord] Statistics report sent (${snapshot.leaderboard.length} ranked users).`);
      return { sent: true, sentAt };
    } catch (error) {
      const normalized =
        error && error.name === "AbortError"
          ? new Error("Discord webhook timed out after 10 seconds.")
          : error;
      lastError = normalized.message;
      throw normalized;
    } finally {
      clearTimeout(timeout);
    }
  }

  function sendNow() {
    if (inFlight) return inFlight;
    inFlight = performSend().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function maybeSend() {
    if (!webhookUrl || configError || inFlight) return { sent: false };
    const retryDelayMs = Math.min(intervalMinutes, 5) * 60_000;
    if (lastAttemptAt && Date.now() - lastAttemptAt < retryDelayMs) {
      return { sent: false };
    }
    const lastSentAt = await getLastSentAt();
    if (lastSentAt) {
      const elapsed = Date.now() - new Date(lastSentAt).getTime();
      if (Number.isFinite(elapsed) && elapsed < intervalMinutes * 60_000) {
        return { sent: false };
      }
    }

    const totals = await db.getAsync("SELECT COUNT(*) AS users FROM users");
    if (!totals || !totals.users) return { sent: false };
    return sendNow();
  }

  async function getStatus() {
    return {
      configured: Boolean(webhookUrl) && !configError,
      interval_minutes: intervalMinutes,
      last_sent_at: await getLastSentAt(),
      last_error: lastError || (configError ? configError.message : null),
      dashboard_url: dashboardUrl,
    };
  }

  return {
    configured: Boolean(webhookUrl) && !configError,
    intervalMinutes,
    sendNow,
    maybeSend,
    getStatus,
  };
}

module.exports = {
  buildDiscordPayload,
  createDiscordReporter,
  escapeDiscordMarkdown,
  parseIntervalMinutes,
  validatePublicDashboardUrl,
  validateDiscordWebhookUrl,
};
