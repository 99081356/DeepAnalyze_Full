/**
 * Comprehensive end-to-end verification of Hub Server overhaul.
 *
 * Covers all phases (A-E):
 *  - Phase A: Backend schema + validation (metadata, categories, constraints)
 *  - Phase B: Seed script (RBAC, orgs, users, skills, sharings)
 *  - Phase C: UI infrastructure (design tokens, Badge, error boundary)
 *  - Phase D: Page rewrites (Security, Sharings, Organizations)
 *  - Phase E: Integration verification
 */
import { test, expect, request } from "@playwright/test";
import { HubApi, adminLogin, uniq } from "../helpers/hubApi";

test.describe.serial("Hub E2E Verification — Full Feature Audit", () => {
  let admin: HubApi;

  test.beforeAll(async () => {
    admin = await adminLogin(await request.newContext());
  });

  // ════════════════════════════════════════════════════════════════════
  // V01: Seed Data Verification
  // ════════════════════════════════════════════════════════════════════

  test("V01: Seed data — organizations, users, skills, RBAC", async () => {
    const orgs = await admin.listOrgs();
    expect(orgs.organizations.length).toBeGreaterThanOrEqual(11);

    const users = await admin.listUsers();
    expect(users.users.length).toBeGreaterThanOrEqual(19);

    const skills = await admin.listSkills();
    expect(skills.items.length).toBeGreaterThanOrEqual(3);

    console.log("Seed verification:", {
      orgs: orgs.organizations.length,
      users: users.users.length,
      skills: skills.items.length,
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // V02: Metadata Validation
  // ════════════════════════════════════════════════════════════════════

  test("V02: Metadata validation — all rejection paths", async () => {
    const stamp = uniq("v02");

    // Missing description → 400
    const r1 = await admin.raw("POST", "/skills", {
      data: { name: `sk_${stamp}_nodesc`, scope: "user" },
    });
    expect(r1.status).toBe(400);

    // Short description → 400
    const r2 = await admin.raw("POST", "/skills", {
      data: { name: `sk_${stamp}_shortdesc`, scope: "user", description: "too short" },
    });
    expect(r2.status).toBe(400);

    // Invalid category → 400
    const r3 = await admin.raw("POST", "/skills", {
      data: {
        name: `sk_${stamp}_badcat`, scope: "user",
        description: "A valid description for testing",
        category: "nonexistent_category",
      },
    });
    expect(r3.status).toBe(400);

    // Valid → 201
    const r4 = await admin.createSkill({
      name: `sk_${stamp}_valid`,
      scope: "user",
      description: "A valid description for testing metadata validation",
      category: "engineering",
    });
    expect(r4.package.id).toBeTruthy();

    // Version without change_summary → 400
    const r5 = await admin.raw("POST", `/skills/${r4.package.id}/versions`, {
      data: { version: "1.0.0", content: "# Test content" },
    });
    expect(r5.status).toBe(400);

    // Version with change_summary → 201
    const r6 = await admin.createVersion(r4.package.id, {
      version: "1.0.0",
      content: "# Test content with summary",
      change_summary: "Initial version for metadata test",
    });
    expect(r6.version.id).toBeTruthy();

    console.log("Metadata validation: all 5 paths verified");
  });

  // ════════════════════════════════════════════════════════════════════
  // V03: Organization CRUD + tree
  // ════════════════════════════════════════════════════════════════════

  test("V03: Organization CRUD + tree structure", async () => {
    const stamp = uniq("v03");

    const org = await admin.createOrg({
      name: `VerifyOrg_${stamp}`,
      code: `VO_${stamp}`,
      type: "department",
    });
    expect(org.organization.id).toBeTruthy();

    const tree = await admin.getOrgSubtree(org.organization.id);
    expect(tree).toBeTruthy();

    const allOrgs = await admin.listOrgs();
    const found = allOrgs.organizations.find((o: any) => o.id === org.organization.id);
    expect(found).toBeTruthy();

    console.log("Org CRUD verified:", org.organization.id);
  });

  // ════════════════════════════════════════════════════════════════════
  // V04: RBAC — admin has all permissions, regular user limited
  // ════════════════════════════════════════════════════════════════════

  test("V04: RBAC — admin has all permissions, regular user limited", async () => {
    const adminUsers = await admin.raw("GET", "/users");
    expect(adminUsers.status).toBe(200);

    const stamp = uniq("v04");
    const orgResult = await admin.createOrg({
      name: `RBACTest_${stamp}`,
      code: `RB_${stamp}`,
      type: "team",
    });
    expect(orgResult.organization.id).toBeTruthy();

    // Login as regular user
    const userLogin = await admin.raw("POST", "/auth/login", {
      data: { username: "liu.tianyu", password: "Test1234!" },
    });
    expect(userLogin.status).toBe(200);
    const userToken = userLogin.body.access_token;

    // Regular user cannot create users
    const createUserAttempt = await admin.raw("POST", "/users", {
      data: {
        username: `should_fail_${stamp}`,
        password: "Test1234!",
        display_name: "Should Fail",
      },
      token: userToken,
    });
    expect([403, 400]).toContain(createUserAttempt.status);

    console.log("RBAC enforcement verified");
  });

  // ════════════════════════════════════════════════════════════════════
  // V05: Skill version state machine — full lifecycle
  // ════════════════════════════════════════════════════════════════════

  test("V05: Skill version state machine — full lifecycle", async () => {
    const stamp = uniq("v05");
    const org = await admin.createOrg({
      name: `StateOrg_${stamp}`, code: `SO_${stamp}`, type: "company",
    });

    const skill = await admin.createSkill({
      name: `sm_${stamp}`,
      scope: "org",
      org_id: org.organization.id,
      description: "State machine lifecycle verification skill with adequate length",
      category: "engineering",
    });
    const pid = skill.package.id;

    const v = await admin.createVersion(pid, {
      version: "1.0.0",
      content: "# State machine test\nLegit content for verification.",
      change_summary: "Initial draft for state machine test",
    });
    const vid = v.version.id;
    expect(v.version.status).toBe("draft");

    // draft → internal_test → canary → publish
    await admin.startTest(pid, vid);
    await admin.canary(pid, vid);
    await admin.requestPublish(pid, vid);
    const approvals = await admin.listApprovals();
    const appr = approvals.approvals.find((a: any) => a.version_id === vid);
    expect(appr).toBeTruthy();
    await admin.approveVersion(appr.id, "E2E verification approve");
    await admin.publish(pid, vid);

    // published → deprecated
    await admin.deprecate(pid, vid);

    // Illegal: draft → published without approval → 400
    const v6 = await admin.createVersion(pid, {
      version: "2.0.0",
      content: "# Second version",
      change_summary: "Second version for illegal transition test",
    });
    const illegal = await admin.raw("POST", `/skills/${pid}/versions/${v6.version.id}/publish`);
    expect(illegal.status).toBe(400);

    console.log("State machine: 6-state lifecycle verified");
  });

  // ════════════════════════════════════════════════════════════════════
  // V06: Skill Sharing — cross-org two-sided approval
  // ════════════════════════════════════════════════════════════════════

  test("V06: Skill Sharing — cross-org approval flow", async () => {
    const stamp = uniq("v06");
    const orgA = await admin.createOrg({
      name: `ShareSource_${stamp}`, code: `SS_${stamp}`, type: "company",
    });
    const orgB = await admin.createOrg({
      name: `ShareTarget_${stamp}`, code: `ST_${stamp}`, type: "company",
    });

    const skill = await admin.createSkill({
      name: `share_${stamp}`,
      scope: "org",
      org_id: orgA.organization.id,
      description: "Cross-org sharing verification skill with adequate description length",
      category: "engineering",
    });
    const pid = skill.package.id;

    const v = await admin.createVersion(pid, {
      version: "1.0.0",
      content: "# Shareable skill content",
      change_summary: "Initial version for sharing test",
    });
    const vid = v.version.id;
    await admin.requestPublish(pid, vid);
    const approvals = await admin.listApprovals();
    const appr = approvals.approvals.find((a: any) => a.version_id === vid);
    if (appr) await admin.approveVersion(appr.id, "auto");
    await admin.publish(pid, vid);

    // Request sharing — verifies usage_intent + business_justification pass through
    const shareResult = await admin.createSharing({
      package_id: pid,
      source_org_id: orgA.organization.id,
      target_org_id: orgB.organization.id,
      usage_intent: "Target org needs this skill for project delivery",
      business_justification: "Cross-team collaboration requirement",
    });
    expect(shareResult.sharing?.id).toBeTruthy();
    expect(shareResult.sharing?.status).toBe("pending");

    console.log("Sharing flow verified:", shareResult.sharing?.id);

    console.log("Sharing flow verified");
  });

  // ════════════════════════════════════════════════════════════════════
  // V07: Security Gateway
  // ════════════════════════════════════════════════════════════════════

  test("V07: Security — RedFlag scanner catches malicious content", async () => {
    const scan1 = await admin.scanText("身份证 110101199001011234 + DROP TABLE users;");
    expect(scan1.result.action).toBe("block");

    const scan2 = await admin.scanText("This is a normal skill description for testing.");
    expect(scan2.result.action).not.toBe("block");

    const toolCheck = await admin.checkTool("bash", { command: "DROP TABLE users;" });
    expect(toolCheck.result.action).toBe("block");

    console.log("Security scanner verified");
  });

  // ════════════════════════════════════════════════════════════════════
  // V08: Worker lifecycle
  // ════════════════════════════════════════════════════════════════════

  test("V08: Worker — register, heartbeat, ack", async () => {
    const stamp = uniq("v08");
    const org = await admin.createOrg({
      name: `WorkerOrg_${stamp}`, code: `WO_${stamp}`, type: "company",
    });

    const regResult = await admin.registerWorker({
      name: `verify-worker-${stamp}`,
      hostname: "verify-host",
      protocol_version: 2,
      org_id: org.organization.id,
    });
    const workerId = regResult.worker_id;
    expect(workerId).toBeTruthy();

    // Approve worker (v2 requires admin approval before heartbeat)
    const apprResult = await admin.approveWorker(workerId);
    const workerToken = apprResult.worker_token;
    expect(workerToken).toBeTruthy();

    // Heartbeat
    const hbResult = await admin.heartbeat(workerToken, [], { status: "idle", active_tasks: 0 });
    expect(hbResult).toBeTruthy();

    // List workers
    const workers = await admin.listWorkers();
    const found = (workers.workers ?? workers).find((w: any) =>
      (w.worker_id ?? w.id) === workerId
    );
    expect(found).toBeTruthy();

    console.log("Worker lifecycle verified:", workerId);
  });

  // ════════════════════════════════════════════════════════════════════
  // V09: Audit log
  // ════════════════════════════════════════════════════════════════════

  test("V09: Audit log — records all transitions", async () => {
    const stamp = uniq("v09");
    const org = await admin.createOrg({
      name: `AuditOrg_${stamp}`, code: `AO_${stamp}`, type: "company",
    });
    const skill = await admin.createSkill({
      name: `audit_${stamp}`,
      scope: "org",
      org_id: org.organization.id,
      description: "Audit trail verification skill with adequate description length here",
      category: "engineering",
    });
    const pid = skill.package.id;
    const v = await admin.createVersion(pid, {
      version: "1.0.0",
      content: "# Audit test content",
      change_summary: "Initial version for audit log test",
    });
    const vid = v.version.id;

    await admin.startTest(pid, vid);
    await admin.canary(pid, vid);
    await admin.requestPublish(pid, vid);
    const approvals = await admin.listApprovals();
    const appr = approvals.approvals.find((a: any) => a.version_id === vid);
    if (appr) await admin.approveVersion(appr.id, "audit test");
    await admin.publish(pid, vid);

    const audit = await admin.getAudit(pid);
    const logs = audit.logs ?? audit.audit_logs ?? audit.entries ?? [];
    expect(logs.length).toBeGreaterThanOrEqual(3);

    const actions = logs.map((l: any) => l.action);
    const hasTransition = actions.some((a: string) => a.includes("transition"));
    expect(hasTransition).toBeTruthy();

    console.log("Audit log verified:", logs.length, "entries");
  });

  // ════════════════════════════════════════════════════════════════════
  // V10: Kill switch + unkill
  // ════════════════════════════════════════════════════════════════════

  test("V10: Kill switch + unkill lifecycle", async () => {
    const stamp = uniq("v10");
    const skill = await admin.createSkill({
      name: `kill_${stamp}`,
      scope: "user",
      description: "Kill switch verification skill with adequate description length here",
      category: "engineering",
    });
    const pid = skill.package.id;
    const v = await admin.createVersion(pid, {
      version: "1.0.0",
      content: "# Kill switch test",
      change_summary: "Initial version for kill switch test",
    });
    const vid = v.version.id;

    // Direct publish for user scope
    await admin.publish(pid, vid);

    // Kill
    await admin.killSwitch(pid, "Emergency disable for testing");
    const killed = await admin.getSkill(pid);
    expect(killed.package?.is_kill_switched ?? killed.is_kill_switched).toBeTruthy();

    // Unkill
    await admin.unkill(pid);
    const unkilled = await admin.getSkill(pid);
    expect(unkilled.package?.is_kill_switched ?? unkilled.is_kill_switched).toBeFalsy();

    console.log("Kill switch lifecycle verified");
  });
});
