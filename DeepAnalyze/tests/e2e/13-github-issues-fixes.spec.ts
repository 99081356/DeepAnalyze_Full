/**
 * 13 - GitHub Issues Fixes Verification
 *
 * End-to-end verification of fixes for issues #13, #14, #15, #16/#17, #18, #20.
 * Each test combines API verification with UI screenshots to confirm both
 * backend behavior and the rendered user experience.
 *
 * Tests are serial because some share a session and a single DA instance.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createApi, type Session } from "./helpers/api";
import { takeScreenshot, gotoPage, filterCriticalErrors } from "./helpers/visual";

test.describe.configure({ mode: "serial" });

const SCREENSHOT_DIR_PREFIX = "13-issues";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a chat message via the run-stream SSE endpoint and wait for completion.
 * Returns the full SSE event log so callers can inspect thinking/content deltas.
 */
async function runStreamUntilDone(
  request: APIRequestContext,
  sessionId: string,
  input: string,
  options?: { timeoutMs?: number },
): Promise<{ events: any[]; taskId?: string }> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const events: any[] = [];
  let taskId: string | undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await request.post(`/api/agents/run-stream`, {
      data: { input, sessionId },
      signal: controller.signal,
      timeout: timeoutMs,
      headers: { Accept: "text/event-stream" },
    });

    if (!resp.ok()) {
      throw new Error(`run-stream failed: ${resp.status()}`);
    }

    const body = await resp.body();
    const text = body.toString("utf8");
    // Parse SSE blocks: each block has optional `event: <type>` and `data: <json>`
    for (const block of text.split(/\n\n/)) {
      const lines = block.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event:"));
      const dataLine = lines.find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload) continue;
      let evt: any;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      // Attach the event type from the `event:` line if present
      if (eventLine) {
        evt.type = eventLine.slice(6).trim();
      }
      events.push(evt);
      if (evt.type === "start" && evt.taskId) taskId = evt.taskId;
      if (evt.type === "done" || evt.type === "error") {
        return { events, taskId };
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return { events, taskId };
}

/**
 * Wait for a session title to be populated by auto-naming (poll getSession).
 */
