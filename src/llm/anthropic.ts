// Real provider: the Anthropic Messages API via the official SDK.
// Used only when ANTHROPIC_API_KEY is set; never used by tests or CI.
import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, LLMRequest, LLMResponse } from "./types";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: request.system,
      // Our messages use the stable SDK types; the beta endpoint accepts the same shapes.
      messages: request.messages as Anthropic.Beta.BetaMessageParam[],
      tools: request.tools,
      // Thinking cannot be disabled on current models; effort controls depth and spend.
      output_config: { effort: "medium" },
      // If a safety classifier declines, let the API retry on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    return {
      // Pass every block back unchanged on the next turn (thinking blocks included).
      content: response.content as unknown as LLMResponse["content"],
      stopReason: response.stop_reason ?? "end_turn",
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}
