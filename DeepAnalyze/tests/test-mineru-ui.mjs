// =============================================================================
// Playwright test: Verify MinerU settings panel renders correctly
// Target: Built frontend served by backend at http://127.0.0.1:21000
// =============================================================================

import { chromium } from 'playwright';

const SCREENSHOT_PATH = '/tmp/mineru-settings.png';
const BASE_URL = 'http://127.0.0.1:21000';

async function run() {
  let browser;
  let passed = false;
  const checks = [];

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // Collect console errors for debugging
    page.on('console', msg => {
      if (msg.type() === 'error') console.log('  [BROWSER CONSOLE ERROR]', msg.text().substring(0, 200));
    });

    // -------------------------------------------------------
    // Step 1: Open the app
    // -------------------------------------------------------
    console.log('[1/7] Opening DeepAnalyze at', BASE_URL);
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('  -> Page loaded. Title:', await page.title());

    // -------------------------------------------------------
    // Step 2: Wait for the app shell to fully render
    // -------------------------------------------------------
    console.log('[2/7] Waiting for app shell to render...');
    await page.waitForSelector('header', { timeout: 15000 });
    // Wait a bit for React hydration
    await page.waitForTimeout(2000);
    console.log('  -> Header rendered.');

    // -------------------------------------------------------
    // Step 3: Find and click the Settings (gear) icon in the header
    // -------------------------------------------------------
    console.log('[3/7] Looking for Settings (gear) icon in header...');
    // The Settings button has title="设置"
    const settingsBtn = page.locator('header button[title="设置"]');
    await settingsBtn.waitFor({ state: 'visible', timeout: 10000 });
    console.log('  -> Found Settings button.');
    await settingsBtn.click();
    console.log('  -> Clicked Settings button.');

    // Wait for the right panel to slide in
    await page.waitForTimeout(1000);

    // -------------------------------------------------------
    // Step 4: Wait for Settings panel and verify it opened
    // -------------------------------------------------------
    console.log('[4/7] Waiting for Settings panel to open...');
    // The settings panel shows tabs: 模型配置, 通信渠道, MCP 服务, 通用
    await page.waitForSelector('text=模型配置', { timeout: 10000 });
    console.log('  -> Settings panel is open (模型配置 tab visible).');

    // -------------------------------------------------------
    // Step 5: Find and click the "MinerU" sub-tab
    // -------------------------------------------------------
    console.log('[5/7] Looking for MinerU tab in the Models panel...');
    // The MinerU tab is inside the ModelsPanel sub-navigation
    // It's a small button with text "MinerU"
    const mineruTab = page.locator('button:has-text("MinerU")').first();
    await mineruTab.waitFor({ state: 'visible', timeout: 10000 });
    console.log('  -> Found MinerU tab.');
    await mineruTab.click();
    console.log('  -> Clicked MinerU tab.');

    // Wait for the MinerU config to load from the API
    await page.waitForTimeout(3000);

    // -------------------------------------------------------
    // Step 6: Take a screenshot
    // -------------------------------------------------------
    console.log('[6/7] Taking screenshot to', SCREENSHOT_PATH);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
    console.log('  -> Screenshot saved.');

    // Debug: dump visible text content from the right panel area
    const rightPanelText = await page.evaluate(() => {
      // The right panel is the last significant div in the body
      const panels = document.querySelectorAll('div');
      // Try to find the settings content by looking for known text
      for (const el of panels) {
        if (el.children.length > 0 && el.textContent?.includes('MinerU')) {
          return el.textContent.substring(0, 1500);
        }
      }
      return 'Could not find MinerU content in DOM';
    });
    console.log('  -> DOM content with MinerU text:');
    console.log(rightPanelText.substring(0, 800));

    // -------------------------------------------------------
    // Step 7: Verify MinerU config form elements
    // -------------------------------------------------------
    console.log('[7/7] Verifying MinerU config form elements...');

    // Check 1: "MinerU 解析服务" heading
    const serviceHeader = await page.locator('text=MinerU 解析服务').count();
    checks.push({ name: 'MinerU service heading visible', pass: serviceHeader > 0 });

    // Check 2: Enable toggle ("启用" label)
    const enableLabel = await page.locator('text=启用').count();
    checks.push({ name: 'Enable toggle visible', pass: enableLabel > 0 });

    // Check 3: Connection status indicator
    // Either "已连接", "未连接", or "检测" button
    const connected = await page.locator('text=已连接').count();
    const disconnected = await page.locator('text=未连接').count();
    const checkStatusBtn = await page.locator('button:has-text("检测")').count();
    checks.push({
      name: 'Connection status indicator',
      pass: connected > 0 || disconnected > 0 || checkStatusBtn > 0,
    });

    // Check 4: "API 服务地址" input section
    const apiSection = await page.locator('text=API 服务地址').count();
    checks.push({ name: 'API URL section visible', pass: apiSection > 0 });

    // Check 5: "默认后端" section
    const backendSection = await page.locator('text=默认后端').count();
    checks.push({ name: 'Backend selector section visible', pass: backendSection > 0 });

    // Check 6: Backend options visible (Hybrid, Pipeline, VLM)
    const hybrid = await page.locator('text=Hybrid').count();
    const pipeline = await page.locator('text=Pipeline').count();
    const vlm = await page.locator('button:has-text("VLM")').count();
    checks.push({
      name: 'Backend options present (Hybrid/Pipeline/VLM)',
      pass: hybrid > 0 && pipeline > 0 && vlm > 0,
    });

    // Check 7: "解析选项" section
    const parseOptions = await page.locator('text=解析选项').count();
    checks.push({ name: 'Parsing options section visible', pass: parseOptions > 0 });

    // Check 8: "保存配置" button
    const saveBtn = await page.locator('button:has-text("保存配置")').count();
    checks.push({ name: 'Save config button visible', pass: saveBtn > 0 });

    // Check 9: Option checkboxes (formula/table/image)
    const formula = await page.locator('text=公式识别').count();
    const table = await page.locator('text=表格识别').count();
    const image = await page.locator('text=图片分析').count();
    checks.push({
      name: 'Option checkboxes (formula/table/image)',
      pass: formula > 0 && table > 0 && image > 0,
    });

    // Print results
    console.log('\n--- Verification Results ---');
    let allPassed = true;
    for (const c of checks) {
      const status = c.pass ? 'PASS' : 'FAIL';
      console.log(`  [${status}] ${c.name}`);
      if (!c.pass) allPassed = false;
    }

    passed = allPassed;
    const total = checks.length;
    const passedCount = checks.filter(c => c.pass).length;
    console.log(`\nResult: ${passedCount}/${total} checks passed.`);

  } catch (err) {
    console.error('\nTest encountered an error:', err.message);
    console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
    passed = false;
  } finally {
    if (browser) await browser.close();
  }

  if (passed) {
    console.log('\n=== TEST PASSED ===');
    process.exit(0);
  } else {
    console.log('\n=== TEST FAILED ===');
    process.exit(1);
  }
}

run();
