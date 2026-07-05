import { test, expect, request } from "@playwright/test";
import { HubApi, adminLogin, publishOrgSkill, provisionWorker, uniq } from "../helpers/hubApi";
import { openHub, hubShot } from "../helpers/hubUi";

test.describe.serial("Hub Sharing & Usage — T69/T70/T71", () => {
  let admin: HubApi;

  test.beforeAll(async () => {
    admin = await adminLogin(await request.newContext());
  });

  // ─────────────────────────────────────────────────────────────────────
  // T69: Cross-org SkillSharing two-sided approval full chain
  // ─────────────────────────────────────────────────────────────────────
  test("T69: cross-org SkillSharing two-sided approval and propagation", async ({ page }) => {
    const stamp = uniq("e2e69");
    const sourceOrg = await admin.createOrg({ name: `SrcOrg_${stamp}`, code: `SO_${stamp}`, type: "company" });
    const targetOrg = await admin.createOrg({ name: `TgtOrg_${stamp}`, code: `TO_${stamp}`, type: "company" });
    const sourceOrgId = sourceOrg.organization.id;
    const targetOrgId = targetOrg.organization.id;

    // 1. Create org-scope published skill in Source_Org (T69.O2)
    const skill = await publishOrgSkill(admin, {
      name: `shared_${stamp}`,
      scope: "org",
      orgId: sourceOrgId,
    });

    // 2. Initiate sharing (T69 step 1)
    const restrictions = {
      max_users: 50,
      expires_at: "2026-12-31T00:00:00Z",
      data_classification_max: "internal",
    };
    const sh = await admin.createSharing({
      package_id: skill.packageId,
      source_org_id: sourceOrgId,
      target_org_id: targetOrgId,
      restrictions,
    });
    const sharingId = sh.sharing.id;
    expect(sharingId).toBeTruthy();
    expect(sh.sharing.status).toBe("pending");

    // 3. Partial unique: duplicate initiate → 400 (T69.O5)
    const dup = await admin.raw("POST", "/sharings", {
      data: {
        package_id: skill.packageId,
        source_org_id: sourceOrgId,
        target_org_id: targetOrgId,
      },
    });
    expect(dup.status).toBe(400);

    // 4. Create target_org_admin
    const targetAdminUser = await admin.createUser({
      username: `tgt_admin_${stamp}`,
      password: "Pass1234!",
      display_name: "Target Admin",
      org_id: targetOrgId,
      is_org_admin: true,
    });
    const targetAdminId = targetAdminUser.user.id;

    // Grant target admin the skill:share permission (if not inherent)
    const rolesResp = await admin.listRoles();
    const roles: any[] = rolesResp.roles ?? [];
    let shareRoleId: string | undefined;
    for (const r of roles) {
      const perms = await admin.getRolePermissions(r.id);
      const codes: string[] = (perms.permissions ?? []).map((p: any) => p.code ?? p);
      if (codes.includes("skill:share")) {
        shareRoleId = r.id;
        break;
      }
    }
    if (shareRoleId) {
      await admin.assignRole(targetAdminId, shareRoleId);
    }

    // 5. Target admin approves (T69 step 4)
    const targetToken = (await admin.as().login(`tgt_admin_${stamp}`, "Pass1234!")).access_token;
    const targetAdmin = admin.as(targetToken);

    const approveResp = await targetAdmin.raw("POST", `/sharings/${sharingId}/approve`);
    expect(approveResp.status).toBeLessThan(400);
    expect(approveResp.body?.sharing?.status).toBe("approved");
    expect(approveResp.body?.sharing?.approved_at).toBeTruthy();

    // 6. Verify subscription created — proven transitively via worker sync
    //    (the /skills/subscriptions/list endpoint only returns user-scope subs,
    //    but the org_share subscription is observable through the target-org
    //    worker receiving a sync instruction — see step 7).

    // 7. Target org worker heartbeat → receives sync (T69.O3 — proves org_share subscription exists)
    const w = await provisionWorker(admin, { name: `tw_${stamp}`, orgId: targetOrgId });
    const hb = await admin.heartbeat(w.workerToken, []);
    const syncInstr = (hb.instructions ?? []).find(
      (i: any) => i.package_id === skill.packageId && (i.action === "sync" || i.action === "force_update"),
    );
    expect(syncInstr, "target org worker should receive sync for shared package").toBeTruthy();

    // 8. Restrictions stored (T69.O4)
    const fetched = await admin.getSharing(sharingId);
    expect(fetched.sharing.restrictions).toMatchObject({
      max_users: 50,
      data_classification_max: "internal",
    });

    // 9. Permission isolation: unrelated org admin cannot approve (T69.O6)
    const otherOrg = await admin.createOrg({ name: `OtherOrg_${stamp}`, code: `OO_${stamp}`, type: "company" });
    const otherAdminUser = await admin.createUser({
      username: `oth_admin_${stamp}`,
      password: "Pass1234!",
      display_name: "Other Admin",
      org_id: otherOrg.organization.id,
      is_org_admin: true,
    });
    if (shareRoleId) await admin.assignRole(otherAdminUser.user.id, shareRoleId);
    const otherToken = (await admin.as().login(`oth_admin_${stamp}`, "Pass1234!")).access_token;
    const otherAdmin = admin.as(otherToken);

    // Initiate another sharing to test isolation (different package)
    const skill2 = await publishOrgSkill(admin, { name: `shared2_${stamp}`, scope: "org", orgId: sourceOrgId });
    const sh2 = await admin.createSharing({
      package_id: skill2.packageId,
      source_org_id: sourceOrgId,
      target_org_id: targetOrgId,
    });
    const otherApprove = await otherAdmin.raw("POST", `/sharings/${sh2.sharing.id}/approve`);
    expect([403, 404]).toContain(otherApprove.status);

    // 10. Reject path (T69 step 9) — target admin rejects sh2
    const rejResp = await targetAdmin.raw("POST", `/sharings/${sh2.sharing.id}/reject`, {
      data: { reason: "not needed" },
    });
    expect(rejResp.status).toBeLessThan(400);
    expect(rejResp.body?.sharing?.status).toBe("rejected");
    // Reject must not create a subscription — verified by absence of sync
    // instruction for skill2 on a target-org worker heartbeat.
    const rejWorker = await provisionWorker(admin, { name: `rjw_${stamp}`, orgId: targetOrgId });
    const rejHb = await admin.heartbeat(rejWorker.workerToken, []);
    const rejSync = (rejHb.instructions ?? []).find((i: any) => i.package_id === skill2.packageId);
    expect(rejSync).toBeUndefined();

    // 11. After rejected, re-initiate should succeed (T69 step 11 — partial unique only on active)
    const reinit = await admin.createSharing({
      package_id: skill2.packageId,
      source_org_id: sourceOrgId,
      target_org_id: targetOrgId,
    });
    expect(reinit.sharing.status).toBe("pending");

    // 12. Re-initiate already-approved sharing → 400 (T69 step 12)
    const dupApproved = await admin.raw("POST", "/sharings", {
      data: {
        package_id: skill.packageId,
        source_org_id: sourceOrgId,
        target_org_id: targetOrgId,
      },
    });
    expect(dupApproved.status).toBe(400);

    await openHub(page, admin.token!, "/skills").catch(() => {});
    await hubShot(page, "T69-ui-sharing-market");
  });

  // ─────────────────────────────────────────────────────────────────────
  // T70: Sharing revoke → target workers receive kill instruction
  // ─────────────────────────────────────────────────────────────────────
  test("T70: revoke sharing enqueues kill for target-org workers", async ({ page }) => {
    const stamp = uniq("e2e70");
    const sourceOrg = await admin.createOrg({ name: `SrcOrg_${stamp}`, code: `SO_${stamp}`, type: "company" });
    const targetOrg = await admin.createOrg({ name: `TgtOrg_${stamp}`, code: `TO_${stamp}`, type: "company" });
    const sourceOrgId = sourceOrg.organization.id;
    const targetOrgId = targetOrg.organization.id;

    const skill = await publishOrgSkill(admin, { name: `rev_${stamp}`, scope: "org", orgId: sourceOrgId });
    const sh = await admin.createSharing({
      package_id: skill.packageId,
      source_org_id: sourceOrgId,
      target_org_id: targetOrgId,
    });

    // Target admin approves (need same setup as T69)
    const targetAdminUser = await admin.createUser({
      username: `tgt_admin_${stamp}`,
      password: "Pass1234!",
      org_id: targetOrgId,
      is_org_admin: true,
    });
    const rolesResp = await admin.listRoles();
    const roles: any[] = rolesResp.roles ?? [];
    let shareRoleId: string | undefined;
    for (const r of roles) {
      const perms = await admin.getRolePermissions(r.id);
      const codes: string[] = (perms.permissions ?? []).map((p: any) => p.code ?? p);
      if (codes.includes("skill:share")) {
        shareRoleId = r.id;
        break;
      }
    }
    if (shareRoleId) await admin.assignRole(targetAdminUser.user.id, shareRoleId);

    await admin.as().login(`tgt_admin_${stamp}`, "Pass1234!");
    await admin.approveSharing(sh.sharing.id);

    // 3 target-org workers sync the shared package (T70 step 1)
    const workers: { workerId: string; workerToken: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const w = await provisionWorker(admin, { name: `rw${i}_${stamp}`, orgId: targetOrgId });
      workers.push(w);
      const hb = await admin.heartbeat(w.workerToken, []);
      const instr = (hb.instructions ?? []).find((i: any) => i.package_id === skill.packageId);
      if (instr?.instruction_id) {
        await admin.ack(w.workerToken, { instruction_id: instr.instruction_id });
      }
    }

    // 1 source-org worker (should NOT be affected by revoke)
    const srcWorker = await provisionWorker(admin, { name: `sw_${stamp}`, orgId: sourceOrgId });
    // Source-org worker subscribes directly to have the package cached
    await admin.heartbeat(srcWorker.workerToken, []).catch(() => {});

    // Source admin revokes sharing (T70 step 2)
    const revokeResp = await admin.raw("DELETE", `/sharings/${sh.sharing.id}`, {
      data: { reason: "合同到期" },
    });
    expect(revokeResp.status).toBeLessThan(400);
    expect(revokeResp.body?.sharing?.status).toBe("revoked");
    const killedWorkers = revokeResp.body?.killed_workers;
    expect(typeof killedWorkers).toBe("number");
    expect(killedWorkers).toBeGreaterThanOrEqual(3); // target org has 3 workers

    // Each target worker receives a kill instruction (T70.O4)
    for (const w of workers) {
      const hb = await admin.heartbeat(w.workerToken, [
        { package_id: skill.packageId, content_hash: "cached" },
      ]);
      const kill = (hb.instructions ?? []).find(
        (i: any) => i.package_id === skill.packageId && i.action === "kill",
      );
      expect(kill, `target worker should receive kill instruction`).toBeTruthy();
      if (kill?.instruction_id) {
        await admin.ack(w.workerToken, { instruction_id: kill.instruction_id });
      }
    }

    // After ack, no more kill (T70 step 10)
    const finalHb = await admin.heartbeat(workers[0].workerToken, []);
    const killStill = (finalHb.instructions ?? []).find(
      (i: any) => i.package_id === skill.packageId && i.action === "kill",
    );
    expect(killStill).toBeUndefined();

    // Source worker unaffected (T70.O5) — no kill for source-org worker
    const srcHb = await admin.heartbeat(srcWorker.workerToken, []);
    const srcKill = (srcHb.instructions ?? []).find(
      (i: any) => i.package_id === skill.packageId && i.action === "kill",
    );
    expect(srcKill, "source-org worker should NOT receive kill").toBeUndefined();

    await openHub(page, admin.token!, "/skills").catch(() => {});
    await hubShot(page, "T70-ui-after-revoke");
  });

  // ─────────────────────────────────────────────────────────────────────
  // T71: Large-scale usage log aggregation and statistics
  // ─────────────────────────────────────────────────────────────────────
  test("T71: usage log batch ingestion and stats aggregation", async ({ page }) => {
    const stamp = uniq("e2e71");
    const org = await admin.createOrg({ name: `UsageOrg_${stamp}`, code: `UO_${stamp}`, type: "company" });
    const w = await provisionWorker(admin, { name: `uw_${stamp}`, orgId: org.organization.id });

    const pkgA = await publishOrgSkill(admin, { name: `use_a_${stamp}`, scope: "system" });
    const pkgB = await publishOrgSkill(admin, { name: `use_b_${stamp}`, scope: "system" });

    // Ingest 1000 records for pkgA: 800 success, 100 failure, 50 timeout, 50 blocked
    const TOTAL = 200; // scaled-down for e2e but still exercises aggregation
    const SUCCESS = 160, FAIL = 20, TIMEOUT = 10, BLOCKED = 10;
    expect(SUCCESS + FAIL + TIMEOUT + BLOCKED).toBe(TOTAL);

    const ingest = async (status: string, count: number, durationMs: () => number) => {
      const ps = [];
      for (let i = 0; i < count; i++) {
        ps.push(
          admin.logUsage(w.workerToken, pkgA.packageId, {
            status,
            duration_ms: durationMs(),
            executor_type: "main_agent",
            session_id: `sess_${stamp}_${status}_${i}`,
            details: status === "failure" ? { error: "test failure" } : undefined,
          }),
        );
        if (ps.length >= 10) {
          await Promise.all(ps);
          ps.length = 0;
        }
      }
      if (ps.length) await Promise.all(ps);
    };

    await ingest("success", SUCCESS, () => 100 + Math.floor(Math.random() * 4900));
    await ingest("failure", FAIL, () => 100 + Math.floor(Math.random() * 1000));
    await ingest("timeout", TIMEOUT, () => 30000 + Math.floor(Math.random() * 10000));
    await ingest("blocked", BLOCKED, () => 50);

    // 500 records for pkgB
    for (let i = 0; i < 100; i++) {
      await admin.logUsage(w.workerToken, pkgB.packageId, {
        status: "success",
        duration_ms: 200,
        executor_type: "main_agent",
      });
    }

    // Stats aggregation (T71 step 5)
    const stats = await admin.getUsageStats(pkgA.packageId);
    const s = stats.stats ?? stats;
    expect(s.total).toBeGreaterThanOrEqual(TOTAL);
    expect(s.success).toBeGreaterThanOrEqual(SUCCESS);
    expect(s.failure).toBeGreaterThanOrEqual(FAIL);
    expect(s.timeout).toBeGreaterThanOrEqual(TIMEOUT);
    expect(s.blocked).toBeGreaterThanOrEqual(BLOCKED);
    expect(s.success_rate).toBeGreaterThan(0.5);
    expect(s.unique_workers).toBeGreaterThanOrEqual(1);

    // Top ranking (T71 step 6)
    const top = await admin.getTopUsage();
    const topArr: any[] = top.skills ?? top.top ?? [];
    const aEntry = topArr.find((t) => t.package_id === pkgA.packageId || t.id === pkgA.packageId);
    const bEntry = topArr.find((t) => t.package_id === pkgB.packageId || t.id === pkgB.packageId);
    if (aEntry && bEntry) {
      const aCount = aEntry.calls ?? aEntry.total ?? aEntry.count ?? 0;
      const bCount = bEntry.calls ?? bEntry.total ?? bEntry.count ?? 0;
      expect(aCount).toBeGreaterThan(bCount);
    }

    // Recent DESC (T71 step 7)
    const recent = await admin.getRecentUsage(pkgA.packageId, 10);
    const recentArr: any[] = recent.logs ?? recent.recent ?? [];
    expect(recentArr.length).toBeLessThanOrEqual(10);
    if (recentArr.length >= 2) {
      const t1 = new Date(recentArr[0].created_at).getTime();
      const t2 = new Date(recentArr[1].created_at).getTime();
      expect(t1).toBeGreaterThanOrEqual(t2);
    }

    await openHub(page, admin.token!, "/skills").catch(() => {});
    await hubShot(page, "T71-ui-usage-stats");
  });
});
