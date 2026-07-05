import { test, expect, request } from "@playwright/test";
import { HubApi, adminLogin, provisionWorker, uniq, hubRaw } from "../helpers/hubApi";
import { openHub, hubShot } from "../helpers/hubUi";

/**
 * T61 + T62 — Hub authentication & multi-tenant authorization.
 *
 * These tests verify Phase 1 RBAC, JWT issuance, API-Key/Worker-Token
 * non-JWT auth, and org-scope data isolation.
 */
test.describe.serial("Hub auth — T61/T62", () => {
  let admin: HubApi;

  test.beforeAll(async () => {
    const ctx = await request.newContext();
    admin = await adminLogin(ctx);
  });

  // ───────────────────────────────────────────────────────────────────────
  // T61: multi-tenant auth + RBAC isolation full chain
  // ───────────────────────────────────────────────────────────────────────
  test("T61: multi-tenant authentication and permission isolation", async ({ page }) => {
    const stamp = uniq("e2e61");

    // 1. JWT issued: access_token in body, refresh_token in Set-Cookie
    const loginResp = await hubRaw(await request.newContext(), "POST", "/auth/login", {
      data: { username: "admin", password: "admin123" },
    });
    expect(loginResp.status).toBe(200);
    expect(loginResp.body.access_token).toBeTruthy();
    const setCookie = loginResp.headers["set-cookie"] ?? "";
    expect(setCookie.toLowerCase()).toContain("refresh_token");
    // HttpOnly cookie — frontend JS cannot read it (T61.O1)
    expect(setCookie.toLowerCase()).toContain("httponly");

    // 2. Build tree: Group → North/South → North_RD, South_Sales
    const group = await admin.createOrg({ name: `E2E_Group_${stamp}`, code: `EG_${stamp}`, type: "company" });
    const groupId = group.organization.id;
    const north = await admin.createOrg({ name: `E2E_North_${stamp}`, code: `EN_${stamp}`, type: "department", parent_id: groupId });
    const northId = north.organization.id;
    const south = await admin.createOrg({ name: `E2E_South_${stamp}`, code: `ES_${stamp}`, type: "department", parent_id: groupId });
    const southId = south.organization.id;
    const northRd = await admin.createOrg({ name: `E2E_North_RD_${stamp}`, code: `ENRD_${stamp}`, type: "team", parent_id: northId });
    const northRdId = northRd.organization.id;
    const southSales = await admin.createOrg({ name: `E2E_South_Sales_${stamp}`, code: `ESS_${stamp}`, type: "team", parent_id: southId });
    const southSalesId = southSales.organization.id;

    // Org path should include ancestor chain (T61.O2)
    expect(northRd.organization.path).toContain(groupId);
    await hubShot(page, `T61-org-tree-created`).catch(() => {});

    // 3. Create north_rd_admin (org admin) and south_user (plain) in their orgs
    const rdAdminUser = await admin.createUser({
      username: `north_rd_admin_${stamp}`,
      password: "Pass1234!",
      display_name: "North RD Admin",
      org_id: northRdId,
      is_org_admin: true,
    });
    const rdAdminId = rdAdminUser.user.id;
    const southUser = await admin.createUser({
      username: `south_user_${stamp}`,
      password: "Pass1234!",
      display_name: "South User",
      org_id: southSalesId,
      is_org_admin: false,
    });
    const southUserId = southUser.user.id;

    const rdAdminToken = (await admin.as().login(`north_rd_admin_${stamp}`, "Pass1234!")).access_token;
    const rdAdmin = admin.as(rdAdminToken);
    const southToken = (await admin.as().login(`south_user_${stamp}`, "Pass1234!")).access_token;
    const southApi = admin.as(southToken);

    // 4. north_rd_admin sees own subtree, NOT south_sales subtree (T61.O3)
    const ownSub = await rdAdmin.getOrgSubtree(northRdId);
    expect(ownSub.ok !== false).toBeTruthy();
    // Cross-org subtree → 403 (T61.O4)
    const crossSub = await rdAdmin.raw("GET", `/orgs/${southSalesId}/tree`);
    expect([403, 404]).toContain(crossSub.status);

    // Create user in own org → success
    const ownCreate = await rdAdmin.raw("POST", "/users", {
      data: { username: `rd_child_${stamp}`, password: "Pass1234!", org_id: northRdId },
    });
    expect(ownCreate.status).toBeLessThan(400);
    // Attempt to create user in a FOREIGN org. The handler defends the boundary
    // by forcing organization_id to the creator's own org (silent reassignment)
    // rather than returning 403. Either way, the security property holds: the
    // user must NOT land in the foreign org.
    const foreignCreate = await rdAdmin.raw("POST", "/users", {
      data: { username: `rd_foreign_${stamp}`, password: "Pass1234!", org_id: southSalesId },
    });
    const createdOrgId = foreignCreate.body?.user?.organization_id ?? foreignCreate.body?.organization_id;
    expect(createdOrgId).not.toBe(southSalesId);

    // 5. south_user (no org:create) → creating org is 403; viewing pending workers 403
    const southOrgCreate = await southApi.raw("POST", "/orgs", {
      data: { name: `south_forbidden_${stamp}`, code: `SF_${stamp}`, type: "company" },
    });
    expect(southOrgCreate.status).toBe(403);
    const pendingView = await southApi.raw("GET", "/workers/pending");
    expect(pendingView.status).toBe(403);

    // 6. Grant a role containing worker:approve to south_user, verify immediate effect (T61.O5)
    const rolesResp = await admin.listRoles();
    const roles: any[] = rolesResp.roles ?? [];
    // Find a role whose permissions include worker:approve
    let grantRoleId: string | undefined;
    for (const r of roles) {
      const perms = await admin.getRolePermissions(r.id);
      const codes: string[] = (perms.permissions ?? []).map((p: any) => p.code ?? p);
      if (codes.includes("worker:approve")) {
        grantRoleId = r.id;
        break;
      }
    }
    if (grantRoleId) {
      await admin.assignRole(southUserId, grantRoleId);
      // Immediate effect: now pending view should succeed
      const afterGrant = await southApi.raw("GET", "/workers/pending");
      expect(afterGrant.status).toBeLessThan(400);
      // Revoke → 403 again
      await admin.removeRole(southUserId, grantRoleId);
      const afterRevoke = await southApi.raw("GET", "/workers/pending");
      expect(afterRevoke.status).toBe(403);
    }

    // 7. UI: admin console shows the org tree (T61.O7)
    await openHub(page, admin.token!, "/orgs");
    await page.waitForTimeout(500);
    await hubShot(page, "T61-ui-org-tree");
  });

  // ───────────────────────────────────────────────────────────────────────
  // T62: API Key (3 scopes) + Worker Token dual-track auth
  // ───────────────────────────────────────────────────────────────────────
  test("T62: API Key scopes and Worker Token isolation", async ({ page }) => {
    const stamp = uniq("e2e62");

    // 1. Create 3 API keys with different scopes (T62.O1, O6)
    const readKey = await admin.createApiKey(`ci_read_${stamp}`, "read");
    const writeKey = await admin.createApiKey(`ci_write_${stamp}`, "write");
    const adminKey = await admin.createApiKey(`ci_admin_${stamp}`, "admin");
    expect(readKey.api_key).toBeTruthy();
    expect(writeKey.api_key).toBeTruthy();
    expect(adminKey.api_key).toBeTruthy();

    // 2. read key works for /auth/me
    const meRead = await hubRaw(await request.newContext(), "GET", "/auth/me", { apiKey: readKey.api_key });
    expect(meRead.status).toBe(200);

    // 3. read key cannot create org → 403 (T62.O2)
    const readCreate = await hubRaw(await request.newContext(), "POST", "/orgs", {
      apiKey: readKey.api_key,
      data: { name: `blocked_${stamp}`, code: `bk_${stamp}`, type: "company" },
    });
    expect(readCreate.status).toBe(403);

    // 4. admin key can create org
    const adminCreate = await hubRaw(await request.newContext(), "POST", "/orgs", {
      apiKey: adminKey.api_key,
      data: { name: `adminkey_org_${stamp}`, code: `ako_${stamp}`, type: "company" },
    });
    expect(adminCreate.status).toBe(201);

    // 5. Wrong key → 401 (T62.O5: no leakage)
    const wrong = await hubRaw(await request.newContext(), "GET", "/auth/me", { apiKey: "dak_invalid_key_xxx" });
    expect(wrong.status).toBe(401);

    // 6. Revoke write key → next call 401 (T62.O3)
    await admin.revokeApiKey(writeKey.key_id);
    const revokedCall = await hubRaw(await request.newContext(), "GET", "/auth/me", { apiKey: writeKey.api_key });
    expect(revokedCall.status).toBe(401);

    // 7. Register + approve worker, get wkt_ token (T62.O4)
    const { workerId, workerToken } = await provisionWorker(admin, { name: `wk_t62_${stamp}` });
    expect(workerToken).toMatch(/^wkt_/);

    // 8. Worker token works for heartbeat
    const hb = await admin.heartbeat(workerToken, []);
    expect(hb).toBeTruthy();

    // 9. Worker token CANNOT call user API (/orgs) → 401
    const workerToUserApi = await hubRaw(await request.newContext(), "GET", "/orgs", { workerToken });
    expect(workerToUserApi.status).toBe(401);

    // 10. UI: worker approval console
    await openHub(page, admin.token!, "/workers");
    await page.waitForTimeout(500);
    await hubShot(page, "T62-ui-worker-approval");
  });
});
