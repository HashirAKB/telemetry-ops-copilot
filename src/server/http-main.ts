// Entry point: MCP server over Streamable HTTP at http://localhost:MCP_PORT/mcp
import { config } from "../config";
import { openDb } from "../data/db";
import { loadRunbooks } from "../data/runbooks";
import { createMcpHttpServer } from "./http";

const options = { apiToken: config.mcpApiToken || undefined, allowWrites: !config.mcpReadOnly };
createMcpHttpServer(openDb(config.dbPath), loadRunbooks(), options).listen(config.mcpPort, () => {
  console.log(`telemetry-ops MCP server on http://localhost:${config.mcpPort}/mcp${config.mcpReadOnly ? " (read-only)" : ""}`);
  if (!config.mcpApiToken) console.warn("WARNING: MCP_API_TOKEN is not set; anyone who can reach this port can call the tools.");
});
