/**
 * Standalone migration runner.
 * Usage: bun run src/store/migrate.ts
 */

import { runMigrations } from "./migrations/runner.js";
import { closePool } from "./pg.js";

runMigrations()
  .then(() => {
    console.log("All migrations applied successfully");
    return closePool();
  })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
