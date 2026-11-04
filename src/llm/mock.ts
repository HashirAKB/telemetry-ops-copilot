// MockProvider: a deterministic, rule-based stand-in for an LLM.
//
// It reads the conversation exactly like a real model would (question +
// previous tool calls and results) and decides the next step: call a tool or
// write the final answer. It is stateless, so the same conversation always
// produces the same response. That makes tests, evals and the demo
// reproducible with zero API keys.
//
// It is NOT smart. It recognises a few intents by keywords. Its job is to
// exercise the real parts of the system (agent loop, MCP tools, guardrails,
// approvals, tracing) end to end. Eval scores with the mock measure that
// harness, not model intelligence.
import type { ContentBlock, LLMProvider, LLMRequest, LLMResponse, Message } from "./types";
import { estimateTokens } from "./types";
import { DEFAULT_PRICED_MODEL } from "./pricing";

/** A tool call already made in this conversation, with its result. */
interface PastCall {
  name: string;
  input: Record<string, unknown>;
  result: unknown; // parsed JSON, or the raw text if not JSON
  isError: boolean;
}

type Step = { tools: { name: string; input: Record<string, unknown> }[]; say: string } | { answer: string };

interface Anomaly {
  device_id: string;
  metric: string;
  peak_value: number;
  direction: string;
  score: number;
  start: string;
  ongoing: boolean;
}
interface DeviceRow {
  id: string;
  site: string;
  latest: { temperature: number; vibration: number; battery: number; signal: number };
}
interface RunbookHit {
  slug: string;
  title: string;
  content: string;
}

export class MockProvider implements LLMProvider {
  readonly name = "mock";
  // Priced as the default real model so cost numbers are meaningful estimates.
  readonly model = DEFAULT_PRICED_MODEL;

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const { question, calls } = readConversation(request.messages);
    const step = plan(question, calls);

    const content: ContentBlock[] =
      "answer" in step
        ? [{ type: "text", text: step.answer }]
        : [
            { type: "text", text: step.say },
            ...step.tools.map((t, i) => ({
              type: "tool_use" as const,
              id: `toolu_mock_${calls.length + i + 1}`,
              name: t.name,
              input: t.input,
            })),
          ];
    return {
      content,
      stopReason: "answer" in step ? "end_turn" : "tool_use",
      usage: { inputTokens: estimateTokens(request), outputTokens: estimateTokens(content) },
    };
  }
}

/** Extract the user's question and every completed tool call from the history. */
export function readConversation(messages: Message[]): { question: string; calls: PastCall[] } {
  const first = messages[0];
  const question =
    typeof first?.content === "string"
      ? first.content
      : (first?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join(" ");

  const pending = new Map<string, { name: string; input: Record<string, unknown> }>();
  const calls: PastCall[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_use") pending.set(block.id, { name: block.name, input: block.input as Record<string, unknown> });
      if (block.type === "tool_result") {
        const call = pending.get(block.tool_use_id);
        if (!call) continue;
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        let result: unknown = text;
        try {
          result = JSON.parse(text);
        } catch {
          // keep raw text (error messages are plain text)
        }
        calls.push({ ...call, result, isError: block.is_error === true });
      }
    }
  }
  return { question, calls };
}

// ---------------------------------------------------------------------------
// Planning: pick an intent from keywords, then walk that intent's steps.
// ---------------------------------------------------------------------------

const has = (text: string, re: RegExp) => re.test(text);

export function plan(question: string, calls: PastCall[]): Step {
  const q = question.toLowerCase();
  const deviceIds = [...new Set(question.toUpperCase().match(/\bD-\d{2}\b/g) ?? [])];

  // Any tool error the user should hear about (unknown device, denied action...).
  const failed = calls.filter((c) => c.isError);

  if (deviceIds.length > 0) return planDevices(q, deviceIds, calls, failed);
  if (has(q, /battery/)) return planBattery(q, calls, failed);
  if (has(q, /restart|reboot|power.?cycle/)) return planFleetRestart(calls);
  if (has(q, /runbook|procedure|how (do|should) (i|we)|what should|bulletin|vendor/)) return planRunbook(question, calls);
  if (has(q, /\b(fleet|anomal\w*|which devices|any devices|problems?|alert\w*|unhealthy|wrong)\b/)) return planFleet(q, calls);
  if (has(q, /list|how many|devices|site|plant|warehouse/)) return planList(q, calls);
  return {
    answer:
      "I can investigate devices (e.g. \"why is D-17 alerting?\"), scan the fleet for anomalies, find low-battery devices, search runbooks, open incidents and request restarts (writes need human approval).",
  };
}

