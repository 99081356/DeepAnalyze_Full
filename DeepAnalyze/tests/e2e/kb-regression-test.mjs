/**
 * E2E Regression Test: KB Analysis + Web Search
 *
 * Test Case 1: KB analysis with bigtest
 * Test Case 2: KB analysis with lbctest
 * Test Case 3: Web search - AI development report
 *
 * Each test:
 *   - Creates a session
 *   - Sets KB scope or webSearch
 *   - Sends a prompt via SSE stream
 *   - Waits for completion (done event)
 *   - Takes screenshots
 *   - Verifies no errors, content persisted, no flushDraftUpdate failures
 *   - Cleans up session
 */

const { chromium } = require('playwright');

const BACKEND = 'http://localhost:21000';
const FRONTEND = 'http://localhost:21001';
const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per test
const SCREENSHOT_DIR = '/tmp/da-regression-screenshots';

// ─── Utility helpers ────────────────────────────────────────────────────────

async function createSession(title) {
  const res = await fetch(`${BACKEND}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Create session failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  console.log(`  [API] Created session: id=${data.id}, title="${title}"`);
  return data;
}

async function setScope(sessionId, scope) {
  const res = await fetch(`${BACKEND}/api/sessions/${sessionId}/scope`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scope),
  });
  if (!res.ok) throw new Error(`Set scope failed: ${res.status} ${await res.text()}`);
  console.log(`  [API] Set scope for session ${sessionId}: ${JSON.stringify(scope)}`);
}

async function getMessages(sessionId) {
  const res = await fetch(`${BACKEND}/api/sessions/${sessionId}/messages`);
  if (!res.ok) throw new Error(`Get messages failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function deleteSession(sessionId) {
  const res = await fetch(`${BACKEND}/api/sessions/${sessionId}`, { method: 'DELETE' });
  if (!res.ok) {
    console.log(`  [WARN] Delete session ${sessionId} failed: ${res.status}`);
  } else {
    console.log(`  [API] Deleted session ${sessionId}`);
  }
}

/**
 * Run the agent via SSE stream. Returns { taskId, status, totalDeltas, collectedText }
 */
async function runAgentStream(sessionId, input) {
  const res = await fetch(`${BACKEND}/api/agents/run-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, input }),
  });
  if (!res.ok) throw new Error(`run-stream failed: ${res.status} ${await res.text()}`);
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error(`Expected SSE, got: ${res.headers.get('content-type')}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let taskId = null;
  let status = null;
  let totalDeltas = 0;
  let collectedText = '';
  let lastLogTime = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        // next data line will have the payload
        const eventName = line.slice(7).trim();
        // We'll process on data: lines
        continue;
      }
      if (line.startsWith('data: ')) {
        const payload = line.slice(6);
        try {
          const parsed = JSON.parse(payload);

          if (parsed.taskId && !taskId) {
            taskId = parsed.taskId;
            console.log(`  [SSE] Task started: ${taskId}`);
          }

          if (parsed.delta) {
            totalDeltas++;
            collectedText += parsed.delta;
            // Log progress every 30 seconds
            if (Date.now() - lastLogTime > 30000) {
              console.log(`  [SSE] Still streaming... deltas=${totalDeltas}, textLen=${collectedText.length}`);
              lastLogTime = Date.now();
            }
          }

          if (parsed.status === 'completed' || parsed.status === 'failed') {
            status = parsed.status;
            console.log(`  [SSE] Task ${taskId} finished with status: ${status}`);
          }
        } catch {
          // non-JSON data, ignore
        }
      }
    }
  }

  return { taskId, status, totalDeltas, collectedText };
}

/**
 * Check backend log for errors.
 * Returns array of matching lines.
 */
function checkBackendLog(pattern) {
  const fs = require('fs');
  const logPath = '/tmp/da_debug.log';
  if (!fs.existsSync(logPath)) {
    console.log(`  [LOG] ${logPath} does not exist, skipping log check`);
    return [];
  }
  const content = fs.readFileSync(logPath, 'utf-8');
  const lines = content.split('\n').filter(l => pattern.test(l));
  return lines;
}

