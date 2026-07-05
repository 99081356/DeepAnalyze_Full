// =============================================================================
// DeepAnalyze Benchmark Test Helper
// =============================================================================
// Provides utilities for:
// - Creating sessions and sending messages via API
// - Collecting SSE events (tool calls, content, push_content, etc.)
// - Waiting for agent completion with configurable timeout
// - LLM-based evaluation of results
// =============================================================================

import { type Page, type Request, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  output: string;
  status: string;
  timestamp: number;
}

export interface PushContentRecord {
  type: string;
  title: string;
  data: string;
  format?: string;
  timestamp: string;
}

export interface AgentRunResult {
  sessionId: string;
  taskId: string;
  /** Main text output from the agent */
  content: string;
  /** All tool calls with inputs and outputs */
  toolCalls: ToolCallRecord[];
  /** Push content cards */
  pushContents: PushContentRecord[];
  /** Total turns used */
  turnsUsed: number;
  /** Token usage per turn */
  tokenUsage: Array<{ inputTokens: number; outputTokens: number; cachedTokens?: number; turn: number }>;
  /** Total execution time in ms */
  durationMs: number;
  /** Whether the agent completed without error */
  success: boolean;
  /** Error message if any */
  error?: string;
  /** Compaction events */
  compactionEvents: Array<{ turn: number; method: string; tokensSaved: number }>;
}

export interface BenchmarkTestCase {
  id: string;
  benchmark: string;
  category: string;
  question: string;
  /** Evaluation criteria for LLM-based grading */
  evaluationCriteria: string[];
  /** Minimum score to pass (0-100) */
  passThreshold: number;
  /** Maximum wait time in ms */
  maxWaitMs: number;
}

export interface EvaluationResult {
  score: number; // 0-100
  passed: boolean;
  feedback: string;
  strengths: string[];
  weaknesses: string[];
  hallucinations: string[];
}

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------

export async function createTestSession(
  request: any,
  title: string,
): Promise<string> {
  const resp = await request.post("/api/sessions", {
    data: { title },
  });
  expect([200, 201]).toContain(resp.status());
  const body = await resp.json();
  return body.id;
}

export async function deleteSession(request: any, sessionId: string): Promise<void> {
  await request.delete(`/api/sessions/${sessionId}`);
}

// ---------------------------------------------------------------------------
// Agent Execution via API (direct SSE consumption)
// ---------------------------------------------------------------------------

/**
 * Run an agent task and collect all events.
 * Uses the SSE streaming endpoint directly.
 */
