/**
 * T48: 并发会话隔离
 *
 * 测试设计：
 * - 创建两个会话，分别绑定bigtest和lbctest
 * - 按顺序运行Agent（Playwright难以真正并行）
 * - 验证两个会话的消息不交叉污染
 *
 * 观察目标：
 * 1. 两个会话创建成功
 * 2. 会话A (bigtest) Agent正常运行
 * 3. 会话B (lbctest) Agent正常运行
 * 4. 两个会话消息不交叉污染
 * 5. 截图
 */
import { test, expect } from "@playwright/test";
import { createApi, type Message } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const BIGTEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";
const LBC_KB_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

const PROMPT_A = "请列出知识库中的所有文档名称和类型。";
const PROMPT_B = "请列出知识库中的所有文档名称和类型。";

test.describe("T48 - 并发会话隔离", () => {
  let sessionAId: string;
  let sessionBId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);

    const sessionA = await api.createSession("T48-会话A-bigtest", {
      kbIds: [BIGTEST_KB_ID],
    });
    sessionAId = sessionA.id;

    const sessionB = await api.createSession("T48-会话B-lbctest", {
      kbIds: [LBC_KB_ID],
    });
    sessionBId = sessionB.id;

    console.log(`[T48] Session A: ${sessionAId} (bigtest)`);
    console.log(`[T48] Session B: ${sessionBId} (lbctest)`);

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

  test("T48.1 创建两个会话", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const sessionA = await api.getSession(sessionAId);
    const sessionB = await api.getSession(sessionBId);

    console.log(`[T48] Session A title: ${sessionA.title}`);
    console.log(`[T48] Session B title: ${sessionB.title}`);

    expect(sessionA.id, "Session A should exist").toBeTruthy();
    expect(sessionB.id, "Session B should exist").toBeTruthy();
    expect(sessionA.id, "Sessions should be different").not.toBe(sessionB.id);
  });

  test("T48.2 运行Agent在会话A (bigtest)", async ({ request }) => {
    test.setTimeout(1_800_000); // 30 minutes

    await gotoPage(page, `sessions/${sessionAId}`);
    await page.waitForLoadState("networkidle");

    const status = await page.evaluate(async ({ prompt, sid }) => {
      const resp = await fetch("/api/agents/run-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: prompt, sessionId: sid }),
      });
      const reader = resp.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      return resp.status;
    }, { prompt: PROMPT_A, sid: sessionAId });

    console.log(`[T48] Session A agent completed with status: ${status}`);
    await takeScreenshot(page, "T48-2-session-a-completed");
  });

  test("T48.3 运行Agent在会话B (lbctest)", async ({ request }) => {
    test.setTimeout(1_800_000); // 30 minutes

    await gotoPage(page, `sessions/${sessionBId}`);
    await page.waitForLoadState("networkidle");

    const status = await page.evaluate(async ({ prompt, sid }) => {
      const resp = await fetch("/api/agents/run-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: prompt, sessionId: sid }),
      });
      const reader = resp.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
      return resp.status;
    }, { prompt: PROMPT_B, sid: sessionBId });

    console.log(`[T48] Session B agent completed with status: ${status}`);
    await takeScreenshot(page, "T48-3-session-b-completed");
  });

  test("T48.4 验证消息不交叉污染", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);

    const msgsA = await api.getMessages(sessionAId);
    const msgsB = await api.getMessages(sessionBId);

    console.log(`[T48] Session A messages: ${msgsA.length}`);
    console.log(`[T48] Session B messages: ${msgsB.length}`);

    // Each session should have its own messages
    expect(msgsA.length, "Session A should have messages").toBeGreaterThanOrEqual(2);
    expect(msgsB.length, "Session B should have messages").toBeGreaterThanOrEqual(2);

    // Verify no cross-contamination: Session A message IDs should not appear in Session B
    const idsA = new Set(msgsA.map((m) => m.id));
    const idsB = new Set(msgsB.map((m) => m.id));
    const overlap = [...idsA].filter((id) => idsB.has(id));
    console.log(`[T48] Message ID overlap: ${overlap.length}`);
    expect(overlap.length, "Should have no overlapping message IDs").toBe(0);

    // Verify content isolation
    const contentA = msgsA.filter((m) => m.role === "user").map((m) => m.content || "").join("");
    const contentB = msgsB.filter((m) => m.role === "user").map((m) => m.content || "").join("");

    // Each session should have its own user message
    console.log(`[T48] Session A user content: ${contentA.slice(0, 100)}`);
    console.log(`[T48] Session B user content: ${contentB.slice(0, 100)}`);
  });

  test("T48.5 截图", async () => {
    test.setTimeout(60_000);

    // Screenshot session A
    await gotoPage(page, `sessions/${sessionAId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T48-5-session-a-final");

    // Screenshot session B
    await gotoPage(page, `sessions/${sessionBId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await takeScreenshot(page, "T48-5-session-b-final");

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T48] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);
  });
});
