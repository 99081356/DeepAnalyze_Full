// =============================================================================
// DeepAnalyze - Degenerate Repetition Detection Tests
// =============================================================================
// Tests the hasMassiveRepetition method to ensure:
// 1. True degenerate loops are detected (identical paragraphs 5+ times)
// 2. Legitimate outputs are never false-positived (reports, math, code, etc.)

import { describe, it, expect } from "vitest";
import { AgentRunner } from "../src/services/agent/agent-runner.js";
import type { ChatResponse, StreamChunk } from "../src/models/provider.js";

// Minimal mock router for instantiation
function createMockRouter(responses: ChatResponse[]) {
  let callIndex = 0;
  function* responseToChunks(response: ChatResponse): Generator<StreamChunk> {
    if (response.content) yield { type: "text", content: response.content };
    if (response.toolCalls) {
      for (const tc of response.toolCalls) yield { type: "tool_call", toolCall: tc };
    }
    yield { type: "done", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 10 } };
  }
  return {
    chatStream: function* (_messages: unknown, _options: unknown) {
      const resp = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      yield* responseToChunks(resp);
    },
    getDefaultModel: () => "mock",
    resolveModel: () => ({ provider: null as unknown, modelId: "mock" }),
  } as any;
}

describe("hasMassiveRepetition", () => {
  const runner = new AgentRunner(createMockRouter([{ content: "ok" }]));
  const detect = (text: string) => (runner as any).hasMassiveRepetition(text);

  // ── False positive tests: legitimate outputs must NOT trigger ──

  it("normal diverse report does NOT trigger", () => {
    const report = [
      "## 一、项目概述\n本项目是一个通用Agent平台，支持多种文档类型的处理和分析。",
      "## 二、技术架构\n系统采用分层架构设计，包含工具层、提示词层和编排层。",
      "## 三、数据处理\n支持PDF、DOCX、XLSX、PNG、音频、视频等多种文件格式。",
      "## 四、Agent系统\n主Agent负责理解用户意图，子Agent负责并行处理具体任务。",
      "## 五、安全机制\n包含反幻觉校验、真实性验证、工具调用统计等多重保障。",
      "## 六、性能优化\n通过compaction机制管理上下文窗口，支持200K token的长会话。",
      "## 七、测试结果\n所有206个Playwright测试用例通过，覆盖核心功能。",
      "## 八、结论\n系统已达到生产就绪状态，可以部署到客户环境。",
    ].join("\n\n");
    expect(detect(report)).toBe(false);
  });

  it("math reasoning with similar structure does NOT trigger", () => {
    const math = [
      "Step 1: Let x = 5 + 3 = 8, therefore x² = 64",
      "Step 2: Let y = 8 * 2 = 16, therefore y² = 256",
      "Step 3: Let z = 16 - 4 = 12, therefore z² = 144",
      "Step 4: Let w = 12 / 3 = 4, therefore w² = 16",
      "Step 5: Let v = 4 + 8 = 12, therefore v² = 144",
      "Step 6: Let u = 12 * 3 = 36, therefore u² = 1296",
    ].join("\n\n");
    expect(detect(math)).toBe(false);
  });

  it("short text does NOT trigger", () => {
    expect(detect("Hello world")).toBe(false);
  });

  it("repeated short phrases but diverse paragraphs do NOT trigger", () => {
    const text = [
      "工作流1负责处理第1-50章，包含凡间崛起和虚天殿副本的内容创作。",
      "工作流2负责处理第51-100章，包含化神期、慕兰草原和大晋王朝的内容。",
      "工作流3负责处理第101-150章，包含妖界、冥界和灵界上篇的故事。",
      "工作流4负责处理第151-200章，包含灵界下篇、仙界和大结局的收尾。",
      "工作流5负责整合所有章节，确保修为时间线一致，人物名字统一。",
    ].join("\n\n");
    expect(detect(text)).toBe(false);
  });

  it("4 identical paragraphs (below threshold) do NOT trigger", () => {
    const paragraph = "这是一段测试文本，用于验证检测算法在阈值边界处的行为是否正确。需要确保不会误触发。";
    const text = Array(4).fill(paragraph).join("\n\n");
    expect(detect(text)).toBe(false);
  });

  it("legitimate audit report with recurring phrases does NOT trigger", () => {
    const paragraphs = [];
    for (let i = 1; i <= 10; i++) {
      paragraphs.push(
        `### 检查项${i}\n\n检查结果：第${i}章的修为逻辑${i % 2 === 0 ? "存在矛盾" : "基本正确"}。` +
        `具体来说，主角在第${i}章的修为从${i === 1 ? "炼气" : i <= 3 ? "筑基" : i <= 6 ? "金丹" : "元婴"}期` +
        `${i % 2 === 0 ? "出现了回退现象" : " progression合理"}。` +
        `建议${i % 2 === 0 ? "修复" : "保持现状"}。`
      );
    }
    expect(detect(paragraphs.join("\n\n"))).toBe(false);
  });

  it("code-like output with short blocks does NOT trigger", () => {
    const code = [
      "function processChapter(chapter1) {\n  return analyze(chapter1);\n}",
      "function processChapter(chapter2) {\n  return analyze(chapter2);\n}",
      "function processChapter(chapter3) {\n  return analyze(chapter3);\n}",
      "function processChapter(chapter4) {\n  return analyze(chapter4);\n}",
      "function processChapter(chapter5) {\n  return analyze(chapter5);\n}",
    ].join("\n\n");
    expect(detect(code)).toBe(false);
  });

  it("crypto/password analysis with similar but different attempts does NOT trigger", () => {
    const attempts = [];
    for (let i = 0; i < 8; i++) {
      attempts.push(
        `Attempt ${i + 1}: Trying ROT-${i + 1} cipher on ciphertext "KHOOR ZRUOG". ` +
        `Result: "${String.fromCharCode(..."KHOOR".split("").map(c => c.charCodeAt(0) - 3 - i))}" ` +
        `Confidence: ${(0.3 + i * 0.08).toFixed(2)}`
      );
    }
    expect(detect(attempts.join("\n\n"))).toBe(false);
  });

  // ── True positive tests: degenerate loops MUST trigger ──

  it("identical paragraph repeated 7 times DOES trigger", () => {
    const paragraph = "现在开始执行！我将创建4个并行工作流，每个创作50章（约25万字）：\n\n工作流1：第1-50章（凡间崛起 + 虚天殿）\n工作流2：第51-100章（慕兰草原 + 大晋王朝）\n工作流3：第101-150章（妖界 + 冥界 + 灵界）\n工作流4：第151-200章（仙界 + 大结局）\n\n现在开始创建工作流！";
    const text = Array(7).fill(paragraph).join("\n\n");
    expect(detect(text)).toBe(true);
  });

  it("identical paragraph repeated exactly 5 times DOES trigger (at threshold)", () => {
    const paragraph = "这是第五次出现的完全相同的段落内容。模型在规划过程中反复生成相同文本，形成了退化输出循环。每次都说要开始执行，但永远不会真正调用工具。";
    const text = Array(5).fill(paragraph).join("\n\n");
    expect(detect(text)).toBe(true);
  });

  it("very long degenerate output with 10+ identical paragraphs DOES trigger", () => {
    const paragraph = "由于100万字工程量巨大，我将采用更高效的策略：分批并行创作，每批10万字。第一批（当前执行）：Agent1第1-20章，Agent2第21-40章，Agent3第41-60章。后续批次根据第一批结果继续。现在开始执行！";
    const text = Array(12).fill(paragraph).join("\n\n");
    expect(detect(text)).toBe(true);
  });
});