/**
 * Get the portion of backend log from a given timestamp onwards
 */
function getLogTail() {
  const fs = require('fs');
  const logPath = '/tmp/da_debug.log';
  if (!fs.existsSync(logPath)) return '';
  const stat = fs.statSync(logPath);
  // Read last 5MB max
  const start = Math.max(0, stat.size - 5 * 1024 * 1024);
  const fd = fs.openSync(logPath, 'r');
  const buf = Buffer.alloc(stat.size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString('utf-8');
}

// ─── Test runner ────────────────────────────────────────────────────────────

async function runTest(testName, config) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`TEST: ${testName}`);
  console.log(`${'='.repeat(80)}\n`);

  const result = {
    name: testName,
    passed: false,
    errors: [],
    contentLength: 0,
    screenshotPaths: [],
    sessionId: null,
  };

  // Capture log position before test
  const logBefore = getLogTail().length;

  // Launch browser
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  // Collect console errors from frontend
  const consoleErrors = [];
  page.on('pageerror', err => consoleErrors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    // Step 1: Create session
    console.log('  Step 1: Creating session...');
    const session = await createSession(config.title);
    result.sessionId = session.id;

    // Step 2: Set scope
    console.log('  Step 2: Setting scope...');
    await setScope(session.id, config.scope);

    // Step 3: Navigate frontend to session page and take initial screenshot
    console.log('  Step 3: Navigating frontend...');
    const sessionUrl = `${FRONTEND}/#/sessions/${session.id}`;
    await page.goto(sessionUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {
      console.log('  [WARN] Frontend navigation timeout (non-fatal)');
    });
    await page.waitForTimeout(2000);
    const ssBefore = `${SCREENSHOT_DIR}/${testName.replace(/\s+/g, '_')}_before.png`;
    await page.screenshot({ path: ssBefore, fullPage: true });
    result.screenshotPaths.push(ssBefore);
    console.log(`  Screenshot saved: ${ssBefore}`);

    // Step 4: Run agent via SSE
    console.log('  Step 4: Running agent (SSE stream)...');
    const streamResult = await Promise.race([
      runAgentStream(session.id, config.prompt),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Test timed out after 30 minutes')), TIMEOUT_MS)
      ),
    ]);

    console.log(`  [SSE] deltas: ${streamResult.totalDeltas}, textLen: ${streamResult.collectedText.length}, status: ${streamResult.status}`);

    // Step 5: Take screenshot after completion
    console.log('  Step 5: Taking post-completion screenshot...');
    await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {
      console.log('  [WARN] Frontend reload timeout (non-fatal)');
    });
    await page.waitForTimeout(3000);
    const ssAfter = `${SCREENSHOT_DIR}/${testName.replace(/\s+/g, '_')}_after.png`;
    await page.screenshot({ path: ssAfter, fullPage: true });
    result.screenshotPaths.push(ssAfter);
    console.log(`  Screenshot saved: ${ssAfter}`);

    // Step 6: Verify content via messages API
    console.log('  Step 6: Verifying content...');
    const messages = await getMessages(session.id);
    console.log(`  [API] Got ${messages.length} messages`);

    // Find assistant messages
    const assistantMsgs = messages.filter(m => m.role === 'assistant');
    if (assistantMsgs.length === 0) {
      result.errors.push('No assistant messages found');
    }

    for (const msg of assistantMsgs) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      result.contentLength += content.length;

      // Check for "Agent failed" error
      if (content.includes('Agent failed')) {
        result.errors.push(`"Agent failed" found in assistant message: ${content.substring(0, 200)}`);
      }
    }

    // Verification 1: Content length > 500
    if (result.contentLength <= 500) {
      result.errors.push(`Content too short: ${result.contentLength} chars (expected > 500)`);
    } else {
      console.log(`  [PASS] Content length: ${result.contentLength} chars (> 500)`);
    }

    // Verification 2: No "Agent failed"
    const agentFailedErrors = result.errors.filter(e => e.includes('Agent failed'));
    if (agentFailedErrors.length === 0) {
      console.log(`  [PASS] No "Agent failed" error found`);
    } else {
      console.log(`  [FAIL] "Agent failed" errors: ${agentFailedErrors.length}`);
    }

    // Verification 3: Check SSE stream completed successfully
    if (streamResult.status === 'failed') {
      result.errors.push(`SSE stream ended with status "failed"`);
    } else if (streamResult.status === 'completed') {
      console.log(`  [PASS] SSE stream completed successfully`);
    } else {
      result.errors.push(`SSE stream ended with unexpected status: ${streamResult.status}`);
    }

    // Verification 4: Check backend log for flushDraftUpdate errors
    console.log('  Step 7: Checking backend log for errors...');
    const logContent = getLogTail();
    const flushErrors = logContent.split('\n').filter(l =>
      l.includes('flushDraftUpdate failed') || l.includes('invalid input syntax')
    );
    // Only count errors that appeared after test start (approximation: just check recent ones)
    if (flushErrors.length > 0) {
      // Show last few
      const recentFlushErrors = flushErrors.slice(-5);
      result.errors.push(`Backend log has ${flushErrors.length} "flushDraftUpdate failed" or "invalid input syntax" errors`);
      console.log(`  [FAIL] Backend log errors found: ${flushErrors.length}`);
      for (const fe of recentFlushErrors) {
        console.log(`    ${fe.substring(0, 200)}`);
      }
    } else {
      console.log(`  [PASS] No "flushDraftUpdate failed" or "invalid input syntax" errors in backend log`);
    }

    // Frontend console errors (informational, not fail criterion)
    if (consoleErrors.length > 0) {
      console.log(`  [INFO] Frontend console errors: ${consoleErrors.length}`);
      const nonTrivial = consoleErrors.filter(
        e => !e.includes('favicon') && !e.includes('ResizeObserver') && !e.includes('net::ERR')
      );
      if (nonTrivial.length > 0) {
        console.log(`  [INFO] Non-trivial frontend errors:`);
        for (const e of nonTrivial.slice(0, 5)) {
          console.log(`    - ${e.substring(0, 150)}`);
        }
      }
    }

    // Determine pass/fail
    result.passed = result.errors.length === 0;

  } catch (err) {
    result.errors.push(`Exception: ${err.message}`);
    result.passed = false;
    console.error(`  [ERROR] ${err.message}`);
    // Try to take error screenshot
    try {
      const ssError = `${SCREENSHOT_DIR}/${testName.replace(/\s+/g, '_')}_error.png`;
      await page.screenshot({ path: ssError, fullPage: true });
      result.screenshotPaths.push(ssError);
    } catch { /* ignore */ }
  } finally {
    // Cleanup: delete session
    if (result.sessionId) {
      console.log(`  Step 8: Cleaning up session...`);
      await deleteSession(result.sessionId);
    }
    await browser.close();
  }

  // Report
  console.log(`\n  ─── RESULT: ${result.passed ? 'PASS' : 'FAIL'} ───`);
  console.log(`  Content length: ${result.contentLength}`);
  console.log(`  Screenshots: ${result.screenshotPaths.join(', ')}`);
  if (result.errors.length > 0) {
    console.log(`  Errors:`);
    for (const e of result.errors) {
      console.log(`    - ${e}`);
    }
  }
  console.log('');

  return result;
}

