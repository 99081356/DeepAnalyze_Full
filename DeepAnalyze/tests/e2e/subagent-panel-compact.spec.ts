// =============================================================================
// DeepAnalyze - SubAgentPanel Compact Mode E2E Tests
// =============================================================================
// Validates the "progressive compaction + collapse-all" UI shipped in
// commit d8d0a4b (spec: 2026-06-27-subagent-panel-compaction-design.md).
//
// Test strategy: inject workflows directly into the Zustand store via the
// `window.__WORKFLOW_STORE__` test hook. This isolates frontend rendering
// from backend event delivery (already covered by workflow-event-delivery).
//
// Coverage:
//   TC-COMPACT-1 — 5 workflows (1 running + 4 completed) → auto-compaction
//   TC-COMPACT-2 — "收起全部" toggle forces all to compact (incl. running)
//   TC-COMPACT-3 — Click compact row → expanded-detail + userOverride lock
//   TC-COMPACT-4 — Single workflow → no compaction triggered
//
// Run: npx playwright test tests/e2e/subagent-panel-compact.spec.ts --reporter=list
// =============================================================================

import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "tests/e2e/screenshots/subagent-compact";
mkdirSync(SHOTS, { recursive: true });

// Use a real session so ChatWindow's `currentSessionId` filter includes our
// injected workflows. Create one per test run for isolation.
const BASE = "http://localhost:21000";

async function newSession(): Promise<string> {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "compact-mode-test" }),
  });
  if (!r.ok) throw new Error(`session create failed: ${r.status}`);
  const body = await r.json() as { id?: string };
  if (!body.id) throw new Error(`session create returned no id: ${JSON.stringify(body)}`);
  return body.id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface InjectAgent {
  id: string;
  role: string;
  task: string;
  status: "running" | "completed" | "error";
}

interface InjectWorkflow {
  id: string;
  teamName: string;
  mode?: string;
  agents: InjectAgent[];
}

