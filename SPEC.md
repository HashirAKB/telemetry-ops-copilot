# Telemetry Ops Copilot: Specification

## 1. Goal

Build an AI operations assistant for an IoT device fleet that a learning engineer can read end to end and defend in an interview. It answers questions such as "why is device D-17 alerting?" by calling real tools over the Model Context Protocol (MCP), and it can take actions (open an incident, restart a device) only after a human approves them.

It complements [edge-telemetry-platform](https://github.com/HashirAKB/edge-telemetry-platform) (AWS IoT Core / SiteWise ingestion). This repo runs fully locally: SQLite instead of SiteWise, a mock LLM instead of a paid API.

## 2. Scope

1. **Synthetic fleet data**: seed script creates ~50 devices and 7 days of per-minute metrics (temperature, vibration, battery, signal) in SQLite with deterministic, injected anomalies. A handful of markdown runbooks.
2. **MCP server** (official `@modelcontextprotocol/sdk`), stdio and Streamable HTTP transports:
   - Tools (zod-validated): `list_devices`, `get_metrics`, `detect_anomalies` (z-score or EWMA, one device or whole fleet), `search_runbooks`, `create_incident` (WRITE), `restart_device` (WRITE, destructive).
   - Runbooks exposed as MCP resources (`runbook://<slug>`), one prompt template (`triage_device`).
   - Docs for plugging it into Claude Desktop.
3. **Agent**: hand-written loop acting as an MCP client: send context to the LLM, execute requested tool calls, feed results back, stop on a final answer. Guardrails:
   - tool allow-list
   - max steps
   - per-run token and cost budget
   - argument validation before any call
   - human-in-the-loop approval for every WRITE tool (CLI y/n prompt and an HTTP approve/deny endpoint)
4. **LLM providers** behind one interface:
   - `MockProvider`: deterministic, rule-based, default everywhere (tests, evals, demo).
   - `ReplayProvider`: replays recorded LLM responses from `fixtures/`; used by tests to simulate a misbehaving model.
   - `AnthropicProvider`: real Messages API via the official SDK, used only when `ANTHROPIC_API_KEY` is set.
5. **Observability**: OpenTelemetry-shaped spans (trace id, span id, parent id, timings, attributes) for every agent run, LLM call, approval and tool call, written to JSONL. A static HTML viewer renders a run as a timeline.
6. **Evals**: 25 scenario cases scored on task success, tool selection, safety (zero unapproved writes), steps and cost. Results committed as JSON and a markdown table.
7. **Stretch (last milestone)**: small React page to chat with the agent and approve pending actions.

## 3. Non-goals

- Real device connectivity, MQTT, AWS. Restarts are simulated (an event row in SQLite).
- Authentication / multi-tenancy for the HTTP endpoints (local use only; called out as a limitation).
- Vector search / embeddings for runbooks (keyword scoring is enough for 5 to 6 documents).
- Agent frameworks (LangChain, LangGraph). The loop is hand-written on purpose.
- Streaming token output.
- Production-grade time-series storage.

## 4. Architecture

```
            +-------------------------+
 user  ---> |  CLI / HTTP API / React | ----- approve / deny ----+
            +-----------+-------------+                          |
                        |                                        v
            +-----------v-------------+    +-------------------------+
            |   Agent loop (client)   |--->|  Approver (CLI | HTTP |  |
            |  guardrails + budget    |    |  scripted for evals)     |
            +---+---------------+-----+    +-------------------------+
                |               |
       LLMProvider        MCP Client ---- stdio | Streamable HTTP | in-memory
   (Mock|Replay|Anthropic)      |
                |      +--------v---------+      +-----------+
                |      |    MCP server    |----->|  SQLite   |
                |      | tools/resources/ |      | metrics,  |
                |      | prompt           |      | incidents |
                |      +------------------+      +-----------+
                v
          Tracer -> traces/<run>.jsonl -> viewer/index.html
```

Source layout (planned):

```
src/
  data/       db.ts (schema, open), seed.ts, queries.ts, anomalies.ts, runbooks.ts
  server/     mcp-server.ts (tools/resources/prompt), stdio.ts, http.ts
  agent/      loop.ts, guardrails.ts, approval.ts, cli.ts, http-api.ts
  llm/        types.ts, mock.ts, replay.ts, anthropic.ts, pricing.ts
  telemetry/  tracer.ts
evals/        cases.json, run.ts, results.json, results.md
runbooks/     *.md
viewer/       index.html
fixtures/     recorded LLM responses (JSON)
tests/        unit + integration (vitest)
```

## 5. Tech choices

| Choice | Reason |
|---|---|
| TypeScript (strict), Node 20+, ESM | Matches the target role; the official MCP SDK is TS-first. |
| `@modelcontextprotocol/sdk` | Required; official implementation of the protocol and both transports. |
| `zod` | MCP SDK uses it for tool input schemas; one schema serves server validation and agent pre-flight validation. |
| `better-sqlite3` | Synchronous, fast, zero-config embedded DB; perfect for a local seeded dataset. |
| `node:http` (no Express) | The two HTTP surfaces are tiny; fewer dependencies to learn. |
| `@anthropic-ai/sdk` for the real provider | Official SDK and its types; our message format reuses them so no translation layer is needed. |
| Hand-rolled tracer writing JSONL | OTel span shape without the OTel SDK setup cost; a file is easy to inspect and diff. |
| Static HTML trace viewer | No build step; open the file in a browser. |
| `vitest` | Fast TS-native test runner, no Babel config. |
| `tsx` | Run TS scripts (seed, demo, evals) without a build step. |
| ESLint + typescript-eslint | Standard lint for TS. |
| Deterministic PRNG (mulberry32) | Seeded data and evals are reproducible across machines. |

## 6. Key design rules

- **Fleet clock**: data ends at a fixed timestamp; "now" for all tools = latest metric timestamp in the DB. Makes every query reproducible.
- **Safety lives in the client and the trace**: the agent never executes a WRITE tool without an approval record; evals verify this from the trace, not from the agent's own claims.
- **Defense in depth**: invalid arguments are rejected by the agent before approval is even requested, and again by the server's zod schema.
- **Mock is honest**: mock eval scores measure the harness (loop, tools, guardrails, data), not model intelligence. The README says so.

## 7. Milestones

| ID | Milestone | Verifiable success criterion |
|---|---|---|
| M0 | Scaffold: package, tsconfig, lint, vitest, CI workflow, LICENSE, .env.example | `npm run lint && npm run typecheck && npm test` pass locally; CI workflow file present. |
| M1 | Synthetic data, runbooks, queries, anomaly detection (z-score, EWMA) | `npm run seed` creates 50 devices and 504,000 metric rows; unit tests prove both detectors find the injected anomalies (e.g. D-17 overheating) and do not flag a healthy device. |
| M2 | MCP server: 6 tools, runbook resources, prompt, stdio + Streamable HTTP; Claude Desktop docs | Integration tests with the SDK `Client` over in-memory and HTTP transports list 6 tools, call each, read a resource, get the prompt; invalid args return an error. |
| M3 | LLM providers + agent loop + guardrails + CLI approval | Tests show: allow-list blocks unknown tools; max steps stops a looping model; budget stops an expensive run; invalid args never reach the server; a denied WRITE is never executed; `npm run demo` answers "why is D-17 alerting?" with zero API keys. |
| M4 | Tracing to JSONL, static trace viewer, HTTP agent API with approve/deny endpoint | A demo run writes a JSONL trace with nested llm/tool/approval spans; viewer renders it (headless browser screenshot); HTTP test approves and denies a pending action. |
| M5 | 25-case eval suite, committed results; Dockerfile; README, LEARNING.md, ADRs, SUMMARY.md | `npm run eval` reproduces committed results; safety = 100%; CI runs lint, typecheck, tests, evals in mock mode; `docker build` file present and valid. |
| M6 | React page: chat with agent, approve/deny pending actions | `npm run web:build` succeeds; UI served by the agent HTTP server; browser test sends a message and approves an action. |

Final: skeptical review pass over every file, re-run everything.

## 8. Risks

| Risk | Mitigation |
|---|---|
| No LLM API access in the sandbox | Provider interface; Mock and Replay providers; Anthropic provider untested live (stated honestly). |
| Mock planner makes evals look too good | Clearly label mock results; include adversarial cases and Replay fixtures of a misbehaving model to test guardrails, not the planner. |
| MCP SDK API churn | Pin the version; integration tests catch breaks. |
| Native module (`better-sqlite3`) fails to install | Fallback: `node:sqlite` (Node 22+). Logged under Deviations if used. |
| 500k rows slow to seed / large DB | Single transaction with prepared statement; DB is generated, git-ignored; tests seed a small fleet. |
| React build tooling adds weight | Last milestone, isolated in `web/`, only if all else is done. |

## 9. Deviations

No install or fetch was refused by the sandbox. Changes to the plan made while building:

1. **Docker image not built locally.** `docker build` failed because Docker Hub returned `429 Too Many Requests` for `node:22-slim` inside the sandbox. Not retried through other routes. Instead, every Dockerfile step (production-only `npm ci --omit=dev`, `npm run seed`, `npm run serve`, `npm run demo`) was run in a clean copy of the files the Dockerfile copies, and the CI workflow has a `docker` job that builds the image and runs the demo inside it. The first CI build failed (no prebuilt `better-sqlite3` binary, no compiler in the slim image); fixed with a two-stage Dockerfile, and the CI job now passes.
2. **Anthropic SDK instead of raw `fetch`.** The spec originally said raw `fetch`. Switched to the official `@anthropic-ai/sdk` so the conversation format can reuse the SDK's message types (no hand-written duplicates). See DECISIONS.md D9.
