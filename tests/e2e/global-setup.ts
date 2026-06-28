/**
 * Global setup: pre-flight checks before any e2e test runs.
 *
 * Verifies:
 * 1. Hub backend on :22000 is up (refuses to start if not)
 * 2. Admin login works (caches token for tests that want it)
 * 3. Seed data presence (sets HUB_HAS_SEED_DATA env var for gated tests)
 * 4. Pre-cleans any leftover test-* skills from prior aborted runs
 */

import { sqlExec, cleanupTestSkills } from "./fixtures.js";

async function globalSetup(): Promise<void> {
  console.log("\n[e2e global-setup] starting...");

  // ─── 1. Backend health check ───────────────────────────────────────
  try {
    const resp = await fetch("http://localhost:22000/api/health", {
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    console.log("[e2e global-setup] backend health OK");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Hub backend not reachable at http://localhost:22000/api/health (${msg}).\n` +
        `Start it with: cd /mnt/d/code/deepanalyze/deepanalyze-hub && bun run src/main.ts\n` +
        `Or set PW_NO_BACKEND=1 if you intend to skip backend-dependent tests.`
    );
  }

  // ─── 2. Admin login works ──────────────────────────────────────────
  try {
    const resp = await fetch("http://localhost:22000/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const body = (await resp.json()) as { access_token: string };
    process.env.HUB_ADMIN_TOKEN = body.access_token;
    console.log("[e2e global-setup] admin login OK (token cached)");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Admin login failed (${msg}). Verify migration 008 ran (admin/admin123).`
    );
  }

  // ─── 3. Seed data detection ────────────────────────────────────────
  const promotableRows = await sqlExec<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM skill_packages p
     WHERE p.is_kill_switched = false
       AND EXISTS (
         SELECT 1 FROM skill_versions v
         WHERE v.package_id = p.id AND v.status = 'published'
       )`
  );
  const promotable = Number(promotableRows[0]?.count ?? "0");
  process.env.HUB_HAS_SEED_DATA = promotable > 0 ? "1" : "0";
  console.log(
    `[e2e global-setup] promotable Phase 2 packages: ${promotable} (HUB_HAS_SEED_DATA=${process.env.HUB_HAS_SEED_DATA})`
  );

  // Also detect non-admin users (for permission tests)
  const userRows = await sqlExec<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM users
     WHERE is_super_admin = false AND auth_source = 'local'
     LIMIT 1`
  );
  const nonAdminCount = Number(userRows[0]?.count ?? "0");
  process.env.HUB_HAS_NON_ADMIN = nonAdminCount > 0 ? "1" : "0";
  console.log(
    `[e2e global-setup] non-admin local users: ${nonAdminCount} (HUB_HAS_NON_ADMIN=${process.env.HUB_HAS_NON_ADMIN})`
  );

  // ─── 4. Pre-clean leftover test data ───────────────────────────────
  const removed = await cleanupTestSkills();
  if (removed > 0) {
    console.log(`[e2e global-setup] cleaned ${removed} leftover test-* skill(s)`);
  }

  // Also clean any leftover test-nopub-* packages from prior P3 runs
  await sqlExec(`DELETE FROM skill_packages WHERE slug LIKE 'test-nopub-%'`);

  // Clean orphan promoted skills (source_package_id set, slug NOT 'test-*')
  // left over from prior aborted runs of promote.spec.ts — prevents 409
  // collisions when promotablePackage() picks the same seed package again.
  const orphanRows = await sqlExec<{ id: string; slug: string }>(
    `DELETE FROM marketplace_skills
     WHERE source_package_id IS NOT NULL
       AND slug NOT LIKE 'test-%'
     RETURNING id, slug`
  );
  if (orphanRows.length > 0) {
    console.log(
      `[e2e global-setup] cleaned ${orphanRows.length} orphan promoted skill(s) from prior runs`
    );
  }

  // ─── 5. Ensure controlled non-admin user exists for permission tests ─
  // Create test-noperm user with NO skill:approve permission.
  // Idempotent — password reset to Test1234! each run.
  const bcrypt = (await import("bcrypt")).default;
  const hash = bcrypt.hashSync("Test1234!", 10);
  await sqlExec(
    `INSERT INTO users (id, username, display_name, password_hash, role, status,
                        auth_source, is_super_admin, is_org_admin)
     VALUES ('u_test_noperm', 'test-noperm', 'Test NoPerm', $1,
             'user', 'active', 'local', false, false)
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [hash]
  );
  // Ensure no role assignments grant skill:approve (clear any leftover)
  await sqlExec(
    `DELETE FROM user_roles WHERE user_id = 'u_test_noperm'`
  );
  process.env.HUB_NON_ADMIN_USER = "test-noperm";
  process.env.HUB_NON_ADMIN_PASS = "Test1234!";
  process.env.HUB_HAS_NON_ADMIN = "1";
  console.log("[e2e global-setup] test-noperm user ready (no skill:approve)");

  console.log("[e2e global-setup] ready\n");
}

export default globalSetup;
