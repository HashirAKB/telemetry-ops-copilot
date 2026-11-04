// Human-in-the-loop approval for WRITE tools.
//
// The agent calls approver.approve() and waits. Different approvers decide
// in different ways: a person typing y/n in a terminal, a person clicking
// approve/deny over HTTP (see http-api.ts), or a fixed policy in tests/evals.
import { createInterface } from "node:readline/promises";

export interface ApprovalRequest {
  runId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ApprovalDecision {
  approved: boolean;
  by: string; // who decided, e.g. "cli", "http", "policy"
  reason?: string;
}

export interface Approver {
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
}

/** Asks the operator in the terminal. Anything other than "y"/"yes" is a denial. */
export class CliApprover implements Approver {
  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        `\nApproval needed: ${request.tool} ${JSON.stringify(request.args)}\nApprove? [y/N] `,
      );
      const approved = /^y(es)?$/i.test(answer.trim());
      return { approved, by: "cli" };
    } finally {
      rl.close();
    }
  }
}

/** Decides with a fixed function. Used by tests, evals and the demo. */
export class PolicyApprover implements Approver {
  readonly requests: ApprovalRequest[] = [];

  constructor(private decide: (request: ApprovalRequest) => boolean) {}

  async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return { approved: this.decide(request), by: "policy" };
  }
}

export const approveAll = () => new PolicyApprover(() => true);
export const denyAll = () => new PolicyApprover(() => false);
