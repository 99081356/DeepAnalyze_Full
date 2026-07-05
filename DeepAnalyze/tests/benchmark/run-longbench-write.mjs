#!/usr/bin/env node
// =============================================================================
// LongBench-Write Benchmark Runner for DeepAnalyze
// Tests Agent long-form writing capability
// Usage:
//   node run-longbench-write.mjs --first 10
//   node run-longbench-write.mjs --ids 0,5,12
//   node run-longbench-write.mjs --type "Popular Science"
//   node run-longbench-write.mjs --resume results.json
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE_URL = 'http://localhost:21000';
const DATA_FILE = path.resolve(import.meta.dirname, 'datasets/longbench_write.jsonl');
const RESULTS_DIR = path.resolve(import.meta.dirname, 'iteration-results/longbench-write');

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// ─── Parse CLI args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const firstN = getArg('--first') ? parseInt(getArg('--first')) : null;
const typeFilter = getArg('--type') || null;
const idsFilter = getArg('--ids') ? getArg('--ids').split(',').map(Number) : null;
const resumeFile = getArg('--resume') || null;

// ─── Load data ────────────────────────────────────────────────────────────
const allTasks = fs.readFileSync(DATA_FILE, 'utf-8')
  .split('\n').filter(Boolean)
  .map((line, i) => ({ ...JSON.parse(line), _idx: i }));

let tasks = allTasks;
if (typeFilter) tasks = tasks.filter(t => t.type === typeFilter);
if (idsFilter) tasks = tasks.filter(t => idsFilter.includes(t._idx));

const runTasks = firstN ? tasks.slice(0, firstN) : tasks;

console.log(`LongBench-Write: ${runTasks.length} tasks to run (of ${allTasks.length} total)`);

// ─── Resume support ──────────────────────────────────────────────────────
let completed = new Map();
if (resumeFile) {
  const resumePath = path.resolve(RESULTS_DIR, resumeFile);
  if (fs.existsSync(resumePath)) {
    const prev = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));
    for (const r of prev.results || []) {
      completed.set(r.task_idx, r);
    }
    console.log(`Resuming: ${completed.size} tasks already completed`);
  }
}

// ─── Helper: Create session ──────────────────────────────────────────────
async function createSession() {
  const resp = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'LongBench-Write Test' }),
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
            toolCalls.push({ tool: payload.toolName, input: JSON.stringify(payload.input || {}).slice(0, 200) });
            break;
          case 'tool_result':
            toolCalls.push({ tool: payload.toolName, output: (payload.output || '').slice(0, 200) });
            break;
          case 'push_content':
            pushedContents.push({ title: payload.title || '', content: (payload.data || payload.content || '').slice(0, 2000) });
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

  return { fullContent, finalOutput, toolCalls, pushedContents, thinkingContent };
}

