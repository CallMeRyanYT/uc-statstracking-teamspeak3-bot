const test = require("node:test");
const assert = require("node:assert/strict");

const databasePath = require.resolve("../src/database");
const trackerPath = require.resolve("../src/tracker");
const writes = [];
let scenario = "afk";

const fakeDb = {
  async getAsync(sql) {
    if (scenario === "ignored") {
      if (sql.includes("SELECT uid, username FROM users")) {
        return { uid: "music-bot-uid", username: "UC Music Bot" };
      }
      return null;
    }

    if (
      scenario === "edit_hours" &&
      sql.includes("SELECT uid, username FROM users")
    ) {
      return { uid: "edited-user-uid", username: "Edited User" };
    }

    if (sql.includes("SELECT u.username, u.last_update, u.is_online")) {
      if (scenario === "otto") {
        return {
          username: "SpiceHater67",
          last_update: new Date(Date.now() - 60_000).toISOString(),
          is_online: 1,
          is_blacklisted: 0,
        };
      }
      if (scenario === "blacklisted") {
        return {
          username: "Blocked User",
          last_update: new Date(Date.now() - 60_000).toISOString(),
          is_online: 1,
          is_blacklisted: 1,
        };
      }
      return {
        username: "Away User",
        last_update: new Date(Date.now() - 60_000).toISOString(),
        is_online: 1,
        is_blacklisted: 0,
      };
    }
    if (sql.includes("SELECT away_since")) {
      return {
        away_since: new Date(Date.now() - 6 * 60_000).toISOString(),
      };
    }
    return null;
  },
  async runAsync(sql, params) {
    writes.push({ sql, params });
    return { changes: 1, lastID: 1 };
  },
  async transactionAsync(callback) {
    return callback();
  },
};

require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: fakeDb,
};
delete require.cache[trackerPath];
const {
  getActiveSessions,
  processClientTick,
  setUserTrackedHours,
} = require(trackerPath);

test("an away client over five minutes gains only AFK time", async () => {
  const tracked = await processClientTick(
    {
      type: 0,
      uniqueIdentifier: "away-user-uid",
      nickname: "Away User",
      channelId: "7",
      away: "1",
    },
    { 7: "General" },
  );

  assert.equal(tracked, true);
  assert.equal(
    writes.some(({ sql }) => sql.includes("afk_time = afk_time + ?")),
    true,
  );
  assert.equal(
    writes.some(({ sql }) => sql.includes("total_time   = total_time   + ?")),
    false,
  );
  assert.equal(
    writes.some(({ sql }) => sql.includes("INSERT INTO channel_time")),
    false,
  );
  assert.equal(
    writes.some(({ sql }) => sql.includes("INSERT INTO hourly_activity")),
    false,
  );
});

test("UC Music Bot is purged instead of tracked", async () => {
  scenario = "ignored";
  const writeStart = writes.length;
  const tracked = await processClientTick(
    {
      type: 0,
      uniqueIdentifier: "music-bot-uid",
      nickname: "UC Music Bot",
      channelId: "7",
      away: 0,
    },
    { 7: "General" },
  );
  const musicWrites = writes.slice(writeStart);

  assert.equal(tracked, false);
  assert.equal(
    musicWrites.some(({ sql }) => sql.includes("DELETE FROM users")),
    true,
  );
  assert.equal(
    musicWrites.some(({ sql }) => sql.includes("INSERT INTO users")),
    false,
  );
});

test("blacklisted clients keep presence without gaining tracked data", async () => {
  scenario = "blacklisted";
  const writeStart = writes.length;
  const tracked = await processClientTick(
    {
      type: 0,
      uniqueIdentifier: "blacklisted-user-uid",
      nickname: "Blocked User",
      channelId: "7",
      away: 0,
    },
    { 7: "General" },
  );
  const blacklistWrites = writes.slice(writeStart);

  assert.equal(tracked, true);
  assert.equal(
    blacklistWrites.some(({ sql }) => sql.includes("INSERT INTO users")),
    true,
  );
  for (const forbiddenWrite of [
    "INSERT INTO sessions",
    "INSERT INTO events",
    "total_time   = total_time   + ?",
    "afk_time = afk_time + ?",
    "INSERT INTO channel_time",
    "INSERT INTO hourly_activity",
  ]) {
    assert.equal(
      blacklistWrites.some(({ sql }) => sql.includes(forbiddenWrite)),
      false,
      `unexpected tracked-data write: ${forbiddenWrite}`,
    );
  }

  const activeSession = getActiveSessions().get("blacklisted-user-uid");
  assert.equal(activeSession.blacklisted, true);
  assert.equal(activeSession.sessionDbId, null);
});

test("sets every leaderboard period from whole hours and minutes", async () => {
  scenario = "edit_hours";
  const writeStart = writes.length;
  const result = await setUserTrackedHours("edited-user-uid", {
    hours: 12,
    minutes: 30,
  });
  const hourWrite = writes.slice(writeStart).find(({ sql }) =>
    sql.includes("UPDATE users SET") && sql.includes("total_time = ?"),
  );

  assert.equal(result.total_time, 12.5);
  assert.equal(result.daily_time, 12.5);
  assert.deepEqual(hourWrite.params, [12.5, 12.5, 12.5, 12.5, "edited-user-uid"]);
  await assert.rejects(
    () =>
      setUserTrackedHours("edited-user-uid", {
        hours: 1,
        minutes: 60,
      }),
    /minutes must be from 0 to 59/,
  );
});
