/**
 * DA Screenshot Script v3 — matches article expectations
 *
 * Key fixes vs v2:
 *  1. Close all popups before chat captures (Escape + wait)
 *  2. Use REAL model tab labels (主模型/辅助模型/嵌入模型/图像理解/视频理解/ASR/生成模型/Docling/MinerU)
 *  3. Add communication channels capture (da-13-channels.png)
 *  4. Teams: wait for 调研团队 to render (9 seeded teams)
 *  5. SubAgentPanel: look for [data-testid="subagent-stack"]
 *  6. TodoMiniPanel: search for 任务进度 in sidebar
 *  7. ReferenceMarkers: search for span with [N] pattern in ReportCard
 *  8. push_content cards: use [data-testid="push-content-card"]
 *  9. Better scroll container detection (MessageList uses overflowY:auto + height:100%)
 * 10. Use data-testid selectors for tool calls instead of broad text matching
 */
const { chromium } = require('playwright');
const fs = require('fs');

const OUT = '/mnt/d/code/deepanalyze/article-screenshots/';
const DA_URL = 'http://localhost:3000';

fs.mkdirSync(OUT, { recursive: true });

// Session IDs
const CASE_SESSION = '0697b513-8861-414e-857d-d5bee2467f64';
const SURVEY_SESSION = '1e763468-896c-4679-96c8-ec05db69a530';
const KB_SESSION = '6b5b134e-09ad-4379-b4e9-008ab3c4bc6a';

