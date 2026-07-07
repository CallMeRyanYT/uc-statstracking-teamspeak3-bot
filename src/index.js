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
const {
  processClientTick,
  reconcileOfflineClients,
  resetDailyTimes,
  resetWeeklyTimes,
  resetMonthlyTimes,
  getActiveSessions,
  clearRuntimeOnlineState,
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
const TS3_CONNECT_TIMEOUT_MS = parsePositiveInt(
  process.env.TS3_CONNECT_TIMEOUT_MS,
  10_000,
);

let ts3 = null;
let pollTimer = null;
let isConnected = false;
let reconnectTimer = null;

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
            "Check that this is the TeamSpeak ServerQuery TCP port and that the tunnel/firewall allows TCP.",
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
app.use(express.static(path.join(__dirname, "../web")));

// All-time leaderboard
app.get("/api/leaderboard", async (_req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT uid, username, total_time, daily_time, weekly_time,
              monthly_time, afk_time, session_count, last_seen, is_online, is_afk
       FROM users
       WHERE total_time > 0 OR is_online = 1
       ORDER BY total_time DESC LIMIT 50`,
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
    const user = await db.getAsync("SELECT * FROM users WHERE uid = ?", [uid]);
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
      "SELECT COUNT(*) AS r FROM users WHERE total_time > ?",
      [user.total_time],
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
        .getAsync("SELECT username, is_afk FROM users WHERE uid = ?", [uid])
        .catch(() => null);
      result.push({
        uid,
        username: row && row.username ? row.username : uid,
        is_afk: row && row.is_afk ? row.is_afk : 0,
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
              SUM(session_count) AS total_sessions
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
    ts3_host: TS3_HOST,
    ts3_query_port: TS3_QUERY_PORT,
    poll_interval_ms: POLL_MS,
    uptime_seconds: Math.round(process.uptime()),
  });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../web/index.html"));
});

app.listen(WEB_PORT, () => {
  console.log(`[Web] Dashboard running at http://localhost:${WEB_PORT}`);
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
  stopPolling();
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
    stopPolling();
    console.error("[TS3] Connection failed:", err.message);
    scheduleReconnect();
  }
}

// ---------------------------------------------------------------------------
// Polling loop — snapshot all online clients every POLL_MS milliseconds
// ---------------------------------------------------------------------------
async function startPolling() {
  stopPolling();
  console.log(`[Tracker] Polling every ${POLL_MS / 1000}s`);

  const poll = async () => {
    if (!isConnected || !ts3) return;

    try {
      const clients = await ts3.clientList();

      // Build channelId -> channelName lookup map
      const channelList = await ts3.channelList();
      const channelMap = {};
      for (const ch of channelList) {
        // ts3-nodejs-library v3 uses ch.channelId; fallback to ch.cid for safety
        const id = String(ch.channelId || ch.cid || "");
        channelMap[id] = ch.name || id;
      }

      // Mark any clients who left since last poll
      await reconcileOfflineClients(clients);

      // Process each visible client
      for (const client of clients) {
        await processClientTick(client, channelMap);
      }
    } catch (err) {
      console.error("[Tracker] Poll error:", err.message);
    }
  };

  // First poll immediately, then on interval
  await poll();
  pollTimer = setInterval(poll, POLL_MS);
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
console.log("===================================================");

async function boot() {
  await clearRuntimeOnlineState().catch((err) => {
    console.error("[Tracker] Startup cleanup failed:", err.message);
  });
  connectTS3();
}

boot();