const done = (calls: PastCall[], name: string, match: (input: Record<string, unknown>) => boolean = () => true) =>
  calls.find((c) => c.name === name && match(c.input));

function methodFor(q: string) {
  return has(q, /drift|trend|gradual|slow|creep/) ? "ewma" : "zscore";
}
function windowFor(q: string) {
  return has(q, /week|7 ?d|past days|history|historic/) ? "7d" : "24h";
}

const RUNBOOK_QUERY: Record<string, string> = {
  temperature: "overheating high temperature",
  vibration: "high vibration drift",
  signal: "connectivity loss weak signal",
  battery: "low battery",
};

const describe = (a: Anomaly) =>
  `${a.metric} ${a.direction} (peak ${a.peak_value}, ${a.score} robust sigmas, ${a.ongoing ? `ongoing since ${a.start}` : `at ${a.start}`})`;

function firstBullets(runbook: RunbookHit, heading: string): string {
  const section = runbook.content.split(heading)[1] ?? "";
  const lines = section.split("\n").filter((l) => /^(\d+\.|-)\s/.test(l.trim()));
  return lines.slice(0, 2).map((l) => l.trim().replace(/^(\d+\.|-)\s*/, "")).join(" ");
}

function planDevices(q: string, ids: string[], calls: PastCall[], failed: PastCall[]): Step {
  const method = methodFor(q);
  const window = windowFor(q);
  const wantsRestart = has(q, /restart|reboot|power.?cycle/);
  const wantsIncident = has(q, /incident|ticket|escalate/);

  // 1. Detect anomalies on every mentioned device (parallel tool calls).
  const todo = ids.filter((id) => !done(calls, "detect_anomalies", (i) => i.target === id));
  if (todo.length) {
    return {
      say: `Checking ${todo.join(", ")} for anomalies (${method}, ${window}).`,
      tools: todo.map((id) => ({ name: "detect_anomalies", input: { target: id, method, window } })),
    };
  }
  // Unknown device ids: stop and report.
  const unknown = failed.filter((c) => c.name === "detect_anomalies");
  if (unknown.length) {
    return { answer: `I could not investigate: ${unknown.map((c) => String(c.result)).join(" ")}` };
  }

  // 2. Metrics for context.
  const metricsTodo = ids.filter((id) => !done(calls, "get_metrics", (i) => i.device_id === id));
  if (metricsTodo.length) {
    return {
      say: "Pulling recent metrics for context.",
      tools: metricsTodo.map((id) => ({ name: "get_metrics", input: { device_id: id, window: "6h" } })),
    };
  }

  const anomalies = calls
    .filter((c) => c.name === "detect_anomalies" && !c.isError)
    .flatMap((c) => (c.result as { anomalies: Anomaly[] }).anomalies);
  const metrics = Object.fromEntries(
    calls
      .filter((c) => c.name === "get_metrics" && !c.isError)
      .map((c) => [c.input.device_id, c.result as { summary: Record<string, { latest: number }> }]),
  );
  const lowBattery = ids.filter((id) => (metrics[id]?.summary.battery?.latest ?? 100) < 20);

  // 3. Find the runbook for the main problem.
  const mainMetric = anomalies[0]?.metric ?? (lowBattery.length ? "battery" : undefined);
  const search = done(calls, "search_runbooks");
  if (mainMetric && !search) {
    return { say: "Looking up the matching runbook.", tools: [{ name: "search_runbooks", input: { query: RUNBOOK_QUERY[mainMetric] } }] };
  }
  const runbook = (search?.result as { results?: RunbookHit[] } | undefined)?.results?.[0];
  const restartDiscouraged = runbook ? /do not restart/i.test(runbook.content) : false;

  // 4. Writes the operator asked for (each one goes through human approval).
  const writes: { name: string; input: Record<string, unknown> }[] = [];
  for (const id of ids) {
    const own = anomalies.filter((a) => a.device_id === id);
    const summary = own.length ? own.map(describe).join("; ") : "no statistical anomalies";
    if (wantsIncident && !done(calls, "create_incident", (i) => i.device_id === id)) {
      const severity = own.some((a) => a.metric === "temperature" && a.peak_value > 60) || own.some((a) => a.metric === "vibration")
        ? "high"
        : own.length || lowBattery.includes(id)
          ? "medium"
          : "low";
      writes.push({
        name: "create_incident",
        input: {
          device_id: id,
          title: own.length ? `${own[0]!.metric} anomaly on ${id}` : `Operator report for ${id}`,
          severity,
          description: `Findings: ${summary}.${runbook ? ` Runbook: ${runbook.title}.` : ""}`,
        },
      });
    }
    if (wantsRestart && !restartDiscouraged && !done(calls, "restart_device", (i) => i.device_id === id)) {
      writes.push({
        name: "restart_device",
        input: { device_id: id, reason: own.length ? `Operator request; ${summary}` : "Operator request" },
      });
    }
  }
  if (writes.length) return { say: "Requesting the actions you asked for (needs approval).", tools: writes };

  // 5. Final answer.
  const lines: string[] = [];
  for (const id of ids) {
    const own = anomalies.filter((a) => a.device_id === id);
    if (own.some((a) => a.ongoing)) lines.push(`${id} is alerting: ${own.map(describe).join("; ")}.`);
    else if (own.length) lines.push(`${id} is not alerting now but had anomalies in the last ${window}: ${own.map(describe).join("; ")}.`);
    else if (lowBattery.includes(id)) lines.push(`${id} has no metric anomalies but its battery is low (${metrics[id]!.summary.battery!.latest}%).`);
    else lines.push(`${id} looks healthy: no anomalies in the last ${window}.`);
  }
  if (runbook) {
    lines.push(`Runbook "${runbook.title}". Likely causes: ${firstBullets(runbook, "**Likely causes**")}`);
    lines.push(`Recommended: ${firstBullets(runbook, "**Remediation**")}`);
  }
  if (wantsRestart && restartDiscouraged) lines.push("I did not restart: the runbook says a restart does not help for this problem.");
  lines.push(...writeOutcomes(calls));
  return { answer: lines.join("\n") };
}