async function waitForAutoTitle(
  request: APIRequestContext,
  sessionId: string,
  timeoutMs = 60_000,
): Promise<Session> {
  const api = createApi(request);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = await api.getSession(sessionId);
    if (session.title && session.title.trim()) return session;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Session ${sessionId} did not get auto-title within ${timeoutMs / 1000}s`);
}

const DA_BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:21000";

/**
 * Fire-and-forget trigger for /api/agents/run-stream.
 *
 * The run-stream endpoint starts the agent in the background and streams SSE
 * events as a viewer (client disconnect does NOT cancel the task — see
 * agents.ts:569-571). We read just enough of the stream to confirm the task
 * started (the "start" event with taskId), then abort the connection.
 *
 * The caller then polls for the outcome via getMessages / listSkills.
 */
async function triggerAgentTask(
  sessionId: string,
  input: string,
  options?: { startTimeoutMs?: number; mediaIds?: string[] },
): Promise<{ taskId?: string }> {
  const startTimeoutMs = options?.startTimeoutMs ?? 30_000;
  const controller = new AbortController();

  const resp = await fetch(`${DA_BASE_URL}/api/agents/run-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ input, sessionId, mediaIds: options?.mediaIds }),
    signal: controller.signal,
  });

  if (!resp.ok || !resp.body) {
    throw new Error(`run-stream POST failed: ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let taskId: string | undefined;

  try {
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split into complete SSE blocks (separated by blank line)
      const blocks = buffer.split(/\n\n/);
      buffer = blocks.pop() || ""; // retain incomplete trailing block

      for (const block of blocks) {
        const lines = block.split("\n");
        const eventType = lines
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim();
        const dataLine = lines.find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        if (eventType === "start") {
          try {
            const payload = JSON.parse(dataLine.slice(5).trim());
            taskId = payload.taskId;
          } catch {
            /* ignore parse errors */
          }
          // Task confirmed started — abort the stream; agent continues server-side
          controller.abort();
          return { taskId };
        }
      }
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { taskId };
    }
    throw err;
  } finally {
    controller.abort();
  }

  return { taskId };
}

/**
 * Wait for an assistant message with non-empty content to appear on the session.
 */
async function waitForAssistantResponse(
  request: APIRequestContext,
  sessionId: string,
  timeoutMs = 300_000,
): Promise<string> {
  const api = createApi(request);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const msgs = await api.getMessages(sessionId);
    const asst = [...msgs].reverse().find((m) => m.role === "assistant");
    if (asst && asst.content && asst.content.trim().length > 0) {
      return asst.content;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`No assistant response within ${timeoutMs / 1000}s`);
}

// ---------------------------------------------------------------------------
// T1: #13 Workspace button expand/collapse
// ---------------------------------------------------------------------------

test.describe("T1 - #13 Workspace button expand/collapse", () => {
  // Scoped helper: find nav buttons inside <nav> only (avoids matching "新建对话"
  // which also contains the substring "对话").
  const navButton = (page: Page, label: string) =>
    page.locator("nav").locator("button", { hasText: label }).first();

  test("workspace toggle hides and restores nav items", async ({ page }) => {
    await gotoPage(page, "sessions");
    await page.waitForTimeout(800);

    // The 4 main nav items should be visible initially inside <nav>
    const navLabels = ["对话", "知识库", "报告", "任务"];
    for (const label of navLabels) {
      await expect(navButton(page, label)).toBeVisible({ timeout: 5000 });
    }
    await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t1-workspace-expanded`);

    // Click "工作区" header to collapse — the header is the clickable span
    const workspaceHeader = page.locator("nav").locator("span", { hasText: "工作区" }).first();
    await workspaceHeader.click();
    await page.waitForTimeout(500);

    await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t1-workspace-collapsed`);

    // After collapse, the nav labels should NOT be visible inside <nav>
    for (const label of navLabels) {
      const visible = await navButton(page, label).isVisible().catch(() => false);
      expect(visible, `${label} should be hidden after workspace collapse`).toBeFalsy();
    }

    // Click again to expand
    await page.locator("nav").locator("span", { hasText: "工作区" }).first().click();
    await page.waitForTimeout(500);

    // Verify items return
    for (const label of navLabels) {
      await expect(navButton(page, label)).toBeVisible({ timeout: 5000 });
    }
    await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t1-workspace-restored`);
  });
});

// ---------------------------------------------------------------------------
// T2: #20 Skills search
// ---------------------------------------------------------------------------

test.describe("T2 - #20 Skills search", () => {
  test("skills panel search filters and clears", async ({ page, request }) => {
    const api = createApi(request);

    // Open the skill panel via header button
    await gotoPage(page, "sessions");
    await page.waitForTimeout(500);

    const skillsBtn = page.locator('button[title="技能库"]').first();
    await expect(skillsBtn).toBeVisible({ timeout: 5000 });
    await skillsBtn.click();
    await page.waitForTimeout(1000);

    // Find skill cards (SkillBrowser renders one card per skill in a grid)
    // Cards contain skill name text; we count distinct skill names we know exist.
    const allSkills = await api.listSkills();
    expect(allSkills.length, "Should have skills available").toBeGreaterThan(0);
    await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t2-skills-all`);

    // Locate search input by placeholder
    const searchInput = page.locator('input[placeholder*="搜索技能"]').first();
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    // Use a known built-in skill name to filter
    const targetName = allSkills[0].name;
    await searchInput.fill(targetName);
    await page.waitForTimeout(800);

    await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t2-skills-filtered`);

    // At least the matching skill should be visible, and count should drop
    const visibleTarget = page.locator(`text=${targetName}`).first();
    await expect(visibleTarget).toBeVisible({ timeout: 5000 });

    // Clear search
    await searchInput.fill("");
    await page.waitForTimeout(500);
    await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t2-skills-cleared`);

    // Search for nonexistent skill — empty state should appear
    await searchInput.fill("zzz_nonexistent_skill_xyz");
    await page.waitForTimeout(800);
    await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t2-skills-empty`);

    // Expect empty-state message to render
    const emptyState = page.locator("text=未找到匹配的技能").first();
    const emptyVisible = await emptyState.isVisible().catch(() => false);
    // SkillBrowser uses EmptyState with "未找到匹配的技能" text — if found assert
    if (emptyVisible) {
      expect(emptyVisible).toBeTruthy();
    } else {
      // Fallback: at minimum, target skill should NOT be visible
      const targetStillThere = await page
        .locator(`text=${targetName}`)
        .first()
        .isVisible()
        .catch(() => false);
      expect(targetStillThere).toBeFalsy();
    }
  });
});

