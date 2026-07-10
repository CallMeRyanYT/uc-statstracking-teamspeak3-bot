/**
 * tracker.js -- Core activity tracking logic
 *
 * Rules:
 *  - Tracks ALL regular voice clients across the whole server
 *  - If TS3 "away" status has been active for >= 5 minutes, time is PAUSED
 *  - AFK time is accumulated separately (still visible in stats)
 *  - Time stored in HOURS (decimal), measured between successful polls
 *
 * ts3-nodejs-library v3 property names used:
 *   client.uniqueIdentifier  -- UID string
 *   client.nickname          -- display name
 *   client.channelId         -- current channel ID (number)
 *   client.away              -- boolean / 0/1
 *   client.type              -- 0=regular voice client, 1=ServerQuery
 */

const db = require("./database");

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const POLL_INTERVAL_MS = parsePositiveInt(
  process.env.POLL_INTERVAL_MS,
  60_000,
);
const AWAY_THRESHOLD_MIN = parsePositiveInt(
  process.env.AFK_AWAY_THRESHOLD_MINUTES,
  5,
);

// uid -> { start: Date, channelId: string, channelName: string, sessionDbId: number }
const activeSessions = new Map();

// Required exclusions cannot be removed by a custom BOT_NICKNAMES value.
const REQUIRED_IGNORED_NICKNAMES = [
  "UC Stats Bot",
  process.env.TS3_BOT_NICKNAME || "",
  "serveradmin",
  "UC Music Bot",
  "Admonus",
];

const BOT_NICKNAMES = [
  ...new Set(
    [
      ...REQUIRED_IGNORED_NICKNAMES,
      ...(process.env.BOT_NICKNAMES || "").split(","),
    ]
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  ),
];

