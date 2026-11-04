// Agent loop tests. The MCP server runs in-process on a seeded in-memory DB.
// - MockProvider runs check the happy paths end to end.
// - ReplayProvider fixtures simulate a misbehaving model to test guardrails.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approveAll, denyAll, PolicyApprover } from "../src/agent/approval";
import { Budget, checkToolCall } from "../src/agent/guardrails";
import { runAgent } from "../src/agent/loop";
import { connectInProcess } from "../src/agent/mcp-client";
import type { DB } from "../src/data/db";
import { MockProvider } from "../src/llm/mock";
import { costUsd } from "../src/llm/pricing";
import { loadFixture, RecordingProvider, ReplayProvider } from "../src/llm/replay";
import { TOOL_NAMES } from "../src/tools/definitions";
import { testDb } from "./helpers";

let db: DB;
let mcp: Client;

beforeAll(async () => {
  db = testDb();
  mcp = await connectInProcess(db);
});
afterAll(() => mcp.close());

// Write tools change the DB; start every test from a clean slate.
beforeEach(() => {
  db.exec("DELETE FROM incidents; DELETE FROM device_events; UPDATE devices SET status = 'online';");
});

const restarts = () => db.prepare("SELECT COUNT(*) FROM device_events").pluck().get();
const incidents = () => db.prepare("SELECT COUNT(*) FROM incidents").pluck().get();
const replay = (name: string) => new ReplayProvider(loadFixture(`fixtures/${name}.json`));

describe("checkToolCall (guardrails)", () => {
  it("blocks unknown tools and tools outside the allow-list", () => {
    expect(checkToolCall("drop_tables", {}, TOOL_NAMES)).toMatchObject({ ok: false, status: "blocked" });
    expect(checkToolCall("restart_device", { device_id: "D-01", reason: "x y" }, ["list_devices"])).toMatchObject({
      ok: false,
      status: "blocked",
    });
  });

  it("rejects invalid arguments with a readable message", () => {
    const check = checkToolCall("restart_device", { device_id: "all" }, TOOL_NAMES);
    expect(check).toMatchObject({ ok: false, status: "invalid" });
    expect(!check.ok && check.message).toMatch(/device_id/);
  });

  it("requires approval for write tools only and applies schema defaults", () => {
    expect(checkToolCall("get_metrics", { device_id: "D-17" }, TOOL_NAMES)).toEqual({
      ok: true,
      tool: "get_metrics",
      args: { device_id: "D-17", window: "24h" },
      needsApproval: false,
    });
    expect(checkToolCall("create_incident", { device_id: "D-17", title: "Hot", severity: "high", description: "70C" }, TOOL_NAMES))
      .toMatchObject({ ok: true, needsApproval: true });
  });
});

describe("Budget", () => {
  it("tracks tokens and cost and reports when exceeded", () => {
    const budget = new Budget({ maxTokens: 1000, maxCostUsd: 1 }, "claude-opus-5-5");
    budget.add({ inputTokens: 500, outputTokens: 100 });
    expect(budget.costUsd).toBeCloseTo(costUsd("claude-opus-5-5", 500, 100));
    expect(budget.exceeded()).toBeNull();
    budget.add({ inputTokens: 400, outputTokens: 0 });
    expect(budget.exceeded()).toMatch(/token budget/);
  });
});

describe("runAgent with the MockProvider", () => {
  it("answers 'why is D-17 alerting?' with read-only tools", async () => {
    const approver = denyAll();
    const result = await runAgent("Why is D-17 alerting?", { provider: new MockProvider(), mcp, approver });
    expect(result.stopReason).toBe("completed");
    expect(result.toolCalls.map((c) => c.name)).toEqual(["detect_anomalies", "get_metrics", "search_runbooks"]);
    expect(result.answer).toMatch(/D-17 is alerting: temperature high/);
    expect(result.answer).toMatch(/Overheating/);
    expect(approver.requests).toHaveLength(0);
    expect(result.usage.costUsd).toBeGreaterThan(0);
  });

  it("executes an approved write", async () => {
    const result = await runAgent("Restart D-33, the signal is bad", { provider: new MockProvider(), mcp, approver: approveAll() });
    expect(result.toolCalls.at(-1)).toMatchObject({ name: "restart_device", status: "ok", approval: { approved: true } });
    expect(restarts()).toBe(1);
  });

  it("never executes a denied write and tells the user", async () => {
    const result = await runAgent("Restart D-33, the signal is bad", { provider: new MockProvider(), mcp, approver: denyAll() });
    expect(result.toolCalls.at(-1)).toMatchObject({ name: "restart_device", status: "denied" });
    expect(restarts()).toBe(0);
    expect(result.answer).toMatch(/NOT performed/);
  });

  it("asks for approval once per write, even with parallel calls", async () => {
    const approver = new PolicyApprover((r) => r.args.device_id !== "D-21"); // deny one of three
    await runAgent("Open incidents for devices with low battery", { provider: new MockProvider(), mcp, approver });
    expect(approver.requests.map((r) => r.args.device_id)).toEqual(["D-05", "D-21", "D-46"]);
    expect(incidents()).toBe(2);
  });

  it("follows the runbook and does not restart low-battery devices", async () => {
    const approver = approveAll();
    const result = await runAgent("Restart all devices with low battery", { provider: new MockProvider(), mcp, approver });
    expect(approver.requests).toHaveLength(0);
    expect(result.answer).toMatch(/did not restart/);
  });
});

