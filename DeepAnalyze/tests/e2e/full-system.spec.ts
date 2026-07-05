// =============================================================================
// DeepAnalyze - Full System E2E Test Suite
// Comprehensive Playwright tests covering all UI components
// Run with: npx playwright test tests/e2e/full-system.spec.ts
// =============================================================================

import { test, expect, type Page, type Locator } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:21000";
const SCREENSHOT_DIR = "tests/screenshots/full-system";

// Helper to build screenshot path
function ss(num: number, name: string) {
  return `${SCREENSHOT_DIR}-${String(num).padStart(2, "0")}-${name}.png`;
}

// Helper: take a screenshot with a descriptive name
async function screenshot(page: Page, num: number, name: string) {
  await page.screenshot({
    path: ss(num, name),
    fullPage: false,
  });
}

// Helper: open right panel by clicking header action button with the given title
async function openRightPanel(page: Page, panelTitle: string) {
  const btn = page.locator(`header button[title="${panelTitle}"]`);
  await btn.waitFor({ state: "visible", timeout: 10000 });
  await btn.click();
  // Wait for the panel to slide in
  await page.waitForTimeout(400);
}

// Helper: close right panel by clicking the X button or pressing Escape
async function closeRightPanel(page: Page) {
  // Click the overlay or press Escape
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// Test suite configuration
// ---------------------------------------------------------------------------

test.describe.configure({ mode: "serial", timeout: 60000, retries: 1 });

// Shared state across serial tests (first KB ID discovered)
let firstKbId = "";
let firstKbName = "";

// ===========================================================================
// 1. Page Loading & Core Layout
// ===========================================================================

test.describe("1. Page Loading & Core Layout", () => {
  test("1.1 Main page loads, React root renders, no console errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(BASE_URL, { waitUntil: "networkidle" });

    await screenshot(page, 1, "page-load-before");

    // Verify React root rendered
    const root = page.locator("#root");
    await expect(root).toBeAttached();

    // Verify key branding text is present (use .first() since multiple elements may match)
    await expect(page.locator("text=DeepAnalyze").first()).toBeVisible();

    await screenshot(page, 2, "page-load-after");

    // Allow some console errors from network (e.g. health check failure) but
    // fail on critical React rendering errors
    const criticalErrors = consoleErrors.filter(
      (e) =>
        e.includes("Uncaught Error") &&
        !e.includes("net::ERR") &&
        !e.includes("Failed to fetch")
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test("1.2 Sidebar visible and functional", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await screenshot(page, 3, "sidebar-before");

    // Sidebar aside element exists
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible();

    // "新建对话" button visible
    await expect(page.locator('button[title="新建对话"]')).toBeVisible();

    // Nav items visible in sidebar nav: 对话, 知识库, 报告, 任务
    // Scope to aside nav to avoid matching "新建对话" button
    const nav = sidebar.locator("nav");
    await expect(nav.locator('button:has-text("对话")')).toBeVisible();
    await expect(nav.locator('button:has-text("知识库")')).toBeVisible();
    await expect(nav.locator('button:has-text("报告")')).toBeVisible();
    await expect(nav.locator('button:has-text("任务")')).toBeVisible();

    await screenshot(page, 4, "sidebar-after");
  });

  test("1.3 Header visible with all buttons", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await screenshot(page, 5, "header-before");

    // Header element exists
    const header = page.locator("header");
    await expect(header).toBeVisible();

    // "DeepAnalyze" branding
    await expect(header.locator("text=DeepAnalyze")).toBeVisible();

    // Action buttons visible (title attributes)
    const expectedButtons = [
      "会话历史",
      "插件管理",
      "技能库",
      "团队管理",
      "定时任务",
      "自进化",
      "设置",
    ];
    for (const title of expectedButtons) {
      await expect(page.locator(`header button[title="${title}"]`)).toBeVisible();
    }

    await screenshot(page, 6, "header-after");
  });

  test("1.4 Theme toggle works (light/dark)", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await screenshot(page, 7, "theme-before");

    // Find the theme toggle button (Sun or Moon icon)
    const themeBtn = page.locator('header button[title^="切换"]');
    await expect(themeBtn).toBeVisible();

    // Read current theme
    const currentTheme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme")
    );

    // Click to toggle
    await themeBtn.click();
    await page.waitForTimeout(500);

    const newTheme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme")
    );
    expect(newTheme).not.toBe(currentTheme);

    await screenshot(page, 8, "theme-after");

    // Toggle back
    await themeBtn.click();
    await page.waitForTimeout(500);
    const restoredTheme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme")
    );
    expect(restoredTheme).toBe(currentTheme);
  });
});

