# Summary

## What was built

Telemetry Ops Copilot is an AI operations assistant for an IoT fleet, in TypeScript on Node 20+.

- **Synthetic fleet data:** a deterministic seed writes 50 devices × 7 days of per-minute metrics (504,000 rows) to SQLite, with known injected anomalies. There are also six markdown runbooks, one of them a deliberate prompt-injection test document.
- **MCP server** on the official `@modelcontextprotocol/sdk`, over stdio and Streamable HTTP:
  - six zod-validated tools (two write tools, one marked destructive)
  - runbooks exposed as resources
  - a `triage_device` prompt
  - setup steps for Claude Desktop
- **Agent:** a hand-written loop that acts as an MCP client. Its guardrails are:
  - a tool allow-list
  - argument validation using the server's own schemas
  - a step limit
  - a token and cost budget
  - human approval for every write, by CLI y/n or by HTTP approve/deny (with a deny-on-timeout fallback)
- **Observability:** OpenTelemetry-shaped spans for every run, LLM call, tool call and approval, written to JSONL and optionally exported as OTLP/HTTP JSON (`OTEL_EXPORTER_OTLP_ENDPOINT`). A static HTML viewer shows each run as a timeline, and the web page streams spans live over Server-Sent Events.
- **Evals:** 25 scenario cases covering diagnosis, fleet, battery, writes, runbooks and adversarial safety. They score task success, tool selection, unapproved writes, steps and cost. Results are committed, and CI re-runs them and fails on any unsafe write or stale results. An optional LLM-as-judge mode (`--judge`, real model only) adds an answer-quality score.
- **Hardening after the first release:** bearer-token auth on the agent API and the MCP HTTP endpoint, a read-only MCP mode without write tools, an SQLite approval audit log and run history (`data/agent.db`), BM25 runbook ranking with operator-vocabulary expansion.
- **Delivery:**
  - an HTTP API with a React chat and approval page
  - a Dockerfile
  - a GitHub Actions CI workflow (lint, typecheck, 88 tests, evals, Docker build, browser e2e), mirrored locally by `npm run check`
  - 5 ADRs, a decisions log and a study guide

## Mocked vs real

| Part | Status |
|---|---|
| MCP server, tools, resources, prompt, both transports | Real; integration-tested with the SDK client over in-memory, HTTP and stdio |
| SQLite data, anomaly detection, runbook search | Real code on synthetic data |
| Device restarts and incidents | Simulated: rows in SQLite, no real devices |
| LLM in tests, evals and demo | Mock: a deterministic rule-based planner that emits Anthropic-shaped responses |
| Misbehaving-model scenarios | Replay of hand-written fixtures |
| Anthropic API provider | Real code on the official SDK, type-checked; never run against the live API here because there was no network access to LLM APIs |
| Token counts and cost in mock mode | Estimates (characters / 4, priced as `claude-opus-5-5`) |
| Docker image | Dockerfile steps checked in a clean copy; the image itself was not built locally (Docker Hub rate limit), but the CI `docker` job builds it and runs the demo inside it, and that job passes |

## Known gaps

- Mock eval scores (100% success) measure the harness, not model reasoning. A real-model mode with an LLM-as-judge exists (`--provider anthropic --judge`) but has not been run, so no real-model results exist yet.
- The agent HTTP API has optional bearer-token auth (`AGENT_API_TOKEN`), runs waiting for approval are interrupted by a server restart (history is persisted). The MCP HTTP endpoint has optional token auth and a read-only mode, both off by default.
- The mock planner only understands a fixed set of intents.
- Runbook search is BM25 plus a small synonym table; there is no embedding-based semantic matching.
- Anomaly detection does not model seasonality beyond the small synthetic daily cycle.

## Resume bullets (honest)

- Built an MCP server in TypeScript with the official SDK that exposes six zod-validated fleet-operations tools, runbook resources and a prompt template over stdio and Streamable HTTP. It is integration-tested with the SDK client on all three transports and works with Claude Desktop.
- Hand-wrote an LLM agent loop (no LangChain or LangGraph) with a tool allow-list, schema validation, step and token/cost budgets, and human approval for every write action (CLI and HTTP, deny on timeout). Prompt-injection and malformed-call scenarios are tested with replayed model fixtures.
- Instrumented every LLM call, tool call and approval as OpenTelemetry-shaped spans in JSONL with a static timeline viewer. Built a 25-case eval harness that checks safety from trace spans and database rows, and gated CI on zero unapproved writes.
- Designed deterministic synthetic telemetry (504,000 rows) and robust anomaly detection (median/MAD z-score and EWMA, grouped into events). This fixed the masking that made a classic z-score miss a 3-hour overheating step, with no false positives on healthy devices.
