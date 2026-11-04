import { openDb, type DB } from "../src/data/db";
import { seedDatabase } from "../src/data/seed";

/** A fresh in-memory fleet: 50 devices, 3 days (enough to include every injected anomaly). */
export function testDb(): DB {
  const db = openDb(":memory:");
  seedDatabase(db, { days: 3 });
  return db;
}
