const { chromium } = require('playwright');
const DA_URL = 'http://localhost:3000';
const CASE_SESSION = '0697b513-8861-414e-857d-d5bee2467f64';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.log('PAGEERR:', err.message.slice(0, 200)));
  
  await page.goto(`${DA_URL}/#/sessions/${CASE_SESSION}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(4000);
  
  // FIX: explicitly initialize userOverride before injection
  await page.evaluate(() => {
    const store = window.__WORKFLOW_STORE__;
    const s = store.getState();
    // Ensure all Map fields are initialized (HMR can leave them undefined)
    store.setState({
      userOverride: s.userOverride instanceof Map ? s.userOverride : new Map(),
      activeWorkflows: s.activeWorkflows instanceof Map ? s.activeWorkflows : new Map(),
    });
  });
  
  // Now inject workflow
  await page.evaluate((sid) => {
    const actions = window.__WORKFLOW_STORE__.getState();
    actions.handleWorkflowStart({
      workflowId: 'debug-wf-fix', sessionId: sid, teamName: '司法证据分析团队',
      mode: 'parallel', agentCount: 2,
    });
    actions.handleAgentStart({ workflowId: 'debug-wf-fix', agentId: 'ag1', role: '财务分析', task: 'test' });
    actions.handleAgentStart({ workflowId: 'debug-wf-fix', agentId: 'ag2', role: '笔录分析', task: 'test2' });
  }, CASE_SESSION);
  
  await page.waitForTimeout(2500);
  
  const domCheck = await page.evaluate(() => ({
    stack: document.querySelectorAll('[data-testid="subagent-stack"]').length,
    panel: document.querySelectorAll('[data-testid="subagent-panel"]').length,
    bodyHasTeam: document.body.innerText.includes('司法证据分析团队'),
  }));
  console.log('DOM:', JSON.stringify(domCheck, null, 2));
  
  await page.screenshot({ path: '/tmp/debug-da02-fix.png' });
  console.log('Screenshot saved');
  
  await browser.close();
})();
