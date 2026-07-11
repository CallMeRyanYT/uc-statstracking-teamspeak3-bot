const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDiscordPayload,
  createDiscordReporter,
  validateDiscordWebhookUrl,
  validatePublicDashboardUrl,
} = require("../src/discord");

test("accepts official Discord webhook URLs and rejects lookalike hosts", () => {
  const valid = validateDiscordWebhookUrl(
    "https://discord.com/api/webhooks/123456789/secret-token",
  );
  assert.equal(valid.hostname, "discord.com");

  assert.throws(
    () =>
      validateDiscordWebhookUrl(
        "https://discord.com.attacker.example/api/webhooks/123/token",
      ),
    /official Discord HTTPS host/,
  );
});

test("normalizes public dashboard URLs and rejects unsafe schemes", () => {
  assert.equal(
    validatePublicDashboardUrl("https://uct.aquaweb.cc"),
    "https://uct.aquaweb.cc/",
  );
  assert.throws(
    () => validatePublicDashboardUrl("javascript:alert(1)"),
    /must use HTTP or HTTPS/,
  );
  assert.throws(
    () => validatePublicDashboardUrl("https://user:password@uct.aquaweb.cc/"),
    /cannot contain login credentials/,
  );
});

test("builds a mention-safe statistics embed", () => {
  const payload = buildDiscordPayload(
    {
      totals: { users: 1, online: 1, total_hours: 2.5, total_sessions: 3 },
      leaderboard: [
        { username: "@everyone *Admin*", total_time: 2.5, is_online: 1 },
      ],
      channels: [{ channel_name: "Lobby", total_time: 2.5 }],
    },
    {
      intervalMinutes: 60,
      dashboardUrl: "https://uct.aquaweb.cc/",
    },
  );

  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.embeds[0].description, /@\u200beveryone/);
  assert.match(payload.embeds[0].description, /\\\*Admin\\\*/);
  assert.equal(payload.embeds[0].fields[0].name, "Users");
  assert.equal(
    payload.embeds[0].fields.at(-1).value,
    "<https://uct.aquaweb.cc/>",
  );
  assert.match(payload.embeds[0].footer.text, /https:\/\/uct\.aquaweb\.cc\//);
});

test("marks away users as AFK instead of online in Discord", () => {
  const payload = buildDiscordPayload({
    totals: { users: 1, online: 1, total_hours: 1, total_sessions: 1 },
    leaderboard: [
      { username: "Away User", total_time: 1, is_online: 1, is_afk: 1 },
    ],
    channels: [],
  });

  assert.match(payload.embeds[0].description, /\(AFK\)/);
  assert.doesNotMatch(payload.embeds[0].description, /\(online\)/);
});

test("marks blacklisted users in Discord statistics", () => {
  const payload = buildDiscordPayload({
    totals: { users: 1, online: 1, total_hours: 1, total_sessions: 1 },
    leaderboard: [
      {
        username: "Blocked User",
        total_time: 1,
        is_online: 1,
        is_afk: 1,
        is_blacklisted: 1,
      },
    ],
    channels: [],
  });

  assert.match(payload.embeds[0].description, /\(AFK, blacklisted\)/);
});

test("carries rounded minutes into the next hour", () => {
  const payload = buildDiscordPayload({
    totals: { users: 1, online: 0, total_hours: 1.999, total_sessions: 1 },
    leaderboard: [
      { username: "Precise User", total_time: 1.999, is_online: 0 },
    ],
    channels: [],
  });

  assert.match(payload.embeds[0].description, /`2h 0m`/);
  assert.equal(payload.embeds[0].fields[2].value, "2h 0m");
});

test("sends with wait=true and records the successful report time", async () => {
  const writes = [];
  const db = {
    async getAsync(sql) {
      if (sql.includes("FROM app_meta")) return null;
      if (sql.includes("COUNT(*) AS users FROM users")) return { users: 1 };
      return { users: 1, online: 0, total_hours: 1, total_sessions: 2 };
    },
    async allAsync(sql) {
      if (sql.includes("FROM channel_time")) return [];
      return [{ username: "Ryan", total_time: 1, is_online: 0 }];
    },
    async runAsync(sql, params) {
      writes.push({ sql, params });
      return { changes: 1 };
    },
  };

  let request = null;
  const reporter = createDiscordReporter({
    db,
    webhookUrl: "https://discord.com/api/webhooks/123456789/secret-token",
    intervalMinutes: 60,
    logger: { log() {}, error() {} },
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, status: 200, text: async () => "" };
    },
  });

  const result = await reporter.sendNow();
  assert.equal(result.sent, true);
  assert.match(request.url, /[?&]wait=true/);
  assert.equal(JSON.parse(request.options.body).embeds.length, 1);
  assert.equal(writes.length, 1);
});
