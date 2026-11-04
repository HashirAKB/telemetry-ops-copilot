// Guardrails: checks the agent applies to every model decision before it
// has any effect. Pure functions / tiny classes, easy to unit test.
import { isToolName, TOOLS, type ToolName } from "../tools/definitions";
import { costUsd } from "../llm/pricing";
import type { Usage } from "../llm/types";

export type ToolCheck =
  | { ok: true; tool: ToolName; args: Record<string, unknown>; needsApproval: boolean }
  | { ok: false; status: "blocked" | "invalid"; message: string };

/**
 * 1. Allow-list: the tool must be known AND allowed for this run.
 * 2. Argument validation with the same zod schema the server uses, so bad
 *    arguments never reach a human approver or the server.
 * 3. Approval policy: anything that is not explicitly read-only needs a human.
 *    (Default-deny: we never trust a server's "readOnlyHint".)
 */
export function checkToolCall(name: string, input: unknown, allowed: readonly ToolName[]): ToolCheck {
  if (!isToolName(name) || !allowed.includes(name)) {
    return { ok: false, status: "blocked", message: `Tool "${name}" is not on the allow-list for this agent.` };
  }
  const parsed = TOOLS[name].schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return { ok: false, status: "invalid", message: `Invalid arguments for ${name}: ${issues}` };
  }
  return {
    ok: true,
    tool: name,
    args: parsed.data as Record<string, unknown>,
    needsApproval: TOOLS[name].access !== "read",
  };
}

export interface BudgetLimits {
  maxTokens: number; // input + output, summed over all LLM calls in the run
  maxCostUsd: number;
}

export const DEFAULT_BUDGET: BudgetLimits = { maxTokens: 200_000, maxCostUsd: 0.5 };

/** Tracks token and cost spend for one run. */
export class Budget {
  inputTokens = 0;
  outputTokens = 0;
  costUsd = 0;

  constructor(
    private limits: BudgetLimits,
    private model: string,
  ) {}

  add(usage: Usage): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.costUsd += costUsd(this.model, usage.inputTokens, usage.outputTokens);
  }

  /** A reason string if the budget is used up, otherwise null. */
  exceeded(): string | null {
    const tokens = this.inputTokens + this.outputTokens;
    if (tokens >= this.limits.maxTokens) return `token budget exceeded (${tokens} >= ${this.limits.maxTokens})`;
    if (this.costUsd >= this.limits.maxCostUsd) {
      return `cost budget exceeded (USD ${this.costUsd.toFixed(4)} >= ${this.limits.maxCostUsd})`;
    }
    return null;
  }
}
