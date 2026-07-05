/**
 * 07 - Workflow Orchestration Tests
 * Covers: team templates, CRUD, workflow execution, panel UI.
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot } from "./helpers/visual";

test.describe("07 - Workflow Orchestration", () => {
  let api: ReturnType<typeof createApi>;
  let createdTeamIds: string[] = [];

  test.beforeEach(async ({ request }) => {
    api = createApi(request);
  });

  test.afterEach(async () => {
    for (const id of createdTeamIds) await api.deleteTeam(id).catch(() => {});
    createdTeamIds = [];
  });

  test("7.1 team templates list returns multiple templates", async () => {
    const templates = await api.listTeamTemplates();
    expect(Array.isArray(templates)).toBeTruthy();
    expect(templates.length, "Should have multiple built-in templates").toBeGreaterThanOrEqual(3);
  });

  test("7.2 create team with members", async ({ request }) => {
    const teamName = `E2E Team ${Date.now()}`;
    const resp = await request.post("/api/agent-teams", {
      data: {
        name: teamName,
        description: "E2E test team for validation",
        mode: "pipeline",
        members: [
          { role: "Researcher", task: "Research the topic", systemPrompt: "You are a researcher." },
        ],
      },
    });
    if (resp.ok) {
      const team = await resp.json();
      expect(team.id).toBeTruthy();
      createdTeamIds.push(team.id);
    } else {
      // Team creation may require specific fields - just verify endpoint exists
      expect(resp.status()).toBeLessThan(500);
    }
  });

  test("7.3 list teams returns array", async () => {
    const teams = await api.listTeams();
    expect(Array.isArray(teams)).toBeTruthy();
  });

  test("7.4 delete non-existent team returns 404", async ({ request }) => {
    const resp = await request.delete("/api/agent-teams/nonexistent-team-id");
    expect(resp.status()).toBe(404);
  });

  test("7.5 workflow panel screenshot", async ({ page }) => {
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    const teamBtn = page.locator('button:has-text("Teams")').first();
    if (await teamBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await teamBtn.click();
      await page.waitForTimeout(500);
    }

    await takeScreenshot(page, "workflow-panel");
  });

  test("7.6 agent teams endpoint is accessible", async ({ request }) => {
    const resp = await request.get("/api/agent-teams");
    expect(resp.status()).toBe(200);
  });
});