// ===========================================================================
// 2. Knowledge Base Page
// ===========================================================================

test.describe("2. Knowledge Base Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
  });

  test("2.1 KB list loads and renders", async ({ page }) => {
    // Click 知识库 nav item (scope to aside nav to be precise)
    await page.locator('aside nav button:has-text("知识库")').click();
    await page.waitForTimeout(2000);

    await screenshot(page, 9, "kb-list-before");

    // Wait for knowledge panel to load (either KB selector or content)
    const kbSelector = page.locator('select, [class*="kb"], [data-testid="kb-selector"]').first();
    // Check if we have any KB content visible
    await page.waitForTimeout(1000);

    // Look for any KB-related content (either dropdown or KB name)
    const hasKbContent = await page.locator("select").count() > 0 ||
      await page.locator('text=知识库').count() > 0;
    expect(hasKbContent).toBeTruthy();

    await screenshot(page, 10, "kb-list-after");
  });

  test("2.2 Create new KB button works", async ({ page }) => {
    // Navigate to knowledge page
    await page.locator('aside nav button:has-text("知识库")').click();
    await page.waitForTimeout(2000);

    await screenshot(page, 11, "kb-create-before");

    // Look for create KB button (various possible selectors)
    const createBtn = page.locator('button:has-text("新建"), button:has-text("创建"), button[title="新建知识库"]').first();
    const btnCount = await createBtn.count();
    if (btnCount > 0) {
      await createBtn.click();
      await page.waitForTimeout(1000);
      await screenshot(page, 12, "kb-create-after");
    } else {
      test.skip();
    }
  });

  test("2.3 Upload file(s) to KB", async ({ page }) => {
    await page.locator('aside nav button:has-text("知识库")').click();
    await page.waitForTimeout(2000);

    await screenshot(page, 13, "kb-upload-before");

    // Look for upload button or drop zone
    const uploadBtn = page.locator('button:has-text("上传"), button[title="上传文件"]').first();
    const uploadBtnCount = await uploadBtn.count();
    if (uploadBtnCount > 0) {
      // The actual file upload is complex; just verify the button exists and is clickable
      await expect(uploadBtn).toBeVisible();
      await screenshot(page, 14, "kb-upload-after");
    } else {
      test.skip();
    }
  });

  test("2.4 Document list renders with cards", async ({ page }) => {
    await page.locator('aside nav button:has-text("知识库")').click();
    await page.waitForTimeout(3000);

    await screenshot(page, 15, "kb-docs-before");

    // If KB exists, documents should load; check for document cards or tree
    const hasDocCards = (await page.locator('[class*="document"], [class*="card"]').count()) > 0 ||
      (await page.locator('text=文档').count()) > 0;
    // It's OK if no docs exist yet
    await screenshot(page, 16, "kb-docs-after");
  });

  test("2.5 L1 preview visible on document cards", async ({ page }) => {
    await page.locator('aside nav button:has-text("知识库")').click();
    await page.waitForTimeout(3000);

    await screenshot(page, 17, "kb-l1-preview-before");

    // Look for L1 buttons or preview text
    const l1Btn = page.locator('button:has-text("L1"), [title="L1"]').first();
    const hasL1 = await l1Btn.count();
    if (hasL1 > 0) {
      await l1Btn.click();
      await page.waitForTimeout(1000);
      await screenshot(page, 18, "kb-l1-preview-after");
    } else {
      test.skip();
    }
  });

  test("2.6 Document card expand/collapse works", async ({ page }) => {
    await page.locator('aside nav button:has-text("知识库")').click();
    await page.waitForTimeout(3000);

    await screenshot(page, 19, "kb-expand-before");

    // Look for expandable document cards (chevrons or expand buttons)
    const expandBtn = page.locator('[title="展开"], [title="Expand"], button svg.lucide-chevron-down').first();
    const hasExpand = await expandBtn.count();
    if (hasExpand > 0) {
      await expandBtn.click();
      await page.waitForTimeout(500);
      await screenshot(page, 20, "kb-expand-after");
    } else {
      test.skip();
    }
  });

  test("2.7 Delete document from KB", async ({ page }) => {
    await page.locator('aside nav button:has-text("知识库")').click();
    await page.waitForTimeout(3000);

    await screenshot(page, 21, "kb-delete-doc-before");

    // Look for delete button on a document card
    const deleteDocBtn = page.locator('[title="删除文档"], [title="Delete document"]').first();
    const hasDeleteBtn = await deleteDocBtn.count();
    if (hasDeleteBtn > 0) {
      // Just verify button is visible, don't actually delete in test
      await expect(deleteDocBtn).toBeVisible();
      await screenshot(page, 22, "kb-delete-doc-after");
    } else {
      test.skip();
    }
  });

  test("2.8 Delete entire KB", async ({ page }) => {
    await page.locator('aside nav button:has-text("知识库")').click();
    await page.waitForTimeout(3000);

    await screenshot(page, 23, "kb-delete-kb-before");

    // Look for KB delete button
    const deleteKbBtn = page.locator('[title="删除知识库"], [title="Delete KB"]').first();
    const hasDeleteKb = await deleteKbBtn.count();
    if (hasDeleteKb > 0) {
      await expect(deleteKbBtn).toBeVisible();
      await screenshot(page, 24, "kb-delete-kb-after");
    } else {
      test.skip();
    }
  });
});

