// =============================================================================
// Regression #78: highlight.js on-demand registration + bundle size reduction
// =============================================================================
// Strategy: verify three deterministic outcomes:
//   1. Markdown chunk loaded is < 200 KB (was 1,032 KB before fix)
//   2. highlight() still produces hljs-* spans on real code blocks in the UI
//   3. No console errors related to highlight.js
//
// The chat is driven entirely through the UI to exercise the real user flow.
// =============================================================================

import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "tests/e2e/screenshots/regression-78";
mkdirSync(SHOTS, { recursive: true });

// Reasoning models can take a while to produce code blocks
const AGENT_TIMEOUT = 180_000;

test.describe("#78 highlight.js", () => {
  test("markdown chunk is small and renders code highlighting", async ({ page, request }) => {
    test.setTimeout(240_000); // 4 min — reasoning model may be slow
    const consoleErrors: string[] = [];
    const chunkSizes: Record<string, number> = {};

    // ---------------------------------------------------------------------------
    // Hook into page events BEFORE navigation
    // ---------------------------------------------------------------------------
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("response", async (resp) => {
      const url = resp.url();
      if (url.includes("/assets/markdown-")) {
        try {
          const buf = await resp.body();
          chunkSizes[url] = buf.length;
        } catch {
          /* body already consumed */
        }
      }
    });

    await page.addInitScript(() => {
      (window as any).__consoleErrors = [];
      const orig = console.error;
      console.error = function (...args: unknown[]) {
        (window as any).__consoleErrors.push(args.map(String).join(" "));
        orig.apply(console, args as never);
      };
    });

    // ---------------------------------------------------------------------------
    // Step 1: create session via API
    // ---------------------------------------------------------------------------
    const createResp = await request.post("/api/sessions", { data: {} });
    expect(createResp.ok()).toBeTruthy();
    const session = await createResp.json();
    const sessionId = session.id;
    console.log(`[test] session=${sessionId}`);

    // ---------------------------------------------------------------------------
    // Step 2: open the session UI (hash router: /#/sessions/<id>)
    // ---------------------------------------------------------------------------
    await page.goto(`/#/sessions/${sessionId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    const textarea = page.locator("textarea").first();
    const sendBtn = page.locator('button[title="发送消息"]');
    await expect(textarea).toBeVisible();
    await expect(sendBtn).toBeVisible();
    console.log("[test] UI ready: textarea + send button visible");

    // ---------------------------------------------------------------------------
    // Step 3: send a chat that elicits code blocks in multiple languages
    // ---------------------------------------------------------------------------
    const prompt = [
      "请用一段简短的代码示例回答（每个语言不超过 6 行），展示以下语言的 hello world：",
      "1. JavaScript",
      "2. Python",
      "3. Bash",
      "4. JSON (一个简单的配置对象)",
      "5. SQL (一个 SELECT 查询)",
      "6. TypeScript",
      "用 markdown ```代码块``` 包裹每个示例。直接给代码，不要解释。",
    ].join("\n");

    await textarea.fill(prompt);
    await page.screenshot({
      path: `${SHOTS}/01-prompt-filled.png`,
      fullPage: true,
    });

    await sendBtn.click();
    console.log("[test] prompt sent, waiting for agent response...");

    // ---------------------------------------------------------------------------
    // Step 4: wait for at least one <pre><code> block to appear in the DOM
    // ---------------------------------------------------------------------------
    const codeBlockLocator = page.locator("pre code").first();
    await codeBlockLocator.waitFor({ state: "attached", timeout: AGENT_TIMEOUT });
    // Give a little extra time for highlighting pass to run after markdown render
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: `${SHOTS}/02-response-received.png`,
      fullPage: true,
    });

    // ---------------------------------------------------------------------------
    // Step 5: verify code blocks rendered with hljs highlighting
    // ---------------------------------------------------------------------------
    const codeBlocks = await page
      .locator("pre code.hljs, pre code[class*='language-']")
      .count();
    console.log(`[test] found ${codeBlocks} code blocks`);

    const firstBlockHtml = await page
      .locator("pre code")
      .first()
      .innerHTML()
      .catch(() => "");
    const hasHljsSpans = firstBlockHtml.includes('class="hljs-');
    console.log(`[test] first block has hljs spans: ${hasHljsSpans}`);
    console.log(
      `[test] first block HTML (first 400 chars): ${firstBlockHtml.slice(0, 400)}`,
    );

    expect(codeBlocks, "should be at least one code block").toBeGreaterThan(0);
    expect(hasHljsSpans, "code block must have hljs highlighting spans").toBe(true);

    // ---------------------------------------------------------------------------
    // Step 6: verify markdown chunk size
    // ---------------------------------------------------------------------------
    await page.waitForLoadState("networkidle");
    const markdownChunks = Object.entries(chunkSizes);
    console.log(`[test] markdown chunks captured: ${markdownChunks.length}`);
    for (const [url, size] of markdownChunks) {
      const kb = (size / 1024).toFixed(1);
      console.log(`  ${url.split("/").pop()} = ${kb} KB`);
    }

    expect(
      markdownChunks.length,
      "markdown chunk must have loaded after opening a session",
    ).toBeGreaterThan(0);
    for (const [url, size] of markdownChunks) {
      expect.soft(
        size,
        `chunk ${url.split("/").pop()} must be < 200KB (was 1032KB before #78)`,
      ).toBeLessThan(200 * 1024);
    }

    // ---------------------------------------------------------------------------
    // Step 7: verify no highlight.js-related console errors
    // ---------------------------------------------------------------------------
    const errors = await page.evaluate(() => (window as any).__consoleErrors || []);
    const hljsErrors = (errors as string[]).filter(
      (e) => e.toLowerCase().includes("highlight") || e.toLowerCase().includes("hljs"),
    );
    console.log(`[test] total console errors: ${errors.length}`);
    console.log(`[test] highlight.js-related errors: ${hljsErrors.length}`);
    if (hljsErrors.length > 0) console.log("  errors:", hljsErrors);
    expect(hljsErrors, "no highlight.js-related console errors").toEqual([]);

    await page.screenshot({ path: `${SHOTS}/03-final.png`, fullPage: true });

    // Cleanup
    await request.delete(`/api/sessions/${sessionId}`).catch(() => {});
  });
});
