// Usage: npm run seed  (writes data/fleet.db, replacing any existing file)
import { rmSync } from "node:fs";
import { config } from "../src/config";
import { openDb } from "../src/data/db";
import { seedDatabase } from "../src/data/seed";

for (const suffix of ["", "-wal", "-shm"]) rmSync(config.dbPath + suffix, { force: true });
const started = Date.now();
const db = openDb(config.dbPath);
const rows = seedDatabase(db);
db.close();
console.log(`Seeded ${config.dbPath}: ${rows} metric rows in ${Date.now() - started} ms`);