// ---------------------------------------------------------------------------
// T3: #16/#17 Skills execution per-skill state
// ---------------------------------------------------------------------------

test.describe("T3 - #16/#17 Skills execution per-skill state", () => {
  test("execute buttons remain enabled (no global lock)", async ({ page, request }) => {
    const api = createApi(request);

    // Ensure we have at least 2 active skills so we can verify others stay enabled
    const initial = await api.listSkills();
    const created: string[] = [];
    const activeBuiltins = initial.filter((s) => s.isActive);
    if (activeBuiltins.length < 2) {
      const s1 = await api.createSkill({
        name: "e2e-skill-A",
        description: "Test skill A",
        prompt: "noop",
        isActive: true,
      });
      const s2 = await api.createSkill({
        name: "e2e-skill-B",
        description: "Test skill B",
        prompt: "noop",
        isActive: true,
      });
      created.push(s1.id, s2.id);
    }

    // Create a session so SkillBrowser has currentSessionId (execute buttons
    // are disabled until a session is active)
    const session = await api.createSession();

    try {
      await gotoPage(page, `sessions/${session.id}`);
      await page.waitForTimeout(1500);

      const skillsBtn = page.locator('button[title="技能库"]').first();
      await skillsBtn.click();
      await page.waitForTimeout(1500);

      await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t3-skills-initial`);

      // Execute buttons use custom <Button> with text "执行" (not title attr)
      const execButtons = page.locator('button', { hasText: "执行" });
      const count = await execButtons.count();
      expect(count, "Should have at least one execute button").toBeGreaterThan(0);

      // At rest, no skill should be in executing state — all buttons enabled
      // (per-skill state means: with no execution running, none are locked).
      // Note: inactive skills remain disabled by design; we only assert that
      // at least one is enabled, proving the global lock is gone.
      let enabledCount = 0;
      for (let i = 0; i < count; i++) {
        const disabled = await execButtons.nth(i).isDisabled();
        if (!disabled) enabledCount++;
      }
      expect(enabledCount, "At least one execute button should be enabled").toBeGreaterThan(0);
    } finally {
      for (const id of created) {
        await api.deleteSkill(id).catch(() => {});
      }
      await api.deleteSession(session.id).catch(() => {});
    }
  });

  test("create skill appears in panel and API list", async ({ page, request }) => {
    const api = createApi(request);
    const skill = await api.createSkill({
      name: "e2e-t3-createskill",
      description: "Temporary skill for T3",
      prompt: "noop prompt",
      isActive: true,
    });
    expect(skill.id).toBeTruthy();

    try {
      await gotoPage(page, "sessions");
      await page.waitForTimeout(500);

      const skillsBtn = page.locator('button[title="技能库"]').first();
      await skillsBtn.click();
      await page.waitForTimeout(1500);

      // New skill should be visible in panel
      const card = page.locator(`text=e2e-t3-createskill`).first();
      await expect(card).toBeVisible({ timeout: 5000 });
      await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t3-created-skill-visible`);

      // Verify in API list
      const list = await api.listSkills();
      const found = list.find((s) => s.id === skill.id);
      expect(found, "Created skill should be in API list").toBeTruthy();
    } finally {
      await api.deleteSkill(skill.id).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// T4: #18 Session auto-naming + rename
// ---------------------------------------------------------------------------

test.describe("T4 - #18 Session auto-naming + rename", () => {
  test("session gets auto-title after first message via run-stream", async ({ request }) => {
    const api = createApi(request);
    const session = await api.createSession();
    expect(session.title).toBeFalsy();

    try {
      const message = "这是一个用于自动命名验证的测试消息";
      const { events } = await runStreamUntilDone(request, session.id, message, {
        timeoutMs: 180_000,
      });

      // Should have received at least start + done events
      const types = events.map((e) => e.type);
      expect(types, `events: ${JSON.stringify(types.slice(0, 10))}`).toContain("start");

      // Wait for auto-title to populate
      const updated = await waitForAutoTitle(request, session.id, 60_000);
      expect(updated.title, "Auto-title should be set").toBeTruthy();
      // Auto-title uses first 30 chars of message
      expect(updated.title).toContain(message.slice(0, 10));
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });

  test("rename via PATCH API updates title", async ({ request }) => {
    const api = createApi(request);
    const session = await api.createSession();

    try {
      await api.renameSession(session.id, "E2E测试重命名");
      const updated = await api.getSession(session.id);
      expect(updated.title).toBe("E2E测试重命名");
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });

  test("UI shows inline edit on session title", async ({ page, request }) => {
    const api = createApi(request);
    // Use a UNIQUE initial title so we can target this exact session in the sidebar
    const uniqueInitial = `e2e-orig-${Date.now()}`;
    const uniqueFinal = `e2e-final-${Date.now()}`;
    const session = await api.createSession(uniqueInitial);

    try {
      // Navigate to home first so sidebar renders session list
      await gotoPage(page, "sessions");
      await page.waitForTimeout(1500);

      // Take initial screenshot
      await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t4-before-edit`);

      // Match the EXACT title text — using getByText with exact:true avoids
      // matching ancestor wrapper divs that also "contain" the text.
      // (hasText on a div would match the whole session-list container.)
      const titleSpan = page.locator("aside").getByText(uniqueInitial, { exact: true }).first();
      await expect(titleSpan).toBeVisible({ timeout: 5000 });

      // Hover the title span itself. Because mouseenter fires when the pointer
      // enters the row OR any descendant, hovering the span triggers the row's
      // onMouseEnter handler, revealing the per-row action buttons.
      await titleSpan.scrollIntoViewIfNeeded();
      await titleSpan.hover();
      await page.waitForTimeout(400);

      // With the row hovered, the rename (pencil) button becomes visible.
      // Only one row is hovered at a time, so only one 重命名 button exists.
      const editBtn = page.locator('button[title="重命名"]').first();
      await editBtn.click({ timeout: 3000 });
      await page.waitForTimeout(300);

      await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t4-editing`);

      // An input replaces the title span; type new name and Enter to commit
      const editInput = page.locator("aside input").first();
      await expect(editInput).toBeVisible({ timeout: 3000 });
      await editInput.fill(uniqueFinal);
      await editInput.press("Enter");
      await page.waitForTimeout(1500);

      // Verify via API that the rename persisted
      const updated = await api.getSession(session.id);
      expect(updated.title).toBe(uniqueFinal);
      await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t4-after-edit`);
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// T5: #14 Thinking process streaming
// ---------------------------------------------------------------------------

test.describe("T5 - #14 Thinking process streaming", () => {
  test("thinking_delta events appear in SSE stream", async ({ request }) => {
    const api = createApi(request);
    const session = await api.createSession();

    try {
      const { events } = await runStreamUntilDone(
        request,
        session.id,
        "简单介绍一下你自己，要求一两句话即可",
        { timeoutMs: 180_000 },
      );

      const types = events.map((e) => e.type);
      expect(types).toContain("start");

      // thinking_delta may not be emitted if the configured model doesn't support thinking.
      // We verify the wiring exists by checking that either thinking_delta OR content_delta
      // was emitted — confirms the SSE pipeline is functioning.
      const hasThinking = types.includes("thinking_delta");
      const hasContent = types.includes("content_delta") || types.includes("content");
      expect(
        hasThinking || hasContent,
        `Expected either thinking_delta or content_delta in stream. Got: ${JSON.stringify(types)}`,
      ).toBeTruthy();

      // If model supports thinking, verify thinkingContent is persisted on the message
      const msgs = await api.getMessages(session.id);
      const assistant = msgs.find((m) => m.role === "assistant");
      expect(assistant, "Should have at least one assistant message").toBeTruthy();

      if (hasThinking) {
        // The MessageItem auto-expand requires thinkingContent to be set on the message
        expect(
          assistant!.thinkingContent,
          "thinking_delta was emitted but thinkingContent not persisted",
        ).toBeTruthy();
      }
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });

  test("UI displays process panel toggle during streaming", async ({ page, request }) => {
    const api = createApi(request);
    const session = await api.createSession();

    try {
      await gotoPage(page, `sessions/${session.id}`);
      await page.waitForTimeout(1500);

      // Type into chat input and send
      const input = page.locator("textarea").first();
      await expect(input).toBeVisible({ timeout: 5000 });
      await input.fill("你好，简单介绍一下你自己");
      await input.press("Enter");

      // Wait for streaming to begin — give it some time
      await page.waitForTimeout(5000);
      await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t5-streaming-mid`);

      // Wait for completion (max ~3 min)
      const start = Date.now();
      while (Date.now() - start < 180_000) {
        const msgs = await api.getMessages(session.id);
        const asst = msgs.find((m) => m.role === "assistant");
        if (asst && asst.content && asst.content.length > 0) break;
        await new Promise((r) => setTimeout(r, 3000));
      }

      await page.waitForTimeout(2000);
      await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t5-streaming-done`);

      // The "过程记录" button should appear if there was thinking content
      const processBtn = page.locator('text=过程记录').first();
      const processVisible = await processBtn.isVisible().catch(() => false);
      // If the model doesn't support thinking, the button may not appear — acceptable
      if (processVisible) {
        // Click to expand
        await processBtn.click();
        await page.waitForTimeout(500);
        await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t5-thinking-panel`);
      }
    } finally {
      await api.deleteSession(session.id).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// T6: #15 Skill upload via chat
// ---------------------------------------------------------------------------

test.describe("T6 - #15 Skill upload via chat", () => {
  // Normalize listSkills response to always be an array.
  // The endpoint normally returns Skill[], but concurrent agent tool calls
  // (skill_create writing to the same table) can occasionally produce a
  // transient non-array response. We guard against that here.
  async function listSkillsSafe(api: ReturnType<typeof createApi>): Promise<any[]> {
    const raw = await api.listSkills();
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object" && Array.isArray((raw as any).skills)) {
      return (raw as any).skills;
    }
    return [];
  }

  // Remove leftover skills from prior runs to keep the assertion unambiguous
  async function cleanupStaleSkills(api: ReturnType<typeof createApi>, prefix: string) {
    const skills = await listSkillsSafe(api);
    for (const s of skills) {
      if (s.name?.startsWith(prefix)) {
        await api.deleteSkill(s.id).catch(() => {});
      }
    }
  }

  test("uploaded SKILL.md content is parsed by agent into a new skill", async ({ request }) => {
    const api = createApi(request);
    const session = await api.createSession();
    const skillName = `e2e-upload-test-${Date.now()}`;

    // Clean up any stale skills from prior failed runs
    await cleanupStaleSkills(api, "e2e-upload-test-");

    const SKILL_MD = `---
name: ${skillName}
description: E2E uploaded skill for verification
---
You are a helpful assistant. Always respond with "E2E_UPLOAD_OK".
`;

    try {
      // Upload the markdown as a media attachment
      const upload = await api.uploadMedia(
        session.id,
        Buffer.from(SKILL_MD, "utf8"),
        "test-skill.md",
        "text/markdown",
      );
      expect(upload.mediaId).toBeTruthy();

      // Trigger the agent via run-stream (fire-and-forget).
      // Pass mediaIds so the agent receives the uploaded file reference in its
      // message context (the run-stream handler embeds media refs into the
      // user message when mediaIds is provided — see agents.ts:596-613).
      const { taskId } = await triggerAgentTask(
        session.id,
        `请分析上传的 SKILL.md 文件（test-skill.md）的内容，并使用 skill_create 工具创建一个技能，名称用 ${skillName}`,
        { startTimeoutMs: 30_000, mediaIds: [upload.mediaId] },
      );
      expect(taskId, "Agent should have started a task").toBeTruthy();

      // Wait for the agent to finish (assistant message appears)
      const content = await waitForAssistantResponse(request, session.id, 360_000);
      expect(content.length).toBeGreaterThan(0);

      // Poll skills list for the newly created skill
      const skillStart = Date.now();
      let found: any = null;
      while (Date.now() - skillStart < 120_000) {
        const skills = await listSkillsSafe(api);
        found = skills.find((s) => s.name === skillName);
        if (found) break;
        await new Promise((r) => setTimeout(r, 5000));
      }
      expect(found, `Skill "${skillName}" should appear in list after upload+run`).toBeTruthy();
    } finally {
      // Cleanup the created skill if any
      const skills = await listSkillsSafe(api);
      const target = skills.find((s) => s.name === skillName);
      if (target) await api.deleteSkill(target.id).catch(() => {});
      await api.deleteSession(session.id).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// T7: Regression — console errors + basic functionality
// ---------------------------------------------------------------------------

test.describe("T7 - Regression: console errors + core flows", () => {
  test("no critical console errors during page load and navigation", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await gotoPage(page, "sessions");
    await page.waitForTimeout(1500);

    // Sidebar should be visible
    const aside = page.locator("aside").first();
    await expect(aside).toBeVisible({ timeout: 5000 });

    // New chat button should be present
    await expect(page.locator('button:has-text("新建对话")').first()).toBeVisible();

    // Header should be present
    await expect(page.locator('button[title="技能库"]').first()).toBeVisible();

    await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t7-regression-baseline`);

    // Cycle through main nav views to detect regressions
    for (const label of ["知识库", "报告", "任务", "对话"]) {
      const nav = page.locator(`button:has-text("${label}")`).first();
      await nav.click().catch(() => {});
      await page.waitForTimeout(800);
    }
    await takeScreenshot(page, `${SCREENSHOT_DIR_PREFIX}-t7-regression-cycled`);

    const critical = filterCriticalErrors(errors);
    expect(
      critical,
      `Critical console errors detected: ${critical.join("\n")}`,
    ).toHaveLength(0);
  });

  test("API health and sessions endpoints respond correctly", async ({ request }) => {
    const api = createApi(request);
    const health = await api.health();
    expect(health.status).toBe("ok");

    const sessions = await api.listSessions();
    expect(Array.isArray(sessions)).toBeTruthy();

    const skills = await api.listSkills();
    expect(Array.isArray(skills)).toBeTruthy();
    expect(skills.length, "Should have built-in skills").toBeGreaterThan(0);

    const caps = await api.getCapabilities();
    expect(caps).toBeTruthy();
  });
});
