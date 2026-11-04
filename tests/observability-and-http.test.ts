import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveAll, PolicyApprover } from "../src/agent/approval";
import { openAgentDb } from "../src/agent/agent-db";
import { AuditLog } from "../src/agent/audit";
import { createAgentApi } from "../src/agent/http-api";
import { isAuthorized } from "../src/server/http";
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
    const audit = new AuditLog(openAgentDb(":memory:"));
    const server = createAgentApi({ mcp, createProvider: () => new MockProvider(), traceDir, approver: new HttpApprover(), audit });
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

      const log = await get("/api/audit");
      expect(log.map((e: { tool: string; approved: number; decided_by: string }) => [e.tool, e.approved, e.decided_by])).toEqual([
        ["restart_device", 0, "http"],
        ["create_incident", 1, "http"],
      ]);
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

describe("live run progress (Server-Sent Events)", () => {
  it("streams spans as they finish, then a done event after the result is saved", async () => {
    const traceDir = mkdtempSync(join(tmpdir(), "traces-"));
    const approver = new HttpApprover();
    const server = createAgentApi({ mcp, createProvider: () => new MockProvider(), traceDir, approver });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    try {
      const { runId } = await (await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ message: "Restart D-33" }) })).json();
      const stream = await fetch(`${base}/api/runs/${runId}/events`);
      expect(stream.headers.get("content-type")).toBe("text/event-stream");

      // Deny the restart once it is requested, while the stream is open.
      const deny = (async () => {
        for (let i = 0; i < 200 && approver.list().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
        approver.settle(approver.list()[0]!.id, { approved: false, by: "test" });
      })();

      const text = await stream.text(); // resolves when the server closes the stream
      await deny;
      const events = text.trim().split("\n\n").map((block) => {
        const [eventLine, dataLine] = block.split("\n");
        return { event: eventLine!.slice("event: ".length), data: JSON.parse(dataLine!.slice("data: ".length)) };
      });
      const names = events.filter((e) => e.event === "span").map((e) => e.data.name);
      expect(names).toContain("llm.complete");
      expect(names).toContain("approval");
      expect(names.at(-1)).toBe("agent.run");
      expect(events.at(-1)!.event).toBe("done");

      // After "done" the saved result is available immediately.
      expect((await (await fetch(`${base}/api/runs/${runId}`)).json()).status).toBe("done");
      // A finished run's stream closes at once; unknown runs are 404.
      expect(await (await fetch(`${base}/api/runs/${runId}/events`)).text()).toContain("event: done");
      expect((await fetch(`${base}/api/runs/nope/events`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
