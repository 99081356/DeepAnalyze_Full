/**
 * DeepAnalyze 80-Test Sequential Runner
 *
 * Runs each test case end-to-end using Playwright browser automation.
 * Captures screenshots, monitors backend logs, validates content quality.
 *
 * Usage: node tests/e2e/run-test-80.mjs <testId>
 * Example: node tests/e2e/run-test-80.mjs T01
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, appendFileSync, existsSync } from "fs";
import { join } from "path";

const BASE = "http://localhost:21000";
const BIGTEST_ID = "60346710-913d-4b54-b742-499da76cd85b";
const LBCTEST_ID = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";
const SCREENSHOT_DIR = "/tmp/test80-screenshots";
const RESULT_FILE = "/tmp/test80-results.md";

mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  appendFileSync(`/tmp/test80-runner.log`, line + "\n");
}

function result(testId, status, details) {
  const entry = `### ${testId}: ${status}\n${details}\n`;
  appendFileSync(RESULT_FILE, entry);
  log(`${testId} => ${status}`);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${BASE}${path}`, opts);
  const text = await resp.text();
  try {
    return { status: resp.status, data: JSON.parse(text) };
  } catch {
    return { status: resp.status, data: text };
  }
}

async function createSession(title, kbScope) {
  const { status, data } = await api("POST", "/api/sessions", { title, kbScope });
  if (status !== 200 && status !== 201) throw new Error(`createSession failed: ${status}`);
  return data;
}

async function getSessionMessages(sessionId) {
  const { status, data } = await api("GET", `/api/sessions/${sessionId}/messages`);
  if (status !== 200) throw new Error(`getMessages failed: ${status}`);
  return Array.isArray(data) ? data : (data.messages || []);
}

async function getTaskStatus(sessionId) {
  const { status, data } = await api("GET", `/api/agents/tasks/${sessionId}`);
  if (status !== 200) return null;
  return Array.isArray(data) ? data[data.length - 1] : data;
}

// ---------------------------------------------------------------------------
// Browser automation
// ---------------------------------------------------------------------------
async function launchBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: "zh-CN",
  });
  const page = await context.newPage();

  // Capture console errors
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(`[${new Date().toISOString()}] ${msg.text()}`);
    }
  });

  // Capture page errors
  page.on("pageerror", (err) => {
    consoleErrors.push(`[PAGE_ERROR] ${err.message}`);
  });

  return { browser, context, page, consoleErrors };
}

async function screenshot(page, testId, name) {
  const path = join(SCREENSHOT_DIR, `${testId}-${name}.png`);
  await page.screenshot({ path, fullPage: false });
  log(`Screenshot saved: ${path}`);
  return path;
}

// ---------------------------------------------------------------------------
// SSE monitoring (consume agent run-stream via EventSource)
// ---------------------------------------------------------------------------
async function runAgentAndWait(page, sessionId, prompt, testId, timeoutMs = 600000) {
  log(`${testId}: Starting agent run, timeout=${timeoutMs / 1000}s`);

  // Navigate to session page
  await page.goto(`${BASE}/#/sessions/${sessionId}`, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);

  // Take initial screenshot
  await screenshot(page, testId, "01-initial");

  // Type the prompt and send
  const textarea = page.locator("textarea").first();
  if (await textarea.isVisible({ timeout: 5000 })) {
    await textarea.fill(prompt);
    await page.waitForTimeout(500);
    await screenshot(page, testId, "02-prompt-entered");

    // Find and click send button
    const sendBtn = page.locator('button[type="submit"], button:has-text("发送"), button[class*="send"]').last();
    if (await sendBtn.isVisible({ timeout: 3000 })) {
      await sendBtn.click();
    } else {
      // Try pressing Enter
      await textarea.press("Enter");
    }
  } else {
    // Fallback: use API to trigger the run
    log(`${testId}: Textarea not found, using API to trigger agent run`);
    await api("POST", "/api/agents/run", { input: prompt, sessionId });
  }

  await page.waitForTimeout(3000);
  await screenshot(page, testId, "03-agent-started");

  // Poll for task completion
  const startTime = Date.now();
  let lastScreenshotTime = Date.now();
  let lastToolCallCount = 0;
  let pollCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    pollCount++;
    await new Promise((r) => setTimeout(r, 5000));

    // Check task status
    const task = await getTaskStatus(sessionId);
    if (task) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log(`${testId}: poll #${pollCount}, elapsed=${elapsed}s, status=${task.status}`);

      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        await screenshot(page, testId, "04-completed");
        return task;
      }
    }

    // Take periodic screenshots (every 60s)
    if (Date.now() - lastScreenshotTime > 60000) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      await screenshot(page, testId, `running-${elapsed}s`);
      lastScreenshotTime = Date.now();
    }
  }

  // Timeout
  await screenshot(page, testId, "TIMEOUT");
  log(`${testId}: TIMEOUT after ${timeoutMs / 1000}s`);
  return { status: "timeout" };
}

// ---------------------------------------------------------------------------
// Content quality validators
// ---------------------------------------------------------------------------
function countChineseChars(text) {
  if (!text) return 0;
  const matches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  return matches ? matches.length : 0;
}

function extractToolCalls(messages) {
  let calls = [];
  for (const msg of messages) {
    if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
      calls = calls.concat(msg.toolCalls);
    }
    if (msg.metadata?.toolCalls) {
      calls = calls.concat(msg.metadata.toolCalls);
    }
  }
  return calls;
}

function extractPushedContents(messages) {
  let contents = [];
  for (const msg of messages) {
    if (msg.pushedContents && Array.isArray(msg.pushedContents)) {
      contents = contents.concat(msg.pushedContents);
    }
    if (msg.metadata?.pushedContents) {
      contents = contents.concat(msg.metadata.pushedContents);
    }
  }
  return contents;
}

function getAssistantText(messages) {
  return messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content || "")
    .join("\n");
}

/** Get total text including pushed content data — this is the REAL output metric. */
function getTotalOutputText(messages) {
  const assistantText = getAssistantText(messages);
  const pushed = extractPushedContents(messages);
  const pushedText = pushed
    .map((p) => (p.data || "") + " " + (p.title || ""))
    .join("\n");
  return assistantText + "\n" + pushedText;
}

