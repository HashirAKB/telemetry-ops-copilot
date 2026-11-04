// The provider interface: the only thing the agent loop knows about LLMs.
//
// Our conversation format *is* the Anthropic Messages API format (we reuse
// the SDK's types). The real provider sends it unchanged, which also means
// any blocks the model returns (including thinking blocks) are passed back
// exactly as received. The mock and replay providers produce the same shape.
import type Anthropic from "@anthropic-ai/sdk";

export type Message = Anthropic.MessageParam;
export type ContentBlock = Anthropic.ContentBlockParam;
export type ToolUseBlock = Anthropic.ToolUseBlockParam;
export type ToolResultBlock = Anthropic.ToolResultBlockParam;

/** A tool as advertised to the model: name, description, JSON schema. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
}

export interface LLMRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  content: ContentBlock[];
  /** "end_turn" | "tool_use" | "max_tokens" | "refusal" | ... */
  stopReason: string;
  usage: Usage;
}

export interface LLMProvider {
  name: string; // "mock" | "replay" | "anthropic"
  model: string; // model id used for pricing
  complete(request: LLMRequest): Promise<LLMResponse>;
}

/** Rough token estimate (~4 characters per token) for providers without real usage data. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}
