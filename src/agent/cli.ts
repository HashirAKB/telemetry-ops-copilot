// Ask the agent one question from the terminal.
//
//   npm run agent -- "Why is D-17 alerting?"
//   npm run agent -- "Restart D-33" --approve cli          (y/n prompt, default)
//   npm run agent -- "..." --transport stdio               (spawn MCP server)
//   npm run agent -- "..." --transport http --url http://localhost:3001/mcp
//   npm run agent -- "..." --provider anthropic            (needs ANTHROPIC_API_KEY)
import { parseArgs } from "node:util";
import { config } from "../config";
import { openSeededDb } from "../data/seed";
import { createProvider, type ProviderName } from "../llm";
import { approveAll, CliApprover, denyAll, type Approver } from "./approval";
import { AuditLog, withAudit } from "./audit";
import { formatRun } from "./format";
import { runAgent } from "./loop";
import { connectHttp, connectInProcess, connectStdio } from "./mcp-client";
import { defaultSink } from "../telemetry/otlp";
import { Tracer } from "../telemetry/tracer";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string", default: "auto" },
    transport: { type: "string", default: "inprocess" },
    url: { type: "string", default: `http://localhost:${config.mcpPort}/mcp` },
    approve: { type: "string", default: "cli" }, // cli | all | none
  },
});

const question = positionals.join(" ").trim();
if (!question) {
  console.error('Usage: npm run agent -- "Why is D-17 alerting?" [--provider mock|anthropic] [--approve cli|all|none]');
  process.exit(1);
}

const approvers: Record<string, () => Approver> = { cli: () => new CliApprover(), all: approveAll, none: denyAll };
const approver = withAudit((approvers[values.approve] ?? approvers.cli!)(), new AuditLog(config.auditDbPath));

const mcp =
  values.transport === "stdio"
    ? await connectStdio()
    : values.transport === "http"
      ? await connectHttp(values.url)
      : await connectInProcess(openSeededDb(config.dbPath));

const provider = createProvider(values.provider as ProviderName);
console.log(`provider=${provider.name} model=${provider.model} transport=${values.transport}\n`);
const sink = defaultSink("traces");
const result = await runAgent(question, { provider, mcp, approver, tracer: new Tracer(sink) });
console.log(formatRun(question, result));
console.log(`  trace: traces/${result.runId}.jsonl (open viewer/index.html to inspect)`);
await sink.flush();
await mcp.close();
