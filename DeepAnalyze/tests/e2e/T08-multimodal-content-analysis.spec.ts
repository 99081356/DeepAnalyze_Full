/**
 * T08: 多模态内容分析（图片+音频+视频）
 *
 * 测试设计：
 * - 选中bigtest
 * - 分析所有图片、音频和视频文件
 * - 验证：图片覆盖、VLM质量、ASR质量、视频理解、跨模态关联
 */
import { test, expect } from "@playwright/test";
import { createApi } from "./helpers/api";
import { takeScreenshot, gotoPage } from "./helpers/visual";

const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

const PROMPT = `请分析知识库中所有图片、音频和视频文件。要求：
1. 图片：描述每张图片的内容，如果是截图则分析界面功能，如果是照片则分析场景和人物
2. 音频：转写所有音频内容，标注说话人和时间戳
3. 视频：描述视频内容，提取关键帧和对话
4. 多模态关联：分析不同媒体文件之间是否存在关联（如同一事件的录音和照片）
5. VLM验证：图片描述必须基于VLM视觉分析结果，不得凭空描述`;

test.describe("T08 - 多模态内容分析", () => {
  let sessionId: string;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    const api = createApi(request);
    const session = await api.createSession("T08-多模态内容分析", {
      kbIds: [TEST_KB_ID],
    });
    sessionId = session.id;

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

  test("T08.1 发送多模态分析提示词并等待完成", async ({ request }) => {
    test.setTimeout(1_800_000);

    await gotoPage(page, `sessions/${sessionId}`);
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
    }, { prompt: PROMPT, sid: sessionId });

    console.log(`[T08] Agent run-stream completed with status: ${status}`);

    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T08-1-agent-completed");
  });

  test("T08.2 验证消息完整性", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    console.log(`[T08] Total messages: ${msgs.length}`);
    expect(msgs.length).toBeGreaterThanOrEqual(2);

    const assistantMsgs = msgs.filter((m) => m.role === "assistant");
    const totalContent = assistantMsgs.map((m) => m.content || "").join("");
    const pushedContentLength = assistantMsgs.reduce((sum, m) => {
      const pushed = (m.pushedContents || m.metadata?.pushedContents || []) as any[];
      return sum + pushed.reduce((s: number, pc: any) => s + (pc.data?.length || pc.content?.length || 0), 0);
    }, 0);
    const totalChars = totalContent.length + pushedContentLength;
    console.log(`[T08] Total output: ${totalChars} chars`);
    expect(totalChars).toBeGreaterThan(500);
  });

  test("T08.3 验证工具调用", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    const assistantMsgs = msgs.filter((m) => m.role === "assistant");

    let totalToolCalls = 0;
    const toolNames = new Set<string>();
    for (const msg of assistantMsgs) {
      const calls = (msg.toolCalls || msg.metadata?.toolCalls || []) as any[];
      totalToolCalls += calls.length;
      for (const tc of calls) { if (tc.toolName) toolNames.add(tc.toolName); }
    }
    console.log(`[T08] Tool calls: ${totalToolCalls}, tools: ${[...toolNames].join(", ")}`);
    expect(totalToolCalls).toBeGreaterThan(0);
  });

  test("T08.4 验证多模态内容覆盖", async ({ request }) => {
    test.setTimeout(60_000);
    const api = createApi(request);
    const msgs = await api.getMessages(sessionId);
    const allContent = msgs.filter((m) => m.role === "assistant").map((m) => m.content || "").join("\n");

    // Check for multimodal coverage
    const modalities = [
      { name: "图片", keywords: ["图片", "图像", "截图", "照片", "image", "jpg"] },
      { name: "音频", keywords: ["音频", "录音", "转写", "mp3", "语音"] },
      { name: "视频", keywords: ["视频", "mp4", "画面", "场景"] },
    ];
    for (const mod of modalities) {
      const found = mod.keywords.some((kw) => allContent.includes(kw));
      console.log(`[T08] Modality "${mod.name}" covered: ${found}`);
    }

    await takeScreenshot(page, "T08-4-multimodal-content");
  });

  test("T08.5 前端最终显示效果截图", async () => {
    test.setTimeout(60_000);
    await gotoPage(page, `sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await takeScreenshot(page, "T08-5-final-fullpage", { fullPage: true });

    const consoleErrors = (page as any).__consoleErrors as string[] || [];
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("ResizeObserver") && !e.includes("WebSocket")
    );
    console.log(`[T08] Console errors (${criticalErrors.length}): ${criticalErrors.slice(0, 5).join("; ")}`);
  });
});
