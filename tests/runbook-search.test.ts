import { describe, expect, it } from "vitest";
import { searchRunbooks, type Runbook } from "../src/data/runbooks";

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
