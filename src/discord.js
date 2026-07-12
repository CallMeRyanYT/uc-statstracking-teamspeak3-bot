const META_LAST_SENT = "discord_last_report_at";
const META_LAST_MESSAGE_ID = "discord_last_report_message_id";
const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 24 * 60;
const SCHEDULE_WINDOW_MS = 60_000;
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
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(
    Math.max(parsed, MIN_INTERVAL_MINUTES),
    MAX_INTERVAL_MINUTES,
  );
}

function getSchedulePeriod(now, intervalMinutes) {
  const start = new Date(now);
  if (intervalMinutes <= 60) {
    start.setMinutes(0, 0, 0);
    return { start, minutes: 60 };
  }
  start.setHours(0, 0, 0, 0);
  return { start, minutes: 24 * 60 };
}

function getLatestScheduledReportAt(value, rawIntervalMinutes) {
  const now = new Date(value);
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("Scheduled report time must be a valid date.");
  }
  const intervalMinutes = parseIntervalMinutes(rawIntervalMinutes);
  const period = getSchedulePeriod(now, intervalMinutes);
  const elapsedMinutes = (now.getTime() - period.start.getTime()) / 60_000;
  const slotOffset = Math.floor(elapsedMinutes / intervalMinutes) * intervalMinutes;
  return new Date(period.start.getTime() + slotOffset * 60_000);
}

function getNextScheduledReportAt(value, rawIntervalMinutes) {
  const now = new Date(value);
  const intervalMinutes = parseIntervalMinutes(rawIntervalMinutes);
  const period = getSchedulePeriod(now, intervalMinutes);
  const latest = getLatestScheduledReportAt(now, intervalMinutes);
  const periodEnd = new Date(
    period.start.getTime() + period.minutes * 60_000,
  );
  const next = new Date(latest.getTime() + intervalMinutes * 60_000);
  return next < periodEnd ? next : periodEnd;
}

function formatReportSchedule(rawIntervalMinutes) {
  const intervalMinutes = parseIntervalMinutes(rawIntervalMinutes);
  if (intervalMinutes === 60) return "Hourly at :00";
  if (intervalMinutes < 60) {
    const slots = [];
    for (let minute = 0; minute < 60; minute += intervalMinutes) {
      slots.push(`:${String(minute).padStart(2, "0")}`);
    }
    return `Every ${intervalMinutes} min | ${slots.join(", ")}`;
  }
  if (intervalMinutes === 24 * 60) return "Daily at 00:00";
  return `Every ${intervalMinutes} min | Daily anchor 00:00`;
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
      `SELECT u.username, u.total_time, u.is_online, u.is_afk,
              CASE WHEN b.uid IS NULL THEN 0 ELSE 1 END AS is_blacklisted
         FROM users u
         LEFT JOIN user_blacklist b ON b.uid = u.uid
        WHERE u.total_time > 0 OR u.is_online = 1 OR b.uid IS NOT NULL
        ORDER BY is_blacklisted ASC, u.total_time DESC
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
            const states = [
              user.is_afk ? "AFK" : user.is_online ? "Online" : "Offline",
            ];
            if (user.is_blacklisted) states.push("Blacklisted");
            return `**${index + 1}. ${escapeDiscordMarkdown(user.username, 48)}** | ` +
              `\`${formatHours(user.total_time)}\` | ${states.join(" / ")}`;
          },
        )
        .join("\n")
    : "No activity has been tracked yet.";

  const channelText = snapshot.channels.length
    ? snapshot.channels
        .map(
          (channel) =>
            `**${escapeDiscordMarkdown(channel.channel_name, 48)}** | ` +
            `\`${formatHours(channel.total_time)}\``,
        )
        .join("\n")
    : "No channel activity yet.";

  return {
    username: "Unknown Cyberia Stats",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        author: { name: "Unknown Cyberia" },
        title: "TeamSpeak Activity Report",
        url: dashboardUrl || undefined,
        color: 0xa92cff,
        description: "Live activity and tracked-time summary.",
        fields: [
          {
            name: "Users",
            value:
              `**${snapshot.totals.users || 0}** total\n` +
              `**${snapshot.totals.online || 0}** online`,
            inline: true,
          },
          {
            name: "Tracked time",
            value: `**${formatHours(snapshot.totals.total_hours)}**`,
            inline: true,
          },
          {
            name: "Sessions",
            value: `**${snapshot.totals.total_sessions || 0}**`,
            inline: true,
          },
          { name: "Leaderboard", value: leaderboardText, inline: false },
          { name: "Top channels", value: channelText, inline: false },
          ...(dashboardUrl
            ? [
                {
                  name: "Dashboard",
                  value: `[Open live statistics](${dashboardUrl.replace(/\)/g, "%29")})`,
                  inline: false,
                },
              ]
            : []),
        ],
        footer: {
          text: `Automatic report | ${formatReportSchedule(
            options.intervalMinutes || DEFAULT_INTERVAL_MINUTES,
          )}`,
        },
        timestamp: new Date(options.timestamp || Date.now()).toISOString(),
      },
    ],
  };
}

