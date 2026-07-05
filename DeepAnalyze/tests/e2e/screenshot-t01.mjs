/**
 * Screenshot T01 session results for frontend rendering verification.
 */
import { chromium } from "playwright";
import { mkdirSync } from "fs";

const SCREENSHOT_DIR = "/tmp/test80-screenshots";
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const SESSION_ID = "835fc606-4ed4-40c4-88b7-166976b4a5b4";
const BASE = "http://localhost:21000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: "zh-CN",
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(`[${new Date().toISOString()}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`[PAGE_ERROR] ${err.message}`);
  });

  console.log("Navigating to session...");
  await page.goto(`${BASE}/?session=${SESSION_ID}`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(3000);

  // Initial state
  await page.screenshot({ path: `${SCREENSHOT_DIR}/T01-01-initial.png`, fullPage: false });
  console.log("Saved T01-01-initial.png");

  // Scroll down to see more content
  await page.evaluate(() => window.scrollBy(0, 500));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/T01-02-scrolled.png`, fullPage: false });
  console.log("Saved T01-02-scrolled.png");

  // Find pushed content cards and expand them
  const cardCount = await page.locator("[class*='push'], [class*='card'], [data-push-id]").count();
  console.log(`Found ${cardCount} push/card elements`);

  // Try clicking "expand" or "view" buttons on cards
  const expandButtons = await page.locator("button:has-text('查看'), button:has-text('展开'), button:has-text('详情')").count();
  console.log(`Found ${expandButtons} expand buttons`);

  // Full page screenshot to capture everything
  await page.screenshot({ path: `${SCREENSHOT_DIR}/T01-03-fullpage.png`, fullPage: true });
  console.log("Saved T01-03-fullpage.png");

  // Get all text content for analysis
  const pageText = await page.evaluate(() => {
    const body = document.body;
    return body ? body.innerText.substring(0, 5000) : "";
  });
  console.log("\n=== Page text preview (first 2000 chars) ===");
  console.log(pageText.substring(0, 2000));

  // Report console errors
  console.log(`\n=== Console Errors: ${consoleErrors.length} ===`);
  for (const err of consoleErrors.slice(0, 10)) {
    console.log(`  ${err}`);
  }

  await browser.close();
}

main().catch(console.error);