/** Check for duplicate content in pushedContents (by MD5-like content comparison). */
function checkDuplicatePushes(messages) {
  const pushed = extractPushedContents(messages);
  const seen = new Map();
  const duplicates = [];
  for (const p of pushed) {
    const data = (p.data || "").trim();
    if (data.length < 100) continue; // Skip short content
    // Use first 200 chars as fingerprint
    const fingerprint = data.substring(0, 200);
    if (seen.has(fingerprint)) {
      duplicates.push({
        title1: seen.get(fingerprint).title,
        title2: p.title,
        dataLength: data.length,
      });
    } else {
      seen.set(fingerprint, p);
    }
  }
  return duplicates;
}

// ---------------------------------------------------------------------------
// Backend log checker
// ---------------------------------------------------------------------------
async function checkBackendLog(testId, startTime) {
  const logFile = "/tmp/da_debug_test80.log";
  if (!existsSync(logFile)) return { errors: [], warnings: [] };

  const { readFileSync } = await import("fs");
  const content = readFileSync(logFile, "utf-8");
  const lines = content.split("\n");

  const errors = [];
  const warnings = [];
  const startTs = startTime.toISOString().slice(11, 19);

  for (const line of lines) {
    if (!line) continue;
    const ts = line.slice(11, 19);
    if (ts < startTs) continue;

    if (/\bERROR\b/i.test(line) && !/favicon|ResizeObserver|ECONNRESET.*retry|Token budget state|budget.*(normal|error)|AuthProfiles.*transient|Cooldown.*error #|Consecutive error intervention/i.test(line)) {
      errors.push(line.slice(0, 200));
    }
    if (/WARNING|WARN\b/i.test(line)) {
      warnings.push(line.slice(0, 200));
    }
  }

  return { errors: errors.slice(0, 20), warnings: warnings.slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Test case definitions
// ---------------------------------------------------------------------------
const TESTS = {
  T01: {
    name: "bigtest全库综合深度分析",
    kbScope: { kbIds: [BIGTEST_ID] },
    prompt: `现在请你分析知识库文档的全部内容，分析清楚所有内容的主要分类关系、从属关系，分析清楚每一类、每一块知识的相关性。针对论文，请给出一份详细的分析报告分析这些论文的技术演进关系，分析不同技术的优劣势，预测未来核心的研究方向和建议，给出详细的分析报告。如果是剧本杀，请分析整个剧本的关系，找出明确的杀手和时间线推理关系，找出所有证据链条和推理逻辑链条，每个剧本杀单独给出详细的完整故事脉络和逻辑关系推理。如果是表格，详细统计分析表格内容和数据情况。其他类型也自定义不同需求，对整个知识库进行全面深入完整的分析与整理。`,
    timeout: 1800000, // 30 min
    validate: (messages, task) => {
      const totalText = getTotalOutputText(messages);
      const charCount = countChineseChars(totalText);
      const pushed = extractPushedContents(messages);
      const toolCalls = extractToolCalls(messages);
      const duplicates = checkDuplicatePushes(messages);
      const details = [
        `- 状态: ${task.status}`,
        `- 总中文字数(含push_content): ${charCount}`,
        `- push_content卡片: ${pushed.length}个`,
        `- 工具调用: ${toolCalls.length}次`,
        `- 重复内容: ${duplicates.length}个 (${duplicates.length === 0 ? "✅ PASS" : "❌ FAIL"})`,
        `- 字数参考: ≥50000 (${charCount >= 50000 ? "✅" : "⚠️ 信息项"})`,
      ];
      const passed = task.status === "completed" && duplicates.length === 0;
      return { passed, details: details.join("\n") };
    },
  },
  T02: {
    name: "lbctest全案司法分析",
    kbScope: { kbIds: [LBCTEST_ID] },
    prompt: `1. 详细分析整个案件，按人、时、地、事、物的关键信息梳理，整理完整的案件介绍。2. 还原整个案件完整的时间线关系，给出所有案件推理和证据证明材料。3. 梳理资金关系和流向，明确分析资金转移情况，核对受害人的资金损失情况。4. 给出量刑标准和法规指引，并对每个量刑项目给出全部证据关联材料信息。5. 使用司法证据链标准的skill，输出符合司法证据链要求的文档报告。`,
    timeout: 1800000,
    validate: (messages, task) => {
      const totalText = getTotalOutputText(messages);
      const charCount = countChineseChars(totalText);
      const pushed = extractPushedContents(messages);
      const toolCalls = extractToolCalls(messages);
      const duplicates = checkDuplicatePushes(messages);
      const hasEvidenceLink = totalText.includes("da-evidence://") || totalText.includes("证据链");
      const details = [
        `- 状态: ${task.status}`,
        `- 总中文字数(含push_content): ${charCount}`,
        `- push_content卡片: ${pushed.length}个`,
        `- 工具调用: ${toolCalls.length}次`,
        `- 重复内容: ${duplicates.length}个`,
        `- 证据链提及: ${hasEvidenceLink ? "✅" : "❌"}`,
      ];
      const passed = task.status === "completed" && duplicates.length === 0;
      return { passed, details: details.join("\n") };
    },
  },
  // ── Common validator for T03-T10 ──
  T03: {
    name: "超长单文档深度分析(5241自杀派对)",
    kbScope: { kbIds: [BIGTEST_ID] },
    prompt: `请选择知识库中的"5241 自杀派对"剧本杀，对每个角色的剧本、线索、结局进行逐字逐句的深度分析。要求：1. 列出所有角色的完整信息（姓名、身份、动机、行为时间线）2. 逐条分析每条线索的含义、指向、与其他线索的关联 3. 构建完整的推理链：从初始线索到最终结论的每一步推理过程 4. 对每个可能的假设进行验证或排除 5. 输出完整的故事还原，包括每个角色的视角。目标输出详细的完整分析报告。`,
    timeout: 1800000,
    validate: (messages, task) => {
      const totalText = getTotalOutputText(messages);
      const charCount = countChineseChars(totalText);
      const pushed = extractPushedContents(messages);
      const toolCalls = extractToolCalls(messages);
      const duplicates = checkDuplicatePushes(messages);
      const details = [
        `- 状态: ${task.status}`,
        `- 总中文字数(含push_content): ${charCount}`,
        `- push_content卡片: ${pushed.length}个`,
        `- 工具调用: ${toolCalls.length}次`,
        `- 重复内容: ${duplicates.length}个 (${duplicates.length === 0 ? "✅ PASS" : "❌ FAIL"})`,
      ];
      const passed = task.status === "completed" && duplicates.length === 0;
      return { passed, details: details.join("\n") };
    },
  },
  T04: {
    name: "多知识库交叉分析(bigtest+lbctest)",
    kbScope: { kbIds: [BIGTEST_ID, LBCTEST_ID] },
    prompt: `请同时分析bigtest和lbctest两个知识库。对比两个知识库的文档类型分布、内容主题差异。bigtest中如果有法律相关的剧本杀内容（如"681追凶手记"），请与lbctest中的真实诉讼文书进行对比，分析虚构案件与真实案件在证据链结构、逻辑推理方式上的异同。`,
    timeout: 1800000,
    validate: (messages, task) => {
      const totalText = getTotalOutputText(messages);
      const charCount = countChineseChars(totalText);
      const pushed = extractPushedContents(messages);
      const toolCalls = extractToolCalls(messages);
      const duplicates = checkDuplicatePushes(messages);
      const hasComparison = totalText.includes("对比") || totalText.includes("异同") || totalText.includes("差异");
      const details = [
        `- 状态: ${task.status}`,
        `- 总中文字数(含push_content): ${charCount}`,
        `- push_content卡片: ${pushed.length}个`,
        `- 工具调用: ${toolCalls.length}次`,
        `- 重复内容: ${duplicates.length}个 (${duplicates.length === 0 ? "✅ PASS" : "❌ FAIL"})`,
        `- 对比分析: ${hasComparison ? "✅" : "⚠️"}`,
      ];
      const passed = task.status === "completed" && duplicates.length === 0;
      return { passed, details: details.join("\n") };
    },
  },
  T05: {
    name: "学术论文技术演进深度分析",
    kbScope: { kbIds: [BIGTEST_ID] },
    prompt: `请分析知识库中所有学术论文。要求：1. 每篇论文的核心贡献（用不超过200字概括）2. 论文之间的引用关系和技术演进路径 3. 每篇论文的方法论对比（包括优势、局限、适用场景）4. 未来研究方向的预测和建议 5. 技术成熟度评估。输出结构化的分析报告，每个分析维度独立成章。`,
    timeout: 1800000,
    validate: (messages, task) => {
      const totalText = getTotalOutputText(messages);
      const charCount = countChineseChars(totalText);
      const pushed = extractPushedContents(messages);
      const toolCalls = extractToolCalls(messages);
      const duplicates = checkDuplicatePushes(messages);
      const details = [
        `- 状态: ${task.status}`,
        `- 总中文字数(含push_content): ${charCount}`,
        `- push_content卡片: ${pushed.length}个`,
        `- 工具调用: ${toolCalls.length}次`,
        `- 重复内容: ${duplicates.length}个 (${duplicates.length === 0 ? "✅ PASS" : "❌ FAIL"})`,
      ];
      const passed = task.status === "completed" && duplicates.length === 0;
      return { passed, details: details.join("\n") };
    },
  },
  T06: {
    name: "反幻觉数字敏感性测试",
    kbScope: { kbIds: [BIGTEST_ID, LBCTEST_ID] },
    prompt: `请从两个知识库中找出所有涉及金额、数量、日期、百分比等数字的内容，整理成结构化表格。每个数字必须标注：来源文档名、原文段落、上下文含义。不允许出现任何原文中不存在的数字。`,
    timeout: 1800000,
    validate: (messages, task) => {
      const totalText = getTotalOutputText(messages);
      const charCount = countChineseChars(totalText);
      const pushed = extractPushedContents(messages);
      const toolCalls = extractToolCalls(messages);
      const duplicates = checkDuplicatePushes(messages);
      const hasTable = totalText.includes("|") && totalText.includes("---");
      const details = [
        `- 状态: ${task.status}`,
        `- 总中文字数(含push_content): ${charCount}`,
        `- push_content卡片: ${pushed.length}个`,
        `- 工具调用: ${toolCalls.length}次`,
        `- 重复内容: ${duplicates.length}个 (${duplicates.length === 0 ? "✅ PASS" : "❌ FAIL"})`,
        `- 结构化表格: ${hasTable ? "✅" : "⚠️"}`,
      ];
      const passed = task.status === "completed" && duplicates.length === 0;
      return { passed, details: details.join("\n") };
    },
  },
  T07: {
    name: "表格数据深度分析(Excel)",
    kbScope: { kbIds: [BIGTEST_ID] },
    prompt: `详细分析知识库中的Excel表格数据。要求：1. 表格整体描述（行数、列数、列名含义、数据类型）2. 按列统计分析（数值列：均值/中位数/最大值/最小值/缺失率；分类列：唯一值数/分布）3. 关键发现（异常值、趋势、相关性）4. 数据质量评估（缺失值、重复行、异常值比例）5. 可视化建议。所有统计数字必须通过run_sql或bash(python3)实际计算得出，不允许估算。`,
    timeout: 1800000,
    validate: (messages, task) => {
      const totalText = getTotalOutputText(messages);
      const charCount = countChineseChars(totalText);
      const pushed = extractPushedContents(messages);
      const toolCalls = extractToolCalls(messages);
      const duplicates = checkDuplicatePushes(messages);
      const hasSqlOrBash = toolCalls.some(tc => {
        const name = tc.toolName || tc.tool_name || "";
        return name === "run_sql" || name === "bash";
      });
      const details = [
        `- 状态: ${task.status}`,
        `- 总中文字数(含push_content): ${charCount}`,
        `- push_content卡片: ${pushed.length}个`,
        `- 工具调用: ${toolCalls.length}次`,
        `- 重复内容: ${duplicates.length}个 (${duplicates.length === 0 ? "✅ PASS" : "❌ FAIL"})`,
        `- SQL/Bash计算: ${hasSqlOrBash ? "✅" : "⚠️"}`,
      ];
      const passed = task.status === "completed" && duplicates.length === 0;
      return { passed, details: details.join("\n") };
    },
  },
  T08: {
    name: "多模态内容分析(图片+音频+视频+SVG)",
    kbScope: { kbIds: [BIGTEST_ID] },
    prompt: `请分析知识库中所有图片、音频、视频和SVG文件。要求：1. 图片：描述每张图片的内容 2. 音频：转写所有音频内容 3. 视频：描述视频内容 4. SVG：分析SVG中的文本内容 5. 多模态关联：分析不同媒体文件之间是否存在关联 6. 所有描述必须基于实际处理结果，不得凭空描述。`,
    timeout: 1800000,
    validate: (messages, task) => {
      const totalText = getTotalOutputText(messages);
      const charCount = countChineseChars(totalText);
      const pushed = extractPushedContents(messages);
      const toolCalls = extractToolCalls(messages);
      const duplicates = checkDuplicatePushes(messages);
      const details = [
        `- 状态: ${task.status}`,
        `- 总中文字数(含push_content): ${charCount}`,
        `- push_content卡片: ${pushed.length}个`,
        `- 工具调用: ${toolCalls.length}次`,
        `- 重复内容: ${duplicates.length}个 (${duplicates.length === 0 ? "✅ PASS" : "❌ FAIL"})`,
      ];
      const passed = task.status === "completed" && duplicates.length === 0;
      return { passed, details: details.join("\n") };
    },
  },
  T09: {
    name: "网络搜索+通用Agent能力(无KB)",
    kbScope: { kbIds: [] },
    prompt: `给我写一个最新的AI发展综述的详细技术报告，包括所有技术模块，演进方向，主要问题，处理方法等等详细信息，基于最新的deepseek，Qwen，kimi，minimax等国内模型的技术报告和论文。完成后再基于详细技术报告写一个完善的PPT大纲。`,
    timeout: 1800000,
    validate: (messages, task) => {
      const totalText = getTotalOutputText(messages);
      const charCount = countChineseChars(totalText);
      const pushed = extractPushedContents(messages);
      const toolCalls = extractToolCalls(messages);
      const duplicates = checkDuplicatePushes(messages);
      const hasWebSearch = toolCalls.some(tc => {
        const name = tc.toolName || tc.tool_name || "";
        return name === "web_search" || name === "web_reader";
      });
      const hasPptOutline = totalText.includes("PPT") || totalText.includes("幻灯片") || totalText.includes("大纲");
      const details = [
        `- 状态: ${task.status}`,
        `- 总中文字数(含push_content): ${charCount}`,
        `- push_content卡片: ${pushed.length}个`,
        `- 工具调用: ${toolCalls.length}次`,
        `- 重复内容: ${duplicates.length}个 (${duplicates.length === 0 ? "✅ PASS" : "❌ FAIL"})`,
        `- 网络搜索: ${hasWebSearch ? "✅" : "⚠️"}`,
        `- PPT大纲: ${hasPptOutline ? "✅" : "⚠️"}`,
      ];
      const passed = task.status === "completed" && duplicates.length === 0;
      return { passed, details: details.join("\n") };
    },
  },
  T10: {
    name: "一致性验证(同问题3次执行)",
    kbScope: { kbIds: [LBCTEST_ID] },
    prompt: `请列出这个案件中所有涉及的资金转移记录，包括金额、日期、转出方、接收方。按时间顺序排列。`,
    timeout: 1800000,
    repeatCount: 3,
    validate: (messages, task) => {
      const totalText = getTotalOutputText(messages);
      const charCount = countChineseChars(totalText);
      const pushed = extractPushedContents(messages);
      const toolCalls = extractToolCalls(messages);
      const duplicates = checkDuplicatePushes(messages);
      const details = [
        `- 状态: ${task.status}`,
        `- 总中文字数(含push_content): ${charCount}`,
        `- push_content卡片: ${pushed.length}个`,
        `- 工具调用: ${toolCalls.length}次`,
        `- 重复内容: ${duplicates.length}个 (${duplicates.length === 0 ? "✅ PASS" : "❌ FAIL"})`,
        `- 注: 第${messages.length > 0 ? "1" : "?"}次执行结果(共3次)`,
      ];
      const passed = task.status === "completed" && duplicates.length === 0;
      return { passed, details: details.join("\n") };
    },
  },
};

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------
async function runTest(testId) {
  const testDef = TESTS[testId];
  if (!testDef) {
    console.error(`Unknown test: ${testId}`);
    console.log(`Available tests: ${Object.keys(TESTS).join(", ")}`);
    process.exit(1);
  }

  log(`========== START ${testId}: ${testDef.name} ==========`);
  const startTime = new Date();

  const { browser, context, page, consoleErrors } = await launchBrowser();

  try {
    // Create session
    const session = await createSession(`${testId}: ${testDef.name}`, testDef.kbScope);
    const sessionId = session.id;
    log(`${testId}: Session created: ${sessionId}`);

    // Run agent and wait
    const task = await runAgentAndWait(page, sessionId, testDef.prompt, testId, testDef.timeout);

    // Get final messages
    const messages = await getSessionMessages(sessionId);
    log(`${testId}: Retrieved ${messages.length} messages`);

    // Take final screenshot
    await screenshot(page, testId, "05-final");

    // Validate
    const validation = testDef.validate(messages, task);

    // Check backend logs
    const logCheck = await checkBackendLog(testId, startTime);

    // Compile results
    const allDetails = [
      validation.details,
      ``,
      `**前端控制台错误**: ${consoleErrors.length}个`,
      consoleErrors.slice(0, 5).map((e) => `  - ${e.slice(0, 150)}`).join("\n"),
      ``,
      `**后端错误日志**: ${logCheck.errors.length}条`,
      logCheck.errors.slice(0, 5).map((e) => `  - ${e}`).join("\n"),
      ``,
      `**后端警告日志**: ${logCheck.warnings.length}条`,
    ].join("\n");

    const overallPass = validation.passed && consoleErrors.length === 0 && logCheck.errors.length === 0;
    result(testId, overallPass ? "✅ PASS" : "❌ FAIL", allDetails);

    // Cleanup session (only on pass; keep failed sessions for debugging)
    if (overallPass) {
      await api("DELETE", `/api/sessions/${sessionId}`);
    } else {
      log(`${testId}: Session preserved for debugging: ${sessionId}`);
    }

    log(`========== END ${testId}: ${overallPass ? "PASS" : "FAIL"} ==========`);
    return overallPass;
  } catch (err) {
    log(`${testId}: EXCEPTION: ${err.message}`);
    await screenshot(page, testId, "EXCEPTION");
    result(testId, "❌ ERROR", `Exception: ${err.message}\n${err.stack}`);
    return false;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
const testId = process.argv[2];
if (!testId) {
  console.log("Usage: node tests/e2e/run-test-80.mjs <testId>");
  console.log(`Available: ${Object.keys(TESTS).join(", ")}`);
  process.exit(1);
}

// Initialize result file
if (!existsSync(RESULT_FILE)) {
  writeFileSync(RESULT_FILE, `# 80-Test Execution Results\n\nStarted: ${new Date().toISOString()}\n\n`);
}

runTest(testId).then((pass) => {
  process.exit(pass ? 0 : 1);
});
