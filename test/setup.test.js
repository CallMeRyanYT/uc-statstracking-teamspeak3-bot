const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const setupSource = fs.readFileSync(
  path.join(__dirname, "../setup.ps1"),
  "utf8",
);

test("setup validates and previews the clock-aligned Discord schedule", () => {
  assert.match(setupSource, /function Read-ReportInterval/);
  assert.match(setupSource, /\$parsed -ge 5 -and \$parsed -le 1440/);
  assert.match(setupSource, /function Format-ReportSchedulePreview/);
  assert.match(setupSource, /Automatic reports align to clock slots/);
  assert.match(setupSource, /Schedule: \$\(Format-ReportSchedulePreview/);
});
