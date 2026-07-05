/**
 * Session Isolation E2E Tests
 *
 * Tests that verify:
 * - Stop button cancels backend tasks (main + sub-agents)
 * - Sessions are fully isolated (no cross-session content)
 * - Multiple sessions can operate concurrently
 * - Session switching preserves state and doesn't corrupt data
 */
import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a session via API */
async function createSession(page: import("@playwright/test").Page, title: string) {
  const resp = await page.request.post("/api/sessions", {
    data: { title },
  });
  expect(resp.ok()).toBeTruthy();
  return resp.json() as Promise<{ id: string; title: string }>;
}

/** Delete a session via API */
async function deleteSession(page: import("@playwright/test").Page, id: string) {
  await page.request.delete(`/api/sessions/${id}`).catch(() => {});
}

/** Navigate to a session's chat view */
async function navigateToSession(page: import("@playwright/test").Page, sessionId: string) {
  await page.goto(`/#/sessions/${sessionId}`);
  await page.waitForLoadState("networkidle");
}

/** Send a message in the current session */
async function sendMessage(page: import("@playwright/test").Page, text: string) {
  const textarea = page.locator("textarea").first();
  await textarea.fill(text);
  await textarea.press("Enter");
}

/** Wait for streaming to begin (stop button appears) */
async function waitForStreamingStart(page: import("@playwright/test").Page, timeout = 15000) {
  // Wait for either the thinking indicator or the stop button
  await page.locator('button[title="停止生成"]').waitFor({ state: "visible", timeout });
}

/** Wait for streaming to finish (stop button gone) */
async function waitForStreamingEnd(page: import("@playwright/test").Page, timeout = 120000) {
  await page.locator('button[title="停止生成"]').waitFor({ state: "hidden", timeout });
}

/** Get the AI response content for the current session */
async function getAIResponseCount(page: import("@playwright/test").Page): Promise<number> {
  // Count AI avatar elements ("AI" text in avatar divs)
  return page.locator("div.markdown-content").count();
}

// ---------------------------------------------------------------------------
// Cleanup: remove test sessions before/after
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  // Clean up any leftover test sessions
  const resp = await page.request.get("/api/sessions");
  if (resp.ok()) {
    const sessions = await resp.json();
    for (const s of sessions) {
      if (s.title?.startsWith("ISO-TEST-")) {
        await page.request.delete(`/api/sessions/${s.id}`).catch(() => {});
      }
    }
  }
});

// ---------------------------------------------------------------------------
// T1: Stop button cancels backend task
// ---------------------------------------------------------------------------
test("T1: stop button cancels backend task", async ({ page }) => {
  const session = await createSession(page, "ISO-TEST-T1-Stop");
  await navigateToSession(page, session.id);

  // Send a query that will trigger a long-running agent task
  await sendMessage(page, "请分析知识库中所有文档的概况，包括数量、文件名列表、主要内容摘要");

  // Wait for streaming to start
  await waitForStreamingStart(page);

  // Verify streaming is active — stop button visible
  const stopBtn = page.locator('button[title="停止生成"]');
  await expect(stopBtn).toBeVisible();

  // Click stop
  await stopBtn.click();

  // Wait a moment for the cancel to propagate
  await page.waitForTimeout(2000);

  // Verify streaming has stopped
  await expect(stopBtn).toBeHidden({ timeout: 10000 });

  // Verify the backend task was cancelled by checking the agent tasks API
  const tasksResp = await page.request.get(`/api/agents/tasks?sessionId=${session.id}`);
  if (tasksResp.ok()) {
    const tasks = await tasksResp.json();
    const latestTask = tasks[0];
    if (latestTask) {
      // Task should be cancelled, failed, or completed (not running)
      expect(["cancelled", "failed", "completed"]).toContain(latestTask.status);
    }
  }

  await deleteSession(page, session.id);
});

// ---------------------------------------------------------------------------
// T2: Stop button cancels sub-agents (workflow scenario)
// ---------------------------------------------------------------------------
test("T2: stop button cancels workflow sub-agents", async ({ page }) => {
  const session = await createSession(page, "ISO-TEST-T2-WorkflowStop");
  await navigateToSession(page, session.id);

  // Send a query likely to trigger workflow_run
  await sendMessage(page, "请使用多Agent并行模式，用两个Agent分别搜索知识库中前5个文档和后5个文档的内容");

  // Wait for streaming to start (may take longer for workflow setup)
  await waitForStreamingStart(page, 30000);

  // Click stop
  const stopBtn = page.locator('button[title="停止生成"]');
  await stopBtn.click();

  // Wait for cancel to propagate
  await page.waitForTimeout(3000);

  // Verify streaming stopped
  await expect(stopBtn).toBeHidden({ timeout: 10000 });

  // Verify no running tasks remain
  const tasksResp = await page.request.get(`/api/agents/tasks?sessionId=${session.id}`);
  if (tasksResp.ok()) {
    const tasks = await tasksResp.json();
    const runningTasks = tasks.filter((t: any) => t.status === "running" || t.status === "pending");
    expect(runningTasks.length).toBe(0);
  }

  await deleteSession(page, session.id);
});

