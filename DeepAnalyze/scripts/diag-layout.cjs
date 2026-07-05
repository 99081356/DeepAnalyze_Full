/**
 * 诊断布局宽度问题：在每个关键位置测量实际渲染宽度
 */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('file:///mnt/d/code/deepanalyze/DeepAnalyze-系统介绍.html', { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  // 测量多个位置的宽度
  const measurements = await page.evaluate(() => {
    const results = [];

    // 检查 body 和 container
    const body = document.body;
    const containers = [...document.querySelectorAll('.container')];
    results.push({
      element: 'body',
      scrollW: body.scrollWidth,
      clientW: body.clientWidth,
    });
    containers.forEach((c, i) => {
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      results.push({
        element: `.container[${i}]`,
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        maxW: cs.maxWidth,
        padding: cs.padding,
      });
    });

    // 检查 cover
    const cover = document.querySelector('.cover');
    if (cover) {
      const r = cover.getBoundingClientRect();
      results.push({ element: '.cover', left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
    }

    // 检查 footer
    const footer = document.querySelector('footer');
    if (footer) {
      const r = footer.getBoundingClientRect();
      const fc = footer.querySelector('.container');
      const fcr = fc ? fc.getBoundingClientRect() : null;
      results.push({
        element: 'footer',
        left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
        footerContainer: fcr ? `left=${Math.round(fcr.left)} right=${Math.round(fcr.right)}` : 'none',
      });
    }

    // 检查每个 section h2
    const h2s = [...document.querySelectorAll('h2')];
    h2s.forEach((h, i) => {
      const r = h.getBoundingClientRect();
      const text = (h.textContent || '').slice(0, 20);
      results.push({
        element: `h2[${i}] "${text}"`,
        left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
      });
    });

    // 检查截图
    const shots = [...document.querySelectorAll('.screenshot')];
    if (shots.length > 0) {
      const r = shots[0].getBoundingClientRect();
      results.push({ element: '.screenshot (first)', left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
    }

    // 检查 table 和 pre (可能突破容器)
    const tables = [...document.querySelectorAll('table')];
    tables.slice(0, 3).forEach((t, i) => {
      const r = t.getBoundingClientRect();
      results.push({ element: `table[${i}]`, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
    });

    const pres = [...document.querySelectorAll('pre')];
    pres.slice(0, 3).forEach((p, i) => {
      const r = p.getBoundingClientRect();
      results.push({ element: `pre[${i}]`, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
    });

    return results;
  });

  console.log('=== Layout Width Measurements ===');
  console.log('(Viewport: 1440px, all widths in CSS pixels)\n');
  measurements.forEach((m) => {
    console.log(`  ${m.element.padEnd(35)} ${JSON.stringify(m)}`);
  });

  // 滚动到不同位置截图
  const positions = [
    { name: 'cover', y: 0 },
    { name: 'toc', y: 600 },
    { name: 'sec01', y: 1100 },
    { name: 'sec03', y: 2500 },
    { name: 'sec05-screenshots', y: 4000 },
    { name: 'sec11-hub', y: 9000 },
  ];

  console.log('\n=== Viewport Screenshots ===');
  const fs = require('fs');
  const outDir = '/mnt/d/code/deepanalyze/article-screenshots/_layout-diag/';
  fs.mkdirSync(outDir, { recursive: true });

  for (const pos of positions) {
    await page.evaluate((y) => window.scrollTo(0, y), pos.y);
    await page.waitForTimeout(500);
    await page.screenshot({ path: outDir + `layout-${pos.name}.png` });
    console.log(`  Saved layout-${pos.name}.png (scrollY=${pos.y})`);
  }

  await browser.close();
})();
