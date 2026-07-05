/**
 * DeepAnalyze Agent Iteration Test
 *
 * Tests DA through the frontend UI like a human user.
 * Runs 3 test cases at a time, records full interaction details,
 * evaluates results using LLM-based assessment.
 *
 * Usage:
 *   node tests/e2e/agent-iteration-test.mjs                   # Run first batch (3 cases)
 *   node tests/e2e/agent-iteration-test.mjs --batch 2         # Run second batch
 *   node tests/e2e/agent-iteration-test.mjs --case GAIA-V-e1fc63a2  # Run specific case
 *   node tests/e2e/agent-iteration-test.mjs --all             # Run all cases
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = 'http://localhost:5173';
const BACKEND = 'http://localhost:21000';
const KB_ID = '89ee4db6-0626-4636-8c66-49a575d05832';
const DABSTEP_KB_ID = '0f329774-cc0f-48fe-b5c1-393e3a80bc0a';

// Results directory
const RESULTS_DIR = path.join(__dirname, '..', 'benchmark', 'iteration-results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// Parse args
const args = process.argv.slice(2);
let batchIndex = 0;
let specificCase = null;
let runAll = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--batch' && args[i + 1]) { batchIndex = parseInt(args[i + 1]) - 1; i++; }
  if (args[i] === '--case' && args[i + 1]) { specificCase = args[i + 1]; i++; }
  if (args[i] === '--all') runAll = true;
}

// ─── Test Cases ──────────────────────────────────────────────
// AgencyBench-v2 Research + DABstep test suite
// Dataset: tests/benchmark/datasets/agencybench-dabstep-test.json
const datasetPath = path.join(__dirname, '..', 'benchmark', 'datasets', 'agencybench-dabstep-test.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));

const TEST_CASES = dataset.map(item => ({
  id: item.id,
  category: `${item.source}-${item.category}`,
  question: item.question,
  expectedAnswer: item.expectedAnswer || '',
  evaluationCriteria: item.evaluationCriteria || '',
  level: item.level === 1 ? 'L1' : item.level === 2 ? 'L2' : 'L3',
  source: item.source,
  requiresFiles: item.requiresFiles || false,
  deliverables: item.deliverables || [],
}));

// Select cases to run
let casesToRun;
if (specificCase) {
  casesToRun = TEST_CASES.filter(c => c.id === specificCase);
} else if (runAll) {
  casesToRun = TEST_CASES.filter(c => !c.requiresImage);
} else {
  const eligible = TEST_CASES.filter(c => !c.requiresImage);
  const start = batchIndex * 3;
  casesToRun = eligible.slice(start, start + 3);
}

if (casesToRun.length === 0) {
  console.log('No test cases to run.');
  process.exit(0);
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  DeepAnalyze Agent Iteration Test`);
console.log(`  Batch ${batchIndex + 1} | ${casesToRun.length} cases`);
console.log(`${'═'.repeat(60)}`);

// ─── Helper Functions ────────────────────────────────────────

const wait = ms => new Promise(r => setTimeout(r, ms));

async function createSession(title) {
  const r = await fetch(`${BACKEND}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const d = await r.json();
  return d.id;
}

/**
 * Run a single test case through the backend API + frontend screenshot.
 * Uses SSE streaming to get full agent output.
 */
