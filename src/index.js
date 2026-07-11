/**
 * index.js -- UC Stats Tracking Bot for TeamSpeak 3
 *
 * Connection: TS3 ServerQuery (TCP port 10011)
 * Works on localhost: set TS3_HOST=host.docker.internal when running in Docker
 * on the same PC as the TS3 server.
 */

require("dotenv").config();
const { TeamSpeak } = require("ts3-nodejs-library");
const net = require("net");
const cron = require("node-cron");
const express = require("express");
const path = require("path");

const db = require("./database");
const { TeamSpeakAdminAuth } = require("./admin-auth");
const {
  createDiscordReporter,
  validatePublicDashboardUrl,
} = require("./discord");
const {
  processClientTick,
  reconcileOfflineClients,
  resetDailyTimes,
  resetWeeklyTimes,
  resetMonthlyTimes,
  getActiveSessions,
  clearRuntimeOnlineState,
  purgeIgnoredUsers,
  resetUserTrackingData,
  resetAllTrackingData,
  setUserBlacklisted,
  setUserTrackedHours,
} = require("./tracker");

// ---------------------------------------------------------------------------
// Config from .env
// ---------------------------------------------------------------------------
function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseHostAndPort(rawHost, rawPort, fallbackPort) {
  let host = String(rawHost || "host.docker.internal").trim();
  let portFromHost = null;

  if (host.includes("://")) {
    const parsed = new URL(host);
    host = parsed.hostname;
    portFromHost = parsed.port ? Number.parseInt(parsed.port, 10) : null;
  } else if (host.startsWith("[") && host.includes("]:")) {
    const end = host.indexOf("]:");
    const possiblePort = host.slice(end + 2);
    if (/^\d+$/.test(possiblePort)) {
      portFromHost = Number.parseInt(possiblePort, 10);
      host = host.slice(1, end);
    }
  } else {
    const lastColon = host.lastIndexOf(":");
    const hasSingleColon = lastColon !== -1 && host.indexOf(":") === lastColon;
    const possiblePort = hasSingleColon ? host.slice(lastColon + 1) : "";
    if (/^\d+$/.test(possiblePort)) {
      portFromHost = Number.parseInt(possiblePort, 10);
      host = host.slice(0, lastColon);
    }
  }

  return {
    host,
    port: portFromHost || parsePositiveInt(rawPort, fallbackPort),
    portFromHost,
  };
}

const ts3Address = parseHostAndPort(
  process.env.TS3_HOST,
  process.env.TS3_QUERY_PORT,
  10011,
);
const TS3_HOST = ts3Address.host;
const TS3_QUERY_PORT = ts3Address.port;
const TS3_QUERY_USER = process.env.TS3_QUERY_USER || "serveradmin";
const TS3_QUERY_PASS = process.env.TS3_QUERY_PASS || "";
const TS3_BOT_NICK = process.env.TS3_BOT_NICKNAME || "UC Stats Bot";
const TS3_SERVER_ID = parsePositiveInt(process.env.TS3_SERVER_ID, 1);
const TS3_SERVER_PORT = parsePositiveInt(process.env.TS3_SERVER_PORT, 9987);
const POLL_MS = parsePositiveInt(process.env.POLL_INTERVAL_MS, 60_000);
const WEB_PORT = parsePositiveInt(process.env.WEB_PORT, 3000);
const HOST_WEB_PORT = parsePositiveInt(process.env.HOST_WEB_PORT, WEB_PORT);
const ADMIN_PORT = parsePositiveInt(process.env.ADMIN_PORT, 3001);
const HOST_ADMIN_PORT = parsePositiveInt(
  process.env.HOST_ADMIN_PORT,
  ADMIN_PORT,
);
function resolvePublicDashboardUrl(value) {
  const fallback = "https://uct.aquaweb.cc/";
  try {
    return validatePublicDashboardUrl(value || fallback) || fallback;
  } catch (error) {
    console.error(`[Config] ${error.message} Using ${fallback} instead.`);
    return fallback;
  }
}

