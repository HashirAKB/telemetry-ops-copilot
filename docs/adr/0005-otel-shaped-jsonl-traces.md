# ADR 0005: OpenTelemetry-shaped spans written to JSONL, static viewer

**Status:** accepted

## Context
Every LLM call and tool call must be observable: timing, tokens, cost, arguments, approval decisions. The project must run locally with no collector or backend.

## Decision
A small tracer (`src/telemetry/tracer.ts`) produces spans with the OpenTelemetry shape (traceId, spanId, parentSpanId, start/end, status, attributes using `gen_ai.*` names where they exist). A sink writes one JSON object per line to `traces/<runId>.jsonl`. A dependency-free HTML page (`viewer/index.html`) renders a trace as a nested timeline.

## Consequences
- Traces are plain files: easy to grep, diff, attach to a bug report, and load in tests (`memorySink`).
- The eval safety metric reads the same spans, so tracing is part of the safety story, not only debugging.
- Not wire-compatible with OTLP yet; exporting to Jaeger/Honeycomb/Grafana means adding an OTLP sink. Listed as future work.
