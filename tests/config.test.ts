import { describe, expect, it } from "vitest";
import { config } from "../src/config";

describe("config", () => {
  it("has local defaults so the project runs with zero setup", () => {
    expect(config.dbPath).toMatch(/\.db$/);
    expect(config.mcpPort).toBeGreaterThan(0);
  });
});
