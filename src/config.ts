// Central place for configuration read from environment variables.
// Every value has a safe local default so the project runs with zero setup.
export const config = {
  dbPath: process.env.DB_PATH ?? "data/fleet.db",
  auditDbPath: process.env.AUDIT_DB_PATH ?? "data/audit.db", // agent-side approval audit log
  mcpPort: Number(process.env.MCP_PORT ?? 3001),
  agentPort: Number(process.env.AGENT_PORT ?? 3000),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  agentApiToken: process.env.AGENT_API_TOKEN ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
};
