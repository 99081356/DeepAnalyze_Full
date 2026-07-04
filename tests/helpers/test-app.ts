// deepanalyze-hub/tests/helpers/test-app.ts
import { Hono } from "hono";
import { createHostServerRoutes } from "../../src/server/routes/host-servers";

type Role = "super_admin" | "org_admin" | "user";

interface TestAppOpts {
  role: Role;
}

/**
 * Build a Hono app with a fake auth middleware that bypasses real JWT verification.
 * Sets the same context values that jwt-auth.ts would set.
 */
export async function createHubTestApp(opts: TestAppOpts): Promise<Hono> {
  const app = new Hono();

  // Fake auth middleware — sets context values matching jwt-auth.ts
  app.use("*", async (c, next) => {
    if (opts.role === "super_admin") {
      c.set("isSuperAdmin", true);
      c.set("userPermissions", []);
    } else if (opts.role === "org_admin") {
      c.set("isSuperAdmin", false);
      // org_admin does NOT have host_server:manage permission
      c.set("userPermissions", ["org:read", "user:read", "worker:read"]);
    } else {
      c.set("isSuperAdmin", false);
      c.set("userPermissions", ["worker:read", "skill:read"]);
    }
    c.set("userId", `test_${opts.role}`);
    c.set("userOrgId", "test_org");
    await next();
  });

  app.route("/api/v1/host-servers", createHostServerRoutes());
  return app;
}