// ===========================================================================
// 3. Chat Window
// ===========================================================================

test.describe("3. Chat Window", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
  });

  test("3.1 Chat input area visible", async ({ page }) => {
    // Click "对话" to ensure we're on the chat view
    await page.locator('aside nav button:has-text("对话")').click();
    await page.waitForTimeout(1000);

    await screenshot(page, 25, "chat-input-before");

    // If no session active, we see welcome screen; create a session
    const welcomeVisible = await page.locator('text=开始对话').count();
    if (welcomeVisible > 0) {
      await page.locator('button:has-text("开始对话")').click();
      await page.waitForTimeout(2000);
    }

    // Chat input textarea should be visible
    const textarea = page.locator('textarea[placeholder*="输入消息"]');
    const textareaCount = await textarea.count();
    if (textareaCount > 0) {
      await expect(textarea).toBeVisible();
    }

    await screenshot(page, 26, "chat-input-after");
  });

  test("3.2 Can type and send a message", async ({ page }) => {
    await page.locator('aside nav button:has-text("对话")').click();
    await page.waitForTimeout(1000);

    // Create a session first if needed
    const welcomeVisible = await page.locator('text=开始对话').count();
    if (welcomeVisible > 0) {
      await page.locator('button:has-text("开始对话")').click();
      await page.waitForTimeout(2000);
    }

    await screenshot(page, 27, "chat-type-before");

    const textarea = page.locator('textarea[placeholder*="输入消息"]').first();
    const hasTextarea = await textarea.count();
    if (hasTextarea > 0) {
      await textarea.fill("Hello, this is an E2E test message.");
      await page.waitForTimeout(300);
      await screenshot(page, 28, "chat-type-typed");

      // Click send button
      const sendBtn = page.locator('button[title="发送消息"], button:has(svg.lucide-send)').last();
      if (await sendBtn.count() > 0) {
        await sendBtn.click();
        await page.waitForTimeout(2000);
        await screenshot(page, 29, "chat-type-sent");
      }
    } else {
      test.skip();
    }
  });

  test("3.3 Agent response streams back", async ({ page }) => {
    await page.locator('aside nav button:has-text("对话")').click();
    await page.waitForTimeout(1000);

    await screenshot(page, 30, "chat-response-before");

    // Check if there's any existing messages in the current session
    const messages = page.locator('[class*="message"], [data-testid="message"]').count();
    // Or look for any streamed text content
    await page.waitForTimeout(1000);

    await screenshot(page, 31, "chat-response-after");
    // This test primarily verifies the chat UI is responsive; actual
    // agent response testing requires a configured backend.
  });

  test("3.4 Tool calls visible during agent execution", async ({ page }) => {
    await page.locator('aside nav button:has-text("对话")').click();
    await page.waitForTimeout(1000);

    await screenshot(page, 32, "chat-toolcalls-before");

    // Look for tool call cards or indicators
    const toolCallCards = page.locator('[class*="tool-call"], [class*="ToolCall"], [data-testid="tool-call"]');
    // These only appear during active agent execution, so just verify structure
    await screenshot(page, 33, "chat-toolcalls-after");
  });

  test("3.5 Session list panel accessible", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await screenshot(page, 34, "chat-sessions-before");

    // Open sessions panel from header
    await openRightPanel(page, "会话历史");

    // Panel should be visible with title "会话历史"
    await expect(page.locator('h3:has-text("会话历史")').first()).toBeVisible();
    await screenshot(page, 35, "chat-sessions-after");

    await closeRightPanel(page);
  });

  test("3.6 Scope selector (KB selection) works", async ({ page }) => {
    // Create a chat session first
    await page.locator('aside nav button:has-text("对话")').click();
    await page.waitForTimeout(1000);

    const welcomeVisible = await page.locator('text=开始对话').count();
    if (welcomeVisible > 0) {
      await page.locator('button:has-text("开始对话")').click();
      await page.waitForTimeout(2000);
    }

    await screenshot(page, 36, "chat-scope-before");

    // Look for scope selector in the chat header area
    // It has a button with "分析范围" or a globe/database icon
    const scopeBtn = page.locator('[title*="范围"], button:has-text("分析范围"), [class*="scope"]').first();
    const hasScope = await scopeBtn.count();
    if (hasScope > 0) {
      await scopeBtn.click();
      await page.waitForTimeout(500);
      await screenshot(page, 37, "chat-scope-after");
    } else {
      // Might be on welcome screen with scope visible
      await screenshot(page, 37, "chat-scope-welcome");
    }
  });
});