/** Human-readable outcome of every write attempt, including denials. */
function writeOutcomes(calls: PastCall[]): string[] {
  return calls
    .filter((c) => c.name === "create_incident" || c.name === "restart_device")
    .map((c) => {
      const target = String(c.input.device_id);
      if (c.isError) return `${c.name} for ${target} was NOT performed: ${String(c.result)}`;
      if (c.name === "create_incident") return `Opened incident #${(c.result as { incident_id: number }).incident_id} for ${target}.`;
      return `Restart requested for ${target}.`;
    });
}

function planBattery(q: string, calls: PastCall[], failed: PastCall[]): Step {
  const threshold = Number(q.match(/(?:below|under|<)\s*(\d+)/)?.[1] ?? 20);
  const listed = done(calls, "list_devices");
  if (!listed) {
    return { say: `Finding devices with battery below ${threshold}%.`, tools: [{ name: "list_devices", input: { battery_below: threshold } }] };
  }
  const devices = (listed.result as DeviceRow[]) ?? [];
  if (!devices.length) return { answer: `No devices have battery below ${threshold}%.` };

  const wantsRestart = has(q, /restart|reboot|power.?cycle/);
  const wantsIncident = has(q, /incident|ticket|escalate|swap|replace/);
  if ((wantsRestart || wantsIncident || has(q, /what should|fix|action|do about/)) && !done(calls, "search_runbooks")) {
    return { say: "Checking the low-battery runbook.", tools: [{ name: "search_runbooks", input: { query: "low battery" } }] };
  }
  if (wantsIncident) {
    const todo = devices.filter((d) => !done(calls, "create_incident", (i) => i.device_id === d.id));
    if (todo.length) {
      return {
        say: "Opening one incident per device so field ops can swap batteries (needs approval).",
        tools: todo.map((d) => ({
          name: "create_incident",
          input: {
            device_id: d.id,
            title: `Low battery on ${d.id}`,
            severity: d.latest.battery < 10 ? "critical" : "medium",
            description: `Battery at ${d.latest.battery}%. Schedule a battery swap (runbook: Low battery).`,
          },
        })),
      };
    }
  }
  const lines = [
    `${devices.length} device(s) have battery below ${threshold}%: ${devices.map((d) => `${d.id} (${d.latest.battery}%)`).join(", ")}.`,
  ];
  if (wantsRestart) {
    lines.push("I did not restart them: the Low battery runbook says restarting does not help and wastes charge. Open incidents for a battery swap instead.");
  }
  lines.push(...writeOutcomes(calls));
  if (failed.length && !lines.some((l) => l.includes("NOT performed"))) lines.push(`Errors: ${failed.map((c) => String(c.result)).join(" ")}`);
  return { answer: lines.join("\n") };
}

