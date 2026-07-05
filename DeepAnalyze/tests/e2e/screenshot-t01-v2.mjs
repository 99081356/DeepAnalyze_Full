/**
 * Detailed T01 session frontend inspection.
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

  console.log("Navigating to session...");
  await page.goto(`${BASE}/?session=${SESSION_ID}`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(5000);

  // Get the entire page structure
  const layout = await page.evaluate(() => {
    function describe(el, depth = 0) {
      if (depth > 4) return "";
      const tag = el.tagName.toLowerCase();
      const cls = (el.className || "").toString().split(" ").filter(Boolean).slice(0, 2).join(".");
      const text = (el.textContent || "").substring(0, 80).replace(/\s+/g, " ").trim();
      const id = el.id ? `#${el.id}` : "";
      const sig = `${tag}${id}${cls ? "." + cls : ""}`;

      // Only include if it has text or is a key structural element
      const structuralTags = ["main", "aside", "header", "nav", "section", "article"];
      const isStructural = structuralTags.includes(tag);
      const hasText = text.length > 5;
      if (!isStructural && !hasText) return "";

      let result = "  ".repeat(depth) + `- ${sig}`;
      if (text && text.length < 80) result += ` :: "${text}"`;
      result += "\n";

      const children = Array.from(el.children);
      if (children.length > 0 && depth < 4) {
        // Only recurse into structural elements to avoid noise
        if (isStructural || children.length < 5) {
          for (const child of children.slice(0, 10)) {
            result += describe(child, depth + 1);
          }
        }
      }
      return result;
    }

    return describe(document.body);
  });

  console.log("=== Layout ===");
  console.log(layout.substring(0, 4000));

  // Find the main chat area - look for specific patterns
  const pushCards = await page.evaluate(() => {
    // Try various selectors that might match push content cards
    const selectors = [
      "[class*='push']",
      "[class*='card']",
      "[data-push-id]",
      "[class*='PushContent']",
      "[class*='message-content']",
      "article",
      "[class*='markdown']",
    ];
    const results = {};
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      results[sel] = {
        count: els.length,
        samples: Array.from(els).slice(0, 3).map(e => ({
          tag: e.tagName,
          cls: (e.className || "").toString().substring(0, 100),
          text: (e.textContent || "").substring(0, 100).replace(/\s+/g, " "),
        })),
      };
    }
    return results;
  });
  console.log("\n=== Element counts ===");
  console.log(JSON.stringify(pushCards, null, 2));

  // Get the main content area text
  const mainContent = await page.evaluate(() => {
    const main = document.querySelector("main, [class*='chat'], [class*='message'], [class*='conversation']");
    return main ? main.textContent.substring(0, 3000) : "NO MAIN FOUND";
  });
  console.log("\n=== Main content (first 3000 chars) ===");
  console.log(mainContent);

  await page.screenshot({ path: `/tmp/test80-screenshots/T01-detail.png`, fullPage: false });
  console.log("\nSaved T01-detail.png");

  await browser.close();
}

main().catch(console.error);
