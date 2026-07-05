/**
 * E2E Test: Evidence Chain Report Generation & Link Verification
 *
 * 1. Create session with lbctest KB scope
 * 2. Send prompt to trigger evidence-linked-report skill
 * 3. Wait for agent to complete
 * 4. Take screenshots of generated report
 * 5. Expand push content cards (collapsed by default for long content)
 * 6. Click evidence links and verify right panel opens correctly
 */

import { chromium } from 'playwright';

const BACKEND = 'http://localhost:21000';
const FRONTEND = 'http://localhost:21001';
const KB_ID = '9ae696db-3e54-4be4-be6c-b2ceae466fc7';
const KB_NAME = 'lbctest';
const SCREENSHOT_DIR = '/tmp/da-evidence-test';
const TIMEOUT_MS = 45 * 60 * 1000; // 45 min timeout

// Match da-evidence:// links with either kbId/docId (two UUIDs) or just docId (single UUID)
const DA_EVIDENCE_LINK_RE = /da-evidence:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?/gi;
// Match kb:// links with full docId
const KB_LINK_RE = /kb:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

async function createSession(title) {
  const res = await fetch(`${BACKEND}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Create session failed: ${res.status}`);
  const data = await res.json();
  console.log(`  Created session: id=${data.id}`);
  return data;
}

async function setScope(sessionId, scope) {
  const res = await fetch(`${BACKEND}/api/sessions/${sessionId}/scope`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kbScope: scope }),
  });
  if (!res.ok) throw new Error(`Set scope failed: ${res.status}`);
  console.log(`  Set scope for session ${sessionId}`);
}

async function getSession(sessionId) {
  const res = await fetch(`${BACKEND}/api/sessions/${sessionId}`);
  if (!res.ok) throw new Error(`Get session failed: ${res.status}`);
  return await res.json();
}

async function getMessages(sessionId) {
  const res = await fetch(`${BACKEND}/api/sessions/${sessionId}/messages`);
  if (!res.ok) throw new Error(`Get messages failed: ${res.status}`);
  return await res.json();
}

async function deleteSession(sessionId) {
  const res = await fetch(`${BACKEND}/api/sessions/${sessionId}`, { method: 'DELETE' });
  console.log(`  Deleted session ${sessionId} (${res.ok ? 'ok' : 'failed'})`);
}

async function runAgentStream(sessionId, input, scope) {
  const res = await fetch(`${BACKEND}/api/agents/run-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, input, scope }),
  });
  if (!res.ok) throw new Error(`run-stream failed: ${res.status} ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let taskId = null;
  let status = null;
  let totalDeltas = 0;
  let collectedText = '';
  let pushCount = 0;
  let lastLogTime = Date.now();
  let currentEvent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
        continue;
      }
      if (line.startsWith('data: ')) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.taskId && !taskId) {
            taskId = parsed.taskId;
            console.log(`  Task started: ${taskId}`);
          }
          if (parsed.delta) {
            totalDeltas++;
            collectedText += parsed.delta;
          }
          // Handle push_content events — the event name is "push_content"
          // and the data is the push content object directly
          if (currentEvent === 'push_content') {
            pushCount++;
            console.log(`  Push content #${pushCount}: "${parsed.title}" (${parsed.dataLength || 0} chars)`);
          }
          if (parsed.status === 'completed' || parsed.status === 'failed') {
            status = parsed.status;
          }
          if (Date.now() - lastLogTime > 60000) {
            console.log(`  Still streaming... deltas=${totalDeltas}, textLen=${collectedText.length}`);
            lastLogTime = Date.now();
          }
        } catch { /* ignore */ }
      }
      // Reset event name after blank line (end of SSE event)
      if (line.trim() === '') {
        currentEvent = '';
      }
    }
  }

  return { taskId, status, totalDeltas, collectedText, pushCount };
}

// ─── Main Test ──────────────────────────────────────────────────────────────