async function runTestCase(page, testCase) {
  const result = {
    id: testCase.id,
    category: testCase.category,
    level: testCase.level,
    question: testCase.question,
    expectedAnswer: testCase.expectedAnswer,
    startTime: new Date().toISOString(),
    events: [],
    toolCalls: [],
    reasoning: [],
    contentOutput: '',
    pushContents: [],
    endTime: null,
    durationMs: 0,
    status: 'unknown',
    error: null,
    screenshotPaths: [],
  };

  try {
    // Create session via API
    const sessionId = await createSession(`Test: ${testCase.id}`);
    console.log(`  Session: ${sessionId}`);

    // Take a screenshot of the frontend
    try {
      await page.goto(`${FRONTEND}?session=${sessionId}`, { waitUntil: 'networkidle', timeout: 15000 });
      await wait(2000);
      const chatTab = await page.$('button:has-text("对话")');
      if (chatTab) { await chatTab.click(); await wait(1000); }
      await page.screenshot({ path: path.join(RESULTS_DIR, `${testCase.id}-pre.png`), fullPage: true });
    } catch {}

    // Run agent via SSE streaming API (more reliable than browser interception)
    console.log('  Running agent via SSE...');
    const startTime = Date.now();

    const sseResult = await runAgentSSE(sessionId, testCase.question,
      testCase.category.includes('KB') ? KB_ID :
      testCase.source === 'DABstep' ? DABSTEP_KB_ID : null);

    result.durationMs = Date.now() - startTime;
    result.endTime = new Date().toISOString();
    result.status = sseResult.status;
    result.contentOutput = sseResult.content;
    result.pushContents = sseResult.pushContents;
    result.toolCalls = sseResult.toolCalls;
    result.events = sseResult.events;
    result.error = sseResult.error;

    // Navigate to the session in browser for screenshot
    try {
      await page.goto(`${FRONTEND}?session=${sessionId}`, { waitUntil: 'networkidle', timeout: 15000 });
      await wait(2000);
      const chatTab = await page.$('button:has-text("对话")');
      if (chatTab) { await chatTab.click(); await wait(1000); }
      await page.screenshot({ path: path.join(RESULTS_DIR, `${testCase.id}-post.png`), fullPage: true });
    } catch {}

    // Combine all output
    result.allOutput = result.contentOutput || '';
    const pushData = result.pushContents.map(pc => pc.data).filter(d => d).join('\n---\n');
    if (pushData) {
      result.allOutput += '\n\n[PUSH_CONTENT]\n' + pushData;
    }

    console.log(`  Completed in ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Tool calls: ${result.toolCalls.length}`);
    console.log(`  Push contents: ${result.pushContents.length}`);
    console.log(`  Output length: ${(result.contentOutput || '').length} chars`);

  } catch (err) {
    result.status = 'error';
    result.error = err.message;
    console.error(`  Error: ${err.message}`);
  }

  return result;
}

/**
 * Run agent via SSE streaming API and collect all events.
 */
