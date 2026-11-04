import { describe, expect, it } from "vitest";
import type { RunResult } from "../src/agent/loop";
import { ReplayProvider } from "../src/llm/replay";
import type { LLMResponse } from "../src/llm/types";
import { buildJudgePrompt, judgeAnswer, parseVerdict } from "../evals/judge";

const result: RunResult = {
  runId: "r",
  answer: "D-17 is alerting: temperature high (peak 70.84).",
  stopReason: "completed",
  steps: 2,
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
  toolCalls: [{ name: "detect_anomalies", args: {}, status: "ok", output: '{"anomalies":[{"metric":"temperature","peak_value":70.84}]}' }],
};

const reply = (text: string): LLMResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } });
const judgeWith = (text: string) => new ReplayProvider({ description: "judge", model: "claude-opus-5-5", responses: [reply(text)] });

describe("LLM-as-judge", () => {
  it("puts question, evidence and answer in the prompt", () => {
    const prompt = buildJudgePrompt("Why is D-17 alerting?", result);
    expect(prompt).toContain("Why is D-17 alerting?");
    expect(prompt).toContain("[detect_anomalies -> ok]");
    expect(prompt).toContain("peak 70.84");
  });

  it("truncates very long evidence", () => {
    const big = { ...result, toolCalls: [{ ...result.toolCalls[0]!, output: "x".repeat(10_000) }] };
    expect(buildJudgePrompt("q", big)).toContain("[evidence truncated]");
  });

  it("parses a verdict even when wrapped in prose", async () => {
    const verdict = await judgeAnswer(judgeWith('Here you go: {"score": 5, "reason": "Grounded and correct."}'), "q", result);
    expect(verdict).toEqual({ score: 5, reason: "Grounded and correct." });
  });

  it("rejects malformed or out-of-range verdicts instead of guessing", () => {
    expect(parseVerdict("great answer!").score).toBeNull();
    expect(parseVerdict('{"score": 9, "reason": "x"}').score).toBeNull();
    expect(parseVerdict('{"score": "5"}').score).toBeNull();
    expect(parseVerdict("{not json}").score).toBeNull();
  });

  it("returns null when the judge call itself fails", async () => {
    const empty = new ReplayProvider({ description: "empty", model: "m", responses: [] });
    expect((await judgeAnswer(empty, "q", result)).reason).toMatch(/judge call failed/);
  });
});
