// HTTP API for the agent (used by the React page and by curl).
//
//   POST /api/chat                 {"message": "..."}  -> 202 {"runId"}
//   GET  /api/runs/:id             -> {"status": "running" | "done" | "interrupted", "result"?}
//   GET  /api/approvals            -> pending approvals
//   POST /api/approvals/:id        {"approved": true|false} -> 200 | 404
//   GET  /api/traces/:id           -> the run's spans (JSONL)
//   GET  /api/audit                -> recent approval decisions (newest first)
//   GET  /viewer                   -> static trace viewer
//   GET  /                         -> React chat page (if built into web/dist)
//
// Runs are asynchronous: a run may be waiting for a human approval, so the
// client polls /api/runs/:id.
//
// Authentication: when `apiToken` is set, every /api/* request must send
// "Authorization: Bearer <token>". Otherwise anyone who can reach the port
// could approve a restart. Static pages (/, /viewer) stay public; they hold
// no data and ask for the token themselves.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse, type Server } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { LLMProvider } from "../llm/types";
import { isAuthorized, readJson } from "../server/http";
import { defaultSink } from "../telemetry/otlp";
import { Tracer } from "../telemetry/tracer";
import { openAgentDb } from "./agent-db";
import { withAudit, type AuditLog } from "./audit";
import { HttpApprover } from "./http-approver";
import { runAgent } from "./loop";
import { RunStore } from "./run-store";

export interface AgentApiOptions {
  mcp: Client;
  createProvider: () => LLMProvider;
  traceDir: string;
  approver?: HttpApprover;
  webDir?: string; // built React app
  apiToken?: string; // if set, required as a bearer token on /api/*
  audit?: AuditLog; // if set, every approval decision is recorded
  runs?: RunStore; // default: an in-memory store (lost on restart)
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : (body as string | Buffer));
}

export function createAgentApi(options: AgentApiOptions): Server {
  const approver = options.approver ?? new HttpApprover();
  const runApprover = options.audit ? withAudit(approver, options.audit) : approver;
  const tracer = new Tracer(defaultSink(options.traceDir));
  const runs = options.runs ?? new RunStore(openAgentDb(":memory:"));
  const webDir = options.webDir ?? join(ROOT, "web/dist");

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (options.apiToken && path.startsWith("/api/") && !isAuthorized(req.headers.authorization, options.apiToken)) {
        return send(res, 401, { error: "missing or invalid bearer token" });
      }
      if (req.method === "POST" && path === "/api/chat") {
        const body = (await readJson(req)) as { message?: unknown } | undefined;
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message || message.length > 2000) return send(res, 400, { error: "message must be 1-2000 characters" });
        const id = randomUUID();
        runs.create(id, message);
        // Fire and forget; the client polls for the result.
        runAgent(message, { provider: options.createProvider(), mcp: options.mcp, approver: runApprover, tracer, runId: id })
          .then((result) => runs.finish(id, { result }))
          .catch((err: Error) => runs.finish(id, { error: err.message }));
        return send(res, 202, { runId: id });
      }

      const runMatch = path.match(/^\/api\/runs\/([\w-]+)$/);
      if (req.method === "GET" && runMatch) {
        const state = runs.get(runMatch[1]!);
        return state ? send(res, 200, state) : send(res, 404, { error: "unknown run" });
      }

      if (req.method === "GET" && path === "/api/approvals") return send(res, 200, approver.list());
      if (req.method === "GET" && path === "/api/audit") return send(res, 200, options.audit?.recent() ?? []);

      const approvalMatch = path.match(/^\/api\/approvals\/([\w-]+)$/);
      if (req.method === "POST" && approvalMatch) {
        const body = (await readJson(req)) as { approved?: unknown } | undefined;
        if (typeof body?.approved !== "boolean") return send(res, 400, { error: '"approved" must be true or false' });
        const ok = approver.settle(approvalMatch[1]!, { approved: body.approved, by: "http" });
        return ok ? send(res, 200, { ok: true }) : send(res, 404, { error: "unknown or already decided approval" });
      }

      const traceMatch = path.match(/^\/api\/traces\/([\w-]+)$/);
      if (req.method === "GET" && traceMatch) {
        const file = join(options.traceDir, `${traceMatch[1]}.jsonl`);
        return existsSync(file) ? send(res, 200, readFileSync(file, "utf8"), "application/x-ndjson") : send(res, 404, { error: "no trace" });
      }

      if (req.method === "GET" && path === "/viewer") {
        return send(res, 200, readFileSync(join(ROOT, "viewer/index.html"), "utf8"), "text/html");
      }

      // Static files of the React app (optional, built in milestone M6).
      if (req.method === "GET") {
        const file = normalize(join(webDir, path === "/" ? "index.html" : path));
        // Only serve files inside webDir (no "../" escapes).
        if (file.startsWith(webDir + sep) && existsSync(file) && extname(file)) {
          return send(res, 200, readFileSync(file), MIME[extname(file)] ?? "application/octet-stream");
        }
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
  });
}
