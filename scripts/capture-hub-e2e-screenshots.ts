// =============================================================================
// scripts/capture-hub-e2e-screenshots.ts
// =============================================================================
// Capture screenshots of all Hub admin pages for visual verification.
// Uses Playwright; auto-logs in as admin; captures full-page screenshots
// of every nav destination + the deploy modal + skill detail.
// =============================================================================

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "/tmp/hub-screenshots";
mkdirSync(OUT_DIR, { recursive: true });

const HUB_BASE = "http://localhost:22000";
const FRONTEND_BASE = "http://localhost:5173";

interface ShotSpec {
  name: string;
  path: string;
  preActions?: (page: import("playwright").Page) => Promise<void>;
  fullPage?: boolean;
}

const SHOTS: ShotSpec[] = [
  { name: "01-login", path: "/login" },
  { name: "02-dashboard", path: "/" },
  { name: "03-orgs", path: "/orgs" },
  { name: "04-users", path: "/users" },
  { name: "05-skills-packages", path: "/skills" },
  { name: "06-worker-skills", path: "/worker-skills" },
  { name: "07-submissions", path: "/submissions" },
  { name: "08-sharings", path: "/sharings" },
  { name: "09-workers", path: "/workers" },
  { name: "10-models", path: "/models" },
  { name: "11-security", path: "/security" },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Login via API to get JWT, inject into localStorage.
  // Use fetch() rather than page.request.post() to avoid a Playwright/Bun
  // set-cookie parsing quirk that throws "cannot be parsed as a URL".
  console.log("[capture] logging in as admin...");
  const loginResp = await fetch(`${HUB_BASE}/api/v1/auth/login`, {
    method: "POST",
    body: JSON.stringify({ username: "admin", password: "admin123" }),
    headers: { "Content-Type": "application/json" },
  });
  if (!loginResp.ok) {
    throw new Error(`login failed: ${loginResp.status}`);
  }
  const { access_token } = (await loginResp.json()) as { access_token: string };

  // Navigate to frontend first to set localStorage
  await page.goto(FRONTEND_BASE, { waitUntil: "domcontentloaded" });
  await page.evaluate((token) => {
    localStorage.setItem("hub_access_token", token);
    localStorage.setItem("hub_token", token);
  }, access_token);

  // Capture each page
  for (const shot of SHOTS) {
    console.log(`[capture] ${shot.name} → ${shot.path}`);
    const url = `${FRONTEND_BASE}${shot.path}`;
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
    } catch (e) {
      console.warn(`  navigation timeout, capturing anyway`);
    }
    if (shot.preActions) {
      try {
        await shot.preActions(page);
      } catch (e) {
        console.warn(`  pre-action failed: ${(e as Error).message}`);
      }
    }
    // Give SPA time to render
    await page.waitForTimeout(800);
    const outPath = join(OUT_DIR, `${shot.name}.png`);
    try {
      await page.screenshot({
        path: outPath,
        fullPage: shot.fullPage ?? true,
      });
      console.log(`  saved ${outPath}`);
    } catch (e) {
      console.error(`  screenshot failed: ${(e as Error).message}`);
    }
  }

  // Capture deploy modal (open modal on /workers page)
  console.log("[capture] 12-deploy-modal");
  try {
    await page.goto(`${FRONTEND_BASE}/workers`, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(800);
    // Look for any "部署" or "Deploy" button
    const deployBtn = page.getByRole("button", { name: /部署|Deploy/i }).first();
    if (await deployBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await deployBtn.click();
      await page.waitForTimeout(800);
      await page.screenshot({
        path: join(OUT_DIR, "12-deploy-modal.png"),
        fullPage: false,
      });
      console.log("  saved deploy modal");
    } else {
      console.log("  no deploy button visible — skipping");
    }
  } catch (e) {
    console.warn(`  deploy modal capture failed: ${(e as Error).message}`);
  }

  await browser.close();
  console.log(`[capture] done. screenshots in ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
