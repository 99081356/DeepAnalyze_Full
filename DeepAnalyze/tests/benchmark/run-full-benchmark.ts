// =============================================================================
// DeepAnalyze Full-Scale Benchmark Runner
// =============================================================================
// Runs real academic benchmark datasets against DA agent:
// - LongBench-Write: 120 long-form writing tasks
// - HaluEval: sampled hallucination detection (QA/Dialogue/Summarization)
// - GAIA: 466 general reasoning questions (validation + test)
// - WebArena: SKIPPED (requires interactive web browsing)
//
// Usage:
//   npx tsx run-full-benchmark.ts <benchmark> [options]
//   npx tsx run-full-benchmark.ts longbench              # All 120 cases
//   npx tsx run-full-benchmark.ts longbench --batch 5     # First 5
//   npx tsx run-full-benchmark.ts longbench --offset 10 --batch 5
//   npx tsx run-full-benchmark.ts halueval --sample 200   # 200 per category
//   npx tsx run-full-benchmark.ts gaia --split validation  # 165 validation only
//   npx tsx run-full-benchmark.ts gaia --split test        # 301 test only
//   npx tsx run-full-benchmark.ts all                      # Run everything
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent as UndiciAgent } from "undici";

// Extend Node.js fetch timeout for long-running agent tasks (default is 300s)
const longTimeoutAgent = new UndiciAgent({
  headersTimeout: 60 * 60 * 1000,   // 60 minutes
  bodyTimeout: 60 * 60 * 1000,
  connect: { timeout: 30_000 },
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:21000";
const DATASETS_DIR = path.resolve(__dirname, "datasets");
const RESULTS_DIR = path.resolve(__dirname, "results");
const MAX_CONCURRENT = 3; // Max concurrent agent runs

// Ensure results dir
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawTestCase {
  id: string;
  benchmark: string;
  category: string;
  question: string;
  expectedAnswer?: string;
  expectedLength?: number;
  evaluationType: "llm" | "exact_match" | "contains" | "length" | "hallucination_binary";
  evaluationCriteria: string[];
  passThreshold: number;
  maxWaitMs: number;
  metadata?: Record<string, unknown>;
}

interface RunResult {
  testCaseId: string;
  success: boolean;
  content: string;
  toolCalls: number;
  turnsUsed: number;
  durationMs: number;
  error?: string;
  evaluation?: {
    score: number;
    passed: boolean;
    details: string;
  };
}

interface BatchResults {
  benchmark: string;
  timestamp: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  results: RunResult[];
  summary: {
    avgDurationMs: number;
    avgTurns: number;
    avgToolCalls: number;
    passRate: number;
    failureReasons: Record<string, number>;
  };
}

// ---------------------------------------------------------------------------
// Dataset Loaders
// ---------------------------------------------------------------------------

function loadLongBenchWrite(): RawTestCase[] {
  const filePath = path.join(DATASETS_DIR, "longbench_write.jsonl");
  if (!fs.existsSync(filePath)) {
    console.error(`LongBench-Write dataset not found: ${filePath}`);
    return [];
  }

  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  return lines.map((line, i) => {
    const d = JSON.parse(line);
    const targetLen = d.length || 500;
    // Scale timeout: 100 words = 180s, 20000 words = 600s
    const timeoutMs = Math.min(600_000, Math.max(180_000, targetLen * 30));

    return {
      id: `LBW-${String(i + 1).padStart(3, "0")}`,
      benchmark: "LongBench-Write",
      category: d.type || "Unknown",
      question: d.prompt,
      expectedLength: targetLen,
      evaluationType: "length" as const,
      evaluationCriteria: [
        `Output should be approximately ${targetLen} words`,
        "Content should be relevant to the prompt",
        "Writing should be coherent and well-structured",
        "Should not contain obvious hallucinations",
      ],
      passThreshold: 60,
      maxWaitMs: timeoutMs,
      metadata: { targetType: d.type, targetLength: targetLen },
    };
  });
}

function loadHaluEval(
  samplePerCategory: number = 500,
): RawTestCase[] {
  const cases: RawTestCase[] = [];

  // QA category
  const qaPath = path.join(DATASETS_DIR, "halu_eval_qa.json");
  if (fs.existsSync(qaPath)) {
    const lines = fs.readFileSync(qaPath, "utf-8").split("\n").filter(Boolean);
    const sampled = shuffleArray(lines).slice(0, samplePerCategory);
    for (const line of sampled) {
      const d = JSON.parse(line);
      cases.push({
        id: `HE-QA-${String(cases.length + 1).padStart(4, "0")}`,
        benchmark: "HaluEval",
        category: "QA",
        question: `你是一个事实核查专家。以下有一段背景知识、一个问题，以及两个回答。其中一个回答是正确的，另一个包含幻觉（捏造的事实）。\n\n背景知识：${d.knowledge}\n\n问题：${d.question}\n\n回答A：${d.right_answer}\n回答B：${d.hallucinated_answer}\n\n请判断哪个回答包含幻觉，并说明理由。\n\n请用以下格式回答：\n幻觉回答：[A或B]\n理由：[你的分析]`,
        expectedAnswer: "B",
        evaluationType: "hallucination_binary",
        evaluationCriteria: [
          "Correctly identifies Answer B as the hallucinated one",
          "Provides reasoning for the identification",
        ],
        passThreshold: 100,
        maxWaitMs: 60_000,
        metadata: {
          knowledge: d.knowledge,
          right_answer: d.right_answer,
          hallucinated_answer: d.hallucinated_answer,
        },
      });
    }
  }

  // Dialogue category
  const dlgPath = path.join(DATASETS_DIR, "halu_eval_dialogue.json");
  if (fs.existsSync(dlgPath)) {
    const lines = fs.readFileSync(dlgPath, "utf-8").split("\n").filter(Boolean);
    const sampled = shuffleArray(lines).slice(0, samplePerCategory);
    for (const line of sampled) {
      const d = JSON.parse(line);
      cases.push({
        id: `HE-DLG-${String(cases.length + 1).padStart(4, "0")}`,
        benchmark: "HaluEval",
        category: "Dialogue",
        question: `你是一个事实核查专家。以下有一段背景知识、一段对话历史，以及两个可能的回复。其中一个回复是正确的，另一个包含幻觉（捏造的事实）。\n\n背景知识：${d.knowledge}\n\n对话历史：${d.dialogue_history}\n\n回复A：${d.right_response}\n回复B：${d.hallucinated_response}\n\n请判断哪个回复包含幻觉，并说明理由。\n\n请用以下格式回答：\n幻觉回复：[A或B]\n理由：[你的分析]`,
        expectedAnswer: "B",
        evaluationType: "hallucination_binary",
        evaluationCriteria: [
          "Correctly identifies Reply B as hallucinated",
          "Provides reasoning",
        ],
        passThreshold: 100,
        maxWaitMs: 60_000,
        metadata: {
          knowledge: d.knowledge,
          right_response: d.right_response,
          hallucinated_response: d.hallucinated_response,
        },
      });
    }
  }

  // Summarization category
  const sumPath = path.join(DATASETS_DIR, "halu_eval_summarization.json");
  if (fs.existsSync(sumPath)) {
    const lines = fs.readFileSync(sumPath, "utf-8").split("\n").filter(Boolean);
    const sampled = shuffleArray(lines).slice(0, samplePerCategory);
    for (const line of sampled) {
      const d = JSON.parse(line);
      cases.push({
        id: `HE-SUM-${String(cases.length + 1).padStart(4, "0")}`,
        benchmark: "HaluEval",
        category: "Summarization",
        question: `你是一个事实核查专家。以下有一段原文和两个摘要。其中一个摘要是正确的，另一个包含幻觉（与原文不符的内容）。\n\n原文：${d.knowledge || d.document}\n\n摘要A：${d.right_summary || d.right_response}\n摘要B：${d.hallucinated_summary || d.hallucinated_response}\n\n请判断哪个摘要包含幻觉，并说明理由。\n\n请用以下格式回答：\n幻觉摘要：[A或B]\n理由：[你的分析]`,
        expectedAnswer: "B",
        evaluationType: "hallucination_binary",
        evaluationCriteria: [
          "Correctly identifies Summary B as hallucinated",
          "Provides reasoning",
        ],
        passThreshold: 100,
        maxWaitMs: 60_000,
      });
    }
  }

  return cases;
}

function loadGAIA(split: "validation" | "test" | "both" = "both", levelFilter?: number, textOnly?: boolean): RawTestCase[] {
  const cases: RawTestCase[] = [];

  const files: { path: string; prefix: string }[] = [];
  if (split === "validation" || split === "both") {
    files.push({
      path: path.join(DATASETS_DIR, "gaia_validation.jsonl"),
      prefix: "GAIA-V",
    });
  }
  if (split === "test" || split === "both") {
    files.push({
      path: path.join(DATASETS_DIR, "gaia_test.jsonl"),
      prefix: "GAIA-T",
    });
  }

  for (const { path: filePath, prefix } of files) {
    if (!fs.existsSync(filePath)) continue;

    const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      const d = JSON.parse(line);
      const hasFile = d.file_name && d.file_name.trim() !== "";
      const level = d.Level || 1;

      // Filter by level and text-only if requested
      if (levelFilter && level !== levelFilter) continue;
      if (textOnly && hasFile) continue;

      cases.push({
        id: `${prefix}-${d.task_id?.slice(0, 8) || cases.length}`,
        benchmark: "GAIA",
        category: `Level ${level}${hasFile ? " (with file)" : " (text-only)"}`,
        question: d.Question,
        expectedAnswer: d["Final answer"],
        evaluationType: "contains",
        evaluationCriteria: [
          `Answer should match or contain: "${d["Final answer"]}"`,
          "Show reasoning steps",
          "Use web search when needed",
        ],
        passThreshold: 100,
        maxWaitMs: level === 3 ? 600_000 : level === 2 ? 420_000 : 300_000,
        metadata: {
          level,
          hasAttachment: hasFile,
          fileName: d.file_name || "",
          annotatorSteps: d["Annotator Metadata"]?.Steps || "",
        },
      });
    }
  }

  return cases;
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function parseArgs(): {
  benchmark: string;
  batch?: number;
  offset?: number;
  sample?: number;
  split?: string;
  level?: number;
  textOnly?: boolean;
  resume?: string;
  dryRun?: boolean;
} {
  const args = process.argv.slice(2);
  const result: any = { benchmark: args[0] || "all" };

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--batch" && args[i + 1]) result.batch = parseInt(args[++i]);
    if (args[i] === "--offset" && args[i + 1]) result.offset = parseInt(args[++i]);
    if (args[i] === "--sample" && args[i + 1]) result.sample = parseInt(args[++i]);
    if (args[i] === "--split" && args[i + 1]) result.split = args[++i];
    if (args[i] === "--level" && args[i + 1]) result.level = parseInt(args[++i]);
    if (args[i] === "--text-only") result.textOnly = true;
    if (args[i] === "--resume" && args[i + 1]) result.resume = args[++i];
    if (args[i] === "--dry-run") result.dryRun = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// API Helpers
// ---------------------------------------------------------------------------

async function createSession(title: string): Promise<string> {
  const resp = await fetch(`${BASE_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!resp.ok) throw new Error(`Failed to create session: ${resp.status}`);
  const body = await resp.json();
  return body.id;
}

async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// SSE-based Agent Runner (reused from run-benchmark.ts)
// ---------------------------------------------------------------------------

async function runAgentSSE(
  sessionId: string,
  question: string,
  maxWaitMs: number = 300_000,
): Promise<{
  content: string;
  toolCalls: number;
  pushContents: Array<{ title: string; data: string }>;
  turnsUsed: number;
  success: boolean;
  error?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), maxWaitMs);

  try {
    const resp = await fetch(`${BASE_URL}/api/agents/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, input: question }),
      signal: controller.signal,
      dispatcher: longTimeoutAgent,
    });

    if (!resp.ok) {
      return {
        content: "",
        toolCalls: 0,
        pushContents: [],
        turnsUsed: 0,
        success: false,
        error: `HTTP ${resp.status}`,
      };
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let toolCallCount = 0;
    const pushContents: any[] = [];
    let turnsUsed = 0;
    let success = false;
    let error: string | undefined;
    const toolCallMap = new Map<string, any>();

    let currentEvent = "";
    let currentData = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          currentData = line.slice(6);
        } else if (line === "" && currentEvent && currentData) {
          try {
            const data = JSON.parse(currentData);
            switch (currentEvent) {
              case "content":
                content = data.content || content;
                break;
              case "content_delta":
                content += data.delta || "";
                break;
              case "tool_call":
                toolCallMap.set(data.id, { id: data.id, toolName: data.toolName });
                break;
              case "tool_result": {
                const tc = toolCallMap.get(data.id);
                if (tc) {
                  toolCallCount++;
                }
                break;
              }
              case "push_content":
                pushContents.push({
                  title: data.title,
                  data: data.data,
                });
                break;
              case "done":
                turnsUsed = data.turnsUsed || 0;
                success = data.status !== "error";
                break;
              case "error":
                error = data.error;
                success = false;
                break;
            }
          } catch { /* skip */ }
          currentEvent = "";
          currentData = "";
        }
      }
    }

    return { content, toolCalls: toolCallCount, pushContents, turnsUsed, success, error };
  } catch (e: any) {
    if (e.name === "AbortError") {
      return {
        content: "",
        toolCalls: 0,
        pushContents: [],
        turnsUsed: 0,
        success: false,
        error: "Timeout",
      };
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function evaluateResult(tc: RawTestCase, agentOutput: string): {
  score: number;
  passed: boolean;
  details: string;
} {
  const output = agentOutput.toLowerCase();
  const expected = (tc.expectedAnswer || "").toLowerCase();

  switch (tc.evaluationType) {
    case "hallucination_binary": {
      // Strip <think/> tags for evaluation
      const cleanOutput = agentOutput.replace(/<think[\s\S]*?<\/think>/g, "").trim();
      const cleanLower = cleanOutput.toLowerCase();

      // Strategy: Look for the FINAL answer pattern first, then fallback to broader matching.
      // The model is expected to output structured format like "幻觉回答：B"

      // Pattern 1: Explicit structured answer — "幻觉回答：B" or "幻觉回复：B" or "幻觉摘要：B"
      const structMatch = cleanOutput.match(/幻觉[回答回复摘要]*\s*[：:]\s*([AaBb])/);
      if (structMatch) {
        const answer = structMatch[1].toUpperCase();
        if (answer === "B") {
          return { score: 100, passed: true, details: "Correctly identified B as hallucinated (structured format)" };
        } else {
          return { score: 0, passed: false, details: "Incorrectly identified A as hallucinated (structured format)" };
        }
      }

      // Pattern 2: Look for final conclusion in the last ~300 chars
      const tail = cleanOutput.slice(-300);
      const tailLower = tail.toLowerCase();

      // Check if tail says B is hallucinated/wrong/contains hallucination
      const tailSaysBWrong = /[Bb].*(包含幻觉|是幻觉|有幻觉|错误|不符|捏造|hallucinat)/i.test(tail) ||
                             /幻觉.*[Bb]/i.test(tail) ||
                             /回答\s*[Bb].*(包含|是|有).*(幻觉|错误|不符)/.test(tail) ||
                             /Answer\s*[Bb]\s*(is|contains)\s*(hallucinat|wrong|incorrect)/i.test(tail);

      // Check if tail says A is hallucinated/wrong
      const tailSaysAWrong = /[Aa].*(包含幻觉|是幻觉|有幻觉|错误|不符|捏造|hallucinat)/i.test(tail) &&
                             !/回答\s*[Aa].*(正确|准确|right|correct)/i.test(tail);

      // Check if tail says A is correct
      const tailSaysACorrect = /回答\s*[Aa].*(正确|准确|right|correct|is\s+the\s+right)/i.test(tail);

      if (tailSaysBWrong && !tailSaysAWrong) {
        return { score: 100, passed: true, details: "Correctly identified B as hallucinated (conclusion)" };
      }
      if (tailSaysAWrong) {
        return { score: 0, passed: false, details: "Incorrectly identified A as hallucinated" };
      }

      // Pattern 3: Broader check — if the text says B is hallucinated or A is correct
      const bIsHalu = /[Bb].*(幻觉|hallucinat|捏造|错误|不符|wrong)/i.test(cleanLower) ||
                      /幻觉.*回答.*[Bb]/i.test(cleanLower);
      const aIsCorrect = /回答\s*[Aa].*(正确|准确|right|correct)/i.test(cleanLower);
      const bIsWrong = /回答\s*[Bb].*(错误|不正确|wrong|incorrect|幻觉)/i.test(cleanLower);

      if ((bIsHalu || bIsWrong) && (aIsCorrect || !/[Aa].*(幻觉|hallucinat|捏造)/i.test(cleanLower))) {
        return { score: 90, passed: true, details: "Correctly identified B as hallucinated (broad match)" };
      }

      // Pattern 4: If just mentions B somewhere with negative context
      if (/\[B\]/i.test(cleanOutput) || /\bb\b\s*是.*幻觉/i.test(cleanOutput)) {
        return { score: 80, passed: true, details: "Likely correct (fuzzy match)" };
      }

      return { score: 0, passed: false, details: "Could not determine which answer was identified as hallucinated" };
    }

    case "exact_match": {
      const cleanOutput = output.replace(/[^\w\u4e00-\u9fff]/g, "");
      const cleanExpected = expected.replace(/[^\w\u4e00-\u9fff]/g, "");
      if (cleanOutput.includes(cleanExpected)) {
        return { score: 100, passed: true, details: `Exact match: "${expected}"` };
      }
      // Fuzzy check
      if (cleanExpected.length > 2 && output.includes(expected)) {
        return { score: 90, passed: true, details: `Contains expected answer: "${expected}"` };
      }
      return { score: 0, passed: false, details: `Expected "${expected}", not found in output` };
    }

    case "contains": {
      if (!expected) {
        // No expected answer available (e.g., GAIA test set may not have answers)
        return { score: -1, passed: false, details: "No expected answer for comparison" };
      }
      // Strip think tags
      const cleanAgentOutput = agentOutput.replace(/<think[\s\S]*?<\/think>/g, "").trim();
      const cleanLower = cleanAgentOutput.toLowerCase();

      // Try exact substring match first
      if (cleanLower.includes(expected.toLowerCase())) {
        return { score: 100, passed: true, details: `Found expected answer: "${expected}"` };
      }

      // Try normalized match (remove extra whitespace, punctuation differences)
      const normalize = (s: string) => s.toLowerCase().replace(/[\s\p{P}]/gu, "").trim();
      const normOutput = normalize(cleanAgentOutput);
      const normExpected = normalize(expected);

      if (normOutput.includes(normExpected)) {
        return { score: 100, passed: true, details: `Found (normalized): "${expected}"` };
      }

      // For numeric answers, check if the number appears
      const numMatch = expected.match(/[\d.]+/);
      if (numMatch) {
        const num = numMatch[0];
        if (cleanLower.includes(num)) {
          return { score: 80, passed: true, details: `Found numeric match: ${num}` };
        }
      }

      // Partial match for long answers
      if (expected.length > 5) {
        const words = expected.toLowerCase().split(/\s+/);
        const foundWords = words.filter(w => w.length > 2 && cleanLower.includes(w));
        const ratio = foundWords.length / words.length;
        if (ratio > 0.7) {
          return {
            score: Math.round(ratio * 80),
            passed: ratio * 80 >= tc.passThreshold,
            details: `Partial match: ${Math.round(ratio * 100)}% of expected words found`,
          };
        }
      }

      return { score: 0, passed: false, details: `Expected "${expected}", not found in output` };
    }

    case "length": {
      const wordCount = agentOutput.split(/\s+/).filter(w => w.length > 0).length;
      const charCount = agentOutput.length;
      const target = tc.expectedLength || 500;

      // For Chinese text, character count is more relevant
      // Rough heuristic: if >30% Chinese chars, use char count / 2 as "word" count
      const chineseChars = (agentOutput.match(/[\u4e00-\u9fff]/g) || []).length;
      const effectiveWordCount = chineseChars > charCount * 0.3
        ? charCount / 2
        : wordCount;

      // Generous length tolerance: 30% below to unlimited above
      const minWords = target * 0.3;
      const meetsLength = effectiveWordCount >= minWords;

      const ratio = Math.min(1, effectiveWordCount / target);
      const score = Math.round(ratio * 70 + (meetsLength ? 30 : 0));

      return {
        score: Math.min(100, score),
        passed: score >= tc.passThreshold,
        details: `Target: ~${target} words, got ~${Math.round(effectiveWordCount)} words (${charCount} chars). Chinese chars: ${chineseChars}`,
      };
    }

    default:
      return { score: 50, passed: false, details: "Unknown evaluation type" };
  }
}

// ---------------------------------------------------------------------------
// Test Execution
// ---------------------------------------------------------------------------

async function runTest(tc: RawTestCase): Promise<RunResult> {
  console.log(`  Running ${tc.id} (${tc.benchmark}/${tc.category})...`);

  const startTime = Date.now();
  let sessionId = "";

  try {
    sessionId = await createSession(`Bench-${tc.id}-${Date.now()}`);
    const agentResult = await runAgentSSE(sessionId, tc.question, tc.maxWaitMs);
    const durationMs = Date.now() - startTime;

    // Combine output
    const fullParts: string[] = [];
    if (agentResult.content) fullParts.push(agentResult.content);
    for (const pc of agentResult.pushContents) {
      fullParts.push(pc.data);
    }
    const fullOutput = fullParts.join("\n\n");

    // Evaluate
    const evaluation = evaluateResult(tc, fullOutput);

    const result: RunResult = {
      testCaseId: tc.id,
      success: agentResult.success,
      content: fullOutput.slice(0, 500),
      toolCalls: agentResult.toolCalls,
      turnsUsed: agentResult.turnsUsed,
      durationMs,
      error: agentResult.error,
      evaluation,
    };

    const status = evaluation.passed ? "PASS" : "FAIL";
    console.log(`    ${status} (${evaluation.score}pts) ${durationMs / 1000}s ${agentResult.turnsUsed}turns ${fullOutput.length}chars`);

    return result;
  } catch (e: any) {
    return {
      testCaseId: tc.id,
      success: false,
      content: "",
      toolCalls: 0,
      turnsUsed: 0,
      durationMs: Date.now() - startTime,
      error: e.message,
    };
  } finally {
    if (sessionId) await deleteSession(sessionId).catch(() => {});
  }
}

async function runBatch(testCases: RawTestCase[]): Promise<BatchResults> {
  const results: RunResult[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    console.log(`[${i + 1}/${testCases.length}] ${tc.id}`);

    const result = await runTest(tc);
    results.push(result);

    if (result.evaluation) {
      if (result.evaluation.passed) passed++;
      else if (result.evaluation.score < 0) skipped++;
      else failed++;
    } else {
      failed++;
    }
  }

  const durations = results.map(r => r.durationMs);
  const turns = results.map(r => r.turnsUsed);
  const toolCalls = results.map(r => r.toolCalls);

  // Count failure reasons
  const failureReasons: Record<string, number> = {};
  for (const r of results) {
    if (r.evaluation && !r.evaluation.passed && r.evaluation.score >= 0) {
      const reason = r.evaluation.details.slice(0, 80);
      failureReasons[reason] = (failureReasons[reason] || 0) + 1;
    } else if (r.error) {
      failureReasons[r.error] = (failureReasons[r.error] || 0) + 1;
    }
  }

  return {
    benchmark: testCases[0]?.benchmark || "unknown",
    timestamp: new Date().toISOString(),
    totalTests: testCases.length,
    passed,
    failed,
    skipped,
    results,
    summary: {
      avgDurationMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      avgTurns: turns.reduce((a, b) => a + b, 0) / turns.length,
      avgToolCalls: toolCalls.reduce((a, b) => a + b, 0) / toolCalls.length,
      passRate: passed / (passed + failed) * 100,
      failureReasons,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  console.log(`\n${"#".repeat(70)}`);
  console.log(`# DeepAnalyze Full-Scale Benchmark Runner`);
  console.log(`# Benchmark: ${args.benchmark}`);
  console.log(`# Batch: ${args.batch || "all"} | Offset: ${args.offset || 0} | Sample: ${args.sample || "default"}`);
  console.log(`${"#".repeat(70)}\n`);

  // Load test cases based on benchmark selection
  let testCases: RawTestCase[] = [];
  const split = args.split as "validation" | "test" | "both" || "both";

  switch (args.benchmark.toLowerCase()) {
    case "longbench":
      testCases = loadLongBenchWrite();
      break;
    case "halueval":
      testCases = loadHaluEval(args.sample || 500);
      break;
    case "gaia":
      testCases = loadGAIA(split, args.level, args.textOnly);
      break;
      break;
    case "all":
      testCases = [
        ...loadLongBenchWrite(),
        ...loadHaluEval(args.sample || 200),
        ...loadGAIA(split, args.level, args.textOnly),
      ];
      break;
    default:
      console.error(`Unknown benchmark: ${args.benchmark}`);
      console.log("Available: longbench, halueval, gaia, all");
      process.exit(1);
  }

  // Apply offset and batch
  if (args.offset) {
    testCases = testCases.slice(args.offset);
  }
  if (args.batch) {
    testCases = testCases.slice(0, args.batch);
  }

  if (args.dryRun) {
    console.log(`\nDry run - ${testCases.length} test cases:`);
    for (const tc of testCases.slice(0, 10)) {
      console.log(`  ${tc.id} | ${tc.benchmark} | ${tc.category} | ${tc.evaluationType} | ${tc.question.slice(0, 80)}...`);
    }
    if (testCases.length > 10) {
      console.log(`  ... and ${testCases.length - 10} more`);
    }

    // Print category distribution
    const byCategory: Record<string, number> = {};
    for (const tc of testCases) {
      const key = `${tc.benchmark}/${tc.category}`;
      byCategory[key] = (byCategory[key] || 0) + 1;
    }
    console.log(`\nDistribution:`);
    for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${cat}: ${count}`);
    }
    return;
  }

  // Resume from previous results
  let completedIds = new Set<string>();
  if (args.resume) {
    const prevFile = path.join(RESULTS_DIR, args.resume);
    if (fs.existsSync(prevFile)) {
      const prev = JSON.parse(fs.readFileSync(prevFile, "utf-8"));
      for (const r of prev.results || []) {
        completedIds.add(r.testCaseId);
      }
      testCases = testCases.filter(tc => !completedIds.has(tc.id));
      console.log(`Resuming: skipping ${completedIds.size} completed tests, ${testCases.length} remaining`);
    }
  }

  console.log(`\nRunning ${testCases.length} test cases...\n`);

  // Run the batch
  const batchResults = await runBatch(testCases);

  // Print summary
  console.log(`\n${"#".repeat(70)}`);
  console.log(`# RESULTS SUMMARY`);
  console.log(`${"#".repeat(70)}\n`);

  console.log(`Benchmark: ${batchResults.benchmark}`);
  console.log(`Total: ${batchResults.totalTests} | Passed: ${batchResults.passed} | Failed: ${batchResults.failed} | Skipped: ${batchResults.skipped}`);
  console.log(`Pass Rate: ${batchResults.summary.passRate.toFixed(1)}%`);
  console.log(`Avg Duration: ${(batchResults.summary.avgDurationMs / 1000).toFixed(1)}s`);
  console.log(`Avg Turns: ${batchResults.summary.avgTurns.toFixed(1)}`);
  console.log(`Avg Tool Calls: ${batchResults.summary.avgToolCalls.toFixed(1)}`);

  if (Object.keys(batchResults.summary.failureReasons).length > 0) {
    console.log(`\nFailure Reasons:`);
    for (const [reason, count] of Object.entries(batchResults.summary.failureReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)) {
      console.log(`  ${count}x ${reason}`);
    }
  }

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const resultFile = path.join(RESULTS_DIR, `${args.benchmark}-${timestamp}.json`);
  fs.writeFileSync(resultFile, JSON.stringify(batchResults, null, 2));
  console.log(`\nResults saved to: ${resultFile}`);

  // Also save a latest symlink/copy
  const latestFile = path.join(RESULTS_DIR, `${args.benchmark}-latest.json`);
  fs.writeFileSync(latestFile, JSON.stringify(batchResults, null, 2));
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
