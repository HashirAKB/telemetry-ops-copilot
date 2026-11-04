import { beforeAll, describe, expect, it } from "vitest";
import type { DB } from "../src/data/db";
import {
  createIncident,
  detectDeviceAnomalies,
  detectFleetAnomalies,
  fleetNow,
  getMetrics,
  listDevices,
  restartDevice,
} from "../src/data/queries";
import { loadRunbooks, searchRunbooks } from "../src/data/runbooks";
import { openDb } from "../src/data/db";
import { END_TS, HEALTHY_DEVICE, INJECTED_ANOMALIES, seedDatabase } from "../src/data/seed";
import { testDb } from "./helpers";

let db: DB;
beforeAll(() => {
  db = testDb();
});

describe("seed", () => {
  it("creates 50 devices with one row per device per minute", () => {
    expect(seedDatabase(openDb(":memory:"), { days: 2 })).toBe(50 * 2 * 1440);
    expect(fleetNow(db)).toBe(END_TS);
  });

  it("is deterministic for the same seed", () => {
    const a = testDb().prepare("SELECT * FROM metrics WHERE device_id = 'D-01' LIMIT 5").all();
    const b = testDb().prepare("SELECT * FROM metrics WHERE device_id = 'D-01' LIMIT 5").all();
    expect(a).toEqual(b);
  });
});

describe("listDevices", () => {
  it("returns every device with its latest reading", () => {
    const devices = listDevices(db);
    expect(devices).toHaveLength(50);
    expect(devices[0]!.latest.battery).toBeTypeOf("number");
  });

  it("filters by battery level: exactly the injected low-battery devices", () => {
    const ids = listDevices(db, { batteryBelow: 15 }).map((d) => d.id);
    expect(ids).toEqual([...INJECTED_ANOMALIES.lowBattery]);
  });
});

describe("getMetrics", () => {
  it("summarises a window and downsamples the series", () => {
    const m = getMetrics(db, INJECTED_ANOMALIES.overheating, "6h");
    expect(m.points).toBe(360);
    expect(m.series).toHaveLength(12);
    expect(m.summary.temperature!.max).toBeGreaterThan(60);
  });

  it("throws a helpful error for unknown devices", () => {
    expect(() => getMetrics(db, "D-99", "1h")).toThrow(/Unknown device "D-99"/);
  });
});

describe("anomaly detection on the seeded fleet", () => {
  it("both methods find the ongoing overheating on D-17", () => {
    for (const method of ["zscore", "ewma"] as const) {
      const found = detectDeviceAnomalies(db, INJECTED_ANOMALIES.overheating, method, "24h");
      expect(found).toEqual([expect.objectContaining({ metric: "temperature", direction: "high", ongoing: true })]);
    }
  });

  it("finds vibration drift on D-08 and signal dropout on D-33", () => {
    const found = detectFleetAnomalies(db, "ewma", "24h").map((a) => `${a.device_id}:${a.metric}`);
    expect(found).toEqual(["D-08:vibration", "D-17:temperature", "D-33:signal"]);
  });

  it("finds the historical spike on D-42 only in a long window", () => {
    expect(detectDeviceAnomalies(db, INJECTED_ANOMALIES.pastSpike, "zscore", "24h")).toEqual([]);
    const found = detectDeviceAnomalies(db, INJECTED_ANOMALIES.pastSpike, "zscore", "7d");
    expect(found).toEqual([expect.objectContaining({ metric: "temperature", ongoing: false })]);
  });

  it("does not flag a healthy device", () => {
    expect(detectDeviceAnomalies(db, HEALTHY_DEVICE, "zscore", "7d")).toEqual([]);
    expect(detectDeviceAnomalies(db, HEALTHY_DEVICE, "ewma", "7d")).toEqual([]);
  });
});

describe("write operations", () => {
  it("createIncident stores a row and returns its id", () => {
    const incident = createIncident(db, { device_id: "D-17", title: "Overheating", severity: "high", description: "70C" });
    expect(incident.incident_id).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) FROM incidents").pluck().get()).toBe(1);
  });

  it("restartDevice records an audit event and marks the device restarting", () => {
    restartDevice(db, "D-33", "radio lock-up");
    expect(db.prepare("SELECT status FROM devices WHERE id = 'D-33'").pluck().get()).toBe("restarting");
    expect(db.prepare("SELECT COUNT(*) FROM device_events WHERE device_id = 'D-33'").pluck().get()).toBe(1);
  });

  it("rejects unknown devices", () => {
    expect(() => restartDevice(db, "D-99", "x")).toThrow(/Unknown device/);
  });
});

describe("runbooks", () => {
  const runbooks = loadRunbooks();

  it("loads every markdown runbook with a title", () => {
    expect(runbooks.map((r) => r.slug)).toContain("overheating");
    expect(runbooks.every((r) => r.title.length > 0)).toBe(true);
  });

  it("ranks the most relevant runbook first", () => {
    expect(searchRunbooks(runbooks, "device overheating high temperature")[0]!.slug).toBe("overheating");
    expect(searchRunbooks(runbooks, "low battery")[0]!.slug).toBe("battery-low");
    expect(searchRunbooks(runbooks, "weak signal connectivity")[0]!.slug).toBe("connectivity-loss");
  });

  it("returns nothing for an unrelated query", () => {
    expect(searchRunbooks(runbooks, "pizza recipe")).toEqual([]);
  });
});
