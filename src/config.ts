// Central place for configuration read from environment variables.
// Every value has a safe local default so the project runs with zero setup.
export const config = {
  dbPath: process.env.DB_PATH ?? "data/fleet.db",
  agentDbPath: process.env.AGENT_DB_PATH ?? "data/agent.db", // agent-side runs + approval audit log
  mcpPort: Number(process.env.MCP_PORT ?? 3001),
  agentPort: Number(process.env.AGENT_PORT ?? 3000),
  // Standard OpenTelemetry variable; when set, traces are also exported via OTLP/HTTP.
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  agentApiToken: process.env.AGENT_API_TOKEN ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
};
