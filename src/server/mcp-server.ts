// The MCP server: exposes fleet tools, runbook resources and a prompt.
//
// It knows nothing about LLMs or approvals. Any MCP client (our agent,
// Claude Desktop, the MCP Inspector) can connect to it.
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DB } from "../data/db";
import {
  createIncident,
  detectDeviceAnomalies,
  detectFleetAnomalies,
  getMetrics,
  listDevices,
  restartDevice,
} from "../data/queries";
import { searchRunbooks, type Runbook } from "../data/runbooks";
import { TOOLS, type ToolName } from "../tools/definitions";

type Args<N extends ToolName> = z.infer<(typeof TOOLS)[N]["schema"]>;

/** Wrap a plain function result (or thrown error) as an MCP tool result. */
function toResult(run: () => unknown): CallToolResult {
  try {
    return { content: [{ type: "text", text: JSON.stringify(run()) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
  }
}

export interface McpServerOptions {
  /**
   * false = do not register write tools at all (a read-only deployment).
   * Defence in depth: even a host that skips human approval cannot call
   * tools that do not exist.
   */
  allowWrites?: boolean;
}

export function createMcpServer(db: DB, runbooks: Runbook[], options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "telemetry-ops", version: "0.1.0" });

  // Register a tool from the shared definitions. The SDK validates arguments
  // against the zod schema before our handler runs.
  function tool<N extends ToolName>(name: N, handler: (args: Args<N>) => unknown) {
    const def = TOOLS[name];
    server.registerTool(
      name,
      {
        description: def.description,
        inputSchema: def.schema,
        // Hints for MCP hosts. Hints are not security: our agent enforces
        // its own policy and never trusts these from a server.
        annotations: {
          readOnlyHint: def.access === "read",
          destructiveHint: name === "restart_device",
        },
      },
      // TypeScript cannot match the generic N against the SDK's overloads,
      // so we cast. Safe: the SDK parses args with def.schema first.
      ((args: Args<N>) => toResult(() => handler(args))) as never,
    );
  }

  tool("list_devices", (a) => listDevices(db, { site: a.site, batteryBelow: a.battery_below }));
  tool("get_metrics", (a) => getMetrics(db, a.device_id, a.window));
  tool("detect_anomalies", (a) => {
    const anomalies =
      a.target === "fleet"
        ? detectFleetAnomalies(db, a.method, a.window)
        : detectDeviceAnomalies(db, a.target, a.method, a.window);
    return { target: a.target, method: a.method, window: a.window, count: anomalies.length, anomalies };
  });
  tool("search_runbooks", (a) => ({ results: searchRunbooks(runbooks, a.query) }));
  if (options.allowWrites ?? true) {
    tool("create_incident", (a) => createIncident(db, a));
    tool("restart_device", (a) => restartDevice(db, a.device_id, a.reason));
  }

  // Resources: each runbook is readable at runbook://<slug>.
  server.registerResource(
    "runbook",
    new ResourceTemplate("runbook://{slug}", {
      list: () => ({
        resources: runbooks.map((rb) => ({ uri: `runbook://${rb.slug}`, name: rb.title, mimeType: "text/markdown" })),
      }),
    }),
    { description: "Operations runbooks (markdown)", mimeType: "text/markdown" },
    (uri, { slug }) => {
      const rb = runbooks.find((r) => r.slug === slug);
      if (!rb) throw new Error(`Unknown runbook "${String(slug)}"`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: rb.content }] };
    },
  );

  // Prompt template: a ready-made triage instruction for one device.
  server.registerPrompt(
    "triage_device",
    {
      description: "Investigate why a device is alerting and recommend actions.",
      argsSchema: { device_id: z.string().describe('Device id, e.g. "D-17"') },
    },
    ({ device_id }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Investigate device ${device_id}.`,
              `1. Call detect_anomalies with target "${device_id}".`,
              `2. Call get_metrics for the affected window to confirm the pattern.`,
              `3. Call search_runbooks for the anomalous metric and follow the runbook.`,
              `4. Explain the likely cause and recommend actions. Do not call write tools unless the operator asks.`,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}
