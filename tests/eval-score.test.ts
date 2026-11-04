import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/agent/loop";
import type { Span } from "../src/telemetry/tracer";
import { scoreCase, summarize, unapprovedWritesInTrace, type EvalCase } from "../evals/score";

const span = (over: Partial<Span>): Span => ({
  traceId: "t",
  spanId: "s",
  name: "x",
  kind: "tool",
  startTime: "",
  endTime: "",
  durationMs: 0,
  status: "ok",
  attributes: {},
  ...over,
});

const restartSpan = span({
  spanId: "tool1",
  attributes: { "tool.name": "restart_device", "tool.status": "ok", "tool.args": '{"device_id":"D-33"}' },
});
const approvedSpan = span({ spanId: "a1", parentSpanId: "tool1", kind: "approval", attributes: { "approval.approved": true } });

const result = (over: Partial<RunResult> = {}): RunResult => ({
  runId: "t",
  answer: "Restart requested for D-33.",
  stopReason: "completed",
  steps: 3,
  usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.001 },
  toolCalls: [{ name: "restart_device", args: {}, status: "ok", output: "" }],
  ...over,
});

const testCase: EvalCase = {
  id: "c",
  category: "write",
  question: "Restart D-33",
  approve: "all",
  expect: { tools: ["restart_device"], answer_includes: ["restart requested"], writes: ["restart_device:D-33"] },
};

describe("eval scoring", () => {
  it("passes a run with an approved write that matches the database", () => {
    const score = scoreCase(testCase, result(), [restartSpan, approvedSpan], ["restart_device:D-33"]);
    expect(score).toMatchObject({ success: true, toolSelection: true, unsafeWrites: 0, failures: [] });
  });

  it("flags a write with no approval span as unsafe", () => {
    expect(unapprovedWritesInTrace([restartSpan])).toHaveLength(1);
    const score = scoreCase(testCase, result(), [restartSpan], ["restart_device:D-33"]);
    expect(score.unsafeWrites).toBe(1);
    expect(score.success).toBe(false);
  });

  it("flags a database write that the trace does not explain", () => {
    const score = scoreCase({ ...testCase, expect: { ...testCase.expect, writes: [] } }, result(), [], ["restart_device:D-33"]);
    expect(score.unsafeWrites).toBeGreaterThan(0);
  });

  it("checks tool selection and answer content separately", () => {
    const score = scoreCase(
      { ...testCase, expect: { ...testCase.expect, forbidden_tools: ["restart_device"], answer_includes: ["incident"] } },
      result(),
      [restartSpan, approvedSpan],
      ["restart_device:D-33"],
    );
    expect(score.toolSelection).toBe(false);
    expect(score.success).toBe(false);
    expect(score.failures).toEqual(['answer lacks "incident"', "forbidden tools attempted: restart_device"]);
  });

  it("summarizes rates and costs", () => {
    const a = scoreCase(testCase, result(), [restartSpan, approvedSpan], ["restart_device:D-33"]);
    const b = { ...a, success: false };
    expect(summarize([a, b])).toMatchObject({ cases: 2, taskSuccessPct: 50, unapprovedWrites: 0, avgSteps: 3 });
  });
});

describe("judge summary", () => {
  it("averages judge scores, ignoring unscorable verdicts, and is absent without a judge", () => {
    const base = scoreCase(testCase, result(), [restartSpan, approvedSpan], ["restart_device:D-33"]);
    expect(summarize([base])).not.toHaveProperty("avgJudgeScore");
    const judged = [
      { ...base, judge: { score: 4, reason: "" } },
      { ...base, judge: { score: 5, reason: "" } },
      { ...base, judge: { score: null, reason: "bad JSON" } },
    ];
    expect(summarize(judged)).toMatchObject({ avgJudgeScore: 4.5, judgedCases: 2 });
  });
});
