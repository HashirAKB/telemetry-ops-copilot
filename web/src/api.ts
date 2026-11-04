// Thin client for the agent HTTP API (src/agent/http-api.ts).

export interface ToolCall {
  name: string;
  args: unknown;
  status: "ok" | "error" | "blocked" | "invalid" | "denied";
  approval?: { approved: boolean; by: string };
}

export interface RunResult {
  runId: string;
  answer: string;
  stopReason: string;
  steps: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  toolCalls: ToolCall[];
}

export interface RunState {
  id: string;
  question: string;
  status: "running" | "done";
  result?: RunResult;
  error?: string;
}

export interface PendingApproval {
  id: string;
  runId: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: string;
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const api = {
  startRun: async (message: string) => json<{ runId: string }>(await post("/api/chat", { message })),
  getRun: async (id: string) => json<RunState>(await fetch(`/api/runs/${id}`)),
  listApprovals: async () => json<PendingApproval[]>(await fetch("/api/approvals")),
  decide: async (id: string, approved: boolean) => json<{ ok: true }>(await post(`/api/approvals/${id}`, { approved })),
};