describe("guardrails against a misbehaving model (replay fixtures)", () => {
  it("prompt injection: a write requested from tool output still needs approval, and denial blocks it", async () => {
    const approver = denyAll();
    const result = await runAgent("What does the TX-200 vendor bulletin say?", { provider: replay("prompt-injection"), mcp, approver });
    expect(approver.requests).toEqual([expect.objectContaining({ tool: "restart_device" })]);
    expect(result.toolCalls[1]).toMatchObject({ name: "restart_device", status: "denied" });
    expect(restarts()).toBe(0);
  });

  it("unknown tool: blocked by the allow-list", async () => {
    const result = await runAgent("Clean up", { provider: replay("unknown-tool"), mcp, approver: approveAll() });
    expect(result.toolCalls[0]).toMatchObject({ name: "delete_all_incidents", status: "blocked" });
    expect(result.stopReason).toBe("completed");
  });

  it("allow-list: a read-only agent cannot call write tools even if approved", async () => {
    const result = await runAgent("x", {
      provider: replay("prompt-injection"),
      mcp,
      approver: approveAll(),
      allowedTools: ["search_runbooks", "list_devices"],
    });
    expect(result.toolCalls[1]).toMatchObject({ name: "restart_device", status: "blocked" });
    expect(restarts()).toBe(0);
  });

  it("invalid arguments: rejected before the approver is even asked", async () => {
    const approver = approveAll();
    const result = await runAgent("Restart everything", { provider: replay("invalid-args"), mcp, approver });
    expect(result.toolCalls[0]!.status).toBe("invalid");
    expect(approver.requests).toHaveLength(0);
    expect(restarts()).toBe(0);
  });

  it("max steps: a model that never stops is cut off", async () => {
    const result = await runAgent("List devices", { provider: replay("never-stops"), mcp, approver: approveAll(), maxSteps: 3 });
    expect(result).toMatchObject({ stopReason: "max_steps", steps: 3 });
  });

  it("budget: the run stops when tokens run out", async () => {
    const result = await runAgent("List devices", {
      provider: replay("never-stops"),
      mcp,
      approver: approveAll(),
      budget: { maxTokens: 2500, maxCostUsd: 10 },
    });
    expect(result.stopReason).toBe("budget_exceeded");
    expect(result.steps).toBe(3); // 3 x 1,100 tokens crosses 2,500
  });

  it("budget: cost limit works too", async () => {
    const result = await runAgent("List devices", {
      provider: replay("never-stops"),
      mcp,
      approver: approveAll(),
      budget: { maxTokens: 1e9, maxCostUsd: 0.01 },
    });
    expect(result.stopReason).toBe("budget_exceeded");
    expect(result.usage.costUsd).toBeGreaterThanOrEqual(0.01);
  });

  it("refusal: stops cleanly", async () => {
    const result = await runAgent("x", { provider: replay("refusal"), mcp, approver: approveAll() });
    expect(result.stopReason).toBe("refusal");
  });
});

describe("record and replay", () => {
  it("replaying a recorded run reproduces the same tool calls and answer", async () => {
    const recorder = new RecordingProvider(new MockProvider());
    const original = await runAgent("Why is D-17 alerting?", { provider: recorder, mcp, approver: denyAll() });
    const replayed = await runAgent("Why is D-17 alerting?", {
      provider: new ReplayProvider({ description: "recorded", model: recorder.model, responses: recorder.responses }),
      mcp,
      approver: denyAll(),
    });
    expect(replayed.answer).toBe(original.answer);
    expect(replayed.toolCalls).toEqual(original.toolCalls);
  });
});

describe("truncated responses", () => {
  it("does not treat a max_tokens cut-off as a final answer", async () => {
    const provider = new ReplayProvider({
      description: "truncated",
      model: "claude-opus-5-5",
      responses: [{ content: [{ type: "text", text: "D-17 is overh" }], stopReason: "max_tokens", usage: { inputTokens: 10, outputTokens: 10 } }],
    });
    const result = await runAgent("Why is D-17 alerting?", { provider, mcp, approver: denyAll() });
    expect(result.stopReason).toBe("error");
  });
});
