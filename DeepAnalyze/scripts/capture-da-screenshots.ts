// =============================================================================
// scripts/capture-da-screenshots.ts
// =============================================================================
// Capture screenshots of the DeepAnalyze frontend for visual verification.
// Uses Playwright with the HashRouter-based UI; auto-detects existing
// sessions/KBs/reports via the API rather than hard-coding IDs.
// =============================================================================

import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "/tmp/da-screenshots";
mkdirSync(OUT_DIR, { recursive: true });

const DA_BASE = "http://localhost:21000";

interface ShotSpec {
  name: string;
  url: string;
  preActions?: (page: Page) => Promise<void>;
  fullPage?: boolean;
}

// Panel button labels in the Header (zh)
const PANEL_BTNS = {
  sessions: "会话历史",
  plugins: "插件管理",
  skills: "技能库",
  teams: "团队管理",
  mcp: "MCP 服务",
  settings: "设置",
  evolution: "自进化",
  cron: "定时任务",
} as const;

async function clickHeaderBtn(page: Page, label: string): Promise<boolean> {
  // Close any open right panel first — when the panel is open it intercepts
  // pointer events over header buttons (Zustand state persists across
  // hash-route navigations).
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  const btn = page.getByRole("button", { name: label, exact: false }).first();
  if (await btn.isVisible({ timeout: 2500 }).catch(() => false)) {
    // force:true bypasses overlay interception — the button is logically
    // visible and clickable to the user.
    await btn.click({ force: true });
    await page.waitForTimeout(900);
    return true;
  }
  return false;
}

async function main() {
  // Discover real IDs
  console.log("[capture] discovering sessions/KBs/reports...");
  const [sessionsRes, kbsRes, reportsRes] = await Promise.all([
    fetch(`${DA_BASE}/api/sessions?limit=20`).then((r) => r.json()),
    fetch(`${DA_BASE}/api/knowledge/kbs`).then((r) => r.json()),
    fetch(`${DA_BASE}/api/reports/reports`).then((r) => r.json()),
  ]);

  const sessions: Array<{ id: string; title: string }> = sessionsRes ?? [];
  const kbs: Array<{ id: string; name: string }> = kbsRes.knowledgeBases ?? [];
  const reports: Array<{ id: string; title: string }> = reportsRes.reports ?? [];

  console.log(
    `  found ${sessions.length} sessions, ${kbs.length} KBs, ${reports.length} reports`,
  );

  // Pick the session with the longest title heuristically (likely most content)
  const session = sessions.sort(
    (a, b) => (b.title?.length ?? 0) - (a.title?.length ?? 0),
  )[0];
  const kb = kbs[0];
  const report = reports[0];

  if (!session) throw new Error("no sessions available — DA needs seed data");
  if (!kb) throw new Error("no knowledge bases available");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // DA may run in auth mode "none" — no login needed. Detect & adapt.
  let authMode = "none";
  try {
    const me = await fetch(`${DA_BASE}/api/auth/me`);
    if (me.status === 401) authMode = "local-or-hub";
  } catch {
    /* ignore */
  }
  console.log(`[capture] DA auth mode = ${authMode}`);

  // Helper: navigate to a hash URL and wait for SPA render
  async function gotoHash(hash: string, fullPage = true) {
    const url = `${DA_BASE}/${hash}`;
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 12000 });
    } catch {
      /* networkidle may time out on streaming — ok */
    }
    await page.waitForTimeout(800);
    return page.screenshot({
      path: "", // placeholder
      fullPage,
    } as never);
  }

  const SHOTS: ShotSpec[] = [
    { name: "01-chat-empty", url: `${DA_BASE}/#/chat` },
    {
      name: "02-session-active",
      url: `${DA_BASE}/#/sessions/${session.id}`,
    },
    {
      name: "03-sessions-panel",
      url: `${DA_BASE}/#/chat`,
      preActions: async (p) => {
        await clickHeaderBtn(p, PANEL_BTNS.sessions);
      },
      fullPage: false,
    },
    {
      name: "04-skills-browser",
      url: `${DA_BASE}/#/chat`,
      preActions: async (p) => {
        await clickHeaderBtn(p, PANEL_BTNS.skills);
      },
      fullPage: false,
    },
    {
      name: "05-plugin-manager",
      url: `${DA_BASE}/#/chat`,
      preActions: async (p) => {
        await clickHeaderBtn(p, PANEL_BTNS.plugins);
      },
      fullPage: false,
    },
    {
      name: "06-team-manager",
      url: `${DA_BASE}/#/chat`,
      preActions: async (p) => {
        await clickHeaderBtn(p, PANEL_BTNS.teams);
      },
      fullPage: false,
    },
    {
      name: "07-mcp-services",
      url: `${DA_BASE}/#/chat`,
      preActions: async (p) => {
        await clickHeaderBtn(p, PANEL_BTNS.mcp);
      },
      fullPage: false,
    },
    {
      name: "08-settings-model-config",
      url: `${DA_BASE}/#/chat`,
      preActions: async (p) => {
        if (await clickHeaderBtn(p, PANEL_BTNS.settings)) {
          // Settings panel opens — wait, then snap
          await p.waitForTimeout(500);
        }
      },
      fullPage: false,
    },
    { name: "09-knowledge-list", url: `${DA_BASE}/#/knowledge/${kb.id}` },
    {
      name: "10-knowledge-search",
      url: `${DA_BASE}/#/knowledge/${kb.id}/search`,
    },
    { name: "11-tasks", url: `${DA_BASE}/#/tasks` },
    ...(report
      ? [
          {
            name: "12-reports-list",
            url: `${DA_BASE}/#/reports`,
          },
          {
            name: "13-report-detail",
            url: `${DA_BASE}/#/reports/${report.id}`,
          },
        ]
      : []),
  ];

  // Capture loop
  for (const shot of SHOTS) {
    console.log(`[capture] ${shot.name} ← ${shot.url.replace(DA_BASE, "")}`);
    try {
      await page.goto(shot.url, { waitUntil: "networkidle", timeout: 12000 });
    } catch {
      console.warn("  navigation timeout, capturing anyway");
    }
    if (shot.preActions) {
      try {
        await shot.preActions(page);
      } catch (e) {
        console.warn(`  pre-action failed: ${(e as Error).message}`);
      }
    }
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

  // Capture one extra: open the chat session and try to expand a SubAgent panel
  // if present
  console.log("[capture] 14-session-subagent-deepdive");
  try {
    await page.goto(`${DA_BASE}/#/sessions/${session.id}`, {
      waitUntil: "networkidle",
      timeout: 12000,
    });
    await page.waitForTimeout(1500);
    // Scroll to bottom to render latest content
    await page
      .locator("main, [role='main']")
      .last()
      .evaluate((el) => el.scrollTo(0, el.scrollHeight))
      .catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({
      path: join(OUT_DIR, "14-session-subagent-deepdive.png"),
      fullPage: false,
    });
    console.log("  saved session detail");
  } catch (e) {
    console.warn(`  deep dive capture failed: ${(e as Error).message}`);
  }

  await browser.close();
  console.log(`[capture] done. screenshots in ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
