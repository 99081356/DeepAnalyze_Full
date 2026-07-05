#!/usr/bin/env node
// =============================================================================
// GAIA Benchmark Runner for DeepAnalyze
// Sends GAIA questions via API, collects responses, and evaluates answers
// Usage:
//   node run-gaia-test.mjs                      # Run all 165 tasks
//   node run-gaia-test.mjs --level 1            # Run Level 1 only
//   node run-gaia-test.mjs --first 10           # Run first 10 questions
//   node run-gaia-test.mjs --ids id1,id2,id3    # Run specific task IDs
//   node run-gaia-test.mjs --resume results.json # Skip completed tasks
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const BASE_URL = 'http://localhost:21000';
const GAIA_FILE = path.resolve(import.meta.dirname, 'datasets/gaia_validation.jsonl');
const GAIA_FILES_DIR = path.resolve(import.meta.dirname, 'datasets/gaia_files');
const RESULTS_DIR = path.resolve(import.meta.dirname, 'iteration-results/gaia');

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ─── Parse CLI args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const firstN = getArg('--first') ? parseInt(getArg('--first')) : null;
const levelFilter = getArg('--level') ? parseInt(getArg('--level')) : null;
const resumeFile = getArg('--resume') || null;
const idsArg = getArg('--ids') || null;

// ─── Load GAIA data ──────────────────────────────────────────────────────
const gaiaData = fs.readFileSync(GAIA_FILE, 'utf-8')
  .split('\n').filter(Boolean)
  .map(line => JSON.parse(line));

// Build set of available GAIA files
const availableFiles = new Set();
if (fs.existsSync(GAIA_FILES_DIR)) {
  for (const f of fs.readdirSync(GAIA_FILES_DIR)) {
    availableFiles.add(f);
  }
}

// Filter tasks
let tasks = gaiaData;
if (idsArg) {
  const ids = idsArg.split(',').map(s => s.trim());
  tasks = tasks.filter(t => ids.includes(t.task_id));
} else if (levelFilter) {
  tasks = tasks.filter(t => t.Level === levelFilter);
}
if (firstN) {
  tasks = tasks.slice(0, firstN);
}

// Separate into text-only and file tasks
const textTasks = tasks.filter(t => !t.file_name);
const fileTasks = tasks.filter(t => t.file_name);
const fileTasksAvailable = fileTasks.filter(t => availableFiles.has(t.file_name));
const fileTasksMissing = fileTasks.filter(t => !availableFiles.has(t.file_name));

console.log(`GAIA Benchmark: ${tasks.length} tasks selected`);
console.log(`  Text-only: ${textTasks.length}`);
console.log(`  With files (available): ${fileTasksAvailable.length}`);
console.log(`  With files (missing, skipped): ${fileTasksMissing.length}`);

// ─── Resume support ──────────────────────────────────────────────────────
let completed = new Map();
if (resumeFile) {
  const resumePath = path.resolve(RESULTS_DIR, resumeFile);
  if (fs.existsSync(resumePath)) {
    const prev = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));
    for (const r of prev.results || []) {
      completed.set(r.task_id, r);
    }
    console.log(`Resuming: ${completed.size} tasks already completed`);
  }
}

// ─── Helper: Create knowledge base ───────────────────────────────────────
async function createKB(name) {
  const resp = await fetch(`${BASE_URL}/api/knowledge/kbs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!resp.ok) throw new Error(`Create KB failed: ${resp.status}`);
  return await resp.json();
}

// ─── Helper: Upload file to KB ───────────────────────────────────────────
async function uploadFileToKB(kbId, filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), fileName);

  const resp = await fetch(`${BASE_URL}/api/knowledge/kbs/${kbId}/upload`, {
    method: 'POST',
    body: formData,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Upload failed: ${resp.status} ${text}`);
  }
  return await resp.json();
}

