const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSource = fs.readFileSync(
  path.join(__dirname, "../src/index.js"),
  "utf8",
);

test("keeps user edits and destructive routes behind full admin access", () => {
  for (const route of [
    "/api/admin/users/:uid/hours",
    "/api/admin/users/:uid/blacklist",
    "/api/admin/users/:uid",
    "/api/admin/data",
    "/api/admin/discord/report",
  ]) {
    const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      indexSource,
      new RegExp(
        `app\\.(?:patch|post|delete)\\(\\s*["']${escapedRoute}["'][\\s\\S]{0,180}?requireRemoteAdmin`,
      ),
      `${route} must require full admin access`,
    );
  }
});
