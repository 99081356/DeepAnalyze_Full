// =============================================================================
// tests/e2e/auth-flow.spec.ts
// =============================================================================
// E2E tests for the auth distribution system: setup wizard + login flow.
//
// PREREQUISITES:
//   Test 1 (local mode setup + login):
//     - Fresh data directory: delete data/setup-complete.flag and data/config.yaml
//     - DA_AUTH_MODE not set (defaults to none, wizard will configure local)
//     - Server running: python3 start.py --no-docker --port 21000
//
//   Test 2 (none mode skips login):
//     - Setup already complete with DA_AUTH_MODE=none
//     - data/setup-complete.flag exists
//     - Server running with DA_AUTH_MODE=none
//
// These tests modify persistent state. Run them against a disposable instance.
// =============================================================================

import { test, expect, type Page } from "@playwright/test";

const BASE_URL = "http://localhost:21000";

// Helper: wait for SetupWizard to appear (App.tsx needsSetup gate)
async function waitForSetupWizard(page: Page): Promise<void> {
  // The wizard card has the "环境检测" heading (step 0)
  await page.waitForSelector("text=环境检测", { timeout: 10_000 });
}

// Helper: click "下一步" button (visible Next button in the current step)
async function clickNext(page: Page): Promise<void> {
  await page.click('button:has-text("下一步")');
  await page.waitForTimeout(300);
}

test.describe.serial("Auth flow", () => {
  // -------------------------------------------------------------------------
  // Test 1: Full setup wizard → local mode → login → chat
  // -------------------------------------------------------------------------
  test("local mode setup + login", async ({ page }) => {
    // Navigate to root — App.tsx gate shows SetupWizard when setup incomplete
    await page.goto(BASE_URL);
    await waitForSetupWizard(page);

    // Step 0 (环境检测): wait for detection, click Next
    await page.waitForSelector("text=CPU：", { timeout: 15_000 });
    await clickNext(page);

    // Step 1 (模式选择): select 个人版
    await page.click("text=个人版（Standalone）");
    await clickNext(page);

    // Step 2 (认证配置): select 启用登录, fill credentials
    await page.click("text=启用登录");
    await page.fill('input[placeholder="admin"]', "admin");
    await page.fill('input[placeholder="•••••••"]', "test1234");
    await clickNext(page);

    // Step 3 (模型策略): select 全部云端 API (fastest, no downloads)
    await page.click("text=全部云端 API");
    await clickNext(page);

    // Step 4 (模型下载): no download needed for all_cloud, click Next
    await clickNext(page);

    // Step 5 (完成): click 完成设置
    await page.click('button:has-text("完成设置")');

    // After setup completes, App.tsx calls window.location.reload()
    // With DA_AUTH_MODE now configured as local, LoginPage appears
    await page.waitForSelector('input[placeholder="用户名"]', { timeout: 10_000 });

    // Login with the admin account created during setup
    await page.fill('input[placeholder="用户名"]', "admin");
    await page.fill('input[placeholder="密码"]', "test1234");
    await page.click('button:has-text("登录")');

    // Should land on #/chat
    await page.waitForURL(/#\/chat/, { timeout: 10_000 });
    expect(page.url()).toContain("#/chat");
  });

  // -------------------------------------------------------------------------
  // Test 2: none mode — direct access, no login required
  // -------------------------------------------------------------------------
  test("none mode skips login", async ({ page }) => {
    // Prerequisite: setup complete, DA_AUTH_MODE=none
    // Navigate to root — should go directly to chat (no LoginPage, no wizard)
    await page.goto(BASE_URL);

    // Should land on #/chat without any login screen
    await page.waitForURL(/#\/chat/, { timeout: 10_000 });
    expect(page.url()).toContain("#/chat");

    // Verify no login form is visible
    await expect(page.locator('input[placeholder="用户名"]')).toHaveCount(0);
  });
});
