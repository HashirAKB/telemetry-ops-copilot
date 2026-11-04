// Live progress for runs in flight, streamed as Server-Sent Events (SSE).
//
// No new instrumentation: the tracer already emits a span whenever an LLM
// call, tool call or approval finishes. `sink` is one more trace sink that
// forwards those spans to anyone watching the run. Spans are buffered per
// run, so a client that connects late still sees the whole story.
import type { ServerResponse } from "node:http";
import type { Span, SpanSink } from "../telemetry/tracer";

interface LiveRun {
  spans: Span[];
  watchers: Set<ServerResponse>;
}

export class LiveRuns {
  private runs = new Map<string, LiveRun>();

  /** Trace sink: forward each finished span to the run's watchers. */
  readonly sink: SpanSink = (span) => {
    const run = this.runs.get(span.traceId);
    if (!run) return;
    run.spans.push(span);
    for (const res of run.watchers) writeEvent(res, "span", span);
  };

  start(runId: string): void {
    this.runs.set(runId, { spans: [], watchers: new Set() });
  }

  /** Call after the run's final state is saved: tells watchers to fetch it. */
  finish(runId: string): void {
    const run = this.runs.get(runId);
    this.runs.delete(runId);
    for (const res of run?.watchers ?? []) closeStream(res);
  }

  /** Stream a run's progress. Returns false if the run is not in flight. */
  watch(runId: string, res: ServerResponse): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const span of run.spans) writeEvent(res, "span", span); // catch up
    run.watchers.add(res);
    res.on("close", () => run.watchers.delete(res));
    return true;
  }
}

function writeEvent(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Send the final "done" event and close. Exported for runs that already finished. */
export function closeStream(res: ServerResponse) {
  if (!res.headersSent) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  }
  writeEvent(res, "done", {});
  res.end();
}
