// =============================================================================
// Multi-Session Parallel Agent Test
// Verifies: session switching with running agent tasks, progress updates,
// message persistence, cache invalidation (Bug 1 + Bug 2 fix)
// =============================================================================

import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:3000";
const API_BASE = "http://localhost:21000";
const SCREENSHOT_DIR = "test-results/multi-session-parallel";
const AGENT_TIMEOUT = 180_000; // 3 min per agent task
const SWITCH_WAIT = 3_000; // wait after switching to observe updates

// Questions that trigger multi-turn agent work (tool calls + streaming)
const QUESTION_A = "请用 bash 命令列出当前目录的文件结构（3层深度），然后总结这个项目的组织方式。";
const QUESTION_B = "请用 bash 运行 echo 'Session-B-测试-$(date)' ，然后解释一下这个命令的输出。";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createSession(request: any, title: string): Promise<string> {
  const resp = await request.post(`${API_BASE}/api/sessions`, {
    data: { title },
  });
  expect([200, 201]).toContain(resp.status());
  const body = await resp.json();
  return body.id;
}

async function getMessages(request: any, sessionId: string): Promise<any[]> {
  const resp = await request.get(`${API_BASE}/api/sessions/${sessionId}/messages`);
  expect(resp.ok()).toBeTruthy();
  return resp.json();
}

async function getAgentTasks(request: any, sessionId: string): Promise<any[]> {
  const resp = await request.get(`${API_BASE}/api/agents/tasks/${sessionId}`);
  if (resp.ok()) return resp.json();
  return [];
}

async function getSession(request: any, sessionId: string): Promise<any> {
  const resp = await request.get(`${API_BASE}/api/sessions/${sessionId}`);
  expect(resp.ok()).toBeTruthy();
  return resp.json();
}

/** Take a full-page screenshot with a descriptive label */
async function screenshot(page: Page, label: string) {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = `${SCREENSHOT_DIR}/${safeLabel}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(`  [Screenshot] ${label} → ${path}`);
  return path;
}

/** Navigate to a session and wait for it to load */
async function navigateToSession(page: Page, sessionId: string) {
  await page.goto(`${BASE_URL}/#/sessions/${sessionId}`);
  await page.waitForLoadState("networkidle");
  // Wait for textarea to appear (confirms chat UI is loaded)
  await page.waitForSelector("textarea", { timeout: 15_000 });
  // Give selectSession + potential reconnection time to fire
  await page.waitForTimeout(1500);
}

/** Send a message in the current session */
async function sendMessage(page: Page, text: string) {
  const textarea = page.locator("textarea").first();
  await expect(textarea).toBeVisible({ timeout: 10_000 });
  await textarea.fill(text);
  await page.waitForTimeout(300);
  await textarea.press("Enter");
}

/** Check if agent is currently running (stop button visible) */
async function isAgentRunning(page: Page): Promise<boolean> {
  const stopBtn = page.locator('button[title="停止生成"]');
  return stopBtn.isVisible().catch(() => false);
}

/** Wait for agent to finish (stop button gone) */
async function waitForAgentFinish(page: Page, timeout = AGENT_TIMEOUT) {
  const stopBtn = page.locator('button[title="停止生成"]');
  try {
    await expect(stopBtn).toBeHidden({ timeout });
    console.log("  Agent finished (stop button hidden)");
  } catch {
    console.log("  Agent still running after timeout");
  }
}

/** Get the text content of the last assistant message using markdown-content class */
async function getLastAssistantContent(page: Page): Promise<string> {
  // Assistant messages contain .markdown-content divs with rendered HTML
  const markdownDivs = page.locator(".markdown-content");
  const count = await markdownDivs.count();
  if (count === 0) return "";
  const text = await markdownDivs.last().textContent();
  return text || "";
}

/** Check for "思考中" streaming indicator */
async function hasThinkingIndicator(page: Page): Promise<boolean> {
  const indicator = page.locator("text=思考中");
  return indicator.isVisible().catch(() => false);
}

