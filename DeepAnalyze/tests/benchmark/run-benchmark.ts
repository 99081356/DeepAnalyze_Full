// =============================================================================
// DeepAnalyze Benchmark Runner
// =============================================================================
// Standalone script that runs benchmark tests, collects results, and outputs
// detailed analysis for optimization. Can be run with: npx tsx run-benchmark.ts
// =============================================================================

import {
  WEBARENA_TESTS,
  WEBARENA_EXTENDED_TESTS,
  AGENTWRITE_TESTS,
  AGENTWRITE_EXTENDED_TESTS,
  HALLUAGENT_TESTS,
  HALLUAGENT_EXTENDED_TESTS,
  GAIA3_TESTS,
  GAIA3_EXTENDED_TESTS,
  ALL_BENCHMARK_TESTS,
  type BenchmarkTestCase,
} from "./test-cases";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = "http://localhost:21000";
const RESULTS_FILE = "./tests/benchmark/results.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunResult {
  testCase: BenchmarkTestCase;
  success: boolean;
  content: string;
  toolCalls: Array<{ toolName: string; input: string; output: string }>;
  pushContents: Array<{ title: string; data: string }>;
  durationMs: number;
  turnsUsed: number;
  error?: string;
  fullOutput: string;
}

// ---------------------------------------------------------------------------
// API Helpers
// ---------------------------------------------------------------------------

async function apiRequest(path: string, options?: RequestInit): Promise<any> {
  const resp = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers as Record<string, string> | undefined),
    },
  });
  return resp;
}

