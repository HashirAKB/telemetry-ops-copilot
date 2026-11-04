# ADR 0002: Mock-first LLM providers behind one interface

**Status:** accepted

## Context
The build environment has no access to LLM APIs, and CI should never need an API key. Tests and evals must be deterministic. Yet the code must work with a real model.

## Decision
One interface, `LLMProvider.complete(request) -> response`, with three implementations:
- `MockProvider`: a rule-based planner that reads the conversation like a model would and returns Anthropic-shaped `tool_use` / `text` blocks. Default for tests, evals and the demo.
- `ReplayProvider` + `RecordingProvider`: play back recorded responses. Hand-written fixtures simulate a misbehaving model (prompt injection, invented tools, invalid arguments, infinite loop, refusal).
- `AnthropicProvider`: the official SDK, used only when `ANTHROPIC_API_KEY` is set.

The conversation format is the Anthropic Messages format, using the SDK's types, so the real provider needs no translation layer.

## Consequences
- Zero-key builds, tests, evals and demo; fully reproducible results.
- Mock eval scores measure the harness, not model intelligence. This is stated next to every results table.
- Guardrail tests do not depend on the mock being "well behaved": replay fixtures produce the bad behaviour on purpose.
- The Anthropic path is type-checked but has not been exercised live in this repo.
