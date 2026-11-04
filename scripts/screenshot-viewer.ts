// Renders a trace in the static viewer with headless Chromium and saves a
// screenshot to docs/trace-viewer.png. Needs a Chromium that playwright-core can find (dev machine only):
//   npm run viewer:screenshot -- traces/<run>.jsonl
import { chromium } from "playwright-core";
import { resolve } from "node:path";

const tracePath = process.argv[2];
if (!tracePath) throw new Error("Usage: npm run viewer:screenshot -- traces/<run>.jsonl");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
await page.goto(`file://${resolve("viewer/index.html")}`);
await page.setInputFiles("#file", resolve(tracePath));
await page.waitForSelector(".span");
const rows = await page.locator(".span").count();
await page.locator(".span").nth(4).click(); // expand one span to show attributes
await page.screenshot({ path: "docs/trace-viewer.png", fullPage: true });
await browser.close();
console.log(`Rendered ${rows} spans -> docs/trace-viewer.png`);
