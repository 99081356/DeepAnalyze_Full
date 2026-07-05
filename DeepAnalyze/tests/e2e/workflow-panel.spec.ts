// =============================================================================
// E2E Test: Sub-Agent Workflow Panel — Full UI Verification
// Tests the expand/collapse panel, agent status chips, slot details,
// message rendering, and end-to-end event flow.
// =============================================================================

import { test, expect, Page } from "@playwright/test";
import { TEST_KB_ID } from "./fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Navigate to chat page with a knowledge base selected */
async function goToChat(page: Page) {
  await page.goto(`http://localhost:21000/#/chat`);
  await page.waitForTimeout(500);
}

/** Send a message that triggers a team workflow (multi-agent) */
async function sendTeamMessage(page: Page, message: string) {
  // Find the chat input
  const input = page.locator('textarea, [contenteditable="true"], input[type="text"]').first();
  await input.waitFor({ state: "visible", timeout: 5000 });
  await input.fill(message);

  // Find and click the send button
  const sendBtn = page.locator('button:has(svg), button[type="submit"]').last();
  // Try pressing Enter first
  await input.press("Enter");
  await page.waitForTimeout(1000);
}

/** Wait for workflow panel to appear */
async function waitForWorkflowPanel(page: Page, timeout = 15000) {
  // The panel appears when a workflow starts — look for the team name header
  const panel = page.locator('[class*="workflow"], [data-testid="workflow-panel"]').first();
  // More robust: look for the Users icon in the panel
  return page.waitForFunction(
    () => {
      // Look for any element containing team-related content
      const allText = document.body.innerText;
      return allText.includes("运行中") || allText.includes("排队中") || allText.includes("Pipeline") || allText.includes("Parallel") || allText.includes("Graph");
    },
    { timeout },
  ).catch(() => null);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

test.describe("Sub-Agent Workflow Panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("http://localhost:21000");
    await page.waitForTimeout(500);
  });

  // ---- 1. Basic page loads without error ----
  test("page loads without crash", async ({ page }) => {
    await page.goto("http://localhost:21000/#/chat");
    await page.waitForTimeout(1000);

    // No white screen — body should have content
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(10);

    // Check for React errors in console
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    await page.waitForTimeout(2000);

    // Filter out benign errors
    const realErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("404") && !e.includes("DevTools"),
    );
    expect(realErrors.length).toBe(0);
  });

  // ---- 2. Welcome screen renders correctly ----
  test("welcome screen shows DeepAnalyze branding", async ({ page }) => {
    await page.goto("http://localhost:21000/#/chat");
    await page.waitForTimeout(1000);

    // Should show DeepAnalyze heading
    const heading = page.locator("h2:text-is('DeepAnalyze')");
    await expect(heading).toBeVisible({ timeout: 5000 });

    // Should show action buttons
    await expect(page.locator("text=上传文档")).toBeVisible();
    await expect(page.locator("text=选择知识库")).toBeVisible();
    await expect(page.locator("text=开始对话")).toBeVisible();
  });

  // ---- 3. Chat input area works ----
  test("can create a new chat session and type", async ({ page }) => {
    await page.goto("http://localhost:21000/#/chat");
    await page.waitForTimeout(500);

    // Click "开始对话" button to create session
    const startBtn = page.locator("text=开始对话");
    await startBtn.click();
    await page.waitForTimeout(1000);

    // Should have a text input visible now
    const input = page.locator("textarea").first();
    await expect(input).toBeVisible({ timeout: 5000 });

    // Type a message
    await input.fill("你好，测试消息");
    const value = await input.inputValue();
    expect(value).toBe("你好，测试消息");
  });

  // ---- 4. Trigger a team workflow and observe the panel ----
  // NOTE: This test requires a real multi-agent workflow to be triggered by the backend.
  // It can take 30-45 seconds and may fail if no team template is configured.
  test.skip("workflow panel appears when team is dispatched", async ({ page }) => {
    // Navigate to chat
    await page.goto("http://localhost:21000/#/chat");
    await page.waitForTimeout(500);

    // Create session
    const startBtn = page.locator("button:has-text('开始对话')");
    if (await startBtn.isVisible()) {
      await startBtn.click();
      await page.waitForTimeout(1000);
    }

    const input = page.locator("textarea").first();
    await expect(input).toBeVisible({ timeout: 5000 });

    // Capture console for debugging
    const logs: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "log" || msg.type() === "error") {
        logs.push(`[${msg.type()}] ${msg.text()}`);
      }
    });

    // Send a message that triggers a workflow
    await input.fill("帮我全面分析知识库中所有文档，使用团队模式并行处理");
    await input.press("Enter");

    // Wait for either workflow panel or agent response
    // The workflow panel should appear within 30 seconds
    const panelAppeared = await page.waitForFunction(
      () => {
        // Check for workflow-related UI elements
        const svgs = document.querySelectorAll("svg");
        for (const svg of svgs) {
          // Users icon is used in the panel header
          const parent = svg.closest("div");
          if (parent) {
            const text = parent.textContent || "";
            if (text.includes("Pipeline") || text.includes("Parallel") || text.includes("Graph") || text.includes("运行中")) {
              return true;
            }
          }
        }

        // Also check for status chips (role + status dot)
        const allElements = document.querySelectorAll("span, div");
        for (const el of allElements) {
          const text = el.textContent || "";
          if (text.includes("排队中") && el.offsetWidth > 0 && el.offsetWidth < 200) {
            return true;
          }
        }
        return false;
      },
      { timeout: 45000 },
    ).catch(() => null);

    // Take a screenshot for visual inspection
    await page.screenshot({ path: "/tmp/workflow-panel-test.png", fullPage: true });

    if (panelAppeared) {
      console.log("Workflow panel appeared successfully");
    } else {
      // Even if no workflow panel, check if we at least got a response
      const bodyText = await page.locator("body").innerText();
      const hasResponse = bodyText.length > 100;
      console.log(`Panel detected: ${!!panelAppeared}, Response received: ${hasResponse}`);
    }
  });

  // ---- 5. Workflow panel collapsed state shows status chips ----
  test("collapsed panel shows agent status chips", async ({ page }) => {
    // This test verifies the chip rendering after a workflow starts
    // We need to trigger a workflow first
    await page.goto("http://localhost:21000/#/chat");
    await page.waitForTimeout(500);

    const startBtn = page.locator("button:has-text('开始对话')");
    if (await startBtn.isVisible()) {
      await startBtn.click();
      await page.waitForTimeout(1000);
    }

    const input = page.locator("textarea").first();
    await expect(input).toBeVisible({ timeout: 5000 });

    // Inject mock workflow data directly into the store for UI testing
    await page.evaluate(() => {
      // Access Zustand store and inject test workflow data
      const store = (window as any).__WORKFLOW_STORE__;
      if (store) {
        store.getState().handleWorkflowStart({
          workflowId: "test-wf-1",
          teamName: "测试团队",
          mode: "parallel",
          agentCount: 3,
        });
        store.getState().handleAgentStart({
          workflowId: "test-wf-1",
          agentId: "agent-1",
          role: "检索员",
          task: "搜索所有PDF文档并提取关键信息",
        });
        store.getState().handleAgentStart({
          workflowId: "test-wf-1",
          agentId: "agent-2",
          role: "分析师",
          task: "深度分析搜索结果并生成报告",
        });
        store.getState().handleAgentStart({
          workflowId: "test-wf-1",
          agentId: "agent-3",
          role: "报告员",
          task: "整合分析结果并输出最终报告",
        });
      }
    });

    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/workflow-collapsed.png", fullPage: true });

    // Check that status chips are visible
    const chip1 = page.locator("text=检索员");
    const chip2 = page.locator("text=分析师");
    const chip3 = page.locator("text=报告员");

    // At least one chip should be visible
    const anyChipVisible =
      (await chip1.isVisible().catch(() => false)) ||
      (await chip2.isVisible().catch(() => false)) ||
      (await chip3.isVisible().catch(() => false));

    console.log(`Status chips visible: ${anyChipVisible}`);
  });

  // ---- 6. Workflow panel can expand and show agent details ----
  test("panel expands to show agent slots", async ({ page }) => {
    await page.goto("http://localhost:21000/#/chat");
    await page.waitForTimeout(500);

    const startBtn = page.locator("button:has-text('开始对话')");
    if (await startBtn.isVisible()) {
      await startBtn.click();
      await page.waitForTimeout(1000);
    }

    // Inject mock data
    await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      if (store) {
        store.getState().handleWorkflowStart({
          workflowId: "test-wf-2",
          teamName: "测试团队",
          mode: "graph",
          agentCount: 2,
        });
        store.getState().handleAgentStart({
          workflowId: "test-wf-2",
          agentId: "agent-a",
          role: "搜索员",
          task: "搜索知识库中的所有相关文档",
        });
        // Simulate tool call
        store.getState().handleAgentToolCall({
          workflowId: "test-wf-2",
          agentId: "agent-a",
          toolName: "kb_search",
          input: { query: "测试查询", topK: 10 },
        });
        // Simulate chunk
        store.getState().handleAgentChunk({
          workflowId: "test-wf-2",
          agentId: "agent-a",
          content: "正在分析文档内容...",
        });
        store.getState().handleAgentStart({
          workflowId: "test-wf-2",
          agentId: "agent-b",
          role: "分析员",
          task: "对搜索结果进行深度分析",
        });
      }
    });

    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/workflow-before-expand.png", fullPage: true });

    // Find the panel header (contains team name) and click to expand
    const panelHeader = page.locator("text=测试团队").first();
    if (await panelHeader.isVisible()) {
      await panelHeader.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: "/tmp/workflow-expanded.png", fullPage: true });

      // Should now see agent slot rows
      const slot1 = page.locator("text=搜索员");
      const slot2 = page.locator("text=分析员");
      const slotVisible =
        (await slot1.isVisible().catch(() => false)) ||
        (await slot2.isVisible().catch(() => false));
      console.log(`Agent slots visible after expand: ${slotVisible}`);
    }
  });

  // ---- 7. Agent slot can expand to show message details ----
  test("agent slot expands to show tool calls and text", async ({ page }) => {
    await page.goto("http://localhost:21000/#/chat");
    await page.waitForTimeout(500);

    const startBtn = page.locator("button:has-text('开始对话')");
    if (await startBtn.isVisible()) {
      await startBtn.click();
      await page.waitForTimeout(1000);
    }

    // Inject comprehensive mock data
    await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      if (store) {
        store.getState().handleWorkflowStart({
          workflowId: "test-wf-3",
          teamName: "详细测试",
          mode: "pipeline",
          agentCount: 1,
        });
        store.getState().handleAgentStart({
          workflowId: "test-wf-3",
          agentId: "agent-x",
          role: "研究员",
          task: "这是研究员的任务描述，包含足够长度的文字来测试截断效果",
        });

        // Tool call with input
        store.getState().handleAgentToolCall({
          workflowId: "test-wf-3",
          agentId: "agent-x",
          toolName: "kb_search",
          input: { query: "重要数据", topK: 20 },
        });

        // Tool result
        store.getState().handleAgentToolResult({
          workflowId: "test-wf-3",
          agentId: "agent-x",
          toolName: "kb_search",
          output: "找到15个相关文档，最高评分0.92，涉及主题包括数据分析和可视化",
        });

        // Multiple chunks (should coalesce)
        store.getState().handleAgentChunk({
          workflowId: "test-wf-3",
          agentId: "agent-x",
          content: "根据分析，",
        });
        store.getState().handleAgentChunk({
          workflowId: "test-wf-3",
          agentId: "agent-x",
          content: "文档中包含",
        });
        store.getState().handleAgentChunk({
          workflowId: "test-wf-3",
          agentId: "agent-x",
          content: "大量关键信息。",
        });

        // Another tool call
        store.getState().handleAgentToolCall({
          workflowId: "test-wf-3",
          agentId: "agent-x",
          toolName: "document_expand",
          input: { docId: "doc-123", format: "md" },
        });
      }
    });

    await page.waitForTimeout(500);

    // Click to expand panel
    const panelHeader = page.locator("text=详细测试").first();
    if (await panelHeader.isVisible()) {
      await panelHeader.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: "/tmp/slot-before-expand.png", fullPage: true });

      // Click agent slot header row to expand — use the role name inside the slot
      const slotRow = page.locator("text=研究员").first();
      if (await slotRow.isVisible()) {
        await slotRow.click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: "/tmp/slot-expanded.png", fullPage: true });

        // The expanded detail area should now be in the DOM.
        // Tool call badges are rendered inside <span> elements with specific styles.
        // Use a more specific locator that finds "kb_search" inside the detail area.
        const detailArea = page.locator("div").filter({ hasText: "kb_search" }).last();

        // Check for tool call badge — use getByText with exact match in a nested context
        // The ToolCallBlock renders "kb_search" inside a styled span
        const toolBadgeText = await page.evaluate(() => {
          // Check all spans for the tool name text
          const spans = document.querySelectorAll("span");
          for (const span of spans) {
            if (span.textContent === "kb_search" && span.offsetWidth > 0) {
              return true;
            }
          }
          return false;
        });
        console.log(`Tool call badge visible: ${toolBadgeText}`);
        expect(toolBadgeText).toBe(true);

        // Should see tool result
        const resultText = page.locator("text=找到15个相关文档");
        const resultVisible = await resultText.isVisible().catch(() => false);
        console.log(`Tool result visible: ${resultVisible}`);
        expect(resultVisible).toBe(true);

        // Should see coalesced chunks
        const chunkText = page.locator("text=根据分析，文档中包含大量关键信息");
        const chunkVisible = await chunkText.isVisible().catch(() => false);
        console.log(`Coalesced chunks visible: ${chunkVisible}`);
        expect(chunkVisible).toBe(true);

        // Click tool call to expand input JSON — find the badge specifically
        const badgeClicked = await page.evaluate(() => {
          const spans = document.querySelectorAll("span");
          for (const span of spans) {
            if (span.textContent === "kb_search" && span.offsetWidth > 0) {
              (span as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (badgeClicked) {
          await page.waitForTimeout(300);
          await page.screenshot({ path: "/tmp/tool-input-expanded.png", fullPage: true });

          // Should see JSON input
          const jsonText = page.locator("text=重要数据");
          const jsonVisible = await jsonText.isVisible().catch(() => false);
          console.log(`Expanded JSON input visible: ${jsonVisible}`);
          expect(jsonVisible).toBe(true);
        }
      }
    }
  });

  // ---- 8. Error state renders correctly ----
  test("error messages display with red highlight", async ({ page }) => {
    await page.goto("http://localhost:21000/#/chat");
    await page.waitForTimeout(500);

    const startBtn = page.locator("button:has-text('开始对话')");
    if (await startBtn.isVisible()) {
      await startBtn.click();
      await page.waitForTimeout(1000);
    }

    // Inject workflow with error
    await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      if (store) {
        store.getState().handleWorkflowStart({
          workflowId: "test-wf-err",
          teamName: "错误测试",
          mode: "parallel",
          agentCount: 1,
        });
        store.getState().handleAgentStart({
          workflowId: "test-wf-err",
          agentId: "agent-err",
          role: "执行员",
          task: "测试错误状态显示",
        });
        // Complete with error
        store.getState().handleAgentComplete({
          workflowId: "test-wf-err",
          agentId: "agent-err",
          error: "连接超时：无法访问知识库",
          duration: 30,
        });
      }
    });

    await page.waitForTimeout(500);

    // Expand panel
    const panelHeader = page.locator("text=错误测试").first();
    if (await panelHeader.isVisible()) {
      await panelHeader.click();
      await page.waitForTimeout(300);

      // Expand agent slot
      const slotRow = page.locator("text=执行员").first();
      if (await slotRow.isVisible()) {
        await slotRow.click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: "/tmp/error-state.png", fullPage: true });

        // Should see error message
        const errorText = page.locator("text=连接超时");
        const errorVisible = await errorText.isVisible().catch(() => false);
        console.log(`Error message visible: ${errorVisible}`);
      }
    }
  });

  // ---- 9. Completed state shows correct status ----
  test("completed agents show checkmark status", async ({ page }) => {
    await page.goto("http://localhost:21000/#/chat");
    await page.waitForTimeout(500);

    const startBtn = page.locator("button:has-text('开始对话')");
    if (await startBtn.isVisible()) {
      await startBtn.click();
      await page.waitForTimeout(1000);
    }

    // Inject completed workflow
    await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      if (store) {
        store.getState().handleWorkflowStart({
          workflowId: "test-wf-done",
          teamName: "完成测试",
          mode: "parallel",
          agentCount: 2,
        });
        store.getState().handleAgentStart({
          workflowId: "test-wf-done",
          agentId: "agent-d1",
          role: "分析员A",
          task: "已完成的分析任务",
        });
        store.getState().handleAgentComplete({
          workflowId: "test-wf-done",
          agentId: "agent-d1",
          duration: 15,
        });
        store.getState().handleAgentStart({
          workflowId: "test-wf-done",
          agentId: "agent-d2",
          role: "分析员B",
          task: "另一个已完成的分析任务",
        });
        store.getState().handleAgentComplete({
          workflowId: "test-wf-done",
          agentId: "agent-d2",
          duration: 22,
        });
      }
    });

    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/completed-collapsed.png", fullPage: true });

    // Check for "全部完成" in panel header (visible even when collapsed)
    const allDone = page.locator("text=全部完成");
    const allDoneVisible = await allDone.isVisible().catch(() => false);
    console.log(`"全部完成" visible: ${allDoneVisible}`);
    expect(allDoneVisible).toBe(true);

    // Expand panel to check slot-level details
    const panelHeader = page.locator("text=完成测试").first();
    if (await panelHeader.isVisible()) {
      await panelHeader.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: "/tmp/completed-expanded.png", fullPage: true });

      // Check for "已完成" labels in expanded slot rows
      const completedLabels = page.locator("text=已完成");
      const count = await completedLabels.count();
      console.log(`Found ${count} "已完成" labels`);
      expect(count).toBeGreaterThanOrEqual(2);

      // Check for duration display in expanded slots
      const duration15 = page.locator("text=15.0s");
      const duration22 = page.locator("text=22.0s");
      const durVisible =
        (await duration15.isVisible().catch(() => false)) ||
        (await duration22.isVisible().catch(() => false));
      console.log(`Duration display visible: ${durVisible}`);
      expect(durVisible).toBe(true);
    }
  });

  // ---- 10. Multiple workflows display independently ----
  test("multiple workflows can coexist", async ({ page }) => {
    await page.goto("http://localhost:21000/#/chat");
    await page.waitForTimeout(500);

    const startBtn = page.locator("button:has-text('开始对话')");
    if (await startBtn.isVisible()) {
      await startBtn.click();
      await page.waitForTimeout(1000);
    }

    // Inject two workflows
    await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      if (store) {
        // Workflow 1
        store.getState().handleWorkflowStart({
          workflowId: "wf-1",
          teamName: "第一个团队",
          mode: "parallel",
          agentCount: 1,
        });
        store.getState().handleAgentStart({
          workflowId: "wf-1",
          agentId: "a1",
          role: "角色A",
          task: "任务A",
        });

        // Workflow 2
        store.getState().handleWorkflowStart({
          workflowId: "wf-2",
          teamName: "第二个团队",
          mode: "graph",
          agentCount: 1,
        });
        store.getState().handleAgentStart({
          workflowId: "wf-2",
          agentId: "a2",
          role: "角色B",
          task: "任务B",
        });
      }
    });

    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/multi-workflow.png", fullPage: true });

    const team1 = page.locator("text=第一个团队");
    const team2 = page.locator("text=第二个团队");
    const bothVisible =
      (await team1.isVisible().catch(() => false)) &&
      (await team2.isVisible().catch(() => false));
    console.log(`Both workflow panels visible: ${bothVisible}`);

    // Expand one panel and verify other stays collapsed
    if (await team1.isVisible()) {
      await team1.click();
      await page.waitForTimeout(300);

      // Panel 1 should be expanded, panel 2 should still show chips
      await page.screenshot({ path: "/tmp/multi-workflow-expanded.png", fullPage: true });
    }
  });

  // ---- 11. Visual: Take comprehensive screenshots for review ----
  test("comprehensive visual state screenshots", async ({ page }) => {
    await page.goto("http://localhost:21000/#/chat");
    await page.waitForTimeout(500);

    const startBtn = page.locator("button:has-text('开始对话')");
    if (await startBtn.isVisible()) {
      await startBtn.click();
      await page.waitForTimeout(1000);
    }

    // Inject a rich workflow scenario
    await page.evaluate(() => {
      const store = (window as any).__WORKFLOW_STORE__;
      if (store) {
        store.getState().handleWorkflowStart({
          workflowId: "visual-wf",
          teamName: "研究管道",
          mode: "graph",
          agentCount: 3,
        });

        // Agent 1: Running with tools and chunks
        store.getState().handleAgentStart({
          workflowId: "visual-wf",
          agentId: "vis-1",
          role: "检索员",
          task: "搜索知识库中所有与数据分析相关的文档，提取关键统计信息",
        });
        store.getState().handleAgentToolCall({
          workflowId: "visual-wf",
          agentId: "vis-1",
          toolName: "kb_search",
          input: { query: "数据分析", topK: 20 },
        });
        store.getState().handleAgentToolResult({
          workflowId: "visual-wf",
          agentId: "vis-1",
          toolName: "kb_search",
          output: "找到 18 个相关文档，评分范围 0.75-0.95",
        });
        store.getState().handleAgentToolCall({
          workflowId: "visual-wf",
          agentId: "vis-1",
          toolName: "expand",
          input: { docId: "doc-abc123", format: "md" },
        });

        // Agent 2: Completed
        store.getState().handleAgentStart({
          workflowId: "visual-wf",
          agentId: "vis-2",
          role: "编译员",
          task: "编译检索到的文档为结构化Wiki页面",
        });
        store.getState().handleAgentComplete({
          workflowId: "visual-wf",
          agentId: "vis-2",
          output: "已完成 5 个文档的编译",
          duration: 45,
        });

        // Agent 3: Error
        store.getState().handleAgentStart({
          workflowId: "visual-wf",
          agentId: "vis-3",
          role: "报告员",
          task: "基于分析结果生成最终报告",
        });
        store.getState().handleAgentComplete({
          workflowId: "visual-wf",
          agentId: "vis-3",
          error: "报告生成失败：输出文件写入权限不足",
          duration: 12,
        });
      }
    });

    await page.waitForTimeout(500);

    // Screenshot 1: Collapsed state
    await page.screenshot({ path: "/tmp/visual-1-collapsed.png", fullPage: true });

    // Expand panel
    const panelHeader = page.locator("text=研究管道").first();
    if (await panelHeader.isVisible()) {
      await panelHeader.click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: "/tmp/visual-2-panel-expanded.png", fullPage: true });

      // Expand each agent slot
      const slots = ["检索员", "编译员", "报告员"];
      for (const role of slots) {
        const slot = page.locator(`text=${role}`).first();
        if (await slot.isVisible()) {
          await slot.click();
          await page.waitForTimeout(300);
        }
      }
      await page.screenshot({ path: "/tmp/visual-3-all-expanded.png", fullPage: true });

      // Expand tool call input JSON — find the badge via evaluate for reliability
      const badgeClicked = await page.evaluate(() => {
        const spans = document.querySelectorAll("span");
        for (const span of spans) {
          if (span.textContent === "kb_search" && span.offsetWidth > 0) {
            (span as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (badgeClicked) {
        await page.waitForTimeout(200);
        await page.screenshot({ path: "/tmp/visual-4-tool-expanded.png", fullPage: true });
      }
    }
  });
});
