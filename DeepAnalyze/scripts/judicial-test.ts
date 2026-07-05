#!/usr/bin/env npx tsx
/**
 * Judicial Knowledge Base Analysis Test
 *
 * Uses the bigtest knowledge base (222 files) with the specified complex prompt
 * to test DeepAnalyze's domain-specific analysis capabilities.
 *
 * Usage:
 *   npx tsx scripts/judicial-test.ts [--api-url http://localhost:21000]
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
function getArg(name: string, defaultValue: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const API_URL = getArg("api-url", "http://localhost:21000");
const OUTPUT_DIR = getArg("output", "cc_test/20260430-000916");
const KB_ID = getArg("kb-id", "d6975eaf-802f-4839-bb1c-499ae17d8dff");
const KB_NAME = "bigtest";

const TEST_PROMPT = `现在请你分析知识库文档的全部内容，分析清楚所有内容的主要分类关系，从属关系，分析清楚每一类，每一块知识的相关性。针对论文，请给出一份详细的分析报告分析这些论文的技术演进关系，分析不同技术的优劣势，预测未来核心的研究方向和建议，给出详细的分析报告。如果是剧本杀，请分析整个剧本的关系，找出明确的杀手和时间线推理关系，找出所有证据链条和推理逻辑链条，每个剧本杀单独给出详细的完整故事脉络和逻辑关系推理。如果是表格，详细统计分析表格内容和数据情况。其他类型也自定义不同需求，对整个知识库进行全面深入完整的分析与整理。`;

interface TestResult {
  test: string;
  knowledgeBase: string;
  documentCount: number;
  prompt: string;
  sessionId: string;
  output: string;
  elapsedSeconds: number;
  status: "success" | "error";
  error?: string;
  events: Array<{
    type: string;
    turn?: number;
    toolName?: string;
    timestamp: string;
    content?: string;
  }>;
}

async function createSession(): Promise<string> {
  const res = await fetch(`${API_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `Judicial Analysis Test ${new Date().toISOString()}` }),
  });
  const data = await res.json();
  return data.id || data.sessionId;
}

async function runAgentWithEvents(
  sessionId: string,
  prompt: string,
  kbId: string,
): Promise<{ output: string; events: TestResult["events"]; elapsedMs: number }> {
  const start = Date.now();
  const events: TestResult["events"] = [];

  // Use the streaming endpoint to capture events
  try {
    const res = await fetch(`${API_URL}/api/agents/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        input: prompt,
        agentType: "general",
        scope: { knowledgeBaseIds: [kbId] },
      }),
      signal: AbortSignal.timeout(30 * 60 * 1000), // 30 minutes
    });

    const elapsedMs = Date.now() - start;

    if (!res.ok) {
      // Fallback to non-streaming
      return await runAgentNonStreaming(sessionId, prompt, kbId, start, events);
    }

    // Read SSE stream
    const reader = res.body?.getReader();
    if (!reader) {
      return await runAgentNonStreaming(sessionId, prompt, kbId, start, events);
    }

    const decoder = new TextDecoder();
    let fullOutput = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6));
            events.push({
              type: event.type || "unknown",
              turn: event.turn,
              toolName: event.toolName,
              timestamp: new Date().toISOString(),
              content: typeof event.output === "string"
                ? event.output.slice(0, 200)
                : typeof event.result === "string"
                  ? event.result.slice(0, 200)
                  : undefined,
            });
            if (event.type === "complete" && event.output) {
              fullOutput = event.output;
            } else if (event.type === "content" && event.content) {
              fullOutput += event.content;
            }
          } catch { /* not JSON, skip */ }
        }
      }
    }

    return { output: fullOutput, events, elapsedMs };
  } catch (err) {
    return await runAgentNonStreaming(sessionId, prompt, kbId, start, events);
  }
}

async function runAgentNonStreaming(
  sessionId: string,
  prompt: string,
  kbId: string,
  start: number,
  events: TestResult["events"],
): Promise<{ output: string; events: TestResult["events"]; elapsedMs: number }> {
  try {
    const res = await fetch(`${API_URL}/api/agents/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        input: prompt,
        agentType: "general",
        scope: { knowledgeBaseIds: [kbId] },
      }),
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    const elapsedMs = Date.now() - start;
    if (!res.ok) {
      return { output: "", events, elapsedMs, error: `${res.status}: ${await res.text()}` } as any;
    }
    const data = await res.json();
    events.push({
      type: "complete",
      timestamp: new Date().toISOString(),
      content: (data.output || "").slice(0, 200),
    });
    return {
      output: data.output || data.result?.output || "",
      events,
      elapsedMs,
    };
  } catch (err) {
    return { output: "", events, elapsedMs: Date.now() - start, error: String(err) } as any;
  }
}

async function main() {
  console.log(`\n=== Judicial Knowledge Base Analysis Test ===`);
  console.log(`API: ${API_URL}`);
  console.log(`Knowledge Base: ${KB_NAME} (${KB_ID})`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  // Check API
  try {
    const health = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error(`Health check failed`);
    console.log(`API is available.`);
  } catch {
    console.error(`ERROR: API not available. Start backend first.`);
    process.exit(1);
  }

  // Verify KB
  try {
    const kbRes = await fetch(`${API_URL}/api/knowledge/kbs/${KB_ID}`);
    if (!kbRes.ok) throw new Error(`KB not found`);
    const kbData = await kbRes.json();
    console.log(`Knowledge Base confirmed: ${kbData.name || KB_NAME}`);
  } catch {
    console.error(`ERROR: Knowledge base ${KB_NAME} (${KB_ID}) not found.`);
    process.exit(1);
  }

  // Create session
  const sessionId = await createSession();
  console.log(`Session: ${sessionId}\n`);
  console.log(`Running analysis with prompt (${TEST_PROMPT.length} chars)...\n`);

  const { output, events, elapsedMs } = await runAgentWithEvents(sessionId, TEST_PROMPT, KB_ID);

  const result: TestResult = {
    test: "judicial-knowledge-base-analysis",
    knowledgeBase: KB_NAME,
    documentCount: 222,
    prompt: TEST_PROMPT,
    sessionId,
    output: output.slice(0, 50000), // Cap at 50K chars
    elapsedSeconds: Math.round(elapsedMs / 1000),
    status: output ? "success" : "error",
    events,
  };

  // Save results
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const resultPath = join(OUTPUT_DIR, "12-judicial-test-results.json");
  writeFileSync(resultPath, JSON.stringify(result, null, 2));

  // Print summary
  console.log(`\n=== Judicial Test Results ===`);
  console.log(`Status: ${result.status}`);
  console.log(`Elapsed: ${result.elapsedSeconds}s`);
  console.log(`Events captured: ${events.length}`);
  console.log(`Output length: ${output.length} chars`);
  console.log(`Output preview: ${output.slice(0, 300)}...`);
  console.log(`\nReport saved to: ${resultPath}`);
}

main().catch(console.error);
