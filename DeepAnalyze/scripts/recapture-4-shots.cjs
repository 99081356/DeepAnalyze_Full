/**
 * Re-capture 4 problematic screenshots:
 *   da-02 SubAgentPanel 多 Agent 并发 (inject workflow state)
 *   da-03 TodoMiniPanel 动态目标 (inject todos)
 *   da-05 证据链与引用标记 (expand push_content + click evidence link → EvidencePreviewPanel)
 *   da-17 证据链在报告中的效果 (expand push_content + scroll to evidence summary at end)
 *
 * Key fixes vs. v1:
 *   - Use dynamic import() for chat store (no source-file modification needed)
 *   - Initialize workflow store's userOverride/activeWorkflows as Maps before
 *     injection (HMR can leave them undefined, crashing selectPanelMode)
 *   - Add chunk messages so SubAgentPanel cards show richer activity
 */
const { chromium } = require('playwright');
const fs = require('fs');

const OUT = '/mnt/d/code/deepanalyze/article-screenshots/';
const DA_URL = 'http://localhost:3000';
const CASE_SESSION = '0697b513-8861-414e-857d-d5bee2467f64';

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
  page.on('pageerror', (err) => console.log('  PAGEERR:', err.message.slice(0, 160)));

  // ── Helpers ──
  async function nav(url, waitForContent = 'main') {
    await page.goto(`${DA_URL}${url}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (waitForContent) {
      try { await page.waitForSelector(waitForContent, { timeout: 15000 }); } catch (_) {}
    }
    await page.waitForTimeout(3000);
    // Wait for session messages to actually load (Vite restart makes first load slow)
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('[class*="message"], [class*="Message"], [data-testid="push-content-card"]').length >= 1,
        { timeout: 12000 },
      );
    } catch (_) {}
    await page.waitForTimeout(1500);
  }

  async function scrollChat(pct) {
    await page.evaluate((p) => {
      const main = document.querySelector('main');
      if (!main) return;
      const allDivs = main.querySelectorAll('div');
      for (const el of allDivs) {
        const style = window.getComputedStyle(el);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            el.clientHeight > 100 && el.scrollHeight > el.clientHeight + 50) {
          el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) * p);
          break;
        }
      }
    }, pct);
    await page.waitForTimeout(600);
  }

  async function shoot(filename) {
    await page.screenshot({ path: OUT + filename });
    const size = (fs.statSync(OUT + filename).size / 1024).toFixed(0);
    console.log(`  OK ${filename} (${size}KB)`);
  }

  async function ensureSidebarExpanded() {
    const btn = page.locator('[title="展开侧边栏"]');
    if (await btn.count() > 0) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(800);
    }
  }

  /** Dynamic-import the chat store and stash it on window for later access. */
  async function exposeChatStore() {
    return await page.evaluate(async () => {
      if (!window.__CHAT_STORE__) {
        try {
          const mod = await import('/src/store/chat.ts');
          window.__CHAT_STORE__ = mod.useChatStore;
        } catch (e) {
          console.log('chat store import failed:', e.message);
          return false;
        }
      }
      return !!window.__CHAT_STORE__;
    });
  }

  /** Ensure workflow store Map fields are real Maps (HMR can leave them undefined). */
  async function ensureWorkflowStoreMaps() {
    await page.evaluate(() => {
      const store = window.__WORKFLOW_STORE__;
      if (!store) return;
      const s = store.getState();
      const patch = {};
      if (!(s.activeWorkflows instanceof Map)) patch.activeWorkflows = new Map();
      if (!(s.userOverride instanceof Map)) patch.userOverride = new Map();
      if (Object.keys(patch).length > 0) store.setState(patch);
    });
  }

  // ════════════════════════════════════════════════════════════
  // da-03: TodoMiniPanel 动态目标 — inject todos via chat store
  // ════════════════════════════════════════════════════════════
  console.log('\n=== da-03 TodoMiniPanel 动态目标 ===');
  await nav(`/#/sessions/${CASE_SESSION}`);
  await ensureSidebarExpanded();
  const chatOk = await exposeChatStore();
  console.log(`  (info) chat store exposed: ${chatOk}`);
  await scrollChat(0.3);

  // Inject realistic todos (mix of completed/in_progress/pending to avoid auto-clear)
  await page.evaluate(() => {
    const store = window.__CHAT_STORE__;
    if (!store) { console.log('CHAT_STORE not found!'); return; }
    store.setState({
      todos: [
        { id: 't1', status: 'completed', subject: '梳理案件人物关系网络', description: '识别所有涉案人员及其关联' },
        { id: 't2', status: 'completed', subject: '提取时间线关键节点', description: '按时间顺序排列事件' },
        { id: 't3', status: 'completed', subject: '解析资金流水链路', description: '追踪资金转移路径' },
        { id: 't4', status: 'in_progress', subject: '交叉验证证据链一致性', description: '多源证据互证分析' },
        { id: 't5', status: 'pending', subject: '识别异常行为模式', description: '动态追加：发现新线索' },
        { id: 't6', status: 'pending', subject: '生成综合分析报告', description: '汇总所有发现' },
      ],
    });
  });
  await page.waitForTimeout(1500);

  // Expand the TodoMiniPanel by clicking the header
  try {
    const header = page.getByText('任务进度', { exact: false }).first();
    if (await header.count() > 0) {
      await header.click({ timeout: 3000 });
      await page.waitForTimeout(1000);
      console.log('  (ok) TodoMiniPanel expanded');
    } else {
      console.log('  (warn) 任务进度 header not found');
    }
  } catch (_) {}

  await shoot('da-03-todo-panel.png');

  // Clear injected todos to avoid affecting other captures
  await page.evaluate(() => {
    window.__CHAT_STORE__?.setState({ todos: [] });
  });

  // ════════════════════════════════════════════════════════════
  // da-02: SubAgentPanel 多 Agent 并发 — inject workflow state
  // ════════════════════════════════════════════════════════════
  console.log('\n=== da-02 SubAgentPanel 多 Agent 并发 ===');
  await nav(`/#/sessions/${CASE_SESSION}`);
  await ensureSidebarExpanded();
  await ensureWorkflowStoreMaps();
  await scrollChat(0.35);

  // Inject a realistic multi-agent workflow
  await page.evaluate((sid) => {
    const store = window.__WORKFLOW_STORE__;
    if (!store) { console.log('WORKFLOW_STORE not found!'); return; }
    const wfId = 'screenshot-demo-wf';
    const actions = store.getState();

    // Create workflow
    actions.handleWorkflowStart({
      workflowId: wfId,
      sessionId: sid,
      teamName: '司法证据分析团队',
      mode: 'parallel',
      agentCount: 4,
    });

    // Agent 1: completed — 财务分析
    actions.handleAgentStart({ workflowId: wfId, agentId: 'ag-finance', role: '财务分析专家', task: '分析资金流水与财务书证' });
    for (let i = 0; i < 8; i++) {
      actions.handleAgentToolCall({ workflowId: wfId, agentId: 'ag-finance', toolName: 'kb_search', input: { query: `资金流水第${i+1}批` } });
    }
    actions.handleAgentToolCall({ workflowId: wfId, agentId: 'ag-finance', toolName: 'expand', input: { docId: '财务报表' } });
    // A few output chunks so the card shows generated content
    for (let i = 0; i < 5; i++) {
      actions.handleAgentChunk({ workflowId: wfId, agentId: 'ag-finance', content: `第${i+1}批次资金流向已确认。` });
    }
    actions.handleAgentComplete({ workflowId: wfId, agentId: 'ag-finance', duration: 184.3 });

    // Agent 2: completed — 笔录分析
    actions.handleAgentStart({ workflowId: wfId, agentId: 'ag-interrogation', role: '笔录分析专家', task: '分析讯问笔录与询问笔录' });
    for (let i = 0; i < 6; i++) {
      actions.handleAgentToolCall({ workflowId: wfId, agentId: 'ag-interrogation', toolName: 'kb_search', input: { query: `笔录分析${i+1}` } });
    }
    actions.handleAgentToolCall({ workflowId: wfId, agentId: 'ag-interrogation', toolName: 'doc_grep', input: { pattern: '供述' } });
    for (let i = 0; i < 4; i++) {
      actions.handleAgentChunk({ workflowId: wfId, agentId: 'ag-interrogation', content: `笔录片段${i+1}已提取。` });
    }
    actions.handleAgentComplete({ workflowId: wfId, agentId: 'ag-interrogation', duration: 167.8 });

    // Agent 3: running — 现场物证
    actions.handleAgentStart({ workflowId: wfId, agentId: 'ag-scene', role: '现场物证专家', task: '分析现场勘验、物证、电子数据' });
    for (let i = 0; i < 5; i++) {
      actions.handleAgentToolCall({ workflowId: wfId, agentId: 'ag-scene', toolName: 'kb_search', input: { query: `现场物证${i+1}` } });
    }
    actions.handleAgentToolCall({ workflowId: wfId, agentId: 'ag-scene', toolName: 'expand', input: { docId: '现场勘验笔录' } });
    for (let i = 0; i < 3; i++) {
      actions.handleAgentChunk({ workflowId: wfId, agentId: 'ag-scene', content: `物证${i+1}正在比对…` });
    }
    // Leave running — don't call handleAgentComplete

    // Agent 4: running — 综合审计
    actions.handleAgentStart({ workflowId: wfId, agentId: 'ag-audit', role: '综合审计员', task: '交叉验证与报告合成' });
    actions.handleAgentToolCall({ workflowId: wfId, agentId: 'ag-audit', toolName: 'kb_search', input: { query: '证据交叉验证' } });
    actions.handleAgentChunk({ workflowId: wfId, agentId: 'ag-audit', content: '正在汇总三方证据…' });
    // Leave running

    // Force expanded mode so agent cards are visible
    if (actions.setUserOverride) {
      actions.setUserOverride(wfId, 'expanded');
    }
  }, CASE_SESSION);

  await page.waitForTimeout(2000);

  // Check if subagent-stack is visible
  const stackVisible = await page.locator('[data-testid="subagent-stack"]').count();
  console.log(`  (info) subagent-stack count: ${stackVisible}`);

  // Click the team name to expand into full detail view (shows agent cards with
  // tool calls, chunk counts, durations). handleTitleClick is bound to the div
  // wrapping the Users icon + teamName span.
  try {
    const teamName = page.getByText('司法证据分析团队', { exact: false }).first();
    if (await teamName.count() > 0) {
      await teamName.click({ timeout: 5000 });
      await page.waitForTimeout(2000);
      console.log('  (ok) Clicked team name to expand detail view');
    } else {
      console.log('  (warn) team name not found');
    }
  } catch (e) {
    console.log(`  (warn) team name click failed: ${e.message.slice(0, 80)}`);
  }

  await shoot('da-02-subagent-panel.png');

  // Clean up injected workflow
  await page.evaluate(() => {
    const store = window.__WORKFLOW_STORE__;
    if (store) {
      const m = new Map(store.getState().activeWorkflows);
      m.delete('screenshot-demo-wf');
      store.setState({ activeWorkflows: m });
    }
  });

  // ════════════════════════════════════════════════════════════
  // da-05: 证据链与引用标记 — expand push_content, click evidence link
  // ════════════════════════════════════════════════════════════
  console.log('\n=== da-05 证据链与引用标记 ===');
  await nav(`/#/sessions/${CASE_SESSION}`);

  // Scroll to find push-content-card
  let cardFound = false;
  for (let i = 0; i <= 12; i++) {
    await scrollChat(i / 12);
    await page.waitForTimeout(400);
    const cnt = await page.locator('[data-testid="push-content-card"]').count();
    if (cnt > 0) { cardFound = true; console.log(`  (ok) Found ${cnt} push-content-cards at ${Math.round(i / 12 * 100)}%`); break; }
  }
  if (!cardFound) {
    // Fallback: wait explicitly for push-content-card with longer timeout
    try {
      await page.waitForSelector('[data-testid="push-content-card"]', { timeout: 15000 });
      cardFound = true;
      console.log('  (ok) push-content-card found via waitForSelector fallback');
    } catch (_) {
      console.log('  (warn) no push-content-card found at all');
    }
  }

  if (cardFound) {
    // Expand the first push-content-card (it starts collapsed for > 2000 chars)
    try {
      const expandLink = page.getByText('展开查看完整内容', { exact: false }).first();
      if (await expandLink.count() > 0) {
        await expandLink.click({ timeout: 5000 });
        console.log('  (ok) Clicked expand on push-content-card');
        // Wait for large content rendering (19K chars takes time)
        await page.waitForTimeout(5000);
      }
    } catch (e) {
      console.log(`  (warn) expand click failed: ${e.message.slice(0, 60)}`);
    }

    // Now find evidence links inside the expanded card
    const evLinks = page.locator('[data-testid="push-content-card"] .evidence-link[data-evidence-anchor]');
    const evCount = await evLinks.count();
    console.log(`  (info) Found ${evCount} evidence links with anchors`);

    if (evCount > 0) {
      // Scroll the first evidence link into view
      await evLinks.first().scrollIntoViewIfNeeded({ timeout: 3000 });
      await page.waitForTimeout(800);

      // Click the evidence link to open EvidencePreviewPanel
      try {
        await evLinks.first().click({ timeout: 5000 });
        console.log('  (ok) Clicked evidence link');
        await page.waitForTimeout(3000); // Wait for panel slide-in + content fetch

        // Verify panel is open
        const panelOpen = await page.evaluate(() => {
          return window.__evidencePreviewStore?.getState()?.isOpen === true;
        });
        console.log(`  (info) EvidencePreviewPanel isOpen: ${panelOpen}`);
      } catch (e) {
        console.log(`  (warn) evidence link click failed: ${e.message.slice(0, 60)}`);
        // Fallback: open via store directly
        await page.evaluate(() => {
          window.__evidencePreviewStore?.getState()?.openDocumentPreview(
            '9ae696db-3e54-4be4-be6c-b2ceae466fc7',
            '3df1d3e7-81dc-4ad5-af8d-9712158331e7'
          );
        });
        await page.waitForTimeout(3000);
      }
    }
  }

  await shoot('da-05-evidence-chain.png');

  // Close the panel
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);

  // ════════════════════════════════════════════════════════════
  // da-17: 证据链在报告中的效果 — scroll to evidence summary at report end
  // ════════════════════════════════════════════════════════════
  console.log('\n=== da-17 证据链在报告中的效果 ===');

  // The push-content should still be expanded from da-05
  // Scroll to the bottom of the expanded markdown content to find the evidence summary
  for (let pct = 0.90; pct <= 0.99; pct += 0.02) {
    await scrollChat(pct);
    const evText = await page.getByText('证据', { exact: false }).count();
    const refText = await page.getByText('引用', { exact: false }).count();
    if (evText > 0 || refText > 0) {
      console.log(`  (info) At ${Math.round(pct * 100)}%: 证据 text=${evText}, 引用 text=${refText}`);
    }
  }

  await scrollChat(0.92);
  await page.waitForTimeout(1000);

  // Try to find and scroll to evidence summary heading
  try {
    for (const heading of ['证据链汇总', '证据来源', '引用列表', '参考资料', '证据索引']) {
      const loc = page.getByText(heading, { exact: false }).first();
      if (await loc.count() > 0) {
        await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
        await page.waitForTimeout(800);
        console.log(`  (ok) Scrolled to "${heading}"`);
        break;
      }
    }
  } catch (_) {}

  await shoot('da-17-evidence-report.png');

  await browser.close();
  console.log('\n=== Done! 4 screenshots captured ===');
})();
