const test = require("node:test");
const assert = require("node:assert/strict");

const { TeamSpeakAdminAuth } = require("../src/admin-auth");

test("verifies a Server Admin by permanent UID and follows nickname changes", () => {
  const auth = new TeamSpeakAdminAuth({ adminGroupIds: "6,10" });
  const challenge = auth.createChallenge();

  auth.updateClients([
    {
      clid: "42",
      uniqueIdentifier: "permanent-user-uid",
      nickname: `Ryan ${challenge.code}`,
      servergroups: ["6"],
    },
  ]);

  const verified = auth.verifyChallenge(challenge.id);
  assert.equal(verified.ok, true);
  assert.equal(verified.uid, "permanent-user-uid");

  auth.updateClients([
    {
      clid: "99",
      uniqueIdentifier: "permanent-user-uid",
      nickname: "Ryan Renamed",
      servergroups: ["6"],
    },
  ]);

  const session = auth.getSession(verified.token);
  assert.equal(session.uid, "permanent-user-uid");
  assert.equal(session.username, "Ryan Renamed");
});

test("rejects a matching nickname without an allowed admin group", () => {
  const auth = new TeamSpeakAdminAuth({ adminGroupIds: "6" });
  const challenge = auth.createChallenge();
  auth.updateClients([
    {
      uniqueIdentifier: "regular-user-uid",
      nickname: `Regular ${challenge.code}`,
      servergroups: ["8"],
    },
  ]);

  const result = auth.verifyChallenge(challenge.id);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not in an allowed Server Admin group/);
});

test("revokes effective access when the TeamSpeak identity goes offline", () => {
  const auth = new TeamSpeakAdminAuth({ adminGroupIds: "6" });
  const challenge = auth.createChallenge();
  auth.updateClients([
    {
      uniqueIdentifier: "admin-uid",
      nickname: `Admin ${challenge.code}`,
      servergroups: ["6"],
    },
  ]);
  const verified = auth.verifyChallenge(challenge.id);
  auth.updateClients([]);

  assert.equal(auth.getSession(verified.token), null);
});
