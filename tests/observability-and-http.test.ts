import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveAll, PolicyApprover } from "../src/agent/approval";
import { createAgentApi, isAuthorized } from "../src/agent/http-api";
import { HttpApprover } from "../src/agent/http-approver";
import { runAgent } from "../src/agent/loop";
import { connectInProcess } from "../src/agent/mcp-client";
import type { DB } from "../src/data/db";
import { MockProvider } from "../src/llm/mock";
import { jsonlSink, memorySink, Tracer, type Span } from "../src/telemetry/tracer";
import { testDb } from "./helpers";

let db: DB;
let mcp: Client;
beforeAll(async () => {
  db = testDb();
  mcp = await connectInProcess(db);
});
afterAll(() => mcp.close());

describe("tracing", () => {
  it("records a tree of agent, llm, tool and approval spans", async () => {
    const spans: Span[] = [];
    const approver = new PolicyApprover((r) => r.tool === "create_incident");
    const result = await runAgent("Open an incident for D-17 and restart it", {
      provider: new MockProvider(),
      mcp,
      approver,
      tracer: new Tracer(memorySink(spans)),
    });

    const root = spans.find((s) => s.kind === "agent")!;
    expect(root.traceId).toBe(result.runId);
    expect(root.parentSpanId).toBeUndefined();
    expect(root.attributes).toMatchObject({ "agent.stop_reason": "completed", "agent.steps": result.steps });
    expect(spans.every((s) => s.traceId === result.runId)).toBe(true);

    const llm = spans.filter((s) => s.kind === "llm");
    expect(llm).toHaveLength(result.steps);
    expect(llm.every((s) => s.parentSpanId === root.spanId)).toBe(true);
    expect(llm[0]!.attributes["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);

    const tools = spans.filter((s) => s.kind === "tool");
    expect(tools.map((s) => s.name)).toEqual([
      "tool.detect_anomalies",
      "tool.get_metrics",
      "tool.search_runbooks",
      "tool.create_incident",
      "tool.restart_device",
    ]);

    // Approval spans are children of the write tool spans.
    const approvals = spans.filter((s) => s.kind === "approval");
    expect(approvals.map((a) => a.attributes["approval.approved"])).toEqual([true, false]);
    expect(approvals[1]!.parentSpanId).toBe(tools[4]!.spanId);
    expect(tools[4]!.status).toBe("error"); // denied
  });

  it("writes one JSONL file per run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traces-"));
    const result = await runAgent("Why is D-17 alerting?", {
      provider: new MockProvider(),
      mcp,
      approver: approveAll(),
      tracer: new Tracer(jsonlSink(dir)),
    });
    const lines = readFileSync(join(dir, `${result.runId}.jsonl`), "utf8").trim().split("\n");
    expect(lines.length).toBe(1 + result.steps + result.toolCalls.length);
    expect(JSON.parse(lines.at(-1)!).name).toBe("agent.run"); // the root ends last
  });
});

describe("agent HTTP API with approve/deny", () => {
  it("runs a chat, waits for approvals over HTTP, then finishes", async () => {
    const traceDir = mkdtempSync(join(tmpdir(), "traces-"));
    const server = createAgentApi({ mcp, createProvider: () => new MockProvider(), traceDir, approver: new HttpApprover() });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) =>
      fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const get = async (path: string) => (await fetch(base + path)).json();
    const waitFor = async <T>(fn: () => Promise<T | undefined>): Promise<T> => {
      for (let i = 0; i < 100; i++) {
        const value = await fn();
        if (value !== undefined) return value;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("timed out");
    };

    try {
      db.exec("DELETE FROM incidents; DELETE FROM device_events;");
      expect((await post("/api/chat", { message: "" })).status).toBe(400);

      const start = await post("/api/chat", { message: "Open an incident for D-17 and restart it" });
      expect(start.status).toBe(202);
      const { runId } = await start.json();

      // First write: create_incident -> approve.
      const first = await waitFor(async () => (await get("/api/approvals"))[0]);
      expect(first).toMatchObject({ tool: "create_incident", runId });
      expect((await post(`/api/approvals/${first.id}`, { approved: true })).status).toBe(200);
      expect((await post(`/api/approvals/${first.id}`, { approved: true })).status).toBe(404); // already decided

      // Second write: restart_device -> deny.
      const second = await waitFor(async () => (await get("/api/approvals")).find((a: { tool: string }) => a.tool === "restart_device"));
      expect((await post(`/api/approvals/${second.id}`, { approved: "yes" })).status).toBe(400);
      expect((await post(`/api/approvals/${second.id}`, { approved: false })).status).toBe(200);

      const run = await waitFor(async () => {
        const state = await get(`/api/runs/${runId}`);
        return state.status === "done" ? state : undefined;
      });
      expect(run.result.toolCalls.map((c: { status: string }) => c.status).slice(-2)).toEqual(["ok", "denied"]);
      expect(db.prepare("SELECT COUNT(*) FROM incidents").pluck().get()).toBe(1);
      expect(db.prepare("SELECT COUNT(*) FROM device_events").pluck().get()).toBe(0);

      const trace = await (await fetch(`${base}/api/traces/${runId}`)).text();
      expect(trace.trim().split("\n").length).toBeGreaterThan(5);
      expect((await fetch(`${base}/viewer`)).status).toBe(200);
      expect((await fetch(`${base}/api/runs/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("denies automatically when nobody answers in time", async () => {
    const approver = new HttpApprover(30);
    const decision = await approver.approve({ runId: "r", tool: "restart_device", args: {} });
    expect(decision).toEqual({ approved: false, by: "timeout" });
    expect(approver.list()).toEqual([]);
  });
});

describe("agent HTTP API authentication", () => {
  it("requires the bearer token on /api/* when configured, but serves static pages", async () => {
    const traceDir = mkdtempSync(join(tmpdir(), "traces-"));
    const server = createAgentApi({ mcp, createProvider: () => new MockProvider(), traceDir, apiToken: "s3cret" });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/api/approvals`)).status).toBe(401);
      expect((await fetch(`${base}/api/approvals`, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
      const chat = await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ message: "Restart D-33" }) });
      expect(chat.status).toBe(401);
      expect((await fetch(`${base}/api/approvals`, { headers: { Authorization: "Bearer s3cret" } })).status).toBe(200);
      expect((await fetch(`${base}/viewer`)).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("isAuthorized compares the whole header", () => {
    expect(isAuthorized("Bearer abc", "abc")).toBe(true);
    expect(isAuthorized("Bearer abcd", "abc")).toBe(false);
    expect(isAuthorized(undefined, "abc")).toBe(false);
  });
});