// ─── Helper: Wait for KB document to be ready ────────────────────────────
async function waitForDocReady(kbId, docId, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const resp = await fetch(`${BASE_URL}/api/knowledge/kbs/${kbId}/documents`);
    if (resp.ok) {
      const docs = await resp.json();
      const doc = docs.find(d => d.id === docId || d.documentId === docId);
      if (doc && doc.status === 'ready') return true;
      if (doc && (doc.status === 'error' || doc.status === 'failed')) return false;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

// ─── Helper: Create session ──────────────────────────────────────────────
async function createSession(kbScope) {
  const body = { title: 'GAIA Test' };
  if (kbScope) body.kbScope = kbScope;
  const resp = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Create session failed: ${resp.status}`);
  const data = await resp.json();
  return data.id;
}

// ─── Helper: Run agent and collect full response ─────────────────────────
async function runAgent(sessionId, question) {
  const resp = await fetch(`${BASE_URL}/api/agents/run-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, input: question }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { error: `HTTP ${resp.status}: ${text}` };
  }

  let fullContent = '';
  let toolCalls = [];
  let pushedContents = [];
  let thinkingContent = '';
  let finalOutput = '';
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
      if (line.startsWith(':') || !line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;

      try {
        const payload = JSON.parse(data);
        switch (currentEvent) {
          case 'content_delta':
            if (payload.delta) fullContent += payload.delta;
            break;
          case 'thinking_delta':
            if (payload.delta) thinkingContent += payload.delta;
            break;
          case 'tool_call':
            toolCalls.push({
              tool: payload.toolName,
              input: JSON.stringify(payload.input || {}).slice(0, 300),
            });
            break;
          case 'tool_result':
            toolCalls.push({
              tool: payload.toolName,
              output: (payload.output || '').slice(0, 300),
            });
            break;
          case 'push_content':
            pushedContents.push({
              title: payload.title || '',
              content: (payload.data || payload.content || '').slice(0, 500),
            });
            break;
          case 'done':
            if (payload.output) finalOutput = payload.output;
            break;
          case 'error':
            return { error: payload.error || payload.message || 'Unknown error' };
        }
      } catch { /* ignore parse errors */ }
      currentEvent = '';
    }
  }

  return {
    fullContent,
    finalOutput,
    toolCalls,
    pushedContents,
    thinkingContent,
    totalLength: fullContent.length + pushedContents.reduce((s, p) => s + p.content.length, 0),
  };
}

// ─── Helper: Prepare file task (create KB, upload, wait) ─────────────────
async function prepareFileTask(task) {
  const filePath = path.join(GAIA_FILES_DIR, task.file_name);
  if (!fs.existsSync(filePath)) return null;

  console.log(`  Uploading ${task.file_name} to KB...`);
  const kb = await createKB(`GAIA-${task.task_id.slice(0, 8)}`);
  const doc = await uploadFileToKB(kb.id, filePath);
  console.log(`  KB: ${kb.id}, Doc: ${doc.id || doc.documentId}, waiting...`);

  const ready = await waitForDocReady(kb.id, doc.id || doc.documentId);
  if (!ready) {
    console.log(`  WARNING: Document not ready, proceeding anyway`);
  }

  return {
    sessionId: null, // Will create with KB scope
    kbId: kb.id,
    scope: {
      knowledgeBases: [{ kbId: kb.id }],
      webSearch: true,
    },
  };
}

// ─── Evaluate answers ────────────────────────────────────────────────────
function normalizeAbbreviations(text) {
  return text
    .replace(/\bst\.?\s+petersburg/gi, 'saint petersburg')
    .replace(/\bst\.?\s+paul/gi, 'saint paul')
    .replace(/\bst\.?\s+louis/gi, 'saint louis')
    .replace(/\bst\.?\s+/gi, 'saint ');
}

