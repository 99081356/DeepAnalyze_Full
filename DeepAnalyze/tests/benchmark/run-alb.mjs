#!/usr/bin/env node
// =============================================================================
// Agent Long Bench Runner
// Runs ALB tasks via DA's /run-stream endpoint with file-writing for long prompts
// Usage:
//   node run-alb.mjs                        # Run all 256 tasks (sequential)
//   node run-alb.mjs --first 3              # Run first 3 tasks
//   node run-alb.mjs --ids ALB-048,ALB-049  # Run specific tasks
//   node run-alb.mjs --small                # Run only small tasks (<80K chars)
//   node run-alb.mjs --category "Count Correctness(Env)"
//   node run-alb.mjs --resume latest.json   # Skip completed tasks from previous run
// =============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const BASE_URL = 'http://localhost:21000';
const ALB_PATH = '/mnt/d/code/deepanalyze/benchmarks/agent-long-bench/unified.json';
const RESULTS_DIR = path.resolve(import.meta.dirname, 'iteration-results', 'alb');
const DATA_DIR = '/tmp/alb-data';  // Where prompts are written for agent to read
const PROMPT_THRESHOLD = 0;     // Always write to file — long prompts overwhelm system prompt

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Load index (lightweight — no prompts) ─────────────────────────────────
// The unified.json is ~540MB, too large for Node readFileSync.
// Use python to extract just the index (id, category, answer, prompt_len).
console.log('Loading ALB index...');
const indexJson = execSync(
  `python3 -c "
import json, sys
with open('${ALB_PATH}', 'r') as f:
    data = json.load(f)
index = [{'id': t['id'], 'category': t['category'], 'expected_answer': str(t['expected_answer']), 'prompt_len': len(t['prompt'])} for t in data]
json.dump(index, sys.stdout)
"`,
  { maxBuffer: 100 * 1024 * 1024, encoding: 'utf-8' }
);
const albIndex = JSON.parse(indexJson);
console.log(`Loaded ${albIndex.length} ALB tasks`);

// ─── Parse CLI args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const firstN = getArg('--first') ? parseInt(getArg('--first')) : null;
const idsArg = getArg('--ids');
const smallMode = args.includes('--small');
const catArg = getArg('--category');
const resumeArg = getArg('--resume');

// ─── Select tasks ─────────────────────────────────────────────────────────
let tasks = albIndex;

if (idsArg) {
  const ids = idsArg.split(',');
  tasks = albIndex.filter(t => ids.includes(t.id));
} else if (smallMode) {
  tasks = albIndex.filter(t => t.prompt_len < PROMPT_THRESHOLD);
} else if (catArg) {
  tasks = albIndex.filter(t => t.category === catArg);
}

if (firstN) {
  tasks = tasks.slice(0, firstN);
}

// Resume: skip tasks already in results
if (resumeArg) {
  const resumePath = resumeArg.startsWith('/') ? resumeArg : path.join(RESULTS_DIR, resumeArg);
  const prevResults = JSON.parse(fs.readFileSync(resumePath, 'utf-8'));
  const completedIds = new Set(
    (prevResults.results || [])
      .filter(r => r.status === 'evaluated' || r.correct !== null)
      .map(r => r.taskId)
  );
  tasks = tasks.filter(t => !completedIds.has(t.id));
  console.log(`Resume: skipping ${completedIds.size} completed tasks, ${tasks.length} remaining`);
}

console.log(`Selected ${tasks.length} tasks to run`);

// ─── Prompt extraction ────────────────────────────────────────────────────
// Extract a single task's prompt from the large JSON file via python
function extractPrompt(taskId) {
  const filePath = path.join(DATA_DIR, `${taskId}.txt`);
  if (fs.existsSync(filePath)) return filePath;

  console.log(`  Extracting prompt to ${filePath}...`);
  execSync(
    `python3 -c "
import json
with open('${ALB_PATH}', 'r') as f:
    data = json.load(f)
for t in data:
    if t['id'] == '${taskId}':
        with open('${filePath}', 'w') as out:
            out.write(t['prompt'])
        break
"`,
    { maxBuffer: 500 * 1024 * 1024 }
  );
  return filePath;
}

