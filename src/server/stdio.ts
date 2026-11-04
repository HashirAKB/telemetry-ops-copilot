// Entry point: MCP server over stdio (used by Claude Desktop and by the
// agent when it spawns the server as a child process).
// stdout carries protocol messages, so all logging must go to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "../config";
import { openDb } from "../data/db";
import { loadRunbooks } from "../data/runbooks";
import { createMcpServer } from "./mcp-server";

const server = createMcpServer(openDb(config.dbPath), loadRunbooks(), { allowWrites: !config.mcpReadOnly });
await server.connect(new StdioServerTransport());
console.error(`telemetry-ops MCP server on stdio (db: ${config.dbPath})`);