// ─── Main ───────────────────────────────────────────────────────────────────

(async () => {
  const fs = require('fs');

  // Ensure screenshot dir exists
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║     DA E2E Regression Tests - KB Analysis + Web Search          ║');
  console.log('║     Backend: http://localhost:21000                              ║');
  console.log('║     Frontend: http://localhost:21001                             ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`Start time: ${new Date().toISOString()}`);

  // Verify backend is reachable
  try {
    const health = await fetch(`${BACKEND}/api/sessions`);
    if (!health.ok) throw new Error(`Status: ${health.status}`);
    console.log('Backend is reachable.\n');
  } catch (err) {
    console.error(`FATAL: Backend not reachable at ${BACKEND}: ${err.message}`);
    process.exit(1);
  }

  const results = [];

  // ── Test Case 1: KB analysis with bigtest ──────────────────────────────
  results.push(await runTest('TC1_KB_bigtest', {
    title: 'Regression TC1: KB analysis bigtest',
    scope: {
      knowledgeBases: [{
        kbId: '60346710-913d-4b54-b742-499da76cd85b',
        mode: 'all',
      }],
      webSearch: false,
    },
    prompt: '现在请你分析知识库文档的全部内容，分析清楚所有内容的主要分类关系，从属关系，分析清楚每一类，每一块知识的相关性。针对论文，请给出一份详细的分析报告分析这些论文的技术演进关系，分析不同技术的优劣势，预测未来核心的研究方向和建议，给出详细的分析报告。如果是剧本杀，请分析整个剧本的关系，找出明确的杀手和时间线推理关系，找出所有证据链条和推理逻辑链条，每个剧本杀单独给出详细的完整故事脉络和逻辑关系推理。如果是表格，详细统计分析表格内容和数据情况。其他类型也自定义不同需求，对整个知识库进行全面深入完整的分析与整理。',
  }));

  // ── Test Case 2: KB analysis with lbctest ──────────────────────────────
  results.push(await runTest('TC2_KB_lbctest', {
    title: 'Regression TC2: KB analysis lbctest',
    scope: {
      knowledgeBases: [{
        kbId: '9ae696db-3e54-4be4-be6c-b2ceae466fc7',
        mode: 'all',
      }],
      webSearch: false,
    },
    prompt: '1.详细分析整个案件，按人，时，地，事，物的关键信息梳理，整理完整的案件介绍。\n2.还原整个案件完整的时间线关系，给出所有案件推理和证据证明材料。\n3.梳理资金关系和流向，明确分析资金转移情况，核对受害人的资金损失情况。\n4.给出量刑标准和法规指引，并对每个量刑项目给出全部证据关联材料信息。\n5.使用司法证据链标准的skill，输出符合司法证据链要求的文档报告。',
  }));

  // ── Test Case 3: Web search - AI development report ────────────────────
  results.push(await runTest('TC3_WebSearch_AI_Report', {
    title: 'Regression TC3: Web search AI report',
    scope: {
      knowledgeBases: [],
      webSearch: true,
    },
    prompt: '给我写一个最新的AI发展综述的详细技术报告，截至到当前时间，包括所有技术模块，演进方向，主要问题，处理方法等等详细信息，基于最新的deepseek，Qwen，kimi，minimax等国内模型的技术报告和论文。完成后再基于详细技术报告写一个完善的ppt。',
  }));

  // ─── Summary ────────────────────────────────────────────────────────────
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║                        FINAL SUMMARY                            ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');

  let allPassed = true;
  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    console.log(`  ${status} | ${r.name} | content=${r.contentLength} chars | screenshots=${r.screenshotPaths.length}`);
    if (!r.passed) {
      allPassed = false;
      for (const e of r.errors) {
        console.log(`         ERROR: ${e}`);
      }
    }
  }

  console.log('');
  const passCount = results.filter(r => r.passed).length;
  console.log(`  Total: ${passCount}/${results.length} passed`);
  console.log(`  End time: ${new Date().toISOString()}`);
  console.log('');

  if (!allPassed) {
    console.log('!!! SOME TESTS FAILED !!!');
    process.exit(1);
  } else {
    console.log('All tests passed.');
    process.exit(0);
  }
})();
