/**
 * Phase 8 验证 — 用 Playwright 加载组装后的文章，检查渲染质量
 */
const { chromium } = require('playwright');
const fs = require('fs');

const ARTICLE = '/mnt/d/code/deepanalyze/DeepAnalyze-系统介绍.html';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  const errors = [];
  const warnings = [];

  // 捕获 console 错误
  page.on('pageerror', (err) => {
    errors.push(`PAGE_ERROR: ${err.message.slice(0, 120)}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`CONSOLE_ERROR: ${msg.text().slice(0, 120)}`);
    }
  });

  // 加载文章
  console.log('Loading article...');
  await page.goto(`file://${ARTICLE}`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 逐步滚动页面，触发所有 lazy 图片的加载
  console.log('Scrolling to trigger lazy loading...');
  const totalHeight = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < totalHeight; y += 800) {
    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), y);
    await page.waitForTimeout(200);
  }
  // 滚回顶部
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(2000);

  // 等待所有图片完全解码
  await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll('.screenshot-img')];
    await Promise.all(imgs.map((img) => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 5000);
      });
    }));
  });

  // 1. 标题
  const title = await page.evaluate(() => document.title);
  console.log(`1. Title: ${title}`);

  // 2. 检查所有截图是否加载
  const imgStats = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.screenshot-img')];
    return {
      total: imgs.length,
      loaded: imgs.filter((i) => i.naturalWidth > 0).length,
      failed: imgs.filter((i) => i.naturalWidth === 0).length,
    };
  });
  console.log(`2. Images: ${imgStats.loaded}/${imgStats.total} loaded, ${imgStats.failed} failed`);
  if (imgStats.failed > 0) {
    errors.push(`${imgStats.failed} images failed to load`);
  }

  // 3. TOC 链接验证
  const tocCheck = await page.evaluate(() => {
    const links = [...document.querySelectorAll('.toc a[href^="#"]')];
    const results = [];
    for (const link of links) {
      const target = link.getAttribute('href').slice(1);
      const el = document.getElementById(target);
      if (!el) {
        results.push(`TOC link target not found: ${target}`);
      }
    }
    return { total: links.length, broken: results };
  });
  console.log(`3. TOC links: ${tocCheck.total} total, ${tocCheck.broken.length} broken`);
  if (tocCheck.broken.length > 0) {
    errors.push(...tocCheck.broken);
  }

  // 4. 布局宽度一致性
  const layoutCheck = await page.evaluate(() => {
    const measure = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    };

    const container = measure('.container') || measure('main');
    const cover = measure('.cover');
    const toc = measure('.toc');
    const firstH2 = measure('h2');
    const firstP = measure('h2 + p, .lead');
    const screenshot = measure('.screenshot');

    return { container, cover, toc, firstH2, firstP, screenshot };
  });
  console.log('4. Layout widths:');
  for (const [key, val] of Object.entries(layoutCheck)) {
    if (val) {
      console.log(`   ${key}: left=${val.left} right=${val.right} width=${val.width}`);
    }
  }

  // 检查是否"前面窄后面又很宽了"
  if (layoutCheck.cover && layoutCheck.container) {
    if (Math.abs(layoutCheck.cover.left - layoutCheck.container.left) > 30) {
      warnings.push(`Cover left (${layoutCheck.cover.left}) differs from container left (${layoutCheck.container.left})`);
    }
  }

  // 5. 水平滚动条检测
  const overflow = await page.evaluate(() => {
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      hasHorizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 5,
    };
  });
  console.log(`5. Horizontal scroll: ${overflow.hasHorizontalScroll ? 'YES (PROBLEM)' : 'no'} (${overflow.scrollWidth} vs ${overflow.clientWidth}px)`);
  if (overflow.hasHorizontalScroll) {
    warnings.push('Page has horizontal scrollbar');
  }

  // 6. 残留占位文本
  const placeholders = await page.evaluate(() => {
    const body = document.body.textContent || '';
    return {
      建议截图: body.includes('建议截图'),
      TBD: body.includes('TBD'),
      TODO: body.includes('TODO'),
    };
  });
  const hasPlaceholders = Object.values(placeholders).some(Boolean);
  console.log(`6. Placeholders: ${hasPlaceholders ? 'FOUND' : 'none'}`);
  if (hasPlaceholders) {
    for (const [k, v] of Object.entries(placeholders)) {
      if (v) warnings.push(`Placeholder "${k}" still in text`);
    }
  }

  // 7. 版本号
  const version = await page.evaluate(() => {
    const body = document.body.textContent || '';
    const m = body.match(/v0\.(\d+)\.(\d+)/g);
    return m;
  });
  console.log(`7. Version strings: ${version ? version.join(', ') : 'none found'}`);

  // 8. 截图尺寸
  const imgSizes = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.screenshot-img')];
    const sizes = imgs.map((i) => ({
      w: i.naturalWidth,
      h: i.naturalHeight,
      displayedW: Math.round(i.getBoundingClientRect().width),
    }));
    const widths = [...new Set(sizes.map((s) => s.w))];
    const displayed = [...new Set(sizes.map((s) => s.displayedW))];
    return {
      totalImgs: imgs.length,
      naturalWidths: widths,
      displayedWidths: displayed,
      avgRatio: (sizes.reduce((a, s) => a + s.h / s.w, 0) / sizes.length).toFixed(2),
    };
  });
  console.log(`8. Image dimensions: naturalWidths=${imgSizes.naturalWidths}, displayedWidths=${imgSizes.displayedWidths}`);
  console.log(`   Average aspect ratio (h/w): ${imgSizes.avgRatio}`);

  // 9. 截一张渲染后的全景图用于人工检查
  await page.screenshot({
    path: '/mnt/d/code/deepanalyze/article-screenshots/_verify-full-page.png',
    fullPage: true,
  });
  console.log('9. Full-page screenshot saved: _verify-full-page.png');

  // 汇总
  console.log(`\n${'='.repeat(50)}`);
  if (errors.length > 0) {
    console.log(`ERRORS (${errors.length}):`);
    errors.forEach((e) => console.log(`  ✗ ${e}`));
  } else {
    console.log('No errors.');
  }

  if (warnings.length > 0) {
    console.log(`\nWARNINGS (${warnings.length}):`);
    warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  } else {
    console.log('No warnings.');
  }

  console.log(`\nFinal: ${errors.length === 0 ? 'PASS' : 'FAIL'}`);

  await browser.close();
})();
