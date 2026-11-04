// The agent loop. No framework: this file is the whole "agent".
//
//   question -> [LLM decides] -> tool calls -> [guardrails] -> [approval]
//            -> MCP server -> results -> back to the LLM -> ... -> answer
//
// The loop ends when the model answers without calling tools, or when a
// guardrail stops it (max steps, budget, refusal).
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { TOOL_NAMES, type ToolName } from "../tools/definitions";
import type { LLMProvider, Message, ToolResultBlock, ToolSpec, ToolUseBlock } from "../llm/types";
import type { Approver } from "./approval";
import { Budget, checkToolCall, DEFAULT_BUDGET, type BudgetLimits } from "./guardrails";
import { SYSTEM_PROMPT } from "./prompt";

export interface AgentOptions {
  provider: LLMProvider;
  mcp: Client;
  approver: Approver;
  allowedTools?: readonly ToolName[]; // default: all six
  maxSteps?: number; // max LLM calls per run
  budget?: BudgetLimits;
}

export type ToolCallStatus = "ok" | "error" | "blocked" | "invalid" | "denied";

export interface ToolCallRecord {
  name: string;
  args: unknown;
  status: ToolCallStatus;
  approval?: { approved: boolean; by: string };
  output: string;
}

export interface RunResult {
  runId: string;
  answer: string;
  stopReason: "completed" | "max_steps" | "budget_exceeded" | "refusal" | "error";
  steps: number; // LLM calls made
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  toolCalls: ToolCallRecord[];
}

export async function runAgent(question: string, options: AgentOptions): Promise<RunResult> {
  const { provider, mcp, approver } = options;
  const allowed = options.allowedTools ?? TOOL_NAMES;
  const maxSteps = options.maxSteps ?? 8;
  const budget = new Budget(options.budget ?? DEFAULT_BUDGET, provider.model);
  const runId = randomUUID();

  // Only advertise allowed tools to the model. The allow-list is enforced
  // again when the model calls a tool, in case it invents a name.
  const { tools: mcpTools } = await mcp.listTools();
  const tools: ToolSpec[] = mcpTools
    .filter((t) => (allowed as readonly string[]).includes(t.name))
    .map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema }));

  const messages: Message[] = [{ role: "user", content: question }];
  const toolCalls: ToolCallRecord[] = [];
  let steps = 0;

  const finish = (stopReason: RunResult["stopReason"], answer: string): RunResult => ({
    runId,
    answer,
    stopReason,
    steps,
    usage: { inputTokens: budget.inputTokens, outputTokens: budget.outputTokens, costUsd: budget.costUsd },
    toolCalls,
  });

  while (steps < maxSteps) {
    const overBudget = budget.exceeded();
    if (overBudget) return finish("budget_exceeded", `Stopped: ${overBudget}.`);

    steps++;
    let response;
    try {
      response = await provider.complete({ system: SYSTEM_PROMPT, messages, tools });
    } catch (err) {
      return finish("error", `LLM call failed: ${(err as Error).message}`);
    }
    budget.add(response.usage);
    messages.push({ role: "assistant", content: response.content });

    if (response.stopReason === "refusal") return finish("refusal", "The model declined this request.");

    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      const text = response.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      return finish("completed", text);
    }

    // Run every requested tool call (in order) and send all results back in
    // ONE user message, as the Messages API expects.
    const results: ToolResultBlock[] = [];
    for (const use of toolUses) {
      const record = await executeToolCall(use, { mcp, approver, allowed, runId });
      toolCalls.push(record);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: record.output,
        is_error: record.status !== "ok",
      });
    }
    messages.push({ role: "user", content: results });
  }
  return finish("max_steps", `Stopped after ${maxSteps} steps without a final answer.`);
}

/** Guardrails, then approval (for writes), then the actual MCP call. */
async function executeToolCall(
  use: ToolUseBlock,
  ctx: { mcp: Client; approver: Approver; allowed: readonly ToolName[]; runId: string },
): Promise<ToolCallRecord> {
  const check = checkToolCall(use.name, use.input, ctx.allowed);
  if (!check.ok) return { name: use.name, args: use.input, status: check.status, output: check.message };

  let approval: ToolCallRecord["approval"];
  if (check.needsApproval) {
    const decision = await ctx.approver.approve({ runId: ctx.runId, tool: check.tool, args: check.args });
    approval = { approved: decision.approved, by: decision.by };
    if (!decision.approved) {
      return {
        name: use.name,
        args: check.args,
        status: "denied",
        approval,
        output: `Denied by the operator (${decision.by}). The action was not performed. Do not retry it.`,
      };
    }
  }

  try {
    const result = (await ctx.mcp.callTool({ name: check.tool, arguments: check.args })) as CallToolResult;
    const output = result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
    return { name: use.name, args: check.args, status: result.isError ? "error" : "ok", approval, output };
  } catch (err) {
    return { name: use.name, args: check.args, status: "error", approval, output: (err as Error).message };
  }
}
