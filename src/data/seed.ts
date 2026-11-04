// Deterministic synthetic fleet generator.
//
// The same seed always produces the same data, so tests and evals are
// reproducible on any machine. Anomalies are injected on purpose and listed
// in INJECTED_ANOMALIES so tests can check the detectors actually find them.
import { openDb, type DB } from "./db";

/** The fleet clock: all generated data ends here (2026-03-01T00:00:00Z). */
export const END_TS = Date.UTC(2026, 2, 1) / 1000;

const SITES = ["plant-a", "plant-b", "warehouse-c"];
const MODELS = ["TX-100", "TX-200"];

/** Ground truth for tests and evals. */
export const INJECTED_ANOMALIES = {
  overheating: "D-17", // temperature jumps to ~70C for the last 3 hours
  vibrationDrift: "D-08", // vibration ramps up over the last 12 hours
  signalDropout: "D-33", // signal collapses to ~-110 dBm for the last 2 hours
  pastSpike: "D-42", // 20-minute temperature spike two days before END_TS
  lowBattery: ["D-05", "D-21", "D-46"], // battery ends below 15%
} as const;

/** A device that has no injected problems; useful as a "healthy" control. */
export const HEALTHY_DEVICE = "D-02";

export interface SeedOptions {
  devices?: number;
  days?: number;
  seed?: number;
}

export function deviceId(n: number): string {
  return `D-${String(n).padStart(2, "0")}`;
}

/** mulberry32: a tiny, well-known seeded pseudo random number generator. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample via the Box-Muller transform. */
function gaussian(rand: () => number): number {
  const u = 1 - rand(); // avoid log(0)
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const round = (x: number, digits = 2) => Number(x.toFixed(digits));

/** Fill an (empty) database with devices and per-minute metrics. Returns the row count. */
export function seedDatabase(db: DB, opts: SeedOptions = {}): number {
  const devices = opts.devices ?? 50;
  const days = opts.days ?? 7;
  const rand = mulberry32(opts.seed ?? 42);
  const minutes = days * 24 * 60;
  const startTs = END_TS - (minutes - 1) * 60;

  const insertDevice = db.prepare(
    "INSERT INTO devices (id, site, model, firmware, status) VALUES (?, ?, ?, ?, 'online')",
  );
  const insertMetric = db.prepare(
    "INSERT INTO metrics (device_id, ts, temperature, vibration, battery, signal) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const lowBattery: readonly string[] = INJECTED_ANOMALIES.lowBattery;

  let rows = 0;
  // One transaction for everything: SQLite is ~100x faster than autocommit.
  db.transaction(() => {
    for (let n = 1; n <= devices; n++) {
      const id = deviceId(n);
      insertDevice.run(id, SITES[n % SITES.length], MODELS[n % MODELS.length], n % 5 === 0 ? "1.4.2" : "1.5.0");

      // Per-device baselines so the fleet is not identical.
      const baseTemp = 32 + rand() * 8; // 32..40 C
      const baseVib = 1.5 + rand() * 1.0; // 1.5..2.5 mm/s
      const baseSignal = -75 + rand() * 15; // -75..-60 dBm
      const drainPerMin = (0.1 + rand() * 0.15) / 60; // 0.10..0.25 %/hour
      // Low-battery devices start low enough to finish under 15%.
      const startBattery = lowBattery.includes(id)
        ? 8 + drainPerMin * minutes + rand() * 4
        : 70 + rand() * 30;

      for (let i = 0; i < minutes; i++) {
        const ts = startTs + i * 60;
        const minutesToEnd = minutes - 1 - i;
        const dayPhase = (2 * Math.PI * (ts % 86400)) / 86400;

        let temperature = baseTemp + 0.8 * Math.sin(dayPhase) + 0.4 * gaussian(rand);
        let vibration = baseVib + 0.15 * gaussian(rand);
        const battery = Math.max(0, startBattery - drainPerMin * i + 0.05 * gaussian(rand));
        let signal = baseSignal + 2 * gaussian(rand);

        // Injected anomalies (times are relative to the end of the data).
        if (id === INJECTED_ANOMALIES.overheating && minutesToEnd < 180) {
          temperature += 30 + 2 * gaussian(rand);
        }
        if (id === INJECTED_ANOMALIES.vibrationDrift && minutesToEnd < 720) {
          vibration += ((720 - minutesToEnd) / 720) * 4; // ramps up to +4 mm/s
        }
        if (id === INJECTED_ANOMALIES.signalDropout && minutesToEnd < 120) {
          signal = -110 + 2 * gaussian(rand);
        }
        const spikeStart = 2 * 24 * 60;
        if (id === INJECTED_ANOMALIES.pastSpike && minutesToEnd < spikeStart && minutesToEnd >= spikeStart - 20) {
          temperature += 25;
        }

        insertMetric.run(id, ts, round(temperature), round(vibration), round(battery), round(signal));
        rows++;
      }
    }
  })();
  return rows;
}

/** Open the database at `path`, seeding it first if it has no data yet. */
export function openSeededDb(path: string): DB {
  const db = openDb(path);
  const hasData = db.prepare("SELECT 1 FROM metrics LIMIT 1").get();
  if (!hasData) seedDatabase(db);
  return db;
}
