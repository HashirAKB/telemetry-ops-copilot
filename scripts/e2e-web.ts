// Browser end-to-end test of the React page (needs `npm run web:build` first
// and a Chromium that playwright-core can find).
//
// Starts the agent API on a random port with a fresh in-memory fleet, sends a
// message from the page, approves the incident and denies the restart, then
// checks the answer on screen AND the database.
//   npm run test:e2e
import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";
import { createAgentApi } from "../src/agent/http-api";
import { connectInProcess } from "../src/agent/mcp-client";
import { openDb } from "../src/data/db";
import { seedDatabase } from "../src/data/seed";
import { MockProvider } from "../src/llm/mock";

const db = openDb(":memory:");
seedDatabase(db, { days: 2 });
const mcp = await connectInProcess(db);
const server = createAgentApi({ mcp, createProvider: () => new MockProvider(), traceDir: "traces" });
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(base);
  await page.getByLabel("Message").fill("Open an incident for D-17 and restart it");
  await page.getByRole("button", { name: "Send" }).click();

  const approvals = page.getByLabel("Pending approvals");
  await approvals.getByText("create_incident").waitFor();
  await approvals.getByRole("button", { name: "Approve" }).click();

  await approvals.getByText("restart_device").waitFor();
  await page.screenshot({ path: "docs/web-ui-approval.png" });
  await approvals.getByRole("button", { name: "Deny" }).click();

  const answer = page.getByTestId("answer");
  await answer.waitFor();
  const text = await answer.innerText();
  await page.screenshot({ path: "docs/web-ui.png", fullPage: true });

  const incidents = db.prepare("SELECT COUNT(*) FROM incidents").pluck().get();
  const restarts = db.prepare("SELECT COUNT(*) FROM device_events").pluck().get();
  if (!text.includes("Opened incident") || !text.includes("NOT performed") || incidents !== 1 || restarts !== 0) {
    throw new Error(`Unexpected outcome: incidents=${incidents} restarts=${restarts} answer=${text}`);
  }
  console.log("E2E passed: incident approved and created, restart denied and not performed.");

  // Second scenario: the API requires a token; the page asks for it.
  const secured = createAgentApi({ mcp, createProvider: () => new MockProvider(), traceDir: "traces", apiToken: "e2e-token" });
  await new Promise<void>((resolve) => secured.listen(0, resolve));
  try {
    const page2 = await browser.newPage();
    await page2.goto(`http://localhost:${(secured.address() as AddressInfo).port}`);
    await page2.getByLabel("API token").fill("e2e-token");
    await page2.getByRole("button", { name: "Save" }).click();
    await page2.getByLabel("Message").fill("Why is D-17 alerting?");
    await page2.getByRole("button", { name: "Send" }).click();
    await page2.getByTestId("answer").waitFor();
    console.log("E2E passed: token prompt shown, token accepted, chat works with auth.");
  } finally {
    secured.close();
  }
} finally {
  await browser.close();
  server.close();
  await mcp.close();
}
