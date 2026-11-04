// USD per million tokens (Anthropic first-party list prices).
// The mock provider is priced as if it were the default model, so the cost
// numbers in evals show what a run *would* cost with the same token counts.
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export const DEFAULT_PRICED_MODEL = "claude-opus-5-5";

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model] ?? PRICES[DEFAULT_PRICED_MODEL]!;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