// ---------------------------------------------------------------------------
// T3: Independent sessions can send in parallel
// ---------------------------------------------------------------------------
test("T3: independent sessions can send in parallel", async ({ page }) => {
  const sessionA = await createSession(page, "ISO-TEST-T3-SessionA");
  const sessionB = await createSession(page, "ISO-TEST-T3-SessionB");

  // Start a task in Session A
  await navigateToSession(page, sessionA.id);
  await sendMessage(page, "知识库中有多少个文档？");
  await waitForStreamingStart(page);

  // Switch to Session B while A is still streaming
  await navigateToSession(page, sessionB.id);

  // Session B should be able to send a message
  const textarea = page.locator("textarea").first();
  await expect(textarea).toBeEnabled({ timeout: 5000 });

  await sendMessage(page, "列出知识库中的文档类型");
  await waitForStreamingStart(page, 15000);

  // Both sessions should have streaming active
  // Verify Session B's textarea was not blocked
  const stopBtn = page.locator('button[title="停止生成"]');
  await expect(stopBtn).toBeVisible();

  // Wait for both to complete
  await waitForStreamingEnd(page, 120000);

  // Verify Session B has its own response
  const bResponses = await getAIResponseCount(page);
  expect(bResponses).toBeGreaterThanOrEqual(1);

  await deleteSession(page, sessionA.id);
  await deleteSession(page, sessionB.id);
});

// ---------------------------------------------------------------------------
// T4: Session switch preserves old session data
// ---------------------------------------------------------------------------
test("T4: session switch preserves data", async ({ page }) => {
  const sessionA = await createSession(page, "ISO-TEST-T4-A");
  const sessionB = await createSession(page, "ISO-TEST-T4-B");

  // Session A: send a message and wait for completion
  await navigateToSession(page, sessionA.id);
  await sendMessage(page, "知识库的名称是什么？");
  await waitForStreamingEnd(page, 60000);

  // Verify Session A has a response
  let aResponses = await getAIResponseCount(page);
  expect(aResponses).toBeGreaterThanOrEqual(1);

  // Switch to Session B
  await navigateToSession(page, sessionB.id);
  await sendMessage(page, "知识库有多少个文档？");
  await waitForStreamingEnd(page, 60000);

  // Switch back to Session A
  await navigateToSession(page, sessionA.id);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);

  // Session A should still have its messages
  aResponses = await getAIResponseCount(page);
  expect(aResponses).toBeGreaterThanOrEqual(1);

  await deleteSession(page, sessionA.id);
  await deleteSession(page, sessionB.id);
});

// ---------------------------------------------------------------------------
// T5: Session switch during streaming — no cross-content pollution
// ---------------------------------------------------------------------------
test("T5: no cross-session content pollution", async ({ page }) => {
  const sessionA = await createSession(page, "ISO-TEST-T5-CrossA");
  const sessionB = await createSession(page, "ISO-TEST-T5-CrossB");

  // Start a long task in Session A
  await navigateToSession(page, sessionA.id);
  await sendMessage(page, "请详细分析知识库中所有PDF文档的内容和结构");
  await waitForStreamingStart(page);

  // Switch to Session B while A streams
  await navigateToSession(page, sessionB.id);

  // Send a completely different query in B
  await sendMessage(page, "知识库中有哪些音频文件？");
  await waitForStreamingStart(page, 15000);

  // Wait for B to finish
  await waitForStreamingEnd(page, 90000);

  // Session B should NOT contain content from Session A's query
  const bContent = await page.locator("div.markdown-content").last().textContent();
  expect(bContent).toBeTruthy();

  // The content should be about audio files, not PDF analysis
  // (We can't strictly assert the content, but we verify it's non-empty
  // and doesn't contain the exact query from Session A)
  if (bContent) {
    expect(bContent).not.toContain("请详细分析知识库中所有PDF文档的内容和结构");
  }

  await deleteSession(page, sessionA.id);
  await deleteSession(page, sessionB.id);
});

// ---------------------------------------------------------------------------
// T6: Workflow events are session-isolated
// ---------------------------------------------------------------------------
test("T6: workflow events don't leak across sessions", async ({ page }) => {
  const sessionA = await createSession(page, "ISO-TEST-T6-WfA");
  const sessionB = await createSession(page, "ISO-TEST-T6-WfB");

  // Start a workflow in Session A
  await navigateToSession(page, sessionA.id);
  await sendMessage(page, "请使用3个Agent并行分析知识库中前3个文档");
  await waitForStreamingStart(page, 30000);

  // Switch to Session B while A's workflow runs
  await navigateToSession(page, sessionB.id);

  // Send a simple (non-workflow) query in B
  await sendMessage(page, "知识库有多少个文档？");
  await waitForStreamingStart(page, 15000);
  await waitForStreamingEnd(page, 60000);

  // Check that B's response doesn't contain workflow events from A
  // The workflow store should not have workflows from session A
  const wfStoreData = await page.evaluate(() => {
    const store = (window as any).__WORKFLOW_STORE__;
    if (!store) return { workflows: [] };
    const state = store.getState();
    return { workflows: Array.from(state.activeWorkflows.entries()) };
  });

  // Session B should not have any active workflows (it was a simple query)
  for (const [wfId, wf] of wfStoreData.workflows) {
    expect((wf as any).sessionId).toBe(sessionB.id);
  }

  await deleteSession(page, sessionA.id);
  await deleteSession(page, sessionB.id);
});