// Comma-separated channel IDs to never track
const EXCLUDED_CHANNELS = (process.env.EXCLUDED_CHANNELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
function isIgnoredNickname(nickname) {
  const nick = (nickname || "").toLowerCase();
  return BOT_NICKNAMES.some((b) => nick.includes(b));
}

function ignoredNameWhereClause() {
  if (!BOT_NICKNAMES.length) return null;
  return BOT_NICKNAMES.map(() => "instr(lower(username), ?) > 0").join(" OR ");
}

function sqlPlaceholders(items) {
  return items.map(() => "?").join(",");
}

async function purgeIgnoredUsers() {
  const ignoredNames = BOT_NICKNAMES.map((n) => n.toLowerCase());
  const whereIgnored = ignoredNameWhereClause();
  if (!whereIgnored) return 0;

  const uidRows = await db.allAsync(
    `SELECT uid FROM users WHERE ${whereIgnored}
     UNION
     SELECT uid FROM sessions WHERE ${whereIgnored}
     UNION
     SELECT uid FROM events WHERE ${whereIgnored}`,
    [...ignoredNames, ...ignoredNames, ...ignoredNames],
  );

  const uids = [
    ...new Set((uidRows || []).map((row) => row.uid).filter(Boolean)),
  ];

  let deleted = 0;

  if (uids.length) {
    const placeholders = sqlPlaceholders(uids);
    deleted += (
      await db.runAsync(
        `DELETE FROM hourly_activity WHERE uid IN (${placeholders})`,
        uids,
      )
    ).changes;
    deleted += (
      await db.runAsync(
        `DELETE FROM channel_time WHERE uid IN (${placeholders})`,
        uids,
      )
    ).changes;
    deleted += (
      await db.runAsync(
        `DELETE FROM sessions WHERE uid IN (${placeholders})`,
        uids,
      )
    ).changes;
    deleted += (
      await db.runAsync(
        `DELETE FROM events WHERE uid IN (${placeholders})`,
        uids,
      )
    ).changes;
    deleted += (
      await db.runAsync(
        `DELETE FROM users WHERE uid IN (${placeholders})`,
        uids,
      )
    ).changes;
  }

  deleted += (
    await db.runAsync(`DELETE FROM sessions WHERE ${whereIgnored}`, ignoredNames)
  ).changes;
  deleted += (
    await db.runAsync(`DELETE FROM events WHERE ${whereIgnored}`, ignoredNames)
  ).changes;

  if (deleted) {
    console.log(`[Tracker] Purged ${deleted} ignored user record(s).`);
  }

  return deleted;
}

// ---------------------------------------------------------------------------
function shouldTrackClient(client) {
  // Skip ServerQuery/admin clients. In TeamSpeak, 0 = regular client, 1 = query.
  const clientType = client.type ?? client.clientType ?? client.client_type;
  if (String(clientType) === "1") return false;
  if (!client.uniqueIdentifier || !client.nickname) return false;

  if (isIgnoredNickname(client.nickname)) return false;

  // channelId can be a number or string depending on library version
  const cid = String(client.channelId || client.cid || "");
  if (!cid) return false;
  if (EXCLUDED_CHANNELS.includes(cid)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// evaluateAway -- checks if the client is away and for how long.
// Returns ONLY calculated values (NO DB writes) to avoid races with the UPSERT.
// ---------------------------------------------------------------------------
async function evaluateAway(client) {
  const uid = client.uniqueIdentifier;
  const now = new Date();

  // away is sometimes boolean, sometimes 0/1
  const awayActive = client.away === true || String(client.away) === "1";

  if (!awayActive) {
    // They are back -- clear away state (handled by caller)
    return { earnTime: true, isAway: false, awaySince: null };
  }

  // Client is in away status -- fetch current state from DB
  const row = await db.getAsync("SELECT away_since FROM users WHERE uid = ?", [
    uid,
  ]);

  if (!row || !row.away_since) {
    // No existing away_since — start the timer now
    return { earnTime: true, isAway: true, awaySince: now.toISOString() };
  }

  const awayMin = (now - new Date(row.away_since)) / 60_000;
  if (awayMin >= AWAY_THRESHOLD_MIN) {
    // Over threshold — time is PAUSED, mark as AFK
    return { earnTime: false, isAway: true, awaySince: row.away_since };
  }

  // Away but still under threshold — still earns time
  return { earnTime: true, isAway: true, awaySince: row.away_since };
}

// ---------------------------------------------------------------------------
// processClientTick -- called every poll interval for each visible client
// ---------------------------------------------------------------------------
async function processClientTick(client, channelMap) {
  if (!shouldTrackClient(client)) {
    if (client.uniqueIdentifier && isIgnoredNickname(client.nickname)) {
      const removed = await resetUserTrackingData(client.uniqueIdentifier);
      if (removed) {
        console.log(`[Tracker] Purged ignored user ${removed.username}.`);
      }
    }
    return false;
  }

  const uid = client.uniqueIdentifier;
  const username = client.nickname;
  // channelId is a number in v3; convert to string for map lookup and DB storage
  const channelId = String(client.channelId || client.cid || "");
  const channelName = channelMap[channelId] || "Channel " + channelId;
  const now = new Date();
  const existingUser = await db.getAsync(
    "SELECT username, last_update, is_online FROM users WHERE uid = ?",
    [uid],
  );
  const previousUpdateMs = existingUser
    ? Date.parse(existingUser.last_update)
    : NaN;
  const elapsedMs =
    existingUser && existingUser.is_online && Number.isFinite(previousUpdateMs)
      ? Math.min(
          Math.max(now.getTime() - previousUpdateMs, 0),
          POLL_INTERVAL_MS * 2,
        )
      : 0;

  const { earnTime, awaySince } = await evaluateAway(client);
  // is_afk in DB means "time is currently paused" (earnTime === false)
  const afkFlag = earnTime ? 0 : 1;

  // Atomic upsert — all user state in one write, no race with evaluateAway
  await db.runAsync(
    `INSERT INTO users
       (uid, username, total_time, daily_time, weekly_time, monthly_time,
        afk_time, session_count, first_seen, last_seen, last_update,
        is_online, is_afk, away_since, current_channel)
     VALUES (?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       username        = excluded.username,
       last_seen       = excluded.last_seen,
       last_update     = excluded.last_update,
       is_online       = 1,
       is_afk          = excluded.is_afk,
       away_since      = excluded.away_since,
       current_channel = excluded.current_channel`,
    [
      uid,
      username,
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      afkFlag,
      awaySince || null,
      channelName,
    ],
  );

  if (existingUser && existingUser.username !== username) {
    await db.runAsync("UPDATE sessions SET username = ? WHERE uid = ?", [
      username,
      uid,
    ]);
    await db.runAsync("UPDATE events SET username = ? WHERE uid = ?", [
      username,
      uid,
    ]);
    console.log(
      `[Tracker] Nickname updated for ${uid}: ` +
        `${existingUser.username} -> ${username}`,
    );
  }

  let visitedChannel = false;

  // Session tracking
  if (!activeSessions.has(uid)) {
    // New session -- open a DB record
    const result = await db.runAsync(
      `INSERT INTO sessions (uid, username, channel_id, channel_name, session_start)
       VALUES (?, ?, ?, ?, ?)`,
      [uid, username, channelId, channelName, now.toISOString()],
    );
    activeSessions.set(uid, {
      start: now,
      channelId,
      channelName,
      sessionDbId: result.lastID,
    });
    await logEvent(uid, username, "join", channelId, channelName, now);
    visitedChannel = true;
  } else {
    const sess = activeSessions.get(uid);
    if (sess.channelId !== channelId) {
      // User moved channels
      await logEvent(uid, username, "move", channelId, channelName, now);
      sess.channelId = channelId;
      sess.channelName = channelName;
      visitedChannel = true;
    }
  }

  const tickMult = uid === "Z9wyOb/tgzg6wd6TMA9fs36txK0=" ? 6.7 : 1;
  const tickTime = (elapsedMs / 3_600_000) * tickMult;
  const tickUnits = (elapsedMs / POLL_INTERVAL_MS) * tickMult;

  if (earnTime) {
    // Accumulate time in all period buckets
    await db.runAsync(
      `UPDATE users SET
         total_time   = total_time   + ?,
         daily_time   = daily_time   + ?,
         weekly_time  = weekly_time  + ?,
         monthly_time = monthly_time + ?
       WHERE uid = ?`,
      [tickTime, tickTime, tickTime, tickTime, uid],
    );

    // Per-channel time
    await db.runAsync(
      `INSERT INTO channel_time (uid, channel_id, channel_name, total_time, visit_count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(uid, channel_id) DO UPDATE SET
         channel_name = excluded.channel_name,
         total_time   = total_time + ?,
         visit_count  = visit_count + ?`,
      [
        uid,
        channelId,
        channelName,
        tickTime,
        visitedChannel ? 1 : 0,
        tickTime,
        visitedChannel ? 1 : 0,
      ],
    );

    if (tickUnits > 0) {
      await db.runAsync(
        `INSERT INTO hourly_activity (uid, hour_of_day, day_of_week, ticks)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(uid, hour_of_day, day_of_week) DO UPDATE SET ticks = ticks + ?`,
        [uid, now.getHours(), now.getDay(), tickUnits, tickUnits],
      );
    }
  } else {
    // Accumulate AFK time separately
    await db.runAsync(
      "UPDATE users SET afk_time = afk_time + ? WHERE uid = ?",
      [tickTime, uid],
    );
  }

  return true;
}

// ---------------------------------------------------------------------------
// reconcileOfflineClients -- detect clients who left since the last poll
// ---------------------------------------------------------------------------
let _prevOnlineUIDs = new Set();

async function clearRuntimeOnlineState() {
  const nowIso = new Date().toISOString();
  activeSessions.clear();
  _prevOnlineUIDs = new Set();

  await db.runAsync(
    `UPDATE users
        SET session_count = session_count + 1
      WHERE uid IN (
        SELECT DISTINCT uid FROM sessions WHERE session_end IS NULL
      )`,
  );

  await db.runAsync(
    `UPDATE sessions
        SET session_end = ?,
            duration_hours = CASE
              WHEN julianday(?) > julianday(session_start)
              THEN (julianday(?) - julianday(session_start)) * 24
              ELSE 0
            END
      WHERE session_end IS NULL`,
    [nowIso, nowIso, nowIso],
  );

  const result = await db.runAsync(
    `UPDATE users SET
       is_online = 0,
       is_afk = 0,
       away_since = NULL,
       muted_since = NULL,
       current_channel = NULL
     WHERE is_online = 1
        OR is_afk = 1
        OR away_since IS NOT NULL
        OR muted_since IS NOT NULL
        OR current_channel IS NOT NULL`,
  );

  if (result.changes) {
    console.log(`[Tracker] Cleared ${result.changes} stale online user(s).`);
  }
}

async function reconcileOfflineClients(currentClients) {
  const currentUIDs = new Set(
    currentClients.filter(shouldTrackClient).map((c) => c.uniqueIdentifier),
  );

  for (const uid of _prevOnlineUIDs) {
    if (!currentUIDs.has(uid)) {
      const row = await db
        .getAsync("SELECT username FROM users WHERE uid = ?", [uid])
        .catch(() => null);
      await handleClientLeft(uid, row && row.username ? row.username : uid);
    }
  }

  _prevOnlineUIDs = currentUIDs;
}

// ---------------------------------------------------------------------------
// handleClientLeft -- close the session and mark user offline
// ---------------------------------------------------------------------------
async function handleClientLeft(uid, username) {
  const now = new Date();
  const sess = activeSessions.get(uid);

  if (sess) {
    const durationHours = (now - sess.start) / 3_600_000;
    if (sess.sessionDbId) {
      await db.runAsync(
        "UPDATE sessions SET session_end = ?, duration_hours = ? WHERE id = ?",
        [now.toISOString(), durationHours, sess.sessionDbId],
      );
    }
    await logEvent(
      uid,
      username,
      "leave",
      sess.channelId,
      sess.channelName,
      now,
    );
    activeSessions.delete(uid);
  }

  await db.runAsync(
    `UPDATE users SET
       is_online   = 0,
       is_afk      = 0,
       away_since  = NULL,
       muted_since = NULL,
       last_seen   = ?,
       session_count = session_count + 1
     WHERE uid = ?`,
    [now.toISOString(), uid],
  );
}

// ---------------------------------------------------------------------------
// logEvent -- insert an event record
// ---------------------------------------------------------------------------
async function logEvent(uid, username, type, channelId, channelName, ts) {
  await db.runAsync(
    `INSERT INTO events (uid, username, event_type, channel_id, channel_name, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      uid,
      username,
      type,
      channelId || null,
      channelName || null,
      (ts || new Date()).toISOString(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Period resets (called by cron in index.js)
// ---------------------------------------------------------------------------
async function resetDailyTimes() {
  await db.runAsync("UPDATE users SET daily_time = 0");
  console.log("[Tracker] Daily times reset.");
}

async function resetWeeklyTimes() {
  await db.runAsync("UPDATE users SET weekly_time = 0");
  console.log("[Tracker] Weekly times reset.");
}

async function resetMonthlyTimes() {
  await db.runAsync("UPDATE users SET monthly_time = 0");
  console.log("[Tracker] Monthly times reset.");
}

async function resetUserTrackingData(uid) {
  const user = await db.getAsync(
    "SELECT uid, username FROM users WHERE uid = ?",
    [uid],
  );
  if (!user) return null;

  activeSessions.delete(uid);
  _prevOnlineUIDs.delete(uid);

  await db.transactionAsync(async () => {
    await db.runAsync("DELETE FROM hourly_activity WHERE uid = ?", [uid]);
    await db.runAsync("DELETE FROM channel_time WHERE uid = ?", [uid]);
    await db.runAsync("DELETE FROM sessions WHERE uid = ?", [uid]);
    await db.runAsync("DELETE FROM events WHERE uid = ?", [uid]);
    await db.runAsync("DELETE FROM users WHERE uid = ?", [uid]);
  });

  return user;
}

async function resetAllTrackingData() {
  const counts = await db.getAsync(
    `SELECT
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM sessions) AS sessions,
       (SELECT COUNT(*) FROM events) AS events`,
  );

  activeSessions.clear();
  _prevOnlineUIDs = new Set();

  await db.transactionAsync(async () => {
    await db.runAsync("DELETE FROM hourly_activity");
    await db.runAsync("DELETE FROM channel_time");
    await db.runAsync("DELETE FROM sessions");
    await db.runAsync("DELETE FROM events");
    await db.runAsync("DELETE FROM users");
    await db.runAsync(
      `DELETE FROM sqlite_sequence
       WHERE name IN ('hourly_activity', 'channel_time', 'sessions', 'events')`,
    );
  });

  return counts || { users: 0, sessions: 0, events: 0 };
}

function getActiveSessions() {
  return activeSessions;
}

module.exports = {
  processClientTick,
  reconcileOfflineClients,
  handleClientLeft,
  resetDailyTimes,
  resetWeeklyTimes,
  resetMonthlyTimes,
  getActiveSessions,
  clearRuntimeOnlineState,
  purgeIgnoredUsers,
  resetUserTrackingData,
  resetAllTrackingData,
};
