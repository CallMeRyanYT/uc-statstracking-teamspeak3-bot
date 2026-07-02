const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "../data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new sqlite3.Database(path.join(dataDir, "stats.sqlite"));

db.serialize(() => {
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA foreign_keys=ON");

  // ── Users ──────────────────────────────────────────────────────────────────
  // Stores lifetime + rolling-period stats per unique TS3 client UID
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      uid              TEXT PRIMARY KEY,
      username         TEXT NOT NULL,
      total_time       REAL DEFAULT 0,   -- lifetime hours
      daily_time       REAL DEFAULT 0,   -- resets at midnight
      weekly_time      REAL DEFAULT 0,   -- resets Sunday midnight
      monthly_time     REAL DEFAULT 0,   -- resets 1st of month
      afk_time         REAL DEFAULT 0,   -- total hours spent in away/AFK state
      session_count    INTEGER DEFAULT 0,
      first_seen       DATETIME,
      last_seen        DATETIME,
      last_update      DATETIME,
      is_online        INTEGER DEFAULT 0,
      is_afk           INTEGER DEFAULT 0,
      away_since       DATETIME,         -- when away status started (for 5-min rule)
      muted_since      DATETIME,
      current_channel  TEXT
    )
  `);

  // ── Sessions ───────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      uid            TEXT NOT NULL,
      username       TEXT NOT NULL,
      channel_id     TEXT,
      channel_name   TEXT,
      session_start  DATETIME NOT NULL,
      session_end    DATETIME,
      duration_hours REAL DEFAULT 0,
      FOREIGN KEY(uid) REFERENCES users(uid)
    )
  `);

  // ── Channel time per user ──────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS channel_time (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      uid          TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      channel_name TEXT,
      total_time   REAL DEFAULT 0,
      visit_count  INTEGER DEFAULT 0,
      UNIQUE(uid, channel_id),
      FOREIGN KEY(uid) REFERENCES users(uid)
    )
  `);

  // ── Join / leave / move event log ──────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      uid          TEXT NOT NULL,
      username     TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      channel_id   TEXT,
      channel_name TEXT,
      timestamp    DATETIME NOT NULL
    )
  `);

  // ── Hour-of-day activity heatmap ───────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS hourly_activity (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      uid          TEXT NOT NULL,
      hour_of_day  INTEGER NOT NULL,
      day_of_week  INTEGER NOT NULL,
      ticks        INTEGER DEFAULT 0,
      UNIQUE(uid, hour_of_day, day_of_week),
      FOREIGN KEY(uid) REFERENCES users(uid)
    )
  `);

  // Indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_uid      ON sessions(uid)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_uid        ON events(uid)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_ts         ON events(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_total       ON users(total_time DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_daily       ON users(daily_time DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_weekly      ON users(weekly_time DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_monthly     ON users(monthly_time DESC)`);
});

// ── Promisified helpers ────────────────────────────────────────────────────
db.getAsync = (sql, p = []) =>
  new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

db.allAsync = (sql, p = []) =>
  new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

db.runAsync = (sql, p = []) =>
  new Promise((res, rej) =>
    db.run(sql, p, function (e) {
      e ? rej(e) : res({ lastID: this.lastID, changes: this.changes });
    })
  );

module.exports = db;
