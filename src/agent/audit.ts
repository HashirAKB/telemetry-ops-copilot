// Approval audit log: who approved or denied which action, when, in which run.
//
// Traces already contain approval spans, but traces are debugging data that
// may be rotated or deleted. An audit log is a durable record you can query.
// It lives in the agent's own SQLite file (data/agent.db, see agent-db.ts),
// not in the MCP server's database: the agent should not reach into the
// server's storage.
//
// `withAudit(approver, log)` wraps any Approver (decorator pattern), so CLI,
// HTTP and policy approvers all get auditing without changing them.
import type { AgentDb } from "./agent-db";
import type { ApprovalDecision, ApprovalRequest, Approver } from "./approval";

export interface AuditEntry {
  id: number;
  run_id: string;
  tool: string;
  args: string; // JSON
  approved: 0 | 1;
  decided_by: string;
  decided_at: string; // ISO timestamp
}

export class AuditLog {
  constructor(private db: AgentDb) {}

  record(request: ApprovalRequest, decision: ApprovalDecision): void {
    this.db
      .prepare("INSERT INTO approval_log (run_id, tool, args, approved, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(request.runId, request.tool, JSON.stringify(request.args), decision.approved ? 1 : 0, decision.by, new Date().toISOString());
  }

  /** Newest first. */
  recent(limit = 50): AuditEntry[] {
    return this.db.prepare("SELECT * FROM approval_log ORDER BY id DESC LIMIT ?").all(limit) as AuditEntry[];
  }
}

export function withAudit(approver: Approver, log: AuditLog): Approver {
  return {
    async approve(request) {
      const decision = await approver.approve(request);
      log.record(request, decision);
      return decision;
    },
  };
}
