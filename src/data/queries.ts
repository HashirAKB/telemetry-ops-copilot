// All reads and writes the tools need. Each function takes the database as
// its first argument (no globals), which makes it trivial to test against an
// in-memory database.
import type { DB } from "./db";
import { detect, type Method } from "./anomalies";

const METRICS = ["temperature", "vibration", "battery", "signal"] as const;
export type Metric = (typeof METRICS)[number];

const WINDOWS = { "1h": 3600, "6h": 6 * 3600, "24h": 24 * 3600, "7d": 7 * 24 * 3600 } as const;
export type Window = keyof typeof WINDOWS;

interface MetricRow {
  ts: number;
  temperature: number;
  vibration: number;
  battery: number;
  signal: number;
}

export interface Device {
  id: string;
  site: string;
  model: string;
  firmware: string;
  status: string;
}

const iso = (ts: number) => new Date(ts * 1000).toISOString();
const round = (x: number) => Number(x.toFixed(2));

/** "Now" for every query: the newest metric timestamp in the database. */
export function fleetNow(db: DB): number {
  const row = db.prepare("SELECT MAX(ts) AS ts FROM metrics").get() as { ts: number | null };
  if (row.ts === null) throw new Error("Database has no metrics. Run `npm run seed` first.");
  return row.ts;
}

function getDevice(db: DB, id: string): Device {
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Device | undefined;
  if (!device) throw new Error(`Unknown device "${id}". Use list_devices to see valid ids.`);
  return device;
}

export interface DeviceFilter {
  site?: string;
  batteryBelow?: number;
}

/** All devices with their latest reading, optionally filtered. */
export function listDevices(db: DB, filter: DeviceFilter = {}) {
  const now = fleetNow(db);
  const rows = db
    .prepare(
      `SELECT d.*, m.temperature, m.vibration, m.battery, m.signal
       FROM devices d LEFT JOIN metrics m ON m.device_id = d.id AND m.ts = ?
       ORDER BY d.id`,
    )
    .all(now) as (Device & MetricRow)[];
  return rows
    .filter((r) => filter.site === undefined || r.site === filter.site)
    .filter((r) => filter.batteryBelow === undefined || r.battery < filter.batteryBelow)
    .map((r) => ({
      id: r.id,
      site: r.site,
      model: r.model,
      firmware: r.firmware,
      status: r.status,
      latest: { temperature: r.temperature, vibration: r.vibration, battery: r.battery, signal: r.signal },
    }));
}

function readMetrics(db: DB, deviceId: string, window: Window): MetricRow[] {
  getDevice(db, deviceId); // throws a helpful error for unknown ids
  const now = fleetNow(db);
  return db
    .prepare(
      `SELECT ts, temperature, vibration, battery, signal FROM metrics
       WHERE device_id = ? AND ts > ? AND ts <= ? ORDER BY ts`,
    )
    .all(deviceId, now - WINDOWS[window], now) as MetricRow[];
}

/**
 * Summary statistics plus a downsampled series (at most `buckets` points).
 * Returning 1,440 raw points per day would waste the LLM's context window.
 */
export function getMetrics(db: DB, deviceId: string, window: Window, buckets = 12) {
  const rows = readMetrics(db, deviceId, window);
  const summary = Object.fromEntries(
    METRICS.map((m) => {
      const values = rows.map((r) => r[m]);
      return [
        m,
        {
          min: round(Math.min(...values)),
          max: round(Math.max(...values)),
          avg: round(values.reduce((a, b) => a + b, 0) / values.length),
          latest: values[values.length - 1],
        },
      ];
    }),
  );
  const size = Math.ceil(rows.length / buckets);
  const series = [];
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const avg = (m: Metric) => round(chunk.reduce((a, r) => a + r[m], 0) / chunk.length);
    series.push({
      from: iso(chunk[0]!.ts),
      temperature: avg("temperature"),
      vibration: avg("vibration"),
      battery: avg("battery"),
      signal: avg("signal"),
    });
  }
  return { device_id: deviceId, window, from: iso(rows[0]!.ts), to: iso(rows.at(-1)!.ts), points: rows.length, summary, series };
}

export interface Anomaly {
  device_id: string;
  metric: Metric;
  start: string;
  end: string;
  peak_value: number;
  direction: "high" | "low";
  score: number;
  ongoing: boolean; // true when the anomaly lasts until the latest reading
}

/** Run a detector over every metric of one device. */
export function detectDeviceAnomalies(db: DB, deviceId: string, method: Method, window: Window): Anomaly[] {
  const rows = readMetrics(db, deviceId, window);
  const anomalies: Anomaly[] = [];
  for (const metric of METRICS) {
    for (const e of detect(rows.map((r) => r[metric]), method)) {
      anomalies.push({
        device_id: deviceId,
        metric,
        start: iso(rows[e.startIndex]!.ts),
        end: iso(rows[e.endIndex]!.ts),
        peak_value: e.peakValue,
        direction: e.direction,
        score: e.score,
        ongoing: e.endIndex === rows.length - 1,
      });
    }
  }
  return anomalies;
}

/** Run a detector over the whole fleet. */
export function detectFleetAnomalies(db: DB, method: Method, window: Window): Anomaly[] {
  const ids = db.prepare("SELECT id FROM devices ORDER BY id").pluck().all() as string[];
  return ids.flatMap((id) => detectDeviceAnomalies(db, id, method, window));
}

type Severity = "low" | "medium" | "high" | "critical";

export function createIncident(
  db: DB,
  input: { device_id: string; title: string; severity: Severity; description: string },
) {
  getDevice(db, input.device_id);
  const createdAt = fleetNow(db);
  const result = db
    .prepare("INSERT INTO incidents (device_id, title, severity, description, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(input.device_id, input.title, input.severity, input.description, createdAt);
  return { incident_id: Number(result.lastInsertRowid), ...input, created_at: iso(createdAt) };
}

/** Simulated restart: records an audit event and marks the device as restarting. */
export function restartDevice(db: DB, deviceId: string, reason: string) {
  getDevice(db, deviceId);
  const createdAt = fleetNow(db);
  db.prepare("INSERT INTO device_events (device_id, type, reason, created_at) VALUES (?, 'restart', ?, ?)").run(
    deviceId,
    reason,
    createdAt,
  );
  db.prepare("UPDATE devices SET status = 'restarting' WHERE id = ?").run(deviceId);
  return { device_id: deviceId, status: "restarting", reason, requested_at: iso(createdAt) };
}
