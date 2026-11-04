# ADR 0001: Hand-written agent loop, no agent framework

**Status:** accepted

## Context
The agent must plan, call tools, observe results and answer, with guardrails (allow-list, max steps, budget, argument validation, human approval) and tracing on every step. Frameworks such as LangChain or LangGraph provide loops, but hide the control flow behind abstractions. This project is also a study piece: the owner must be able to explain every line.

## Decision
Write the loop by hand in `src/agent/loop.ts` (about 200 lines). The LLM sits behind a small `LLMProvider` interface, tools are reached through a standard MCP client, and guardrails are plain functions in `src/agent/guardrails.ts`.

## Consequences
- Every guardrail is visible at the exact point where it applies; tests target them directly.
- No framework upgrades or lock-in; the only protocol dependency is MCP.
- We re-implement things a framework gives for free: retries, streaming, parallel tool execution, memory across conversations. None are needed for the spec; they are listed under "What I'd do next".
