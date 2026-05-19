/**
 * Database migration runner for DeepAnalyze Hub.
 *
 * Runs migrations sequentially from the migrations directory.
 * Each migration is a TypeScript module exporting an `up()` function.
 */

import { query } from "../pg.js";
import { readdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  // Ensure migrations tracking table exists
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Get already-applied migrations
  const { rows } = await query<{ name: string }>(
    "SELECT name FROM _migrations ORDER BY name"
  );
  const applied = new Set(rows.map((r) => r.name));

  // List migration files (exclude runner.ts and migrate.ts)
  const migrationsDir = __dirname;
  let files: string[];
  try {
    files = (await readdir(migrationsDir))
      .filter((f) =>
        (f.endsWith(".ts") || f.endsWith(".js")) &&
        f !== "runner.ts" && f !== "migrate.ts"
      )
      .sort();
  } catch {
    console.log("[DB] No migrations found, skipping");
    return;
  }

  for (const file of files) {
    if (applied.has(file)) continue;

    console.log(`[DB] Running migration: ${file}`);
    try {
      const mod = await import(join(migrationsDir, file));
      if (typeof mod.up === "function") {
        await mod.up(query);
      }
      await query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      console.log(`[DB] Migration applied: ${file}`);
    } catch (err) {
      console.error(`[DB] Migration failed: ${file}`, err);
      throw err;
    }
  }

  console.log("[DB] Migrations complete");
}
