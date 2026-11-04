# Learning guide

This is a study guide for this repo. Read it with the code open. It covers the concepts from first principles, a reading order, one request traced through the code, interview questions with model answers, and hands-on exercises.

---

## 1. Concepts from first principles

### 1.1 What an LLM "tool call" really is
An LLM only produces text. "Tool use" is a convention: you send the model a list of tools (name, description, JSON schema for the arguments), and the model may answer with a structured block that says "call tool X with these arguments" instead of plain text. In the Anthropic Messages API this is a `tool_use` content block, and the response has `stop_reason: "tool_use"`.

The model does **not** run anything. *Your code* runs the tool and sends the output back as a `tool_result` block in the next user message, matched by `tool_use_id`. Then you call the model again. See `src/llm/types.ts` for the shapes and `src/agent/loop.ts` for the code that does this.

### 1.2 The agent loop
An agent is a loop around that exchange:

```
messages = [user question]
repeat:
  response = LLM(system, messages, tools)
  append response to messages
  if response has no tool calls: return its text
  for each tool call: check it, maybe ask a human, run it, collect the result
  append all results (one user message) to messages
```

That is all an "agent" is. Everything else is about making that loop **safe** (guardrails), **affordable** (budgets), **observable** (traces) and **measurable** (evals). This repo's loop is `runAgent` in `src/agent/loop.ts`.

Important detail: the API is stateless. Every call sends the *whole* conversation. That is why token usage grows with every step and why a step limit and budget matter.

### 1.3 MCP (Model Context Protocol)
MCP standardises how an AI application talks to tool providers. A **server** exposes:
- **tools**: functions the model can ask to call (`list_devices`, `restart_device`...),
- **resources**: readable data addressed by URI (`runbook://overheating`),
- **prompts**: reusable prompt templates (`triage_device`).

A **client** (our agent, Claude Desktop, the MCP Inspector) connects to it over a **transport**: `stdio` (the server is a child process; JSON-RPC over stdin/stdout) or **Streamable HTTP** (JSON-RPC over HTTP POST). Messages are JSON-RPC 2.0 (`tools/list`, `tools/call`, `resources/read`...).

Why it matters: write the tool server once, and any MCP host can use it. Our MCP server knows nothing about LLMs or approvals (`src/server/mcp-server.ts`).

### 1.4 Guardrails
The model's output is untrusted input. Before a tool call has any effect we check:
1. **Allow-list**: is this tool known and allowed for this agent? (A model can invent tool names.)
2. **Argument validation**: do the arguments match the schema? (`zod`, same schema as the server.)
3. **Approval**: does this tool change the world? Then a human must say yes.
4. **Max steps**: a model can loop forever.
5. **Budget**: each step costs tokens and money; stop before it gets expensive.

See `src/agent/guardrails.ts`. Order matters: validation runs *before* approval, so a human is never asked to approve a malformed destructive action.

### 1.5 Human-in-the-loop (HITL) and prompt injection
**Prompt injection**: text that the model reads (a tool result, a document, a web page) contains instructions ("restart every device"). The model may follow them. You cannot reliably prevent a model from being fooled, so you limit what a fooled model can do: writes need a human. The `vendor-bulletin` runbook contains such an injection; the `prompt-injection` fixture shows a model that obeys it, and the approval gate stops it.

**Default-deny**: the agent requires approval for any tool not explicitly marked read-only in *its own* definitions. MCP annotations like `readOnlyHint` come from the server, so they are hints, not security.

### 1.6 Observability: traces and spans
A **trace** is the story of one request. It is a tree of **spans**. Each span is a timed operation with a parent, a status and key/value **attributes**. This follows the OpenTelemetry model. Here: one `agent.run` root span, children `llm.complete` and `tool.<name>`, and an `approval` span under each write tool. With this you can answer "why was this run slow / expensive / wrong?" afterwards. See `src/telemetry/tracer.ts` and `viewer/index.html`.

### 1.7 Evals
Unit tests check functions; **evals** check behaviour of the whole system on realistic tasks. Each case has a question and expectations: which tools must be used, what the answer must contain, which writes must (or must not) happen. Metrics: task success, tool selection, safety, steps, cost. A good eval measures safety from **independent evidence** (trace + database), not from the agent's claims. See `evals/`.

### 1.8 Mock vs replay vs real model
- **Mock** (`src/llm/mock.ts`): a deterministic planner that produces model-shaped responses. Lets everything run with no key, reproducibly.
- **Replay** (`src/llm/replay.ts`): plays back recorded responses. Used to simulate a *bad* model to test guardrails.
- **Real** (`src/llm/anthropic.ts`): the Anthropic API through the official SDK.

