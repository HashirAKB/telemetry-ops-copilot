// Persistent record of HTTP agent runs.
//
// A run that is waiting for a human approval lives inside the server process
// (it is a pending Promise). If the server restarts, that run cannot be
// resumed. Instead of pretending, startup marks every run that was still
// "running" as "interrupted", so clients get a clear final state rather than
// a run that never finishes. Completed runs survive restarts.
import type { AgentDb } from "./agent-db";
import type { RunResult } from "./loop";

export interface RunState {
  id: string;
  question: string;
  status: "running" | "done" | "interrupted";
  result?: RunResult;
  error?: string;
}

interface RunRow {
  id: string;
  question: string;
  status: RunState["status"];
  result: string | null;
  error: string | null;
}

export class RunStore {
  constructor(private db: AgentDb) {}

  create(id: string, question: string): void {
    this.db
      .prepare("INSERT INTO runs (id, question, status, created_at) VALUES (?, ?, 'running', ?)")
      .run(id, question, new Date().toISOString());
  }

  finish(id: string, outcome: { result: RunResult } | { error: string }): void {
    this.db
      .prepare("UPDATE runs SET status = 'done', result = ?, error = ? WHERE id = ?")
      .run("result" in outcome ? JSON.stringify(outcome.result) : null, "error" in outcome ? outcome.error : null, id);
  }

  get(id: string): RunState | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      question: row.question,
      status: row.status,
      ...(row.result ? { result: JSON.parse(row.result) as RunResult } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  /** Call once at startup. Returns how many runs were cut off by the restart. */
  markInterrupted(): number {
    return this.db
      .prepare("UPDATE runs SET status = 'interrupted', error = 'The server restarted before this run finished.' WHERE status = 'running'")
      .run().changes;
  }
}
