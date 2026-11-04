// OTLP export: send our spans to any OpenTelemetry backend (Jaeger, Grafana
// Tempo, Honeycomb, an OTel Collector...) using the standard OTLP/HTTP JSON
// encoding. No OpenTelemetry SDK needed: it is a format conversion plus a POST.
//
// Spans of a trace are buffered and sent together when the root span ends
// (the root always ends last). Export failures are logged and swallowed: an
// unreachable collector must never break an agent run.
import { config } from "../config";
import { jsonlSink, multiSink, type AttributeValue, type Span, type SpanKind, type SpanSink } from "./tracer";

const SERVICE_NAME = "telemetry-ops-copilot";

// OTLP enums.
const SPAN_KIND = { INTERNAL: 1, CLIENT: 3 } as const;
const STATUS = { OK: 1, ERROR: 2 } as const;
const KIND_MAP: Record<SpanKind, number> = {
  agent: SPAN_KIND.INTERNAL,
  approval: SPAN_KIND.INTERNAL,
  llm: SPAN_KIND.CLIENT, // a call out to the model API
  tool: SPAN_KIND.CLIENT, // a call out to the MCP server
};

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };

function toOtlpValue(value: AttributeValue): OtlpValue {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: value };
}

/** ISO timestamp -> nanoseconds since epoch, as a string (OTLP JSON uses strings for 64-bit ints). */
const toNanos = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

/** OTLP trace ids are 32 hex characters; our trace id is a UUID. */
const toTraceId = (id: string) => id.replace(/-/g, "").padStart(32, "0").slice(-32);

/** Build an OTLP/JSON ExportTraceServiceRequest body. */
export function toOtlp(spans: Span[]) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }] },
        scopeSpans: [
          {
            scope: { name: SERVICE_NAME },
            spans: spans.map((s) => ({
              traceId: toTraceId(s.traceId),
              spanId: s.spanId,
              parentSpanId: s.parentSpanId ?? "",
              name: s.name,
              kind: KIND_MAP[s.kind],
              startTimeUnixNano: toNanos(s.startTime),
              endTimeUnixNano: toNanos(s.endTime),
              attributes: Object.entries(s.attributes).map(([key, value]) => ({ key, value: toOtlpValue(value) })),
              status: { code: s.status === "ok" ? STATUS.OK : STATUS.ERROR },
            })),
          },
        ],
      },
    ],
  };
}

/**
 * A sink that exports each finished trace to `${endpoint}/v1/traces`.
 * `flush()` waits for in-flight exports (useful before a CLI exits, and in tests).
 */
export function otlpSink(endpoint: string): SpanSink & { flush(): Promise<void> } {
  const url = `${endpoint.replace(/\/$/, "")}/v1/traces`;
  const buffers = new Map<string, Span[]>();
  const inFlight = new Set<Promise<void>>();

  const sink = (span: Span) => {
    const buffer = buffers.get(span.traceId) ?? [];
    buffer.push(span);
    buffers.set(span.traceId, buffer);
    if (span.parentSpanId) return; // wait for the root span
    buffers.delete(span.traceId);
    const request = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toOtlp(buffer)),
    })
      .then((res) => {
        if (!res.ok) console.error(`OTLP export failed: HTTP ${res.status}`);
      })
      .catch((err: Error) => console.error(`OTLP export failed: ${err.message}`))
      .finally(() => inFlight.delete(request));
    inFlight.add(request);
  };
  return Object.assign(sink, { flush: async () => void (await Promise.all(inFlight)) });
}

/** Default sink for the CLI and server: JSONL files, plus OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set. */
export function defaultSink(traceDir: string): SpanSink & { flush(): Promise<void> } {
  const file = jsonlSink(traceDir);
  if (!config.otlpEndpoint) return Object.assign(file, { flush: async () => {} });
  const otlp = otlpSink(config.otlpEndpoint);
  return Object.assign(multiSink(file, otlp), { flush: otlp.flush });
}
