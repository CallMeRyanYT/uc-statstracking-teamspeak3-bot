const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSource = fs.readFileSync(
  path.join(__dirname, "../src/index.js"),
  "utf8",
);

test("manual refresh is same-origin, rate-limited, and waits for a TS poll", () => {
  assert.match(
    indexSource,
    /app\.use\("\/api",[\s\S]*?Cache-Control", "no-store"/,
  );
  assert.match(
    indexSource,
    /app\.post\(\s*"\/api\/refresh",\s*requireSameOriginJson/,
  );
  assert.match(indexSource, /const MANUAL_POLL_COOLDOWN_MS = 3_000;/);
  assert.match(
    indexSource,
    /const result = await triggerPoll\(\);[\s\S]{0,320}?polled: true/,
  );
});

test("pollOnce reports success and failure to manual refresh callers", () => {
  assert.match(indexSource, /return \{ ok: true, lastPoll: lastPollStats \};/);
  assert.match(indexSource, /return \{ ok: false, error: err\.message \};/);
});
