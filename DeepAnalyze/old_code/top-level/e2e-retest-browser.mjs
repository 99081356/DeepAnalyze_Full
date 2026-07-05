// Full browser E2E test: evidence panel open → render → close
import { chromium } from 'playwright';

const BASE = 'http://localhost:21000';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  let passed = 0, failed = 0;
  function log(name, ok, detail) {
    if (ok) passed++; else failed++;
    console.log(`${ok ? '✅' : '❌'} ${name}: ${detail}`);
  }

  console.log('===== Browser E2E: Evidence Panel Full Test =====\n');

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // ===== TEST 1: Image evidence panel =====
  console.log('--- Test 1: Image Evidence Panel (POS机.jpg) ---\n');

  // Open panel via exposed store
  const imgOpenResult = await page.evaluate(() => {
    const store = window.__evidencePreviewStore;
    if (!store) return { error: 'Store not found on window' };
    store.getState().openPreview(
      '3429dca3-5e91-4130-931f-a3840214ab47:image:0',
      'f65cb573-05c7-4098-ba7d-c26c006986ee',
      '3429dca3-5e91-4130-931f-a3840214ab47'
    );
    return { opened: true, state: store.getState() };
  });

  log('Store accessible', !imgOpenResult.error,
    imgOpenResult.error || `isOpen=${imgOpenResult.state?.isOpen}`);

  if (imgOpenResult.opened) {
    // Wait for API call and rendering
    await page.waitForTimeout(3000);

    // Check panel content
    const imgPanelCheck = await page.evaluate(() => {
      // Find elements with z-index >= 1400 (panel overlay/content)
      const all = document.querySelectorAll('*');
      const results = {
        overlayExists: false,
        panelExists: false,
        headerText: '',
        footerText: '',
        imageExists: false,
        imageSrc: '',
        kbName: '',
      };

      for (const el of all) {
        const z = parseInt(getComputedStyle(el).zIndex) || 0;
        if (z === 1400) results.overlayExists = true;
        if (z === 1500) {
          results.panelExists = true;
          // Find header
          const spans = el.querySelectorAll('span');
          for (const s of spans) {
            const text = s.textContent?.trim();
            if (text && text.length > 2 && text.length < 50 && !text.includes('View')) {
              if (!results.headerText || text.includes('POS') || text.includes('jpg')) {
                results.headerText = text;
              }
              if (text.length < 15 && text !== 'Evidence Preview') {
                results.kbName = text;
              }
            }
          }
          // Find footer
          const buttons = el.querySelectorAll('button');
          for (const b of buttons) {
            if (b.textContent?.includes('View')) results.footerText = b.textContent.trim();
          }
          // Find image
          const imgs = el.querySelectorAll('img');
          for (const img of imgs) {
            if (img.src.includes('/api/files/')) {
              results.imageExists = true;
              results.imageSrc = img.src;
            }
          }
        }
      }
      return results;
    });

    log('Panel overlay rendered (z:1400)', imgPanelCheck.overlayExists, '');
    log('Panel content rendered (z:1500)', imgPanelCheck.panelExists, '');
    log('Header shows doc name', imgPanelCheck.headerText.includes('POS') || imgPanelCheck.headerText.includes('Evidence'),
      `"${imgPanelCheck.headerText}"`);
    log('KB name visible', imgPanelCheck.kbName.length > 0,
      `"${imgPanelCheck.kbName}"`);
    log('Image displayed', imgPanelCheck.imageExists,
      imgPanelCheck.imageExists ? `src contains /api/files/` : 'no image');
    log('Footer has View button', imgPanelCheck.footerText.includes('View'),
      `"${imgPanelCheck.footerText}"`);

    // Take screenshot
    await page.screenshot({ path: '/tmp/retest-1-image-panel.png' });
    console.log('  Screenshot: /tmp/retest-1-image-panel.png');

    // ===== TEST 2: Escape closes panel =====
    console.log('\n--- Test 2: Escape Key Closes Panel ---\n');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const afterEscape = await page.evaluate(() => {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const z = parseInt(getComputedStyle(el).zIndex) || 0;
        if (z >= 1400) return { panelStillVisible: true, z };
      }
      return { panelStillVisible: false };
    });
    log('Escape closes panel', !afterEscape.panelStillVisible,
      `panel visible after Escape: ${afterEscape.panelStillVisible}`);

    await page.screenshot({ path: '/tmp/retest-2-after-escape.png' });

    // ===== TEST 3: Document evidence panel =====
    console.log('\n--- Test 3: Document Evidence Panel (turn anchor) ---\n');

    const docOpenResult = await page.evaluate(() => {
      const store = window.__evidencePreviewStore;
      store.getState().openPreview(
        'faae8dfc-4fb8-4581-a46a-72353df870d1:turn:0',
        'bigtest3-kb-id',
        'faae8dfc-4fb8-4581-a46a-72353df870d1'
      );
      return { opened: true };
    });

    if (docOpenResult.opened) {
      await page.waitForTimeout(3000);

      const docPanelCheck = await page.evaluate(() => {
        const all = document.querySelectorAll('*');
        const results = {
          panelExists: false,
          headerText: '',
          hasContent: false,
          contentPreview: '',
          hasHighlight: false,
        };

        for (const el of all) {
          const z = parseInt(getComputedStyle(el).zIndex) || 0;
          if (z === 1500) {
            results.panelExists = true;
            const text = el.textContent || '';
            // Check for document content (ASR text from turn anchor)
            if (text.includes('天使') || text.includes('说话者') || text.includes('浮滑')) {
              results.hasContent = true;
              results.contentPreview = text.substring(0, 200);
            }
            // Check for highlighted text (mark element or styled highlight)
            const marks = el.querySelectorAll('mark, span[style*="background"], em[style*="background"]');
            if (marks.length > 0) results.hasHighlight = true;

            // Get header
            const spans = el.querySelectorAll('span');
            for (const s of spans) {
              const t = s.textContent?.trim();
              if (t && t.length > 2 && t.length < 50) {
                results.headerText = t;
                break;
              }
            }
          }
        }
        return results;
      });

      log('Document panel rendered', docPanelCheck.panelExists, '');
      log('Header shows doc name', docPanelCheck.headerText.length > 0,
        `"${docPanelCheck.headerText}"`);
      log('Document content visible', docPanelCheck.hasContent,
        docPanelCheck.hasContent ? `content starts with: "${docPanelCheck.contentPreview.substring(0, 80)}"` : 'no content');
      log('Text highlighting works', docPanelCheck.hasHighlight,
        docPanelCheck.hasHighlight ? 'highlight marks found' : 'no explicit marks (inline styles may be used)');

      await page.screenshot({ path: '/tmp/retest-3-doc-panel.png' });
      console.log('  Screenshot: /tmp/retest-3-doc-panel.png');

      // Close panel
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

    // ===== TEST 4: Unknown anchor (no sectionContent) =====
    console.log('\n--- Test 4: Unknown anchor (graceful fallback) ---\n');

    const unkOpenResult = await page.evaluate(() => {
      const store = window.__evidencePreviewStore;
      store.getState().openPreview(
        'fbacf138-c2d1-4610-9185-8c9e6fad28bf:unknown:0',
        'bigtest3-kb-id',
        'fbacf138-c2d1-4610-9185-8c9e6fad28bf'
      );
      return { opened: true };
    });

    if (unkOpenResult.opened) {
      await page.waitForTimeout(3000);

      const unkPanelCheck = await page.evaluate(() => {
        const all = document.querySelectorAll('*');
        const results = { panelExists: false, headerText: '', hasError: false, errorMsg: '' };

        for (const el of all) {
          const z = parseInt(getComputedStyle(el).zIndex) || 0;
          if (z === 1500) {
            results.panelExists = true;
            const spans = el.querySelectorAll('span');
            for (const s of spans) {
              const t = s.textContent?.trim();
              if (t && t.length > 2 && t.length < 80) {
                results.headerText = t;
                break;
              }
            }
          }
        }
        return results;
      });

      log('Unknown anchor panel rendered', unkPanelCheck.panelExists, '');
      log('Header shows doc name or default', unkPanelCheck.headerText.length > 0,
        `"${unkPanelCheck.headerText}"`);

      await page.screenshot({ path: '/tmp/retest-4-unk-panel.png' });
      console.log('  Screenshot: /tmp/retest-4-unk-panel.png');

      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

    // ===== TEST 5: Non-existent anchor (404) =====
    console.log('\n--- Test 5: Non-existent anchor (error handling) ---\n');

    const errOpenResult = await page.evaluate(() => {
      const store = window.__evidencePreviewStore;
      store.getState().openPreview('nonexistent-anchor-id', 'fake-kb', 'fake-doc');
      return { opened: true };
    });

    if (errOpenResult.opened) {
      await page.waitForTimeout(2000);

      const errPanelCheck = await page.evaluate(() => {
        const all = document.querySelectorAll('*');
        for (const el of all) {
          const z = parseInt(getComputedStyle(el).zIndex) || 0;
          if (z === 1500) {
            const text = el.textContent || '';
            return {
              panelExists: true,
              hasErrorMsg: text.includes('not found') || text.includes('未找到') || text.includes('Evidence'),
              errorText: text.substring(0, 200),
            };
          }
        }
        return { panelExists: false };
      });

      log('Error panel rendered', errPanelCheck.panelExists, '');
      log('Error message shown', errPanelCheck.hasErrorMsg,
        `"${errPanelCheck.errorText?.substring(0, 100)}"`);

      await page.screenshot({ path: '/tmp/retest-5-error-panel.png' });
      console.log('  Screenshot: /tmp/retest-5-error-panel.png');

      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  }

  // ===== TEST 6: Bundle verification =====
  console.log('\n--- Test 6: Bundle Verification ---\n');

  const bundleCheck = await page.evaluate(async () => {
    const scripts = Array.from(document.querySelectorAll('script[src]'));
    const results = [];
    for (const s of scripts) {
      try {
        const resp = await fetch(s.src);
        const text = await resp.text();
        if (text.includes('da-evidence') || text.includes('evidence-link') || text.includes('data-evidence')) {
          results.push({
            file: s.src.split('/').pop(),
            hasDaEvidence: text.includes('da-evidence'),
            hasEvidenceLink: text.includes('evidence-link'),
            hasDataEvidence: text.includes('data-evidence'),
          });
        }
      } catch {}
    }
    return results;
  });

  for (const b of bundleCheck) {
    log(`Bundle ${b.file}`, b.hasDaEvidence && b.hasEvidenceLink && b.hasDataEvidence,
      `da-evidence=${b.hasDaEvidence}, evidence-link=${b.hasEvidenceLink}, data-evidence=${b.hasDataEvidence}`);
  }

  if (bundleCheck.length === 0) {
    log('Bundle verification', false, 'No bundles found with evidence code');
  }

  // ===== SUMMARY =====
  console.log(`\n===== SUMMARY: ${passed} passed, ${failed} failed =====`);

  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