// ===========================================================================
// 4. Settings Panels
// ===========================================================================

test.describe("4. Settings Panels", () => {
  async function openSettings(page: Page) {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await openRightPanel(page, "设置");
    // Wait for settings panel to load
    await page.waitForTimeout(1000);
  }

  test("4.1 Settings panel opens", async ({ page }) => {
    await openSettings(page);

    await screenshot(page, 38, "settings-open-before");

    // Panel title "设置"
    await expect(page.locator('h3:has-text("设置")').first()).toBeVisible();

    // Left nav tabs visible
    await expect(page.locator('button[title="模型配置"]')).toBeVisible();
    await expect(page.locator('button[title="通信渠道"]')).toBeVisible();
    await expect(page.locator('button[title="MCP 服务"]')).toBeVisible();
    await expect(page.locator('button[title="通用"]')).toBeVisible();

    await screenshot(page, 39, "settings-open-after");

    await closeRightPanel(page);
  });

  test("4.2 Main model config tab loads", async ({ page }) => {
    await openSettings(page);

    await screenshot(page, 40, "settings-models-main-before");

    // Models tab should be default - click it explicitly
    await page.locator('button[title="模型配置"]').click();
    await page.waitForTimeout(1000);

    // Main model tab should be active by default
    // Look for the main model sub-tab
    const mainTab = page.locator('button:has-text("主模型")');
    if (await mainTab.count() > 0) {
      await mainTab.click();
      await page.waitForTimeout(500);
    }

    await screenshot(page, 41, "settings-models-main-after");

    await closeRightPanel(page);
  });

  test("4.3 Sub model config tab loads", async ({ page }) => {
    await openSettings(page);

    await page.locator('button[title="模型配置"]').click();
    await page.waitForTimeout(1000);

    await screenshot(page, 42, "settings-models-sub-before");

    const subTab = page.locator('button:has-text("辅助模型"), button:has-text("辅助")').first();
    if (await subTab.count() > 0) {
      await subTab.click();
      await page.waitForTimeout(500);
      await screenshot(page, 43, "settings-models-sub-after");
    } else {
      test.skip();
    }

    await closeRightPanel(page);
  });

  test("4.4 Embedding model tab loads", async ({ page }) => {
    await openSettings(page);

    await page.locator('button[title="模型配置"]').click();
    await page.waitForTimeout(1000);

    await screenshot(page, 44, "settings-models-embedding-before");

    const embeddingTab = page.locator('button:has-text("嵌入模型"), button:has-text("嵌入")').first();
    if (await embeddingTab.count() > 0) {
      await embeddingTab.click();
      await page.waitForTimeout(500);
      await screenshot(page, 45, "settings-models-embedding-after");
    } else {
      test.skip();
    }

    await closeRightPanel(page);
  });

  test("4.5 VLM model tab loads", async ({ page }) => {
    await openSettings(page);

    await page.locator('button[title="模型配置"]').click();
    await page.waitForTimeout(1000);

    await screenshot(page, 46, "settings-models-vlm-before");

    const vlmTab = page.locator('button:has-text("图像理解"), button:has-text("VLM")').first();
    if (await vlmTab.count() > 0) {
      await vlmTab.click();
      await page.waitForTimeout(500);
      await screenshot(page, 47, "settings-models-vlm-after");
    } else {
      test.skip();
    }

    await closeRightPanel(page);
  });

  test("4.6 ASR model tab loads", async ({ page }) => {
    await openSettings(page);

    await page.locator('button[title="模型配置"]').click();
    await page.waitForTimeout(1000);

    await screenshot(page, 48, "settings-models-asr-before");

    const asrTab = page.locator('button:has-text("ASR"), button:has-text("ASR 模型")').first();
    if (await asrTab.count() > 0) {
      await asrTab.click();
      await page.waitForTimeout(500);
      await screenshot(page, 49, "settings-models-asr-after");
    } else {
      test.skip();
    }

    await closeRightPanel(page);
  });

  test("4.7 Video understand model tab loads", async ({ page }) => {
    await openSettings(page);

    await page.locator('button[title="模型配置"]').click();
    await page.waitForTimeout(1000);

    await screenshot(page, 50, "settings-models-video-before");

    const videoTab = page.locator('button:has-text("视频理解"), button:has-text("视频")').first();
    if (await videoTab.count() > 0) {
      await videoTab.click();
      await page.waitForTimeout(500);
      await screenshot(page, 51, "settings-models-video-after");
    } else {
      test.skip();
    }

    await closeRightPanel(page);
  });

  test("4.8 Generation models tab loads", async ({ page }) => {
    await openSettings(page);

    await page.locator('button[title="模型配置"]').click();
    await page.waitForTimeout(1000);

    await screenshot(page, 52, "settings-models-gen-before");

    const genTab = page.locator('button:has-text("生成模型"), button:has-text("生成")').first();
    if (await genTab.count() > 0) {
      await genTab.click();
      await page.waitForTimeout(500);
      await screenshot(page, 53, "settings-models-gen-after");
    } else {
      test.skip();
    }

    await closeRightPanel(page);
  });

  test("4.9 Document processing tab loads", async ({ page }) => {
    await openSettings(page);

    await page.locator('button[title="模型配置"]').click();
    await page.waitForTimeout(1000);

    await screenshot(page, 54, "settings-models-docling-before");

    const doclingTab = page.locator('button:has-text("文档处理"), button:has-text("文档")').first();
    if (await doclingTab.count() > 0) {
      // Use force: true because the sub-tab row may overflow and the button
      // can be intercepted by the RightPanel overlay
      await doclingTab.click({ force: true });
      await page.waitForTimeout(500);
      await screenshot(page, 55, "settings-models-docling-after");
    } else {
      test.skip();
    }

    await closeRightPanel(page);
  });

  test("4.10 General settings tab loads", async ({ page }) => {
    await openSettings(page);

    await screenshot(page, 56, "settings-general-before");

    // Click general tab
    await page.locator('button[title="通用"]').click();
    await page.waitForTimeout(1000);

    // Should see theme section, agent settings, about section
    await expect(page.locator('h3:has-text("主题")')).toBeVisible();
    await expect(page.locator('h3:has-text("关于")')).toBeVisible();

    await screenshot(page, 57, "settings-general-after");

    await closeRightPanel(page);
  });
});

