import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openAgentDb } from "../src/agent/agent-db";
import { createAgentApi } from "../src/agent/http-api";
import type { RunResult } from "../src/agent/loop";
import { connectInProcess } from "../src/agent/mcp-client";
import { RunStore } from "../src/agent/run-store";
import { MockProvider } from "../src/llm/mock";
import { testDb } from "./helpers";

const fakeResult = { runId: "r1", answer: "ok", stopReason: "completed", steps: 1, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, toolCalls: [] } as RunResult;

describe("RunStore", () => {
  it("stores a run from start to finish", () => {
    const store = new RunStore(openAgentDb(":memory:"));
    store.create("r1", "Why is D-17 alerting?");
    expect(store.get("r1")).toEqual({ id: "r1", question: "Why is D-17 alerting?", status: "running" });
    store.finish("r1", { result: fakeResult });
    expect(store.get("r1")).toMatchObject({ status: "done", result: { answer: "ok" } });
    expect(store.get("missing")).toBeUndefined();
  });

  it("records errors", () => {
    const store = new RunStore(openAgentDb(":memory:"));
    store.create("r2", "q");
    store.finish("r2", { error: "boom" });
    expect(store.get("r2")).toMatchObject({ status: "done", error: "boom" });
  });
});

describe("runs across a server restart", () => {
  let mcp: Client;
  beforeAll(async () => {
    mcp = await connectInProcess(testDb());
  });
  afterAll(() => mcp.close());

  it("keeps finished runs and marks runs that were waiting for approval as interrupted", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "agentdb-")), "agent.db");
    const traceDir = mkdtempSync(join(tmpdir(), "traces-"));

    // "Before the restart": one run finishes, one blocks on an approval nobody gives.
    const before = createAgentApi({ mcp, createProvider: () => new MockProvider(), traceDir, runs: new RunStore(openAgentDb(dbPath)) });
    await new Promise<void>((resolve) => before.listen(0, resolve));
    const base = `http://localhost:${(before.address() as AddressInfo).port}`;
    const start = async (message: string) =>
      (await (await fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ message }) })).json()).runId as string;
    const finished = await start("Why is D-17 alerting?");
    const blocked = await start("Restart D-33");
    for (let i = 0; i < 100; i++) {
      const [a, pending] = [await (await fetch(`${base}/api/runs/${finished}`)).json(), await (await fetch(`${base}/api/approvals`)).json()];
      if (a.status === "done" && pending.length === 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    before.close();

    // "After the restart": a new store on the same file.
    const store = new RunStore(openAgentDb(dbPath));
    expect(store.markInterrupted()).toBe(1);
    expect(store.get(finished)).toMatchObject({ status: "done", result: { stopReason: "completed" } });
    expect(store.get(blocked)).toMatchObject({ status: "interrupted", error: expect.stringMatching(/restarted/) });
  });
});
