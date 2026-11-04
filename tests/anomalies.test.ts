import { describe, expect, it } from "vitest";
import { detect, ewma, median, robustStats } from "../src/data/anomalies";
import { mulberry32 } from "../src/data/seed";

// Deterministic noise around 10 with standard deviation ~1.
function noise(n: number, seed = 1): number[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, () => 10 + (rand() + rand() + rand() - 1.5) * 2);
}

describe("statistics helpers", () => {
  it("median handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("robustStats ignores a large outlier", () => {
    const { center, sigma } = robustStats([1, 2, 3, 4, 5, 1000]);
    expect(center).toBe(3.5);
    expect(sigma).toBeLessThan(5);
  });

  it("ewma smooths towards new values", () => {
    expect(ewma([10, 10], 0.5, 0)).toEqual([5, 7.5]);
  });
});

describe("detect", () => {
  it("finds nothing in pure noise", () => {
    expect(detect(noise(1440), "zscore")).toEqual([]);
    expect(detect(noise(1440), "ewma")).toEqual([]);
  });

  it("zscore finds a step change and reports it as one ongoing high event", () => {
    const values = noise(1440);
    for (let i = 1300; i < 1440; i++) values[i]! += 20;
    const events = detect(values, "zscore");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ direction: "high", endIndex: 1439 });
  });

  it("zscore ignores a single-point glitch (needs a run of 3)", () => {
    const values = noise(1440);
    values[700] = 100;
    expect(detect(values, "zscore")).toEqual([]);
  });

  it("ewma finds a slow downward drift", () => {
    const values = noise(1440);
    for (let i = 900; i < 1440; i++) values[i]! -= ((i - 900) / 540) * 6;
    const events = detect(values, "ewma");
    expect(events).toHaveLength(1);
    expect(events[0]!.direction).toBe("low");
  });

  it("returns nothing for very short series", () => {
    expect(detect([1, 100, 1], "zscore")).toEqual([]);
  });
});
