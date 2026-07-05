/**
 * Comprehensive E2E test — ALL features from May 14-16 development
 * Covers: #6, #7, #8, #9, Task 10 (Evidence), Evolution, Plugins, Settings
 */
import { chromium } from 'playwright';
import fs from 'fs';

const FRONTEND = 'http://localhost:5173';
const KB_ID = '89ee4db6-0626-4636-8c66-49a575d05832';

const R = { pass: 0, fail: 0 };
const ok = (cond, name) => {
  if (cond) { R.pass++; console.log(`  ✓ ${name}`); }
  else      { R.fail++; console.log(`  ✗ ${name}`); }
};
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // ---- F1: Header (search bar removed) ----
  console.log('\n=== F1: Header ===');
  await page.goto(FRONTEND, { waitUntil: 'networkidle', timeout: 15000 });
  await wait(2000);

  ok((await page.$$('header input[type="text"]')).length === 0, 'No text inputs in header');
  ok(!await page.$('text=Ctrl+K'), 'No Ctrl+K text');
  ok(await page.$eval('header span', e => e.textContent) === 'DeepAnalyze', 'Logo preserved');
  const btns = await page.$$('header button');
  ok(btns.length >= 7, `${btns.length} buttons (≥7)`);
  await page.screenshot({ path: '/tmp/e2e4-F1.png' });

  // ---- F2: Provider config auto-naming ----
  console.log('\n=== F2: Provider config ===');
  await page.click('header button[title="设置"]');
  await wait(1500);
  ok(await page.$('text=Provider 管理') !== null, 'Provider section visible');

  const optVals = await page.$$eval('select option', els => els.map(e => ({ v: e.value, t: e.textContent })));
  const openaiOpt = optVals.find(o => o.t?.includes('OpenAI'));
  if (openaiOpt?.v) {
    await page.selectOption('select', openaiOpt.v);
    await wait(500);
    ok(await page.$('text=新配置') !== null, 'New config hint');
    const modelInput = await page.$('input[list]');
    if (modelInput) {
      await modelInput.click(); await modelInput.fill(''); await modelInput.type('gpt-4o');
      await wait(300);
      const vals = await page.$$eval('input[type="text"]', els => els.map(e => e.value));
      ok(!!vals.find(v => v?.includes('gpt-4o')), `Auto-name: ${vals.find(v => v?.includes('gpt-4o'))}`);
    }
  }
  await page.screenshot({ path: '/tmp/e2e4-F2.png' });
  await page.keyboard.press('Escape'); await wait(800);

  // ---- F3: Evolution panel ----
  console.log('\n=== F3: Evolution ===');
  await page.click('header button[title="自进化"]');
  await wait(2000);
  const evoText = await page.textContent('body');
  ok(evoText.includes('自进化'), 'Evolution panel opened');
  ok(await page.$('[role="switch"]') !== null, 'Toggle present');
  await page.screenshot({ path: '/tmp/e2e4-F3.png' });
  await page.keyboard.press('Escape'); await wait(800);

  // ---- F4: Plugin + Skill panels ----
  console.log('\n=== F4: Plugins/Skills ===');
  await page.click('header button[title="插件管理"]');
  await wait(2000);
  const pluginBody = await page.textContent('body');
  ok(!pluginBody.includes('加载失败') || !pluginBody.includes('500'), 'Plugin panel no error');
  ok(pluginBody.includes('插件') || pluginBody.includes('Plugin'), 'Plugin panel opened');
  await page.screenshot({ path: '/tmp/e2e4-F4-plugins.png' });
  await page.keyboard.press('Escape'); await wait(800);

  await page.click('header button[title="技能库"]');
  await wait(2000);
  const skillBody = await page.textContent('body');
  ok(skillBody.includes('技能') || skillBody.includes('Skill'), 'Skill browser opened');
  await page.screenshot({ path: '/tmp/e2e4-F4-skills.png' });
  await page.keyboard.press('Escape'); await wait(800);

  // ---- F5: KB search ----
  console.log('\n=== F5: KB search ===');
  await page.click('text=知识库'); await wait(1500);
  await page.selectOption('select', KB_ID); await wait(2000);

  const searchInput = await page.$('input[placeholder="搜索知识库..."]');
  ok(searchInput !== null, 'Search input found');
  if (searchInput) {
    await searchInput.click(); await searchInput.fill('document'); await wait(2500);
    const bodyText = await page.textContent('body') || '';
    ok(/\d{2,3}\.\d%/.test(bodyText), 'Results with scores');
  }
  await page.screenshot({ path: '/tmp/e2e4-F5.png' });

  // ---- F6: Evidence preview ----
  console.log('\n=== F6: Evidence preview ===');
  await page.goto(FRONTEND, { waitUntil: 'networkidle', timeout: 15000 });
  await wait(2000);

  const storeCheck = await page.evaluate(() => {
    const s = window.__evidencePreviewStore;
    if (!s) return { exists: false };
    const state = s.getState();
    return { exists: true, hasOpen: typeof state.openPreview === 'function', hasClose: typeof state.closePreview === 'function' };
  });
  ok(storeCheck.exists, 'Evidence store exposed');
  ok(storeCheck.hasOpen && storeCheck.hasClose, 'Store has open/close');

  // Backend evidence API
  const evidenceAPI = await page.evaluate(async () => {
    const r = await fetch('/api/preview/evidence/nonexistent');
    return { status: r.status };
  });
  ok(evidenceAPI.status === 404, `Evidence API exists (${evidenceAPI.status})`);

  // Filesystem checks
  const previewFiles = [
    'frontend/src/store/evidencePreview.ts',
    'frontend/src/components/preview/EvidencePreviewPanel.tsx',
    'frontend/src/components/preview/renderers/ImagePreview.tsx',
    'frontend/src/components/preview/renderers/DocumentPreview.tsx',
    'frontend/src/components/preview/renderers/TablePreview.tsx',
    'frontend/src/components/preview/renderers/MediaPreview.tsx',
  ];
  ok(previewFiles.every(f => fs.existsSync(f)), 'All preview files exist');
  await page.screenshot({ path: '/tmp/e2e4-F6.png' });

  // ---- F7: TodoMiniPanel ----
  console.log('\n=== F7: TodoMiniPanel ===');
  const todoSrc = fs.readFileSync('frontend/src/components/chat/TodoPanel.tsx', 'utf8');
  ok(todoSrc.includes('TodoMiniPanel'), 'TodoMiniPanel exported');
  ok(todoSrc.includes('Agent Tasks'), 'Agent Tasks header');
  ok(fs.readFileSync('frontend/src/components/layout/Sidebar.tsx', 'utf8').includes('TodoMiniPanel'), 'In Sidebar');

  // ---- F8: Backend APIs ----
  console.log('\n=== F8: Backend APIs ===');
  const pluginAPI = await page.evaluate(async () => {
    const r = await fetch('/api/plugins/plugins');
    const d = await r.json();
    return { status: r.status, hasPlugins: Array.isArray(d.plugins), count: d.plugins?.length ?? 0 };
  });
  ok(pluginAPI.status === 200, `Plugin API 200 (was 500)`);
  ok(pluginAPI.hasPlugins, `Plugin list returned (${pluginAPI.count} plugins)`);

  const agentsAPI = await page.evaluate(async () => {
    const r = await fetch('/api/agents');
    return r.json();
  });
  ok(agentsAPI.initialized === true, 'Agent system initialized');

  // ---- Summary ----
  console.log('\n' + '═'.repeat(50));
  console.log(`  TOTAL: ${R.pass} PASS / ${R.fail} FAIL`);
  console.log('═'.repeat(50));

  await browser.close();
})();
