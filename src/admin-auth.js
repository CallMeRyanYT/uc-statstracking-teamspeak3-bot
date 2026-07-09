const crypto = require("crypto");

const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 60 * 60_000;
const MAX_CHALLENGES = 100;

function normalizeGroupIds(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function generateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return `UC-${code.slice(0, 4)}-${code.slice(4)}`;
}

class TeamSpeakAdminAuth {
  constructor(options = {}) {
    this.adminGroupIds = new Set(normalizeGroupIds(options.adminGroupIds));
    this.challengeTtlMs = options.challengeTtlMs || CHALLENGE_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs || SESSION_TTL_MS;
    this.clients = new Map();
    this.challenges = new Map();
    this.sessions = new Map();
  }

  updateClients(clients) {
    const next = new Map();
    for (const client of clients || []) {
      const uid = client.uniqueIdentifier || client.clientUniqueIdentifier;
      const nickname = client.nickname || client.clientNickname;
      if (!uid || !nickname) continue;
      next.set(String(uid), {
        uid: String(uid),
        nickname: String(nickname),
        groupIds: normalizeGroupIds(
          client.servergroups ||
            client.serverGroups ||
            client.clientServergroups,
        ),
      });
    }
    this.clients = next;
    this.cleanup();
  }

  isAdminClient(client) {
    return client.groupIds.some((id) => this.adminGroupIds.has(id));
  }

  createChallenge() {
    this.cleanup();
    while (this.challenges.size >= MAX_CHALLENGES) {
      this.challenges.delete(this.challenges.keys().next().value);
    }

    const id = crypto.randomUUID();
    const code = generateCode();
    const expiresAt = Date.now() + this.challengeTtlMs;
    this.challenges.set(id, { code, expiresAt });
    return { id, code, expiresAt: new Date(expiresAt).toISOString() };
  }

  verifyChallenge(id) {
    this.cleanup();
    const challenge = this.challenges.get(String(id || ""));
    if (!challenge) {
      return { ok: false, reason: "Challenge expired. Start a new one." };
    }

    const code = challenge.code.toUpperCase();
    const matchingClients = [...this.clients.values()].filter((client) =>
      client.nickname.toUpperCase().includes(code),
    );

    if (!matchingClients.length) {
      return {
        ok: false,
        reason: "No online TeamSpeak nickname contains the verification code yet.",
      };
    }

    const adminClient = matchingClients.find((client) =>
      this.isAdminClient(client),
    );
    if (!adminClient) {
      return {
        ok: false,
        reason: "That TeamSpeak identity is not in an allowed Server Admin group.",
      };
    }

    this.challenges.delete(String(id));
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.sessionTtlMs;
    this.sessions.set(token, {
      uid: adminClient.uid,
      username: adminClient.nickname,
      expiresAt,
    });

    return {
      ok: true,
      token,
      uid: adminClient.uid,
      username: adminClient.nickname,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  getSession(token) {
    this.cleanup();
    const session = this.sessions.get(String(token || ""));
    if (!session) return null;

    const client = this.clients.get(session.uid);
    if (!client || !this.isAdminClient(client)) {
      this.sessions.delete(String(token));
      return null;
    }

    session.username = client.nickname;
    return { ...session };
  }

  revoke(token) {
    this.sessions.delete(String(token || ""));
  }

  cleanup() {
    const now = Date.now();
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id);
    }
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

module.exports = { TeamSpeakAdminAuth, normalizeGroupIds };
