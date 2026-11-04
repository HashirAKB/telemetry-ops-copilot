import { describe, expect, it } from "vitest";
import { PolicyApprover } from "../src/agent/approval";
import { AuditLog, withAudit } from "../src/agent/audit";
import { HttpApprover } from "../src/agent/http-approver";

describe("approval audit log", () => {
  it("records every decision of the wrapped approver, newest first", async () => {
    const log = new AuditLog(":memory:");
    const approver = withAudit(new PolicyApprover((r) => r.tool === "create_incident"), log);

    const first = await approver.approve({ runId: "run-1", tool: "create_incident", args: { device_id: "D-17" } });
    const second = await approver.approve({ runId: "run-1", tool: "restart_device", args: { device_id: "D-17" } });

    expect(first.approved).toBe(true);
    expect(second.approved).toBe(false);
    expect(log.recent()).toMatchObject([
      { run_id: "run-1", tool: "restart_device", approved: 0, decided_by: "policy", args: '{"device_id":"D-17"}' },
      { run_id: "run-1", tool: "create_incident", approved: 1, decided_by: "policy" },
    ]);
  });

  it("records timeouts as denials", async () => {
    const log = new AuditLog(":memory:");
    await withAudit(new HttpApprover(10), log).approve({ runId: "r", tool: "restart_device", args: {} });
    expect(log.recent()[0]).toMatchObject({ approved: 0, decided_by: "timeout" });
  });
});
