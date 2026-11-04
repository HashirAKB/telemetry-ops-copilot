# Using the MCP server from Claude Desktop

The MCP server is a normal MCP server, so any MCP host can use it. These steps are for Claude Desktop.

## 1. Prepare the data

```bash
npm install
```

```bash
npm run seed
```

## 2. Register the server

Open Claude Desktop, go to **Settings > Developer > Edit Config**. This opens `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the server (use absolute paths):

```json
{
  "mcpServers": {
    "telemetry-ops": {
      "command": "npx",
      "args": ["tsx", "/ABSOLUTE/PATH/telemetry-ops-copilot/src/server/stdio.ts"],
      "env": { "DB_PATH": "/ABSOLUTE/PATH/telemetry-ops-copilot/data/fleet.db" }
    }
  }
}
```

Restart Claude Desktop. The tools icon should list six tools.

## 3. Try it

- "Which devices in my fleet have anomalies right now?"
- "Why is D-17 alerting? Check the runbooks."
- Use the **triage_device** prompt from the prompt picker and enter `D-17`.
- Attach a runbook resource such as `runbook://overheating` to the conversation.

`create_incident` and `restart_device` are write tools. Claude Desktop asks you before every tool call; the tool annotations mark `restart_device` as destructive. Our own agent (see `src/agent`) does not rely on those hints: it has its own approval gate.

## Remote / HTTP clients

```bash
npm run mcp:http
```

The server listens on `http://localhost:3001/mcp` (Streamable HTTP, stateless). You can inspect it with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

Choose transport "Streamable HTTP" and URL `http://localhost:3001/mcp`.

## Hardening

- `MCP_READ_ONLY=1` (in the `env` block above, or for `npm run mcp:http`) removes `create_incident` and `restart_device` from the server entirely. Use it when a host should only investigate.
- `MCP_API_TOKEN=<secret>` makes the HTTP endpoint require `Authorization: Bearer <secret>`. The agent sends it automatically with `--transport http`.

## Troubleshooting

- "Database has no metrics": run `npm run seed`, and check `DB_PATH` is absolute.
- Nothing appears: check Claude Desktop's MCP logs (`~/Library/Logs/Claude/mcp*.log` on macOS). The server logs to stderr only, because stdout carries the protocol.
