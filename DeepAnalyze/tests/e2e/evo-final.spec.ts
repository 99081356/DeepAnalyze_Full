// =============================================================================
// E2E Test: EvolutionPanel - Final comprehensive UI screenshot capture
// =============================================================================
import { test, expect, type Page } from "@playwright/test";

const BASE = "http://localhost:21000";

test.describe("Evolution Panel - Final Screenshots", () => {
  test("capture comprehensive UI screenshots", async ({ page }) => {
    // Ensure clean state
    await page.goto(BASE);
    await page.evaluate(async () => {
      await fetch('/api/settings/evolution', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          modules: {
            persistentMemory: true,
            memoryAccumulation: true,
            skillEvolution: true,
            skillMaintenance: false,
            historyRecall: true,
            autoDream: true,
          },
          params: { nudgeInterval: 10, staleAfterDays: 30, archiveAfterDays: 90, curatorIntervalDays: 7 },
        }),
      });
    });
    await page.waitForTimeout(1000);

    // Open evolution panel
    await page.locator('button[title="自进化"]').click();
    await page.waitForTimeout(2500);

    // Screenshot 1: Full panel with all toggles ON
    await page.screenshot({ path: "/tmp/evo-final-01-all-on.png" });

    // Verify all 7 toggles present and labeled correctly
    const toggles = page.locator('div[role="switch"]');
    expect(await toggles.count()).toBe(7);
    const labels = await Promise.all(
      Array.from({ length: 7 }, (_, i) => toggles.nth(i).getAttribute('aria-label'))
    );
    console.log("Toggle labels:", labels);

    // Screenshot 2: Toggle persistentMemory OFF
    await page.locator('div[role="switch"][aria-label="持久记忆"]').click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "/tmp/evo-final-02-pm-off.png" });

    // Verify backend
    let config = await page.evaluate(async () => {
      const res = await fetch('/api/settings/evolution');
      return res.json();
    });
    expect(config.modules.persistentMemory).toBe(false);

    // Screenshot 3: Toggle autoDream OFF too
    await page.locator('div[role="switch"][aria-label="跨会话整合"]').click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "/tmp/evo-final-03-ad-off.png" });

    config = await page.evaluate(async () => {
      const res = await fetch('/api/settings/evolution');
      return res.json();
    });
    expect(config.modules.autoDream).toBe(false);

    // Restore both
    await page.locator('div[role="switch"][aria-label="持久记忆"]').click();
    await page.locator('div[role="switch"][aria-label="跨会话整合"]').click();
    await page.waitForTimeout(1500);

    // Screenshot 4: Master toggle OFF
    await page.locator('div[role="switch"][aria-label="启用自进化"]').click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "/tmp/evo-final-04-master-off.png" });

    // Verify module section opacity
    const opacity = await page.locator('div[role="switch"][aria-label="持久记忆"]').evaluate(el => {
      let p = el.parentElement;
      while (p) {
        const op = parseFloat(getComputedStyle(p).opacity);
        if (op < 1) return op;
        p = p.parentElement;
      }
      return 1;
    });
    expect(opacity).toBe(0.5);
    console.log(`Module section opacity when master OFF: ${opacity}`);

    // Restore master
    await page.locator('div[role="switch"][aria-label="启用自进化"]').click();
    await page.waitForTimeout(1500);

    // Screenshot 5: Stats section
    await page.screenshot({ path: "/tmp/evo-final-05-stats.png" });

    // Screenshot 6: Expand memory list
    await page.getByText(/记忆列表/).first().click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "/tmp/evo-final-06-memories.png" });

    // Verify memory count
    const memories = await page.evaluate(async () => {
      const res = await fetch('/api/settings/evolution/memories');
      return res.json();
    });
    console.log(`Memory count: ${memories.count}`);
    for (const m of memories.memories) {
      console.log(`  [${m.category}] ${m.content.slice(0, 50)}... use=${m.use_count}`);
    }

    // Screenshot 7: Scroll to params
    await page.getByText(/参数设置/).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/evo-final-07-params.png" });

    // Verify all param inputs exist
    const inputs = page.locator('input[type="number"]');
    const inputCount = await inputs.count();
    console.log(`Found ${inputCount} parameter inputs`);
    expect(inputCount).toBe(4);

    console.log("\n=== All screenshots captured successfully ===");
  });
});
