/**
 * index.js -- UC Stats Tracking Bot for TeamSpeak 3
 *
 * Connection: TS3 ServerQuery (TCP port 10011)
 * Works on localhost: set TS3_HOST=host.docker.internal when running in Docker
 * on the same PC as the TS3 server.
 */

require("dotenv").config();
const { TeamSpeak } = require("ts3-nodejs-library");
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
} = require("./tracker");
const { handleMessage } = require("./commands");
const {
  sendHourlyReport,
  sendDailyReport,
  sendWeeklyReport,
} = require("./discord");

// ---------------------------------------------------------------------------
// Config from .env
// ---------------------------------------------------------------------------
const TS3_HOST = process.env.TS3_HOST || "host.docker.internal";
const TS3_QUERY_PORT = parseInt(process.env.TS3_QUERY_PORT) || 10011;
const TS3_QUERY_USER = process.env.TS3_QUERY_USER || "serveradmin";
const TS3_QUERY_PASS = process.env.TS3_QUERY_PASS || "";
const TS3_BOT_NICK = process.env.TS3_BOT_NICKNAME || "UC Stats Bot";
const TS3_CHANNEL = process.env.TS3_CHANNEL_NAME || "Stalking Room";
const TS3_CHAN_PASS = process.env.TS3_CHANNEL_PASS || "1337";
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 60_000;
const WEB_PORT = parseInt(process.env.WEB_PORT) || 3000;

let ts3 = null;
let pollTimer = null;
let isConnected = false;

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

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../web/index.html"));
});

app.listen(WEB_PORT, () => {
  console.log(`[Web] Dashboard running at http://localhost:${WEB_PORT}`);
});

// ---------------------------------------------------------------------------
// TS3 Connection
// ---------------------------------------------------------------------------
async function connectTS3() {
  console.log(`[TS3] Connecting to ${TS3_HOST}:${TS3_QUERY_PORT} ...`);

  try {
    // TeamSpeak.connect handles login + virtual server select internally
    ts3 = await TeamSpeak.connect({
      host: TS3_HOST,
      queryport: TS3_QUERY_PORT,
      serverport: 9987, // selects the virtual server automatically
      username: TS3_QUERY_USER,
      password: TS3_QUERY_PASS,
      nickname: TS3_BOT_NICK,
      keepAlive: true,
      keepAliveTimeout: 60,
    });

    isConnected = true;
    console.log("[TS3] Connected and authenticated.");

    // NOTE: ServerQuery clients (type=0) cannot join voice channels.
    // We use clientList() to monitor all channels — no need to "move" the bot.
    console.log(
      `[TS3] Monitoring channel: "${TS3_CHANNEL}" (pass: ${TS3_CHAN_PASS})`,
    );

    // Register for text message events using v3 event names
    // textserver  = server-wide chat messages
    // textprivate = private messages to the bot
    // textchannel = channel chat messages (id=0 means all channels)
    await ts3.registerEvent("textserver");
    await ts3.registerEvent("textprivate");
    await ts3.registerEvent("textchannel", 0);

    ts3.on("textmessage", async (event) => {
      try {
        const text = (event.msg || "").trim();
        const invoker = event.invoker;
        if (!text || !invoker) return;

        // Ignore messages from the bot's own query client
        const self = await ts3.whoami().catch(() => null);
        if (self && invoker.clid === self.clid) return;

        const uid = invoker.uniqueIdentifier;
        const nick = invoker.nickname || "Unknown";

        const reply = await handleMessage(text, uid, nick);
        if (!reply) return;

        // targetmode: 1 = private, 2 = channel, 3 = server
        const mode = event.targetmode;
        if (mode === 1) {
          // Private message — reply privately to the invoker
          await ts3.sendTextMessage(invoker.clid, 1, reply);
        } else {
          // Channel or server message — reply to the same channel
          const targetId =
            event.targetmode === 3
              ? 0 // server-wide: target 0 = all virtual server
              : (await ts3.clientInfo(invoker.clid).catch(() => null))?.cid;
          if (targetId) {
            await ts3.sendTextMessage(targetId, 2, reply);
          }
        }
      } catch (e) {
        console.error("[TS3] textmessage handler error:", e.message);
      }
    });

    // Handle disconnection — auto-reconnect
    ts3.on("close", () => {
      isConnected = false;
      console.warn("[TS3] Connection closed. Reconnecting in 10s...");
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      setTimeout(connectTS3, 10_000);
    });

    ts3.on("error", (err) => {
      console.error("[TS3] Error:", err.message);
    });

    // Start the polling loop
    startPolling();
  } catch (err) {
    isConnected = false;
    console.error("[TS3] Connection failed:", err.message);
    console.log("[TS3] Retrying in 15s...");
    setTimeout(connectTS3, 15_000);
  }
}

// ---------------------------------------------------------------------------
// Polling loop — snapshot all online clients every POLL_MS milliseconds
// ---------------------------------------------------------------------------
async function startPolling() {
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
// Scheduled Discord reports
// ---------------------------------------------------------------------------

// Every hour on the hour
cron.schedule("0 * * * *", () => {
  console.log("[Cron] Sending hourly Discord report...");
  sendHourlyReport().catch(console.error);
});

// Daily at midnight: post daily leaderboard + reset daily times
cron.schedule("0 0 * * *", async () => {
  console.log("[Cron] Daily report + reset...");
  await sendDailyReport().catch(console.error);
  await resetDailyTimes().catch(console.error);
});

// Sunday midnight: post weekly report + reset weekly times
cron.schedule("0 0 * * 0", async () => {
  console.log("[Cron] Weekly report + reset...");
  await sendWeeklyReport().catch(console.error);
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
console.log(`   Web Dashboard : http://localhost:${WEB_PORT}`);
console.log("===================================================");

connectTS3();
