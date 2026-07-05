const { chromium } = require('playwright');
const DA_URL = 'http://localhost:3000';
const CASE_SESSION = '0697b513-8861-414e-857d-d5bee2467f64';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.log('PAGEERR:', err.message.slice(0, 200)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('CONSOLE ERR:', msg.text().slice(0, 200));
  });

  await page.goto(`${DA_URL}/#/sessions/${CASE_SESSION}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Check what's actually loaded
  const diag = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return { err: 'no main' };
    
    // Count various elements
    const allDivs = main.querySelectorAll('div');
    let scrollable = [];
    for (const el of allDivs) {
      const style = window.getComputedStyle(el);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          el.clientHeight > 100) {
        scrollable.push({
          clientH: el.clientHeight,
          scrollH: el.scrollHeight,
          scrollTop: el.scrollTop,
          class: el.className?.toString?.()?.slice(0, 60) || '',
        });
      }
    }
    
    return {
      pushCards: document.querySelectorAll('[data-testid="push-content-card"]').length,
      allTestIds: Array.from(document.querySelectorAll('[data-testid]'))
        .map(e => e.getAttribute('data-testid'))
        .filter(t => t)
        .slice(0, 20),
      scrollable: scrollable.slice(0, 5),
      bodyTextLen: document.body.innerText.length,
      bodyTextStart: document.body.innerText.slice(0, 200),
    };
  });
  console.log('DIAG:', JSON.stringify(diag, null, 2));

  await browser.close();
})();
