// deepanalyze-hub/tests/helpers/test-app.ts
import { Hono } from "hono";
import { createHostServerRoutes } from "../../src/server/routes/host-servers";
import { getPool } from "../../src/store/pg";
import { issueTokenPair } from "../../src/domain/auth";

type Role = "super_admin" | "org_admin" | "user";

interface TestAppOpts {
  role: Role;
}

/**
 * Build a Hono app for host-servers route tests.
 *
 * Pattern (matches monitoring.test.ts / config-templates.test.ts):
 * - Seed real user rows in DB (super_admin / org_admin)
 * - Issue real JWT via issueTokenPair
 * - Mount the actual createHostServerRoutes (with real jwtAuth)
 * - Return app + access_token to pass in `Authorization: Bearer ...`
 *
 * This exercises the FULL auth chain (jwtAuth + requirePermission),
 * not a fake middleware shortcut. Required since the T21 host-servers.ts
 * jwtAuth fix — see acceptance doc P1 latent bug #1.
 */
export async function createHubTestApp(opts: TestAppOpts): Promise<{
  app: Hono;
  accessToken: string;
  userId: string;
}> {
  const app = new Hono();
  app.route("/api/v1/host-servers", createHostServerRoutes());

  const userId =
    opts.role === "super_admin"
      ? "usr_test_host_servers_super"
      : opts.role === "org_admin"
        ? "usr_test_host_servers_org"
        : "usr_test_host_servers_user";

  // Seed user + org context
  const pool = getPool();
  if (opts.role === "super_admin") {
    await pool.query(
      `INSERT INTO users (id, username, display_name, is_super_admin, status)
       VALUES ($1, $2, 'Test Super', true, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [userId, `test_${userId}`],
    );
  } else {
    // org_admin / user: seed org + assign user
    const orgId = "org_test_host_servers";
    await pool.query(
      `INSERT INTO organizations (id, name, code, parent_id, level, path, type, settings)
       VALUES ($1, 'Test Org Host Servers', 'test_host_servers', NULL, 0, $1, 'root', '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [orgId],
    );
    await pool.query(
      `INSERT INTO users (id, username, display_name, organization_id, is_org_admin, status)
       VALUES ($1, $2, 'Test Org Admin', $3, $4, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [
        userId,
        `test_${userId}`,
        orgId,
        opts.role === "org_admin",
      ],
    );
    if (opts.role === "org_admin") {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'role_org_admin')
         ON CONFLICT DO NOTHING`,
        [userId],
      );
    }
  }

  const { access_token } = await issueTokenPair(userId);
  return { app, accessToken: access_token, userId };
}