async function runAgentSSE(sessionId, question, kbId) {
  const { Agent: UndiciAgent } = await import('undici');
  const longTimeoutAgent = new UndiciAgent({
    headersTimeout: 60 * 60 * 1000,
    bodyTimeout: 60 * 60 * 1000,
    connect: { timeout: 30_000 },
  });

  const result = {
    status: 'unknown',
    content: '',
    pushContents: [],
    toolCalls: [],
    events: [],
    error: null,
  };

  const body = { sessionId, input: question };
  if (kbId) body.scope = { kbIds: [kbId] };

  try {
    const resp = await fetch(`${BACKEND}/api/agents/run-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      dispatcher: longTimeoutAgent,
    });

    if (!resp.ok) {
      result.status = 'error';
      result.error = `HTTP ${resp.status}`;
      return result;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const contentParts = [];

    // SSE parser: tracks event name across lines
    let currentEvent = '';
    let currentData = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        // SSE comment (keepalive)
        if (line.startsWith(':')) continue;

        // SSE event name
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
          continue;
        }

        // SSE data line (may have multiple data: lines per event)
        if (line.startsWith('data: ')) {
          currentData += line.slice(6);
          continue;
        }

        // Empty line = end of SSE event
        if (line === '' && currentData) {
          try {
            const data = JSON.parse(currentData);
            const eventType = currentEvent;

            result.events.push({ sseEvent: eventType, ...data });

            // Handle each event type using the SSE event name
            switch (eventType) {
              case 'content_delta':
                if (data.delta) contentParts.push(data.delta);
                break;
              case 'turn':
                // Turn events contain accumulated content - don't duplicate with content_delta
                if (data.content) {
                  result.turnContents = result.turnContents || [];
                  result.turnContents.push(data.content);
                }
                break;
              case 'complete':
                if (data.output) result.finalOutput = data.output;
                result.status = 'completed';
                break;
              case 'done':
                if (data.status === 'completed') result.status = 'completed';
                if (data.output) result.finalOutput = data.output;
                break;
              case 'error':
              case 'cancelled':
                result.error = data.error || data.message || `Agent ${eventType}`;
                result.status = eventType === 'cancelled' ? 'cancelled' : 'error';
                break;
              case 'tool_call':
                result.toolCalls.push({
                  tool: data.toolName,
                  args: data.input || data.toolInput,
                });
                const toolInput = data.input || data.toolInput;
                if (data.toolName === 'finish' && toolInput?.summary) {
                  result.finishSummary = toolInput.summary;
                }
                break;
              case 'push_content':
                result.pushContents.push({
                  title: data.title || '',
                  data: (data.data || '').slice(0, 5000),
                });
                break;
            }
          } catch {}
          currentEvent = '';
          currentData = '';
        }
      }
    }

    result.content = contentParts.join('');
    // Priority for output: finalOutput (complete event) > finishSummary > contentParts
    // finalOutput contains the definitive output from the agent
    if (result.finalOutput) {
      // Use finalOutput as primary content (it's the canonical output)
      // Keep contentParts for reference but prefer finalOutput
      if (result.finalOutput.length > result.content.length) {
        result.content = result.finalOutput;
      }
    }
    if (!result.content && result.finishSummary) {
      result.content = result.finishSummary;
    }
    if (result.status !== 'completed' && result.status !== 'error') {
      result.status = 'completed'; // Stream ended without explicit done
    }

  } catch (err) {
    result.status = 'error';
    result.error = err.message;
  }

  return result;
}

/**
 * Evaluate test result using the expected answer and criteria.
 * For now uses string matching; will be enhanced with LLM evaluation.
 */
function evaluateResult(testCase, result) {
  const evaluation = {
    testCaseId: testCase.id,
    expectedAnswer: testCase.expectedAnswer,
    criteria: testCase.evaluationCriteria,
    passed: false,
    score: 0,
    details: '',
  };

  if (result.status !== 'completed') {
    evaluation.details = `Test did not complete: ${result.status}${result.error ? ' - ' + result.error : ''}`;
    return evaluation;
  }

  const output = result.allOutput || result.contentOutput || '';

  if (!output || output.trim().length === 0) {
    evaluation.details = 'Output is empty or too short';
    return evaluation;
  }

  // Check if expected answer appears in output
  const expected = testCase.expectedAnswer;
  // Determine if this is an open-ended expected answer (non-specific)
  const isOpenEnded = !expected || expected === testCase.id ||
    expected.startsWith('Any ') || expected.startsWith('List ') ||
    expected.startsWith('Comparison') || expected.startsWith('Systematic') ||
    expected.startsWith('Weight') || expected.startsWith('Classification') ||
    expected.length > 50; // Long descriptions are open-ended

  if (expected && !isOpenEnded) {
    // Specific expected answer - check if it appears in output
    // Normalize numbers: remove comma separators for matching (17000 matches "17,000")
    const normalizeNum = s => String(s).replace(/,/g, '');
    const outputLower = output.toLowerCase();
    const outputNorm = normalizeNum(outputLower);

    // Support "|" separator: all parts must appear in output
    const parts = String(expected).split('|').map(p => p.trim()).filter(p => p);
    const allFound = parts.every(part => {
      const partLower = part.toLowerCase();
      const partNorm = normalizeNum(partLower);
      return outputLower.includes(partLower) || outputNorm.includes(partNorm);
    });

    if (allFound) {
      evaluation.passed = true;
      evaluation.score = 100;
      evaluation.details = `Found expected answer "${expected}" in output`;
      return evaluation;
    }

    // Try single match for non-"|" expected answers
    const expectedStr = String(expected).toLowerCase();
    const expectedNorm = normalizeNum(expectedStr);
    if (outputLower.includes(expectedStr) || outputNorm.includes(expectedNorm)) {
      evaluation.passed = true;
      evaluation.score = 100;
      evaluation.details = `Found expected answer "${expected}" in output`;
      return evaluation;
    }

    evaluation.details = `Expected "${expected}" not found in output (first 500 chars: ${output.slice(0, 500)})`;
    evaluation.score = 0;
  } else {
    // Open-ended evaluation - check output quality
    // Heuristic: output should be substantial, use tools, and contain structured data
    const hasTable = output.includes('|') && output.includes('---');
    const hasList = output.includes('- ') || output.includes('* ');
    const hasNumbers = /\d+/.test(output);
    const hasToolCalls = result.toolCalls.length > 0;
    const outputLength = output.length;

    let score = 0;
    if (outputLength > 100) score += 20;
    if (outputLength > 300) score += 20;
    if (hasToolCalls) score += 20;
    if (hasTable || hasList) score += 20;
    if (hasNumbers) score += 20;

    evaluation.score = Math.min(score, 100);
    evaluation.passed = score >= 60;
    evaluation.details = `Output quality: ${outputLength} chars, ${result.toolCalls.length} tool calls, hasTable=${hasTable}, hasNumbers=${hasNumbers}`;
  }

  return evaluation;
}

// ─── Main ────────────────────────────────────────────────────

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const batchResults = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (let i = 0; i < casesToRun.length; i++) {
    const tc = casesToRun[i];
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  Test ${i + 1}/${casesToRun.length}: ${tc.id}`);
    console.log(`  Category: ${tc.category} | Level: ${tc.level}`);
    console.log(`  Question: ${tc.question.slice(0, 100)}...`);
    console.log(`${'─'.repeat(50)}`);

    const result = await runTestCase(page, tc);
    const evaluation = evaluateResult(tc, result);

    result.evaluation = evaluation;

    // Print summary
    console.log(`\n  Result: ${evaluation.passed ? 'PASS' : 'FAIL'} (${evaluation.score}%)`);
    console.log(`  Details: ${evaluation.details.slice(0, 200)}`);

    // Print tool call summary
    if (result.toolCalls.length > 0) {
      const toolSummary = {};
      for (const tc of result.toolCalls) {
        toolSummary[tc.tool] = (toolSummary[tc.tool] || 0) + 1;
      }
      console.log(`  Tools used: ${Object.entries(toolSummary).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    }

    // Print reasoning path
    if (result.events.length > 0) {
      const thinkEvents = result.events.filter(e => e.type === 'content_delta' || e.type === 'thinking');
      console.log(`  Reasoning steps: ${thinkEvents.length} thinking blocks`);
    }

    batchResults.push(result);

    // Save intermediate results
    const resultFile = path.join(RESULTS_DIR, `${tc.id}-${timestamp}.json`);
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
    console.log(`  Saved: ${resultFile}`);
  }

  // Print batch summary
  const passed = batchResults.filter(r => r.evaluation?.passed).length;
  const failed = batchResults.filter(r => !r.evaluation?.passed).length;
  const totalDuration = batchResults.reduce((sum, r) => sum + (r.durationMs || 0), 0);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Batch Summary`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Results: ${passed} PASS / ${failed} FAIL`);
  console.log(`  Total time: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log(`  Avg per case: ${casesToRun.length > 0 ? (totalDuration / casesToRun.length / 1000).toFixed(1) : 0}s`);

  // Save batch summary
  const summaryFile = path.join(RESULTS_DIR, `batch-${batchIndex + 1}-${timestamp}.json`);
  fs.writeFileSync(summaryFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    batchIndex: batchIndex + 1,
    cases: casesToRun.length,
    passed,
    failed,
    totalDurationMs: totalDuration,
    results: batchResults.map(r => ({
      id: r.id,
      category: r.category,
      status: r.status,
      durationMs: r.durationMs,
      toolCallCount: r.toolCalls.length,
      outputLength: (r.contentOutput || '').length,
      pushContentCount: r.pushContents.length,
      evaluation: r.evaluation,
    })),
  }, null, 2));

  console.log(`\n  Summary saved: ${summaryFile}`);

  await browser.close();
})();