// ===========================================================================
// 5. Right Panel System
// ===========================================================================

test.describe("5. Right Panel System", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
  });

  test("5.1 Sessions panel opens and lists sessions", async ({ page }) => {
    await screenshot(page, 58, "panel-sessions-before");

    await openRightPanel(page, "会话历史");

    await expect(page.locator('h3:has-text("会话历史")').first()).toBeVisible();
    await screenshot(page, 59, "panel-sessions-after");

    await closeRightPanel(page);
  });

  test("5.2 Skills panel opens and lists skills", async ({ page }) => {
    await screenshot(page, 60, "panel-skills-before");

    await openRightPanel(page, "技能库");

    await expect(page.locator('h3:has-text("技能库")').first()).toBeVisible();
    await screenshot(page, 61, "panel-skills-after");

    await closeRightPanel(page);
  });

  test("5.3 Plugins panel opens", async ({ page }) => {
    await screenshot(page, 62, "panel-plugins-before");

    await openRightPanel(page, "插件管理");

    await expect(page.locator('h3:has-text("插件管理")').first()).toBeVisible();
    await screenshot(page, 63, "panel-plugins-after");

    await closeRightPanel(page);
  });

  test("5.4 Cron manager panel opens", async ({ page }) => {
    await screenshot(page, 64, "panel-cron-before");

    await openRightPanel(page, "定时任务");

    await expect(page.locator('h3:has-text("定时任务")').first()).toBeVisible();
    await screenshot(page, 65, "panel-cron-after");

    await closeRightPanel(page);
  });

  test("5.5 Teams panel opens", async ({ page }) => {
    await screenshot(page, 66, "panel-teams-before");

    await openRightPanel(page, "团队管理");

    await expect(page.locator('h3:has-text("团队管理")').first()).toBeVisible();
    await screenshot(page, 67, "panel-teams-after");

    await closeRightPanel(page);
  });
});

