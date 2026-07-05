import { chromium } from "playwright";

const BASE = "http://localhost:21000";
const SHOTS = "/tmp/da-fix-verify-v3";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();

  const sessions = [
    { id: "4150c8d7-8c1b-4196-be68-127f07c6bada", label: "fix1-push-content" },
    { id: "653938b0-2159-45c3-9f31-997b231e28f1", label: "fix3-docgrep" },
    { id: "c54d784d-ac4c-43fc-a5b9-28feb8120dfb", label: "fix4-multimodal" },
    { id: "e22848e6-44d1-4111-b99f-624b4f6b7d3a", label: "fix2-compaction" },
  ];

  for (const s of sessions) {
    await page.goto(`${BASE}/?session=${s.id}`, { waitUntil: "domcontentloaded" });

    // Wait for messages to render
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(500);
      const hasMsg = await page.evaluate(() => {
        const els = document.querySelectorAll('[class*="markdown"], [class*="message"], article, pre');
        for (const el of els) {
          if (el.textContent && el.textContent.trim().length > 30) return true;
        }
        // Also check for push content cards
        const cards = document.querySelectorAll('[class*="push"], [class*="card"]');
        for (const c of cards) {
          if (c.textContent && c.textContent.trim().length > 10) return true;
        }
        return false;
      });
      if (hasMsg) break;
    }

    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SHOTS}/${s.label}-final.png`, fullPage: true });
    console.log(`Screenshot: ${s.label}-final.png`);
  }

  await browser.close();
}

main().catch(console.error);
