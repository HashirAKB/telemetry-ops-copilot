// Central place for configuration read from environment variables.
// Every value has a safe local default so the project runs with zero setup.
export const config = {
  dbPath: process.env.DB_PATH ?? "data/fleet.db",
  mcpPort: Number(process.env.MCP_PORT ?? 3001),
  agentPort: Number(process.env.AGENT_PORT ?? 3000),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
};
