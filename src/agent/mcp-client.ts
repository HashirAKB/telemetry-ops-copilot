// Ways for the agent to connect to the MCP server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DB } from "../data/db";
import { loadRunbooks } from "../data/runbooks";
import { createMcpServer } from "../server/mcp-server";

const CLIENT_INFO = { name: "telemetry-ops-agent", version: "0.1.0" };

/** Server and client in the same process (fast; used by tests, evals, demo). */
export async function connectInProcess(db: DB): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(db, loadRunbooks()).connect(serverSide);
  const client = new Client(CLIENT_INFO);
  await client.connect(clientSide);
  return client;
}

/** Spawn the server as a child process speaking stdio (like Claude Desktop does). */
export async function connectStdio(): Promise<Client> {
  const client = new Client(CLIENT_INFO);
  await client.connect(
    new StdioClientTransport({ command: "npx", args: ["tsx", "src/server/stdio.ts"], stderr: "ignore" }),
  );
  return client;
}

/** Connect to a running Streamable HTTP server, e.g. http://localhost:3001/mcp */
export async function connectHttp(url: string): Promise<Client> {
  const client = new Client(CLIENT_INFO);
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}
