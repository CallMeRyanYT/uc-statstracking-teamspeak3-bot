const test = require("node:test");
const assert = require("node:assert/strict");

const databasePath = require.resolve("../src/database");
const trackerPath = require.resolve("../src/tracker");
const writes = [];
let scenario = "afk";

const fakeDb = {
  async getAsync(sql) {
    if (sql.includes("SELECT value FROM app_meta")) {
      return scenario === "otto" ? { value: "3" } : null;
    }

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
  getOttoMultiplier,
  processClientTick,
  setOttoMultiplier,
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

test("Otto defaults to 2x and a configured 3x credits time and heatmap units", async () => {
  scenario = "default_multiplier";
  assert.equal(await getOttoMultiplier(), 2);

  scenario = "otto";
  const writeStart = writes.length;
  await processClientTick(
    {
      type: 0,
      uniqueIdentifier: "Z9wyOb/tgzg6wd6TMA9fs36txK0=",
      nickname: "SpiceHater67",
      channelId: "7",
      away: 0,
    },
    { 7: "General" },
  );
  const ottoWrites = writes.slice(writeStart);
  const timeWrite = ottoWrites.find(({ sql }) =>
    sql.includes("total_time   = total_time   + ?"),
  );
  const heatmapWrite = ottoWrites.find(({ sql }) =>
    sql.includes("INSERT INTO hourly_activity"),
  );

  assert.ok(timeWrite);
  assert.ok(heatmapWrite);
  assert.ok(timeWrite.params[0] > 0.049 && timeWrite.params[0] < 0.051);
  assert.ok(heatmapWrite.params[3] > 2.99 && heatmapWrite.params[3] < 3.01);
});

test("persists only bounded Otto multipliers", async () => {
  scenario = "default_multiplier";
  const writeStart = writes.length;
  assert.equal(await setOttoMultiplier(2.5), 2.5);
  const multiplierWrite = writes.slice(writeStart).find(({ sql }) =>
    sql.includes("INSERT INTO app_meta"),
  );
  assert.deepEqual(multiplierWrite.params, ["otto_hours_multiplier", "2.5"]);
  await assert.rejects(() => setOttoMultiplier(0), /between 0.1 and 100/);
  await assert.rejects(() => setOttoMultiplier(101), /between 0.1 and 100/);
});

test("validates and updates all editable leaderboard hour counters", async () => {
  scenario = "edit_hours";
  const writeStart = writes.length;
  const result = await setUserTrackedHours("edited-user-uid", {
    total_time: 12.5,
    daily_time: 1.25,
    weekly_time: 4,
    monthly_time: 8,
  });
  const hourWrite = writes.slice(writeStart).find(({ sql }) =>
    sql.includes("UPDATE users SET") && sql.includes("total_time = ?"),
  );

  assert.equal(result.total_time, 12.5);
  assert.deepEqual(hourWrite.params, [12.5, 1.25, 4, 8, "edited-user-uid"]);
  await assert.rejects(
    () =>
      setUserTrackedHours("edited-user-uid", {
        total_time: 1,
        daily_time: 2,
        weekly_time: 0,
        monthly_time: 0,
      }),
    /cannot exceed all-time/,
  );
});
