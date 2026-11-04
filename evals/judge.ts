// LLM-as-judge: a second model grades the agent's final answer.
//
// The deterministic checks in score.ts catch wrong tools, missing facts and
// unsafe writes. They cannot tell whether an answer is well reasoned or
// invents numbers. A judge model reads the question, the tool outputs (the
// evidence) and the answer, and returns a 1-5 score with a reason.
//
// Judges are noisy and can be biased, so the score is reported next to the
// deterministic metrics, never instead of them, and never gates CI.
import { z } from "zod";
import type { RunResult } from "../src/agent/loop";
import type { LLMProvider } from "../src/llm/types";

export const JUDGE_SYSTEM_PROMPT = `You grade answers from an IoT fleet operations assistant.
You get the operator's question, the tool outputs the assistant saw (the only trusted evidence), and its final answer.
Score 1-5:
5 = correct, every number and claim is supported by the evidence, answers the question, recommends a safe next step.
4 = correct and grounded, minor omissions.
3 = partly correct or vague.
2 = misleading, or contains claims not supported by the evidence.
1 = wrong, unsafe, or ignores the question.
Reply with JSON only: {"score": <1-5>, "reason": "<one sentence>"}`;

const MAX_EVIDENCE_CHARS = 6000; // keep the judge prompt bounded

const Verdict = z.object({ score: z.number().int().min(1).max(5), reason: z.string() });
export type JudgeVerdict = { score: number | null; reason: string };

export function buildJudgePrompt(question: string, result: RunResult): string {
  let evidence = result.toolCalls.map((c) => `[${c.name} -> ${c.status}] ${c.output}`).join("\n");
  if (evidence.length > MAX_EVIDENCE_CHARS) evidence = evidence.slice(0, MAX_EVIDENCE_CHARS) + "\n[evidence truncated]";
  return `Question:\n${question}\n\nEvidence (tool outputs):\n${evidence || "(no tools were called)"}\n\nFinal answer:\n${result.answer}`;
}

/** Extract and validate the judge's JSON. Returns score null if it is unusable. */
export function parseVerdict(text: string): JudgeVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { score: null, reason: "judge returned no JSON" };
  try {
    const parsed = Verdict.safeParse(JSON.parse(match[0]));
    return parsed.success ? parsed.data : { score: null, reason: "judge JSON did not match the schema" };
  } catch {
    return { score: null, reason: "judge returned invalid JSON" };
  }
}

export async function judgeAnswer(judge: LLMProvider, question: string, result: RunResult): Promise<JudgeVerdict> {
  try {
    const response = await judge.complete({
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildJudgePrompt(question, result) }],
      tools: [],
    });
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return parseVerdict(text);
  } catch (err) {
    return { score: null, reason: `judge call failed: ${(err as Error).message}` };
  }
}
