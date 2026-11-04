// MCP server over Streamable HTTP, in stateless mode: every POST /mcp gets a
// fresh server + transport. Simple and horizontally scalable; we do not need
// server-initiated messages or resumable sessions.
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { DB } from "../data/db";
import type { Runbook } from "../data/runbooks";
import { createMcpServer } from "./mcp-server";

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

export function createMcpHttpServer(db: DB, runbooks: Runbook[]): Server {
  return createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode: no SSE stream (GET) and no sessions to delete (DELETE).
      res.writeHead(405, { Allow: "POST" }).end("Method not allowed");
      return;
    }
    try {
      const body = await readJson(req);
      const server = createMcpServer(db, runbooks);
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