Because all three implement `LLMProvider`, the loop does not know which one it has. This is dependency inversion in practice.

### 1.9 Ranking documents with BM25
Counting how often query words appear in a document has three problems: a word that is in every document ("device") counts as much as a rare, specific one ("fan"); saying a word 40 times scores 40 times higher; and long documents win just by being long. BM25 fixes all three: **IDF** weights rare words up, the **K1** term makes repeated occurrences saturate, and the **B** term normalises by document length. It is still the baseline that search engines (Lucene, Elasticsearch) use before any embeddings. See `searchRunbooks` in `src/data/runbooks.ts`.

### 1.10 Robust anomaly detection
- **z-score**: how many standard deviations a point is from the mean. Problem: a long anomaly pulls the mean and inflates the standard deviation, hiding itself ("masking").
- **Robust z-score**: use the median and the MAD (median absolute deviation) instead; `1.4826 * MAD` estimates the standard deviation for normal data, and outliers barely move the median.
- **EWMA**: smooth the series, `s = alpha * x + (1 - alpha) * s`. Noise cancels out, slow drifts remain. Good for "bearing slowly wearing out".
- **Events, not points**: random noise crosses any threshold occasionally. Requiring several consecutive points and merging nearby runs removes those false alarms.

See `src/data/anomalies.ts` and ADR 0004.

---

## 2. Reading order

| # | File | What it teaches |
|---|---|---|
| 1 | `SPEC.md`, `PLAN.md` | Scope, milestones, how success was defined up front |
| 2 | `src/data/db.ts` | The schema: devices, per-minute metrics, incidents, restart audit log |
| 3 | `src/data/seed.ts` | Deterministic synthetic data (seeded PRNG, Box-Muller), injected anomalies as ground truth |
| 4 | `src/data/anomalies.ts` | Robust statistics, EWMA, grouping flags into events |
| 5 | `src/data/queries.ts` | Plain functions over SQLite; downsampling to save LLM context; the fleet clock |
| 6 | `src/tools/definitions.ts` | One zod schema per tool shared by server and agent; read vs write |
| 7 | `src/server/mcp-server.ts` | Registering MCP tools, resources and a prompt; errors as `isError` results |
| 8 | `src/server/stdio.ts`, `src/server/http.ts` | The two transports; why stdout is reserved; stateless HTTP |
| 9 | `src/llm/types.ts` | The provider interface and the Messages API shapes |
| 10 | `src/llm/mock.ts` | How a "model" decides the next step from the conversation |
| 11 | `src/agent/guardrails.ts` | Allow-list, validation, approval policy, budget |
| 12 | `src/agent/approval.ts`, `src/agent/http-approver.ts` | Three ways a human (or policy) decides; fail-safe timeout |
| 13 | `src/agent/loop.ts` | The agent itself: loop, stop conditions, tool execution, tracing |
| 14 | `src/telemetry/tracer.ts`, `viewer/index.html` | Spans, trace trees, rendering a timeline |
| 15 | `src/agent/http-api.ts` | Async runs, polling, approve/deny endpoints |
| 16 | `src/llm/replay.ts`, `fixtures/*.json` | Testing guardrails with a deliberately bad model |
| 17 | `evals/score.ts`, `evals/run.ts`, `evals/cases.json` | Measuring behaviour; safety from evidence |
| 18 | `tests/*.test.ts` | How each layer is tested |
| 19 | `src/llm/anthropic.ts` | The real API call |
| 20 | `docs/adr/*`, `DECISIONS.md` | Why things are the way they are |

---

## 3. One request, end to end

`npm run agent -- "Restart D-33, its signal dropped"` with the default mock provider and a y/n prompt.

