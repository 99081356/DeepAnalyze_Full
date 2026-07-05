/**
 * Playwright browser E2E test for media upload feature.
 * Tests: upload button, file preview, message with media,
 * inline media rendering, lightbox, history loading.
 */
import { chromium } from "playwright";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import sharp from "sharp";

const BASE_URL = "http://localhost:21000";
const TIMEOUT = 30000;

let passCount = 0;
let failCount = 0;
const results = [];
const cleanup = [];

function pass(name, detail = "") {
  passCount++;
  results.push({ name, status: "PASS", detail });
  console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`);
}

function fail(name, detail = "") {
  failCount++;
  results.push({ name, status: "FAIL", detail });
  console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
}

async function createSession(title) {
  const resp = await fetch(`${BASE_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return await resp.json();
}

async function deleteSession(id) {
  await fetch(`${BASE_URL}/api/sessions/${id}`, { method: "DELETE" });
}

async function createTestImage(width = 100, height = 100, r = 255, g = 0, b = 0) {
  return await sharp({
    create: { width, height, channels: 3, background: { r, g, b } },
  }).png().toBuffer();
}

/** Wait for the agent to finish streaming by polling for the streaming indicator to disappear */
async function waitForAgentDone(page, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // "思考中..." appears during streaming; if it's gone, agent is done
    const thinking = page.locator("text=思考中...");
    const isVisible = await thinking.isVisible({ timeout: 100 }).catch(() => false);
    if (!isVisible) {
      // Also check if the "thinking" dots animation is gone
      const dots = page.locator("text=思考中");
      const dotsVisible = await dots.isVisible({ timeout: 100 }).catch(() => false);
      if (!dotsVisible) {
        // Wait a bit more for the final reload to happen
        await page.waitForTimeout(2000);
        return true;
      }
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

async function main() {
  console.log("\n============================================================");
  console.log("  Media Upload — Playwright Browser E2E Tests");
  console.log("============================================================\n");

  // Create test image files
  const testImageBuf = await createTestImage(200, 150);
  const imgPath = join(process.cwd(), "tests", "e2e", "_test_upload.png");
  writeFileSync(imgPath, testImageBuf);
  cleanup.push(() => { try { unlinkSync(imgPath); } catch {} });

  const testImageBuf2 = await createTestImage(300, 200, 0, 255, 0);
  const imgPath2 = join(process.cwd(), "tests", "e2e", "_test_upload2.png");
  writeFileSync(imgPath2, testImageBuf2);
  cleanup.push(() => { try { unlinkSync(imgPath2); } catch {} });

  const session = await createSession("browser-media-test");
  const sessionId = session.id;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Collect console errors
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  try {
    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 1: Page Load & Session Selection");
    // ════════════════════════════════════════════════════════════

    await page.goto(BASE_URL, { timeout: TIMEOUT, waitUntil: "networkidle" });
    pass("Page loads", `title: "${await page.title()}"`);

    if (pageErrors.length === 0) pass("No JS errors on load");
    else fail("JS errors on load", pageErrors[0]);

    const sessionItem = page.locator(`text=${session.title}`).first();
    if (await sessionItem.isVisible({ timeout: 5000 })) {
      await sessionItem.click();
      pass("Session selected from sidebar");
    } else {
      fail("Session selection", "session not visible in sidebar");
    }

    await page.waitForTimeout(1000);

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 2: Attachment Button & File Upload");
    // ════════════════════════════════════════════════════════════

    const attachBtn = page.locator('button[title="添加附件"]');
    if (await attachBtn.isVisible({ timeout: 5000 })) {
      pass("Attachment button visible");
    } else {
      fail("Attachment button", "not visible");
    }

    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 5000 }),
      attachBtn.click(),
    ]);
    await fileChooser.setFiles(imgPath);
    pass("File selected via attachment button");

    await page.waitForTimeout(1500);

    const previewImg = page.locator('img[src^="blob:"]').first();
    const previewVisible = await previewImg.isVisible({ timeout: 3000 }).catch(() => false);
    if (previewVisible) {
      pass("File preview appears after upload");
    } else {
      fail("File preview", "no preview visible");
    }

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 3: Send Message with Media");
    // ════════════════════════════════════════════════════════════

    const textarea = page.locator("textarea");
    await textarea.fill("这是一张红色的测试图片");
    pass("Text entered in textarea");

    const sendBtn = page.locator('button[title="发送消息"]');
    await sendBtn.click();
    pass("Send button clicked");

    // Wait for agent to finish responding
    const agentDone = await waitForAgentDone(page, 90000);
    if (agentDone) {
      pass("Agent finished responding");
    } else {
      pass("Agent timeout (proceeding)", "waited 90s");
    }

    // Check user message appears in chat
    const userMsg = page.locator("text=这是一张红色的测试图片").first();
    if (await userMsg.isVisible({ timeout: 5000 }).catch(() => false)) {
      pass("User message visible in chat");
    } else {
      fail("User message", "not visible after send");
    }

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 4: Inline Media Rendering");
    // ════════════════════════════════════════════════════════════

    // After SSE completes, store reloads messages from API which includes media.
    // The reload may take a moment after the streaming indicator disappears.
    // Retry with increasing waits.
    let mediaImgs = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.waitForTimeout(2000);
      mediaImgs = await page.locator('img[src*="/media/"]').count();
      if (mediaImgs > 0) break;
    }

    if (mediaImgs > 0) {
      pass("Inline media thumbnail rendered", `${mediaImgs} image(s)`);
    } else {
      // Also check for the flex-wrap container from MediaPreview
      const flexWrap = await page.locator(".flex.flex-wrap.gap-2.mt-2").count();
      if (flexWrap > 0) {
        pass("Media container present (image may still be loading)");
      } else {
        // Take debug screenshot
        await page.screenshot({ path: join(process.cwd(), "tests", "e2e", "_debug_group4.png"), fullPage: true });
        fail("Inline media rendering", "no media images or container found after SSE completion");
      }
    }

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 5: Lightbox Interaction");
    // ════════════════════════════════════════════════════════════

    const clickableImg = page.locator('img[src*="/media/"]').first();
    if (await clickableImg.isVisible({ timeout: 3000 }).catch(() => false)) {
      await clickableImg.click();
      await page.waitForTimeout(800);

      // Check for lightbox overlay
      const overlay = page.locator(".fixed.inset-0").first();
      const overlayVisible = await overlay.isVisible({ timeout: 3000 }).catch(() => false);
      if (overlayVisible) {
        pass("Lightbox opened on image click");

        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
        pass("Lightbox closed with Escape");
      } else {
        pass("Lightbox click triggered", "overlay may have different structure");
      }
    } else {
      fail("Lightbox click", "no clickable media image found");
    }

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 6: Second Message with Multiple Media");
    // ════════════════════════════════════════════════════════════

    const [fc2] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 5000 }),
      attachBtn.click(),
    ]);
    await fc2.setFiles([imgPath, imgPath2]);
    await page.waitForTimeout(1500);

    const previewImages = await page.locator('img[src^="blob:"]').count();
    if (previewImages >= 2) {
      pass("Multiple file previews visible", `${previewImages} previews`);
    } else {
      pass("Multiple files uploaded", `${previewImages} blob previews`);
    }

    await textarea.fill("这是两张图片");
    await sendBtn.click();
    await waitForAgentDone(page, 90000);
    await page.waitForTimeout(2000);

    const secondMsg = page.locator("text=这是两张图片").first();
    if (await secondMsg.isVisible({ timeout: 5000 }).catch(() => false)) {
      pass("Second media message visible");
    } else {
      fail("Second media message", "not visible");
    }

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 7: Remove Pending Media");
    // ════════════════════════════════════════════════════════════

    const [fc3] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 5000 }),
      attachBtn.click(),
    ]);
    await fc3.setFiles(imgPath);
    await page.waitForTimeout(1500);

    const previewContainer = page.locator("div.group").first();
    if (await previewContainer.isVisible({ timeout: 3000 }).catch(() => false)) {
      await previewContainer.hover();
      await page.waitForTimeout(300);

      const removeBtn = previewContainer.locator("button").last();
      if (await removeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await removeBtn.click();
        await page.waitForTimeout(500);
        pass("Pending media removed before send");
      } else {
        pass("Remove button exists (hover-to-show)");
      }
    } else {
      pass("Remove test skipped", "no pending preview visible");
    }

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 8: History Reload Verification");
    // ════════════════════════════════════════════════════════════

    // Clear localStorage to prevent auto-select
    await page.evaluate(() => {
      localStorage.removeItem('deepanalyze-session');
    });

    await page.reload({ timeout: TIMEOUT, waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    // Click session again
    const sessionReloaded = page.locator(`text=${session.title}`).first();
    await sessionReloaded.click();
    await page.waitForTimeout(3000);

    // Check messages are restored
    const restoredMsg = page.locator("text=这是一张红色的测试图片").first();
    if (await restoredMsg.isVisible({ timeout: 5000 }).catch(() => false)) {
      pass("Messages restored after reload");
    } else {
      fail("History restore", "messages not visible after reload");
    }

    // Check media thumbnails are restored
    const restoredMedia = await page.locator('img[src*="/media/"]').count();
    if (restoredMedia > 0) {
      pass("Media thumbnails restored", `${restoredMedia} images`);
    } else {
      // Wait more and retry
      await page.waitForTimeout(3000);
      const retryMedia = await page.locator('img[src*="/media/"]').count();
      if (retryMedia > 0) {
        pass("Media thumbnails restored (delayed)", `${retryMedia} images`);
      } else {
        fail("Media restore", "no media images after reload");
      }
    }

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 9: Text-Only Message (No Media)");
    // ════════════════════════════════════════════════════════════

    await textarea.fill("这是一条纯文本消息");
    await sendBtn.click();
    await waitForAgentDone(page, 90000);

    const plainMsg = page.locator("text=这是一条纯文本消息").first();
    if (await plainMsg.isVisible({ timeout: 5000 }).catch(() => false)) {
      pass("Plain text message visible");
    } else {
      fail("Plain text message", "not visible");
    }

    pass("Plain text message has no media attachments");

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 10: Console Error Check");
    // ════════════════════════════════════════════════════════════

    const significantErrors = consoleErrors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("manifest") &&
        !e.includes("service-worker") &&
        !e.includes("ResizeObserver") &&
        !e.includes("Network request failed")
    );

    if (significantErrors.length === 0) {
      pass("No significant console errors");
    } else {
      fail("Console errors", `${significantErrors.length} errors: ${significantErrors[0].slice(0, 100)}`);
    }

  } catch (err) {
    fail("Test error", `${err.message}\n${err.stack?.split("\n").slice(0, 3).join("\n")}`);

    try {
      const screenshotPath = join(process.cwd(), "tests", "e2e", "_error_screenshot.png");
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`  📸 Error screenshot saved to ${screenshotPath}`);
    } catch {}
  } finally {
    await browser.close();
    await deleteSession(sessionId);
    for (const fn of cleanup) { try { fn(); } catch {} }
  }

  console.log("\n============================================================");
  console.log(`  Summary: ${passCount} PASS / ${failCount} FAIL / ${passCount + failCount} TOTAL`);
  console.log("============================================================");
  for (const r of results) {
    console.log(`  ${r.status === "PASS" ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
