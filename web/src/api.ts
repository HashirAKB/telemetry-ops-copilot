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
  status: "running" | "done" | "interrupted";
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

export class UnauthorizedError extends Error {}

// The API token (if the server requires one) is kept in localStorage so the
// trace viewer (same origin, new tab) can use it too. Access is wrapped
// because storage can be unavailable (private mode, blocked site data).
const TOKEN_KEY = "ops-copilot-token";
export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage unavailable: the token is simply not remembered
  }
}
function authHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function json<T>(response: Response): Promise<T> {
  if (response.status === 401) throw new UnauthorizedError("API token required");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as T;
}

const get = (path: string) => fetch(path, { headers: authHeaders() });
const post = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });

export const api = {
  startRun: async (message: string) => json<{ runId: string }>(await post("/api/chat", { message })),
  getRun: async (id: string) => json<RunState>(await get(`/api/runs/${id}`)),
  listApprovals: async () => json<PendingApproval[]>(await get("/api/approvals")),
  decide: async (id: string, approved: boolean) => json<{ ok: true }>(await post(`/api/approvals/${id}`, { approved })),
};
