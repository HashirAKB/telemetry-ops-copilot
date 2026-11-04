import { describe, expect, it } from "vitest";
import { expandQuery, loadRunbooks, searchRunbooks, type Runbook } from "../src/data/runbooks";

const doc = (slug: string, content: string): Runbook => ({ slug, title: content.match(/^# (.+)$/m)![1]!, content });

describe("BM25 runbook ranking", () => {
  it("a rare query word beats many repetitions of a common one", () => {
    const runbooks = [
      doc("generic", "# Generic notes\n" + "device ".repeat(40)),
      doc("fan", "# Fan failure\nA failed fan makes the device overheat."),
      doc("other", "# Other\nA device note."),
    ];
    // Plain term counting ranks "generic" first (40 x "device").
    expect(searchRunbooks(runbooks, "device fan")[0]!.slug).toBe("fan");
  });

  it("prefers the shorter document when term counts are equal (length normalisation)", () => {
    const runbooks = [
      doc("long", "# Notes\nbattery " + "filler words about nothing in particular ".repeat(30)),
      doc("short", "# Notes\nbattery swap"),
      doc("unrelated", "# Unrelated\nsomething else"),
    ];
    expect(searchRunbooks(runbooks, "battery")[0]!.slug).toBe("short");
  });

  it("still matches word prefixes and boosts titles", () => {
    const runbooks = [doc("a", "# Overheating\nhot"), doc("b", "# Misc\nan overheat mention"), doc("c", "# C\nnothing")];
    expect(searchRunbooks(runbooks, "overheat").map((r) => r.slug)).toEqual(["a", "b"]);
  });
});

describe("query expansion with operator vocabulary", () => {
  const real = loadRunbooks();

  it("finds the right runbook for everyday phrasing", () => {
    expect(searchRunbooks(real, "device running too hot")[0]!.slug).toBe("overheating");
    expect(searchRunbooks(real, "unit keeps dropping offline")[0]!.slug).toBe("connectivity-loss");
    expect(searchRunbooks(real, "motor shaking")[0]!.slug).toBe("vibration-high");
    expect(searchRunbooks(real, "it keeps running out of charge")[0]!.slug).toBe("battery-low");
    expect(searchRunbooks(real, "how do I reboot a device")[0]!.slug).toBe("device-restart");
  });

  it("does not change queries that already use runbook words", () => {
    expect(expandQuery("overheating")).toEqual(["overheating"]);
    expect(expandQuery("too hot")).toEqual(["hot", "overheating", "temperature"]);
  });
});
