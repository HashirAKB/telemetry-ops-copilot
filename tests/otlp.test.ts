import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { otlpSink, toOtlp } from "../src/telemetry/otlp";
import { memorySink, multiSink, Tracer, type Span } from "../src/telemetry/tracer";

const TRACE_ID = "3111dee4-e5d6-4f06-a628-262e9db50573";

function sampleTrace(sink: (span: Span) => void) {
  const root = new Tracer(sink).startTrace("agent.run", TRACE_ID).set({ "agent.question": "q" });
  root.child("tool.restart_device", "tool").set({ "tool.status": "denied", "gen_ai.usage.input_tokens": 12, cost: 0.5, ok: false }).end("error");
  root.end();
}

describe("OTLP export", () => {
  it("converts spans to the OTLP/JSON shape", () => {
    const spans: Span[] = [];
    sampleTrace(memorySink(spans));
    const body = toOtlp(spans);
    const [tool, root] = body.resourceSpans[0]!.scopeSpans[0]!.spans;

    expect(body.resourceSpans[0]!.resource.attributes[0]).toEqual({ key: "service.name", value: { stringValue: "telemetry-ops-copilot" } });
    expect(root!.traceId).toBe("3111dee4e5d64f06a628262e9db50573");
    expect(root!.traceId).toHaveLength(32);
    expect(root!.parentSpanId).toBe("");
    expect(tool!.parentSpanId).toBe(root!.spanId);
    expect(tool!.kind).toBe(3); // CLIENT
    expect(tool!.status).toEqual({ code: 2 }); // ERROR
    expect(tool!.attributes).toEqual([
      { key: "tool.status", value: { stringValue: "denied" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: "12" } },
      { key: "cost", value: { doubleValue: 0.5 } },
      { key: "ok", value: { boolValue: false } },
    ]);
    expect(BigInt(root!.endTimeUnixNano) >= BigInt(root!.startTimeUnixNano)).toBe(true);
    expect(root!.startTimeUnixNano.endsWith("000000")).toBe(true); // ms precision
  });

  it("posts one request per trace, after the root span ends", async () => {
    const bodies: unknown[] = [];
    const paths: string[] = [];
    const collector = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        paths.push(req.url ?? "");
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, resolve));
    try {
      const sink = otlpSink(`http://localhost:${(collector.address() as AddressInfo).port}/`);
      const local: Span[] = [];
      sampleTrace(multiSink(sink, memorySink(local)));
      await sink.flush();
      expect(paths).toEqual(["/v1/traces"]);
      expect(local).toHaveLength(2);
      const spans = (bodies[0] as ReturnType<typeof toOtlp>).resourceSpans[0]!.scopeSpans[0]!.spans;
      expect(spans.map((s) => s.name)).toEqual(["tool.restart_device", "agent.run"]);
    } finally {
      collector.close();
    }
  });

  it("never throws when the collector is unreachable", async () => {
    const sink = otlpSink("http://127.0.0.1:9");
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      sampleTrace(sink);
      await sink.flush();
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
  });
});
