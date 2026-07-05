import { test, expect, request } from "@playwright/test";
import { HubApi, adminLogin, provisionWorker, publishOrgSkill, uniq } from "../helpers/hubApi";
import { openHub, hubShot } from "../helpers/hubUi";

/**
 * Find the instruction targeting a specific package, ignoring leftover
 * instructions from prior runs (the heartbeat returns all pending instructions).
 */
function instrFor(instructions: any[], packageId: string): any | undefined {
  return (instructions ?? []).find((i) => i.package_id === packageId);
}

test.describe.serial("Hub SkillSync — T63/T64/T67", () => {
  let admin: HubApi;

  test.beforeAll(async () => {
    admin = await adminLogin(await request.newContext());
  });

  // ─────────────────────────────────────────────────────────────────────
  // T63: system-scope skill publish → Worker auto-sync full chain
  // ─────────────────────────────────────────────────────────────────────
  test("T63: SkillSync — publish, heartbeat, ack, version upgrade", async ({ page }) => {
    const stamp = uniq("e2e63");
    const org = await admin.createOrg({ name: `OrgA_${stamp}`, code: `OA_${stamp}`, type: "company" });
    const orgId = org.organization.id;

    // 3 workers in the org
    const w1 = await provisionWorker(admin, { name: `w1_${stamp}`, orgId });
    const w2 = await provisionWorker(admin, { name: `w2_${stamp}`, orgId });
    const w3 = await provisionWorker(admin, { name: `w3_${stamp}`, orgId });

    // Publish a system-scope package (auto-syncs to all workers per computeExpectedSkills)
    const skill = await publishOrgSkill(admin, {
      name: `e2e-sync_${stamp}`,
      scope: "system",
      content: `# Sync test\n\nLegitimate system skill for e2e.\n## Instructions\nBe precise.`,
    });

    // w1 heartbeat with empty cache → expect a sync instruction (T63.O2)
    const hb1 = await admin.heartbeat(w1.workerToken, []);
    const sync1 = instrFor(hb1.instructions, skill.packageId);
    expect(sync1, "w1 should receive sync instruction").toBeTruthy();
    expect(sync1.action === "sync" || sync1.action === "force_update").toBeTruthy();

    // w2 also receives it (T63.O2 — multi-worker consistency)
    const hb2 = await admin.heartbeat(w2.workerToken, []);
    expect(instrFor(hb2.instructions, skill.packageId)).toBeTruthy();

    // w3 reports it already has the package → no instruction (T63.O4)
    const versions = await admin.listVersions(skill.packageId);
    const published = (versions.versions ?? []).find((v: any) => v.status === "published");
    const cachedEntry = {
      package_id: skill.packageId,
      content_hash: published?.content_hash,
      version: published?.version ?? "1.0.0",
    };
    const hb3 = await admin.heartbeat(w3.workerToken, [cachedEntry]);
    expect(instrFor(hb3.instructions, skill.packageId)).toBeUndefined();

    // ack is idempotent (T63.O4)
    if (sync1.instruction_id) {
      await admin.ack(w1.workerToken, { instruction_id: sync1.instruction_id });
      const hb1b = await admin.heartbeat(w1.workerToken, [cachedEntry]);
      expect(instrFor(hb1b.instructions, skill.packageId)).toBeUndefined();
    }

    await hubShot(page, `T63-after-sync`).catch(() => {});
    await openHub(page, admin.token!, "/skills").catch(() => {});
    await hubShot(page, "T63-ui-skills-market");
  });

  // ─────────────────────────────────────────────────────────────────────
  // T64: Kill Switch → all Workers receive kill within one heartbeat
  // ─────────────────────────────────────────────────────────────────────
  test("T64: Kill Switch emergency disable propagates to Workers", async ({ page }) => {
    const stamp = uniq("e2e64");
    const org = await admin.createOrg({ name: `KillOrg_${stamp}`, code: `KO_${stamp}`, type: "company" });
    const workers = [];
    for (let i = 0; i < 3; i++) {
      workers.push(await provisionWorker(admin, { name: `kw${i}_${stamp}`, orgId: org.organization.id }));
    }
    const skill = await publishOrgSkill(admin, { name: `e2e-kill_${stamp}`, scope: "system" });

    // Workers sync the package first
    for (const w of workers) {
      const hb = await admin.heartbeat(w.workerToken, []);
      const instr = instrFor(hb.instructions, skill.packageId);
      if (instr?.instruction_id) await admin.ack(w.workerToken, { instruction_id: instr.instruction_id });
    }

    const t0 = Date.now();
    // Activate kill switch (T64.O1)
    await admin.killSwitch(skill.packageId, "紧急安全漏洞 — e2e kill switch");

    // Verify the package can no longer be subscribed (T64.O3)
    const subAfter = await admin.raw("POST", `/skills/${skill.packageId}/subscribe`, { data: {} });
    expect(subAfter.status).toBe(403);

    // Every worker receives a kill instruction on next heartbeat (T64.O2)
    const receiptTimes: number[] = [];
    for (const w of workers) {
      const hb = await admin.heartbeat(w.workerToken, [{ package_id: skill.packageId, version_hash: "cached" }]);
      const kill = (hb.instructions ?? []).find(
        (i: any) => i.package_id === skill.packageId && i.action === "kill",
      );
      expect(kill, `worker should receive kill instruction`).toBeTruthy();
      receiptTimes.push(Date.now());
      if (kill?.instruction_id) await admin.ack(w.workerToken, { instruction_id: kill.instruction_id });
    }
    // All received within a heartbeat window (< 30s in real deployments; here sequential so fast)
    const elapsed = receiptTimes[receiptTimes.length - 1] - t0;
    expect(elapsed).toBeLessThan(30000);

    // After ack, no more kill instruction (T64.O6 idempotent)
    const finalHb = await admin.heartbeat(workers[0].workerToken, []);
    expect((finalHb.instructions ?? []).find((i: any) => i.package_id === skill.packageId && i.action === "kill")).toBeUndefined();

    // unkill restores subscribability (T64.O5)
    await admin.unkill(skill.packageId);
    const subAfterUnkill = await admin.raw("POST", `/skills/${skill.packageId}/subscribe`, { data: {} });
    expect(subAfterUnkill.status).toBeLessThan(400);

    await openHub(page, admin.token!, "/skills").catch(() => {});
    await hubShot(page, "T64-ui-after-unkill");
  });

  // ─────────────────────────────────────────────────────────────────────
  // T67: Force Update — priority queue + deadline
  // ─────────────────────────────────────────────────────────────────────
  test("T67: Force Update enqueues priority instruction with deadline", async ({ page }) => {
    const stamp = uniq("e2e67");
    const org = await admin.createOrg({ name: `ForceOrg_${stamp}`, code: `FO_${stamp}`, type: "company" });
    const w1 = await provisionWorker(admin, { name: `fw1_${stamp}`, orgId: org.organization.id });

    const skill = await publishOrgSkill(admin, { name: `e2e-force_${stamp}`, scope: "system" });

    // Enqueue force update with a 24h deadline (T67.O2)
    const fu = await admin.forceUpdate(skill.packageId, { reason: "安全补丁 e2e", deadline_hours: 24 });
    expect(fu).toBeTruthy();

    // Worker heartbeat returns force_update instruction with deadline + reason (T67.O3)
    const hb = await admin.heartbeat(w1.workerToken, [{ package_id: skill.packageId, version_hash: "v1" }]);
    const instr = (hb.instructions ?? []).find(
      (i: any) => i.package_id === skill.packageId && i.action === "force_update",
    );
    expect(instr, "should receive force_update instruction").toBeTruthy();
    expect(instr.deadline).toBeTruthy();
    expect(instr.reason).toContain("安全补丁");

    // Priority ordering: kill > force_update > sync (T67.O5/O6) — verify force_update present
    const priorities = (hb.instructions ?? []).map((i: any) => i.action);
    const fuIdx = priorities.indexOf("force_update");
    const syncIdx = priorities.indexOf("sync");
    if (fuIdx >= 0 && syncIdx >= 0) expect(fuIdx).toBeLessThanOrEqual(syncIdx);

    // ack is idempotent (T67.O6): force_update lives in a persistent queue and
    // stays active until its deadline expires; acking just records confirmation
    // without side effects. Verify a second ack also succeeds.
    if (instr?.instruction_id) {
      const ack1 = await admin.ack(w1.workerToken, { instruction_id: instr.instruction_id });
      expect(ack1).toBeTruthy();
      const ack2 = await admin.ack(w1.workerToken, { instruction_id: instr.instruction_id });
      expect(ack2).toBeTruthy(); // idempotent — no error on repeat
    }

    await openHub(page, admin.token!, "/workers").catch(() => {});
    await hubShot(page, "T67-ui-workers");
  });
});