(async () => {
  const fs = await import('fs');
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  E2E Test: Evidence Chain Report + Link Verification     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`Start: ${new Date().toISOString()}\n`);

  // Verify backend
  try {
    const r = await fetch(`${BACKEND}/api/sessions`);
    if (!r.ok) throw new Error(`Status ${r.status}`);
    console.log('Backend OK\n');
  } catch (e) {
    console.error(`FATAL: Backend unreachable: ${e.message}`);
    process.exit(1);
  }

  // Verify lbctest KB has documents
  try {
    const docsRes = await fetch(`${BACKEND}/api/knowledge/kbs/${KB_ID}/documents?limit=3`);
    if (!docsRes.ok) throw new Error(`Status ${docsRes.status}`);
    const docsData = await docsRes.json();
    const docs = docsData.documents || docsData;
    if (!Array.isArray(docs) || docs.length === 0) {
      throw new Error(`${KB_NAME} KB has no documents`);
    }
    console.log(`  ${KB_NAME} KB: ${docs.length}+ documents (first: ${docs[0]?.filename})\n`);
  } catch (e) {
    console.error(`FATAL: Cannot verify ${KB_NAME} KB: ${e.message}`);
    process.exit(1);
  }

  let sessionId = null;
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('pageerror', err => consoleErrors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    // ── Step 1: Create session and set scope ──────────────────────────
    console.log('Step 1: Create session with lbctest KB...');
    const session = await createSession('E2E Test: Evidence Chain Report');
    sessionId = session.id;

    await setScope(sessionId, {
      knowledgeBases: [{ kbId: KB_ID, mode: 'all' }],
      webSearch: false,
    });

    // Verify scope was persisted
    const sessionCheck = await getSession(sessionId);
    const scopeCheck = typeof sessionCheck.kbScope === 'string'
      ? JSON.parse(sessionCheck.kbScope) : sessionCheck.kbScope;
    const scopeKbIds = scopeCheck?.knowledgeBases?.map(kb => kb.kbId) || [];
    console.log(`  Session kbScope: kbIds=${scopeKbIds.join(',')}`);
    if (!scopeKbIds.includes(KB_ID)) {
      throw new Error(`Session scope doesn't include ${KB_NAME}! Got: ${JSON.stringify(scopeKbIds)}`);
    }

    // ── Step 2: Navigate frontend to session ──────────────────────────
    console.log('\nStep 2: Navigate to session page...');
    await page.goto(`${FRONTEND}/#/sessions/${sessionId}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01_session_initial.png`, fullPage: true });
    console.log('  Screenshot: 01_session_initial.png');

    // ── Step 3: Run agent with evidence-linked-report prompt ──────────
    console.log('\nStep 3: Run agent (evidence-linked-report)...');
    // Explicitly mention the KB ID and name so the agent uses the correct KB
    // Tell agent to NOT use workflow_run/sub-agents so it handles everything directly
    // and uses actual document UUIDs in da-evidence:// links
    const prompt = `请使用司法证据链skill，对当前session关联的知识库 ${KB_NAME} (${KB_ID}) 中的所有文档进行完整的证据链分析。` +
      `重要要求：` +
      `1. 不要使用 workflow_run 派发子Agent，由你自己直接完成所有分析工作。` +
      `2. 使用 kb_search 和 expand 工具查看知识库中的文档，不要使用 run_sql 或 bash 查询其他知识库。` +
      `3. 对每份要引用的文档，先用 expand 展开获取其完整UUID和锚点。` +
      `4. 所有证据引用必须使用 [文字](da-evidence://${KB_ID}/DOC_UUID?anchor=ANCHOR_ID) 格式，其中DOC_UUID和ANCHOR_ID必须从expand结果中逐字复制。` +
      `5. 报告中的每一个事实性陈述都必须有链接到原始证据文档的da-evidence://超链接。` +
      `6. 最后用 push_content 推送最终报告。`;

    const scope = {
      knowledgeBases: [{ kbId: KB_ID, mode: 'all' }],
      webSearch: false,
    };

    const streamResult = await Promise.race([
      runAgentStream(sessionId, prompt, scope),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Test timed out')), TIMEOUT_MS)
      ),
    ]);

    console.log(`\n  Stream complete: status=${streamResult.status}, deltas=${streamResult.totalDeltas}, pushCount=${streamResult.pushCount}`);

    if (streamResult.status === 'failed') {
      throw new Error('Agent task failed');
    }

    // ── Step 4: Reload and take screenshot of report ──────────────────
    console.log('\nStep 4: Reload and screenshot the report...');
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(5000); // Wait for rendering

    // Diagnostic: check frontend state after reload
    const diagAfterReload = await page.evaluate(() => {
      const chatStore = window.__chatStore;
      if (!chatStore) return { error: 'chatStore not exposed on window' };
      const state = chatStore.getState();
      const msgs = state.messages || [];
      return {
        url: window.location.href,
        currentSessionId: state.currentSessionId,
        totalMessages: msgs.length,
        assistantMessages: msgs.filter(m => m.role === 'assistant').map(m => ({
          id: m.id?.substring(0, 8),
          contentLen: m.content?.length || 0,
          hasPushedContents: !!(m.pushedContents?.length),
          pushedContentsCount: m.pushedContents?.length || 0,
          pushedContentDataLens: m.pushedContents?.map(pc => pc.data?.length || 0) || [],
          hasToolCalls: !!(m.toolCalls?.length),
          hasReport: !!m.report,
          isStreaming: m.isStreaming,
        })),
        isSessionLoading: state.isSessionLoading,
        isStreaming: state.isStreaming,
        htmlLen: document.body.innerHTML.length,
        bodyTextSample: document.body.textContent?.substring(0, 300),
      };
    });
    console.log('  Diagnostic after reload:', JSON.stringify(diagAfterReload, null, 2));

    await page.screenshot({ path: `${SCREENSHOT_DIR}/02_report_overview.png`, fullPage: true });
    console.log('  Screenshot: 02_report_overview.png');

    // ── Step 5: Check message content for evidence links ──────────────
    console.log('\nStep 5: Check messages for evidence links...');
    const messages = await getMessages(sessionId);
    const assistantMsgs = messages.filter(m => m.role === 'assistant');
    console.log(`  Total messages: ${messages.length}, assistant: ${assistantMsgs.length}`);

    let totalContent = '';
    let daEvidenceCount = 0;
    let kbEvidenceCount = 0;
    let pushContentCount = 0;
    let pushContentEvidenceLinks = 0;

    for (const msg of assistantMsgs) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      totalContent += content;

      // Check for actual evidence links (relaxed pattern: single or double UUID)
      const daMatches = content.match(DA_EVIDENCE_LINK_RE);
      const kbMatches = content.match(KB_LINK_RE);
      if (daMatches) daEvidenceCount += daMatches.length;
      if (kbMatches) kbEvidenceCount += kbMatches.length;

      // Parse metadata (API returns it as JSON string)
      let metadata = msg.metadata;
      if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
      }

      // Check pushedContents in metadata
      if (metadata?.pushedContents) {
        for (const pc of metadata.pushedContents) {
          pushContentCount++;
          const pcData = pc.data || '';
          const pcDaMatches = pcData.match(DA_EVIDENCE_LINK_RE);
          const pcKbMatches = pcData.match(KB_LINK_RE);
          if (pcDaMatches) { daEvidenceCount += pcDaMatches.length; pushContentEvidenceLinks += pcDaMatches.length; }
          if (pcKbMatches) { kbEvidenceCount += pcKbMatches.length; pushContentEvidenceLinks += pcKbMatches.length; }
          console.log(`  Push content "${pc.title}": type=${pc.type}, ${pcData.length} chars, da-evidence=${pcDaMatches?.length || 0}, kb=${pcKbMatches?.length || 0}`);
        }
      }

      // Also check push_content tool calls (sub-agent tasks store push data in toolCalls)
      const toolCalls = msg.toolCalls || metadata?.toolCalls || [];
      for (const tc of toolCalls) {
        if (tc.toolName === 'push_content') {
          const tcInput = tc.fullInput || {};
          const tcOutput = tc.outputSummary || tc.fullOutput || '';
          // Try to extract push content data from the tool output JSON
          try {
            const outObj = JSON.parse(tcOutput);
            if (outObj.data) {
              pushContentCount++;
              const pcDaMatches = outObj.data.match(DA_EVIDENCE_LINK_RE);
              const pcKbMatches = outObj.data.match(KB_LINK_RE);
              if (pcDaMatches) { daEvidenceCount += pcDaMatches.length; pushContentEvidenceLinks += pcDaMatches.length; }
              if (pcKbMatches) { kbEvidenceCount += pcKbMatches.length; pushContentEvidenceLinks += pcKbMatches.length; }
              console.log(`  Push content (toolCall) "${outObj.title}": ${outObj.data.length} chars, da-evidence=${pcDaMatches?.length || 0}, kb=${pcKbMatches?.length || 0}`);
            }
          } catch {
            // Not JSON or no data field — skip
          }
        }
      }
    }

    console.log(`  Total content: ${totalContent.length} chars`);
    console.log(`  Push content cards: ${pushContentCount}`);
    console.log(`  da-evidence:// links: ${daEvidenceCount} (strict UUID pattern)`);
    console.log(`  kb:// links: ${kbEvidenceCount}`);
    const totalEvidenceLinks = daEvidenceCount + kbEvidenceCount;

    // ── Step 6: Find and click evidence links in the rendered page ────
    console.log('\nStep 6: Find evidence links on page...');

    // Push content cards are collapsed by default when content >= 2000 chars.
    // The collapsed card shows "展开查看完整内容" text that can be clicked.
    // After clicking, the card expands to show markdown content with evidence links.

    // First, try to find and expand all collapsed push content cards
    const expandTexts = await page.$$eval('span', spans =>
      spans
        .filter(s => s.textContent?.includes('展开查看完整内容'))
        .map(s => s.textContent.trim())
    );
    console.log(`  Found ${expandTexts.length} collapsed cards with "展开" text`);

    // Click each "展开查看完整内容" span to expand the cards
    // NOTE: The card header onClick is a TOGGLE (setExpanded(!expanded)),
    // so we must NOT click headers after this — it would collapse the cards again.
    const expandSpans = await page.$$('span');
    for (const span of expandSpans) {
      try {
        const text = await span.textContent();
        if (text?.includes('展开查看完整内容')) {
          await span.click({ timeout: 3000 });
          console.log(`  Expanded a card: "${text.trim().substring(0, 60)}"`);
          await page.waitForTimeout(1000);
        }
      } catch { /* ignore */ }
    }

    // Wait for React re-render and markdown rendering to complete
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03_after_expand.png`, fullPage: true });
    console.log('  Screenshot: 03_after_expand.png');

    // Find evidence links on page (data-evidence-doc attribute)
    const evidenceLinkCount = await page.$$eval('[data-evidence-doc]', els => els.length);
    console.log(`  Evidence links on page: ${evidenceLinkCount}`);

    if (evidenceLinkCount === 0) {
      // Debug: dump page structure with improved diagnostics
      const pageDebug = await page.evaluate(() => {
        // Check markdown-content divs (expanded cards)
        const markdownDivs = document.querySelectorAll('.markdown-content');

        // Check for blue-bordered card wrappers (browser converts hex to rgb)
        const pushCardWrappers = Array.from(document.querySelectorAll('div'))
          .filter(d => {
            const style = d.style;
            return style.border?.includes('3b82f6') || style.border?.includes('rgb(59, 130, 246)');
          });

        // Check for "展开" spans (collapsed cards)
        const allSpans = document.querySelectorAll('span');
        const expandSpans = Array.from(allSpans).filter(s => s.textContent?.includes('展开'));

        // Check for evidence-link class anywhere
        const evidenceLinks = document.querySelectorAll('.evidence-link');
        const evidenceLinkDetails = Array.from(evidenceLinks).slice(0, 5).map(el => ({
          text: el.textContent?.substring(0, 50),
          docId: el.getAttribute('data-evidence-doc')?.substring(0, 12),
          hasHref: el.getAttribute('href'),
        }));

        // Check raw da-evidence:// text in any element
        const daEvidenceRaw = document.body.innerHTML.match(/da-evidence:\/\//g)?.length || 0;

        // Check if any card content area has HTML (expanded state)
        const cardContentHtml = Array.from(markdownDivs).map(d => ({
          textLen: d.textContent?.length || 0,
          htmlLen: d.innerHTML?.length || 0,
          hasEvidenceLink: d.innerHTML.includes('evidence-link'),
          hasDaEvidence: d.innerHTML.includes('da-evidence'),
          htmlSnippet: d.innerHTML.substring(0, 300),
        }));

        // Check non-markdown card content areas (pre-wrap style, used for non-markdown types)
        const nonMarkdownCards = Array.from(document.querySelectorAll('div'))
          .filter(d => d.style.whiteSpace === 'pre-wrap' && d.style.wordBreak === 'break-word')
          .map(d => ({
            textLen: d.textContent?.length || 0,
            textSnippet: d.textContent?.substring(0, 200),
            hasDaEvidence: d.textContent?.includes('da-evidence'),
          }));

        // Check Zustand store
        const chatStore = window.__chatStore;
        let storeInfo = 'store not available';
        if (chatStore) {
          const state = chatStore.getState();
          const asstMsgs = state.messages.filter(m => m.role === 'assistant');
          storeInfo = JSON.stringify({
            msgCount: state.messages.length,
            asstCount: asstMsgs.length,
            asstMsgs: asstMsgs.map(m => ({
              id: m.id?.substring(0, 8),
              contentLen: m.content?.length || 0,
              pushedContents: m.pushedContents?.length || 0,
              pushedContentTypes: m.pushedContents?.map(pc => pc.type) || [],
            })),
          });
        }

        return {
          markdownDivCount: markdownDivs.length,
          cardContentHtml,
          nonMarkdownCards,
          pushCardWrapperCount: pushCardWrappers.length,
          expandSpanCount: expandSpans.length,
          evidenceLinkCount: evidenceLinks.length,
          evidenceLinkDetails,
          daEvidenceRawCount: daEvidenceRaw,
          storeInfo,
        };
      });
      console.log(`  Debug: ${JSON.stringify(pageDebug, null, 2)}`);
    }

    // ── Step 7: Click evidence links and verify preview panel ──────────
    console.log('\nStep 7: Click evidence links and verify preview panel...');
    let clickResults = [];

    // Get all evidence links (prioritize ones with anchor for richer preview)
    const allEvidenceLinks = await page.$$('[data-evidence-doc]');
    const maxClicks = Math.min(allEvidenceLinks.length, 5);

    for (let i = 0; i < maxClicks; i++) {
      const link = allEvidenceLinks[i];
      try {
        const linkText = await link.textContent();
        const docId = await link.getAttribute('data-evidence-doc');
        const kbIdAttr = await link.getAttribute('data-evidence-kb');
        const anchorAttr = await link.getAttribute('data-evidence-anchor');
        console.log(`\n  Clicking link #${i + 1}: text="${linkText?.trim().substring(0, 50)}", docId=${docId?.substring(0, 8)}..., kbId=${kbIdAttr?.substring(0, 8) || 'none'}..., anchor=${anchorAttr?.substring(0, 12) || 'none'}`);

        await link.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await link.click();
        await page.waitForTimeout(2000);

        // Check if evidence preview panel opened
        // The panel is a fixed-position div with width 560px at right:0
        const panelOpen = await page.evaluate(() => {
          const panels = document.querySelectorAll('div');
          for (const el of panels) {
            const style = el.style;
            if (style.position === 'fixed' && style.width === '560px' && style.right === '0px') {
              return true;
            }
          }
          return false;
        });

        // Also check for "Document not found" or error text
        const panelContent = await page.evaluate(() => {
          const panels = document.querySelectorAll('div');
          for (const el of panels) {
            const style = el.style;
            if (style.position === 'fixed' && style.width === '560px' && style.right === '0px') {
              return el.textContent?.substring(0, 200) || '';
            }
          }
          return '';
        });

        const hasError = panelContent.includes('Document not found') || panelContent.includes('加载失败') || panelContent.includes('Failed to');

        // Take screenshot
        const screenshotFile = `${SCREENSHOT_DIR}/04_evidence_click_${i + 1}.png`;
        await page.screenshot({ path: screenshotFile, fullPage: true });
        console.log(`  Screenshot: ${screenshotFile}`);
        console.log(`  Panel open: ${panelOpen}, Has error: ${hasError}`);
        if (panelContent) {
          console.log(`  Panel text: "${panelContent.substring(0, 100)}..."`);
        }

        clickResults.push({
          index: i + 1,
          text: linkText?.trim().substring(0, 50),
          docId: docId,
          kbId: kbIdAttr,
          anchor: anchorAttr,
          panelOpen: panelOpen,
          hasError: hasError,
        });

        // Close preview panel before next click
        if (panelOpen) {
          // Click the overlay to close (fixed div with backgroundColor rgba)
          await page.evaluate(() => {
            const overlays = document.querySelectorAll('div');
            for (const el of overlays) {
              const style = el.style;
              if (style.position === 'fixed' && style.inset === '0px' && style.zIndex === '1400') {
                el.click();
                return;
              }
            }
          });
          await page.waitForTimeout(1000);
        }
      } catch (err) {
        console.log(`  Click #${i + 1} error: ${err.message}`);
        clickResults.push({ index: i + 1, error: err.message });
      }
    }

    // ── Step 8: Summary ───────────────────────────────────────────────
    console.log('\n\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║                    TEST SUMMARY                          ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');

    const passed = [];

    // Check 1: Agent completed
    if (streamResult.status === 'completed') {
      console.log('  ✅ Agent completed successfully');
      passed.push(true);
    } else {
      console.log(`  ❌ Agent status: ${streamResult.status}`);
      passed.push(false);
    }

    // Check 2: Content generated (in messages and push_contents)
    const totalReportContent = totalContent.length + pushContentCount * 1000; // rough estimate
    if (totalContent.length > 500 || pushContentCount > 0) {
      console.log(`  ✅ Content generated: ${totalContent.length} chars text, ${pushContentCount} push content cards`);
      passed.push(true);
    } else {
      console.log(`  ❌ Content too short: ${totalContent.length} chars, 0 push content cards`);
      passed.push(false);
    }

    // Check 3: Evidence links found in content (strict UUID pattern)
    if (totalEvidenceLinks > 0) {
      console.log(`  ✅ Evidence links found: da-evidence://${daEvidenceCount}, kb://${kbEvidenceCount} (strict UUID)`);
      passed.push(true);
    } else {
      console.log('  ❌ No evidence links found in content (strict UUID pattern)');
      passed.push(false);
    }

    // Check 4: Evidence links rendered on page
    if (evidenceLinkCount > 0) {
      console.log(`  ✅ Evidence links rendered on page: ${evidenceLinkCount}`);
      passed.push(true);
    } else {
      console.log('  ❌ No evidence links rendered on page');
      passed.push(false);
    }

    // Check 5: Evidence preview panel opens on click
    const successfulClicks = clickResults.filter(r => r.panelOpen && !r.hasError);
    if (successfulClicks.length > 0) {
      console.log(`  ✅ Evidence preview opens correctly: ${successfulClicks.length}/${clickResults.length} clicks`);
      passed.push(true);
    } else if (clickResults.length > 0) {
      console.log(`  ❌ Evidence preview failed for all ${clickResults.length} clicks`);
      passed.push(false);
    } else {
      console.log('  ⚠️  No clicks tested (no evidence links found on page)');
      passed.push(false);
    }

    // Frontend console errors
    const nonTrivialErrors = consoleErrors.filter(
      e => !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR')
    );
    if (nonTrivialErrors.length > 0) {
      console.log(`\n  ⚠️  Frontend console errors (${nonTrivialErrors.length}):`);
      for (const e of nonTrivialErrors.slice(0, 5)) {
        console.log(`    - ${e.substring(0, 150)}`);
      }
    }

    // Detail click results
    if (clickResults.length > 0) {
      console.log('\n  Click details:');
      for (const r of clickResults) {
        if (r.error) {
          console.log(`    #${r.index}: ERROR - ${r.error}`);
        } else {
          console.log(`    #${r.index}: text="${r.text}" panel=${r.panelOpen} error=${r.hasError}`);
        }
      }
    }

    const allPassed = passed.every(Boolean);
    console.log(`\n  Result: ${allPassed ? 'ALL PASSED ✅' : 'SOME FAILED ❌'} (${passed.filter(Boolean).length}/${passed.length})`);
    console.log(`  End: ${new Date().toISOString()}`);

    if (!allPassed) process.exit(1);

  } catch (err) {
    console.error(`\nFATAL ERROR: ${err.message}`);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/99_error.png`, fullPage: true }).catch(() => {});
    process.exit(1);
  } finally {
    if (sessionId) await deleteSession(sessionId);
    await browser.close();
  }
})();
