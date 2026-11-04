// Entry point: MCP server over Streamable HTTP at http://localhost:MCP_PORT/mcp
import { config } from "../config";
import { openDb } from "../data/db";
import { loadRunbooks } from "../data/runbooks";
import { createMcpHttpServer } from "./http";

createMcpHttpServer(openDb(config.dbPath), loadRunbooks()).listen(config.mcpPort, () => {
  console.log(`telemetry-ops MCP server on http://localhost:${config.mcpPort}/mcp`);
});