const PUBLIC_DASHBOARD_URL = resolvePublicDashboardUrl(
  String(process.env.PUBLIC_DASHBOARD_URL || "").trim(),
);
const TS3_CONNECT_TIMEOUT_MS = parsePositiveInt(
  process.env.TS3_CONNECT_TIMEOUT_MS,
  10_000,
);

let ts3 = null;
let pollTimer = null;
let isConnected = false;
let reconnectTimer = null;
let lastPollStats = null;
let lastPollLogKey = "";
let pollPromise = null;
let maintenanceQueue = Promise.resolve();

const adminAuth = new TeamSpeakAdminAuth({
  adminGroupIds: process.env.TS3_ADMIN_GROUP_IDS || "6",
});
const discordReporter = createDiscordReporter({
  db,
  webhookUrl: process.env.DISCORD_WEBHOOK_URL,
  intervalMinutes: process.env.DISCORD_REPORT_INTERVAL_MINUTES,
  dashboardUrl: PUBLIC_DASHBOARD_URL,
});

function checkTcpReachable(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    function done(error) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    }

    socket.setTimeout(timeoutMs, () => {
      done(
        new Error(
          `Timed out opening TCP ${host}:${port} after ${timeoutMs}ms. ` +
            "Check that this is the TeamSpeak ServerQuery TCP port and that the network/firewall allows TCP.",
        ),
      );
    });
    socket.once("connect", () => done());
    socket.once("error", (err) => done(err));
  });
}

// ---------------------------------------------------------------------------
// Express web dashboard
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "../web")));

const ADMIN_COOKIE = "uc_admin_session";

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const item of raw.split(";")) {
    const separator = item.indexOf("=");
    if (separator === -1) continue;
    const key = item.slice(0, separator).trim();
    if (key === name) return decodeURIComponent(item.slice(separator + 1));
  }
  return null;
}

function getExpectedRequestHost(req) {
  const forwarded = req.get("x-forwarded-host");
  return (forwarded || req.get("host") || "").split(",")[0].trim();
}

function requireSameOriginJson(req, res, next) {
  if (!req.is("application/json")) {
    return res.status(415).json({ error: "application/json is required" });
  }

  const origin = req.get("origin");
  try {
    if (!origin || new URL(origin).host !== getExpectedRequestHost(req)) {
      return res.status(403).json({ error: "Request origin is not allowed" });
    }
  } catch {
    return res.status(403).json({ error: "Request origin is not allowed" });
  }

  next();
}