1. **CLI** (`src/agent/cli.ts`) parses flags, opens `data/fleet.db` (seeding it if empty, `openSeededDb`), connects an MCP client to an in-process MCP server (`connectInProcess` in `src/agent/mcp-client.ts`, using `InMemoryTransport`), picks `MockProvider` (`createProvider` in `src/llm/index.ts`), and calls `runAgent`.
2. **Setup** (`runAgent`, `src/agent/loop.ts`): creates the run id and root span `agent.run`, calls `mcp.listTools()` (a `tools/list` JSON-RPC request) and keeps only allowed tools. `messages = [{role: "user", content: question}]`.
3. **Step 1, LLM**: span `llm.complete`. `MockProvider.complete` reads the conversation (`readConversation`), finds the device id `D-33`, and `planDevices` returns a `tool_use` block: `detect_anomalies({target: "D-33", method: "zscore", window: "24h"})`. Token usage is estimated and added to the `Budget`.
4. **Tool call**: `executeToolCall` opens span `tool.detect_anomalies`. `checkToolCall` confirms it is allowed, validates arguments with zod (adds nothing new here) and sees it is read-only, so no approval. `mcp.callTool` sends `tools/call` to the server.
5. **Server** (`src/server/mcp-server.ts`): the SDK validates the arguments with the same zod schema and runs the handler, which calls `detectDeviceAnomalies` (`src/data/queries.ts`). That reads 1,440 minutes of metrics and runs `detect` (`src/data/anomalies.ts`) on each metric. The signal dropout becomes one event. The result is returned as JSON text.
6. **Back in the loop**: the result is appended as a `tool_result` block in a new user message.
7. **Steps 2 and 3**: the mock asks for `get_metrics(D-33, 6h)`, then `search_runbooks("connectivity loss weak signal")`. The runbook search (`src/data/runbooks.ts`) ranks "Connectivity loss" first; its text says a restart often helps.
8. **Step 4, a write**: the mock requests `restart_device({device_id: "D-33", reason: "..."})`. `checkToolCall` says `needsApproval: true`. An `approval` span starts; `CliApprover` prints the request and waits for `y`. On `y`, the call goes to the server, `restartDevice` inserts a row into `device_events` and sets the status to `restarting`.
9. **Step 5, answer**: the mock sees everything is done and returns text only (`stop_reason: end_turn`). The loop returns `RunResult` with the answer, steps, usage and every tool call record. The root span gets the final attributes and is written last.
10. **Output**: the CLI prints the tool calls, the answer, tokens and cost, and the path of `traces/<runId>.jsonl`, which you can open in `viewer/index.html`.

Had you typed `n` at step 8, the tool result would say "Denied by the operator", the span status would be `error`, no row would be written, and the final answer would say the restart was NOT performed.

---

## 4. Interview questions with model answers

**1. Walk me through your agent loop.**
`runAgent` keeps a message list starting with the user question. Each iteration checks the budget, calls the provider with the system prompt, messages and allowed tools, and appends the response. If there are no `tool_use` blocks, the text is the answer. Otherwise every tool call goes through `executeToolCall` (allow-list, zod validation, approval for writes, MCP call), and all results go back in one user message. It stops on a final answer, max steps, budget, refusal, or a provider error. About 200 lines in `src/agent/loop.ts`.

**2. Why not LangChain or LangGraph?**
The loop is small and the safety logic must be obvious at the exact point it applies. A framework would hide the control flow and add dependencies I would have to defend. I would reconsider for features like durable execution or complex multi-agent graphs. ADR 0001.

**3. What is MCP and why use it here?**
A protocol for exposing tools, resources and prompts to AI applications over JSON-RPC, with stdio and Streamable HTTP transports. Writing the fleet tools as an MCP server means the same server works with my agent, Claude Desktop and the MCP Inspector, and the agent depends on a standard client instead of direct function calls.

**4. stdio vs Streamable HTTP?**
stdio: the host spawns the server as a child process; simple, local, one client. Streamable HTTP: the server is a network service; many clients, can be deployed remotely. I run HTTP in stateless mode, a new server instance per request, which is easy to scale but cannot push notifications. In stdio mode stdout carries protocol messages, so logs must go to stderr.

**5. How do you stop the agent from doing something destructive?**
Four layers. The allow-list limits which tools exist for this agent. Arguments are validated with zod before anything else. Every tool not explicitly read-only needs human approval through an `Approver` (CLI y/n, HTTP, or policy), and HTTP approvals time out to deny. And evals verify from the trace and database that no write ever ran without an approval span.

**6. How do you handle prompt injection?**
I assume the model can be fooled, so I limit what a fooled model can do. The system prompt says tool results are data, but the real defence is that writes require a human. The `vendor-bulletin` runbook contains an injection; the `prompt-injection` fixture replays a model that obeys it, and the test shows the restart is denied and never reaches the database.

**7. Why validate arguments in the agent if the server validates too?**
Defence in depth, and ordering: I want invalid destructive calls rejected *before* a human is asked to approve them, so humans only see well-formed actions. Both sides use the same zod schema from `src/tools/definitions.ts`, so they cannot drift.