// ─── Evaluation: word count accuracy ─────────────────────────────────────
function evaluateWriting(output, expectedLength) {
  if (!output) return { score: 0, reason: 'No output' };

  // Count both Chinese chars and English words
  const chineseChars = (output.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = (output.replace(/[\u4e00-\u9fff]/g, ' ').match(/[a-zA-Z]+/g) || []).length;
  const totalWords = chineseChars + englishWords;

  // Score based on how close to expected length (±50% is acceptable)
  const ratio = totalWords / expectedLength;
  let lengthScore;
  if (ratio >= 0.5 && ratio <= 2.0) {
    lengthScore = 1.0 - Math.abs(1.0 - ratio) * 0.5;
  } else if (ratio < 0.5) {
    lengthScore = ratio;
  } else {
    lengthScore = Math.max(0, 1.0 - (ratio - 2.0) * 0.3);
  }

  // Check for quality indicators
  const hasStructure = /#{1,3}\s/.test(output) || /\d+\./.test(output);
  const hasParagraphs = output.split('\n\n').length > 2;

  const qualityScore = (hasStructure ? 0.3 : 0) + (hasParagraphs ? 0.3 : 0) + 0.4;
  const finalScore = Math.min(1.0, lengthScore * 0.5 + qualityScore * 0.5);

  return {
    score: Math.round(finalScore * 100),
    totalWords,
    expectedLength,
    ratio: ratio.toFixed(2),
    hasStructure,
    hasParagraphs,
  };
}

// ─── Run tests ───────────────────────────────────────────────────────────
const results = [];

for (let i = 0; i < runTasks.length; i++) {
  const task = runTasks[i];
  const taskIdx = task._idx;

  if (completed.has(taskIdx)) {
    console.log(`[${i + 1}/${runTasks.length}] SKIP idx=${taskIdx} (already done)`);
    results.push(completed.get(taskIdx));
    continue;
  }

  console.log(`\n[${i + 1}/${runTasks.length}] Task idx=${taskIdx} (type=${task.type}, length=${task.length})`);
  console.log(`  Q: ${task.prompt.slice(0, 120)}...`);

  const startTime = Date.now();

  try {
    const sessionId = await createSession();
    console.log(`  Session: ${sessionId}`);

    const agentResult = await runAgent(sessionId, task.prompt);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (agentResult.error) {
      console.log(`  ERROR: ${agentResult.error} (${elapsed}s)`);
      results.push({
        task_idx: taskIdx,
        type: task.type,
        expected_length: task.length,
        prompt: task.prompt.slice(0, 200),
        status: 'error',
        error: agentResult.error,
        elapsed: parseFloat(elapsed),
      });
    } else {
      // Deduplicate: if finalOutput ≈ fullContent, use only one
      const fo = (agentResult.finalOutput || '').trim();
      const so = (agentResult.fullContent || '').trim();
      let mainOutput;
      if (fo && so && (fo.includes(so.slice(0, 100)) || so.includes(fo.slice(0, 100)))) {
        mainOutput = fo.length > so.length ? fo : so;
      } else {
        mainOutput = [fo, so].filter(Boolean).join('\n\n');
      }
      const allOutput = [
        mainOutput,
        ...agentResult.pushedContents.map(p => p.content),
      ].filter(Boolean).join('\n\n');

      const eval_ = evaluateWriting(allOutput, task.length);

      console.log(`  Output: ${allOutput.length} chars, ${eval_.totalWords} words (expected ~${task.length})`);
      console.log(`  Score: ${eval_.score}, Tools: ${agentResult.toolCalls.length} (${elapsed}s)`);
      console.log(`  Preview: ${allOutput.slice(0, 150).replace(/\n/g, ' ')}...`);

      results.push({
        task_idx: taskIdx,
        type: task.type,
        expected_length: task.length,
        prompt: task.prompt.slice(0, 200),
        status: 'completed',
        output: allOutput.slice(0, 5000),
        final_output: agentResult.finalOutput || '',
        stream_output: agentResult.fullContent || '',
        pushed_contents: agentResult.pushedContents.length,
        tool_calls: agentResult.toolCalls.length,
        evaluation: eval_,
        elapsed: parseFloat(elapsed),
      });
    }
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  FAILED: ${err.message} (${elapsed}s)`);
    results.push({
      task_idx: taskIdx,
      type: task.type,
      expected_length: task.length,
      prompt: task.prompt.slice(0, 200),
      status: 'error',
      error: err.message,
      elapsed: parseFloat(elapsed),
    });
  }
}

// ─── Save results ────────────────────────────────────────────────────────
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const resultFile = path.join(RESULTS_DIR, `lbw-${timestamp}.json`);
const completedResults = results.filter(r => r.status === 'completed');
const avgScore = completedResults.length > 0
  ? (completedResults.reduce((s, r) => s + (r.evaluation?.score || 0), 0) / completedResults.length).toFixed(1)
  : 'N/A';

const summary = {
  timestamp,
  total: results.length,
  completed: completedResults.length,
  errors: results.filter(r => r.status === 'error').length,
  avgScore,
  model: 'MiniMax-M3',
  results,
};
fs.writeFileSync(resultFile, JSON.stringify(summary, null, 2));
console.log(`\nResults saved to ${resultFile}`);
console.log(`Total: ${summary.total}, Completed: ${summary.completed}, Errors: ${summary.errors}`);
console.log(`Average Score: ${avgScore}/100`);