// ---------------------------------------------------------------------------
// T7: Multiple session rapid switching stress test
// ---------------------------------------------------------------------------
test("T7: rapid session switching stress test", async ({ page }) => {
  const sessions = await Promise.all([
    createSession(page, "ISO-TEST-T7-S1"),
    createSession(page, "ISO-TEST-T7-S2"),
    createSession(page, "ISO-TEST-T7-S3"),
  ]);

  // Send a message in each session
  for (let i = 0; i < sessions.length; i++) {
    await navigateToSession(page, sessions[i].id);
    await sendMessage(page, `这是第${i + 1}个会话的消息`);
    await waitForStreamingEnd(page, 60000);
  }

  // Rapid switching between sessions
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < sessions.length; i++) {
      await navigateToSession(page, sessions[i].id);
      await page.waitForTimeout(500);
    }
  }

  // Verify each session still has its messages
  for (let i = 0; i < sessions.length; i++) {
    await navigateToSession(page, sessions[i].id);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Should have at least 1 AI response
    const responseCount = await getAIResponseCount(page);
    expect(responseCount).toBeGreaterThanOrEqual(1);
  }

  // Cleanup
  for (const s of sessions) {
    await deleteSession(page, s.id);
  }
});

// ---------------------------------------------------------------------------
// T8: Stop and resend in same session
// ---------------------------------------------------------------------------
test("T8: stop and resend works correctly", async ({ page }) => {
  const session = await createSession(page, "ISO-TEST-T8-Resend");
  await navigateToSession(page, session.id);

  // Send a long-running query
  await sendMessage(page, "请详细分析知识库中所有文档，包括每个文档的完整摘要");
  await waitForStreamingStart(page);

  // Stop it
  const stopBtn = page.locator('button[title="停止生成"]');
  await stopBtn.click();
  await expect(stopBtn).toBeHidden({ timeout: 10000 });

  // Wait for UI to settle
  await page.waitForTimeout(1000);

  // Send a new message — should work fine
  const textarea = page.locator("textarea").first();
  await expect(textarea).toBeEnabled({ timeout: 5000 });

  await sendMessage(page, "知识库有多少个文档？");
  await waitForStreamingStart(page, 15000);
  await waitForStreamingEnd(page, 60000);

  // Verify the second response exists
  const responses = await getAIResponseCount(page);
  expect(responses).toBeGreaterThanOrEqual(1);

  await deleteSession(page, session.id);
});

// ---------------------------------------------------------------------------
// T9: Deleting one session doesn't affect others
// ---------------------------------------------------------------------------
test("T9: deleting session doesn't affect running session", async ({ page }) => {
  const sessionA = await createSession(page, "ISO-TEST-T9-Running");
  const sessionB = await createSession(page, "ISO-TEST-T9-ToDelete");

  // Start a task in Session A
  await navigateToSession(page, sessionA.id);
  await sendMessage(page, "知识库的名称是什么？");
  await waitForStreamingEnd(page, 60000);

  // Make B have some messages too
  await navigateToSession(page, sessionB.id);
  await sendMessage(page, "知识库有多少个文档？");
  await waitForStreamingEnd(page, 60000);

  // Delete Session B via API while A is idle
  await deleteSession(page, sessionB.id);

  // Go back to Session A
  await navigateToSession(page, sessionA.id);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);

  // Session A should still work — send another message
  const textarea = page.locator("textarea").first();
  await expect(textarea).toBeEnabled({ timeout: 5000 });
  await sendMessage(page, "列出文件类型统计");
  await waitForStreamingEnd(page, 60000);

  // Session A should have 2 AI responses now
  const responses = await getAIResponseCount(page);
  expect(responses).toBeGreaterThanOrEqual(2);

  await deleteSession(page, sessionA.id);
});

// ---------------------------------------------------------------------------
// T10: Page refresh preserves completed session data
// ---------------------------------------------------------------------------
test("T10: page refresh preserves session data", async ({ page }) => {
  const session = await createSession(page, "ISO-TEST-T10-Refresh");

  // Send a message and wait for completion
  await navigateToSession(page, session.id);
  await sendMessage(page, "知识库的名称是什么？");
  await waitForStreamingEnd(page, 60000);

  // Record the AI response
  const responseBefore = await page.locator("div.markdown-content").first().textContent();

  // Reload the page
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3000);

  // The session should still be selected and have its messages
  // Navigate back to the session if needed
  await navigateToSession(page, session.id);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);

  // The AI response should still be there
  const responseAfter = await page.locator("div.markdown-content").first().textContent();
  expect(responseAfter).toBeTruthy();
  // Content should be similar (may differ in whitespace/formatting from server reload)
  if (responseBefore && responseAfter) {
    expect(responseAfter.length).toBeGreaterThan(0);
  }

  await deleteSession(page, session.id);
});
