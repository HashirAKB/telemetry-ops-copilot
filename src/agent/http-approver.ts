// Approval over HTTP: the agent run waits on a Promise that is resolved
// when someone calls POST /api/approvals/:id. If nobody decides within the
// timeout, the request is DENIED (fail safe).
import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalRequest, Approver } from "./approval";

export interface PendingApproval extends ApprovalRequest {
  id: string;
  createdAt: string;
}

export class HttpApprover implements Approver {
  private pending = new Map<string, { info: PendingApproval; resolve: (d: ApprovalDecision) => void }>();

  constructor(private timeoutMs = 5 * 60_000) {}

  approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    const info: PendingApproval = { ...request, id: randomUUID(), createdAt: new Date().toISOString() };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(info.id, { approved: false, by: "timeout" }), this.timeoutMs);
      this.pending.set(info.id, {
        info,
        resolve: (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
      });
    });
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.info);
  }

  /** Resolve a pending approval. Returns false if the id is unknown (or already decided). */
  settle(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(decision);
    return true;
  }
}
