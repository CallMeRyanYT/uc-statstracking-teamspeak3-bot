const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const trackerSource = fs.readFileSync(
  path.join(__dirname, "../src/tracker.js"),
  "utf8",
);

test("preserves the protected UID multiplier in both active calculations", () => {
  assert.match(
    trackerSource,
    /const tickMult = uid === "Z9wyOb\/tgzg6wd6TMA9fs36txK0=" \? 6\.7 : 1;/,
  );
  assert.match(
    trackerSource,
    /const tickTime = \(elapsedMs \/ 3_600_000\) \* tickMult;/,
  );
  assert.match(
    trackerSource,
    /const tickUnits = \(elapsedMs \/ POLL_INTERVAL_MS\) \* tickMult;/,
  );
  assert.match(trackerSource, /const DEFAULT_OTTO_MULTIPLIER = 2;/);
  assert.match(
    trackerSource,
    /const creditedTickTime = tickTime \* multiplierAdjustment;/,
  );
  assert.match(
    trackerSource,
    /const creditedTickUnits = tickUnits \* multiplierAdjustment;/,
  );
});

test("keeps required ignored names and purges them during runtime", () => {
  assert.match(trackerSource, /"UC Music Bot"/);
  assert.match(trackerSource, /"Admonus"/);
  assert.match(
    trackerSource,
    /isIgnoredNickname\(client\.nickname\)[\s\S]*resetUserTrackingData\(client\.uniqueIdentifier\)/,
  );
});

test("stores nickname changes on the permanent UID row", () => {
  assert.match(trackerSource, /ON CONFLICT\(uid\) DO UPDATE SET/);
  assert.match(trackerSource, /username\s+= excluded\.username/);
  assert.match(
    trackerSource,
    /UPDATE sessions SET username = \? WHERE uid = \?/,
  );
  assert.match(
    trackerSource,
    /UPDATE events SET username = \? WHERE uid = \?/,
  );
});