function setAdminSessionCookie(req, res, token) {
  const forwardedProto = (req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim();
  const secure = req.secure || forwardedProto === "https";
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=3600",
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAdminSessionCookie(req, res) {
  const forwardedProto = (req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim();
  const parts = [
    `${ADMIN_COOKIE}=`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ];
  if (req.secure || forwardedProto === "https") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function getRemoteAdminSession(req) {
  return adminAuth.getSession(getCookie(req, ADMIN_COOKIE));
}

function permissionsForRole(role) {
  return {
    manage_users: role === "admin",
  };
}

function requireRemoteAdmin(req, res, next) {
  const session = getRemoteAdminSession(req);
  if (!session) {
    return res.status(401).json({ error: "Server Admin verification required" });
  }
  if (session.role !== "admin") {
    return res.status(403).json({ error: "Full Server Admin access required" });
  }
  res.locals.adminActor = `TeamSpeak admin ${session.username} (${session.uid})`;
  res.locals.adminSession = session;
  next();
}


async function listBlacklistedUsers() {
  const users = await db.allAsync(
    `SELECT u.uid, u.username, u.is_online, u.is_afk, u.last_seen
       FROM user_blacklist b
       JOIN users u ON u.uid = b.uid
      ORDER BY lower(u.username), u.uid`,
  );
  return users || [];
}

app.get("/api/config", (_req, res) => {
  res.json({
    admin_port: HOST_ADMIN_PORT,
    discord_configured: discordReporter.configured,
    remote_admin_available: true,
    public_dashboard_url: PUBLIC_DASHBOARD_URL,
  });
});

app.get(
  "/api/admin/status",
  asyncRoute(async (req, res) => {
    const session = getRemoteAdminSession(req);
    const fullAdmin = session && session.role === "admin";
    const [discord, blacklistedUsers] = session
      ? await Promise.all([
          fullAdmin
            ? discordReporter.getStatus()
            : { configured: discordReporter.configured },
          fullAdmin ? listBlacklistedUsers() : [],
        ])
      : [{ configured: discordReporter.configured }, []];
    res.json({
      authorized: Boolean(session),
      mode: session ? "teamspeak" : null,
      username: session ? session.username : null,
      role: session ? session.role : null,
      permissions: permissionsForRole(session ? session.role : null),
      ts3_connected: isConnected,
      discord,
      blacklisted_users: blacklistedUsers,
    });
  }),
);

app.post("/api/admin/challenge", requireSameOriginJson, (req, res) => {
  if (!isConnected) {
    return res.status(503).json({
      error: "TeamSpeak must be connected before a Server Admin can verify.",
    });
  }
  res.status(201).json(adminAuth.createChallenge());
});

app.post(
  "/api/admin/verify",
  requireSameOriginJson,
  asyncRoute(async (req, res) => {
    if (!isConnected || !ts3) {
      return res.status(503).json({ error: "TeamSpeak is not connected." });
    }

    const clients = await ts3.clientList({ clientType: 0 });
    adminAuth.updateClients(clients);
    const result = adminAuth.verifyChallenge(req.body.challengeId);
    if (!result.ok) return res.status(403).json({ error: result.reason });

    setAdminSessionCookie(req, res, result.token);
    res.json({
      authorized: true,
      mode: "teamspeak",
      username: result.username,
      role: result.role,
      permissions: permissionsForRole(result.role),
      expires_at: result.expiresAt,
    });
  }),
);

app.post("/api/admin/logout", requireSameOriginJson, (req, res) => {
  adminAuth.revoke(getCookie(req, ADMIN_COOKIE));
  clearAdminSessionCookie(req, res);
  res.json({ ok: true });
});

async function resetUserHandler(req, res) {
  const uid = String(req.params.uid || "");
  if (!uid || req.body.uid !== uid) {
    return res.status(400).json({ error: "User confirmation did not match." });
  }

  const user = await runTrackingMaintenance(() => resetUserTrackingData(uid));
  if (!user) return res.status(404).json({ error: "User not found." });

  console.log(
    `[Admin] ${res.locals.adminActor || "Local host"} reset ${user.username} (${uid}).`,
  );
  res.json({ ok: true, user });
}

async function resetAllHandler(req, res) {
  if (req.body.confirm !== "RESET") {
    return res.status(400).json({ error: "Type RESET to confirm." });
  }

  const deleted = await runTrackingMaintenance(resetAllTrackingData);
  lastPollStats = null;
  console.log(
    `[Admin] ${res.locals.adminActor || "Local host"} reset all tracked data.`,
  );
  res.json({ ok: true, deleted });
}

async function blacklistUserHandler(req, res) {
  const uid = String(req.params.uid || "");
  if (
    !uid ||
    req.body.uid !== uid ||
    typeof req.body.blacklisted !== "boolean"
  ) {
    return res.status(400).json({ error: "User and blacklist state are required." });
  }

  const user = await runTrackingMaintenance(() =>
    setUserBlacklisted(uid, req.body.blacklisted),
  );
  if (!user) return res.status(404).json({ error: "User not found." });

  const action = req.body.blacklisted ? "blacklisted" : "unblacklisted";
  console.log(
    `[Admin] ${res.locals.adminActor || "Local host"} ${action} ${user.username} (${uid}).`,
  );
  res.json({ ok: true, user });
}

async function editUserHoursHandler(req, res) {
  const uid = String(req.params.uid || "");
  if (!uid || req.body.uid !== uid || !req.body.hours) {
    return res.status(400).json({ error: "User and tracked hours are required." });
  }

  let user;
  try {
    user = await runTrackingMaintenance(() =>
      setUserTrackedHours(uid, req.body.hours),
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
  if (!user) return res.status(404).json({ error: "User not found." });

  console.log(
    `[Admin] ${res.locals.adminActor || "Local host"} edited tracked hours for ${user.username} (${uid}).`,
  );
  res.json({ ok: true, user });
}


async function sendDiscordHandler(_req, res) {
  if (!discordReporter.configured) {
    return res.status(400).json({ error: "Discord webhook is not configured." });
  }
  const result = await discordReporter.sendNow();
  console.log(
    `[Admin] ${res.locals.adminActor || "Local host"} sent a Discord report.`,
  );
  res.json({ ok: true, ...result });
}

app.delete(
  "/api/admin/users/:uid",
  requireSameOriginJson,
  requireRemoteAdmin,
  asyncRoute(resetUserHandler),
);
app.post(
  "/api/admin/users/:uid/blacklist",
  requireSameOriginJson,
  requireRemoteAdmin,
  asyncRoute(blacklistUserHandler),
);
app.patch(
  "/api/admin/users/:uid/hours",
  requireSameOriginJson,
  requireRemoteAdmin,
  asyncRoute(editUserHoursHandler),
);
app.delete(
  "/api/admin/data",
  requireSameOriginJson,
  requireRemoteAdmin,
  asyncRoute(resetAllHandler),
);
app.post(
  "/api/admin/discord/report",
  requireSameOriginJson,
  requireRemoteAdmin,
  asyncRoute(sendDiscordHandler),
);

// All-time leaderboard
app.get("/api/leaderboard", async (_req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT u.uid, u.username, u.total_time, u.daily_time, u.weekly_time,
              u.monthly_time, u.afk_time, u.session_count, u.last_seen,
              u.is_online, u.is_afk,
              CASE WHEN b.uid IS NULL THEN 0 ELSE 1 END AS is_blacklisted
         FROM users u
         LEFT JOIN user_blacklist b ON b.uid = u.uid
        WHERE u.total_time > 0 OR u.is_online = 1 OR b.uid IS NOT NULL
        ORDER BY is_blacklisted ASC, u.total_time DESC
        LIMIT 50`,
    );
    res.json(rows || []);
  } catch (e) {
    console.error("[API] /leaderboard error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Per-user profile
app.get("/api/user/:uid", async (req, res) => {
  try {
    const uid = req.params.uid;
    const user = await db.getAsync(
      `SELECT u.*,
              CASE WHEN b.uid IS NULL THEN 0 ELSE 1 END AS is_blacklisted
         FROM users u
         LEFT JOIN user_blacklist b ON b.uid = u.uid
        WHERE u.uid = ?`,
      [uid],
    );
    if (!user) return res.status(404).json({ error: "User not found" });

    const channels = await db.allAsync(
      `SELECT channel_name, total_time, visit_count
       FROM channel_time WHERE uid = ?
       ORDER BY total_time DESC LIMIT 5`,
      [uid],
    );
    const recentSessions = await db.allAsync(
      `SELECT session_start, session_end, duration_hours, channel_name
       FROM sessions WHERE uid = ?
       ORDER BY session_start DESC LIMIT 10`,
      [uid],
    );
    const hourly = await db.allAsync(
      `SELECT hour_of_day, SUM(ticks) AS t
       FROM hourly_activity WHERE uid = ?
       GROUP BY hour_of_day ORDER BY hour_of_day`,
      [uid],
    );
    const rankRow = await db.getAsync(
      `SELECT COUNT(*) AS r
         FROM users u
         LEFT JOIN user_blacklist b ON b.uid = u.uid
        WHERE (u.total_time > 0 OR u.is_online = 1 OR b.uid IS NOT NULL)
          AND ((CASE WHEN b.uid IS NULL THEN 0 ELSE 1 END) < ?
            OR ((CASE WHEN b.uid IS NULL THEN 0 ELSE 1 END) = ?
                AND u.total_time > ?))`,
      [user.is_blacklisted, user.is_blacklisted, user.total_time],
    );

    res.json({
      ...user,
      channels: channels || [],
      recentSessions: recentSessions || [],
      hourly: hourly || [],
      rank: (rankRow ? rankRow.r : 0) + 1,
    });
  } catch (e) {
    console.error("[API] /user error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Currently online users
app.get("/api/online", async (_req, res) => {
  try {
    const sessions = getActiveSessions();
    const now = Date.now();
    const result = [];
    for (const [uid, sess] of sessions) {
      const row = await db
        .getAsync(
          `SELECT u.username, u.is_afk,
                  CASE WHEN b.uid IS NULL THEN 0 ELSE 1 END AS is_blacklisted
             FROM users u
             LEFT JOIN user_blacklist b ON b.uid = u.uid
            WHERE u.uid = ?`,
          [uid],
        )
        .catch(() => null);
      result.push({
        uid,
        username: row && row.username ? row.username : uid,
        is_afk: row && row.is_afk ? row.is_afk : 0,
        is_blacklisted: row && row.is_blacklisted ? 1 : 0,
        sessionHours: (now - sess.start.getTime()) / 3_600_000,
        channel: sess.channelName || "",
      });
    }
    res.json(result);
  } catch (e) {
    console.error("[API] /online error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Server-wide stats
app.get("/api/server", async (_req, res) => {
  try {
    const stats = await db.getAsync(
      `SELECT COUNT(*) AS users,
               SUM(total_time)    AS total_hours,
               (SELECT COUNT(*) FROM sessions) AS total_sessions
        FROM users`,
    );
    res.json({
      users: stats && stats.users ? stats.users : 0,
      total_hours: stats && stats.total_hours ? stats.total_hours : 0,
      total_sessions: stats && stats.total_sessions ? stats.total_sessions : 0,
      currently_online: getActiveSessions().size,
      bot_connected: isConnected,
    });
  } catch (e) {
    console.error("[API] /server error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/activity", async (_req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT username, event_type, channel_name, timestamp
       FROM events
       ORDER BY timestamp DESC LIMIT 20`,
    );
    res.json(rows || []);
  } catch (e) {
    console.error("[API] /activity error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/channels", async (_req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT channel_name,
              SUM(total_time) AS total_time,
              SUM(visit_count) AS visit_count,
              COUNT(DISTINCT uid) AS user_count
       FROM channel_time
       WHERE total_time > 0
       GROUP BY channel_name
       ORDER BY total_time DESC LIMIT 10`,
    );
    res.json(rows || []);
  } catch (e) {
    console.error("[API] /channels error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    bot_connected: isConnected,
    active_sessions: getActiveSessions().size,
    last_poll: lastPollStats,
    ts3_host: TS3_HOST,
    ts3_query_port: TS3_QUERY_PORT,
    poll_interval_ms: POLL_MS,
    discord_configured: discordReporter.configured,
    uptime_seconds: Math.round(process.uptime()),
  });
});

const localAdminApp = express();
const localDashboardOrigins = new Set(
  ["localhost", "127.0.0.1"].map(
    (hostname) => new URL(`http://${hostname}:${HOST_WEB_PORT}`).origin,
  ),
);

localAdminApp.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && !localDashboardOrigins.has(origin)) {
    return res.status(403).json({ error: "Only the local dashboard can use this API." });
  }

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PATCH, DELETE, OPTIONS",
    );
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
localAdminApp.use(express.json({ limit: "16kb" }));

function requireLocalJson(req, res, next) {
  if (!req.is("application/json")) {
    return res.status(415).json({ error: "application/json is required" });
  }
  res.locals.adminActor = "Local host";
  next();
}

localAdminApp.get(
  "/api/admin/status",
  asyncRoute(async (_req, res) => {
    const [discord, blacklistedUsers] = await Promise.all([
      discordReporter.getStatus(),
      listBlacklistedUsers(),
    ]);
    res.json({
      authorized: true,
      mode: "local",
      username: "Local host",
      role: "admin",
      permissions: permissionsForRole("admin"),
      ts3_connected: isConnected,
      discord,
      blacklisted_users: blacklistedUsers,
    });
  }),
);
localAdminApp.delete(
  "/api/admin/users/:uid",
  requireLocalJson,
  asyncRoute(resetUserHandler),
);
localAdminApp.post(
  "/api/admin/users/:uid/blacklist",
  requireLocalJson,
  asyncRoute(blacklistUserHandler),
);
localAdminApp.patch(
  "/api/admin/users/:uid/hours",
  requireLocalJson,
  asyncRoute(editUserHoursHandler),
);
localAdminApp.patch(
);
localAdminApp.delete(
  "/api/admin/data",
  requireLocalJson,
  asyncRoute(resetAllHandler),
);
localAdminApp.post(
  "/api/admin/discord/report",
  requireLocalJson,
  asyncRoute(sendDiscordHandler),
);

function apiErrorHandler(error, _req, res, _next) {
  console.error("[API] Unhandled error:", error.message);
  if (res.headersSent) return;
  const status = Number(error.status || error.statusCode) || 500;
  res.status(status).json({
    error: status === 400 ? "Invalid JSON request body." : error.message,
  });
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../web/index.html"));
});

app.use(apiErrorHandler);
localAdminApp.use(apiErrorHandler);

app.listen(WEB_PORT, () => {
  console.log(`[Web] Dashboard running at http://localhost:${WEB_PORT}`);
});

localAdminApp.listen(ADMIN_PORT, "0.0.0.0", () => {
  console.log(
    `[Web] Local admin API on http://127.0.0.1:${HOST_ADMIN_PORT} ` +
      "(loopback only)",
  );
});

// ---------------------------------------------------------------------------
// TS3 Connection
// ---------------------------------------------------------------------------
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function scheduleReconnect(delayMs = 15_000) {
  if (reconnectTimer) return;

  console.log(`[TS3] Retrying in ${delayMs / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTS3();
  }, delayMs);
}

function handleConnectionLost(reason) {
  if (!isConnected && reconnectTimer) return;

  isConnected = false;
  adminAuth.updateClients([]);
  stopPolling();
  clearRuntimeOnlineState().catch((error) => {
    console.error("[Tracker] Connection-loss cleanup failed:", error.message);
  });
  console.warn(`[TS3] Connection lost${reason ? `: ${reason}` : ""}`);
  scheduleReconnect();
}

async function connectTS3() {
  console.log(`[TS3] Connecting to ${TS3_HOST}:${TS3_QUERY_PORT} ...`);

  try {
    await checkTcpReachable(
      TS3_HOST,
      TS3_QUERY_PORT,
      TS3_CONNECT_TIMEOUT_MS,
    );

    // TeamSpeak.connect handles login + virtual server select internally
    ts3 = await TeamSpeak.connect({
      host: TS3_HOST,
      queryport: TS3_QUERY_PORT,
      serverport: TS3_SERVER_PORT,
      username: TS3_QUERY_USER,
      password: TS3_QUERY_PASS,
      nickname: TS3_BOT_NICK,
      protocol: "raw",
      keepAlive: true,
      readyTimeout: TS3_CONNECT_TIMEOUT_MS,
    });

    if (TS3_SERVER_ID && typeof ts3.useBySid === "function") {
      await ts3.useBySid(TS3_SERVER_ID);
    }

    ts3.on("close", () => handleConnectionLost("socket closed"));
    ts3.on("error", (err) =>
      console.error("[TS3] Connection error:", err.message),
    );

    isConnected = true;
    console.log("[TS3] Connected and authenticated.");

    // Monitoring is global — all voice clients across the entire server are tracked.
    console.log("[TS3] Monitoring all channels (global tracking).");

    // Start the polling loop
    await startPolling();
  } catch (err) {
    isConnected = false;
    adminAuth.updateClients([]);
    stopPolling();
    console.error("[TS3] Connection failed:", err.message);
    scheduleReconnect();
  }
}

// ---------------------------------------------------------------------------
// Polling loop — snapshot all online clients every POLL_MS milliseconds
// ---------------------------------------------------------------------------
async function pollOnce() {
  if (!isConnected || !ts3) return;

  try {
    const clients = await ts3.clientList({ clientType: 0 });
    adminAuth.updateClients(clients);

    const channelList = await ts3.channelList();
    const channelMap = {};
    for (const ch of channelList) {
      const id = String(ch.channelId || ch.cid || "");
      channelMap[id] = ch.name || id;
    }

    await reconcileOfflineClients(clients);

    let processedClients = 0;
    for (const client of clients) {
      if (await processClientTick(client, channelMap)) processedClients += 1;
    }

    lastPollStats = {
      at: new Date().toISOString(),
      visible_regular_clients: clients.length,
      tracked_clients: processedClients,
    };

    const pollLogKey = `${clients.length}:${processedClients}`;
    if (pollLogKey !== lastPollLogKey) {
      lastPollLogKey = pollLogKey;
      console.log(
        `[Tracker] Poll saw ${clients.length} regular client(s), ` +
          `tracking ${processedClients}.`,
      );
    }
  } catch (err) {
    console.error("[Tracker] Poll error:", err.message);
  }
}

function triggerPoll() {
  if (pollPromise) return pollPromise;
  pollPromise = pollOnce().finally(() => {
    pollPromise = null;
  });
  return pollPromise;
}

async function startPolling(options = {}) {
  stopPolling();
  console.log(`[Tracker] Polling every ${POLL_MS / 1000}s`);
  if (options.immediate !== false) await triggerPoll();
  pollTimer = setInterval(() => {
    void triggerPoll();
  }, POLL_MS);
}

function runTrackingMaintenance(action) {
  const run = maintenanceQueue.then(async () => {
    stopPolling();
    if (pollPromise) await pollPromise;
    try {
      return await action();
    } finally {
      if (isConnected) await startPolling({ immediate: false });
    }
  });
  maintenanceQueue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Scheduled period resets
// ---------------------------------------------------------------------------

// Daily at midnight: reset daily times
cron.schedule("0 0 * * *", async () => {
  console.log("[Cron] Daily reset...");
  await resetDailyTimes().catch(console.error);
});

// Sunday midnight: reset weekly times
cron.schedule("0 0 * * 0", async () => {
  console.log("[Cron] Weekly reset...");
  await resetWeeklyTimes().catch(console.error);
});

// 1st of each month at midnight: reset monthly times
cron.schedule("0 0 1 * *", async () => {
  console.log("[Cron] Monthly reset...");
  await resetMonthlyTimes().catch(console.error);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
console.log("===================================================");
console.log("   UC Stats Tracking Bot for TeamSpeak 3");
console.log(`   Connecting to : ${TS3_HOST}:${TS3_QUERY_PORT}`);
if (ts3Address.portFromHost) {
  console.log(
    `   Parsed TS3_HOST : host=${TS3_HOST}, query_port=${TS3_QUERY_PORT}`,
  );
}
console.log(
  `   Virtual server: sid=${TS3_SERVER_ID}, voice_port=${TS3_SERVER_PORT}`,
);
console.log(`   Web Dashboard : http://localhost:${WEB_PORT}`);
console.log(`   Public URL    : ${PUBLIC_DASHBOARD_URL}`);
console.log(`   Local Admin   : http://127.0.0.1:${HOST_ADMIN_PORT}`);
console.log(
  `   Discord      : ${discordReporter.configured ? `every ${discordReporter.intervalMinutes}m` : "not configured"}`,
);
console.log("===================================================");

function checkScheduledDiscordReport() {
  if (!discordReporter.configured) return;
  discordReporter.maybeSend().catch((error) => {
    console.error("[Discord] Scheduled report failed:", error.message);
  });
}

async function boot() {
  await clearRuntimeOnlineState().catch((err) => {
    console.error("[Tracker] Startup cleanup failed:", err.message);
  });
  await purgeIgnoredUsers().catch((err) => {
    console.error("[Tracker] Ignored-user cleanup failed:", err.message);
  });
  connectTS3();
  setTimeout(checkScheduledDiscordReport, 15_000);
  setInterval(checkScheduledDiscordReport, 60_000);
}

boot();