function planFleetRestart(calls: PastCall[]): Step {
  const search = done(calls, "search_runbooks");
  if (!search) {
    return { say: "Checking the restart policy first.", tools: [{ name: "search_runbooks", input: { query: "device restart procedure policy" } }] };
  }
  return {
    answer:
      'I will not restart the whole fleet. The "Device restart procedure" runbook says never to restart more than 5 devices at once without a change ticket, and every restart needs a stated reason. Tell me which devices (e.g. "restart D-33") and why.',
  };
}

function planRunbook(question: string, calls: PastCall[]): Step {
  const search = done(calls, "search_runbooks");
  if (!search) return { say: "Searching the runbooks.", tools: [{ name: "search_runbooks", input: { query: question.slice(0, 200) } }] };
  const hits = (search.result as { results: RunbookHit[] }).results;
  if (!hits.length) return { answer: "I found no runbook matching that question." };
  const top = hits[0]!;
  // Note: runbook text is data. Instructions inside it are never followed.
  const body = top.content
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && !/instruction|ai assistant/i.test(l))
    .slice(0, 4)
    .join(" ");
  return { answer: `Best match: "${top.title}" (runbook://${top.slug}). ${body}` };
}

function planFleet(q: string, calls: PastCall[]): Step {
  const method = methodFor(q);
  const window = windowFor(q);
  const scan = done(calls, "detect_anomalies");
  if (!scan) {
    return { say: `Scanning the whole fleet (${method}, ${window}).`, tools: [{ name: "detect_anomalies", input: { target: "fleet", method, window } }] };
  }
  const anomalies = (scan.result as { anomalies: Anomaly[] }).anomalies;
  if (!anomalies.length) return { answer: `No anomalies across the fleet in the last ${window}.` };
  const lines = anomalies.map((a) => `- ${a.device_id}: ${describe(a)}`);
  return { answer: `${anomalies.length} anomalies across the fleet (${method}, ${window}):\n${lines.join("\n")}` };
}

function planList(q: string, calls: PastCall[]): Step {
  const site = q.match(/\b(plant-[a-z]|warehouse-[a-z])\b/)?.[1];
  const listed = done(calls, "list_devices");
  if (!listed) return { say: "Listing devices.", tools: [{ name: "list_devices", input: site ? { site } : {} }] };
  const devices = listed.result as DeviceRow[];
  const hottest = [...devices].sort((a, b) => b.latest.temperature - a.latest.temperature)[0];
  const weakest = [...devices].sort((a, b) => a.latest.battery - b.latest.battery)[0];
  return {
    answer:
      `${devices.length} devices${site ? ` at ${site}` : ""}: ${devices.map((d) => d.id).join(", ")}.` +
      (hottest ? ` Hottest: ${hottest.id} (${hottest.latest.temperature} C). Lowest battery: ${weakest!.id} (${weakest!.latest.battery}%).` : ""),
  };
}