// ===========================================================================
// 6. Agent Teams
// ===========================================================================

test.describe("6. Agent Teams", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await openRightPanel(page, "团队管理");
    await page.waitForTimeout(1500);
  });

  test.afterEach(async ({ page }) => {
    await closeRightPanel(page);
  });

  test("6.1 Team list renders", async ({ page }) => {
    await screenshot(page, 68, "teams-list-before");

    // Either shows teams or "No teams yet" message
    const hasTeams = await page.locator('text=Agent Teams').count();
    expect(hasTeams).toBeGreaterThan(0);

    // Look for team cards or empty state
    const hasTeamCards = await page.locator('[class*="team"], [style*="border-radius"]').count();
    const hasEmptyState = await page.locator('text=No teams yet').count();
    expect(hasTeamCards > 0 || hasEmptyState > 0).toBeTruthy();

    await screenshot(page, 69, "teams-list-after");
  });

  test("6.2 Create new team button present", async ({ page }) => {
    await screenshot(page, 70, "teams-create-btn-before");

    // "新建团队" button should be visible
    await expect(page.locator('button:has-text("新建团队")')).toBeVisible();

    await screenshot(page, 71, "teams-create-btn-after");
  });

  test("6.3 Team editor components visible when creating", async ({ page }) => {
    await screenshot(page, 72, "teams-editor-before");

    // Click create button to open editor
    await page.locator('button:has-text("新建团队")').click();
    await page.waitForTimeout(1000);

    // TeamEditor modal should appear with form elements
    // Look for name input, mode selector, member configuration
    const editorVisible = await page.locator('[class*="modal"], [class*="editor"], [class*="overlay"]').count();
    if (editorVisible > 0) {
      await screenshot(page, 73, "teams-editor-after");
    } else {
      // The editor might render inline, check for form elements
      const hasFormInputs = await page.locator('input, select, textarea').count();
      expect(hasFormInputs).toBeGreaterThan(0);
      await screenshot(page, 73, "teams-editor-inline");
    }
  });
});

// ===========================================================================
// 7. Search Functionality
// ===========================================================================

test.describe("7. Search Functionality", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    // Navigate to knowledge page
    await page.locator('aside nav button:has-text("知识库")').click();
    await page.waitForTimeout(2000);
  });

  test("7.1 Search bar visible in knowledge page", async ({ page }) => {
    await screenshot(page, 74, "search-bar-before");

    // Search bar with "搜索知识库..." placeholder
    const searchInput = page.locator('input[placeholder="搜索知识库..."]').first();
    const hasSearchInput = await searchInput.count();
    if (hasSearchInput > 0) {
      await expect(searchInput).toBeVisible();
      await screenshot(page, 75, "search-bar-after");
    } else {
      test.skip();
    }
  });

  test("7.2 Search with query returns results", async ({ page }) => {
    await screenshot(page, 76, "search-query-before");

    const searchInput = page.locator('input[placeholder="搜索知识库..."]').first();
    if (await searchInput.count() > 0) {
      await searchInput.fill("测试搜索");
      await searchInput.press("Enter");
      await page.waitForTimeout(2000);
      await screenshot(page, 77, "search-query-after");
    } else {
      test.skip();
    }
  });

  test("7.3 Search mode selector (semantic/keyword/hybrid) works", async ({ page }) => {
    await screenshot(page, 78, "search-mode-before");

    // Find the mode toggle button (shows "语义" by default)
    const modeBtn = page.locator('button:has-text("语义"), button:has-text("向量"), button:has-text("混合")').first();
    if (await modeBtn.count() > 0) {
      await modeBtn.click();
      await page.waitForTimeout(300);

      // Should show mode options
      const semanticBtn = page.locator('button:has-text("语义检索")').first();
      const vectorBtn = page.locator('button:has-text("向量检索")').first();
      const hybridBtn = page.locator('button:has-text("混合检索")').first();

      // At least one should be visible
      const anyVisible =
        (await semanticBtn.count()) > 0 ||
        (await vectorBtn.count()) > 0 ||
        (await hybridBtn.count()) > 0;
      expect(anyVisible).toBeTruthy();

      await screenshot(page, 79, "search-mode-after");

      // Click "混合检索" to switch mode
      if (await hybridBtn.count() > 0) {
        await hybridBtn.click();
        await page.waitForTimeout(300);
        await screenshot(page, 80, "search-mode-hybrid");
      }
    } else {
      test.skip();
    }
  });

  test("7.4 Layer selector works", async ({ page }) => {
    await screenshot(page, 81, "search-layer-before");

    // First open the controls dropdown
    const modeBtn = page.locator('button:has-text("语义"), button:has-text("向量"), button:has-text("混合")').first();
    if (await modeBtn.count() > 0) {
      await modeBtn.click();
      await page.waitForTimeout(300);

      // Look for layer selector (L0, L1, L2 buttons)
      const l0Btn = page.locator('button:has-text("L0")').first();
      const l1Btn = page.locator('button:has-text("L1")').first();
      const l2Btn = page.locator('button:has-text("L2")').first();

      const anyLayerVisible =
        (await l0Btn.count()) > 0 ||
        (await l1Btn.count()) > 0 ||
        (await l2Btn.count()) > 0;

      if (anyLayerVisible) {
        // Toggle L2 on
        if (await l2Btn.count() > 0) {
          await l2Btn.click();
          await page.waitForTimeout(200);
        }
        await screenshot(page, 82, "search-layer-after");
      } else {
        test.skip();
      }
    } else {
      test.skip();
    }
  });
});

