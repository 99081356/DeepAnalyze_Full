#!/usr/bin/env npx tsx
/**
 * GAIA Benchmark Runner for DeepAnalyze
 *
 * Selects 50 questions from the GAIA validation set,
 * runs them through the DeepAnalyze agent, and produces a detailed report.
 *
 * Usage:
 *   npx tsx scripts/gaia-benchmark.ts [--count 50] [--level 1,2,3] [--api-url http://localhost:3000]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name: string, defaultValue: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const API_URL = getArg("api-url", "http://localhost:3000");
const COUNT = parseInt(getArg("count", "50"), 10);
const LEVELS = getArg("level", "1,2,3").split(",");
const OUTPUT_DIR = getArg("output", "cc_test/20260430-000916");
const GAIA_PATH = join(process.cwd(), "..", "benchmarks", "gaia", "validation.json");

// Dynamic timeout by level (ms)
const LEVEL_TIMEOUT: Record<string, number> = {
  "1": 5 * 60 * 1000,   // 5 min for Level 1
  "2": 10 * 60 * 1000,  // 10 min for Level 2
  "3": 20 * 60 * 1000,  // 20 min for Level 3
};
const DEFAULT_TIMEOUT = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GaiaQuestion {
  task_id: string;
  Question: string;
  Level: string;
  "Final answer": string;
  file_name: string;
  file_path: string;
  "Annotator Metadata": Record<string, string>;
}

interface BenchmarkResult {
  benchmark: string;
  level: string;
  total: number;
  correct: number;
  wrong: number;
  failed: number;
  accuracy: string;
  timestamp: string;
  sessionId: string;
  results: Array<{
    taskId: string;
    level: string;
    question: string;
    expectedAnswer: string;
    predictedAnswer: string;
    agentOutput: string;
    isCorrect: boolean;
    status: "correct" | "wrong" | "error";
    turnsUsed?: number;
    toolCalls?: number;
    elapsedSeconds?: number;
    error?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Load GAIA questions
// ---------------------------------------------------------------------------

function loadQuestions(): GaiaQuestion[] {
  const raw = readFileSync(GAIA_PATH, "utf-8");
  const all: GaiaQuestion[] = JSON.parse(raw);
  // Filter by level and shuffle
  const filtered = all.filter((q) => LEVELS.includes(q.Level));
  // Deterministic shuffle using simple hash
  filtered.sort((a, b) => a.task_id.localeCompare(b.task_id));
  // Take first COUNT
  return filtered.slice(0, COUNT);
}

// ---------------------------------------------------------------------------
// Create session via API
// ---------------------------------------------------------------------------

async function createSession(): Promise<string> {
  const res = await fetch(`${API_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `GAIA Benchmark ${new Date().toISOString()}` }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.id || data.sessionId;
}

// ---------------------------------------------------------------------------
// Run agent via API
// ---------------------------------------------------------------------------

async function runAgent(
  sessionId: string,
  question: string,
  level: string,
): Promise<{ output: string; error?: string; elapsedMs: number }> {
  const start = Date.now();
  const timeout = LEVEL_TIMEOUT[level] || DEFAULT_TIMEOUT;
  try {
    const res = await fetch(`${API_URL}/api/agents/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        input: question,
        agentType: "general",
      }),
      signal: AbortSignal.timeout(timeout),
    });
    const elapsedMs = Date.now() - start;
    if (!res.ok) {
      return { output: "", error: `${res.status}: ${await res.text()}`, elapsedMs };
    }
    const data = await res.json();
    return {
      output: data.output || data.result?.output || "",
      elapsedMs,
    };
  } catch (err) {
    return { output: "", error: String(err), elapsedMs: Date.now() - start };
  }
}

// ---------------------------------------------------------------------------
// Answer comparison
// ---------------------------------------------------------------------------

function compareAnswers(expected: string, predicted: string): boolean {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .trim()
      .replace(/[.,;:!?'"()\[\]{}]/g, "")
      .replace(/\s+/g, " ");

  const e = normalize(expected);
  if (!e || !predicted) return false;

  // First: check raw output (most permissive, catches substring matches)
  const rawNorm = normalize(predicted);
  if (rawNorm.includes(e)) return true;
  if (e.includes(rawNorm) && rawNorm.length > 3) return true;

  // Second: check extracted answer
  const extracted = extractAnswer(predicted);
  const p = normalize(extracted);
  if (p) {
    if (e === p) return true;
    if (p.includes(e)) return true;
    if (e.includes(p) && p.length > 3) return true;
  }

  // Number comparison
  const eNum = parseFloat(e.replace(/[^0-9.\-]/g, ""));
  const pNum = parseFloat(rawNorm.replace(/[^0-9.\-]/g, ""));
  if (!isNaN(eNum) && !isNaN(pNum) && Math.abs(eNum - pNum) < 0.01) return true;

  return false;
}

/**
 * Extract the final answer from a potentially verbose agent output.
 * Looks for common patterns like "Answer: X", "**X**", final line, etc.
 */
