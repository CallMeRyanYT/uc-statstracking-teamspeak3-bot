const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const setupSource = fs.readFileSync(
  path.join(__dirname, "../setup.ps1"),
  "utf8",
);
const bashSetupSource = fs.readFileSync(
  path.join(__dirname, "../setup.sh"),
  "utf8",
);

test("setup validates and previews the clock-aligned Discord schedule", () => {
  assert.match(setupSource, /function Read-ReportInterval/);
  assert.match(setupSource, /\$parsed -ge 5 -and \$parsed -le 1440/);
  assert.match(setupSource, /function Format-ReportSchedulePreview/);
  assert.match(setupSource, /Automatic reports align to clock slots/);
  assert.match(setupSource, /Schedule: \$\(Format-ReportSchedulePreview/);
});

test("Debian Bash setup installs Docker when needed and validates report scheduling", () => {
  assert.match(bashSetupSource, /^#!\/usr\/bin\/env bash/m);
  assert.match(bashSetupSource, /download\.docker\.com\/linux\/debian/);
  assert.match(bashSetupSource, /docker-compose-plugin/);
  assert.match(bashSetupSource, /read_report_interval/);
  assert.match(bashSetupSource, /-ge 5/);
  assert.match(bashSetupSource, /-le 1440/);
  assert.match(bashSetupSource, /format_report_schedule_preview/);
});
