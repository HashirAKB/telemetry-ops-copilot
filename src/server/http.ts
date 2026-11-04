// MCP server over Streamable HTTP, in stateless mode: every POST /mcp gets a
// fresh server + transport. Simple and horizontally scalable; we do not need
// server-initiated messages or resumable sessions.
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { DB } from "../data/db";
import type { Runbook } from "../data/runbooks";
import { createMcpServer, type McpServerOptions } from "./mcp-server";

const MAX_BODY_BYTES = 1_000_000;

/** Constant-time comparison so the token cannot be guessed byte by byte from response timing. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Read and parse a JSON request body (undefined if empty). Rejects bodies over 1 MB. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

export interface McpHttpOptions extends McpServerOptions {
  apiToken?: string; // if set, every request needs "Authorization: Bearer <token>"
}

export function createMcpHttpServer(db: DB, runbooks: Runbook[], options: McpHttpOptions = {}): Server {
  return createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }
    if (options.apiToken && !isAuthorized(req.headers.authorization, options.apiToken)) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode: no SSE stream (GET) and no sessions to delete (DELETE).
      res.writeHead(405, { Allow: "POST" }).end("Method not allowed");
      return;
    }
    try {
      const body = await readJson(req);
      const server = createMcpServer(db, runbooks, options);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: (err as Error).message }, id: null }));
    }
  });
}
