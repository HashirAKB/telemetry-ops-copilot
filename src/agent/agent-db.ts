// The agent's own SQLite database (data/agent.db by default). It is separate
// from the fleet database on purpose: the agent reaches fleet data only
// through MCP, and keeps its own records here:
//   - approval_log: who approved or denied which action (audit.ts)
//   - runs: every HTTP run and its result (run-store.ts)
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AgentDb = Database.Database;

export function openAgentDb(path: string): AgentDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     TEXT    NOT NULL,
      tool       TEXT    NOT NULL,
      args       TEXT    NOT NULL,   -- JSON
      approved   INTEGER NOT NULL,   -- 0 | 1
      decided_by TEXT    NOT NULL,   -- cli | http | policy | timeout
      decided_at TEXT    NOT NULL    -- ISO timestamp
    );
    CREATE TABLE IF NOT EXISTS runs (
      id         TEXT PRIMARY KEY,
      question   TEXT NOT NULL,
      status     TEXT NOT NULL,      -- running | done | interrupted
      result     TEXT,               -- RunResult as JSON, when done
      error      TEXT,
      created_at TEXT NOT NULL
    );`);
  return db;
}