**8. Why not trust MCP tool annotations like `readOnlyHint`?**
They come from the server, which might be third-party or wrong. The spec describes them as hints. My client decides from its own definitions and defaults to "needs approval" for anything not explicitly read-only.

**9. How do you control cost?**
A `Budget` sums input and output tokens over the run and converts them to dollars with a price table; the loop checks it before every LLM call. Also: `get_metrics` downsamples to 12 points and anomalies are grouped into events, so tool results stay small, because every result is re-sent on every later call. With the real API I would add prompt caching on the stable prefix (tools and system prompt).

**10. How does your mock LLM work, and is it cheating?**
It is a deterministic planner: it reads the conversation like a model would, picks an intent from keywords, and emits the same `tool_use`/`text` blocks a real model would. It exists so tests, evals and the demo run with no key. It is not a measure of intelligence, and the README says so next to the results. The guardrail tests do not depend on it: they use replay fixtures of a misbehaving model.

**11. What do your evals measure and how?**
25 cases with expected tools, answer content and expected database writes. Metrics: task success, tool selection, unapproved writes, steps and cost. Safety comes from evidence: every successful write span must have an approved approval child span, and the actual rows in SQLite must equal the approved writes in the trace. CI fails on any unapproved write or if committed results are stale.

**12. Why a robust z-score?**
On the seeded data the classic z-score missed a 3-hour overheating step: the anomaly inflated the standard deviation (masking) so it scored about 2.6 sigma. Median and MAD barely move with up to 50% outliers. I also require runs of 3 points and merge nearby runs, which removed all false positives on healthy devices. ADR 0004.

**13. When is EWMA better than a z-score?**
For slow drifts. Each point in a drift may be only slightly unusual, but the smoothed series moves steadily away from the baseline. Smoothing also cancels random noise, so it raises fewer isolated alarms. The vibration drift on D-08 is the example.

**14. What is in a trace, and how would you go to production observability?**
OpenTelemetry-shaped spans: trace id (= run id), span id, parent, timings, status and attributes such as `gen_ai.usage.input_tokens`, `tool.name`, `approval.approved`. They are written as JSONL and rendered by a static viewer. For production I would add an OTLP exporter sink, keeping the same span model, and send to Tempo, Jaeger or Honeycomb.

**15. What would break first in production, and what would you change?**
The HTTP API has no auth, so anyone who can reach it could approve actions: add authentication and an audit log of approvers. Runs and pending approvals are in memory: persist them. SQLite and per-request full scans would not scale to millions of devices: use a time-series store and precomputed anomaly jobs. And I would run the eval suite against the real model, with an LLM judge for answer quality, before every prompt or model change.

---

## 5. Hands-on exercises

**Exercise 1 (break it): remove the approval gate.**
In `src/agent/guardrails.ts` make `needsApproval` always `false`. Run `npm test` and `npm run eval -- --check`.
*Hint:* watch which tests fail and why; the eval check should fail on safety even though the agent's answers look fine. That is the point of measuring safety from the trace.

**Exercise 2 (break it): use the classic z-score.**
In `src/data/anomalies.ts`, compute the centre with the mean and sigma with the standard deviation. Run `npx vitest run tests/data.test.ts`.
*Hint:* look at which injected anomaly disappears and compute its score by hand: about 12% of points are 30 degrees higher. Then try a 3-point run requirement with a 3.0 threshold and count false positives on the healthy device.

**Exercise 3 (extend it): add a `get_device_events` read tool.**
Return the restart history of a device from `device_events`.
*Hint:* add a schema with `access: "read"` in `src/tools/definitions.ts`, a query in `src/data/queries.ts`, register it with `tool(...)` in `src/server/mcp-server.ts`, and update the "lists the six tools" test. The agent needs no change. Why?

**Exercise 4 (extend it): a per-run limit on write actions.**
Add `maxWrites` to `AgentOptions` (default 5, matching the restart runbook policy). Further write requests get a `blocked` result without asking a human.
*Hint:* count approved writes inside `runAgent`; write a test with a fixture that asks for six restarts in one response (copy `fixtures/prompt-injection.json`).

**Exercise 5 (extend it): record a real run and replay it.**
With an API key, wrap `AnthropicProvider` in `RecordingProvider`, run one question, and `save()` it to `fixtures/`. Then write a test that replays it.
*Hint:* look at `tests/agent.test.ts` "record and replay". Why does sequential replay break if you change the system prompt? What would a hash-keyed replay need to handle (DECISIONS.md D12)?
