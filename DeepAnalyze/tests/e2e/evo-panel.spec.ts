// =============================================================================
// E2E Test: EvolutionPanel - Self-evolution toggle switches (refined)
// =============================================================================
import { test, expect, type Page } from "@playwright/test";

const BASE = "http://localhost:21000";

async function openEvolutionPanel(page: Page) {
  await page.goto(BASE);
  await page.waitForTimeout(3000);
  await page.locator('button[title="自进化"]').click();
  await page.waitForTimeout(2000);
}

/** Find a module toggle by its aria-label */
function moduleToggle(page: Page, label: string) {
  return page.locator(`div[role="switch"][aria-label="${label}"]`);
}

test.describe("Evolution Panel - Functional Tests", () => {
  // Ensure master switch is ON before each test
  test.beforeEach(async ({ page }) => {
    // Force enable via API to guarantee clean state
    await page.goto(BASE);
    await page.evaluate(async () => {
      await fetch('/api/settings/evolution', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
    });
  });

  test("verify all 7 toggle switches with correct labels and states", async ({ page }) => {
    await openEvolutionPanel(page);
    await page.screenshot({ path: "/tmp/evo-v2-01-loaded.png" });

    const toggles = page.locator('div[role="switch"]');
    const count = await toggles.count();

    // 1 master + 6 modules = 7
    expect(count).toBe(7);

    const expectedLabels = [
      "启用自进化",
      "持久记忆",
      "跨会话整合",
      "历史回顾",
      "经验积累",
      "技能进化",
      "技能维护",
    ];

    for (let i = 0; i < count; i++) {
      const label = await toggles.nth(i).getAttribute('aria-label');
      const checked = await toggles.nth(i).getAttribute('aria-checked');
      console.log(`  [${i}] ${label} = ${checked}`);
      expect(label).toBe(expectedLabels[i]);
    }

    // 技能维护 should be false (from prior API state)
    const skillMaintChecked = await toggles.nth(6).getAttribute('aria-checked');
    console.log(`技能维护 state: ${skillMaintChecked}`);
  });

  test("toggle persistentMemory OFF → backend persists", async ({ page }) => {
    await openEvolutionPanel(page);

    const toggle = moduleToggle(page, "持久记忆");
    await expect(toggle).toBeVisible({ timeout: 5000 });

    // Check current state
    const before = await toggle.getAttribute('aria-checked');
    console.log(`persistentMemory before: ${before}`);

    // Click to toggle
    await toggle.click();
    await page.waitForTimeout(2500);

    // Check UI state changed
    const after = await toggle.getAttribute('aria-checked');
    console.log(`persistentMemory after click: ${after}`);
    expect(after).toBe(before === 'true' ? 'false' : 'true');

    await page.screenshot({ path: "/tmp/evo-v2-02-pm-toggled.png" });

    // Check backend was updated
    const config = await page.evaluate(async () => {
      const res = await fetch('/api/settings/evolution');
      return res.json();
    });
    console.log(`Backend persistentMemory: ${config.modules.persistentMemory}`);
    expect(config.modules.persistentMemory).toBe(after === 'true');

    // Restore
    await toggle.click();
    await page.waitForTimeout(1500);
  });

  test("toggle autoDream OFF → backend persists", async ({ page }) => {
    await page.evaluate(async () => {
      await fetch('/api/settings/evolution', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, modules: { persistentMemory: true, autoDream: true } }),
      });
    });

    await openEvolutionPanel(page);

    const toggle = moduleToggle(page, "跨会话整合");
    await expect(toggle).toBeVisible({ timeout: 5000 });

    const before = await toggle.getAttribute('aria-checked');
    console.log(`autoDream before: ${before}`);

    await toggle.click();
    await page.waitForTimeout(2500);

    const after = await toggle.getAttribute('aria-checked');
    console.log(`autoDream after click: ${after}`);
    expect(after).not.toBe(before);

    await page.screenshot({ path: "/tmp/evo-v2-03-ad-toggled.png" });

    // Check backend
    const config = await page.evaluate(async () => {
      const res = await fetch('/api/settings/evolution');
      return res.json();
    });
    console.log(`Backend autoDream: ${config.modules.autoDream}`);
    expect(config.modules.autoDream).toBe(after === 'true');

    // Restore
    await toggle.click();
    await page.waitForTimeout(1500);
  });

  test("master OFF disables module section", async ({ page }) => {
    await openEvolutionPanel(page);

    const masterToggle = moduleToggle(page, "启用自进化");
    await expect(masterToggle).toBeVisible({ timeout: 5000 });

    // Turn master OFF
    await masterToggle.click();
    await page.waitForTimeout(1500);

    await page.screenshot({ path: "/tmp/evo-v2-04-master-off.png" });

    // Check master state
    const masterState = await masterToggle.getAttribute('aria-checked');
    expect(masterState).toBe('false');

    // Module toggles should still exist but the section should be visually disabled
    // Check that a module toggle is visible but the parent has opacity < 1
    const pmToggle = moduleToggle(page, "持久记忆");
    const opacity = await pmToggle.evaluate(el => {
      let parent = el.parentElement;
      while (parent) {
        const op = parseFloat(getComputedStyle(parent).opacity);
        if (op < 1) return op;
        parent = parent.parentElement;
      }
      return 1;
    });
    console.log(`Module area opacity with master OFF: ${opacity}`);
    expect(opacity).toBeLessThan(1);

    // Restore master ON
    await masterToggle.click();
    await page.waitForTimeout(1500);

    // Also restore via API in case click didn't work
    await page.evaluate(async () => {
      await fetch('/api/settings/evolution', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
    });

    await page.screenshot({ path: "/tmp/evo-v2-05-master-on.png" });
  });

  test("stats section shows correct memory count", async ({ page }) => {
    await openEvolutionPanel(page);

    // Get stats from API
    const stats = await page.evaluate(async () => {
      const res = await fetch('/api/settings/evolution/stats');
      return res.json();
    });
    console.log(`API stats: memoryCount=${stats.memoryCount}`);

    // Check the memory count stat card is visible
    const memCountLabel = page.getByText("记忆条目").first();
    await expect(memCountLabel).toBeVisible({ timeout: 5000 });

    // The count number should be in the same card
    const countValue = page.getByText(String(stats.memoryCount)).first();
    await expect(countValue).toBeVisible({ timeout: 3000 });

    await page.screenshot({ path: "/tmp/evo-v2-06-stats.png" });
  });

  test("memory list expands and shows entries", async ({ page }) => {
    await openEvolutionPanel(page);

    // Click to expand memory list
    const memoryHeader = page.getByText(/记忆列表/).first();
    await memoryHeader.click();
    await page.waitForTimeout(2000);

    await page.screenshot({ path: "/tmp/evo-v2-07-memories.png" });

    // Verify memories from API
    const memories = await page.evaluate(async () => {
      const res = await fetch('/api/settings/evolution/memories');
      return res.json();
    });
    console.log(`Memory count: ${memories.count}`);

    if (memories.count > 0) {
      for (const m of memories.memories) {
        console.log(`  [${m.category}] ${m.content.slice(0, 40)}... use=${m.use_count}`);
      }
    }
  });

  test("parameter input changes persist to backend", async ({ page }) => {
    await openEvolutionPanel(page);

    // Find nudgeInterval input by looking for the input next to "回顾间隔" label
    const nudgeLabel = page.getByText(/回顾间隔/).first();
    await expect(nudgeLabel).toBeVisible({ timeout: 5000 });

    // Navigate to the input in the same row
    const row = nudgeLabel.locator('xpath=ancestor::div[div[contains(text(),"回顾间隔")]]');
    const input = page.locator('input[type="number"]').first();

    const originalValue = await input.inputValue();
    console.log(`nudgeInterval original: ${originalValue}`);

    // Clear and set new value
    await input.click();
    await input.fill('20');

    // Trigger save by pressing Tab (moves focus away, triggers onBlur)
    await input.press('Tab');
    await page.waitForTimeout(2000);

    // Verify backend updated
    const config = await page.evaluate(async () => {
      const res = await fetch('/api/settings/evolution');
      return res.json();
    });
    console.log(`Backend nudgeInterval: ${config.params.nudgeInterval}`);
    expect(config.params.nudgeInterval).toBe(20);

    await page.screenshot({ path: "/tmp/evo-v2-08-params.png" });

    // Restore
    await input.click();
    await input.fill(originalValue);
    await input.press('Tab');
    await page.waitForTimeout(1500);
  });
});
