const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDiscordPayload,
  createDiscordReporter,
  formatReportSchedule,
  getLatestScheduledReportAt,
  getNextScheduledReportAt,
  parseIntervalMinutes,
  validateDiscordWebhookUrl,
  validatePublicDashboardUrl,
} = require("../src/discord");

function getEmbedField(payload, name) {
  return payload.embeds[0].fields.find((field) => field.name === name);
}

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
  assert.equal(payload.embeds[0].title, "TeamSpeak Activity Report");
  assert.match(getEmbedField(payload, "Leaderboard").value, /@\u200beveryone/);
  assert.match(getEmbedField(payload, "Leaderboard").value, /\\\*Admin\\\*/);
  assert.equal(payload.embeds[0].fields[0].name, "Users");
  assert.equal(
    payload.embeds[0].fields.at(-1).value,
    "[Open live statistics](https://uct.aquaweb.cc/)",
  );
  assert.match(payload.embeds[0].footer.text, /Hourly at :00/);
});

test("marks away users as AFK instead of online in Discord", () => {
  const payload = buildDiscordPayload({
    totals: { users: 1, online: 1, total_hours: 1, total_sessions: 1 },
    leaderboard: [
      { username: "Away User", total_time: 1, is_online: 1, is_afk: 1 },
    ],
    channels: [],
  });

  assert.match(getEmbedField(payload, "Leaderboard").value, /AFK/);
  assert.doesNotMatch(getEmbedField(payload, "Leaderboard").value, /Online/);
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

  assert.match(
    getEmbedField(payload, "Leaderboard").value,
    /AFK \/ Blacklisted/,
  );
});

test("carries rounded minutes into the next hour", () => {
  const payload = buildDiscordPayload({
    totals: { users: 1, online: 0, total_hours: 1.999, total_sessions: 1 },
    leaderboard: [
      { username: "Precise User", total_time: 1.999, is_online: 0 },
    ],
    channels: [],
  });

  assert.match(getEmbedField(payload, "Leaderboard").value, /`2h 0m`/);
  assert.equal(getEmbedField(payload, "Tracked time").value, "**2h 0m**");
});

test("aligns automatic reports to clean wall-clock slots", () => {
  const at2042 = new Date(2026, 6, 12, 20, 42, 30);
  const at2059 = new Date(2026, 6, 12, 20, 59, 30);

  assert.equal(getLatestScheduledReportAt(at2042, 60).getMinutes(), 0);
  assert.equal(getNextScheduledReportAt(at2042, 60).getHours(), 21);
  assert.equal(getLatestScheduledReportAt(at2042, 15).getMinutes(), 30);
  assert.equal(getNextScheduledReportAt(at2042, 15).getMinutes(), 45);
  assert.equal(getLatestScheduledReportAt(at2042, 13).getMinutes(), 39);
  assert.equal(getNextScheduledReportAt(at2042, 13).getMinutes(), 52);
  assert.equal(getNextScheduledReportAt(at2059, 13).getHours(), 21);
  assert.equal(getNextScheduledReportAt(at2059, 13).getMinutes(), 0);
  assert.equal(formatReportSchedule(13), "Every 13 min | :00, :13, :26, :39, :52");
  assert.equal(parseIntervalMinutes(2), 5);
  assert.equal(parseIntervalMinutes(2000), 1440);
  assert.equal(parseIntervalMinutes("13.5"), 60);
});

test("scheduled sending waits for the next aligned slot", async () => {
  let now = new Date(2026, 6, 12, 20, 42, 10);
  const meta = new Map();
  let postCount = 0;
  const db = {
    async getAsync(sql, params = []) {
      if (sql.includes("FROM app_meta")) {
        const value = meta.get(params[0]);
        return value ? { value } : null;
      }
      if (sql.includes("COUNT(*) AS users FROM users")) return { users: 1 };
      return { users: 1, online: 1, total_hours: 2, total_sessions: 3 };
    },
    async allAsync(sql) {
      if (sql.includes("FROM channel_time")) return [];
      return [{ username: "Ryan", total_time: 2, is_online: 1 }];
    },
    async runAsync(_sql, params) {
      meta.set(params[0], params[1]);
      return { changes: 1 };
    },
  };
  const reporter = createDiscordReporter({
    db,
    webhookUrl: "https://discord.com/api/webhooks/123456789/secret-token",
    intervalMinutes: 60,
    now: () => now,
    logger: { log() {}, error() {} },
    fetchImpl: async () => {
      postCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => '{"id":"200000000000000003"}',
      };
    },
  });

  const status = await reporter.getStatus();
  assert.equal(status.schedule, "Hourly at :00");
  assert.equal(new Date(status.next_scheduled_at).getHours(), 21);
  assert.equal(new Date(status.next_scheduled_at).getMinutes(), 0);
  assert.deepEqual(await reporter.maybeSend(), { sent: false });
  assert.equal(postCount, 0);

  now = new Date(2026, 6, 12, 21, 0, 10);
  assert.equal((await reporter.maybeSend()).sent, true);
  assert.equal(postCount, 1);

  now = new Date(2026, 6, 12, 21, 0, 30);
  assert.deepEqual(await reporter.maybeSend(), { sent: false });
  assert.equal(postCount, 1);
});

test("sends with wait=true and stores the report time and message ID", async () => {
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

  const requests = [];
  const reporter = createDiscordReporter({
    db,
    webhookUrl: "https://discord.com/api/webhooks/123456789/secret-token",
    intervalMinutes: 60,
    logger: { log() {}, error() {} },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        text: async () => '{"id":"200000000000000001"}',
      };
    },
  });

  const result = await reporter.sendNow();
  assert.equal(result.sent, true);
  assert.equal(result.messageId, "200000000000000001");
  assert.match(requests[0].url, /[?&]wait=true/);
  assert.equal(JSON.parse(requests[0].options.body).embeds.length, 1);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].params, [
    "discord_last_report_at",
    result.sentAt,
  ]);
});

test("deletes the previous webhook report after sending its replacement", async () => {
  const meta = new Map([
    ["discord_last_report_message_id", "200000000000000001"],
  ]);
  const requests = [];
  const db = {
    async getAsync(sql, params = []) {
      if (sql.includes("FROM app_meta")) {
        const value = meta.get(params[0]);
        return value ? { value } : null;
      }
      if (sql.includes("COUNT(*) AS users FROM users")) return { users: 1 };
      return { users: 1, online: 0, total_hours: 1, total_sessions: 2 };
    },
    async allAsync(sql) {
      if (sql.includes("FROM channel_time")) return [];
      return [{ username: "Ryan", total_time: 1, is_online: 0 }];
    },
    async runAsync(_sql, params) {
      meta.set(params[0], params[1]);
      return { changes: 1 };
    },
  };
  const reporter = createDiscordReporter({
    db,
    webhookUrl: "https://discord.com/api/webhooks/123456789/secret-token",
    intervalMinutes: 60,
    logger: { log() {}, error() {} },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (options.method === "DELETE") {
        return { ok: true, status: 204, text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        text: async () => '{"id":"200000000000000002"}',
      };
    },
  });

  const result = await reporter.sendNow();
  assert.equal(result.deletedPrevious, true);
  assert.deepEqual(
    requests.map(({ options }) => options.method),
    ["POST", "DELETE"],
  );
  assert.match(
    requests[1].url,
    /\/messages\/200000000000000001$/,
  );
  assert.equal(
    meta.get("discord_last_report_message_id"),
    "200000000000000002",
  );
});
