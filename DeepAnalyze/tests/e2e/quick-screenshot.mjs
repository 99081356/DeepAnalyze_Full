import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto("http://localhost:21000", { waitUntil: "networkidle", timeout: 30000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: "/tmp/test80-screenshots/ui-check.png" });

// Check for key UI elements
const hasTextarea = await page.locator("textarea").count();
const hasSidebar = await page.locator("[class*='sidebar'], nav, aside").count();
const title = await page.title();
console.log(JSON.stringify({ title, hasTextarea, hasSidebar }));

// List all buttons
const buttons = await page.locator("button").allTextContents();
console.log("Buttons:", buttons.slice(0, 15).join(" | "));

await browser.close();
