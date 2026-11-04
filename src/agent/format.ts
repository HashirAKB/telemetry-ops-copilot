// Pretty-print a run for the terminal (CLI and demo).
import type { RunResult } from "./loop";

export function formatRun(question: string, result: RunResult): string {
  const lines = [`> ${question}`];
  for (const call of result.toolCalls) {
    const approval = call.approval ? ` [${call.approval.approved ? "approved" : "DENIED"} by ${call.approval.by}]` : "";
    lines.push(`  tool ${call.name}(${JSON.stringify(call.args)}) -> ${call.status}${approval}`);
  }
  lines.push("", result.answer, "");
  lines.push(
    `  stop=${result.stopReason} steps=${result.steps} tokens=${result.usage.inputTokens}+${result.usage.outputTokens} ` +
      `cost=USD ${result.usage.costUsd.toFixed(4)}`,
  );
  return lines.join("\n");
}
