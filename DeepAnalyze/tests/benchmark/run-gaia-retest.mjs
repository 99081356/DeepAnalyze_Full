#!/usr/bin/env node
// =============================================================================
// GAIA Benchmark Re-test Runner - Re-runs specific failed task IDs
// Usage:
//   node run-gaia-retest.mjs --ids id1,id2,id3
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE_URL = 'http://localhost:21000';
const GAIA_FILE = path.resolve(import.meta.dirname, 'datasets/gaia_validation.jsonl');
const RESULTS_DIR = path.resolve(import.meta.dirname, 'iteration-results/gaia');

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// Parse CLI args
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const idsArg = getArg('--ids');
const levelFilter = getArg('--level') ? parseInt(getArg('--level')) : null;

// Load GAIA data
const gaiaData = fs.readFileSync(GAIA_FILE, 'utf-8')
  .split('\n').filter(Boolean)
  .map(line => JSON.parse(line));

let tasks;
if (idsArg) {
  const ids = idsArg.split(',').map(s => s.trim());
  tasks = gaiaData.filter(t => ids.includes(t.task_id));
} else if (levelFilter) {
  tasks = gaiaData.filter(t => t.Level === levelFilter && !t.file_path);
} else {
  tasks = gaiaData.filter(t => !t.file_path);
}

console.log(`GAIA Retest: ${tasks.length} tasks`);

// Session helper
async function createSession() {
  const resp = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'GAIA Retest' }),
  });
  if (!resp.ok) throw new Error(`Create session failed: ${resp.status}`);
  const data = await resp.json();
  return data.id;
}

// Agent runner with SSE parsing
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
            toolCalls.push({ tool: payload.toolName, input: JSON.stringify(payload.input || {}).slice(0, 200) });
            break;
          case 'tool_result':
            toolCalls.push({ tool: payload.toolName, output: (payload.output || '').slice(0, 200) });
            break;
          case 'push_content':
            pushedContents.push({ title: payload.title || '', content: (payload.data || payload.content || '').slice(0, 500) });
            break;
          case 'done':
            if (payload.output) finalOutput = payload.output;
            break;
          case 'error':
            return { error: payload.error || payload.message || 'Unknown error' };
        }
      } catch { /* ignore */ }
      currentEvent = '';
    }
  }

  return {
    fullContent, finalOutput, toolCalls, pushedContents, thinkingContent,
    totalLength: fullContent.length + pushedContents.reduce((s, p) => s + p.content.length, 0),
  };
}

// Evaluate
function evaluateAnswer(output, expected) {
  if (!output || !expected) return false;
  const exp = expected.trim().toLowerCase();
  const out = output.trim().toLowerCase();
  if (out === exp) return true;
  const expEscaped = exp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\s|[,;:.!?]|\\*\\*|\\|)${expEscaped}(?:$|\\s|[,;:.!?]|\\*\\*|\\|)`, 'i');
  if (re.test(out)) return true;
  const expNum = parseFloat(exp);
  const outNums = out.match(/-?\d+[\d,]*\.?\d*/g);
  if (!isNaN(expNum) && outNums) {
    for (const n of outNums) {
      if (parseFloat(n.replace(/,/g, '')) === expNum) return true;
    }
  }
  return false;
}

// Run
const results = [];
let correct = 0, wrong = 0;

for (let i = 0; i < tasks.length; i++) {
  const task = tasks[i];
  console.log(`\n[${i + 1}/${tasks.length}] Task ${task.task_id} (Level ${task.Level})`);
  console.log(`  Q: ${task.Question.slice(0, 120)}...`);
  console.log(`  Expected: ${String(task['Final answer']).slice(0, 100)}`);

  const startTime = Date.now();
  try {
    const sessionId = await createSession();
    console.log(`  Session: ${sessionId}`);
    const agentResult = await runAgent(sessionId, task.Question);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (agentResult.error) {
      console.log(`  ERROR: ${agentResult.error} (${elapsed}s)`);
      results.push({
        task_id: task.task_id, level: task.Level,
        question: task.Question.slice(0, 200),
        expected: String(task['Final answer']),
        status: 'error', error: agentResult.error,
        elapsed: parseFloat(elapsed),
      });
    } else {
      const allOutput = [
        agentResult.finalOutput || '',
        agentResult.fullContent || '',
        ...agentResult.pushedContents.map(p => p.content),
      ].join('\n\n');

      const match = evaluateAnswer(allOutput, String(task['Final answer']));
      if (match) correct++; else wrong++;
      console.log(`  ${match ? 'OK' : 'MISS'}: ${allOutput.length} chars, ${agentResult.toolCalls.length} tools (${elapsed}s)`);
      console.log(`  Final: ${(agentResult.finalOutput || '').slice(0, 120)}`);

      results.push({
        task_id: task.task_id, level: task.Level,
        question: task.Question.slice(0, 200),
        expected: String(task['Final answer']),
        status: 'completed',
        output: allOutput.slice(0, 5000),
        final_output: agentResult.finalOutput || '',
        stream_output: agentResult.fullContent || '',
        output_length: allOutput.length,
        tool_calls: agentResult.toolCalls.length,
        pushed_contents: agentResult.pushedContents.length,
        elapsed: parseFloat(elapsed), match,
      });
    }
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  FAILED: ${err.message} (${elapsed}s)`);
    results.push({
      task_id: task.task_id, level: task.Level,
      question: task.Question.slice(0, 200),
      expected: String(task['Final answer']),
      status: 'error', error: err.message,
      elapsed: parseFloat(elapsed),
    });
  }
}

// Save
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const resultFile = path.join(RESULTS_DIR, `gaia-retest-${timestamp}.json`);
const summary = {
  timestamp, total: results.length,
  completed: results.filter(r => r.status === 'completed').length,
  errors: results.filter(r => r.status === 'error').length,
  correct, wrong,
  accuracy: results.filter(r => r.status === 'completed').length > 0
    ? (correct / results.filter(r => r.status === 'completed').length * 100).toFixed(1) + '%'
    : 'N/A',
  results,
};
fs.writeFileSync(resultFile, JSON.stringify(summary, null, 2));
console.log(`\nResults saved to ${resultFile}`);
console.log(`Total: ${summary.total}, Correct: ${correct}, Wrong: ${wrong}, Accuracy: ${summary.accuracy}`);
