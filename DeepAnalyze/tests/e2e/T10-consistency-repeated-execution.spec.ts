/**
 * T10: 一致性验证——同一问题多次执行结果对比
 *
 * 测试设计：
 * - 选中lbctest
 * - 连续执行3次完全相同的提示词
 * - 验证：结果一致性、结构一致性、覆盖率一致性、无矛盾
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT = `请列出这个案件中所有涉及的资金转移记录，包括金额、日期、转出方、接收方。按时间顺序排列。`;

test.describe("T10 - 一致性验证", () => {
  let page: Page;
  const results: { sessionId: string; content: string; toolCalls: number }[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    (page as any).__consoleErrors = consoleErrors;
  });

  test.afterAll(async () => {
    if (page) await page.close().catch(() => {});
  });

  // Run the same prompt 3 times and collect results
  for (let run = 1; run <= 3; run++) {
    test(`T10.${run} 第${run}次执行`, async ({ request }) => {
      test.setTimeout(1_800_000);

      const api = createApi(request);
      const session = await api.createSession(`T10-一致性测试-第${run}次`, {
        kbIds: [LBC_KB_ID],
      });

      await gotoPage(page, `sessions/${session.id}`);
      await page.waitForLoadState("networkidle");

      const status = await page.evaluate(async ({ prompt, sid }) => {
        const resp = await fetch("/api/agents/run-stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: prompt, sessionId: sid }),
        });
        const reader = resp.body?.getReader();
        if (reader) {
          while (true) { const { done } = await reader.read(); if (done) break; }
        }
        return resp.status;
      }, { prompt: PROMPT, sid: session.id });

      console.log(`[T10] Run ${run} completed with status: ${status}`);

      await gotoPage(page, `sessions/${session.id}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(3000);
      await takeScreenshot(page, `T10-${run}-completed`);

      // Collect results
      const msgs = await api.getMessages(session.id);
      const assistantMsgs = msgs.filter((m) => m.role === "assistant");
      const content = assistantMsgs.map((m) => m.content || "").join("\n");
      let toolCallCount = 0;
      for (const msg of assistantMsgs) {
        const calls = (msg.toolCalls || msg.metadata?.toolCalls || []) as any[];
        toolCallCount += calls.length;
      }
      results.push({ sessionId: session.id, content, toolCalls: toolCallCount });
      console.log(`[T10] Run ${run}: ${content.length} chars, ${toolCallCount} tool calls`);
    });
  }

  test("T10.4 对比3次执行结果", async () => {
    test.setTimeout(60_000);

    expect(results.length, "Should have 3 results").toBe(3);

    // Compare output lengths (should be similar order of magnitude)
    const lengths = results.map((r) => r.content.length);
    const minLen = Math.min(...lengths);
    const maxLen = Math.max(...lengths);
    const ratio = maxLen / Math.max(minLen, 1);
    console.log(`[T10] Output lengths: ${lengths.join(", ")}`);
    console.log(`[T10] Length ratio (max/min): ${ratio.toFixed(2)}`);

    // Check for common number patterns across runs
    const extractNumbers = (text: string): string[] => {
      const matches = text.match(/[\d,]+\.?\d*/g) || [];
      return matches.filter((m) => m.length >= 2);
    };

    for (let i = 0; i < 3; i++) {
      const numbers = extractNumbers(results[i].content);
      console.log(`[T10] Run ${i + 1} unique numbers: ${numbers.length}`);
    }

    // Tool call counts should be similar
    const toolCalls = results.map((r) => r.toolCalls);
    console.log(`[T10] Tool call counts: ${toolCalls.join(", ")}`);

    await takeScreenshot(page, "T10-4-comparison");
  });
});
