// Entry point: agent HTTP API + trace viewer (+ React page once built).
//   npm run serve   then open http://localhost:3000
import { config } from "../config";
import { openSeededDb } from "../data/seed";
import { createProvider } from "../llm";
import { createAgentApi } from "./http-api";
import { connectInProcess } from "./mcp-client";

const mcp = await connectInProcess(openSeededDb(config.dbPath));
const server = createAgentApi({ mcp, createProvider: () => createProvider("auto"), traceDir: "traces" });
server.listen(config.agentPort, () => {
  console.log(`Agent API on http://localhost:${config.agentPort}  (trace viewer: /viewer)`);
});
