const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(
  path.join(__dirname, "../web/index.html"),
  "utf8",
);

test("dashboard inline JavaScript parses", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((source) => source.trim());

  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0]));
});

test("dashboard includes blacklist controls and the refresh easter egg", () => {
  assert.match(html, /<link rel="icon" href="\/favicon\.svg"/);
  assert.match(html, />Total Users</);
  assert.match(html, /ALEX_TRIGGER_CLICKS = 5/);
  assert.match(html, /ALEX_REPEAT_MS = 10_000/);
  assert.match(html, /onclick="handleRefreshClick\(\)"/);
  assert.match(html, /refreshAll\(\{ forcePoll: true \}\)/);
  assert.match(html, /fetchJson\('\/api\/refresh'/);
  assert.match(html, /fetch\(url, \{ cache: 'no-store', \.\.\.options \}\)/);
  assert.match(html, /Date\.parse\(health\?\.last_poll\?\.at/);
  assert.doesNotMatch(html, /lastRefreshAt = Date\.now\(\)/);
  assert.doesNotMatch(html, /fetch\('\/api\/leaderboard'\)[\s\S]{0,80}?catch/);
  assert.match(html, /getElementById\('site-title'\)\.textContent = 'Alex Lazau'/);
  assert.match(html, /document\.title = 'Alex Lazau - TeamSpeak Activity Tracker'/);
  assert.match(html, /new Audio\('\/alex-lazau-spotted\.mp3'\)/);
  assert.match(html, /setInterval\(\(\) => \{ void playAlexSpotted\(\); \}, ALEX_REPEAT_MS\)/);
  assert.match(html, /url\('\/alex-lazau\.png'\)/);
  assert.match(html, /badge-blacklisted/);
  assert.match(html, /Tracking disabled/);
  assert.match(html, /Tracking paused/);
  assert.match(html, /id="user-hours-editor"/);
  assert.match(html, /id="save-user-hours-btn"/);
  assert.match(html, /id="edit-hours"/);
  assert.match(html, /id="edit-minutes"/);
  assert.doesNotMatch(html, /id="edit-daily-hours"/);
  assert.doesNotMatch(html, /otto-multiplier|Otto multiplier/);
  assert.match(html, /permissions\?\.manage_users/);
  assert.match(html, /setInterval\(updateRefreshInfo, 1_000\)/);
  assert.match(html, /second: '2-digit'/);
  assert.doesNotMatch(html, /HONOR_CLOSE_DELAY_SECONDS|honor-overlay/);
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
});

test("easter egg media assets are present and non-empty", () => {
  const webDir = path.join(__dirname, "../web");
  assert.ok(fs.statSync(path.join(webDir, "alex-lazau.png")).size > 1_000);
  assert.ok(
    fs.statSync(path.join(webDir, "alex-lazau-spotted.mp3")).size > 1_000,
  );
});
