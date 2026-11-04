// A tiny tracer that produces OpenTelemetry-shaped spans.
//
// A *trace* is one agent run. It is a tree of *spans*: the run itself, each
// LLM call, each tool call, each approval. Every span records when it
// started, how long it took, its parent, and key/value attributes (tokens,
// cost, tool name...). Spans are written as one JSON object per line (JSONL),
// which is easy to grep, diff, and load into the static viewer.
//
// We do not use the OpenTelemetry SDK: the shape is the same (traceId,
// spanId, parentSpanId, attributes), and swapping in a real OTLP exporter
// later only means writing a different sink.
import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export type SpanKind = "agent" | "llm" | "tool" | "approval";
export type AttributeValue = string | number | boolean;

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: string; // ISO timestamp
  endTime: string;
  durationMs: number;
  status: "ok" | "error";
  attributes: Record<string, AttributeValue>;
}

export type SpanSink = (span: Span) => void;

export class ActiveSpan {
  readonly spanId = randomBytes(8).toString("hex");
  private readonly start = Date.now();
  private readonly attributes: Record<string, AttributeValue> = {};

  constructor(
    private sink: SpanSink,
    readonly traceId: string,
    private name: string,
    private kind: SpanKind,
    private parentSpanId?: string,
  ) {}

  set(attributes: Record<string, AttributeValue | undefined>): this {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) this.attributes[key] = value;
    }
    return this;
  }

  /** Start a child span in the same trace. */
  child(name: string, kind: SpanKind): ActiveSpan {
    return new ActiveSpan(this.sink, this.traceId, name, kind, this.spanId);
  }

  end(status: "ok" | "error" = "ok"): void {
    const end = Date.now();
    this.sink({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      startTime: new Date(this.start).toISOString(),
      endTime: new Date(end).toISOString(),
      durationMs: end - this.start,
      status,
      attributes: this.attributes,
    });
  }
}

export class Tracer {
  constructor(private sink: SpanSink = () => {}) {}

  /** Start the root span of a new trace. */
  startTrace(name: string, traceId: string): ActiveSpan {
    return new ActiveSpan(this.sink, traceId, name, "agent");
  }
}

/** Writes each trace to <dir>/<traceId>.jsonl. Spans are appended as they end. */
export function jsonlSink(dir: string): SpanSink {
  mkdirSync(dir, { recursive: true });
  return (span) => appendFileSync(join(dir, `${span.traceId}.jsonl`), JSON.stringify(span) + "\n");
}

/** Keeps spans in memory (tests, evals). */
export function memorySink(spans: Span[]): SpanSink {
  return (span) => spans.push(span);
}

/** Send every span to several sinks (e.g. JSONL file + OTLP + live stream). */
export function multiSink(...sinks: SpanSink[]): SpanSink {
  return (span) => sinks.forEach((sink) => sink(span));
}
