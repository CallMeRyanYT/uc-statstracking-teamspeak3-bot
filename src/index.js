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
} = require("./tracker");
const { handleMessage } = require("./commands");
const {
  postWebhook,
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

// =========================================================================
// Raw TCP text listener - bypasses broken library event system
// =========================================================================
let rawSocket = null;
let rawBuf = "";
let rawServerSelected = false;
let rawEventsRegistered = false;

function startRawTextListener() {
  console.log("[Raw] Starting raw TCP text listener...");
  rawSocket = new net.Socket();
  rawSocket.connect(TS3_QUERY_PORT, TS3_HOST, () => {
    console.log(`[Raw] Connected to ${TS3_HOST}:${TS3_QUERY_PORT}`);
    sendRaw(`login ${TS3_QUERY_USER} ${TS3_QUERY_PASS}`);
  });
  rawSocket.on("data", (chunk) => {
    rawBuf += chunk.toString("utf8");
    let idx;
    while ((idx = rawBuf.indexOf("\n")) !== -1) {
      const line = rawBuf.slice(0, idx).replace(/\r$/, "").trim();
      rawBuf = rawBuf.slice(idx + 1);
      if (!line) continue;
      handleRawLine(line);
    }
  });
  rawSocket.on("close", () => {
    console.warn("[Raw] TCP closed. Reconnecting in 30s...");
    rawSocket = null;
    rawBuf = "";
    rawServerSelected = false;
    rawEventsRegistered = false;
    setTimeout(startRawTextListener, 30_000);
  });
  rawSocket.on("error", (err) =>
    console.error("[Raw] TCP error:", err.message),
  );
}

function sendRaw(cmd) {
  if (!rawSocket || rawSocket.destroyed) return;
  rawSocket.write(cmd + "\n");
}

function handleRawLine(line) {
  if (line.startsWith("error id=0 msg=ok")) {
    if (!rawServerSelected) {
      sendRaw("use port=9987");
      rawServerSelected = true;
      return;
    }
    if (!rawEventsRegistered) {
      sendRaw("servernotifyregister event=textserver");
      sendRaw("servernotifyregister event=textchannel");
      sendRaw("servernotifyregister event=textprivate");
      rawEventsRegistered = true;
      console.log("[Raw] Text events registered on raw connection.");
      return;
    }
    return;
  }
  if (line.startsWith("notifytextmessage")) {
    parseAndHandleText(line);
    return;
  }
}

function parseAndHandleText(line) {
  const params = {};
  const re = /(\w+)=((?:"[^"]*")|(?:\S+))/g;
  let m;
  while ((m = re.exec(line)) !== null)
    params[m[1]] = m[2].replace(/^"|"$/g, "");

  const text = (params.msg || "").trim();
  if (!text) return;

  const invokerClid = parseInt(params.invokerid) || 0;
  const invokerUid = params.invokeruid || "";
  const invokerNick = params.invokername || "Unknown";
  const targetmode = parseInt(params.targetmode) || 2;

  if (!invokerClid || !invokerUid) return;

  console.log(`[Raw] Message from ${invokerNick}: ${text.slice(0, 100)}`);

  (async () => {
    try {
      const reply = await handleMessage(text, invokerUid, invokerNick);
      if (!reply) return;

      let targetId, replyMode;
      if (targetmode === 1) {
        targetId = invokerClid;
        replyMode = 1;
      } else {
        const info = await ts3.clientInfo(invokerClid).catch(() => null);
        targetId = info ? info.cid || info.channelId : null;
        replyMode = 2;
      }

      if (targetId) {
        await ts3.sendTextMessage(targetId, replyMode, reply);
        console.log(`[Raw] Response sent (target ${targetId})`);
      } else {
        await ts3.sendTextMessage(invokerClid, 1, reply);
      }

      const discordMsg = [
        `📥 **${invokerNick}** used command in TS3:`,
        "```",
        text,
        "```",
        "**Result:**",
        "```",
        reply,
        "```",
      ].join("\n");
      await postWebhook(
        discordMsg.length > 1950
          ? discordMsg.slice(0, 1950) + "..."
          : discordMsg,
      ).catch((e) => console.error("[Raw] Discord error:", e.message));
    } catch (e) {
      console.error("[Raw] Handler error:", e.message);
    }
  })();
}

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
      serverport: 9987,
      username: TS3_QUERY_USER,
      password: TS3_QUERY_PASS,
      nickname: TS3_BOT_NICK,
      protocol: "raw",
      keepAlive: false, // temp disable to test if keepalive blocks events
    });

    isConnected = true;
    console.log("[TS3] Connected and authenticated.");

    // Monitoring is global — all voice clients across the entire server are tracked.
    console.log("[TS3] Monitoring all channels (global tracking).");

    // Start raw TCP listener for text notifications (bypasses broken event system)
    startRawTextListener();

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
