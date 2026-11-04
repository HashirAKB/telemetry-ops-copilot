// Pick an LLM provider by name. "auto" uses the real API only if a key is set.
import { config } from "../config";
import { AnthropicProvider } from "./api-provider";
import { MockProvider } from "./mock";
import type { LLMProvider } from "./types";

export type ProviderName = "auto" | "mock" | "anthropic";

export function createProvider(name: ProviderName = "auto"): LLMProvider {
  if (name === "mock" || (name === "auto" && !config.anthropicApiKey)) return new MockProvider();
  if (!config.anthropicApiKey) throw new Error("The Anthropic provider (--provider anthropic or --judge) needs ANTHROPIC_API_KEY (see .env.example)");
  return new AnthropicProvider(config.anthropicModel, config.anthropicApiKey);
}
