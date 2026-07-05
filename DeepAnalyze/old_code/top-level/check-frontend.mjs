import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 15000 });
await new Promise(r => setTimeout(r, 3000));

// Click 对话 tab
const chatTab = await page.$('button:has-text("对话")');
if (chatTab) {
  await chatTab.click();
  await new Promise(r => setTimeout(r, 2000));
}

// Look for input elements
const elements = await page.evaluate(() => {
  const results = [];
  const selectors = ['textarea', 'input', '[contenteditable]', '[role="textbox"]'];
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      results.push({
        tag: el.tagName,
        type: el.type || '',
        placeholder: el.placeholder || '',
        className: (el.className || '').toString().slice(0, 100),
        id: el.id || '',
      });
    }
  }
  return results;
});

console.log('Input elements:', JSON.stringify(elements, null, 2));

await page.screenshot({ path: '/tmp/frontend-dom-check2.png' });
await browser.close();
