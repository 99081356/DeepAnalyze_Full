import { chromium } from "playwright";

const BASE = "http://localhost:21000";

async function main() {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.waitForTimeout(3000);

  // Find session list items and click Fix1-push-content
  const items = await p.$$("li");
  for (const item of items) {
    const text = await item.innerText().catch(() => "");
    if (text.trim() === "Fix1-push-content") {
      // Click the inner element (likely a span or div)
      const inner = await item.$("span, div, a");
      if (inner) {
        await inner.click();
        console.log("Clicked inner element of Fix1-push-content li");
      } else {
        await item.click();
        console.log("Clicked Fix1-push-content li directly");
      }
      break;
    }
  }

  await p.waitForTimeout(8000);
  console.log("URL:", p.url());

  // Get chat area text
  const text = await p.evaluate(() => {
    // Find the right panel content
    const body = document.body.innerText;
    return body;
  });

  const hasChat = text.includes("push_content") || text.includes("测试报告");
  console.log("Has chat content:", hasChat);

  if (hasChat) {
    const chatLines = text.split("\n").filter(l =>
      l.includes("push") || l.includes("测试") || l.includes("报告") ||
      l.includes("结论") || l.includes("工具")
    );
    console.log("Relevant lines:", chatLines.slice(0, 10));
  }

  await p.screenshot({ path: "/tmp/da-fix-verify-v3/final-ui.png", fullPage: true });

  // Try approach 2: navigate directly via hash
  await p.goto(`${BASE}/#/chat/4150c8d7-8c1b-4196-be68-127f07c6bada`, { waitUntil: "networkidle" });
  await p.waitForTimeout(5000);
  console.log("Direct URL:", p.url());
  const text2 = await p.evaluate(() => document.body.innerText);
  const hasChat2 = text2.includes("push_content") || text2.includes("测试报告");
  console.log("Direct nav has chat:", hasChat2);

  await p.screenshot({ path: "/tmp/da-fix-verify-v3/final-ui-direct.png", fullPage: true });

  await b.close();
}

main().catch(console.error);
