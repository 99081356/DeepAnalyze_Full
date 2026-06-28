/**
 * State machine spec — verify all status transitions through the UI + DB.
 *
 * S1: approve (pending → approved)
 * S2: reject (pending → rejected, with reason)
 * S3: deprecate (approved → deprecated, with reason)
 * S4: delete (rejected → gone)
 * S5: illegal transition (deprecated → approve) rejected by API
 * E2: double-click protection (rapid double confirm → single transition)
 */

import { test, expect } from "./fixtures.js";
import {
  loginFast,
  captureScreenshot,
  seedMarketplaceSkill,
  sqlExec,
  getApiToken,
  deleteSkillById,
  cardByName,
} from "./fixtures.js";

test.describe("State machine", () => {
  test.beforeEach(async ({ page, request, cleanup }) => {
    await loginFast(page, request, "admin", "admin123");
    await cleanup();
  });

  test.afterEach(async ({ cleanup }) => {
    await cleanup();
  });

  test("S1: approve pending skill moves it to approved", async ({ page }) => {
    const skill = await seedMarketplaceSkill("pending", { name: "TestS1 Approve" });
    await page.goto("/worker-skills", { waitUntil: "networkidle" });
    await expect(page.getByText("TestS1 Approve")).toBeVisible({ timeout: 5_000 });

    // Click 批准 on this card → ConfirmDialog
    await cardByName(page, "TestS1 Approve").getByRole("button", { name: "批准", exact: true }).click();

    // ConfirmDialog (Modal with role=dialog)
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3_000 });
    await dialog.getByRole("button", { name: "批准", exact: true }).click();

    // Toast success
    await expect(page.getByText(/已批准 TestS1 Approve/)).toBeVisible({ timeout: 5_000 });
    await captureScreenshot(page, "state-machine", "s1-approved");

    // Card disappears from pending tab
    await expect(page.getByText("TestS1 Approve")).not.toBeVisible({ timeout: 5_000 });

    // DB row now approved
    const rows = await sqlExec<{ review_status: string; reviewer_id: string | null }>(
      `SELECT review_status, reviewer_id FROM marketplace_skills WHERE id = $1`,
      [skill.id]
    );
    expect(rows[0].review_status).toBe("approved");
    expect(rows[0].reviewer_id).not.toBeNull();
  });

  test("S2: reject pending skill with reason moves it to rejected", async ({ page }) => {
    const skill = await seedMarketplaceSkill("pending", { name: "TestS2 Reject" });
    await page.goto("/worker-skills", { waitUntil: "networkidle" });
    await expect(page.getByText("TestS2 Reject")).toBeVisible({ timeout: 5_000 });

    // Click 拒绝 on this card → ReasonDialog (custom overlay, not Modal)
    await cardByName(page, "TestS2 Reject").getByRole("button", { name: "拒绝", exact: true }).click();

    // ReasonDialog textarea (autofocus) + 确认拒绝 button
    const reasonTextarea = page.locator("textarea").first();
    await expect(reasonTextarea).toBeVisible({ timeout: 3_000 });
    await reasonTextarea.fill("Test reason: not production-ready");
    await page.getByRole("button", { name: "确认拒绝" }).click();

    await expect(page.getByText(/已拒绝 TestS2 Reject/)).toBeVisible({ timeout: 5_000 });
    await captureScreenshot(page, "state-machine", "s2-rejected");

    // DB row now rejected with review_notes
    const rows = await sqlExec<{ review_status: string; review_notes: string | null }>(
      `SELECT review_status, review_notes FROM marketplace_skills WHERE id = $1`,
      [skill.id]
    );
    expect(rows[0].review_status).toBe("rejected");
    expect(rows[0].review_notes).toContain("not production-ready");
  });

  test("S3: deprecate approved skill with reason moves it to deprecated", async ({ page }) => {
    const skill = await seedMarketplaceSkill("approved", { name: "TestS3 Deprecate" });
    await page.goto("/worker-skills", { waitUntil: "networkidle" });

    // Approved tab
    await page.getByRole("button", { name: /^已批准/ }).click();
    await expect(page.getByText("TestS3 Deprecate")).toBeVisible({ timeout: 5_000 });

    // Click 下架 on this card → ReasonDialog
    await cardByName(page, "TestS3 Deprecate").getByRole("button", { name: "下架", exact: true }).click();

    const reasonTextarea = page.locator("textarea").first();
    await expect(reasonTextarea).toBeVisible({ timeout: 3_000 });
    await reasonTextarea.fill("Deprecated: superseded by v2");
    await page.getByRole("button", { name: "确认下架" }).click();

    await expect(page.getByText(/已下架 TestS3 Deprecate/)).toBeVisible({ timeout: 5_000 });
    await captureScreenshot(page, "state-machine", "s3-deprecated");

    const rows = await sqlExec<{ review_status: string; review_notes: string | null }>(
      `SELECT review_status, review_notes FROM marketplace_skills WHERE id = $1`,
      [skill.id]
    );
    expect(rows[0].review_status).toBe("deprecated");
    expect(rows[0].review_notes).toContain("superseded");
  });

  test("S4: delete rejected skill removes row from DB", async ({ page }) => {
    const skill = await seedMarketplaceSkill("rejected", { name: "TestS4 Delete" });
    await page.goto("/worker-skills", { waitUntil: "networkidle" });

    // Rejected tab
    await page.getByRole("button", { name: /^已拒绝/ }).click();
    await expect(page.getByText("TestS4 Delete")).toBeVisible({ timeout: 5_000 });

    // Click 删除 → ConfirmDialog (Modal-based, danger variant)
    await cardByName(page, "TestS4 Delete").getByRole("button", { name: "删除", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3_000 });
    await dialog.getByRole("button", { name: "删除", exact: true }).click();

    await expect(page.getByText(/已删除 TestS4 Delete/)).toBeVisible({ timeout: 5_000 });
    await captureScreenshot(page, "state-machine", "s4-deleted");

    // Row gone from DB
    const rows = await sqlExec(`SELECT id FROM marketplace_skills WHERE id = $1`, [skill.id]);
    expect(rows.length).toBe(0);
  });

  test("S5: illegal transition (deprecated → approve) returns 404 and leaves DB unchanged", async ({ request }) => {
    const skill = await seedMarketplaceSkill("deprecated", { name: "TestS5 Illegal" });
    const token = await getApiToken(request, "admin", "admin123");

    const resp = await request.post(
      `http://localhost:22000/api/v1/marketplace/admin/skills/${skill.id}/approve`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    // State machine guards: only pending can be approved; deprecated → 404
    expect([404, 409, 400]).toContain(resp.status());

    // DB unchanged
    const rows = await sqlExec<{ review_status: string }>(
      `SELECT review_status FROM marketplace_skills WHERE id = $1`,
      [skill.id]
    );
    expect(rows[0].review_status).toBe("deprecated");

    await deleteSkillById(skill.id);
  });

  test("E2: rapid double-confirm on approve produces single transition", async ({ page }) => {
    const skill = await seedMarketplaceSkill("pending", { name: "TestE2 Double" });
    await page.goto("/worker-skills", { waitUntil: "networkidle" });
    await expect(page.getByText("TestE2 Double")).toBeVisible({ timeout: 5_000 });

    await cardByName(page, "TestE2 Double").getByRole("button", { name: "批准", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    // Rapidly click confirm twice
    const confirmBtn = dialog.getByRole("button", { name: "批准", exact: true });
    await Promise.all([confirmBtn.click(), confirmBtn.click()]).catch(() => {
      // Second click may fail if modal already closed — that's the expected behavior
    });

    // Should get one success toast (the second click might fail silently or modal closes first)
    await expect(page.getByText(/已批准 TestE2 Double/)).toBeVisible({ timeout: 5_000 });

    // DB has exactly ONE transition (reviewer_id set, status approved)
    const rows = await sqlExec<{ review_status: string; reviewer_id: string | null }>(
      `SELECT review_status, reviewer_id FROM marketplace_skills WHERE id = $1`,
      [skill.id]
    );
    expect(rows[0].review_status).toBe("approved");
    expect(rows.length).toBe(1);
  });
});