/** Inject workflows via the test hook on window.__WORKFLOW_STORE__. */
async function injectWorkflows(page: import("@playwright/test").Page, wfs: InjectAgent[] | InjectWorkflow[], _tag?: string) {
  // Accept either shape for flexibility; normalize to InjectWorkflow[]
  const workflows = (wfs as (InjectWorkflow | InjectAgent)[]).map((w, i) =>
    "agents" in w ? w : { id: `wf-${i}`, teamName: `WF${i}`, agents: [w as InjectAgent] },
  ) as InjectWorkflow[];

  await page.evaluate(async (wfsEv) => {
    const store = (window as any).__WORKFLOW_STORE__;
    if (!store) throw new Error("__WORKFLOW_STORE__ not exposed on window");

    // Clear any prior state so tests are independent
    const active = store.getState().activeWorkflows as Map<string, unknown>;
    for (const id of Array.from(active.keys())) {
      store.getState().clearWorkflow(id);
    }
    // Reset compaction UI state too
    store.getState().setForceCompactAll(false);

    for (const wf of wfsEv as InjectWorkflow[]) {
      store.getState().handleWorkflowStart({
        workflowId: wf.id,
        teamName: wf.teamName,
        mode: wf.mode ?? "parallel",
        agentCount: wf.agents.length,
      });
      for (const agent of wf.agents) {
        store.getState().handleAgentStart({
          workflowId: wf.id,
          agentId: agent.id,
          role: agent.role,
          task: agent.task,
        });
        if (agent.status === "completed") {
          store.getState().handleAgentComplete({
            workflowId: wf.id,
            agentId: agent.id,
            duration: 10,
          });
        } else if (agent.status === "error") {
          store.getState().handleAgentComplete({
            workflowId: wf.id,
            agentId: agent.id,
            error: "test injected error",
            duration: 10,
          });
        }
        // running → leave as-is
      }
    }
  }, workflows);
  // Let React render
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("SubAgentPanel Compact Mode", () => {
  let sessionId: string;

  test.beforeAll(async () => {
    sessionId = await newSession();
    console.log(`[setup] created session ${sessionId}`);
  });

  test.beforeEach(async ({ page }) => {
    // Navigate to the real session so ChatWindow sets currentSessionId.
    // Default Playwright viewport is 1280×720; 40vh = 288px, 50vh = 360px.
    // 5 expanded panels × 88px = 440px → well above the 40vh compaction threshold.
    await page.goto(`/#/sessions/${sessionId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(500);
  });

  test("TC-COMPACT-1: 5 workflows (1 running + 4 completed) auto-compacts non-running", async ({ page }) => {
    await injectWorkflows(page, [
      {
        id: "wf-run-1",
        teamName: "运行中工作流",
        agents: [{ id: "a1", role: "运行分析员", task: "x", status: "running" }],
      },
      { id: "wf-done-1", teamName: "已完成A", agents: [{ id: "a2", role: "检索员A", task: "x", status: "completed" }] },
      { id: "wf-done-2", teamName: "已完成B", agents: [{ id: "a3", role: "检索员B", task: "x", status: "completed" }] },
      { id: "wf-done-3", teamName: "已完成C", agents: [{ id: "a4", role: "检索员C", task: "x", status: "completed" }] },
      { id: "wf-done-4", teamName: "已完成D", agents: [{ id: "a5", role: "检索员D", task: "x", status: "completed" }] },
    ]);

    await page.screenshot({ path: `${SHOTS}/tc1-01-after-inject.png`, fullPage: true });

    // Stack header is visible
    await expect(page.locator('[data-testid="subagent-stack-header"]')).toBeVisible();
    // Header summary mentions 5 total + 1 running
    const headerText = await page.locator('[data-testid="subagent-stack-header"]').innerText();
    expect(headerText, "header should show total=5").toContain("5");
    expect(headerText, "header should show running=1").toContain("1 运行中");

    // Running workflow stays expanded (chips visible)
    const runPanel = page.locator('[data-workflow-id="wf-run-1"]');
    await expect(runPanel).toBeVisible();
    await expect(runPanel).toHaveAttribute("data-panel-mode", "expanded");
    // Running workflow's chip text is visible (proves chips rendered)
    await expect(page.getByText("运行分析员").first()).toBeVisible();

    // All 4 completed workflows auto-compacted
    for (const id of ["wf-done-1", "wf-done-2", "wf-done-3", "wf-done-4"]) {
      const panel = page.locator(`[data-workflow-id="${id}"]`);
      await expect(panel).toHaveAttribute("data-panel-mode", "compact");
    }

    // Wrapper clientHeight ≤ 50vh + buffer (header included in wrapper)
    const dims = await page.locator('[data-testid="subagent-stack"]').evaluate((el) => ({
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    const vh = await page.evaluate(() => window.innerHeight);
    console.log(`[tc1] stack client=${dims.clientHeight}px scroll=${dims.scrollHeight}px vh=${vh}px`);
    expect(dims.clientHeight, "wrapper clientHeight must respect 50vh cap").toBeLessThanOrEqual(vh * 0.5 + 1);
  });

  test("TC-COMPACT-2: 收起全部 button forces all panels (incl. running) to compact", async ({ page }) => {
    // 5 running workflows → all normally expanded (chips visible) because of hasRunning rule
    await injectWorkflows(page, [
      { id: "wf-a", teamName: "工作流A", agents: [{ id: "a1", role: "分析员A", task: "x", status: "running" }] },
      { id: "wf-b", teamName: "工作流B", agents: [{ id: "a2", role: "分析员B", task: "x", status: "running" }] },
      { id: "wf-c", teamName: "工作流C", agents: [{ id: "a3", role: "分析员C", task: "x", status: "running" }] },
      { id: "wf-d", teamName: "工作流D", agents: [{ id: "a4", role: "分析员D", task: "x", status: "running" }] },
      { id: "wf-e", teamName: "工作流E", agents: [{ id: "a5", role: "分析员E", task: "x", status: "running" }] },
    ]);

    // Pre-condition: at least one running panel is expanded (proves baseline)
    await expect(page.locator('[data-workflow-id="wf-a"]')).toHaveAttribute("data-panel-mode", "expanded");
    await page.screenshot({ path: `${SHOTS}/tc2-01-before-collapse.png`, fullPage: true });

    // Click "收起全部"
    const btn = page.locator('[data-testid="subagent-collapse-all"]');
    await expect(btn).toContainText("收起全部");
    await btn.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/tc2-02-after-collapse.png`, fullPage: true });

    // All 5 panels should be compact now (including running ones)
    for (const id of ["wf-a", "wf-b", "wf-c", "wf-d", "wf-e"]) {
      await expect(
        page.locator(`[data-workflow-id="${id}"]`),
        `${id} should be compact after collapse-all`,
      ).toHaveAttribute("data-panel-mode", "compact");
    }

    // Button label flipped
    await expect(btn).toContainText("展开全部");

    // Click again to expand all
    await btn.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/tc2-03-after-expand.png`, fullPage: true });

    // Running workflows restored to expanded
    await expect(page.locator('[data-workflow-id="wf-a"]')).toHaveAttribute("data-panel-mode", "expanded");
  });

  test("TC-COMPACT-3: click compact row → detail + userOverride locks expansion", async ({ page }) => {
    // 5 completed workflows → all auto-compacted (none running)
    await injectWorkflows(page, [
      { id: "wf-1", teamName: "压缩A", agents: [{ id: "a1", role: "员1", task: "x", status: "completed" }] },
      { id: "wf-2", teamName: "压缩B", agents: [{ id: "a2", role: "员2", task: "x", status: "completed" }] },
      { id: "wf-3", teamName: "压缩C", agents: [{ id: "a3", role: "员3", task: "x", status: "completed" }] },
      { id: "wf-4", teamName: "压缩D", agents: [{ id: "a4", role: "员4", task: "x", status: "completed" }] },
      { id: "wf-5", teamName: "压缩E", agents: [{ id: "a5", role: "员5", task: "x", status: "completed" }] },
    ]);

    // All start in compact mode
    await expect(page.locator('[data-workflow-id="wf-3"]')).toHaveAttribute("data-panel-mode", "compact");
    await page.screenshot({ path: `${SHOTS}/tc3-01-all-compact.png`, fullPage: true });

    // Click compact row of wf-3 → enters detail mode.
    // Click on the teamName text so the click reliably lands on the clickable row
    // (clicking [data-workflow-id] hits the outer container whose center may miss
    // the inner onClick region in detail mode).
    await page.getByText("压缩C").click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/tc3-02-wf3-expanded.png`, fullPage: true });

    await expect(page.locator('[data-workflow-id="wf-3"]')).toHaveAttribute("data-panel-mode", "detail");

    // userOverride[wf-3] should be set to "expanded"
    const overrideSet = await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      return store.getState().userOverride.get("wf-3") ?? null;
    });
    expect(overrideSet, "userOverride must lock wf-3 to expanded").toBe("expanded");

    // Now toggle forceCompactAll — wf-3 should remain in detail (override wins)
    await page.locator('[data-testid="subagent-collapse-all"]').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/tc3-03-override-wins.png`, fullPage: true });

    await expect(
      page.locator('[data-workflow-id="wf-3"]'),
      "wf-3 must stay detailed despite forceCompactAll (userOverride wins)",
    ).toHaveAttribute("data-panel-mode", "detail");

    // Click wf-3 teamName again → exit detail, override cleared.
    // Use teamName text so the click lands on the title bar (the outer container
    // center is over the agent detail list, which has no onClick).
    await page.getByText("压缩C").click();
    await page.waitForTimeout(300);

    const overrideCleared = await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      return store.getState().userOverride.get("wf-3") ?? null;
    });
    expect(overrideCleared, "userOverride must be cleared after exiting detail").toBeNull();
  });

  test("TC-COMPACT-4: single workflow — no compaction triggered", async ({ page }) => {
    await injectWorkflows(page, [
      {
        id: "wf-solo",
        teamName: "单工作流",
        agents: [{ id: "a1", role: "分析员", task: "x", status: "running" }],
      },
    ]);

    await page.screenshot({ path: `${SHOTS}/tc4-01-single-wf.png`, fullPage: true });

    // Single workflow's expanded panel is ~88px << 40vh threshold → autoCompact = false
    const autoCompact = await page.evaluate(() => {
      // Re-derive: single wf, 1 agent, expanded = 88px, 40vh@720 = 288 → no compact
      return false; // we'll assert via DOM behavior below
    });
    void autoCompact;

    // Force flag stays default
    const forceCompact = await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      return store.getState().forceCompactAll;
    });
    expect(forceCompact, "forceCompactAll must default to false").toBe(false);

    // Panel must be in expanded mode (chips visible)
    await expect(page.locator('[data-workflow-id="wf-solo"]')).toHaveAttribute("data-panel-mode", "expanded");
    await expect(page.getByText("分析员").first()).toBeVisible();

    // Stack header is still visible (implementation choice: always show for ≥1 wf,
    // consistent with spec's "or hidden" wording — we chose visible for UI consistency)
    await expect(page.locator('[data-testid="subagent-stack-header"]')).toBeVisible();
  });
});