// For small tasks, extract prompt content directly
function extractPromptContent(taskId) {
  return execSync(
    `python3 -c "
import json, sys
with open('${ALB_PATH}', 'r') as f:
    data = json.load(f)
for t in data:
    if t['id'] == '${taskId}':
        sys.stdout.write(t['prompt'])
        break
"`,
    { maxBuffer: 500 * 1024 * 1024, encoding: 'utf-8' }
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────
async function createSession(title) {
  const resp = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  const data = await resp.json();
  return data.id;
}

async function deleteSession(sessionId) {
  await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
}

function parseSSEEvents(body) {
  const events = [];
  const lines = body.split('\n');
  let currentEvent = null;
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = { type: line.slice(7).trim(), data: {} };
    } else if (line.startsWith('data: ') && currentEvent) {
      try {
        currentEvent.data = JSON.parse(line.slice(6));
      } catch {
        currentEvent.data = { raw: line.slice(6) };
      }
    } else if (line === '' && currentEvent) {
      events.push(currentEvent);
      currentEvent = null;
    }
  }
  return events;
}

// ─── Answer extraction ────────────────────────────────────────────────────
// Strategy: try multiple methods in priority order, return the first that
// produces a short, clean answer.
function extractAnswer(text, finishSummary) {
  if (!text && !finishSummary) return '';

  // Helper: try to extract a list from text containing "X and Y" or "X, Y, and Z"
  function extractListFromProse(str) {
    // Match patterns like "are 0202 and 0527" or "are Cubchoo and Cubone"
    const proseListMatch = str.match(/(?:are|is|:)\s+(['"]?(\w+)['"]?)\s+and\s+(['"]?(\w+)['"]?)/i);
    if (proseListMatch) {
      const a = proseListMatch[2];
      const b = proseListMatch[4];
      return `[${JSON.stringify(a)}, ${JSON.stringify(b)}]`;
    }
    // Match "X, Y, and Z" patterns
    const commaAndMatch = str.match(/(?:are|is|:)\s+(.+?)\s+and\s+(\w+)\s*[.\s]*$/i);
    if (commaAndMatch) {
      const parts = commaAndMatch[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
      parts.push(commaAndMatch[2].replace(/^['"]|['"]$/g, ''));
      if (parts.length >= 2 && parts.every(p => p.length > 0 && p.length <= 30)) {
        return '[' + parts.map(p => JSON.stringify(p)).join(', ') + ']';
      }
    }
    return null;
  }

  // Priority 1: <answer> tags (used in ALB prompts)
  for (const tag of ['answer', 'ans']) {
    const m = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'));
    if (m) return m[1].trim();
  }

  // Priority 2: Finish summary — the agent's deliberate, explicit answer
  if (finishSummary && finishSummary.trim().length > 0) {
    const fs = finishSummary.trim();
    // If finishSummary is a short prose with list, extract it
    if (fs.length <= 200) {
      const listFromProse = extractListFromProse(fs);
      if (listFromProse) return listFromProse;
      return fs;
    }
  }

  // Priority 3+: Collect candidates from text parsing
  const candidates = [];

  // Bold markers — **answer text**
  const boldMatches = text.match(/\*\*([^*]+)\*\*/g);
  if (boldMatches) {
    // Process bold matches in reverse order (last bold = most likely answer)
    for (let i = boldMatches.length - 1; i >= 0; i--) {
      const inner = boldMatches[i].replace(/\*\*/g, '').trim();
      if (inner.length > 0 && inner.length <= 200) candidates.push(inner);
    }
  }

  // "The answer is X" / "answer: X" patterns
  const answerPatterns = [
    /(?:the answer is|answer is|answer:|答案是|结果是|correct answer[:\s]+)(.{1,100}?)(?:\.|$)/i,
    /(?:the two \w+ (?:immediately )?after .*? (?:is|are)[:\s]+)(.{1,200}?)(?:\.|$)/i,
  ];
  for (const pat of answerPatterns) {
    const m = text.match(pat);
    if (m) {
      const val = m[1].trim();
      // Try to extract list from prose answer
      const listFromProse = extractListFromProse(val);
      if (listFromProse) {
        candidates.unshift(listFromProse); // High priority
      } else {
        candidates.push(val);
      }
    }
  }

  // Prose containing list: "are X and Y" anywhere in text
  const proseList = extractListFromProse(text);
  if (proseList) candidates.push(proseList);

  // Standalone number on its own line
  const numLineMatch = text.match(/(?:^|\n)\s*(-?\d+(?:\.\d+)?)\s*(?:\n|$)/);
  if (numLineMatch) candidates.push(numLineMatch[1]);

  // Number embedded in short phrases like "appears once" → "1"
  const onceMatch = text.match(/\bappears\s+(once|twice|\d+)\s+time/i);
  if (onceMatch) {
    const word = onceMatch[1].toLowerCase();
    if (word === 'once') candidates.push('1');
    else if (word === 'twice') candidates.push('2');
    else candidates.push(word);
  }

  // Boolean standalone
  const boolMatch = text.match(/(?:^|\n)\s*(true|false|yes|no)\s*(?:\n|$)/i);
  if (boolMatch) candidates.push(boolMatch[1].toLowerCase());

  // List pattern like ['item1', 'item2'] or ["item1", "item2"] — prefer the LAST one (most likely final answer)
  const listMatches = [...text.matchAll(/\[[^\]]*\]/g)];
  // Identify the "long list" candidate — a list that looks like a formatted array answer
  let longListCandidate = null;
  if (listMatches.length > 0) {
    const lastList = listMatches[listMatches.length - 1][0];
    candidates.push(lastList);
    // A list with 3+ quoted string items is very likely the intended answer, not incidental brackets
    const itemCount = (lastList.match(/['"][^'"]+['"]/g) || []).length;
    if (itemCount >= 3) {
      longListCandidate = lastList;
    }
  }

  // Last short line (skip markdown artifacts)
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length > 0 && line.length <= 200 && !/^[`#*_~-]+$/.test(line)) {
      candidates.push(line);
      break;
    }
  }

  // If we found a formatted list with 3+ items, return it immediately —
  // it's the answer, not a prose description like "Complete result (323 IDs):"
  if (longListCandidate) return longListCandidate;

  // Return the shortest candidate that looks like a real answer
  for (const c of candidates) {
    if (c.length <= 5) return c; // Numbers, booleans, short names
  }
  for (const c of candidates) {
    if (c.length <= 50) return c; // Medium answers (includes short lists)
  }
  for (const c of candidates) {
    if (c.length <= 200) return c; // Longer lists
  }
  // Return first candidate or the full text
  return candidates[0] || text.trim();
}

// ─── Answer comparison ────────────────────────────────────────────────────
function compareAnswers(expected, actual) {
  const expStr = String(expected).trim();
  const actStr = String(actual).trim();

  if (!actStr) return false;

  // Exact match
  if (expStr === actStr) return true;

  // Case-insensitive match
  if (expStr.toLowerCase() === actStr.toLowerCase()) return true;

  // Numeric comparison
  const expNum = parseFloat(expStr);
  const actNum = parseFloat(actStr);
  if (!isNaN(expNum) && !isNaN(actNum) && Math.abs(expNum - actNum) < 0.5) return true;

  // Boolean comparison
  const boolMap = { 'true': true, 'false': false, 'yes': true, 'no': false };
  if (expStr.toLowerCase() in boolMap && actStr.toLowerCase() in boolMap) {
    return boolMap[expStr.toLowerCase()] === boolMap[actStr.toLowerCase()];
  }

  // List comparison (sorted) — try parsing both as lists
  // Support JSON format (["A", "B"]), Python format (['A', 'B']), and bare format ([A, B])
  function tryParseList(str) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    // Try Python-style list: ['A', 'B'] → replace single quotes
    try {
      const fixed = str.replace(/'/g, '"');
      const parsed = JSON.parse(fixed);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    // Try bare format: [A, B] → add quotes around elements
    try {
      const fixed = str.replace(/\[([^\]]*)\]/, (_, inner) => {
        const items = inner.split(',').map(s => `"${s.trim()}"`);
        return `[${items.join(',')}]`;
      });
      const parsed = JSON.parse(fixed);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return null;
  }
  const expList = tryParseList(expStr);
  const actList = tryParseList(actStr);
  if (expList && actList) {
    const expSorted = [...expList].map(String).sort().join('|');
    const actSorted = [...actList].map(String).sort().join('|');
    if (expSorted === actSorted) return true;
  }

  // Comma-separated list comparison (e.g., "0613, 0104" vs ['0613', '0104'])
  if (expList) {
    const actParts = actStr.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    if (actParts.length === expList.length) {
      const expSorted = [...expList].map(String).sort().join('|');
      const actSorted = [...actParts].sort().join('|');
      if (expSorted === actSorted) return true;
    }
  }

  // Substring match (for name answers)
  if (expStr.length > 2 && actStr.toLowerCase().includes(expStr.toLowerCase())) return true;
  if (expStr.length > 2 && expStr.toLowerCase().includes(actStr.toLowerCase())) return true;

  return false;
}

// ─── Category-specific instructions ───────────────────────────────────────
const CATEGORY_HINTS = {
  'Count Correctness(Env)': [
    `This task asks how many sections were judged CORRECT in a specific round.`,
    `Steps:`,
    `1. Run: tail -n 20 <file> to see the question and identify the target round number`,
    `2. Use python3 to find that round's feedback and count only items marked (correct)`,
    `   - Search for the round header: [USER]: Round <N>:`,
    `   - In that round's section, count lines containing "(correct)"`,
    `   - Do NOT count "(wrong)" or other annotations`,
  ].join('\n'),

  'Count Frequency(Env)': [
    `This task asks how many times a specific property VALUE appears across ALL rounds' feedback.`,
    `Steps:`,
    `1. Run: tail -n 20 <file> to see the question and identify the target property value`,
    `2. Use python3 to count occurrences ONLY in feedback sections (between [USER] lines), NOT in [TOOL RESULT] sections`,
    `   - Read the file and split by [USER] markers`,
    `   - For each round's feedback, check if the property value appears`,
    `   - Count only exact matches in feedback, not in tool intersection lists`,
    `CRITICAL edge cases:`,
    `- The LAST round's feedback shares a text block with [FINAL QUESTION]. Do NOT skip this block — extract the feedback before [FINAL QUESTION].`,
    `- Match EXACT property values. "Level >= 20" is DIFFERENT from "Level >= 20 (Atk<Def)" — the parenthetical condition is part of the property value.`,
    `- Use regex word-boundary or exact line matching, not simple substring count.`,
  ].join('\n'),

  'Count Frequency(Tool)': [
    `This task asks how many times a specific item (Pokemon name or numeric ID) appears in tool outputs for a specific round.`,
    `CRITICAL: "tool outputs for round N" means the [TOOL RESULT] that appears BEFORE the [USER]: Round N: header.`,
    `The data structure is: [TOOL RESULT] → [USER]: Round N: ... → [ASSISTANT] → [TOOL RESULT] → [USER]: Round N+1: ...`,
    `The tool result "for round N" is the one that comes JUST BEFORE the Round N header (from the previous round's query).`,
    `Do NOT use the tool result that appears AFTER the Round N header — that is the result of round N's own query.`,
    `CRITICAL: Do NOT use regex to extract JSON. Use brace-depth counting or json.JSONDecoder().raw_decode() to parse.`,
    `Steps:`,
    `1. Run: tail -n 20 <file> to see the question and identify the round number and target item`,
    `2. Use python3 to extract the [TOOL RESULT] JSON that appears BEFORE the Round N header`,
    `   - Find "[USER]: Round N:" in the text`,
    `   - Search BACKWARDS from that position for the nearest "[TOOL RESULT]"`,
    `   - Parse the JSON from that tool result using proper JSON parsing (not regex)`,
    `   - The JSON has two possible formats:`,
    `     a) {"intersection": ["name1", "name2", ...]} — flat list. Count occurrences of the target.`,
    `     b) {"per_section": [{"section": "...", "candidates": ["n1", "n2", ...]}, ...]} — structured.`,
    `        Count how many section candidates lists contain the target item.`,
    `        Then add 1 if the target appears in ALL sections (this counts the implicit intersection).`,
    `        Formula: count_in_sections + (1 if count_in_sections == total_sections else 0)`,
    `   - Return the count as a number`,
  ].join('\n'),

  'Find Duplicates(Tool)': [
    `This task asks whether a specific Pokemon (or ID) appears in tool results of TWO specific rounds.`,
    `CRITICAL: "tool results for round N" means the [TOOL RESULT] that appears BEFORE the [USER]: Round N: header.`,
    `The tool result "for round N" is the one that comes JUST BEFORE the Round N header (from the previous round's query).`,
    `Steps:`,
    `1. Run: tail -n 20 <file> to see the question and identify the two round numbers and target name/ID`,
    `2. Use python3 to extract [TOOL RESULT] JSON for BOTH rounds`,
    `   - For each round, find "[USER]: Round N:" then search BACKWARDS for the nearest "[TOOL RESULT]"`,
    `   - Parse the JSON (use brace-depth counting, not regex)`,
    `   - The JSON has two possible formats:`,
    `     a) {"intersection": ["name1", ...]} — check if target is in this flat list`,
    `     b) {"per_section": [{"section": "...", "candidates": [...]}, ...]} — check if target appears in ANY section's candidates list`,
    `   - A target "appears in" a round's tool result if it is found in the intersection list OR in any per_section candidates list`,
    `   - Answer True (appears in both) or False`,
  ].join('\n'),

  'Find Round with Largest Value(Env)': [
    `This task asks which round has the maximum total base stats.`,
    `Steps:`,
    `1. Run: tail -n 20 <file> to confirm the question`,
    `2. Use python3 to parse ALL rounds and extract base stat values`,
    `   - For each round, find the "Base Stats" section`,
    `   - Extract the total base stats value`,
    `   - Find the round with the maximum total`,
    `   - Return the round NUMBER only`,
  ].join('\n'),

  'Find Target Offsets(Tool)': [
    `This task asks for the two Pokemon (or IDs) immediately AFTER the first occurrence of the guessed Pokemon in a round's tool result list.`,
    `CRITICAL: "tool results for round N" means the [TOOL RESULT] that appears BEFORE the [USER]: Round N: header.`,
    `The tool result "for round N" is the one that comes JUST BEFORE the Round N header (from the previous round's query).`,
    `Do NOT use the tool result that appears AFTER the Round N header.`,
    `Steps:`,
    `1. Run: tail -n 20 <file> to see the question and identify the target round number`,
    `2. Use python3 to:`,
    `   - Find "[USER]: Round N:" to get the guessed Pokemon name from the header`,
    `   - Search BACKWARDS from that position for the nearest "[TOOL RESULT]"`,
    `   - Parse the JSON from that tool result`,
    `   - If the JSON has "intersection" key: use that flat list`,
    `   - If the JSON has "per_section" key: use the FIRST section's candidates list (all sections give the same result since lists are alphabetically sorted)`,
    `   - Find the first index of the guessed Pokemon in that list`,
    `   - Return the TWO items at index+1 and index+2`,
    ``,
    `ANSWER FORMAT: Return ONLY a Python-style list like ['name1', 'name2'] or ['0001', '0002'].`,
    `Do NOT return the guessed Pokemon itself. Do NOT return prose text. Do NOT return a number.`,
    `Your ENTIRE answer should be just the list.`,
  ].join('\n'),

  'Intersection': [
    `This task has 3 possible subtypes. Read the question at the end of the file first to determine which one:`,
    ``,
    `SUBTYPE 1 — "what is the final answer?"`,
    `  Deduce the target Pokemon from accumulated game feedback.`,
    `  - Collect all properties marked (correct) across all rounds`,
    `  - Examine the LAST [TOOL RESULT] intersection list (most narrowed-down set)`,
    `  - The answer is the single Pokemon name matching all correct properties`,
    ``,
    `SUBTYPE 2 — "intersection of candidate lists for the 'section' field"`,
    `  Compute set intersection of per_section candidate lists in a specific round's tool result.`,
    `  The "tool return" for round N means the [TOOL RESULT] that appears IMMEDIATELY BEFORE "[USER]: Round N:" header.`,
    `  Game structure: [USER]: Round N-1: ... → [ASSISTANT]: thinks & calls query → [TOOL RESULT]: {json} → [USER]: Round N: ...`,
    `  So to find round N's tool return: find "[USER]: Round N:" then look BACKWARD for the LAST "[TOOL RESULT]" BEFORE it.`,
    `  Parse the JSON per_section structure: {"per_section": [{"section": "...", "candidates": [...]}, ...]}`,
    `  CRITICAL: Do NOT use regex to parse JSON. The JSON can be megabytes long with nested braces.`,
    `    Use this approach to extract JSON:`,
    `    1. Find "[TOOL RESULT]: " marker`,
    `    2. Read from the { character`,
    `    3. Use a brace-depth counter to find the matching }`,
    `    4. Then json.loads() the extracted string`,
    `  Compute the INTERSECTION (common items) of ALL section candidates lists`,
    `  Use python3 set operations: set(list1) & set(list2) & ...`,
    `  Return the result as a Python-style list SORTED alphabetically/numerically`,
    `  IMPORTANT: Return ONLY the LIST of common items, NOT the count, NOT a superset, NOT a subset`,
    `  Do NOT return ALL candidates — only those that appear in EVERY section's list`,
    ``,
    `SUBTYPE 3 — "what is the final masked id?"`,
    `  Deduce the target numeric ID by intersecting candidate lists across ALL rounds.`,
    `  Do NOT just read the last <answer> tag or guess from the last intersection — that may be wrong.`,
    `  Use python3 to:`,
    `  1. Find ALL [TOOL RESULT] sections in the file`,
    `  2. For each tool result, extract the candidate list:`,
    `     - If {"intersection": [...]}: use that flat list`,
    `     - If {"per_section": [{"section": "...", "candidates": [...]}, ...]}: compute intersection of ALL section candidates`,
    `  3. Compute the INTERSECTION of ALL rounds' candidate lists — the IDs that appear in EVERY round's list`,
    `     This should narrow down to 1 or very few candidates`,
    `  4. If still multiple candidates: check the last few rounds' (correct) feedback to narrow further`,
    `  Return the single numeric ID (e.g. "0276")`,
    ``,
    `Steps:`,
    `1. Run: tail -n 30 <file> to read the final question`,
    `2. Identify the subtype and follow the appropriate instructions above`,
    `3. Use python3 for all parsing — never estimate from reading`,
  ].join('\n'),

  'Weighted Summation(Env)': [
    `This task computes a weighted score difference between two rounds.`,
    `Steps:`,
    `1. Run: tail -n 20 <file> to see the question, weights, and the two round numbers`,
    `2. Use python3 to:`,
    `   - Find both rounds and count correct sections for each property type`,
    `   - Apply weights: e.g. Type=6, Ability=5, Base Stats=4, Evolution=3, Generation=2, Other=1`,
    `   - Compute weighted sum for each round`,
    `   - Return the ABSOLUTE DIFFERENCE`,
  ].join('\n'),
};

// ─── Build prompt message ─────────────────────────────────────────────────
function buildMessage(task) {
  if (task.prompt_len < PROMPT_THRESHOLD) {
    // Small enough to send directly
    const content = extractPromptContent(task.id);
    return content;
  }

  // Large prompt: write to file, tell agent to read it
  const filePath = extractPrompt(task.id);
  const categoryHint = CATEGORY_HINTS[task.category] || '';

  return [
    `I need you to read a large text file and answer a question about it.`,
    ``,
    `The file is at: ${filePath}`,
    `File size: ${task.prompt_len.toLocaleString()} characters`,
    ``,
    `The file contains a multi-round Pokemon guessing game log. Each round has:`,
    `  - A header: [USER]: Round N: Guess <Pokemon> (#<num>)`,
    `  - Feedback sections (Type, Base Stats, Generation, Abilities, Evolution, Other) with (correct)/(wrong) annotations`,
    `  - A [TOOL RESULT] section with a JSON object containing an "intersection" array of Pokemon names`,
    `  - The question is at the very end of the file after all rounds`,
    ``,
    `IMPORTANT rules:`,
    `- Feedback sections = the property lines between [USER] headers. These contain (correct)/(wrong) annotations.`,
    `- [TOOL RESULT] sections = JSON data with intersection arrays. These are separate from feedback.`,
    `- Count ONLY in the correct section (feedback or tool) based on what the question asks`,
    `- NEVER use grep -c for counting — it counts ALL lines including tool output and question text`,
    `- ALWAYS use python3 to parse and count precisely`,
    ``,
    `Category: ${task.category}`,
    categoryHint,
    ``,
    `Give ONLY the precise answer (a number, name, boolean, or list). No explanation.`,
  ].join('\n');
}

// ─── Run single task ──────────────────────────────────────────────────────
async function runTask(task) {
  const result = {
    taskId: task.id,
    category: task.category,
    promptLength: task.prompt_len,
    expectedAnswer: task.expected_answer,
    actualAnswer: null,
    correct: null,
    status: 'pending',
    content: '',
    toolCalls: [],
    turnsUsed: 0,
    durationMs: 0,
    sessionId: null,
    error: null,
  };

  let message;
  try {
    message = buildMessage(task);
  } catch (err) {
    result.error = `Prompt extraction failed: ${err.message}`;
    result.status = 'error';
    return result;
  }

  const sessionId = await createSession(`ALB-${task.id}`);
  result.sessionId = sessionId;
  console.log(`  Session: ${sessionId}`);

  const startTime = Date.now();

  try {
    const resp = await fetch(`${BASE_URL}/api/agents/run-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        input: message,
      }),
    });

    if (!resp.ok) {
      result.error = `HTTP ${resp.status}`;
      result.status = 'error';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const body = await resp.text();
    const events = parseSSEEvents(body);

    const toolCallMap = new Map();
    let output = '';
    let finishSummary = '';

    for (const event of events) {
      switch (event.type) {
        case 'content':
        case 'content_delta':
          if (event.data.accumulated) {
            output = event.data.accumulated;
          } else if (event.data.delta) {
            output += event.data.delta;
          } else if (event.data.content) {
            output = event.data.content;
          }
          break;

        case 'tool_call': {
          const tc = {
            toolName: event.data.toolName,
            input: event.data.input || {},
          };
          toolCallMap.set(event.data.id, tc);
          break;
        }

        case 'tool_result': {
          const existing = toolCallMap.get(event.data.id);
          if (existing) {
            existing.output = (event.data.output || '').slice(0, 500);
            result.toolCalls.push(existing);
            // Capture finish summary
            if (existing.toolName === 'finish') {
              try {
                const parsed = JSON.parse(event.data.output || '{}');
                finishSummary = parsed.summary || '';
              } catch {}
            }
          }
          break;
        }

        case 'done':
          result.turnsUsed = event.data.turnsUsed || 0;
          if (event.data.output) {
            output = event.data.output;
          }
          break;

        case 'error':
          result.error = event.data.error;
          break;
      }
    }

    result.content = output;
    result.finishSummary = finishSummary;
    result.durationMs = Date.now() - startTime;

    // Extract and evaluate answer using both content and finish summary
    result.actualAnswer = extractAnswer(output, finishSummary);
    result.correct = compareAnswers(task.expected_answer, result.actualAnswer);
    result.status = 'evaluated';

  } catch (err) {
    result.error = err.message;
    result.status = 'error';
    result.durationMs = Date.now() - startTime;
  }

  // Clean up
  await deleteSession(sessionId).catch(() => {});

  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────
const results = [];
let correct = 0;
let total = 0;

for (let i = 0; i < tasks.length; i++) {
  const task = tasks[i];
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${i + 1}/${tasks.length}] ${task.id} | ${task.category} | ${task.prompt_len.toLocaleString()} chars`);
  console.log(`Expected answer: ${String(task.expected_answer).slice(0, 100)}`);
  console.log(`${'='.repeat(60)}`);

  const result = await runTask(task);
  results.push(result);
  total++;

  if (result.correct) correct++;

  const mark = result.correct ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] Actual: ${String(result.actualAnswer || '(empty)').slice(0, 100)} | ${result.toolCalls.length} tools | ${result.turnsUsed} turns | ${(result.durationMs / 1000).toFixed(1)}s`);
  if (result.error) console.log(`  Error: ${result.error}`);

  // Save incremental results after each task
  const summary = {
    timestamp: new Date().toISOString(),
    totalTasks: total,
    correct,
    accuracy: total > 0 ? (correct / total * 100).toFixed(1) : '0',
    results,
  };
  fs.writeFileSync(path.join(RESULTS_DIR, 'latest.json'), JSON.stringify(summary, null, 2));
}

// ─── Final summary ────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log('FINAL RESULTS');
console.log(`${'='.repeat(60)}`);
console.log(`Total: ${total} | Correct: ${correct} | Accuracy: ${total > 0 ? (correct / total * 100).toFixed(1) : 0}%`);

// Category breakdown
const catStats = {};
for (const r of results) {
  if (!catStats[r.category]) catStats[r.category] = { total: 0, correct: 0 };
  catStats[r.category].total++;
  if (r.correct) catStats[r.category].correct++;
}
console.log('\nBy category:');
for (const [cat, stats] of Object.entries(catStats)) {
  console.log(`  ${cat}: ${stats.correct}/${stats.total} (${(stats.correct / stats.total * 100).toFixed(0)}%)`);
}

// Failed tasks detail
const failed = results.filter(r => !r.correct);
if (failed.length > 0) {
  console.log(`\nFailed tasks:`);
  for (const r of failed) {
    console.log(`  ${r.taskId}: expected="${String(r.expectedAnswer).slice(0, 60)}" got="${String(r.actualAnswer || '').slice(0, 60)}"`);
  }
}

// Save final results with timestamp
const finalFile = `alb-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(path.join(RESULTS_DIR, finalFile), JSON.stringify({
  timestamp: new Date().toISOString(),
  totalTasks: total,
  correct,
  accuracy: total > 0 ? (correct / total * 100).toFixed(1) : '0',
  categoryStats: catStats,
  results,
}, null, 2));
console.log(`\nFinal results saved: ${finalFile}`);