export async function runAgentAndWait(
  request: any,
  sessionId: string,
  question: string,
  maxWaitMs: number = 300_000, // 5 min default
  scope?: { knowledgeBases?: string[]; webSearch?: boolean },
): Promise<AgentRunResult> {
  const startTime = Date.now();

  const result: AgentRunResult = {
    sessionId,
    taskId: "",
    content: "",
    toolCalls: [],
    pushContents: [],
    turnsUsed: 0,
    tokenUsage: [],
    durationMs: 0,
    success: false,
    compactionEvents: [],
  };

  // Map to track tool call ID → record for pairing call with result
  const toolCallMap = new Map<string, ToolCallRecord>();

  // Use the streaming endpoint
  const resp = await request.post("/api/agents/run-stream", {
    data: {
      sessionId,
      input: question,
      scope: scope || undefined,
    },
    timeout: maxWaitMs,
  });

  if (!resp.ok()) {
    result.error = `HTTP ${resp.status()}: ${await resp.text().catch(() => "unknown")}`;
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // Read the SSE response body
  const body = await resp.text();
  const events = parseSSEEvents(body);

  for (const event of events) {
    switch (event.type) {
      case "start":
        result.taskId = event.data.taskId || "";
        break;

      case "content":
      case "content_delta":
        // Accumulate content
        if (event.data.accumulated) {
          result.content = event.data.accumulated;
        } else if (event.data.delta) {
          result.content += event.data.delta;
        } else if (event.data.content) {
          result.content = event.data.content;
        }
        break;

      case "tool_call": {
        const tc: ToolCallRecord = {
          id: event.data.id,
          toolName: event.data.toolName,
          input: event.data.input || {},
          output: "",
          status: event.data.status || "pending",
          timestamp: Date.now(),
        };
        toolCallMap.set(tc.id, tc);
        break;
      }

      case "tool_result": {
        const existing = toolCallMap.get(event.data.id);
        if (existing) {
          existing.output = event.data.output || "";
          existing.status = "completed";
          result.toolCalls.push(existing);
        } else {
          result.toolCalls.push({
            id: event.data.id,
            toolName: event.data.toolName,
            input: {},
            output: event.data.output || "",
            status: "completed",
            timestamp: Date.now(),
          });
        }
        break;
      }

      case "push_content":
        result.pushContents.push({
          type: event.data.type,
          title: event.data.title,
          data: event.data.data,
          format: event.data.format,
          timestamp: event.data.timestamp,
        });
        break;

      case "done":
        result.turnsUsed = event.data.turnsUsed || 0;
        result.success = event.data.status !== "error";
        break;

      case "error":
        result.error = event.data.error;
        result.success = false;
        break;

      case "turn_usage":
        result.tokenUsage.push({
          inputTokens: event.data.inputTokens || 0,
          outputTokens: event.data.outputTokens || 0,
          cachedTokens: event.data.cachedTokens,
          turn: event.data.turn || 0,
        });
        break;

      case "compaction":
        result.compactionEvents.push({
          turn: event.data.turn || 0,
          method: event.data.method || "",
          tokensSaved: event.data.tokensSaved || 0,
        });
        break;
    }
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

// ---------------------------------------------------------------------------
// SSE Parsing
// ---------------------------------------------------------------------------

interface SSEEvent {
  type: string;
  data: Record<string, any>;
}

function parseSSEEvents(rawBody: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  let currentType = "";
  let currentData = "";

  for (const rawLine of rawBody.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    if (line.startsWith("event: ")) {
      currentType = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    } else if (line === "" && currentType && currentData) {
      try {
        events.push({
          type: currentType,
          data: JSON.parse(currentData),
        });
      } catch {
        // Skip malformed events
      }
      currentType = "";
      currentData = "";
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Frontend-based Agent Execution (Playwright Page interaction)
// ---------------------------------------------------------------------------

/**
 * Run agent by interacting with the frontend UI like a human user.
 * Types a message in the chat input and waits for the response.
 * Captures all visible content including push_content cards.
 */
export async function runAgentViaFrontend(
  page: Page,
  sessionId: string,
  question: string,
  maxWaitMs: number = 300_000,
): Promise<AgentRunResult> {
  const startTime = Date.now();

  const result: AgentRunResult = {
    sessionId,
    taskId: "",
    content: "",
    toolCalls: [],
    pushContents: [],
    turnsUsed: 0,
    tokenUsage: [],
    durationMs: 0,
    success: false,
    compactionEvents: [],
  };

  // Navigate to the session
  await page.goto(`/#/sessions/${sessionId}`);
  await page.waitForLoadState("networkidle");

  // Wait for the textarea to be visible
  const textarea = page.locator("textarea").first();
  await expect(textarea).toBeVisible({ timeout: 10_000 });

  // Capture SSE events via network interception
  const collectedEvents: SSEEvent[] = [];

  // Intercept the run-stream response
  page.on("request", async (req: Request) => {
    if (req.url().includes("/api/agents/run-stream") && req.method() === "POST") {
      // We'll capture the response via the response event
    }
  });

  // Set up response interception for SSE
  page.on("response", async (response: any) => {
    if (response.url().includes("/api/agents/run-stream")) {
      try {
        const text = await response.text();
        const events = parseSSEEvents(text);
        collectedEvents.push(...events);
      } catch {
        // Response may not be readable yet
      }
    }
  });

  // Type the question
  await textarea.fill(question);
  await page.waitForTimeout(300);

  // Press Enter to send
  await textarea.press("Enter");

  // Wait for the agent to complete
  // Look for the "done" state — the stop button should disappear
  const stopButton = page.locator('button[data-testid="stop-button"], button:has(svg.lucide-square)').first();

  // Wait for either completion or timeout
  const completeIndicator = page.locator(
    '[data-testid="message-complete"], .message-assistant:last-child'
  );

  try {
    // Wait for the agent to finish - look for thinking indicator to disappear
    await page.waitForFunction(
      () => {
        const thinking = document.querySelector('.thinking-indicator, [data-testid="thinking"]');
        const stopBtns = document.querySelectorAll('button');
        let hasStop = false;
        for (const btn of stopBtns) {
          const svg = btn.querySelector('svg.lucide-square');
          if (svg) { hasStop = true; break; }
        }
        // Complete when thinking is gone and no stop button
        return !thinking && !hasStop;
      },
      { timeout: maxWaitMs }
    );
  } catch {
    // Timeout — agent may still be running
  }

  // Wait a bit for final content to render
  await page.waitForTimeout(2000);

  // Extract content from the page
  // Get all assistant message elements
  const messages = page.locator('.message-assistant, [data-role="assistant"]');
  const messageCount = await messages.count();

  if (messageCount > 0) {
    // Get the last assistant message content
    const lastMessage = messages.last();
    result.content = await lastMessage.textContent() || "";
  }

  // Also try to get content via API
  try {
    const apiMessages = await page.request.get(`/api/sessions/${sessionId}/messages`);
    if (apiMessages.ok()) {
      const msgs = await apiMessages.json();
      const assistantMsgs = msgs.filter((m: any) => m.role === "assistant");
      if (assistantMsgs.length > 0) {
        const last = assistantMsgs[assistantMsgs.length - 1];
        result.content = last.content || result.content;

        // Extract push_content from tool calls
        if (last.toolCalls) {
          for (const tc of last.toolCalls) {
            if (tc.toolName === "push_content") {
              try {
                const args = typeof tc.function?.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function?.arguments || {};
                result.pushContents.push({
                  type: args.type || "",
                  title: args.title || "",
                  data: args.data || "",
                  format: args.format,
                  timestamp: new Date().toISOString(),
                });
              } catch { /* skip */ }
            }
          }
        }
      }
    }
  } catch { /* best effort */ }

  // Process collected SSE events for tool calls and other data
  const toolCallMap = new Map<string, ToolCallRecord>();
  for (const event of collectedEvents) {
    switch (event.type) {
      case "start":
        result.taskId = event.data.taskId || "";
        break;
      case "tool_call": {
        const tc: ToolCallRecord = {
          id: event.data.id,
          toolName: event.data.toolName,
          input: event.data.input || {},
          output: "",
          status: event.data.status || "pending",
          timestamp: Date.now(),
        };
        toolCallMap.set(tc.id, tc);
        break;
      }
      case "tool_result": {
        const existing = toolCallMap.get(event.data.id);
        if (existing) {
          existing.output = event.data.output || "";
          existing.status = "completed";
          result.toolCalls.push(existing);
        }
        break;
      }
      case "push_content":
        result.pushContents.push({
          type: event.data.type,
          title: event.data.title,
          data: event.data.data,
          format: event.data.format,
          timestamp: event.data.timestamp,
        });
        break;
      case "done":
        result.turnsUsed = event.data.turnsUsed || 0;
        result.success = event.data.status !== "error";
        break;
      case "error":
        result.error = event.data.error;
        break;
    }
  }

  result.durationMs = Date.now() - startTime;
  result.success = result.content.length > 0;
  return result;
}

// ---------------------------------------------------------------------------
// LLM-based Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate an agent's response using an LLM.
 * Calls the DA summarizer model to grade the response.
 */
export async function evaluateWithLLM(
  request: any,
  testCase: BenchmarkTestCase,
  agentResult: AgentRunResult,
): Promise<EvaluationResult> {
  // Combine all output content for evaluation
  const fullOutput = combineAllOutput(agentResult);

  const evaluationPrompt = `你是一个严格的评估专家，负责评估AI Agent的回答质量。

## 评估任务

### 问题
${testCase.question}

### Agent的回答
${fullOutput.slice(0, 15000)}

### 评估标准
${testCase.evaluationCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## 评估要求

请按以下格式输出评估结果（必须是合法JSON）：

\`\`\`json
{
  "score": <0-100的整数分数>,
  "feedback": "<总体评价>",
  "strengths": ["<优点1>", "<优点2>"],
  "weaknesses": ["<缺点1>", "<缺点2>"],
  "hallucinations": ["<幻觉内容1>（如果有）"]
}
\`\`\`

### 评分规则
- 90-100分：完全正确、完整、无幻觉
- 70-89分：基本正确，但有小的遗漏或不精确
- 50-69分：部分正确，有明显缺陷
- 0-49分：错误或严重幻觉

### 关键评估维度
1. **正确性**：事实性内容是否正确？数值、名称、日期是否准确？
2. **完整性**：是否完整回答了问题？是否有重要遗漏？
3. **无幻觉**：是否编造了不存在的信息？是否对不确定的内容进行了标注？
4. **格式**：输出是否有良好的结构和格式？
5. **来源引用**：是否标注了信息来源？

请直接输出JSON，不要有其他内容。`;

  try {
    // Use the DA API to call the summarizer model for evaluation
    const resp = await request.post("/api/agents/run", {
      data: {
        sessionId: `eval-${Date.now()}`,
        input: evaluationPrompt,
        agentType: "default",
      },
      timeout: 60_000,
    });

    if (!resp.ok()) {
      // Fallback: try using a simpler evaluation
      return ruleBasedFallback(testCase, agentResult);
    }

    const body = await resp.json();
    const output = body.output || "";

    // Extract JSON from the response
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        score: Math.min(100, Math.max(0, parsed.score || 0)),
        passed: (parsed.score || 0) >= testCase.passThreshold,
        feedback: parsed.feedback || "",
        strengths: parsed.strengths || [],
        weaknesses: parsed.weaknesses || [],
        hallucinations: parsed.hallucinations || [],
      };
    }
  } catch (e) {
    // LLM evaluation failed, use rule-based fallback
  }

  return ruleBasedFallback(testCase, agentResult);
}

/**
 * Simple rule-based fallback evaluation when LLM is unavailable.
 */
function ruleBasedFallback(
  testCase: BenchmarkTestCase,
  result: AgentRunResult,
): EvaluationResult {
  const fullOutput = combineAllOutput(result);
  const weaknesses: string[] = [];
  const strengths: string[] = [];
  const hallucinations: string[] = [];
  let score = 50;

  // Check if agent produced any output
  if (fullOutput.length === 0) {
    return {
      score: 0,
      passed: false,
      feedback: "Agent did not produce any output",
      strengths: [],
      weaknesses: ["完全无输出"],
      hallucinations: [],
    };
  }

  // Check if agent used tools (indicating research was done)
  if (result.toolCalls.length > 0) {
    strengths.push(`使用了 ${result.toolCalls.length} 次工具调用进行研究`);
    score += 10;
  }

  // Check for common hallucination indicators
  const uncertainPhrases = ["不确定", "可能", "推测", "猜测", "估计"];
  const hasUncertainty = uncertainPhrases.some(p => fullOutput.includes(p));
  if (hasUncertainty) {
    strengths.push("对不确定内容进行了标注");
    score += 5;
  }

  // Check output length
  if (fullOutput.length < 100) {
    weaknesses.push("输出过短，回答可能不完整");
    score -= 15;
  } else if (fullOutput.length > 500) {
    strengths.push("提供了详细的信息");
    score += 5;
  }

  // Check if agent completed successfully
  if (result.success) {
    strengths.push("Agent正常完成任务");
    score += 10;
  } else {
    weaknesses.push(`Agent执行异常: ${result.error || "未知错误"}`);
    score -= 20;
  }

  score = Math.min(100, Math.max(0, score));

  return {
    score,
    passed: score >= testCase.passThreshold,
    feedback: `规则评估：得分 ${score}/100`,
    strengths,
    weaknesses,
    hallucinations,
  };
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Combine all output content from an agent run result.
 * Includes main content + push_content data.
 */
export function combineAllOutput(result: AgentRunResult): string {
  const parts: string[] = [];

  if (result.content) {
    parts.push("## 主要回答\n" + result.content);
  }

  for (const pc of result.pushContents) {
    parts.push(`## ${pc.title || "推送内容"} (${pc.type})\n${pc.data}`);
  }

  return parts.join("\n\n");
}

/**
 * Format a benchmark result for logging.
 */
export function formatBenchmarkResult(
  testCase: BenchmarkTestCase,
  result: AgentRunResult,
  evaluation: EvaluationResult,
): string {
  const lines: string[] = [
    `=== ${testCase.id}: ${testCase.benchmark} / ${testCase.category} ===`,
    `问题: ${testCase.question.slice(0, 100)}...`,
    `执行时间: ${(result.durationMs / 1000).toFixed(1)}s`,
    `工具调用: ${result.toolCalls.length} 次`,
    `Push内容: ${result.pushContents.length} 条`,
    `轮次: ${result.turnsUsed}`,
    `评估分数: ${evaluation.score}/100 (${evaluation.passed ? "PASS" : "FAIL"})`,
    `Token使用: ${result.tokenUsage.reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0)} tokens`,
  ];

  if (evaluation.strengths.length > 0) {
    lines.push(`优点: ${evaluation.strengths.join("; ")}`);
  }
  if (evaluation.weaknesses.length > 0) {
    lines.push(`缺点: ${evaluation.weaknesses.join("; ")}`);
  }
  if (evaluation.hallucinations.length > 0) {
    lines.push(`幻觉: ${evaluation.hallucinations.join("; ")}`);
  }

  lines.push(`---`);
  return lines.join("\n");
}

/**
 * Log tool call details for analysis.
 */
export function formatToolCallDetails(result: AgentRunResult): string {
  if (result.toolCalls.length === 0) return "(无工具调用)";

  return result.toolCalls.map((tc, i) => {
    const inputStr = JSON.stringify(tc.input).slice(0, 200);
    const outputStr = tc.output.slice(0, 200);
    return `[${i + 1}] ${tc.toolName}: ${inputStr}\n    → ${outputStr}`;
  }).join("\n");
}