async function createSession(title: string): Promise<string> {
  const resp = await apiRequest("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  if (!resp.ok) throw new Error(`Failed to create session: ${resp.status}`);
  const body = await resp.json();
  return body.id;
}

async function deleteSession(sessionId: string): Promise<void> {
  await apiRequest(`/api/sessions/${sessionId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// SSE-based Agent Runner
// ---------------------------------------------------------------------------

interface SSEEvent {
  type: string;
  data: any;
}

async function runAgentSSE(
  sessionId: string,
  question: string,
  maxWaitMs: number = 300_000,
): Promise<{
  content: string;
  toolCalls: Array<{ id: string; toolName: string; input: any; output: string; status: string }>;
  pushContents: Array<{ type: string; title: string; data: string; format?: string }>;
  turnsUsed: number;
  taskId: string;
  success: boolean;
  error?: string;
  tokenUsage: any[];
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), maxWaitMs);

  try {
    const resp = await fetch(`${BASE_URL}/api/agents/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, input: question }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      return {
        content: "",
        toolCalls: [],
        pushContents: [],
        turnsUsed: 0,
        taskId: "",
        success: false,
        error: `HTTP ${resp.status}`,
        tokenUsage: [],
      };
    }

    // Read the SSE stream
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let content = "";
    const toolCallMap = new Map<string, any>();
    const toolCalls: any[] = [];
    const pushContents: any[] = [];
    let turnsUsed = 0;
    let taskId = "";
    let success = false;
    let error: string | undefined;
    const tokenUsage: any[] = [];

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
              case "start":
                taskId = data.taskId || "";
                break;
              case "content":
                content = data.content || content;
                break;
              case "content_delta":
                content += data.delta || "";
                break;
              case "tool_call":
                toolCallMap.set(data.id, {
                  id: data.id,
                  toolName: data.toolName,
                  input: data.input || {},
                  output: "",
                  status: data.status || "pending",
                });
                break;
              case "tool_result": {
                const tc = toolCallMap.get(data.id);
                if (tc) {
                  tc.output = data.output || "";
                  tc.status = "completed";
                  toolCalls.push(tc);
                }
                break;
              }
              case "push_content":
                pushContents.push({
                  type: data.type,
                  title: data.title,
                  data: data.data,
                  format: data.format,
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
              case "turn_usage":
                tokenUsage.push(data);
                break;
            }
          } catch { /* skip */ }
          currentEvent = "";
          currentData = "";
        }
      }
    }

    return { content, toolCalls, pushContents, turnsUsed, taskId, success, error, tokenUsage };
  } catch (e: any) {
    if (e.name === "AbortError") {
      return {
        content: "",
        toolCalls: [],
        pushContents: [],
        turnsUsed: 0,
        taskId: "",
        success: false,
        error: "Timeout",
        tokenUsage: [],
      };
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Test Execution
// ---------------------------------------------------------------------------

async function runTest(testCase: BenchmarkTestCase): Promise<RunResult> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Running: ${testCase.id} — ${testCase.benchmark} / ${testCase.category}`);
  console.log(`Question: ${testCase.question.slice(0, 100)}...`);
  console.log(`${"=".repeat(70)}`);

  const startTime = Date.now();
  let sessionId = "";

  try {
    sessionId = await createSession(`Bench-${testCase.id}-${Date.now()}`);
    console.log(`Session created: ${sessionId}`);

    const agentResult = await runAgentSSE(
      sessionId,
      testCase.question,
      testCase.maxWaitMs,
    );

    const durationMs = Date.now() - startTime;

    // Combine all output
    const fullParts: string[] = [];
    if (agentResult.content) fullParts.push(agentResult.content);
    for (const pc of agentResult.pushContents) {
      fullParts.push(`\n--- ${pc.title} (${pc.type}) ---\n${pc.data}`);
    }
    const fullOutput = fullParts.join("\n\n");

    const result: RunResult = {
      testCase,
      success: agentResult.success,
      content: agentResult.content,
      toolCalls: agentResult.toolCalls.map(tc => ({
        toolName: tc.toolName,
        input: JSON.stringify(tc.input).slice(0, 500),
        output: tc.output.slice(0, 500),
      })),
      pushContents: agentResult.pushContents.map(pc => ({
        title: pc.title,
        data: pc.data.slice(0, 1000),
      })),
      durationMs,
      turnsUsed: agentResult.turnsUsed,
      error: agentResult.error,
      fullOutput,
    };

    // Print summary
    console.log(`\n--- Result Summary ---`);
    console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
    console.log(`Turns: ${agentResult.turnsUsed}`);
    console.log(`Tool calls: ${agentResult.toolCalls.length}`);
    console.log(`Push contents: ${agentResult.pushContents.length}`);
    console.log(`Content length: ${agentResult.content.length} chars`);
    console.log(`Full output length: ${fullOutput.length} chars`);
    console.log(`Success: ${agentResult.success}`);

    if (agentResult.toolCalls.length > 0) {
      console.log(`\nTool calls:`);
      for (const tc of agentResult.toolCalls) {
        console.log(`  [${tc.toolName}] ${JSON.stringify(tc.input).slice(0, 100)}...`);
      }
    }

    console.log(`\nOutput preview (first 300 chars):`);
    console.log(fullOutput.slice(0, 300));
    console.log(`\n... (truncated) ...\n`);
    console.log(`Output preview (last 300 chars):`);
    console.log(fullOutput.slice(-300));

    return result;
  } catch (e: any) {
    return {
      testCase,
      success: false,
      content: "",
      toolCalls: [],
      pushContents: [],
      durationMs: Date.now() - startTime,
      turnsUsed: 0,
      error: e.message,
      fullOutput: "",
    };
  } finally {
    if (sessionId) {
      await deleteSession(sessionId).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const groupFilter = args[0]; // Optional: "webarena", "agentwrite", "halluagent", "gaia3"
  const testIdFilter = args[1]; // Optional: specific test ID

  let tests: BenchmarkTestCase[] = [];

  if (testIdFilter) {
    const found = ALL_BENCHMARK_TESTS.find(t => t.id === testIdFilter);
    if (found) tests = [found];
    else {
      console.error(`Test ID not found: ${testIdFilter}`);
      console.log(`Available: ${ALL_BENCHMARK_TESTS.map(t => t.id).join(", ")}`);
      process.exit(1);
    }
  } else if (groupFilter) {
    const filterMap: Record<string, BenchmarkTestCase[]> = {
      webarena: [...WEBARENA_TESTS, ...WEBARENA_EXTENDED_TESTS],
      agentwrite: [...AGENTWRITE_TESTS, ...AGENTWRITE_EXTENDED_TESTS],
      halluagent: [...HALLUAGENT_TESTS, ...HALLUAGENT_EXTENDED_TESTS],
      gaia3: [...GAIA3_TESTS, ...GAIA3_EXTENDED_TESTS],
    };
    tests = filterMap[groupFilter.toLowerCase()] || ALL_BENCHMARK_TESTS;
  } else {
    tests = ALL_BENCHMARK_TESTS;
  }

  console.log(`\n${"#".repeat(70)}`);
  console.log(`# DeepAnalyze Benchmark Runner`);
  console.log(`# Tests to run: ${tests.length}`);
  console.log(`# Test IDs: ${tests.map(t => t.id).join(", ")}`);
  console.log(`${"#".repeat(70)}\n`);

  const results: RunResult[] = [];

  for (let i = 0; i < tests.length; i++) {
    const tc = tests[i];
    console.log(`\n[${i + 1}/${tests.length}] Running ${tc.id}...`);
    const result = await runTest(tc);
    results.push(result);
  }

  // Print final summary
  console.log(`\n${"#".repeat(70)}`);
  console.log(`# FINAL SUMMARY`);
  console.log(`${"#".repeat(70)}\n`);

  for (const r of results) {
    const status = r.success ? "OK" : "FAIL";
    const outputLen = r.fullOutput.length;
    console.log(
      `${r.testCase.id} [${status}] ` +
      `${(r.durationMs / 1000).toFixed(1)}s ` +
      `${r.turnsUsed}turns ` +
      `${r.toolCalls.length}tools ` +
      `${outputLen}chars ` +
      `${r.error || ""}`
    );
  }

  // Save results to file
  const fs = await import("node:fs/promises");
  await fs.writeFile(RESULTS_FILE, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\nResults saved to: ${RESULTS_FILE}`);
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