function createDiscordReporter(options) {
  const db = options.db;
  const fetchImpl = options.fetchImpl || global.fetch;
  const intervalMinutes = parseIntervalMinutes(options.intervalMinutes);
  const logger = options.logger || console;
  const nowProvider =
    typeof options.now === "function" ? options.now : () => Date.now();
  let webhookUrl = null;
  let dashboardUrl = null;
  let configError = null;
  let lastError = null;
  let lastScheduledAttemptAt = 0;
  let inFlight = null;

  function getNow() {
    const now = new Date(nowProvider());
    return Number.isFinite(now.getTime()) ? now : new Date();
  }

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

  async function getLastMessageId() {
    const row = await db.getAsync("SELECT value FROM app_meta WHERE key = ?", [
      META_LAST_MESSAGE_ID,
    ]);
    return row && /^\d+$/.test(String(row.value || ""))
      ? String(row.value)
      : null;
  }

  async function setLastMessageId(value) {
    await db.runAsync(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [META_LAST_MESSAGE_ID, value],
    );
  }

  async function deletePreviousMessage(messageId) {
    const endpoint = new URL(webhookUrl);
    endpoint.search = "";
    endpoint.hash = "";
    endpoint.pathname =
      `${endpoint.pathname.replace(/\/$/, "")}/messages/${messageId}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const response = await fetchImpl(endpoint, {
        method: "DELETE",
        signal: controller.signal,
      });
      if (response.ok || response.status === 404) return true;
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      logger.error(
        `[Discord] Could not delete previous report (HTTP ${response.status}${detail ? `: ${detail}` : ""}).`,
      );
      return false;
    } catch (error) {
      const message =
        error && error.name === "AbortError"
          ? "timed out after 10 seconds"
          : error.message;
      logger.error(`[Discord] Could not delete previous report: ${message}.`);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function performSend() {
    if (configError) throw configError;
    if (!webhookUrl) throw new Error("Discord webhook is not configured.");
    if (typeof fetchImpl !== "function") {
      throw new Error("This Node.js version does not provide fetch().");
    }
    const attemptedAt = getNow();

    const snapshot = await readStatsSnapshot(db);
    const payload = buildDiscordPayload(snapshot, {
      intervalMinutes,
      dashboardUrl,
      timestamp: attemptedAt,
    });
    const endpoint = new URL(webhookUrl);
    endpoint.searchParams.set("wait", "true");
    const previousMessageId = await getLastMessageId();

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

      const responseBody = await response.text().catch(() => "");
      let messageId = null;
      try {
        const message = JSON.parse(responseBody);
        if (/^\d+$/.test(String(message.id || ""))) {
          messageId = String(message.id);
        }
      } catch {
        // A successful Discord wait=true response should be JSON. Keep the
        // report successful even if a proxy strips the response body.
      }

      let deletedPrevious = false;
      if (messageId) {
        if (previousMessageId && previousMessageId !== messageId) {
          deletedPrevious = await deletePreviousMessage(previousMessageId);
        }
        await setLastMessageId(messageId);
      } else {
        logger.error(
          "[Discord] Report sent, but Discord returned no message ID; the previous report was kept.",
        );
      }

      const sentAt = getNow().toISOString();
      await setLastSentAt(sentAt);
      lastError = null;
      logger.log(`[Discord] Statistics report sent (${snapshot.leaderboard.length} ranked users).`);
      return { sent: true, sentAt, messageId, deletedPrevious };
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
    const now = getNow();
    const nowMs = now.getTime();
    const scheduledAt = getLatestScheduledReportAt(now, intervalMinutes);
    const slotAgeMs = nowMs - scheduledAt.getTime();
    if (slotAgeMs < 0 || slotAgeMs >= SCHEDULE_WINDOW_MS) {
      return { sent: false };
    }

    const retryDelayMs = Math.min(intervalMinutes, 5) * 60_000;
    if (
      lastScheduledAttemptAt &&
      nowMs - lastScheduledAttemptAt < retryDelayMs
    ) {
      return { sent: false };
    }
    const lastSentAt = await getLastSentAt();
    if (lastSentAt) {
      const sentTime = new Date(lastSentAt).getTime();
      if (Number.isFinite(sentTime) && sentTime >= scheduledAt.getTime()) {
        return { sent: false };
      }
    }

    const totals = await db.getAsync("SELECT COUNT(*) AS users FROM users");
    if (!totals || !totals.users) return { sent: false };
    lastScheduledAttemptAt = nowMs;
    return sendNow();
  }

  async function getStatus() {
    return {
      configured: Boolean(webhookUrl) && !configError,
      interval_minutes: intervalMinutes,
      last_sent_at: await getLastSentAt(),
      last_error: lastError || (configError ? configError.message : null),
      dashboard_url: dashboardUrl,
      schedule: formatReportSchedule(intervalMinutes),
      next_scheduled_at: getNextScheduledReportAt(
        getNow(),
        intervalMinutes,
      ).toISOString(),
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
  formatReportSchedule,
  getLatestScheduledReportAt,
  getNextScheduledReportAt,
  parseIntervalMinutes,
  validatePublicDashboardUrl,
  validateDiscordWebhookUrl,
};
