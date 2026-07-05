// =============================================================================
// DeepAnalyze Benchmark Test Suite
// =============================================================================
// Iterative benchmark testing: runs 3 test cases at a time, evaluates results,
// and reports findings for optimization analysis.
// =============================================================================

import { test, expect, describe } from "@playwright/test";
import {
  createTestSession,
  deleteSession,
  runAgentAndWait,
  combineAllOutput,
  formatBenchmarkResult,
  formatToolCallDetails,
  type AgentRunResult,
  type EvaluationResult,
} from "./da-helper";
import {
  WEBARENA_TESTS,
  AGENTWRITE_TESTS,
  HALLUAGENT_TESTS,
  GAIA3_TESTS,
  ALL_BENCHMARK_TESTS,
  getTestGroups,
  type BenchmarkTestCase,
} from "./test-cases";

// ---------------------------------------------------------------------------
// Test timeout: allow up to 10 minutes per test
// ---------------------------------------------------------------------------
test.setTimeout(600_000);

// ---------------------------------------------------------------------------
// Group 1: WebArena 2.0 Tests (WA-001, WA-002, WA-003)
// ---------------------------------------------------------------------------

describe("WebArena 2.0 — 信息检索与多步推理", () => {
  for (const testCase of WEBARENA_TESTS) {
    test(testCase.id, async ({ request }) => {
      const result = await executeBenchmarkTest(request, testCase);
      logTestResult(testCase, result);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 2: AgentWrite-Bench Tests (AW-001, AW-002, AW-003)
// ---------------------------------------------------------------------------

describe("AgentWrite-Bench — 长篇写作与结构化输出", () => {
  for (const testCase of AGENTWRITE_TESTS) {
    test(testCase.id, async ({ request }) => {
      const result = await executeBenchmarkTest(request, testCase);
      logTestResult(testCase, result);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 3: HalluAgent-Bench Tests (HA-001, HA-002, HA-003)
// ---------------------------------------------------------------------------

describe("HalluAgent-Bench — 幻觉检测与事实核查", () => {
  for (const testCase of HALLUAGENT_TESTS) {
    test(testCase.id, async ({ request }) => {
      const result = await executeBenchmarkTest(request, testCase);
      logTestResult(testCase, result);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 4: GAIA-3 Tests (GA-001, GA-002, GA-003)
// ---------------------------------------------------------------------------

describe("GAIA-3 — 通用推理与工具使用", () => {
  for (const testCase of GAIA3_TESTS) {
    test(testCase.id, async ({ request }) => {
      const result = await executeBenchmarkTest(request, testCase);
      logTestResult(testCase, result);
    });
  }
});

// ---------------------------------------------------------------------------
// Core test execution function
// ---------------------------------------------------------------------------

async function executeBenchmarkTest(
  request: any,
  testCase: BenchmarkTestCase,
): Promise<AgentRunResult> {
  const sessionId = await createTestSession(request, `Benchmark: ${testCase.id}`);

  try {
    const result = await runAgentAndWait(
      request,
      sessionId,
      testCase.question,
      testCase.maxWaitMs,
    );

    // Basic assertions
    expect(result.success).toBe(true);
    expect(result.content.length).toBeGreaterThan(0);

    // Log key metrics for analysis
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Test: ${testCase.id} - ${testCase.benchmark} / ${testCase.category}`);
    console.log(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`Turns: ${result.turnsUsed}`);
    console.log(`Tool calls: ${result.toolCalls.length}`);
    console.log(`Push contents: ${result.pushContents.length}`);
    console.log(`Content length: ${result.content.length} chars`);

    // Log tool calls for analysis
    if (result.toolCalls.length > 0) {
      console.log(`\nTool call details:`);
      for (const tc of result.toolCalls) {
        const inputPreview = JSON.stringify(tc.input).slice(0, 150);
        console.log(`  - ${tc.toolName}: ${inputPreview}`);
      }
    }

    // Log output preview
    const fullOutput = combineAllOutput(result);
    console.log(`\nOutput preview (first 500 chars):`);
    console.log(fullOutput.slice(0, 500));
    console.log(`\nOutput preview (last 500 chars):`);
    console.log(fullOutput.slice(-500));
    console.log(`${"=".repeat(60)}\n`);

    return result;
  } finally {
    await deleteSession(request, sessionId);
  }
}

function logTestResult(testCase: BenchmarkTestCase, result: AgentRunResult): void {
  // This is for console output during test runs
  // The actual evaluation will be done separately by the optimization script
}
