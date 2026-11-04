// Tool definitions shared by the MCP server and the agent.
//
// The server uses the zod schemas to validate incoming arguments. The agent
// uses the *same* schemas to validate arguments before it even asks a human
// for approval (defense in depth), and uses `access` to decide which tools
// need approval. Keeping one source of truth avoids the two drifting apart.
import { z } from "zod";

const DeviceId = z.string().regex(/^D-\d{2}$/, 'device ids look like "D-17"');
const Window = z.enum(["1h", "6h", "24h", "7d"]);

export const TOOLS = {
  list_devices: {
    access: "read",
    description:
      "List fleet devices with their latest temperature, vibration, battery and signal. Optional filters: site, battery_below (percent).",
    schema: z.object({
      site: z.string().optional().describe("Only devices at this site, e.g. plant-a"),
      battery_below: z.number().min(0).max(100).optional().describe("Only devices with battery below this percent"),
    }),
  },
  get_metrics: {
    access: "read",
    description:
      "Summary (min/max/avg/latest) and a downsampled series of all metrics for one device over a time window.",
    schema: z.object({
      device_id: DeviceId,
      window: Window.default("24h"),
    }),
  },
  detect_anomalies: {
    access: "read",
    description:
      'Detect anomalies for one device (target "D-17") or the whole fleet (target "fleet"). method "zscore" catches spikes and steps, "ewma" catches slow drifts.',
    schema: z.object({
      target: z.union([DeviceId, z.literal("fleet")]),
      method: z.enum(["zscore", "ewma"]).default("zscore"),
      window: Window.default("24h"),
    }),
  },
  search_runbooks: {
    access: "read",
    description: "Keyword search over operations runbooks. Returns the best matches (full text) and a runbook:// URI.",
    schema: z.object({ query: z.string().min(2).max(200) }),
  },
  create_incident: {
    access: "write",
    description: "WRITE: open an incident ticket for a device. Requires human approval.",
    schema: z.object({
      device_id: DeviceId,
      title: z.string().min(3).max(120),
      severity: z.enum(["low", "medium", "high", "critical"]),
      description: z.string().min(3).max(2000),
    }),
  },
  restart_device: {
    access: "write",
    description: "WRITE, DESTRUCTIVE: remotely power-cycle a device (about 2 minutes of downtime). Requires human approval.",
    schema: z.object({
      device_id: DeviceId,
      reason: z.string().min(3).max(500),
    }),
  },
} as const;

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOLS, name);
}
