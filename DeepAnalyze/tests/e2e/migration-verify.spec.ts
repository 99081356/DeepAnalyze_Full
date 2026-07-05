// =============================================================================
// E2E Test: MCP UI + Cron UI + Settings Panel Verification
// Uses Playwright with screenshots to verify all migrated features
// =============================================================================

import { test, expect } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:21000";

// Helper: take screenshot with a descriptive name
async function screenshot(page: any, name: string) {
  const path = `/tmp/migration-e2e-${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(`Screenshot saved: ${path}`);
  return path;
}

// Helper: open a specific right panel by clicking its header button
async function openPanel(page: any, panelTitle: string) {
  const btn = page.locator(`header button[title="${panelTitle}"]`);
  await btn.click();
  await page.waitForTimeout(1500);
}

test.describe("Migration E2E: Settings Panel with MCP Tab", () => {
  test("Settings panel opens and shows MCP tab", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForTimeout(3000);
    await screenshot(page, "01-home");

    // Click the Settings button in header (title="设置")
    await openPanel(page, "设置");
    await screenshot(page, "02-settings-panel");

    // Verify settings panel is visible - look for tab labels
    const modelsTab = page.getByText("模型配置", { exact: false });
    expect(await modelsTab.count()).toBeGreaterThan(0);

    // Click MCP tab
    const mcpTab = page.getByText("MCP 服务");
    expect(await mcpTab.count()).toBeGreaterThan(0);
    await mcpTab.click();
    await page.waitForTimeout(2000);
    await screenshot(page, "03-mcp-tab");

    // Verify MCP panel content - should show server count or info text
    const mcpContent = page.locator('text=/MCP.*服务|服务器|暂无|共.*个服务器/');
    expect(await mcpContent.count()).toBeGreaterThan(0);
  });

  test("MCP panel shows existing servers", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForTimeout(3000);

    await openPanel(page, "设置");
    await page.waitForTimeout(1500);

    // Click MCP tab
    await page.getByText("MCP 服务").click();
    await page.waitForTimeout(2000);
    await screenshot(page, "04-mcp-servers-list");

    // Should show server count (the system has 8 pre-configured MCP servers)
    const serverCount = page.locator('text=/共 \\d+ 个服务器/');
    expect(await serverCount.count()).toBeGreaterThan(0);
    console.log("MCP server count text found");
  });

  test("MCP add server form works", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForTimeout(3000);

    await openPanel(page, "设置");
    await page.waitForTimeout(1500);

    await page.getByText("MCP 服务").click();
    await page.waitForTimeout(2000);

    // Click "添加" button in MCP panel
    const addBtn = page.locator('button:has-text("添加")');
    await addBtn.click();
    await page.waitForTimeout(1000);
    await screenshot(page, "05-mcp-add-form");

    // Verify form fields exist
    const idInput = page.locator('input[placeholder="unique-server-id"]');
    expect(await idInput.count()).toBe(1);

    const nameInput = page.locator('input[placeholder="My MCP Server"]');
    expect(await nameInput.count()).toBe(1);

    // Fill in the form
    await idInput.fill("test-playwright-server");
    await nameInput.fill("Playwright Test Server");

    // Select SSE type
    const sseBtn = page.getByText("sse", { exact: true });
    await sseBtn.click();

    // Fill URL
    const urlInput = page.locator('input[placeholder="http://localhost:3001/sse"]');
    await urlInput.fill("http://localhost:9999/sse");

    await screenshot(page, "06-mcp-form-filled");

    // Cancel instead of saving (don't pollute the DB)
    const cancelBtn = page.getByText("取消");
    await cancelBtn.click();
    await page.waitForTimeout(500);
    await screenshot(page, "07-mcp-form-cancelled");
  });
});

test.describe("Migration E2E: Cron Panel", () => {
  test("Cron panel opens and shows empty state", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForTimeout(3000);

    // Click the Clock button in header (title="定时任务")
    await openPanel(page, "定时任务");
    await page.waitForTimeout(2000);
    await screenshot(page, "08-cron-panel");

    // Should show cron management UI
    const cronTitle = page.locator('text=/定时任务|Cron/');
    expect(await cronTitle.count()).toBeGreaterThan(0);
  });
});

test.describe("Migration E2E: API Endpoints", () => {
  test("MCP API CRUD works", async ({ request }) => {
    // List servers
    const listResp = await request.get(`${BASE_URL}/api/mcp`);
    expect(listResp.ok()).toBeTruthy();
    const listData = await listResp.json();
    expect(Array.isArray(listData)).toBeTruthy();
    console.log(`MCP servers: ${listData.length}`);

    // MCP Status
    const statusResp = await request.get(`${BASE_URL}/api/mcp/status`);
    expect(statusResp.ok()).toBeTruthy();
    const statusData = await statusResp.json();
    expect(Array.isArray(statusData)).toBeTruthy();
    console.log(`MCP statuses: ${statusData.length}`);

    // Add test server
    const addResp = await request.post(`${BASE_URL}/api/mcp`, {
      data: {
        id: "test-e2e-server",
        name: "E2E Test Server",
        type: "sse",
        url: "http://localhost:9999/sse",
        enabled: false,
      },
    });
    expect(addResp.ok()).toBeTruthy();

    // Verify added
    const listResp2 = await request.get(`${BASE_URL}/api/mcp`);
    const listData2 = await listResp2.json();
    const found = listData2.find((s: any) => s.id === "test-e2e-server");
    expect(found).toBeTruthy();
    expect(found.name).toBe("E2E Test Server");

    // Delete test server
    const delResp = await request.delete(`${BASE_URL}/api/mcp/test-e2e-server`);
    expect(delResp.ok()).toBeTruthy();

    // Verify deletion
    const listResp3 = await request.get(`${BASE_URL}/api/mcp`);
    const listData3 = await listResp3.json();
    const found2 = listData3.find((s: any) => s.id === "test-e2e-server");
    expect(found2).toBeFalsy();
    console.log("MCP CRUD: add/list/delete all passed");
  });

  test("Cron API CRUD works", async ({ request }) => {
    // List jobs (should be empty or have some jobs)
    const listResp = await request.get(`${BASE_URL}/api/cron/jobs`);
    expect(listResp.ok()).toBeTruthy();
    const listData = await listResp.json();
    expect(Array.isArray(listData)).toBeTruthy();
    console.log(`Cron jobs before: ${listData.length}`);

    // Create a cron job
    const createResp = await request.post(`${BASE_URL}/api/cron/jobs`, {
      data: {
        name: "E2E Test Cron Job",
        schedule: "0 */6 * * *",
        message: "This is a test cron job from e2e tests",
        enabled: false,
      },
    });
    expect(createResp.ok()).toBeTruthy();
    const jobData = await createResp.json();
    const jobId = jobData.id;
    console.log("Created cron job:", jobId);

    // Validate cron expression
    const validateResp = await request.post(`${BASE_URL}/api/cron/validate`, {
      data: { schedule: "0 9 * * 1-5" },
    });
    expect(validateResp.ok()).toBeTruthy();
    const validateData = await validateResp.json();
    expect(validateData.valid).toBeTruthy();
    console.log("Cron validate:", JSON.stringify(validateData));

    // List jobs - should include our job
    const listResp2 = await request.get(`${BASE_URL}/api/cron/jobs`);
    const listData2 = await listResp2.json();
    const found = listData2.find((j: any) => j.id === jobId);
    expect(found).toBeTruthy();
    expect(found.name).toBe("E2E Test Cron Job");
    expect(found.schedule).toBe("0 */6 * * *");

    // Get single job
    const getResp = await request.get(`${BASE_URL}/api/cron/jobs/${jobId}`);
    expect(getResp.ok()).toBeTruthy();
    const job = await getResp.json();
    expect(job.name).toBe("E2E Test Cron Job");

    // Delete the job
    const delResp = await request.delete(`${BASE_URL}/api/cron/jobs/${jobId}`);
    expect(delResp.ok()).toBeTruthy();

    // Verify deletion
    const listResp3 = await request.get(`${BASE_URL}/api/cron/jobs`);
    const listData3 = await listResp3.json();
    const found2 = listData3.find((j: any) => j.id === jobId);
    expect(found2).toBeFalsy();
    console.log("Cron CRUD: create/list/get/delete all passed");
  });

  test("Health and sessions API work", async ({ request }) => {
    const healthResp = await request.get(`${BASE_URL}/api/health`);
    expect(healthResp.ok()).toBeTruthy();

    const sessionsResp = await request.get(`${BASE_URL}/api/sessions`);
    expect(sessionsResp.ok()).toBeTruthy();
    const sessions = await sessionsResp.json();
    expect(Array.isArray(sessions)).toBeTruthy();
    console.log(`Sessions: ${sessions.length}`);
  });
});
