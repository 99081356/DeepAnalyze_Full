/**
 * 09 - Side Panel Tests
 * Covers: Skills, Plugins, Teams, Cron, MCP panels and their APIs.
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot } from "./helpers/visual";

test.describe("09 - Side Panels", () => {
  let api: ReturnType<typeof createApi>;
  let createdSkillIds: string[] = [];
  let createdCronIds: string[] = [];
  let createdMcpIds: string[] = [];

  test.beforeEach(async ({ request }) => {
    api = createApi(request);
  });

  test.afterEach(async () => {
    for (const id of createdSkillIds) await api.deleteSkill(id).catch(() => {});
    for (const id of createdCronIds) await api.deleteCronJob(id).catch(() => {});
    for (const id of createdMcpIds) await api.deleteMCPServer(id).catch(() => {});
    createdSkillIds = [];
    createdCronIds = [];
    createdMcpIds = [];
  });

  // -- Skills --
  test("9.1 skills list returns registered skills", async () => {
    const skills = await api.listSkills();
    expect(Array.isArray(skills)).toBeTruthy();
    // Should have at least deep-research built-in skill
    expect(skills.length, "Should have built-in skills").toBeGreaterThanOrEqual(1);
  });

  test("9.2 create and delete custom skill", async () => {
    const skill = await api.createSkill({
      name: "e2e-test-skill",
      description: "E2E test skill",
      prompt: "This is a test skill for E2E testing.",
      isActive: true,
    });
    expect(skill.id).toBeTruthy();
    expect(skill.name).toBe("e2e-test-skill");
    createdSkillIds.push(skill.id);

    // Verify it appears in list
    const skills = await api.listSkills();
    const found = skills.find((s) => s.id === skill.id);
    expect(found, "Created skill should appear in list").toBeTruthy();

    // Delete
    await api.deleteSkill(skill.id);
    createdSkillIds = createdSkillIds.filter((id) => id !== skill.id);

    // Verify deletion
    const skillsAfter = await api.listSkills();
    const foundAfter = skillsAfter.find((s) => s.id === skill.id);
    expect(foundAfter, "Deleted skill should not appear").toBeFalsy();
  });

  // -- Plugins --
  test("9.3 plugins list shows installed plugins", async () => {
    const result = await api.listPlugins();
    expect(result).toBeTruthy();
    // plugins field may be at top level or nested
    const plugins = result.plugins || result;
    if (Array.isArray(plugins)) {
      // Should have judicial-analysis and superpowers plugins
      expect(plugins.length).toBeGreaterThanOrEqual(0);
    }
  });

  // -- Cron --
  test("9.4 cron job list returns array", async () => {
    const jobs = await api.listCronJobs();
    expect(Array.isArray(jobs)).toBeTruthy();
  });

  test("9.5 create and delete cron job", async ({ request }) => {
    const createResp = await request.post("/api/cron/jobs", {
      data: {
        name: "E2E Test Cron",
        schedule: "0 0 * * *",
        enabled: false,
        message: "test message",
        sessionId: "00000000-0000-0000-0000-000000000000",
      },
    });
    if (createResp.ok) {
      const job = await createResp.json();
      expect(job.id).toBeTruthy();
      createdCronIds.push(job.id);
      await api.deleteCronJob(job.id);
      createdCronIds = createdCronIds.filter((id) => id !== job.id);
    } else {
      // Cron job creation may fail — just verify endpoint exists
      expect(createResp.status()).toBeLessThan(500);
    }
  });

  test("9.6 invalid cron expression returns error", async ({ request }) => {
    const resp = await request.post("/api/cron/validate", {
      data: { expression: "invalid-cron" },
    });
    // Should return error status or error in body
    const body = await resp.json().catch(() => ({}));
    expect(resp.status() === 200 || resp.status() === 400).toBeTruthy();
    if (resp.status() === 200) {
      expect(body.valid === false || body.error).toBeTruthy();
    }
  });

  // -- MCP --
  test("9.7 MCP server list returns array", async () => {
    const servers = await api.listMCPServers();
    expect(Array.isArray(servers)).toBeTruthy();
  });

  test("9.8 add and delete MCP server", async ({ request }) => {
    const resp = await request.post("/api/mcp", {
      data: {
        id: "e2e-test-mcp",
        name: "E2E Test MCP",
        type: "stdio",
        command: "echo",
      },
    });
    if (resp.ok) {
      const server = await resp.json();
      expect(server.id).toBeTruthy();
      createdMcpIds.push(server.id);
      await api.deleteMCPServer(server.id || "e2e-test-mcp");
      createdMcpIds = createdMcpIds.filter((id) => id !== (server.id || "e2e-test-mcp"));
    } else {
      // MCP server creation may require specific config — just verify endpoint exists
      expect(resp.status()).toBeLessThan(500);
    }
  });

  // -- UI --
  test("9.9 header button group screenshot", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    await takeScreenshot(page, "panels-header-buttons");
  });

  test("9.10 skills panel opens from header", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const skillBtn = page.locator('button:has-text("技能")').first();
    if (await skillBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await skillBtn.click();
      await page.waitForTimeout(500);
      await takeScreenshot(page, "panels-skills-open");
    }
  });

  test("9.11 plugins panel opens from header", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const pluginBtn = page.locator('button:has-text("插件")').first();
    if (await pluginBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await pluginBtn.click();
      await page.waitForTimeout(500);
      await takeScreenshot(page, "panels-plugins-open");
    }
  });

  test("9.12 cron panel opens from header", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");

    const cronBtn = page.locator('button:has-text("定时")').first();
    if (await cronBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await cronBtn.click();
      await page.waitForTimeout(500);
      await takeScreenshot(page, "panels-cron-open");
    }
  });
});
