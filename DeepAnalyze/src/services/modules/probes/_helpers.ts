// src/services/modules/probes/_helpers.ts
import { getPool } from "../../../store/pg.js";
import { PgModuleStatesRepo, type ModuleId } from "../../../store/repos/module-states.js";

/**
 * Load a module state row. Returns null if not installed.
 * (Inline pattern matches src/server/routes/modules.ts:25 convention.)
 */
export async function loadModuleState(moduleId: ModuleId) {
  const pool = await getPool();
  const repo = new PgModuleStatesRepo(pool);
  return repo.get(moduleId);
}

/**
 * For not_installed / disabled modules, return an "unknown" health record.
 * For installed modules, return null (caller should do real probe).
 */
export function unknownHealth(mode: "local" | "remote" | "disabled" | undefined) {
  return {
    status: "unknown" as const,
    mode: mode ?? "disabled",
    last_check_at: new Date().toISOString(),
  };
}