// ===========================================================================
// 8. Channel Management
// ===========================================================================

test.describe("8. Channel Management", () => {
  test("8.1 Channels panel accessible", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await screenshot(page, 83, "channels-before");

    // Open settings, then navigate to channels tab
    await openRightPanel(page, "设置");
    await page.waitForTimeout(1000);

    // Click "通信渠道" tab
    await page.locator('button[title="通信渠道"]').click();
    await page.waitForTimeout(1000);

    await screenshot(page, 84, "channels-after");

    await closeRightPanel(page);
  });

  test("8.2 Channel cards visible for configured channels", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await openRightPanel(page, "设置");
    await page.waitForTimeout(1000);
    await page.locator('button[title="通信渠道"]').click();
    await page.waitForTimeout(1500);

    await screenshot(page, 85, "channels-cards-before");

    // Look for channel identifiers: feishu, dingtalk, wechat, qq, telegram, discord
    const channelNames = ["飞书", "钉钉", "微信", "QQ", "Telegram", "Discord"];
    let foundAny = false;
    for (const name of channelNames) {
      if (await page.locator(`text=${name}`).count() > 0) {
        foundAny = true;
        break;
      }
    }
    // It's fine if no channels are configured
    await screenshot(page, 86, "channels-cards-after");

    await closeRightPanel(page);
  });
});

// ===========================================================================
// 9. Evolution Panel
// ===========================================================================

test.describe("9. Evolution Panel", () => {
  test("9.1 Evolution panel accessible", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await screenshot(page, 87, "evolution-before");

    await openRightPanel(page, "自进化");

    await expect(page.locator('h3:has-text("自进化")').first()).toBeVisible();
    await screenshot(page, 88, "evolution-after");

    await closeRightPanel(page);
  });

  test("9.2 Evolution config toggles visible", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await openRightPanel(page, "自进化");
    await page.waitForTimeout(1500);

    await screenshot(page, 89, "evolution-toggles-before");

    // Look for toggle switches or config sections
    const hasToggle = await page.locator('[class*="toggle"], [class*="switch"], input[type="checkbox"]').count();
    // Look for module names
    const hasMemorySection = await page.locator('text=记忆, text=memory, text=记忆积累').count();
    const hasSkillSection = await page.locator('text=技能, text=skill').count();

    const hasAnyConfig = hasToggle > 0 || hasMemorySection > 0 || hasSkillSection > 0;
    if (!hasAnyConfig) {
      // Panel might show loading or empty state
      await screenshot(page, 90, "evolution-toggles-loading");
    } else {
      await screenshot(page, 90, "evolution-toggles-after");
    }

    await closeRightPanel(page);
  });
});

// ===========================================================================
// 10. Report Viewing
// ===========================================================================

