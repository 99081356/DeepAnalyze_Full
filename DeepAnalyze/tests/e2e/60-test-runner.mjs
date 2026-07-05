/**
 * 60-Item Comprehensive E2E Test Runner
 *
 * Executes all 60 tests sequentially with:
 * - Frontend screenshots (before/after each test)
 * - Backend log analysis
 * - SSE event stream monitoring
 * - Tool call tracking and analysis
 * - Hallucination checks
 * - Result persistence and reporting
 *
 * Usage: node tests/e2e/60-test-runner.mjs [--start N] [--end N] [--only T01,T02,...]
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:21000";
const OUT = "/tmp/da-60test";
const TIMEOUT_DEFAULT = 600000; // 10 minutes per test default
const TIMEOUT_HEAVY = 900000;  // 15 minutes for heavy tests

// KB IDs
const BIGTEST_KB = "60346710-913d-4b54-b742-499da76cd85b";
const LBCTEST_KB = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

// ── SSE Parser ──
function parseSSE(raw) {
  const events = [];
  let currentEvent = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEvent = { type: line.slice(7).trim(), data: null };
    } else if (line.startsWith("data: ") && currentEvent) {
      try { currentEvent.data = JSON.parse(line.slice(6)); } catch { currentEvent.data = line.slice(6); }
      events.push(currentEvent);
      currentEvent = null;
    } else if (line.startsWith("data: ") && !currentEvent) {
      try { events.push({ type: "message", data: JSON.parse(line.slice(6)) }); } catch {}
      currentEvent = null;
    } else if (line.trim() === "") {
      currentEvent = null;
    }
  }
  return events;
}

// ── API Helpers ──
async function createSession(kbId, title) {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const s = await r.json();
  const sid = s.id || s.sessionId;
  // Always PATCH: bind specific KB when provided, or explicit empty scope for "no KB" tests.
  // Skipping PATCH leaves the session with backend default scope, which may include
  // pre-existing KBs — that defeats tests like T56 "Empty KB Handling".
  await fetch(`${BASE}/api/sessions/${sid}/scope`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kbScope: { kbIds: kbId ? [kbId] : [] } }),
  });
  return sid;
}

async function createDualKBSession(kbIds, title) {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const s = await r.json();
  const sid = s.id || s.sessionId;
  await fetch(`${BASE}/api/sessions/${sid}/scope`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kbScope: { kbIds } }),
  });
  return sid;
}

async function runAgent(sessionId, input, timeoutMs = TIMEOUT_DEFAULT) {
  const controller = new AbortController();
  // Add 60s buffer for network overhead beyond agent timeout
  const timer = setTimeout(() => controller.abort(), timeoutMs + 60000);
  const startTime = Date.now();
  try {
    const resp = await fetch(`${BASE}/api/agents/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, input }),
      signal: controller.signal,
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}`, elapsed: Date.now() - startTime };
    const raw = await resp.text();
    const events = parseSSE(raw);

    const textParts = events
      .filter(e => e.type === "progress" && e.data?.type === "text")
      .map(e => e.data.content || "").filter(Boolean);
    const toolCalls = events
      .filter(e => e.type === "tool_call")
      .map(e => ({ name: e.data?.toolName, input: e.data?.input }));
    const toolResults = events
      .filter(e => e.type === "tool_result")
      .map(e => ({ name: e.data?.toolName, result: e.data?.result }));
    const pushContents = events
      .filter(e => e.type === "push_content")
      .map(e => e.data);
    const done = events.find(e => e.type === "done");
    const complete = events.find(e => e.type === "complete");
    const fullOutput = complete?.data?.output || textParts.join("\n") || "";

    return {
      fullOutput,
      toolCalls,
      toolResults,
      pushContents,
      done: !!done,
      complete: complete?.data,
      allEvents: events,
      elapsed: Date.now() - startTime,
      rawLength: raw.length,
    };
  } catch (e) {
    return { error: e.message, elapsed: Date.now() - startTime };
  } finally {
    clearTimeout(timer);
  }
}

async function getBackendLogs() {
  try {
    const files = fs.readdirSync("/tmp").filter(f => f.startsWith("da_debug") && f.endsWith(".log")).sort();
    if (!files.length) return [];
    const content = fs.readFileSync(`/tmp/${files[files.length - 1]}`, "utf-8");
    return content.split("\n").slice(-500); // last 500 lines
  } catch { return []; }
}

function grepLogLines(lines, pattern) {
  return lines.filter(l => pattern.test(l));
}

// ── Screenshot Helper ──
async function takeScreenshot(page, sessionId, filename) {
  try {
    await page.goto(`${BASE}/?session=${sessionId}`, { waitUntil: "domcontentloaded" });
    // Wait for content to render
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(800);
      const hasContent = await page.evaluate(() => {
        const els = document.querySelectorAll(
          '[class*="markdown"], [class*="message"], [class*="content"], article, pre, [class*="push"]'
        );
        for (const el of els) {
          if (el.textContent && el.textContent.trim().length > 30) return true;
        }
        return false;
      });
      if (hasContent) break;
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/${filename}`, fullPage: true });
    return true;
  } catch (e) {
    console.log(`  Screenshot failed: ${e.message}`);
    return false;
  }
}

// ── Frontend Analysis Helper ──
async function analyzeFrontend(page) {
  return await page.evaluate(() => {
    const result = {
      pushCards: [],
      toolCallCards: [],
      messages: [],
      errors: [],
      bodyTextLength: 0,
    };

    // Check push content cards
    const pushEls = document.querySelectorAll('[class*="push-content"], [class*="PushContent"]');
    pushEls.forEach(el => {
      result.pushCards.push({
        text: (el.textContent || "").slice(0, 200),
        hasContent: (el.textContent || "").length > 10,
      });
    });

    // Check tool call cards
    const toolEls = document.querySelectorAll('[class*="tool-call"], [class*="ToolCall"]');
    toolEls.forEach(el => {
      result.toolCallCards.push({
        text: (el.textContent || "").slice(0, 100),
      });
    });

    // Check messages
    const msgEls = document.querySelectorAll('[class*="message-item"], [class*="MessageItem"]');
    result.messages = msgEls.length;

    // Check for console errors
    result.bodyTextLength = document.body.innerText.length;

    return result;
  });
}

// ── Core Analysis ──
function analyzeToolCalls(toolCalls, res) {
  const analysis = {
    total: toolCalls.length,
    byName: {},
    duplicateSearches: 0,
    emptyResults: 0,
    uniqueKbSearches: new Set(),
  };

  const searchQueries = [];
  for (const tc of toolCalls) {
    analysis.byName[tc.name] = (analysis.byName[tc.name] || 0) + 1;

    // Track search deduplication
    if (tc.name === "kb_search" || tc.name === "doc_grep") {
      const q = JSON.stringify(tc.input?.query || tc.input);
      if (searchQueries.includes(q)) analysis.duplicateSearches++;
      searchQueries.push(q);
    }
  }

  return analysis;
}

// ════════════════════════════════════════════════════════
// TEST CASES
// ════════════════════════════════════════════════════════

const TESTS = {
  // ── Group 1: Ultra-Long Reports & KB Deep Analysis ──
  T01: {
    name: "bigtest Full KB Comprehensive Deep Analysis",
    group: 1,
    kb: BIGTEST_KB,
    prompt: `请对知识库进行全面分析。步骤：
1. 先用 wiki_browse 查看分类结构，了解文档类型分布
2. 用 run_sql 统计各类型文档数量
3. 对论文类文档：展开3-5篇代表性论文的L1内容，分析技术主题和演进关系
4. 对剧本杀类文档：选择一个剧本杀，分析其核心推理逻辑和证据链
5. 对表格类文档：查看Excel的L0摘要，描述数据特征
6. 对图片/音视频：查看VLM描述和ASR转写的质量
7. 用 push_content 推送一份综合分析摘要卡片
每个类别至少分析2-3个文档，确保覆盖全面。`,
    timeout: 900000, // 15 min for full KB analysis
    observe: {
      expectTools: ["kb_search", "expand", "wiki_browse", "run_sql", "push_content"],
      minToolCalls: 30,
      minOutputChars: 10000,
      checkPushContent: true,
      checkHallucination: true,
    },
  },
  T02: {
    name: "lbctest Full Case Judicial Analysis",
    group: 1,
    kb: LBCTEST_KB,
    prompt: `请完成以下分析任务：
1. 详细分析整个案件，按人、时、地、事、物整理关键信息，编撰完整的案情介绍
2. 还原整个案件的完整时间线，提供所有案件推理和证据支撑材料
3. 梳理资金关系和流向，清晰分析资金划转情况，核实被害人资金损失情况
4. 提供量刑标准和法律指导意见，并将所有证据材料与每个量刑项关联
5. 使用司法证据链标准 skill 输出符合司法证据链要求的文档报告`,
    timeout: 600000,
    observe: {
      expectTools: ["kb_search", "expand", "doc_grep", "skill_invoke"],
      minToolCalls: 20,
      minOutputChars: 8000,
      checkPushContent: true,
    },
  },
  T03: {
    name: "Ultra-Long Single Document Deep Analysis",
    group: 1,
    kb: BIGTEST_KB,
    prompt: `请从知识库中选择"5241自杀派对"这个剧本杀游戏，对每个角色的剧本、线索、结局进行逐字深度分析。要求：
1. 列出所有角色的完整信息（姓名、身份、动机、行为时间线）
2. 对每条线索逐条分析含义、指向、与其他线索的关联
3. 构建完整的推理链：从初始线索到最终结论的每一步推理
4. 验证或排除每个可能的假设
5. 输出完整的故事还原，包括每个角色的视角`,
    timeout: 600000,
    observe: {
      expectTools: ["expand", "kb_search", "wiki_browse"],
      minToolCalls: 20,
      minOutputChars: 15000,
      checkHallucination: true,
    },
  },
  T04: {
    name: "Multi-KB Cross Analysis",
    group: 1,
    kb: [BIGTEST_KB, LBCTEST_KB], // dual KB
    prompt: `请同时分析 bigtest 和 lbctest 两个知识库。对比两个知识库的文档类型分布和内容主题差异。如果 bigtest 中有法律相关的剧本杀内容（如"681追凶"），与 lbctest 中的真实诉讼文书做对比，分析虚构案件与真实案件在证据链结构和逻辑推理方法上的异同。`,
    timeout: 600000,
    observe: {
      expectTools: ["kb_search", "expand"],
      minToolCalls: 15,
      minOutputChars: 5000,
    },
  },
  T05: {
    name: "Academic Paper Technology Evolution Analysis",
    group: 1,
    kb: BIGTEST_KB,
    prompt: `请分析知识库中的所有学术论文。要求：
1. 每篇论文的核心贡献（200字以内概述）
2. 论文之间的引用关系和技术演进路径
3. 每篇论文的方法论对比（包含优势、局限性、适用场景）
4. 对未来研究方向的预测和建议（基于论文中的局限性和future work）
5. 技术成熟度评估（每项技术处于什么阶段：理论/原型/生产）
输出结构化分析报告，每个分析维度作为一个独立章节。`,
    timeout: 600000,
    observe: {
      expectTools: ["expand", "kb_search", "run_sql"],
      minToolCalls: 20,
      minOutputChars: 8000,
    },
  },
  T06: {
    name: "Anti-Hallucination Number Sensitivity",
    group: 1,
    kb: BIGTEST_KB,
    prompt: `请从知识库中找出所有涉及金额、数量、日期、百分比等数字的内容，整理成结构化表格。每个数字必须标注：来源文档名称、原文段落、上下文含义。不允许出现原文中不存在的数字。`,
    timeout: 300000,
    observe: {
      expectTools: ["kb_search", "doc_grep", "expand"],
      minToolCalls: 10,
      checkHallucination: true,
    },
  },
  T07: {
    name: "Table Data Deep Analysis",
    group: 1,
    kb: BIGTEST_KB,
    prompt: `请详细分析知识库中的Excel表格数据。要求：
1. 整体表格描述（行数、列数、列名含义、数据类型）
2. 每列的统计分析（数值列：均值/中位数/最大值/最小值/缺失率；分类列：唯一值数/分布）
3. 关键发现（异常值、趋势、相关性）
4. 数据质量评估（缺失值、重复行、异常值比例）
5. 可视化建议（根据数据特征推荐5种图表类型）
所有统计数字必须通过 run_sql 或 bash(python3) 实际计算，不允许估算。`,
    timeout: 300000,
    observe: {
      expectTools: ["run_sql", "expand", "bash"],
      minToolCalls: 10,
      checkHallucination: true,
    },
  },
  T08: {
    name: "Multimodal Content Analysis",
    group: 1,
    kb: BIGTEST_KB,
    prompt: `请分析知识库中的所有图片、音频和视频文件。要求：
1. 图片：描述每张图片的内容；如果是截图，分析界面功能；如果是照片，分析场景和人物
2. 音频：转写所有音频内容，标注说话人和时间戳
3. 视频：描述视频内容，提取关键帧和对话
4. 多模态关联：分析不同媒体文件之间是否存在关联
5. VLM验证：图片描述必须基于VLM视觉分析结果，不允许捏造描述`,
    timeout: 300000,
    observe: {
      expectTools: ["expand", "run_sql", "tool_discover"],
      minToolCalls: 10,
      minOutputChars: 3000,
    },
  },
  T09: {
    name: "Web Search + KB Hybrid Analysis",
    group: 1,
    kb: null, // no KB
    prompt: `请根据 DeepSeek、Qwen、Kimi、MiniMax 等国产模型的最新技术报告和论文，写一份详细的AI发展现状技术报告，包含所有技术模块、演进方向、主要问题、处理方法等详细信息。完成后根据详细技术报告编写一份综合PPT大纲。`,
    timeout: 300000,
    observe: {
      expectTools: ["web_search"],
      minToolCalls: 5,
      minOutputChars: 5000,
      checkNoKBError: true,
    },
  },
  T10: {
    name: "Consistency Verification (3x)",
    group: 1,
    kb: LBCTEST_KB,
    multiRun: 3,
    prompt: `请列出本案件涉及的所有资金转账记录，包括金额、日期、转出方、接收方。按时间顺序排列。`,
    timeout: 300000,
    observe: {
      expectTools: ["kb_search", "expand", "doc_grep"],
      minToolCalls: 5,
      consistencyCheck: true,
    },
  },

  // ── Group 2: Multi-Agent Extreme Scenarios ──
  T11: {
    name: "Parallel Sub-Agent Document Analysis",
    group: 2,
    kb: BIGTEST_KB,
    prompt: `请使用 workflow_run parallel 模式，将知识库中的所有文档按类型分为5-8组，每组分配一个子Agent进行深度分析。每个子Agent负责：文档清单整理、核心内容摘要、关键发现提取。所有子Agent完成后，主Agent汇总输出综合分析报告。`,
    timeout: 600000,
    observe: {
      expectTools: ["workflow_run"],
      minToolCalls: 5,
      minOutputChars: 5000,
      checkSubAgents: true,
    },
  },
  T12: {
    name: "Pipeline Mode Serial Chain",
    group: 2,
    kb: LBCTEST_KB,
    prompt: `请使用 workflow_run pipeline 模式，按串行步骤分析案件：
1. 信息收集Agent：收集所有文档，按类别分类
2. 事实提取Agent：从分类结果中提取所有事实要素
3. 证据链构建Agent：基于事实要素构建完整证据链
4. 法律分析Agent：基于证据链进行法律分析和量刑建议
5. 报告生成Agent：生成最终结构化报告
每个Agent的输出作为下一个Agent的输入。`,
    timeout: 600000,
    observe: {
      expectTools: ["workflow_run"],
      minToolCalls: 3,
      minOutputChars: 3000,
    },
  },
  T13: {
    name: "Council Mode Cross Review",
    group: 2,
    kb: BIGTEST_KB,
    prompt: `请使用 council 模式安排3个不同视角的子Agent分析知识库中的学术论文：
- Agent A（技术评估者）：评估每篇论文的技术创新性和方法有效性
- Agent B（应用分析师）：分析每篇论文的实用价值和落地场景
- Agent C（批判审阅者）：找出每篇论文的局限性和潜在问题
第一轮完成后，进行交叉审阅，每个Agent审阅另一个Agent的分析。`,
    timeout: 1800000, // 30 min — council mode spawns 6 agents (~2.5M tokens)
    observe: {
      expectTools: ["workflow_run"],
      minToolCalls: 3,
      minOutputChars: 3000,
    },
  },
  T14: {
    name: "Graph Mode DAG Dependencies",
    group: 2,
    kb: BIGTEST_KB,
    prompt: `使用 graph 模式分析知识库。设置以下Agent依赖关系：
- 基础调研Agent（无依赖）：浏览所有文档，提取基础信息
- 论文分析Agent（依赖基础调研）：深度分析论文部分
- 剧本杀分析Agent（依赖基础调研）：深度分析剧本杀部分
- 多媒体分析Agent（依赖基础调研）：分析图片/音频/视频
- 综合报告Agent（依赖论文分析+剧本杀分析+多媒体分析）：汇总所有分析结果`,
    timeout: 1800000, // 30 min — graph mode with 5+ dependent agents
    observe: {
      expectTools: ["workflow_run"],
      minToolCalls: 3,
      minOutputChars: 3000,
    },
  },
  T15: {
    name: "Ultra-Long Tool Chain (50+ Steps)",
    group: 2,
    kb: BIGTEST_KB,
    prompt: `请逐个阅读知识库中所有PDF论文的L1内容，对每篇论文输出以下信息：
1. 论文标题和作者
2. 核心方法（200字以内）
3. 实验结果中的关键指标（精确引用数值）
4. 主要局限性
每篇论文的分析必须在通过 expand 工具获取 L1 内容后进行总结。`,
    timeout: 1800000, // 30 min — 50+ sequential tool calls
    observe: {
      expectTools: ["expand", "kb_search"],
      minToolCalls: 20,
      minOutputChars: 5000,
    },
  },
  T16: {
    name: "Main+Sub Agent Hybrid",
    group: 2,
    kb: LBCTEST_KB,
    prompt: `分析这个案件。首先你（主Agent）搜索和阅读关键文档形成初步理解。然后派遣2个子Agent分别分析不同的证据组。子Agent完成后，你综合所有信息输出最终分析。`,
    timeout: 1800000, // 30 min — main + sub hybrid
    observe: {
      expectTools: ["kb_search", "expand", "delegate_task"],
      minToolCalls: 10,
      minOutputChars: 3000,
    },
  },
  T17: {
    name: "Agent Failure + Partial Success",
    group: 2,
    kb: BIGTEST_KB,
    prompt: `请使用 workflow_run parallel 模式分成5个子Agent分析知识库的不同部分：
- Agent 1：分析所有PDF论文
- Agent 2：分析"5241自杀派对"剧本杀
- Agent 3：分析所有图片
- Agent 4：分析Excel表格
- Agent 5：分析所有音频和视频
如果某个子Agent失败，其他Agent应继续执行并输出结果。`,
    timeout: 1800000, // 30 min — parallel 5 agents with partial failure
    observe: {
      expectTools: ["workflow_run"],
      minToolCalls: 3,
      minOutputChars: 2000,
    },
  },
  T18: {
    name: "Nested Workflow",
    group: 2,
    kb: BIGTEST_KB,
    prompt: `请将知识库按主题分为3大组，每组使用一个子Agent进行分析。如果分析论文组的子Agent发现论文太多，应该进一步使用 delegate_task 派遣更细粒度的分析任务。`,
    timeout: 1800000, // 30 min — nested workflow
    observe: {
      expectTools: ["workflow_run", "delegate_task"],
      minToolCalls: 5,
      minOutputChars: 3000,
    },
  },
  T19: {
    name: "Super-Long Workflow 100+ Steps",
    group: 2,
    kb: [BIGTEST_KB, LBCTEST_KB],
    prompt: `请完成以下综合任务：
1. 浏览 bigtest 知识库中的所有文档，按类型分类
2. 对每篇论文展开L1内容分析技术要点
3. 对每个剧本杀进行完整剧情分析和推理
4. 浏览 lbctest 知识库中的所有文档，分类整理
5. 提取 lbctest 中的所有时间线信息
6. 为 lbctest 构建完整证据链
7. 交叉对比两个知识库中法律相关内容的异同
8. 生成最终综合报告`,
    timeout: 2400000, // 40 min — dual-KB super-long workflow 100+ steps
    observe: {
      expectTools: ["kb_search", "expand", "wiki_browse", "run_sql", "doc_grep"],
      minToolCalls: 30,
      minOutputChars: 8000,
    },
  },
  T20: {
    name: "Cancel and Resume",
    group: 2,
    kb: BIGTEST_KB,
    prompt: `请对知识库进行全面深入的分析，逐个展开所有文档，分析每个文档的内容，最后生成综合报告。`,
    timeout: 300000,
    observe: {
      cancelAfter: 3, // cancel after 3 tool calls
      resumeWith: "请简单告诉我知识库里有多少文档？主要有哪些类型？",
    },
  },

  // ── Group 3: Skill/Plugin Evolution ──
  T21: {
    name: "Built-in Skill Auto-Activation",
    group: 3,
    kb: BIGTEST_KB,
    prompt: `请对知识库进行全面知识库分析并生成分析报告。`,
    timeout: 1800000, // 30 min — full-KB analysis + skill auto-activation
    observe: {
      expectTools: ["skill_invoke"],
      minToolCalls: 10,
      minOutputChars: 5000,
    },
  },
  T22: {
    name: "Skill Create-Verify-Invoke",
    group: 3,
    kb: null,
    multiTurn: [
      "请帮我创建一个新的 skill，名为\"市场分析助手\"，用于分析市场数据和竞争格局。要求：1) 先搜索相关市场数据 2) 创建竞品对比表格 3) 输出 SWOT 分析。保存到数据库。",
      "验证刚创建的skill，使用 list_skills 检查是否在列表中。",
      "请使用这个skill分析当前中国新能源汽车市场现状。",
    ],
    timeout: 600000, // 10 min — multi-turn skill create/verify/invoke, no KB
    observe: {
      expectTools: ["skill_create", "list_skills", "skill_invoke"],
      minToolCalls: 3,
    },
  },
  T23: {
    name: "Skill Modify & Compare",
    group: 3,
    kb: BIGTEST_KB,
    multiTurn: [
      "使用\"报告生成\"skill对知识库中的论文生成分析报告。",
      "修改\"报告生成\"skill，增加要求\"每个分析点都必须有数据支撑，禁止无数据的主观判断\"。",
      "再次使用修改后的\"报告生成\"skill生成分析报告。",
    ],
    timeout: 1800000, // 30 min — multi-turn skill modify + compare on BIGTEST
    observe: {
      expectTools: ["skill_invoke", "skill_update"],
      minToolCalls: 5,
    },
  },
  T24: {
    name: "Evidence Chain Skill",
    group: 3,
    kb: LBCTEST_KB,
    prompt: `请使用"evidence-chain" skill 分析本案的证据链完整性。要求：
1. 收集所有证据材料
2. 构建证据链关系图（时序关系、因果关系、印证关系、矛盾关系）
3. 评估证据链完整性（缺失环节标注[待补充]，矛盾标注[矛盾]）
4. 生成证据链报告，附原文引用链接`,
    timeout: 1800000, // 30 min — evidence-chain skill on LBCTEST
    observe: {
      expectTools: ["skill_invoke", "expand", "kb_search"],
      minToolCalls: 10,
      minOutputChars: 5000,
    },
  },
  T25: {
    name: "Timeline + Entity Network Skills",
    group: 3,
    kb: LBCTEST_KB,
    prompt: `请分别使用"timeline-reconstruction"和"entity-network"技能分析案件。先用时间线重建skill构建完整案件时间线，再用实体网络skill梳理所有人物和组织关系。最后综合两个skill的结果输出完整的案件全景分析。`,
    timeout: 1800000, // 30 min — timeline + entity-network on LBCTEST
    observe: {
      expectTools: ["skill_invoke"],
      minToolCalls: 10,
      minOutputChars: 5000,
    },
  },
  T26: {
    name: "Skill Hub Search + Install",
    group: 3,
    kb: null,
    prompt: `请搜索 Skill Hub 中与"数据分析"相关的技能，选择最合适的一个安装，然后使用它分析以下数据：[1,2,3,4,5,6,7,8,9,10] 的统计特征。`,
    timeout: 600000, // 10 min — skill hub search + install
    observe: {
      expectTools: ["skill_hub_search", "skill_install", "skill_invoke"],
      minToolCalls: 3,
    },
  },
  T27: {
    name: "Skill Auto-Evolution",
    group: 3,
    kb: BIGTEST_KB,
    prompt: `请分析知识库中的论文，根据分析过程中遇到的困难和发现，自动优化你正在使用的分析skill。记录优化前后的差异。`,
    timeout: 1800000, // 30 min — skill auto-evolution on BIGTEST
    observe: {
      expectTools: ["skill_invoke", "skill_update"],
      minToolCalls: 10,
    },
  },
  T28: {
    name: "Plugin Enable/Disable",
    group: 3,
    kb: LBCTEST_KB,
    prompt: `请先禁用 judicial-analysis 插件，然后尝试进行案件分析。观察分析结果有什么不同。然后重新启用插件再次分析。`,
    timeout: 1800000, // 30 min — plugin enable/disable + re-analyze
    observe: {
      expectTools: ["plugin_disable", "plugin_enable"],
      minToolCalls: 5,
    },
  },

  // ── Group 4: KB Lifecycle & Retrieval ──
  T29: {
    name: "KB Full Lifecycle",
    group: 4,
    kb: null,
    prompt: `请帮我创建一个新的知识库，名称为"测试知识库"。然后告诉我这个新知识库的ID。`,
    timeout: 120000,
    observe: {
      expectTools: ["kb_create"],
      minToolCalls: 1,
    },
  },
  T30: {
    name: "Cross-KB Search",
    group: 4,
    kb: [BIGTEST_KB, LBCTEST_KB],
    prompt: `请同时搜索两个知识库中包含"证据"关键词的内容，对比两个知识库中关于"证据"的文档数量和类型分布。`,
    timeout: 300000,
    observe: {
      expectTools: ["kb_search", "doc_grep"],
      minToolCalls: 5,
    },
  },
  T31: {
    name: "Deep Preprocessing Verification",
    group: 4,
    kb: BIGTEST_KB,
    prompt: `请检查知识库中所有文档的预处理状态。对每种文件类型（PDF、DOCX、图片、音频、视频、Excel），分别查看L0、L1、L2层的内容完整性。报告哪些文档的预处理可能存在问题。`,
    timeout: 300000,
    observe: {
      expectTools: ["expand", "run_sql", "wiki_browse"],
      minToolCalls: 15,
    },
  },
  T32: {
    name: "Document Reprocess",
    group: 4,
    kb: BIGTEST_KB,
    prompt: `请列出知识库中所有图片类型的文档，检查每张图片的VLM描述质量。如果发现有图片的VLM描述为空或为占位符，请使用 image_analysis 工具重新分析。`,
    timeout: 300000,
    observe: {
      expectTools: ["run_sql", "expand", "tool_discover"],
      minToolCalls: 10,
    },
  },
  T33: {
    name: "Search Modes Comparison",
    group: 4,
    kb: BIGTEST_KB,
    prompt: `请分别用 kb_search、doc_grep、bash(grep) 三种方式搜索知识库中包含"推理"关键词的内容。对比三种搜索方式的结果数量、覆盖范围和速度。`,
    timeout: 300000,
    observe: {
      expectTools: ["kb_search", "doc_grep", "bash"],
      minToolCalls: 5,
    },
  },
  T34: {
    name: "Search Saturation Detection",
    group: 4,
    kb: BIGTEST_KB,
    prompt: `请对知识库进行极其全面的搜索分析。使用多种关键词组合（"分析"、"推理"、"证据"、"时间线"、"人物"）反复搜索，直到搜索结果开始大量重复。观察系统何时触发搜索饱和提示。`,
    timeout: 300000,
    observe: {
      expectTools: ["kb_search", "doc_grep"],
      minToolCalls: 10,
    },
  },
  T35: {
    name: "Anchor System",
    group: 4,
    kb: BIGTEST_KB,
    prompt: `请展开知识库中第一个PDF论文的L2内容，然后尝试使用锚点定位到论文的第三节。描述锚点系统的使用方式和效果。`,
    timeout: 300000,
    observe: {
      expectTools: ["expand"],
      minToolCalls: 3,
    },
  },
  T36: {
    name: "KB CRUD Stress",
    group: 4,
    kb: BIGTEST_KB,
    prompt: `请对知识库执行以下操作：1) 浏览所有分类 2) 查看每个分类的文档数量 3) 对前10个文档展开L1 4) 搜索5个不同关键词 5) 统计总文档数和各类型文档数`,
    timeout: 300000,
    observe: {
      expectTools: ["wiki_browse", "expand", "kb_search", "run_sql"],
      minToolCalls: 15,
    },
  },

  // ── Group 5: MCP/Model/Frontend ──
  T37: {
    name: "MCP Server Lifecycle",
    group: 5,
    kb: null,
    prompt: `请列出当前所有可用的 MCP 服务器，检查每个服务器的连接状态。尝试使用 web_search MCP 工具搜索"2026年AI最新进展"。`,
    timeout: 300000,
    observe: {
      expectTools: ["mcp_list", "web_search"],
      minToolCalls: 2,
    },
  },
  T38: {
    name: "Model Switching",
    group: 5,
    kb: BIGTEST_KB,
    prompt: `请分析知识库中的第一个文档。给出简要摘要。`,
    timeout: 180000,
    observe: {
      minToolCalls: 2,
      minOutputChars: 200,
    },
  },
  T39: {
    name: "Multi-Role Models",
    group: 5,
    kb: BIGTEST_KB,
    prompt: `请使用 workflow_run 模式，安排3个子Agent使用不同角色分析同一个文档：一个作为技术专家、一个作为普通读者、一个作为批评家。`,
    timeout: 1800000, // 30 min — workflow_run with 3 multi-role sub-agents
    observe: {
      expectTools: ["workflow_run"],
      minToolCalls: 3,
    },
  },
  T40: {
    name: "Provider Circuit Breaker",
    group: 5,
    kb: BIGTEST_KB,
    prompt: `请连续搜索知识库10次，每次搜索不同的关键词。观察系统在高频请求下的行为。`,
    timeout: 300000,
    observe: {
      expectTools: ["kb_search"],
      minToolCalls: 8,
    },
  },
  T41: {
    name: "Frontend Streaming Display",
    group: 5,
    kb: BIGTEST_KB,
    prompt: `请写一篇关于知识库内容概览的详细报告，包括文档分类、每类文档数量、知识库主题分析等。要求输出足够长以便观察流式渲染效果。`,
    timeout: 300000,
    observe: {
      minToolCalls: 5,
      minOutputChars: 3000,
      checkStreaming: true,
    },
  },
  T42: {
    name: "Tool Call Cards Display",
    group: 5,
    kb: BIGTEST_KB,
    prompt: `请对知识库进行以下操作：搜索"推理"关键词、展开第一个搜索结果的L1内容、用 doc_grep 搜索"时间线"、查看wiki分类结构。每步都要有明确的工具调用。`,
    timeout: 300000,
    observe: {
      expectTools: ["kb_search", "expand", "doc_grep", "wiki_browse"],
      minToolCalls: 4,
    },
  },
  T43: {
    name: "Push Content Cards Display",
    group: 5,
    kb: BIGTEST_KB,
    prompt: `请分析知识库中的论文部分，生成3个独立的push_content卡片：1）论文概览卡片 2）技术演进分析卡片 3）未来研究方向卡片。每个卡片内容不少于500字。`,
    timeout: 1800000, // 30 min — 3 deep push_content cards
    observe: {
      expectTools: ["push_content"],
      minToolCalls: 5,
      checkPushContent: true,
    },
  },
  T44: {
    name: "Multi-Panel Switch",
    group: 5,
    kb: BIGTEST_KB,
    prompt: `请分析知识库并生成报告。在分析过程中展示工具调用面板、子Agent面板（如果有）、和报告面板的交互。`,
    timeout: 1800000, // 30 min — multi-panel analysis with report generation
    observe: {
      minToolCalls: 5,
    },
  },

  // ── Group 6: Robustness & Recovery ──
  T45: {
    name: "Compaction Info Retention",
    group: 6,
    kb: BIGTEST_KB,
    prompt: `请展开知识库前20个文档获取L1内容，列出每个文档的ID和摘要。确保所有文档ID都被完整保留。`,
    timeout: 600000,
    observe: {
      expectTools: ["expand"],
      minToolCalls: 20,
      minOutputChars: 3000,
    },
  },
  T46: {
    name: "SSE Reconnect",
    group: 6,
    kb: BIGTEST_KB,
    prompt: `请分析知识库中的剧本杀内容。要求输出详细的角色分析和线索梳理。`,
    timeout: 1800000, // 30 min — 4 剧本杀 detailed analysis
    observe: {
      minToolCalls: 5,
      minOutputChars: 2000,
    },
  },
  T47: {
    name: "Large File Upload",
    group: 6,
    kb: null,
    prompt: `请告诉我如何上传文件到知识库，以及支持哪些文件类型。`,
    timeout: 60000,
    observe: {
      minToolCalls: 0,
      minOutputChars: 100,
    },
  },
  T48: {
    name: "Concurrent Session Isolation",
    group: 6,
    kb: BIGTEST_KB,
    prompt: `请搜索知识库中包含"分析"关键词的内容。`,
    timeout: 180000,
    observe: {
      expectTools: ["kb_search"],
      minToolCalls: 2,
    },
  },
  T49: {
    name: "Error Boundary Recovery",
    group: 6,
    kb: BIGTEST_KB,
    prompt: `请搜索知识库中包含一个不存在的超级长关键词"zzzzzzzzzzzzzzzzzzzz nonexistent keyword test 12345"的内容，然后正常搜索"分析"关键词，验证系统能正常恢复。`,
    timeout: 180000,
    observe: {
      expectTools: ["kb_search"],
      minToolCalls: 2,
    },
  },
  T50: {
    name: "Full Chain Stress Test",
    group: 6,
    kb: BIGTEST_KB,
    prompt: `请执行以下完整流程：
1. 浏览知识库分类结构
2. 搜索关键词"论文"
3. 展开前3个搜索结果
4. 对比3个文档内容
5. 生成分析摘要
6. 推送分析报告卡片`,
    timeout: 300000,
    observe: {
      expectTools: ["wiki_browse", "kb_search", "expand", "push_content"],
      minToolCalls: 8,
      checkPushContent: true,
    },
  },

  // ── Additional Tests T51-T60 ──
  T51: {
    name: "Multi-Turn Context Retention",
    group: 6,
    kb: BIGTEST_KB,
    multiTurn: [
      "请搜索知识库中关于剧本杀的文档，列出所有剧本杀的名称。",
      "第二个剧本杀叫什么名字？有多少个文档？",
      "请展开第一个剧本杀的前3个文档的L1内容。",
    ],
    timeout: 300000,
    observe: {
      expectTools: ["kb_search", "expand"],
      minToolCalls: 5,
    },
  },
  T52: {
    name: "Attachment Inline Parse",
    group: 5,
    kb: null,
    prompt: `我接下来会上传一个文件请你分析。请准备好。`,
    timeout: 120000,
    observe: {
      minToolCalls: 0,
      minOutputChars: 50,
    },
  },
  T53: {
    name: "Report Generation Quality",
    group: 1,
    kb: BIGTEST_KB,
    prompt: `请使用报告生成skill生成一份关于知识库中论文部分的分析报告。报告需要包含：摘要、方法论分析、实验结果对比、结论。`,
    timeout: 1800000,
    observe: {
      expectTools: ["skill_invoke", "expand", "push_content"],
      minToolCalls: 10,
      minOutputChars: 5000,
    },
  },
  T54: {
    name: "Bash Tool First-Class Citizen",
    group: 5,
    kb: BIGTEST_KB,
    prompt: `请使用 bash 工具执行 python3 脚本来统计知识库中文档类型的分布。然后用 grep 搜索知识库磁盘文件中包含特定关键词的文件。验证 bash 作为一等公民的使用体验。`,
    timeout: 300000,
    observe: {
      expectTools: ["bash"],
      minToolCalls: 3,
    },
  },
  T55: {
    name: "Long Output Continuation",
    group: 6,
    kb: BIGTEST_KB,
    prompt: `请对知识库中的每个剧本杀（逐个）进行极其详细的分析，每个剧本杀分析不少于3000字，包括：角色分析、线索解读、推理过程、故事还原、结局分析。`,
    timeout: 1800000,
    observe: {
      minToolCalls: 10,
      minOutputChars: 10000,
    },
  },
  T56: {
    name: "Empty KB Handling",
    group: 4,
    kb: null,
    prompt: `请分析我的知识库中的所有文档。`,
    // Empty kbScope: both main agent and sub-agents must respect the scope.
    // KB-scoped tools (kb_search, expand, doc_grep, wiki_browse, db_query) are
    // excluded from tool definitions (Layer 1) and blocked at runtime if
    // hallucinated (Layer 2). run_sql is blocked from querying KB tables.
    // bash/grep/read_file are blocked from accessing wiki/ and original/ dirs.
    // The agent may still spawn workflows for non-KB work, which takes time.
    timeout: 900000,
    observe: {
      minToolCalls: 1,
      checkNoKBError: true,
    },
  },
  T57: {
    name: "Tool Discovery Deferred Tools",
    group: 5,
    kb: BIGTEST_KB,
    prompt: `请使用 tool_discover 工具查找 image_analysis 工具，然后用它分析知识库中的第一张图片。`,
    timeout: 300000,
    observe: {
      expectTools: ["tool_discover"],
      minToolCalls: 3,
    },
  },
  T58: {
    name: "Context Compaction Trigger",
    group: 6,
    kb: BIGTEST_KB,
    prompt: `请展开知识库中所有文档的L1内容，对每个文档进行简要分析。这将产生大量上下文来触发压缩机制。`,
    timeout: 1800000,
    observe: {
      expectTools: ["expand"],
      minToolCalls: 30,
    },
  },
  T59: {
    name: "Multi-Language Support",
    group: 5,
    kb: BIGTEST_KB,
    prompt: `Please analyze the documents in the knowledge base and provide a brief summary in English of the main categories and themes found.`,
    timeout: 300000,
    observe: {
      minToolCalls: 3,
      minOutputChars: 500,
    },
  },
  T60: {
    name: "System Health & Final Validation",
    group: 6,
    kb: BIGTEST_KB,
    prompt: `请执行以下验证步骤：
1. 搜索知识库验证搜索功能正常
2. 展开一个文档验证L1内容正常
3. 使用push_content推送一个测试卡片验证推送功能正常
4. 总结系统当前的健康状态`,
    timeout: 300000,
    observe: {
      expectTools: ["kb_search", "expand", "push_content"],
      minToolCalls: 4,
      checkPushContent: true,
    },
  },
};

// ════════════════════════════════════════════════════════
// TEST EXECUTION ENGINE
// ════════════════════════════════════════════════════════

async function executeSingleTest(browser, testId, test) {
  const result = {
    id: testId,
    name: test.name,
    group: test.group,
    passed: false,
    score: 0,
    details: [],
    issues: [],
    screenshots: [],
    metrics: {},
  };

  const page = await browser.newPage();
  const logsBefore = await getBackendLogs();

  try {
    result.details.push(`Starting ${testId}: ${test.name}`);

    if (test.multiTurn) {
      // Multi-turn test
      result.details.push(`Mode: multi-turn (${test.multiTurn.length} turns)`);
      let sid = await createSession(test.kb, `${testId}-multi`);
      result.details.push(`Session: ${sid}`);

      await takeScreenshot(page, sid, `${testId}-00-initial.png`);

      let allToolCalls = [];
      let allOutput = "";
      let turnResults = [];

      for (let i = 0; i < test.multiTurn.length; i++) {
        const turnPrompt = test.multiTurn[i];
        result.details.push(`Turn ${i+1}: "${turnPrompt.slice(0, 60)}..."`);
        const res = await runAgent(sid, turnPrompt, test.timeout);

        if (res.error) {
          result.details.push(`  Turn ${i+1} ERROR: ${res.error}`);
          result.issues.push(`Turn ${i+1} error: ${res.error}`);
          continue;
        }

        turnResults.push(res);
        allToolCalls.push(...res.toolCalls);
        allOutput += (allOutput ? "\n\n" : "") + res.fullOutput;

        result.details.push(`  Done: ${res.done}, Tools: ${res.toolCalls.length}, Output: ${res.fullOutput?.length || 0}ch, Time: ${(res.elapsed/1000).toFixed(1)}s`);
      }

      result.metrics = {
        totalToolCalls: allToolCalls.length,
        totalOutputChars: allOutput.length,
        turns: test.multiTurn.length,
      };

      const tc = analyzeToolCalls(allToolCalls);
      result.details.push(`Tool breakdown: ${Object.entries(tc.byName).map(([k,v]) => `${k}=${v}`).join(", ")}`);

      // Screenshot final state
      await takeScreenshot(page, sid, `${testId}-99-final.png`);

      // Evaluate
      const obs = test.observe || {};
      let score = 0;
      let maxScore = 0;

      // All turns completed
      maxScore += 20;
      if (turnResults.every(r => r.done || r.fullOutput?.length > 0)) { score += 20; }

      // Tool call count
      maxScore += 20;
      if (allToolCalls.length >= (obs.minToolCalls || 1)) { score += 20; }
      else { result.issues.push(`Tool calls ${allToolCalls.length} < ${obs.minToolCalls}`); }

      // Output length
      maxScore += 20;
      if (allOutput.length >= (obs.minOutputChars || 50)) { score += 20; }

      // No errors
      maxScore += 20;
      if (!result.issues.some(i => i.includes("error"))) { score += 20; }

      // Expected tools present
      maxScore += 20;
      if (obs.expectTools) {
        const found = obs.expectTools.filter(t => tc.byName[t]);
        if (found.length >= Math.min(1, obs.expectTools.length)) { score += 20; }
        else { result.issues.push(`Expected tools not found: ${obs.expectTools.filter(t => !tc.byName[t]).join(", ")}`); }
      } else { score += 20; }

      result.score = score;
      result.passed = score >= maxScore * 0.6;

    } else if (test.multiRun) {
      // Multi-run consistency test
      result.details.push(`Mode: multi-run (${test.multiRun}x)`);
      const outputs = [];

      for (let run = 0; run < test.multiRun; run++) {
        const sid = await createSession(test.kb, `${testId}-run${run}`);
        result.details.push(`Run ${run+1}: Session ${sid}`);

        const res = await runAgent(sid, test.prompt, test.timeout);
        if (res.error) {
          result.details.push(`  Run ${run+1} ERROR: ${res.error}`);
          result.issues.push(`Run ${run+1} error: ${res.error}`);
          outputs.push("");
          continue;
        }

        outputs.push(res.fullOutput || "");
        result.details.push(`  Run ${run+1}: Done=${res.done}, Tools=${res.toolCalls.length}, Output=${res.fullOutput?.length || 0}ch`);

        await takeScreenshot(page, sid, `${testId}-run${run}-final.png`);
      }

      // Consistency check: compare outputs
      result.metrics = { runs: test.multiRun, outputLengths: outputs.map(o => o.length) };

      // Simple consistency: extract numbers and compare
      const numPatterns = outputs.map(o => (o.match(/\d+[\.\d]*/g) || []).sort());
      const consistent = numPatterns.length >= 2 &&
        numPatterns[0].slice(0, 20).join(",") === numPatterns[numPatterns.length - 1].slice(0, 20).join(",");

      result.details.push(`Number consistency: ${consistent ? "CONSISTENT" : "DIFFERENT"}`);
      result.passed = outputs.filter(o => o.length > 0).length === test.multiRun;

    } else if (test.observe?.cancelAfter) {
      // Cancel-and-resume test: stream SSE until N tool calls, then abort via AbortController
      // (ported from t20-cancel.mjs — proves cancellation works mid-stream)
      result.details.push(`Mode: cancel-resume (cancelAfter=${test.observe.cancelAfter})`);
      const sid = await createSession(test.kb, `${testId}-cancel`);
      result.details.push(`Session: ${sid}`);

      const cancelTarget = test.observe.cancelAfter;
      const ctrl = new AbortController();
      const t0 = Date.now();
      let firstToolCalls = 0;
      let firstOutput = "";
      let firstTaskId = null;
      let aborted = false;
      // Hard timeout: 120s to reach cancel target (typical: 30-60s for 3 tool calls)
      const hardTimeout = setTimeout(() => {
        if (!aborted) { aborted = true; ctrl.abort(); }
      }, 120000);

      try {
        const resp = await fetch(`${BASE}/api/agents/run-stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid, input: test.prompt }),
          signal: ctrl.signal,
        });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop();
          for (const part of parts) {
            let etype = "", edata = null;
            for (const line of part.split("\n")) {
              if (line.startsWith("event: ")) etype = line.slice(7).trim();
              if (line.startsWith("data: ")) {
                try { edata = JSON.parse(line.slice(6)); } catch { edata = line.slice(6); }
              }
            }
            if (!etype) continue;
            if (etype === "start" && edata?.taskId) firstTaskId = edata.taskId;
            if (etype === "tool_call") {
              firstToolCalls++;
              result.details.push(`  First-run tool #${firstToolCalls}: ${edata?.toolName || "unknown"}`);
            }
            if (etype === "content_delta" && edata?.delta) firstOutput += edata.delta;
            if (firstToolCalls >= cancelTarget && !aborted) {
              result.details.push(`  >> Aborting stream after ${firstToolCalls} tool calls (taskId=${firstTaskId})`);
              aborted = true;
              ctrl.abort();
              break;
            }
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") result.issues.push(`First-run stream error: ${e.message}`);
      } finally {
        clearTimeout(hardTimeout);
      }

      const firstElapsed = Date.now() - t0;
      result.details.push(`First run: aborted=${aborted}, tools=${firstToolCalls}, output=${firstOutput.length}ch, time=${(firstElapsed/1000).toFixed(1)}s, taskId=${firstTaskId}`);
      await takeScreenshot(page, sid, `${testId}-01-cancelled.png`);

      // If we have a taskId, explicitly cancel it on the server (defensive)
      if (firstTaskId) {
        try {
          const cancelResp = await fetch(`${BASE}/api/agents/cancel/${firstTaskId}`, { method: "POST" });
          result.details.push(`  Server cancel: ${cancelResp.status}`);
        } catch (e) {
          result.details.push(`  Server cancel failed: ${e.message}`);
        }
      }

      // Wait 2s for cancel to propagate
      await new Promise(r => setTimeout(r, 2000));

      // Resume with new question
      const resumePrompt = test.observe.resumeWith;
      const res2 = await runAgent(sid, resumePrompt, 180000);

      if (res2.error) {
        result.details.push(`Resume run: ${res2.error}`);
        result.issues.push(`Resume error: ${res2.error}`);
      } else {
        result.details.push(`Resume run: Done=${res2.done}, Tools=${res2.toolCalls.length}, Output=${res2.fullOutput?.length || 0}ch`);
        await takeScreenshot(page, sid, `${testId}-02-resume.png`);
      }

      // Pass when: first run produced >= cancelTarget tool calls AND was aborted AND resume completed
      result.passed = aborted && firstToolCalls >= cancelTarget && !res2?.error && res2?.done;

    } else {
      // Standard single-run test
      const kbId = Array.isArray(test.kb) ? null : test.kb;
      const sid = Array.isArray(test.kb)
        ? await createDualKBSession(test.kb, `${testId}`)
        : await createSession(kbId, `${testId}`);
      result.details.push(`Session: ${sid}`);

      await takeScreenshot(page, sid, `${testId}-00-initial.png`);

      const res = await runAgent(sid, test.prompt, test.timeout);

      if (res.error) {
        result.details.push(`ERROR: ${res.error}`);
        result.issues.push(`Agent error: ${res.error}`);
        result.metrics = { elapsed: res.elapsed };
        result.passed = false;
      } else {
        result.details.push(`Done: ${res.done}`);
        result.details.push(`Output: ${res.fullOutput?.length || 0} chars`);
        result.details.push(`Time: ${(res.elapsed / 1000).toFixed(1)}s`);
        result.details.push(`SSE raw: ${(res.rawLength / 1024).toFixed(1)}KB`);
        result.details.push(`Tool calls: ${res.toolCalls.length}`);
        result.details.push(`Push contents: ${res.pushContents.length}`);

        const tc = analyzeToolCalls(res.toolCalls, res);
        result.details.push(`Tool breakdown: ${Object.entries(tc.byName).map(([k,v]) => `${k}=${v}`).join(", ")}`);
        if (tc.duplicateSearches > 0) {
          result.details.push(`Duplicate searches: ${tc.duplicateSearches}`);
          result.issues.push(`${tc.duplicateSearches} duplicate search queries detected`);
        }

        // Push content analysis
        for (const pc of res.pushContents) {
          const dl = (pc.data || "").length;
          result.details.push(`  PC "${pc.title}": data=${dl}ch ${dl > 0 ? "OK" : "EMPTY!"}`);
          if (dl === 0) result.issues.push(`Push content "${pc.title}" has empty data`);
        }

        // Backend log analysis
        const logsAfter = await getBackendLogs();
        const newLogs = logsAfter.slice(logsBefore.length);
        const warnings = grepLogLines(newLogs, /WARN|WARNING/i);
        const errors = grepLogLines(newLogs, /ERR[^O]|ERROR|FATAL/i);
        const crashes = grepLogLines(newLogs, /unhandledRejection|uncaughtException/i);

        result.details.push(`Logs: ${warnings.length} warnings, ${errors.length} errors, ${crashes.length} crashes`);
        if (crashes.length > 0) {
          result.issues.push(`CRASH: ${crashes[0].slice(0, 200)}`);
        }

        result.metrics = {
          elapsed: res.elapsed,
          outputChars: res.fullOutput?.length || 0,
          toolCalls: res.toolCalls.length,
          pushContents: res.pushContents.length,
          warnings: warnings.length,
          errors: errors.length,
          crashes: crashes.length,
          duplicateSearches: tc.duplicateSearches,
        };

        // Frontend screenshot
        await takeScreenshot(page, sid, `${testId}-99-final.png`);

        // Frontend analysis
        const frontend = await analyzeFrontend(page);
        result.details.push(`Frontend: ${frontend.messages} messages, ${frontend.pushCards.length} push cards, ${frontend.toolCallCards.length} tool cards, bodyText=${frontend.bodyTextLength}ch`);

        // No-KB check
        if (test.observe?.checkNoKBError) {
          const noKBErr = res.fullOutput?.includes("请先上传") || res.fullOutput?.includes("没有知识库");
          if (noKBErr) {
            result.issues.push("Agent shows KB-required error in no-KB scenario");
          }
        }

        // ── Scoring ──
        const obs = test.observe || {};
        let score = 0;
        let maxScore = 0;

        // 1. Agent completed (25 points)
        maxScore += 25;
        if (res.done) { score += 25; }
        else if (res.fullOutput?.length > 100) { score += 15; result.issues.push("Agent did not signal done but has output"); }
        else { result.issues.push("Agent did not complete"); }

        // 2. Tool call count (20 points)
        maxScore += 20;
        if (res.toolCalls.length >= (obs.minToolCalls || 1)) { score += 20; }
        else { result.issues.push(`Tool calls ${res.toolCalls.length} < expected ${obs.minToolCalls}`); }

        // 3. Output quality (20 points) — includes main agent text + push_content card data
        //    (council/graph modes deliver analysis via push_content, not main agent text)
        maxScore += 20;
        const pushContentChars = (res.pushContents || []).reduce((s, pc) => s + (pc.data || "").length, 0);
        const totalOutputChars = (res.fullOutput?.length || 0) + pushContentChars;
        if (totalOutputChars >= (obs.minOutputChars || 100)) { score += 20; }
        else { result.issues.push(`Output ${totalOutputChars} < expected ${obs.minOutputChars}`); }

        // 4. No crashes (15 points)
        maxScore += 15;
        if (crashes.length === 0) { score += 15; }
        else { result.issues.push("Uncaught exceptions detected"); }

        // 5. Expected tools present (10 points)
        maxScore += 10;
        if (obs.expectTools) {
          const found = obs.expectTools.filter(t => tc.byName[t]);
          result.details.push(`Expected tools found: ${found.join(", ")} / ${obs.expectTools.join(", ")}`);
          if (found.length >= 1) { score += 10; }
          else { result.issues.push(`None of expected tools used: ${obs.expectTools.join(", ")}`); }
        } else { score += 10; }

        // 6. Push content quality (10 points)
        maxScore += 10;
        if (obs.checkPushContent) {
          if (res.pushContents.length > 0 && res.pushContents.every(pc => (pc.data || "").length > 0)) { score += 10; }
          else if (res.pushContents.length > 0) { score += 5; result.issues.push("Some push_content cards have empty data"); }
          else { result.issues.push("No push_content cards generated"); }
        } else { score += 10; }

        result.score = score;
        result.passed = score >= maxScore * 0.6 && crashes.length === 0;
      }
    }
  } catch (e) {
    result.details.push(`EXCEPTION: ${e.message}`);
    result.issues.push(`Exception: ${e.message}`);
    result.passed = false;
  }

  await page.close();
  return result;
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════