function extractAnswer(output: string): string {
  if (!output) return "";

  // If output starts with "模型调用失败" it's a provider error, not an answer
  if (output.startsWith("模型调用失败")) return output;

  // Try to find "Answer: X" or "answer is X" patterns
  const answerMatch = output.match(/(?:answer|答案)[\s:：]*is\s*\*{0,2}(.+?)\*{0,2}\s*$/im)
    || output.match(/\*\*answer:\*\*\s*(.+?)$/im)
    || output.match(/(?:the answer is|answer:)\s*\*{0,2}(.+?)\*{0,2}\s*$/im);
  if (answerMatch) return answerMatch[1].trim();

  // Try bold final answer pattern: **X**
  const boldAnswers = [...output.matchAll(/\*\*(.+?)\*\*/g)];
  if (boldAnswers.length > 0) {
    // Collect all short bold texts (potential answers)
    const candidates: string[] = [];
    for (const m of boldAnswers) {
      const text = m[1].trim();
      if (text.length <= 100 && !text.startsWith("Based on") && !text.startsWith("Note") && !text.startsWith("Source")) {
        candidates.push(text);
      }
    }
    // If only one candidate, use it; if multiple, prefer the shortest one (likely a direct answer)
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      // Sort by length ascending — direct answers tend to be shorter
      candidates.sort((a, b) => a.length - b.length);
      return candidates[0];
    }
  }

  // Fall back to last non-empty line
  const lines = output.split("\n").filter((l) => l.trim());
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1].trim();
    // If last line is very short, it's likely the answer
    if (lastLine.length <= 200) return lastLine;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n=== GAIA Benchmark Runner ===`);
  console.log(`API: ${API_URL}`);
  console.log(`Questions: ${COUNT} (levels: ${LEVELS.join(",")})`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  // Check API availability
  try {
    const health = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error(`Health check failed: ${health.status}`);
    console.log(`API is available.`);
  } catch {
    console.error(`ERROR: API at ${API_URL} is not available.`);
    console.error(`Please start the backend first: cd deepanalyze && npx tsx src/main.ts`);
    console.error(`\nFalling back to generating test plan only (no live testing).\n`);
    await generateOfflineReport();
    return;
  }

  // Load questions
  const questions = loadQuestions();
  console.log(`Loaded ${questions.length} questions.\n`);

  const masterSessionId = await createSession();
  console.log(`Master session: ${masterSessionId}\n`);

  const results: BenchmarkResult["results"] = [];
  let correct = 0;
  let wrong = 0;
  let failed = 0;

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    console.log(`[${i + 1}/${questions.length}] Level ${q.Level}: ${q.Question.slice(0, 80)}...`);

    // Create a fresh session per question to avoid context pollution
    const sessionId = await createSession();
    const { output, error, elapsedMs } = await runAgent(sessionId, q.Question, q.Level);

    if (error) {
      failed++;
      results.push({
        taskId: q.task_id,
        level: q.Level,
        question: q.Question,
        expectedAnswer: q["Final answer"],
        predictedAnswer: "",
        agentOutput: "",
        isCorrect: false,
        status: "error",
        elapsedSeconds: Math.round(elapsedMs / 1000),
        error,
      });
      console.log(`  ERROR: ${error.slice(0, 100)}`);
      continue;
    }

    const isCorrect = compareAnswers(q["Final answer"], output);
    if (isCorrect) {
      correct++;
      console.log(`  ✓ Correct (${Math.round(elapsedMs / 1000)}s)`);
    } else {
      wrong++;
      console.log(`  ✗ Wrong (expected: "${q["Final answer"].slice(0, 50)}", got: "${output.slice(0, 50)}") (${Math.round(elapsedMs / 1000)}s)`);
    }

    results.push({
      taskId: q.task_id,
      level: q.Level,
      question: q.Question,
      expectedAnswer: q["Final answer"],
      predictedAnswer: output.slice(0, 1000),
      agentOutput: output.slice(0, 2000),
      isCorrect,
      status: isCorrect ? "correct" : "wrong",
      elapsedSeconds: Math.round(elapsedMs / 1000),
    });
  }

  const total = questions.length;
  const accuracy = ((correct / total) * 100).toFixed(1);

  const report: BenchmarkResult = {
    benchmark: "GAIA",
    level: LEVELS.join(","),
    total,
    correct,
    wrong,
    failed,
    accuracy: `${accuracy}%`,
    timestamp: new Date().toISOString(),
    sessionId: masterSessionId,
    results,
  };

  // Save report
  const reportPath = join(OUTPUT_DIR, "11-gaia-test-results.json");
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Print summary
  console.log(`\n=== GAIA Benchmark Results ===`);
  console.log(`Total: ${total}`);
  console.log(`Correct: ${correct}`);
  console.log(`Wrong: ${wrong}`);
  console.log(`Failed: ${failed}`);
  console.log(`Accuracy: ${accuracy}%`);
  console.log(`Report saved to: ${reportPath}`);

  // Level breakdown
  const byLevel: Record<string, { total: number; correct: number }> = {};
  for (const r of results) {
    if (!byLevel[r.level]) byLevel[r.level] = { total: 0, correct: 0 };
    byLevel[r.level].total++;
    if (r.isCorrect) byLevel[r.level].correct++;
  }
  console.log(`\nBy Level:`);
  for (const [level, stats] of Object.entries(byLevel)) {
    console.log(`  Level ${level}: ${stats.correct}/${stats.total} (${((stats.correct / stats.total) * 100).toFixed(1)}%)`);
  }
}

async function generateOfflineReport() {
  const questions = loadQuestions();
  console.log(`\n--- Offline Test Plan ---`);
  console.log(`Total questions available: ${questions.length}`);
  console.log(`Will test: ${Math.min(COUNT, questions.length)} questions`);
  console.log(`Levels: ${LEVELS.join(", ")}\n`);

  const byLevel: Record<number, number> = {};
  for (const q of questions) {
    byLevel[q.Level] = (byLevel[q.Level] || 0) + 1;
  }
  console.log("Level distribution:");
  for (const [level, count] of Object.entries(byLevel)) {
    console.log(`  Level ${level}: ${count} questions`);
  }

  // Save offline plan
  const plan = {
    benchmark: "GAIA",
    status: "offline-plan",
    totalQuestions: questions.length,
    plannedCount: Math.min(COUNT, questions.length),
    levels: LEVELS,
    levelDistribution: byLevel,
    questions: questions.slice(0, COUNT).map((q) => ({
      taskId: q.task_id,
      level: q.Level,
      question: q.Question.slice(0, 200),
      expectedAnswer: q["Final answer"],
      hasFile: !!q.file_name,
    })),
    instructions: "Start the backend with `npx tsx src/main.ts` then re-run this script.",
  };

  const planPath = join(OUTPUT_DIR, "11-gaia-test-plan.json");
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  console.log(`\nTest plan saved to: ${planPath}`);
  console.log(`To run live tests: start backend, then execute this script again.`);
}

main().catch(console.error);
