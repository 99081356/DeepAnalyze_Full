/**
 * Global teardown: final cleanup after all e2e tests have run.
 *
 * - Sweeps any remaining test-* skills (defensive — per-test cleanup should already cover)
 * - Sweeps any test-nopub-* Phase 2 packages created by P3 fallback
 * - Restores any test-* packages flipped to is_kill_switched=true by P4
 * - Closes the DB pool
 */

import {
  sqlExec,
  cleanupTestSkills,
  cleanupTestSkillPackages,
  closePool,
} from "./fixtures.js";

async function globalTeardown(): Promise<void> {
  console.log("\n[e2e global-teardown] starting...");

  // Restore any test-* packages that P4 may have flipped to is_kill_switched=true
  const restored = await sqlExec(
    `UPDATE skill_packages SET is_kill_switched = false
     WHERE slug LIKE 'test-%' AND is_kill_switched = true
     RETURNING id, slug`
  );
  if (restored.length > 0) {
    console.log(
      `[e2e global-teardown] restored ${restored.length} test package(s) from kill-switched state`
    );
  }

  // Final sweep: test-* skills
  const skillCount = await cleanupTestSkills();
  console.log(`[e2e global-teardown] removed ${skillCount} test-* skill(s)`);

  // Final sweep: test-nopub-* packages
  await cleanupTestSkillPackages();
  console.log(`[e2e global-teardown] removed test-nopub-* package(s)`);

  await closePool();
  console.log("[e2e global-teardown] DB pool closed\n");
}

export default globalTeardown;
