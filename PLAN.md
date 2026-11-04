# Plan

Tick each milestone when its success criterion (see SPEC.md section 7) passes and the commit is pushed.

- [x] M0 Scaffold: package, tsconfig, lint, vitest, CI, LICENSE, .env.example
- [x] M1 Synthetic data + runbooks + queries + anomaly detection
- [x] M2 MCP server (6 tools, resources, prompt, stdio + HTTP) + Claude Desktop docs
- [x] M3 LLM providers + agent loop + guardrails + CLI approval + demo
- [x] M4 Tracing (JSONL) + trace viewer + HTTP agent API with approve/deny
- [x] M5 Evals (25 cases, committed results) + Dockerfile + README, LEARNING, ADRs, SUMMARY
- [x] M6 React chat + approval page
- [x] Final skeptical review pass

## Follow-up items (README "What I'd do next")

- [x] 1. Bearer-token auth on the agent HTTP API
- [x] 2. Approval audit log in SQLite
- [x] 3. BM25 runbook ranking
- [x] 4. OTLP export of spans
- [x] 5. Real-model eval mode with LLM-as-judge (code + tests; not run live, no API access)

## Second round of next items (README)

- [ ] 1. Real-model eval run (blocked: needs ANTHROPIC_API_KEY; no LLM API access here)
- [x] 2. Persist runs in SQLite; mark runs cut off by a restart as interrupted
- [x] 3. MCP HTTP bearer token + read-only server mode
- [x] 4. Live run progress over Server-Sent Events

## Blockers

_None._
