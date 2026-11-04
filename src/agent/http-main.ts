// Entry point: agent HTTP API + trace viewer (+ React page once built).
//   npm run serve   then open http://localhost:3000
import { config } from "../config";
import { openSeededDb } from "../data/seed";
import { createProvider } from "../llm";
import { AuditLog } from "./audit";
import { createAgentApi } from "./http-api";
import { connectInProcess } from "./mcp-client";

const mcp = await connectInProcess(openSeededDb(config.dbPath));
const server = createAgentApi({
  mcp,
  createProvider: () => createProvider("auto"),
  traceDir: "traces",
  apiToken: config.agentApiToken || undefined,
  audit: new AuditLog(config.auditDbPath),
});
server.listen(config.agentPort, () => {
  console.log(`Agent API on http://localhost:${config.agentPort}  (trace viewer: /viewer)`);
  if (!config.agentApiToken) {
    console.warn("WARNING: AGENT_API_TOKEN is not set; anyone who can reach this port can approve actions.");
  }
});
