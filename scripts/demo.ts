// Non-interactive demo with zero API keys: MockProvider + in-process MCP
// server. A fixed policy plays the human: it approves incidents and denies
// restarts, so you can see both outcomes of the approval gate.
import { PolicyApprover } from "../src/agent/approval";
import { formatRun } from "../src/agent/format";
import { runAgent } from "../src/agent/loop";
import { connectInProcess } from "../src/agent/mcp-client";
import { openDb } from "../src/data/db";
import { seedDatabase } from "../src/data/seed";
import { MockProvider } from "../src/llm/mock";

// Fresh in-memory fleet so the demo never modifies data/fleet.db.
const db = openDb(":memory:");
seedDatabase(db);
const mcp = await connectInProcess(db);

const approver = new PolicyApprover((request) => {
  const approved = request.tool === "create_incident";
  console.log(`  [demo operator] ${approved ? "APPROVE" : "DENY"} ${request.tool} ${JSON.stringify(request.args)}`);
  return approved;
});

const questions = [
  "Why is D-17 alerting?",
  "Which devices in the fleet have anomalies?",
  "Open an incident for D-17 and restart it",
  "Restart all devices with low battery",
];

for (const question of questions) {
  const result = await runAgent(question, { provider: new MockProvider(), mcp, approver });
  console.log(formatRun(question, result));
  console.log("-".repeat(80));
}
await mcp.close();