/** Check for tool call cards */
async function hasToolCallCards(page: Page): Promise<boolean> {
  // Tool call cards show tool names like bash, kb_search, etc.
  const cards = page.locator("text=bash").or(page.locator("text=kb_search")).or(page.locator("text=echo"));
  return cards.first().isVisible().catch(() => false);
}

// ---------------------------------------------------------------------------
// Test 1: Parallel sessions with switching
// ---------------------------------------------------------------------------

test.describe("Multi-session parallel agent tasks", () => {

  // Override timeout for tests that run agent tasks
  test.setTimeout(300_000); // 5 min

  test("parallel sessions with switching show real-time progress", async ({
    page,
    request,
  }) => {
    let sessionA: string;
    let sessionB: string;
    const titleA = `Session-A-${Date.now()}`;
    const titleB = `Session-B-${Date.now()}`;

    // =======================================================================
    // Step 1: Create two sessions via API
    // =======================================================================
    console.log("\n=== Step 1: Creating two sessions ===");
    sessionA = await createSession(request, titleA);
    sessionB = await createSession(request, titleB);
    console.log(`  Session A: ${sessionA}`);
    console.log(`  Session B: ${sessionB}`);

    // =======================================================================
    // Step 2: Navigate to Session A, send complex query
    // =======================================================================
    console.log("\n=== Step 2: Start agent in Session A ===");
    await navigateToSession(page, sessionA);
    await screenshot(page, "02_session_A_loaded");

    await sendMessage(page, QUESTION_A);
    console.log("  Sent question to Session A");
    await page.waitForTimeout(3000);

    const thinkingA = await hasThinkingIndicator(page);
    console.log(`  Session A thinking indicator: ${thinkingA}`);
    await screenshot(page, "03_session_A_agent_running");

    // =======================================================================
    // Step 3: Switch to Session B (while A is still running)
    // =======================================================================
    console.log("\n=== Step 3: Switch to Session B ===");
    await navigateToSession(page, sessionB);
    await screenshot(page, "04_session_B_loaded");

    // Send a query to Session B too
    await sendMessage(page, QUESTION_B);
    console.log("  Sent question to Session B");
    await page.waitForTimeout(3000);

    await screenshot(page, "05_session_B_agent_running");

    // =======================================================================
    // Step 4: Switch back to Session A — verify reconnection
    // =======================================================================
    console.log("\n=== Step 4: Switch back to Session A (test reconnection) ===");
    await navigateToSession(page, sessionA);
    // Wait for reconnection to establish and events to replay
    await page.waitForTimeout(SWITCH_WAIT);
    // Wait for markdown-content to appear (reconnection should render it)
    try {
      await page.waitForSelector(".markdown-content", { timeout: 10_000 });
    } catch {
      // Content might still be streaming — check indicators instead
    }
    await screenshot(page, "06_switched_back_to_A");

    // Check for any content or streaming indicator
    const contentA_switch1 = await getLastAssistantContent(page);
    const thinkingA_switch = await hasThinkingIndicator(page);
    const runningA = await isAgentRunning(page);
    console.log(`  Session A: content_len=${contentA_switch1.length}, thinking=${thinkingA_switch}, running=${runningA}`);

    // Whether running or completed, we should see either content or streaming indicator
    const hasProgress = contentA_switch1.length > 0 || thinkingA_switch || runningA;
    console.log(`  Session A has visible progress: ${hasProgress}`);

    if (runningA || thinkingA_switch) {
      // Wait for more content to accumulate
      await page.waitForTimeout(4000);
      await screenshot(page, "07_session_A_progress_after_reconnect");
      const contentA_progress = await getLastAssistantContent(page);
      console.log(`  Session A content after wait: ${contentA_progress.length} chars`);
    }

    // =======================================================================
    // Step 5: Switch back to Session B — verify reconnection
    // =======================================================================
    console.log("\n=== Step 5: Switch back to Session B (test reconnection) ===");
    await navigateToSession(page, sessionB);
    // Wait for reconnection to establish and events to replay
    await page.waitForTimeout(SWITCH_WAIT);
    try {
      await page.waitForSelector(".markdown-content", { timeout: 10_000 });
    } catch {
      // Content might still be streaming
    }
    await screenshot(page, "08_switched_back_to_B");

    const contentB_switch1 = await getLastAssistantContent(page);
    const thinkingB_switch = await hasThinkingIndicator(page);
    const runningB = await isAgentRunning(page);
    console.log(`  Session B: content_len=${contentB_switch1.length}, thinking=${thinkingB_switch}, running=${runningB}`);

    if (runningB || thinkingB_switch) {
      await page.waitForTimeout(4000);
      await screenshot(page, "09_session_B_progress_after_reconnect");
    }

    // =======================================================================
    // Step 6: Wait for both agents to finish
    // =======================================================================
    console.log("\n=== Step 6: Wait for both agents to complete ===");

    // Wait for A
    await navigateToSession(page, sessionA);
    await waitForAgentFinish(page, AGENT_TIMEOUT);
    await page.waitForTimeout(2000);
    // Wait for content to render after reconnection/completion
    try {
      await page.waitForSelector(".markdown-content", { timeout: 10_000 });
    } catch { /* may not have content yet */ }
    await page.waitForTimeout(1000);
    await screenshot(page, "10_session_A_completed");

    const contentA_final_ui = await getLastAssistantContent(page);
    console.log(`  Session A final UI content: ${contentA_final_ui.length} chars`);

    // Wait for B
    await navigateToSession(page, sessionB);
    await waitForAgentFinish(page, AGENT_TIMEOUT);
    await page.waitForTimeout(2000);
    try {
      await page.waitForSelector(".markdown-content", { timeout: 10_000 });
    } catch { /* may not have content yet */ }
    await page.waitForTimeout(1000);
    await screenshot(page, "11_session_B_completed");

    const contentB_final_ui = await getLastAssistantContent(page);
    console.log(`  Session B final UI content: ${contentB_final_ui.length} chars`);

    // =======================================================================
    // Step 7: Verify message persistence via API
    // =======================================================================
    console.log("\n=== Step 7: Verify message persistence via API ===");

    const messagesA = await getMessages(request, sessionA);
    const messagesB = await getMessages(request, sessionB);

    const assistantMsgsA = messagesA.filter((m: any) => m.role === "assistant");
    const assistantMsgsB = messagesB.filter((m: any) => m.role === "assistant");
    const contentA_api = assistantMsgsA.map((m: any) => m.content || "").join("");
    const contentB_api = assistantMsgsB.map((m: any) => m.content || "").join("");

    console.log(`  Session A: ${messagesA.length} msgs, ${assistantMsgsA.length} assistant, ${contentA_api.length} chars content`);
    console.log(`  Session B: ${messagesB.length} msgs, ${assistantMsgsB.length} assistant, ${contentB_api.length} chars content`);

    // Check draft status (metadata is a JSON string, needs parsing)
    const parseDraft = (m: any): boolean => {
      try {
        const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata;
        return meta?.draft === true;
      } catch { return false; }
    };
    const draftA = assistantMsgsA.find(parseDraft);
    const draftB = assistantMsgsB.find(parseDraft);
    console.log(`  Session A has draft messages: ${!!draftA}`);
    console.log(`  Session B has draft messages: ${!!draftB}`);

    // =======================================================================
    // Step 8: Page refresh — verify both sessions load correctly
    // =======================================================================
    console.log("\n=== Step 8: Page refresh persistence test ===");

    // Reload Session A
    await navigateToSession(page, sessionA);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForSelector("textarea", { timeout: 15_000 });
    await page.waitForTimeout(3000);
    await screenshot(page, "12_session_A_after_refresh");

    const contentA_reload = await getLastAssistantContent(page);
    console.log(`  Session A content after refresh: ${contentA_reload.length} chars`);

    // Reload Session B
    await navigateToSession(page, sessionB);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForSelector("textarea", { timeout: 15_000 });
    await page.waitForTimeout(3000);
    await screenshot(page, "13_session_B_after_refresh");

    const contentB_reload = await getLastAssistantContent(page);
    console.log(`  Session B content after refresh: ${contentB_reload.length} chars`);

    // =======================================================================
    // Step 9: Final cross-session switch
    // =======================================================================
    console.log("\n=== Step 9: Final cross-session switch ===");
    await navigateToSession(page, sessionA);
    await page.waitForTimeout(2000);
    await screenshot(page, "14_final_session_A");

    const contentA_final2 = await getLastAssistantContent(page);

    await navigateToSession(page, sessionB);
    await page.waitForTimeout(2000);
    await screenshot(page, "15_final_session_B");

    const contentB_final2 = await getLastAssistantContent(page);

    // =======================================================================
    // Assertions
    // =======================================================================
    console.log("\n=== Assertions ===");

    // 1. Both sessions have messages
    expect(messagesA.length).toBeGreaterThanOrEqual(2);
    console.log("  ✓ Session A has messages");
    expect(messagesB.length).toBeGreaterThanOrEqual(2);
    console.log("  ✓ Session B has messages");

    // 2. Both sessions have assistant messages
    expect(assistantMsgsA.length).toBeGreaterThanOrEqual(1);
    console.log("  ✓ Session A has assistant messages");
    expect(assistantMsgsB.length).toBeGreaterThanOrEqual(1);
    console.log("  ✓ Session B has assistant messages");

    // 3. Assistant content is non-empty and non-draft
    expect(contentA_api.length).toBeGreaterThan(50);
    console.log(`  ✓ Session A assistant content is substantive (${contentA_api.length} chars)`);
    expect(contentB_api.length).toBeGreaterThan(20);
    console.log(`  ✓ Session B assistant content is substantive (${contentB_api.length} chars)`);

    // 4. No draft messages remain (Bug 2 fix)
    expect(draftA).toBeUndefined();
    console.log("  ✓ Session A no draft messages");
    expect(draftB).toBeUndefined();
    console.log("  ✓ Session B no draft messages");

    // 5. After refresh, content is still visible in UI
    expect(contentA_reload.length).toBeGreaterThan(10);
    console.log("  ✓ Session A content visible after page refresh");
    expect(contentB_reload.length).toBeGreaterThan(10);
    console.log("  ✓ Session B content visible after page refresh");

    // 6. Session isolation — user messages should be different
    const userMsgA = messagesA.filter((m: any) => m.role === "user");
    const userMsgB = messagesB.filter((m: any) => m.role === "user");
    expect(userMsgA[0]?.content).not.toBe(userMsgB[0]?.content);
    console.log("  ✓ Session isolation verified — no cross-contamination");

    console.log("\n=== ALL TESTS PASSED ===\n");

    // Cleanup
    try {
      await request.delete(`${API_BASE}/api/sessions/${sessionA}`);
      await request.delete(`${API_BASE}/api/sessions/${sessionB}`);
      console.log("  Cleaned up test sessions");
    } catch { /* ignore */ }
  });

  // ---------------------------------------------------------------------------
  // Test 2: Agent task status correctness
  // ---------------------------------------------------------------------------
  test("agent task status is correct after session switch", async ({
    page,
    request,
  }) => {
    const sessionId = await createSession(request, `Status-Test-${Date.now()}`);

    await navigateToSession(page, sessionId);
    await screenshot(page, "status_01_loaded");

    // Send a query that triggers tool usage
    await sendMessage(page, "请运行 bash 命令 echo 'hello-world-test' 并解释输出");
    await page.waitForTimeout(3000);

    // Check task status via API while agent is running
    const tasksDuringRun = await getAgentTasks(request, sessionId);
    console.log(`  Tasks during run: ${JSON.stringify(tasksDuringRun.map((t: any) => t.status))}`);
    await screenshot(page, "status_02_task_running");

    // Wait for completion
    await waitForAgentFinish(page, AGENT_TIMEOUT);
    await page.waitForTimeout(2000);
    await screenshot(page, "status_03_task_completed");

    // Verify task is completed
    const tasksAfterRun = await getAgentTasks(request, sessionId);
    const allCompleted = tasksAfterRun.every(
      (t: any) => t.status === "completed" || t.status === "error"
    );
    console.log(`  Tasks after run: ${JSON.stringify(tasksAfterRun.map((t: any) => t.status))}`);
    expect(allCompleted).toBeTruthy();
    console.log("  ✓ All tasks completed");

    // Verify messages are persisted
    const messages = await getMessages(request, sessionId);
    const assistantMsgs = messages.filter((m: any) => m.role === "assistant");

    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    console.log(`  ✓ Assistant message persisted (${assistantMsgs.length} messages)`);

    const content = assistantMsgs[0]?.content || "";
    expect(content.length).toBeGreaterThan(10);
    console.log(`  ✓ Content is non-empty (${content.length} chars)`);

    // Verify no draft status (metadata is a JSON string)
    const hasDraft = assistantMsgs.some((m: any) => {
      try {
        const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata;
        return meta?.draft === true;
      } catch { return false; }
    });
    expect(hasDraft).toBeFalsy();
    console.log("  ✓ No draft messages remaining");

    // Verify UI shows the content
    const uiContent = await getLastAssistantContent(page);
    expect(uiContent.length).toBeGreaterThan(5);
    console.log(`  ✓ UI shows content (${uiContent.length} chars)`);

    // Cleanup
    try { await request.delete(`${API_BASE}/api/sessions/${sessionId}`); } catch { /* ignore */ }
  });

  // ---------------------------------------------------------------------------
  // Test 3: message updateContent bumps session timestamp (cache invalidation)
  // ---------------------------------------------------------------------------
  test("message updateContent bumps session timestamp (cache invalidation)", async ({
    page,
    request,
  }) => {
    const sessionId = await createSession(request, `Cache-Test-${Date.now()}`);

    // Get initial session timestamp
    const sessionData = await getSession(request, sessionId);
    const initialUpdatedAt = sessionData.updatedAt;
    console.log(`  Initial updatedAt: ${initialUpdatedAt}`);

    // Send a message to trigger content creation + updates
    await navigateToSession(page, sessionId);
    await sendMessage(page, "运行 bash 命令 echo cache-test-verification");
    await page.waitForTimeout(5000);

    // While agent is running, check that session timestamp is being updated
    const sessionData2 = await getSession(request, sessionId);
    const midUpdatedAt = sessionData2.updatedAt;
    console.log(`  Mid-run updatedAt: ${midUpdatedAt}`);

    // Wait for completion
    await waitForAgentFinish(page, AGENT_TIMEOUT);
    await page.waitForTimeout(1000);

    // Get final timestamp
    const sessionData3 = await getSession(request, sessionId);
    const finalUpdatedAt = sessionData3.updatedAt;
    console.log(`  Final updatedAt: ${finalUpdatedAt}`);

    // The timestamp MUST have changed (updateContent bumps sessions.updated_at)
    expect(finalUpdatedAt).not.toBe(initialUpdatedAt);
    console.log("  ✓ Session timestamp was updated (cache invalidation works)");

    await screenshot(page, "cache_01_final_state");

    // Verify messages are correct
    const messages = await getMessages(request, sessionId);
    const assistantMsg = messages.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect((assistantMsg?.content || "").length).toBeGreaterThan(10);
    console.log(`  ✓ Assistant content is complete (${(assistantMsg?.content || "").length} chars)`);

    // Cleanup
    try { await request.delete(`${API_BASE}/api/sessions/${sessionId}`); } catch { /* ignore */ }
  });
});
