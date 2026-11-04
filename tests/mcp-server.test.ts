// Integration tests: a real MCP Client talks to our server over in-memory,
// Streamable HTTP and stdio transports.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/data/db";
import { loadRunbooks } from "../src/data/runbooks";
import { seedDatabase } from "../src/data/seed";
import { createMcpHttpServer } from "../src/server/http";
import { createMcpServer } from "../src/server/mcp-server";
import { testDb } from "./helpers";

function text(result: unknown): string {
  return ((result as CallToolResult).content[0] as { text: string }).text;
}

let db: DB;
let client: Client;

beforeAll(async () => {
  db = testDb();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(db, loadRunbooks()).connect(serverSide);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
});

afterAll(() => client.close());

describe("MCP server over in-memory transport", () => {
  it("lists the six tools with write tools annotated", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_incident",
      "detect_anomalies",
      "get_metrics",
      "list_devices",
      "restart_device",
      "search_runbooks",
    ]);
    const restart = tools.find((t) => t.name === "restart_device")!;
    expect(restart.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(restart.inputSchema.required).toEqual(["device_id", "reason"]);
  });

  it("list_devices supports the battery filter", async () => {
    const result = await client.callTool({ name: "list_devices", arguments: { battery_below: 15 } });
    expect(JSON.parse(text(result)).map((d: { id: string }) => d.id)).toEqual(["D-05", "D-21", "D-46"]);
  });

  it("get_metrics applies the default window", async () => {
    const result = await client.callTool({ name: "get_metrics", arguments: { device_id: "D-17" } });
    expect(JSON.parse(text(result))).toMatchObject({ device_id: "D-17", window: "24h", points: 1440 });
  });

  it("detect_anomalies works for a device and for the fleet", async () => {
    const one = JSON.parse(text(await client.callTool({ name: "detect_anomalies", arguments: { target: "D-17" } })));
    expect(one.anomalies[0]).toMatchObject({ metric: "temperature", ongoing: true });
    const fleet = JSON.parse(
      text(await client.callTool({ name: "detect_anomalies", arguments: { target: "fleet", method: "ewma" } })),
    );
    expect(fleet.count).toBe(3);
  });

  it("search_runbooks returns ranked results", async () => {
    const result = JSON.parse(text(await client.callTool({ name: "search_runbooks", arguments: { query: "overheating" } })));
    expect(result.results[0].uri).toBe("runbook://overheating");
  });

  it("write tools change the database", async () => {
    const incident = await client.callTool({
      name: "create_incident",
      arguments: { device_id: "D-17", title: "Overheating", severity: "high", description: "Temp 70C" },
    });
    expect(JSON.parse(text(incident)).incident_id).toBe(1);
    await client.callTool({ name: "restart_device", arguments: { device_id: "D-33", reason: "radio lock-up" } });
    expect(db.prepare("SELECT status FROM devices WHERE id = 'D-33'").pluck().get()).toBe("restarting");
  });

  it("rejects invalid arguments with an error result", async () => {
    const result = await client.callTool({ name: "restart_device", arguments: { device_id: "all" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/D-17|reason/);
  });

  it("returns a domain error for unknown devices", async () => {
    const result = await client.callTool({ name: "get_metrics", arguments: { device_id: "D-99" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Unknown device/);
  });

  it("exposes runbooks as resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("runbook://battery-low");
    const read = await client.readResource({ uri: "runbook://battery-low" });
    expect((read.contents[0] as { text: string }).text).toMatch(/# Low battery/);
  });

  it("serves the triage_device prompt", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["triage_device"]);
    const prompt = await client.getPrompt({ name: "triage_device", arguments: { device_id: "D-17" } });
    expect((prompt.messages[0]!.content as { text: string }).text).toMatch(/Investigate device D-17/);
  });
});

describe("MCP server over Streamable HTTP", () => {
  it("serves tools to an HTTP client", async () => {
    const http = createMcpHttpServer(db, loadRunbooks());
    await new Promise<void>((resolve) => http.listen(0, resolve));
    const port = (http.address() as AddressInfo).port;
    const httpClient = new Client({ name: "http-test", version: "1.0.0" });
    try {
      await httpClient.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
      expect((await httpClient.listTools()).tools).toHaveLength(6);
      const result = await httpClient.callTool({ name: "detect_anomalies", arguments: { target: "D-33" } });
      expect(JSON.parse(text(result)).anomalies[0].metric).toBe("signal");
      const res = await fetch(`http://localhost:${port}/mcp`);
      expect(res.status).toBe(405);
    } finally {
      await httpClient.close();
      http.close();
    }
  });
});

describe("MCP server over stdio", () => {
  it("runs as a child process", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tocp-")), "fleet.db");
    const fileDb = openDb(dbPath);
    seedDatabase(fileDb, { days: 1, devices: 5 });
    fileDb.close();
    const stdioClient = new Client({ name: "stdio-test", version: "1.0.0" });
    await stdioClient.connect(
      new StdioClientTransport({
        command: "npx",
        args: ["tsx", "src/server/stdio.ts"],
        env: { ...process.env, DB_PATH: dbPath } as Record<string, string>,
        stderr: "ignore",
      }),
    );
    try {
      const result = await stdioClient.callTool({ name: "list_devices", arguments: {} });
      expect(JSON.parse(text(result))).toHaveLength(5);
    } finally {
      await stdioClient.close();
    }
  });
});
