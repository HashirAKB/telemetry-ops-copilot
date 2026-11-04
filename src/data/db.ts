// SQLite access: opening the database and creating the schema.
//
// We use better-sqlite3 because it is synchronous: a query is a plain
// function call that returns rows, which keeps the data layer easy to read.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id        TEXT PRIMARY KEY,         -- e.g. "D-17"
  site      TEXT NOT NULL,            -- e.g. "plant-a"
  model     TEXT NOT NULL,            -- hardware model
  firmware  TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'online'  -- online | restarting
);

-- One row per device per minute. WITHOUT ROWID stores rows ordered by the
-- primary key, so "metrics for device X between t1 and t2" is a range scan.
CREATE TABLE IF NOT EXISTS metrics (
  device_id   TEXT    NOT NULL,
  ts          INTEGER NOT NULL,       -- unix seconds (UTC)
  temperature REAL    NOT NULL,       -- degrees Celsius
  vibration   REAL    NOT NULL,       -- mm/s RMS
  battery     REAL    NOT NULL,       -- percent
  signal      REAL    NOT NULL,       -- dBm (closer to 0 is stronger)
  PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  severity    TEXT    NOT NULL,       -- low | medium | high | critical
  description TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Audit log of actions taken on devices (restarts).
CREATE TABLE IF NOT EXISTS device_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT    NOT NULL,
  type        TEXT    NOT NULL,       -- e.g. "restart"
  reason      TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
`;

/** Open (and create if needed) a SQLite database with the schema applied. */
export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}
