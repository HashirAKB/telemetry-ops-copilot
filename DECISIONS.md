# Decisions log

Decisions taken while building without the owner available. Each entry: decision, alternatives considered, why.

## D1. Work directly on `main`
- **Alternatives:** feature branch + PRs.
- **Why:** explicit owner instruction.

## D2. Run TypeScript with `tsx`, no compile step
- **Alternatives:** `tsc` build to `dist/` and run with `node`.
- **Why:** one less moving part for a learner; `tsc --noEmit` still type-checks everything in CI. `tsx` is therefore a runtime dependency.

## D3. "zscore" is the robust (median/MAD) modified z-score
- **Alternatives:** classic mean/standard-deviation z-score.
- **Why:** measured on the seeded data: a 3-hour overheating step inflates the plain standard deviation so much that the anomaly scores only ~2.6 sigma and is missed (masking). Median/MAD is unaffected by up to 50% outliers.

## D4. Anomalies are reported as events, not points
- **Alternatives:** return every flagged minute.
- **Why:** with 1,440 points a day, Gaussian noise alone crosses a 3.5 sigma threshold about once per device per day. Requiring a run of 3 points (z-score) and merging runs separated by < 30 points removed every false positive on the seeded fleet and turns a drifting signal into one event instead of five. Also keeps tool output small for the LLM.

## D5. EWMA starts at the median, threshold 3 robust sigmas on the smoothed series
- **Alternatives:** start at the first value; textbook EWMA control limits L * sigma * sqrt(alpha / (2 - alpha)).
- **Why:** starting at the first value produced a false positive (first reading was a noisy outlier). Textbook limits are so tight that the normal daily temperature cycle is flagged on every device.

## D6. `list_devices` accepts optional `site` and `battery_below` filters
- **Alternatives:** no arguments, let the LLM filter 50 rows itself.
- **Why:** low battery is a threshold condition, not a statistical anomaly; filtering server-side is cheaper in tokens and less error-prone.

## D7. Fleet clock: "now" = latest metric timestamp
- **Alternatives:** wall-clock time.
- **Why:** makes every tool result reproducible regardless of when the seed ran.

## D8. A poisoned "vendor bulletin" runbook is committed on purpose
- **Alternatives:** keep injection text only in test fixtures.
- **Why:** lets evals exercise prompt injection through a real tool result (`search_runbooks`). The file says clearly that it is untrusted test content.

## D9. Official Anthropic SDK for the real provider (not raw fetch)
- **Alternatives:** raw `fetch` to `/v1/messages` (the original spec).
- **Why:** the SDK's types (`MessageParam`, `ContentBlockParam`) become our conversation format, so the real provider sends history unchanged, including any thinking blocks it must pass back. Raw fetch would mean hand-maintaining those types.

## D10. Default model `claude-opus-5-5`, effort `medium`, server-side refusal fallback on
- **Alternatives:** a cheaper Sonnet/Haiku default.
- **Why:** best default quality; `ANTHROPIC_MODEL` overrides it. Thinking cannot be disabled on this model, so `output_config.effort` is the cost lever. `fallbacks: "default"` lets the API retry a safety refusal on another model; the loop still handles `stop_reason: "refusal"`.

## D11. Mock token usage is estimated (chars / 4) and priced as `claude-opus-5-5`
- **Alternatives:** report zero cost for the mock.
- **Why:** budgets and cost metrics must be exercised in tests and evals. The numbers are labelled as estimates.

## D12. Replay is sequential, not keyed by request hash
- **Alternatives:** hash each request and look up the matching response.
- **Why:** hand-written "misbehaving model" fixtures are easier to read and write as an ordered list. Hash keys break on any prompt change. Tradeoff: a replayed run must make the same number of calls.

## D13. Approval policy is default-deny on the client side
- **Alternatives:** trust the MCP tool annotations (`readOnlyHint`).
- **Why:** annotations come from the server and are hints, not security. The agent requires approval for every tool not explicitly marked read-only in its own definitions.

## D14. Demo runs on a fresh in-memory fleet with a scripted operator
- **Alternatives:** interactive y/n prompts in the demo.
- **Why:** reproducible output for the README and CI; never mutates `data/fleet.db`. The interactive path is `npm run agent`.

## D15. Hand-rolled tracer with OpenTelemetry span shape, JSONL sink
- **Alternatives:** `@opentelemetry/sdk-trace-node` + file exporter.
- **Why:** ~80 lines a learner can read fully; the span fields (traceId, spanId, parentSpanId, attributes using `gen_ai.*` names) match OTel, so moving to a real exporter is a new sink, not a rewrite. Trace id = run id.

## D16. HTTP runs are asynchronous; clients poll
- **Alternatives:** keep the POST open until the run ends; WebSockets/SSE.
- **Why:** a run can wait minutes for a human approval. Polling two endpoints is the simplest thing that works with curl and a small React page.

## D17. Unanswered HTTP approvals are denied after 5 minutes
- **Alternatives:** wait forever; approve on timeout.
- **Why:** fail safe. A forgotten approval must never turn into an action, and must not hang a run forever.

## D18. Viewer screenshot uses `playwright-core` pinned to the pre-installed browser version
- **Alternatives:** full `playwright` package (downloads browsers).
- **Why:** no browser download needed; dev-only script, not part of CI.

## D19. React page built with Vite into `web/dist`, served by the agent API
- **Alternatives:** separate `web/package.json` workspace; React from a CDN without a build.
- **Why:** one `npm install` for everything; the agent API already serves static files, so no extra server or CORS. React and Vite are dev dependencies only (the built bundle is static).

## D20. The browser e2e test is a script, not a vitest test
- **Alternatives:** run it inside `npm test`.
- **Why:** it needs Chromium; keeping it out of `npm test` keeps unit tests runnable anywhere. CI runs it in its own job after installing Chromium.

## D21. Optional bearer token on /api/*, constant-time compare, static pages public
- **Alternatives:** always require a token (breaks the zero-setup quickstart); sessions/cookies; mTLS.
- **Why:** one env var gives real protection for approvals; unset keeps local dev frictionless but the server prints a warning. Static pages hold no data, so they stay public and ask for the token. The page keeps it in localStorage so the trace viewer tab can reuse it.

## D22. Approval audit log as a decorator, in the agent's own SQLite file
- **Alternatives:** write approvals into the fleet database; rely on traces only.
- **Why:** the agent talks to the server only through MCP, so it should not write into the server's database. A decorator (`withAudit`) adds auditing to every approver type without touching them. Traces can be rotated; an audit log is the durable record.

## D23. BM25 instead of term counting for runbook search; no embeddings
- **Alternatives:** keep term counts; embeddings with a vector index.
- **Why:** a test showed term counting ranks a document that repeats a common word above the one with the rare, relevant word. BM25 fixes that in about 30 lines with no dependencies or model downloads. Embeddings would add synonym matching but need a model, which is overkill for six documents and impossible offline here.

## D24. OTLP export as a hand-written OTLP/HTTP JSON sink, one POST per finished trace
- **Alternatives:** OpenTelemetry SDK with the OTLP exporter package; protobuf encoding.
- **Why:** JSON encoding is part of the OTLP spec and needs no dependencies. Buffering until the root span ends keeps a trace together in one request. Failures are logged and swallowed so a missing collector never breaks a run. Uses the standard `OTEL_EXPORTER_OTLP_ENDPOINT` variable.