// KB with 69 docs
const DOC_WANG_KB = '40ba98d9-34fa-40ca-b6f9-82becdf0c560';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();

  page.on('pageerror', (err) => console.log('  PAGEERR:', err.message.slice(0, 120)));

  // ── Helpers ──

  async function nav(url, waitForContent = null) {
    await page.goto(`${DA_URL}${url}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (waitForContent) {
      try {
        await page.waitForSelector(waitForContent, { timeout: 12000 });
      } catch (e) {
        console.log(`  (warn) waitForSelector timeout: ${waitForContent}`);
      }
    } else {
      await page.waitForTimeout(3000);
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    await page.waitForTimeout(1000); // Wait for React auto-scroll to settle
  }

  /**
   * Set the chat scroll container to a specific percentage.
   * Uses JS evaluation to find and scroll the correct container.
   */
  async function scrollChat(pct) {
    await page.evaluate((p) => {
      const main = document.querySelector('main');
      if (!main) return;
      // Find the scrollable div (MessageList)
      const allDivs = main.querySelectorAll('div');
      for (const el of allDivs) {
        const style = window.getComputedStyle(el);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            el.clientHeight > 100 && el.scrollHeight > el.clientHeight + 50) {
          const max = el.scrollHeight - el.clientHeight;
          el.scrollTop = Math.floor(max * p);
          break;
        }
      }
    }, pct);
    await page.waitForTimeout(600);
  }

  /**
   * Scroll the chat to find elements matching a Playwright selector.
   * Uses Playwright locator count() at each position.
   * Returns the scroll percentage where the element was found, or -1.
   */
  async function scrollChatToFind(selector, maxTries = 10) {
    for (let i = 0; i <= maxTries; i++) {
      const pct = i / maxTries;
      await scrollChat(pct);
      const count = await page.locator(selector).count();
      if (count > 0) {
        return pct;
      }
    }
    return -1;
  }

  /**
   * Scroll chat to a percentage and then scroll a specific element into view.
   * Uses bounding rect to check if element is in viewport.
   */
  async function scrollChatToElement(selector, maxTries = 10) {
    for (let i = 0; i <= maxTries; i++) {
      const pct = i / maxTries;
      await scrollChat(pct);

      // Check if selector exists and get its position
      const loc = page.locator(selector).first();
      const count = await loc.count();
      if (count > 0) {
        // Check if element is in viewport
        try {
          const box = await loc.boundingBox({ timeout: 2000 });
          if (box && box.y >= 0 && box.y < 800) {
            return pct;
          }
          // Try to scroll it into view using the scroll container
          await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
          await page.waitForTimeout(500);
          return pct;
        } catch (_) {}
      }
    }
    return -1;
  }

  async function clickByTitle(title) {
    const btn = page.locator(`[title="${title}"]`).first();
    try {
      await btn.click({ timeout: 5000 });
      return true;
    } catch (e) {
      console.log(`  (warn) clickByTitle("${title}") failed: ${e.message.slice(0, 60)}`);
      return false;
    }
  }

  async function clickByText(text, exact = true) {
    const loc = exact
      ? page.getByText(text, { exact: true }).first()
      : page.getByText(text).first();
    try {
      await loc.click({ timeout: 5000 });
      return true;
    } catch (e) {
      console.log(`  (warn) clickByText("${text}") failed: ${e.message.slice(0, 60)}`);
      return false;
    }
  }

  async function shoot(filename, fullPage = false) {
    await page.screenshot({ path: OUT + filename, fullPage });
    const size = (fs.statSync(OUT + filename).size / 1024).toFixed(0);
    console.log(`  OK ${filename} (${size}KB)`);
  }

  async function safeShoot(label, filename, fn) {
    console.log(`\n${label}: ${filename}`);
    try {
      await fn();
      await shoot(filename);
    } catch (e) {
      console.log(`  FAIL ${filename}: ${e.message.slice(0, 80)}`);
      try { await shoot(filename); } catch (_) {}
    }
  }

  async function closePopups() {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  async function ensureSidebarExpanded() {
    const expandBtn = page.locator('[title="展开侧边栏"]');
    if (await expandBtn.count() > 0) {
      await expandBtn.click().catch(() => {});
      await page.waitForTimeout(800);
    }
  }

  // ════════════════════════════════════════════════════════════
  // A. Case session — rich content screenshots
  // ════════════════════════════════════════════════════════════
  console.log('\n=== A. Case Session — Rich Content ===');

  await nav(`/#/sessions/${CASE_SESSION}`, 'main');
  await page.waitForTimeout(3000);

  // da-20: Chat overview — full chat flow at top with sidebar
  await safeShoot('da-20 对话流全景', 'da-20-chat-overview.png', async () => {
    await ensureSidebarExpanded();
    await scrollChat(0.0);
  });

  // da-01: Chat with diverse tool calls
  // The CASE session has 60 tool calls as data-testid="tool-call-card"
  // Tool names include wiki_browse, agent_todo, expand, read_file, workflow_run, etc.
  // Scroll to ~40% to show diverse tool call types (expand, bash, run_sql, etc.)
  await safeShoot('da-01 主对话界面 (ToolCallCards)', 'da-01-chat-toolcalls.png', async () => {
    await scrollChat(0.40);
    // Verify we see tool-call-cards
    const tcCount = await page.locator('[data-testid="tool-call-card"]').count();
    console.log(`  (info) ${tcCount} tool-call-cards in DOM, at 40% scroll`);
  });

  // da-02: SubAgentPanel — workflow_run content
  // The CASE session has a workflow_run tool call that triggers SubAgentPanel
  await safeShoot('da-02 SubAgentPanel', 'da-02-subagent-panel.png', async () => {
    // Check if subagent-stack is visible with children (active workflow)
    const stackCount = await page.locator('[data-testid="subagent-stack"]').count();
    let hasChildren = false;
    if (stackCount > 0) {
      const childCount = await page.locator('[data-testid="subagent-stack"] > *').count();
      hasChildren = childCount > 0;
      console.log(`  (info) subagent-stack found, children=${childCount}`);
    }

    if (!hasChildren) {
      // Look for workflow_run tool call card and scroll to it
      // The workflow_run card is around the middle of the tool calls
      const toolCards = page.locator('[data-testid="tool-call-card"]');
      const tcCount = await toolCards.count();
      console.log(`  (info) Total tool-call-cards: ${tcCount}`);

      if (tcCount > 0) {
        // Find the workflow_run card (it should be around index 13 out of 60)
        for (let i = 0; i < tcCount; i++) {
          const card = toolCards.nth(i);
          const text = await card.textContent();
          if (text && text.includes('workflow_run')) {
            await card.scrollIntoViewIfNeeded({ timeout: 3000 });
            await page.waitForTimeout(800);
            console.log(`  (ok) Scrolled to workflow_run card at index ${i}`);
            break;
          }
        }
      }
    } else {
      console.log('  (ok) SubAgentPanel active');
    }
  });

  // da-03: TodoMiniPanel / 任务进度
  // The CASE session has agent_todo tool calls
  // Scroll to ~25% to show agent_todo tool calls (they start around index 1-12)
  await safeShoot('da-03 TodoMiniPanel (任务进度)', 'da-03-todo-panel.png', async () => {
    await ensureSidebarExpanded();
    // Check if 任务进度 panel is visible in sidebar (requires active todos)
    const todoPanel = page.getByText('任务进度', { exact: false });
    const count = await todoPanel.count();
    if (count > 0) {
      console.log('  (ok) 任务进度 panel visible in sidebar');
    } else {
      // Scroll to 25% to show agent_todo update calls
      await scrollChat(0.25);
      console.log('  (info) Scrolled to 25% for agent_todo content');
    }
  });

  // da-04: PushContentCards
  await safeShoot('da-04 push_content cards', 'da-04-push-content.png', async () => {
    const foundPct = await scrollChatToElement('[data-testid="push-content-card"]', 10);
    if (foundPct >= 0) {
      console.log(`  (ok) push-content-card found at ${Math.round(foundPct * 100)}% scroll`);
    } else {
      console.log('  (warn) No push-content-card found');
      await scrollChat(0.85);
    }
  });

  // da-05: Evidence chain / ReferenceMarkers [1][2][3]
  // The push_content cards contain markdown reports with evidence links
  // Scroll deeper into the report content (past the push-content cards)
  await safeShoot('da-05 证据链与引用标记', 'da-05-evidence-chain.png', async () => {
    // Reference markers are span elements with [N] text
    // Try to find them directly first
    const markerFound = await scrollChatToElement('span >> text=/^\\[\\d+\\]$/', 10);
    if (markerFound >= 0) {
      console.log(`  (ok) Reference markers found at ${Math.round(markerFound * 100)}% scroll`);
    } else {
      // Scroll to ~95% to show the report body with evidence markers
      await scrollChat(0.95);
      console.log('  (info) Scrolled to 95% for report body');
    }
  });

  // da-06: 过程记录 (thinking panel)
  await safeShoot('da-06 过程记录', 'da-06-thinking.png', async () => {
    // 过程记录 button is in the assistant message
    // Find it and scroll to it, then click to expand
    const procBtn = page.getByText('过程记录', { exact: true });
    const count = await procBtn.count();
    if (count > 0) {
      // Scroll it into view first
      await procBtn.first().scrollIntoViewIfNeeded({ timeout: 3000 });
      await page.waitForTimeout(800);
      // Click to expand
      try {
        await procBtn.first().click({ timeout: 4000 });
        await page.waitForTimeout(2500);
        console.log('  (ok) 过程记录 expanded');
      } catch (e) {
        console.log('  (warn) 过程记录 click failed');
      }
    } else {
      console.log('  (warn) No 过程记录 button found');
      await scrollChat(0.05);
    }
  });

  // ════════════════════════════════════════════════════════════
  // B. Knowledge Base System
  // ════════════════════════════════════════════════════════════
  console.log('\n=== B. Knowledge Base System ===');

  // da-07: KB document list (69 docs)
  await safeShoot('da-07 知识库文档列表', 'da-07-knowledge-panel.png', async () => {
    await page.goto(`${DA_URL}/#/knowledge/${DOC_WANG_KB}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    try {
      await page.waitForSelector('text=就绪', { timeout: 12000 });
      console.log('  (ok) KB docs rendered');
    } catch (e) {
      try {
        await page.waitForSelector('text=文档', { timeout: 8000 });
        console.log('  (ok) KB view loaded (文档 text found)');
      } catch (_) {
        console.log('  (warn) KB docs not detected, waiting more');
        await page.waitForTimeout(4000);
      }
    }
  });

  // da-08: Document L0 summary preview
  await safeShoot('da-08 文档L0摘要预览', 'da-08-doc-processing.png', async () => {
    try {
      const docRow = page.locator('text=就绪').first();
      await docRow.click({ timeout: 5000 });
      await page.waitForTimeout(2500);
      console.log('  (ok) Clicked first ready document');
    } catch (e) {
      try {
        const docCard = page.locator('[class*="ocument"], [class*="oc-card"]').first();
        await docCard.click({ timeout: 5000 });
        await page.waitForTimeout(2500);
      } catch (_) {
        console.log('  (warn) Could not click document, scrolling');
        await scrollChat(0.3);
      }
    }
  });

  // da-09: L0/L1/L2 layered view
  await safeShoot('da-09 L0/L1/L2 三层分层视图', 'da-09-doc-layers.png', async () => {
    let clicked = false;
    try {
      const l1Btn = page.locator('button:has-text("L1")').first();
      if (await l1Btn.count() > 0) {
        await l1Btn.click({ timeout: 5000 });
        await page.waitForTimeout(3000);
        clicked = true;
        console.log('  (ok) Clicked L1 button');
      }
    } catch (_) {}

    if (!clicked) {
      try {
        const l1Link = page.getByText('查看 L1 概览', { exact: false }).first();
        if (await l1Link.count() > 0) {
          await l1Link.click({ timeout: 5000 });
          await page.waitForTimeout(3000);
          clicked = true;
          console.log('  (ok) Clicked "查看 L1 概览"');
        }
      } catch (_) {}
    }

    if (!clicked) {
      console.log('  (warn) No L1 button found, capturing current state');
    }
  });

  // ════════════════════════════════════════════════════════════
  // C. Settings & Panels
  // ════════════════════════════════════════════════════════════
  console.log('\n=== C. Settings & Panels ===');

  await nav('/#/chat', 'main');

  // da-11: Model config panel — main model tab
  await safeShoot('da-11 模型配置面板', 'da-11-model-config.png', async () => {
    await closePopups();
    await clickByTitle('设置');
    await page.waitForTimeout(1500);
    try {
      await page.getByText('模型配置', { exact: true }).first().click({ timeout: 5000 });
      await page.waitForTimeout(1500);
      console.log('  (ok) Clicked 模型配置 tab');
    } catch (e) {
      console.log('  (warn) 模型配置 tab not found, may already be active');
    }
    try {
      await page.getByText('主模型', { exact: true }).first().click({ timeout: 3000 });
      await page.waitForTimeout(1000);
    } catch (_) {}
  });

  // da-12: Model config — non-main tab (辅助模型 final)
  await safeShoot('da-12 模型配置 Tab 切换', 'da-12-model-tabs.png', async () => {
    const tabsToClick = ['嵌入模型', '辅助模型'];
    for (const tab of tabsToClick) {
      try {
        await page.getByText(tab, { exact: true }).first().click({ timeout: 4000 });
        await page.waitForTimeout(1500);
        console.log(`  (ok) Clicked ${tab}`);
      } catch (e) {
        console.log(`  (warn) ${tab} tab not clickable`);
      }
    }
  });

  // da-13-channels: Communication channels (NEW file)
  await safeShoot('da-13-channels 通信渠道', 'da-13-channels.png', async () => {
    await closePopups();
    await clickByTitle('设置');
    await page.waitForTimeout(1500);
    try {
      await page.getByText('通信渠道', { exact: true }).first().click({ timeout: 5000 });
      await page.waitForTimeout(2000);
      console.log('  (ok) Clicked 通信渠道 tab');
      const feishu = await page.getByText('飞书', { exact: false }).count();
      if (feishu > 0) {
        console.log('  (ok) Channel cards visible');
      } else {
        console.log('  (warn) 飞书 not found, panel may not be loaded');
      }
    } catch (e) {
      console.log('  (warn) 通信渠道 tab click failed');
    }
  });

  // da-13-mcp: MCP services
  await safeShoot('da-13 MCP服务面板', 'da-13-mcp.png', async () => {
    await closePopups();
    await clickByTitle('MCP 服务');
    await page.waitForTimeout(2500);
    const mcpText = await page.getByText('MCP', { exact: false }).count();
    if (mcpText > 0) {
      console.log('  (ok) MCP panel visible');
    }
  });

  // da-14: Skill browser
  await safeShoot('da-14 技能库', 'da-14-skills.png', async () => {
    await closePopups();
    await clickByTitle('技能库');
    await page.waitForTimeout(2500);
    const skillText = await page.getByText('技能', { exact: false }).count();
    if (skillText > 0) {
      console.log('  (ok) Skill panel visible');
    }
  });

  // da-15: Team management (9 seeded teams)
  await safeShoot('da-15 团队管理', 'da-15-teams.png', async () => {
    await closePopups();
    await clickByTitle('团队管理');
    try {
      await page.waitForSelector('text=调研团队', { timeout: 10000 });
      console.log('  (ok) Teams rendered (调研团队 visible)');
    } catch (e) {
      console.log('  (warn) 调研团队 not found, waiting more');
      await page.waitForTimeout(3000);
    }
    await page.waitForTimeout(1500);
  });

  // ════════════════════════════════════════════════════════════
  // D. Complex Task Sessions
  // ════════════════════════════════════════════════════════════
  console.log('\n=== D. Complex Task Sessions ===');

  // da-16: Case analysis overview (~70% scroll)
  await safeShoot('da-16 案件分析全景', 'da-16-case-analysis.png', async () => {
    await nav(`/#/sessions/${CASE_SESSION}`, 'main');
    await scrollChat(0.7);
  });

  // da-17: Evidence markers in report body (~85% scroll)
  await safeShoot('da-17 证据链在报告中', 'da-17-evidence-report.png', async () => {
    await scrollChat(0.85);
    const markers = await page.locator('span >> text=/^\\[\\d+\\]$/').count();
    if (markers > 0) {
      console.log(`  (ok) Found ${markers} reference markers`);
    } else {
      console.log('  (info) No inline markers at this position, capturing report body');
    }
  });

  // da-18: Survey report (AI综述)
  await safeShoot('da-18 AI综述报告', 'da-18-survey-report.png', async () => {
    await nav(`/#/sessions/${SURVEY_SESSION}`, 'main');
    await scrollChat(0.5);
  });

  // da-19: KB batch analysis
  await safeShoot('da-19 知识库批量分析', 'da-19-kb-analysis.png', async () => {
    await nav(`/#/sessions/${KB_SESSION}`, 'main');
    await scrollChat(0.4);
  });

  await browser.close();

  // Summary
  const files = fs.readdirSync(OUT).filter((f) => f.startsWith('da-') && f.endsWith('.png'));
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Done! ${files.length} DA screenshots captured:`);
  console.log(`${'═'.repeat(60)}`);
  files.sort().forEach((f) => {
    const size = (fs.statSync(OUT + f).size / 1024).toFixed(0);
    const flag = parseInt(size) < 30 ? ' *** SMALL ***' : '';
    console.log(`  ${f} (${size}KB)${flag}`);
  });
})();