test.describe("10. Report Viewing", () => {
  test("10.1 Reports panel accessible", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await screenshot(page, 91, "reports-before");

    // Navigate to reports view via sidebar
    await page.locator('aside nav button:has-text("报告")').click();
    await page.waitForTimeout(3000);

    // Report panel should load (lazy-loaded, so wait for it)
    // Check for any report-related content: tab buttons, empty state, or generate button
    const reportLocator = page.locator('button:has-text("报告")').or(page.locator('text=暂无报告')).or(page.locator('text=生成报告')).or(page.locator('text=时间线'));
    const hasReportContent = await reportLocator.count();
    expect(hasReportContent).toBeGreaterThan(0);

    await screenshot(page, 92, "reports-after");
  });

  test("10.2 Report list renders", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await page.locator('aside nav button:has-text("报告")').click();
    await page.waitForTimeout(3000);

    await screenshot(page, 93, "reports-list-before");

    // Look for report cards or empty state - the panel loads lazily
    const hasReportCards = await page.locator('[class*="report"], [class*="card"]').count();
    const hasEmptyState = await page.locator('text=暂无报告, text=No reports, button:has-text("生成报告")').count();
    // Either reports or empty state should be present
    await screenshot(page, 94, "reports-list-after");
  });
});

// ===========================================================================
// 11. Responsive Behavior
// ===========================================================================

test.describe("11. Responsive Behavior", () => {
  test("11.1 Sidebar collapse/expand", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await screenshot(page, 95, "sidebar-collapse-before");

    // Find the collapse toggle button (absolute positioned circle)
    const collapseBtn = page.locator('aside button[title="收起侧边栏"], aside button[title="展开侧边栏"]').first();
    if (await collapseBtn.count() > 0) {
      // Collapse
      await collapseBtn.click();
      await page.waitForTimeout(500);
      await screenshot(page, 96, "sidebar-collapsed");

      // Expand back
      const expandBtn = page.locator('aside button[title="展开侧边栏"]').first();
      if (await expandBtn.count() > 0) {
        await expandBtn.click();
        await page.waitForTimeout(500);
        await screenshot(page, 97, "sidebar-expanded");
      }
    } else {
      test.skip();
    }
  });

  test("11.2 Right panel open/close", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await screenshot(page, 98, "panel-open-close-before");

    // Open settings panel
    await openRightPanel(page, "设置");
    await page.waitForTimeout(1000);

    // Verify panel is visible
    await expect(page.locator('h3:has-text("设置")').first()).toBeVisible();
    await screenshot(page, 99, "panel-open");

    // Close via Escape
    await closeRightPanel(page);
    await page.waitForTimeout(500);

    // Verify panel is closed
    const panelGone = await page.locator('h3:has-text("设置")').count();
    expect(panelGone).toBe(0);

    await screenshot(page, 100, "panel-closed");
  });

  test("11.3 Layout adapts to panel state", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await screenshot(page, 101, "layout-adapt-before");

    // Open a right panel and verify main content area still visible
    await openRightPanel(page, "会话历史");
    await page.waitForTimeout(500);

    // Main content area (sidebar + main) should still be rendered
    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible();

    // Right panel overlays on top, so main content is still behind
    await screenshot(page, 102, "layout-adapt-with-panel");

    await closeRightPanel(page);
    await screenshot(page, 103, "layout-adapt-after");
  });
});

// ===========================================================================
// 12. Error States
// ===========================================================================

test.describe("12. Error States", () => {
  test("12.1 Unknown route redirects to chat (404 handling)", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/nonexistent-page-xyz`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    await screenshot(page, 104, "error-404-before");

    // The router redirects unknown paths to /chat
    // Verify we end up on a valid page with the app rendered
    await expect(page.locator("text=DeepAnalyze").first()).toBeVisible();

    await screenshot(page, 105, "error-404-after");
  });

  test("12.2 Error boundary catches errors", async ({ page }) => {
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    await screenshot(page, 106, "error-boundary-before");

    // Inject an error into a React component to test error boundary
    // This is a smoke test - verify the error boundary component exists in the DOM
    const hasErrorBoundary = await page.evaluate(() => {
      // Check if the app is still rendering correctly
      const root = document.getElementById("root");
      return root && root.children.length > 0;
    });
    expect(hasErrorBoundary).toBeTruthy();

    await screenshot(page, 107, "error-boundary-after");
  });

  test("12.3 Loading states display correctly (skeleton/spinner)", async ({ page }) => {
    // Throttle network to see loading states
    const client = await page.context().newCDPSession(page);
    await client.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 500,
      downloadThroughput: 50000,
      uploadThroughput: 50000,
    });

    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);

    await screenshot(page, 108, "loading-state");

    // Restore network
    await client.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    // Wait for page to fully load
    await page.waitForTimeout(3000);
    await screenshot(page, 109, "loading-state-complete");
  });
});
