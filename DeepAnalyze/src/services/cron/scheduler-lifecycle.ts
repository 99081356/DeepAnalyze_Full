// =============================================================================
// DeepAnalyze - CronScheduler Lifecycle
// Singleton lifecycle management for the CronScheduler.
// Separated from scheduler.ts to avoid circular imports.
// =============================================================================

import { CronScheduler } from "./scheduler.js";

let instance: CronScheduler | null = null;

/**
 * Start the CronScheduler singleton.
 * Called at server boot after the agent system is pre-warmed.
 */
export function startCronScheduler(): void {
  if (instance) return;
  instance = new CronScheduler();
  instance.start();
}

/**
 * Get the current CronScheduler instance (may be null if not started).
 */
export function getCronScheduler(): CronScheduler | null {
  return instance;
}
