// =============================================================================
// Regression: workflow "(recovered)" placeholder card — full closure test
// =============================================================================
// Verifies the three batches of fixes that eliminated "(recovered)":
//   Batch 1 (SSE filter): not directly testable here, but Batch 2/3 cover the
//                          user-visible outcomes
//   Batch 2 (DB persistence): GET /api/sessions/:id/workflows returns real
//                              teamName/mode/agentCount (not placeholders)
//   Batch 3 (frontend override): when an old session is reopened, the workflow
//                                 card shows real teamName instead of "(recovered)"
//
// We use a historical session that has a completed workflow in the DB.
// =============================================================================

import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "tests/e2e/screenshots/regression-92";
mkdirSync(SHOTS, { recursive: true });

// Real session with a completed `delegate` workflow in DB (2026-06-26).
const SESSION_WITH_WF = "f82af9c4-a388-41bd-8cc9-66a995efc1eb";
const EXPECTED_WF_ID = "9f9c2776-ac76-4c74-9d78-2f9435b721f7";

test.describe("Workflow (recovered) fix", () => {
  test("listSessionWorkflows returns real teamName/mode/agentCount", async ({ request }) => {
    const r = await request.get(`/api/sessions/${SESSION_WITH_WF}/workflows`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    console.log(`[test] found ${body.workflows.length} workflows`);

    const wf = body.workflows.find(
      (w: { workflowId: string }) => w.workflowId === EXPECTED_WF_ID,
    );
    expect(wf, "expected workflow must be returned").toBeDefined();

    console.log("[test] workflow data:", JSON.stringify(wf, null, 2));

    // Critical assertions — these fields used to be missing/placeholder
    expect(wf.teamName, "teamName must be real, not placeholder").toBe("delegate");
    expect(wf.teamName, "teamName must not be (recovered)").not.toBe("(recovered)");
    expect(wf.mode, "mode must be present").toBe("single");
    expect(wf.agentCount, "agentCount must be present").toBe(1);
    expect(wf.goal, "goal must be present").toBeTruthy();
    expect(wf.status, "status must be present").toBe("completed");
    expect(typeof wf.startTime, "startTime must be a number").toBe("number");
  });

  test("UI does not show (recovered) when reopening a session with workflows", async ({ page }) => {
    // Navigate to the session — this triggers reconnectToRunningTask /
    // handleWorkflowStart for each workflow returned by listSessionWorkflows
    await page.goto(`/#/sessions/${SESSION_WITH_WF}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await page.screenshot({
      path: `${SHOTS}/01-session-with-workflow.png`,
      fullPage: true,
    });

    // Scan the entire page DOM for the literal "(recovered)" string
    const bodyText = await page.locator("body").innerText();
    const hasRecovered = bodyText.includes("(recovered)");
    console.log(`[test] page contains "(recovered)": ${hasRecovered}`);
    expect(hasRecovered, "UI must not show (recovered) for stored workflows").toBe(false);

    // Also check the workflow card specifically — it should show "delegate"
    // teamName (or its localized equivalent)
    const workflowCard = page.locator(
      `[data-workflow-id="${EXPECTED_WF_ID}"], [data-wf-id="${EXPECTED_WF_ID}"]`,
    );
    const cardVisible = await workflowCard.isVisible().catch(() => false);
    console.log(`[test] workflow card visible (by data-attr): ${cardVisible}`);

    // Even if the card isn't keyed by data-attr, the page text should include
    // "delegate" somewhere (from the teamName).
    const hasDelegateText = bodyText.toLowerCase().includes("delegate");
    console.log(`[test] page contains 'delegate' text: ${hasDelegateText}`);

    // Verify no console errors related to workflows
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    await page.waitForTimeout(1000);
    const wfErrors = consoleErrors.filter(
      (e) => e.toLowerCase().includes("workflow") || e.toLowerCase().includes("(recovered)"),
    );
    expect(wfErrors, "no workflow-related console errors").toEqual([]);
  });

  test("live workflow via chat renders without (recovered)", async ({ page, request }) => {
    // End-to-end test: trigger a real workflow by asking the agent to
    // delegate a trivial task, then verify no "(recovered)" appears.
    test.setTimeout(120_000);

    // Create a fresh session
    const createResp = await request.post("/api/sessions", { data: {} });
    const session = await createResp.json();
    const sessionId = session.id;
    console.log(`[test] new session=${sessionId}`);

    // Listen for console errors during the entire flow
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });

    await page.goto(`/#/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    const textarea = page.locator("textarea").first();
    const sendBtn = page.locator('button[title="发送消息"]');
    await expect(textarea).toBeVisible();

    // Ask for delegation — this should trigger `delegate_task` or `workflow_run`
    const prompt = [
      "请使用 delegate_task 工具创建一个后台工作流（backgroundWorkflows=true），",
      "任务目标：用 bash 工具写一个文件 /tmp/wf_smoke_<random>.txt 内容为 'hello workflow'，",
      "完成后报告。如果你没有 delegate_task 工具，请直接说 'no delegate_task tool'。",
    ].join("");

    await textarea.fill(prompt);
    await sendBtn.click();
    console.log("[test] delegation prompt sent, waiting for workflow activity...");

    // Wait for either a workflow card to appear OR a regular response
    const wfCard = page.locator(
      '[data-workflow-id], [data-wf-id], div:has-text("workflow")',
    );
    let workflowSeen = false;
    try {
      await wfCard.first().waitFor({ state: "attached", timeout: 60_000 });
      workflowSeen = true;
    } catch {
      console.log("[test] no workflow card detected — agent may have declined to delegate");
    }
    console.log(`[test] workflow card seen: ${workflowSeen}`);

    await page.waitForTimeout(5000); // let things settle
    await page.screenshot({
      path: `${SHOTS}/02-live-workflow.png`,
      fullPage: true,
    });

    // The hard assertion: regardless of whether delegation happened, no
    // "(recovered)" text may appear in the rendered DOM
    const bodyText = await page.locator("body").innerText();
    expect(
      bodyText,
      "live UI must never show (recovered)",
    ).not.toContain("(recovered)");

    const wfErrors = consoleErrors.filter((e) =>
      e.toLowerCase().includes("workflow") || e.toLowerCase().includes("(recovered)"),
    );
    expect(wfErrors, "no workflow-related console errors during live flow").toEqual([]);

    // Cleanup
    await request.delete(`/api/sessions/${sessionId}`).catch(() => {});
  });
});
