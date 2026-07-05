// =============================================================================
// DeepAnalyze - Browser Tool (Playwright-based)
// =============================================================================
// Allows the agent to navigate web pages, take screenshots, extract text
// content, and interact with page elements via CSS selectors.
// Playwright is lazy-loaded so the tool imposes zero startup cost when unused.
// =============================================================================

/**
 * Create a browser tool that uses Playwright (lazy-loaded) to interact with
 * web pages. Supported actions: navigate, screenshot, extract, click, fill.
 *
 * The tool launches a new headless Chromium instance per call and tears it
 * down in a `finally` block to avoid leaking browser processes.
 */
export function createBrowserTool(): {
  name: string;
  description: string;
  inputSchema: any;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    name: "browser",
    description:
      "使用无头浏览器访问网页、截图、提取文本内容和交互元素。" +
      "支持导航到指定 URL、截取页面截图（返回 base64 PNG）、" +
      "提取页面文本（支持 CSS 选择器定位特定元素）、" +
      "点击页面元素、填写表单字段。" +
      "每次调用启动独立的浏览器实例，完成后自动关闭。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["navigate", "screenshot", "extract", "click", "fill"],
          description:
            "要执行的操作：navigate=导航到URL，screenshot=截图，extract=提取文本，click=点击元素，fill=填写表单",
        },
        url: {
          type: "string",
          description: "要导航到的 URL（navigate 必填，其他操作可选——提供时先导航再操作）",
        },
        selector: {
          type: "string",
          description: "CSS 选择器，用于定位 click/fill/extract 操作的目标元素",
        },
        value: {
          type: "string",
          description: "fill 操作要填入的值",
        },
      },
      required: ["action"],
    },

    async execute(input: Record<string, unknown>) {
      const action = input.action as string;
      const url = input.url as string | undefined;
      const selector = input.selector as string | undefined;
      const value = input.value as string | undefined;

      // Validate action
      const validActions = ["navigate", "screenshot", "extract", "click", "fill"];
      if (!validActions.includes(action)) {
        return {
          success: false,
          error: `Invalid action "${action}". Must be one of: ${validActions.join(", ")}`,
        };
      }

      // Navigate requires a URL
      if (action === "navigate" && !url) {
        return { success: false, error: 'The "navigate" action requires a "url" parameter.' };
      }

      // Click and fill require a selector
      if ((action === "click" || action === "fill") && !selector) {
        return { success: false, error: `The "${action}" action requires a "selector" parameter.` };
      }

      // Fill requires a value
      if (action === "fill" && value === undefined) {
        return { success: false, error: 'The "fill" action requires a "value" parameter.' };
      }

      let browser: import("playwright").Browser | null = null;

      try {
        // Lazy-import Playwright to avoid startup overhead
        const { chromium } = await import("playwright");

        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        });
        const page = await context.newPage();

        // If a URL is provided for any action, navigate first
        if (url) {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        }

        switch (action) {
          // ---------------------------------------------------------------
          // navigate — go to URL and return page metadata
          // ---------------------------------------------------------------
          case "navigate": {
            const title = await page.title();
            const finalUrl = page.url();
            return { success: true, title, url: finalUrl };
          }

          // ---------------------------------------------------------------
          // screenshot — capture PNG screenshot as base64
          // ---------------------------------------------------------------
          case "screenshot": {
            const screenshotBuffer = await page.screenshot({ type: "png", fullPage: false });
            const base64 = screenshotBuffer.toString("base64");
            return {
              success: true,
              screenshot: base64,
              mimeType: "image/png",
            };
          }

          // ---------------------------------------------------------------
          // extract — get text content from selector or full body
          // ---------------------------------------------------------------
          case "extract": {
            let text: string;
            if (selector) {
              const element = await page.$(selector);
              if (!element) {
                return { success: false, error: `Element not found for selector: "${selector}"` };
              }
              text = (await element.textContent()) ?? "";
            } else {
              text = (await page.textContent("body")) ?? "";
            }
            return { success: true, text: text.trim() };
          }

          // ---------------------------------------------------------------
          // click — click an element identified by selector
          // ---------------------------------------------------------------
          case "click": {
            await page.click(selector!, { timeout: 10_000 });
            // Wait briefly for any navigation or JS updates
            await page.waitForTimeout(500);
            return { success: true };
          }

          // ---------------------------------------------------------------
          // fill — fill a form field with the provided value
          // ---------------------------------------------------------------
          case "fill": {
            await page.fill(selector!, value!, { timeout: 10_000 });
            return { success: true };
          }

          default: {
            return { success: false, error: `Unhandled action: ${action}` };
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Browser tool error: ${message}` };
      } finally {
        // Always close the browser to prevent process leaks
        if (browser) {
          try {
            await browser.close();
          } catch {
            // Swallow close errors — the main operation result takes priority
          }
        }
      }
    },
  };
}