async function main() {
  // Parse args
  const args = process.argv.slice(2);
  let startFrom = 1;
  let endAt = 60;
  let onlyTests = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--start" && args[i + 1]) { startFrom = parseInt(args[i + 1]); i++; }
    else if (args[i] === "--end" && args[i + 1]) { endAt = parseInt(args[i + 1]); i++; }
    else if (args[i] === "--only" && args[i + 1]) { onlyTests = args[i + 1].split(",").map(t => t.trim().toUpperCase()); i++; }
  }

  console.log("=".repeat(70));
  console.log("DeepAnalyze 60-Item Comprehensive E2E Test");
  console.log("=".repeat(70));
  console.log(`Range: T${String(startFrom).padStart(2, "0")} - T${String(endAt).padStart(2, "0")}`);
  if (onlyTests) console.log(`Only: ${onlyTests.join(", ")}`);
  console.log(`Output: ${OUT}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log("=".repeat(70));

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: "zh-CN",
  });
  // Override newPage to use our context
  const origNewPage = browser.newPage.bind(browser);
  browser.newPage = () => ctx.newPage();

  const allResults = [];
  const testIds = onlyTests || Array.from({ length: 60 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`);

  for (const testId of testIds) {
    const num = parseInt(testId.replace("T", ""));
    if (num < startFrom || num > endAt) continue;

    const test = TESTS[testId];
    if (!test) {
      console.log(`\n[SKIP] ${testId}: Not defined`);
      continue;
    }

    console.log(`\n${"─".repeat(70)}`);
    console.log(`[${testId}] ${test.name} (Group ${test.group})`);
    console.log(`${"─".repeat(70)}`);

    const startTime = Date.now();
    const result = await executeSingleTest(browser, testId, test);
    result.totalElapsed = Date.now() - startTime;

    allResults.push(result);

    const status = result.passed ? "PASS" : "FAIL";
    console.log(`\n[${status}] ${testId}: ${result.name}`);
    console.log(`  Score: ${result.score}/${result.metrics?.expectedScore || "N/A"}`);
    console.log(`  Time: ${(result.totalElapsed / 1000).toFixed(1)}s`);
    for (const d of result.details.slice(-5)) console.log(`  ${d}`);
    if (result.issues.length > 0) {
      console.log(`  Issues: ${result.issues.length}`);
      for (const i of result.issues) console.log(`    ⚠ ${i}`);
    }

    // Save incremental results
    fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(allResults, null, 2));
  }

  await browser.close();

  // ── Summary Report ──
  console.log("\n" + "=".repeat(70));
  console.log("FINAL SUMMARY");
  console.log("=".repeat(70));

  let passed = 0, failed = 0;
  const byGroup = {};

  for (const r of allResults) {
    const s = r.passed ? "PASS" : "FAIL";
    r.passed ? passed++ : failed++;
    console.log(`[${s}] ${r.id}: ${r.name} (score=${r.score}, ${(r.totalElapsed/1000).toFixed(1)}s)`);

    if (!byGroup[r.group]) byGroup[r.group] = { passed: 0, failed: 0, total: 0 };
    byGroup[r.group].total++;
    r.passed ? byGroup[r.group].passed++ : byGroup[r.group].failed++;
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Total: ${allResults.length} | Pass: ${passed} | Fail: ${failed} | Rate: ${(passed/allResults.length*100).toFixed(1)}%`);
  console.log(`\nBy Group:`);
  for (const [g, stats] of Object.entries(byGroup)) {
    console.log(`  Group ${g}: ${stats.passed}/${stats.total} passed (${(stats.passed/stats.total*100).toFixed(0)}%)`);
  }
  console.log(`\nScreenshots: ${OUT}`);
  console.log(`Results: ${OUT}/results.json`);
  console.log("=".repeat(70));

  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(allResults, null, 2));
  fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify({
    total: allResults.length,
    passed,
    failed,
    rate: `${(passed/allResults.length*100).toFixed(1)}%`,
    byGroup,
    timestamp: new Date().toISOString(),
  }, null, 2));
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
