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

test("dashboard includes the requested identity, AFK, and mention UI", () => {
  assert.match(html, /<link rel="icon" href="\/favicon\.svg"/);
  assert.match(html, />Total Users</);
  assert.match(html, /HONOR_CLOSE_DELAY_SECONDS = 5/);
  assert.match(html, /HONOR_REAPPEAR_MS = 5 \* 60_000/);
  assert.match(html, /Tracking paused/);
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
});
