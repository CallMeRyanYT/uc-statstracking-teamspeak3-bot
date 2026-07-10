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

    if (sql.includes("SELECT username, last_update, is_online")) {
      return {
        username: "Away User",
        last_update: new Date(Date.now() - 60_000).toISOString(),
        is_online: 1,
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
const { processClientTick } = require(trackerPath);

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
