// Central place for configuration read from environment variables.
// Every value has a safe local default so the project runs with zero setup.
export const config = {
  dbPath: process.env.DB_PATH ?? "data/fleet.db",
  agentDbPath: process.env.AGENT_DB_PATH ?? "data/agent.db", // agent-side runs + approval audit log
  mcpPort: Number(process.env.MCP_PORT ?? 3001),
  mcpApiToken: process.env.MCP_API_TOKEN ?? "", // bearer token for the MCP HTTP endpoint
  mcpReadOnly: process.env.MCP_READ_ONLY === "1", // do not expose write tools at all
  agentPort: Number(process.env.AGENT_PORT ?? 3000),
  // Standard OpenTelemetry variable; when set, traces are also exported via OTLP/HTTP.
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  agentApiToken: process.env.AGENT_API_TOKEN ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
};