function evaluateAnswer(output, expected) {
  if (!output || !expected) return false;
  const exp = normalizeAbbreviations(expected.trim().toLowerCase());
  const out = normalizeAbbreviations(output.trim().toLowerCase());

  // Exact match
  if (out === exp) return true;

  // Check if expected answer appears as a standalone token in output
  const expEscaped = exp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\s|[,;:.!?"'\\u201c\\u201d]|\\*\\*|\\|\\(|\\))${expEscaped}(?:$|\\s|[,;:.!?"'\\u201c\\u201d]|\\*\\*|\\|\\(|\\))`, 'i');
  if (re.test(out)) return true;

  // Also check if expected appears as a simple substring (for multi-word answers)
  // This handles cases like "the castle" appearing in quotes or other contexts
  if (exp.includes(' ') && out.includes(exp)) return true;

  // For short answers (1-2 words), also check if they appear in **bold** markdown
  if (exp.split(' ').length <= 2) {
    const boldRe = new RegExp(`\\*\\*${expEscaped}\\*\\*`, 'i');
    if (boldRe.test(out)) return true;
  }

  // Numeric comparison
  const expNum = parseFloat(exp);
  const outNums = out.match(/-?\d+[\d,]*\.?\d*/g);
  if (!isNaN(expNum) && outNums) {
    for (const n of outNums) {
      if (parseFloat(n.replace(/,/g, '')) === expNum) return true;
    }
  }

  // Percentage comparison ("50%" should match "0.5")
  if (exp.endsWith('%')) {
    const pctVal = parseFloat(exp);
    if (!isNaN(pctVal) && outNums) {
      for (const n of outNums) {
        const numVal = parseFloat(n.replace(/,/g, ''));
        if (Math.abs(numVal - pctVal) < 0.01) return true;
        if (Math.abs(numVal * 100 - pctVal) < 0.01) return true;
      }
    }
  }

  return false;
}

// ─── Extract answer from agent output ────────────────────────────────────
function extractAnswer(finalOutput, fullContent) {
  // Priority 1: final output from done event
  if (finalOutput && finalOutput.trim()) return finalOutput.trim();
  // Priority 2: full streaming content
  if (fullContent && fullContent.trim()) return fullContent.trim();
  return '';
}

// ─── Run tests ───────────────────────────────────────────────────────────
const allTasks = [...textTasks, ...fileTasksAvailable];
// Mark missing file tasks as skipped
const skippedResults = fileTasksMissing.map(t => ({
  task_id: t.task_id,
  level: t.Level,
  question: t.Question.slice(0, 200),
  expected: String(t['Final answer']),
  status: 'skipped',
  reason: 'file_not_available',
  file_name: t.file_name,
}));

const results = [];
let correct = 0, wrong = 0, errors = 0, skipped = skippedResults.length;

for (let i = 0; i < allTasks.length; i++) {
  const task = allTasks[i];
  const taskId = task.task_id;

  // Skip completed (resume support)
  if (completed.has(taskId)) {
    console.log(`[${i + 1}/${allTasks.length}] SKIP ${taskId} (already done)`);
    results.push(completed.get(taskId));
    if (completed.get(taskId).match) correct++;
    else if (completed.get(taskId).status === 'completed') wrong++;
    continue;
  }

  console.log(`\n============================================================`);
  console.log(`[${i + 1}/${allTasks.length}] Task ${taskId} (Level ${task.Level})`);
  console.log(`  Q: ${task.Question.slice(0, 150)}`);
  console.log(`  Expected: ${String(task['Final answer']).slice(0, 100)}`);

  const startTime = Date.now();

  try {
    let sessionId;
    let scope = null;

    // Handle file tasks: create KB, upload file, create session with KB scope
    if (task.file_name && availableFiles.has(task.file_name)) {
      const prepared = await prepareFileTask(task);
      if (prepared) {
        scope = prepared.scope;
        sessionId = await createSession(scope);
      } else {
        sessionId = await createSession();
      }
    } else {
      sessionId = await createSession();
    }

    console.log(`  Session: ${sessionId}`);

    const agentResult = await runAgent(sessionId, task.Question);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (agentResult.error) {
      console.log(`  [ERROR] ${agentResult.error.slice(0, 100)} (${elapsed}s)`);
      errors++;
      results.push({
        task_id: taskId,
        level: task.Level,
        question: task.Question.slice(0, 200),
        expected: String(task['Final answer']),
        status: 'error',
        error: agentResult.error.slice(0, 500),
        elapsed: parseFloat(elapsed),
      });
    } else {
      const answer = extractAnswer(agentResult.finalOutput, agentResult.fullContent);
      const match = evaluateAnswer(answer, String(task['Final answer']));

      if (match) correct++;
      else wrong++;

      const tag = match ? 'PASS' : 'FAIL';
      console.log(`  [${tag}] ${agentResult.toolCalls.length} tools, ${elapsed}s`);
      if (!match) {
        console.log(`  Expected: ${String(task['Final answer']).slice(0, 100)}`);
        console.log(`  Got: ${answer.slice(0, 150).replace(/\n/g, ' ')}`);
      }

      results.push({
        task_id: taskId,
        level: task.Level,
        question: task.Question.slice(0, 200),
        expected: String(task['Final answer']),
        status: 'completed',
        output: answer.slice(0, 5000),
        final_output: agentResult.finalOutput || '',
        stream_output: agentResult.fullContent || '',
        output_length: answer.length,
        tool_calls: agentResult.toolCalls,
        tool_calls_count: agentResult.toolCalls.length,
        pushed_contents: agentResult.pushedContents.length,
        elapsed: parseFloat(elapsed),
        match,
        file_name: task.file_name || null,
      });
    }
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  [EXCEPTION] ${err.message} (${elapsed}s)`);
    errors++;
    results.push({
      task_id: taskId,
      level: task.Level,
      question: task.Question.slice(0, 200),
      expected: String(task['Final answer']),
      status: 'error',
      error: err.message,
      elapsed: parseFloat(elapsed),
    });
  }

  // Incremental save every 5 tasks
  if ((i + 1) % 5 === 0) {
    const incTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const incFile = path.join(RESULTS_DIR, `gaia-progress-${incTimestamp}.json`);
    const completed_count = results.filter(r => r.status === 'completed').length;
    fs.writeFileSync(incFile, JSON.stringify({
      timestamp: incTimestamp,
      progress: `${i + 1}/${allTasks.length}`,
      correct, wrong, errors, skipped,
      accuracy: completed_count > 0 ? (correct / completed_count * 100).toFixed(1) + '%' : 'N/A',
      results: [...results, ...skippedResults],
    }, null, 2));
  }
}

// Combine all results
const allResults = [...results, ...skippedResults];

// ─── Compute level stats ─────────────────────────────────────────────────
const levelStats = {};
for (const r of allResults) {
  const lv = r.level || '?';
  if (!levelStats[lv]) levelStats[lv] = { total: 0, correct: 0, wrong: 0, error: 0, skipped: 0 };
  levelStats[lv].total++;
  if (r.match) levelStats[lv].correct++;
  else if (r.status === 'completed') levelStats[lv].wrong++;
  else if (r.status === 'error') levelStats[lv].error++;
  else if (r.status === 'skipped') levelStats[lv].skipped++;
}

// ─── Save results ────────────────────────────────────────────────────────
const completed_count = allResults.filter(r => r.status === 'completed').length;
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const resultFile = path.join(RESULTS_DIR, `gaia-${timestamp}.json`);
const summary = {
  timestamp,
  total: allResults.length,
  completed: completed_count,
  correct,
  wrong,
  errors,
  skipped,
  accuracy: completed_count > 0 ? (correct / completed_count * 100).toFixed(1) + '%' : 'N/A',
  levelStats,
  results: allResults,
};
fs.writeFileSync(resultFile, JSON.stringify(summary, null, 2));

// Also save as latest.json
const latestFile = path.join(RESULTS_DIR, 'latest.json');
fs.writeFileSync(latestFile, JSON.stringify(summary, null, 2));

// ─── Print summary ──────────────────────────────────────────────────────
console.log(`\n============================================================`);
console.log(`GAIA BENCHMARK RESULTS`);
console.log(`============================================================`);
console.log(`Total: ${allResults.length} | Completed: ${completed_count} | Correct: ${correct} | Wrong: ${wrong} | Errors: ${errors} | Skipped: ${skipped}`);
console.log(`Accuracy: ${summary.accuracy}`);
console.log(`\nBy Level:`);
for (const [lv, stats] of Object.entries(levelStats).sort()) {
  const pct = stats.total > 0 ? (stats.correct / stats.total * 100).toFixed(1) : '0.0';
  console.log(`  Level ${lv}: ${stats.correct}/${stats.total} (${pct}%) — correct:${stats.correct} wrong:${stats.wrong} error:${stats.error} skipped:${stats.skipped}`);
}

// List failed tasks
const failed = allResults.filter(r => r.status === 'completed' && !r.match);
if (failed.length > 0) {
  console.log(`\nFailed tasks (${failed.length}):`);
  for (const r of failed) {
    console.log(`  ${r.task_id}: expected="${r.expected.slice(0, 60)}" got="${(r.output || '').slice(0, 60).replace(/\n/g, ' ')}"`);
  }
}

console.log(`\nResults saved to ${resultFile}`);
