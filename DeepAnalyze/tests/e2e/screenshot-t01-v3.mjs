/**
 * T01 frontend verification with CORRECT hash-based routing.
 */
import { chromium } from "playwright";

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
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`[PAGE_ERROR] ${err.message}`));

  console.log("Navigating to session via hash route...");
  // Use hash-based routing
  await page.goto(`${BASE}/#/sessions/${SESSION_ID}`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(5000);

  // Get page structure
  const info = await page.evaluate(() => {
    const main = document.querySelector("main");
    const mainChildren = main ? Array.from(main.children).map(c => ({
      tag: c.tagName.toLowerCase(),
      cls: (c.className || "").toString().substring(0, 80),
      childCount: c.children.length,
      textLen: (c.textContent || "").length,
    })) : [];

    // Look for message elements
    const messageSelectors = [
      "[class*='message']",
      "[class*='Message']",
      "[class*='chat']",
      "[class*='Chat']",
      "[class*='push']",
      "[class*='Push']",
      "[class*='markdown']",
      "[class*='card']",
    ];
    const counts = {};
    for (const sel of messageSelectors) {
      counts[sel] = document.querySelectorAll(sel).length;
    }

    // Get main content text
    const mainText = main ? main.textContent.substring(0, 5000) : "NO MAIN";

    // Get current URL
    return {
      url: window.location.href,
      hash: window.location.hash,
      mainChildren,
      counts,
      mainText,
    };
  });

  console.log("=== URL ===");
  console.log(info.url);
  console.log("\n=== Main children ===");
  console.log(JSON.stringify(info.mainChildren, null, 2));
  console.log("\n=== Element counts ===");
  console.log(JSON.stringify(info.counts, null, 2));
  console.log("\n=== Main text (first 2000) ===");
  console.log(info.mainText.substring(0, 2000));

  await page.screenshot({ path: `/tmp/test80-screenshots/T01-v3-session.png`, fullPage: false });
  console.log("\nSaved T01-v3-session.png");

  // Scroll to bottom to see all content
  await page.evaluate(() => {
    const scrollable = document.querySelector("main") || document.documentElement;
    scrollable.scrollTop = scrollable.scrollHeight;
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `/tmp/test80-screenshots/T01-v3-bottom.png`, fullPage: false });
  console.log("Saved T01-v3-bottom.png");

  // Full page screenshot
  await page.screenshot({ path: `/tmp/test80-screenshots/T01-v3-fullpage.png`, fullPage: true });
  console.log("Saved T01-v3-fullpage.png");

  console.log(`\n=== Console Errors: ${consoleErrors.length} ===`);
  for (const err of consoleErrors.slice(0, 10)) console.log(`  ${err.slice(0, 200)}`);

  await browser.close();
}

main().catch(console.error);
