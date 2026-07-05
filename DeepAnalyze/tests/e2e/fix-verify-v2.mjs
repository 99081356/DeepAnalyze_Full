/**
 * Enhanced E2E Fix Verification - V2
 * - Uses fetch API directly for SSE (not ReadableStream)
 * - Captures screenshots AFTER waiting for message rendering
 * - Preserves sessions for manual inspection
 * - More detailed tool call tracking
 */

import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:21000";
const SHOTS = "/tmp/da-fix-verify-v2";
const BIGTEST_KB = "60346710-913d-4b54-b742-499da76cd85b";
const LBCTEST_KB = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

// ── Utility: SSE reader via raw HTTP ──
async function runAgentSSE(sessionId, input, timeoutMs = 300000) {
  const body = JSON.stringify({ sessionId, input });
  const url = `${BASE}/api/agents/run-stream`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
    body,
  });

  if (!resp.ok) return { error: `HTTP ${resp.status}` };

  const text = await resp.text();
  const events = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try { events.push(JSON.parse(line.slice(6))); } catch {}
    }
  }

  const output = events.filter(e => e.type === "text").map(e => e.content || "").join("");
  const toolCalls = events.filter(e => e.type === "tool_call").map(e => ({
    name: e.toolName,
    input: e.toolInput,
  }));
  const pushContents = events.filter(e => e.type === "push_content");
  const done = events.some(e => e.type === "done");

  return { fullOutput: output, toolCalls, pushContents, done, rawEvents: events };
}

async function createSession(kbId, name) {
  const resp = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: name }),
  });
  const session = await resp.json();
  const sid = session.id || session.sessionId;
  if (kbId) {
    await fetch(`${BASE}/api/sessions/${sid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: { kbIds: [kbId] } }),
    });
  }
  return sid;
}

async function takeScreenshot(page, sessionId, filename) {
  // Navigate to session and wait for content to render
  await page.goto(`${BASE}/?session=${sessionId}`, { waitUntil: "networkidle" });

  // Wait for messages to appear (up to 15s)
  try {
    await page.waitForSelector('[data-testid="message-content"], .message-content, .markdown-body, article', { timeout: 15000 });
  } catch {}

  // Extra wait for rendering
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/${filename}`, fullPage: true });
}

function checkLogs(pattern) {
  try {
    const files = fs.readdirSync("/tmp").filter(f => f.startsWith("da_debug") && f.endsWith(".log")).sort();
    if (!files.length) return { found: [], logFile: "none" };
    const content = fs.readFileSync(`/tmp/${files[files.length - 1]}`, "utf-8");
    const lines = content.split("\n").filter(l => pattern.test(l));
    return { found: lines.slice(-20), logFile: files[files.length - 1] };
  } catch (e) {
    return { found: [], error: e.message };
  }
}

// =====================================================
// Tests
// =====================================================

async function testFix1(browser) {
  console.log("\n=== Fix 1: push_content data field ===");
  const r = { name: "Fix 1", passed: false, details: [] };
  const page = await browser.newPage();

  const sid = await createSession(BIGTEST_KB, "Fix1-push-content");
  r.details.push(`Session: ${sid}`);

  await takeScreenshot(page, sid, "fix1-01-created.png");

  // Ask agent to write + push content
  const res = await runAgentSSE(sid,
    `请对知识库做一份简要概述（200字以内），写一个文件保存，然后通过 push_content 推送给我。`, 180000);

  r.details.push(`Done: ${res.done}, Output: ${res.fullOutput?.length}ch`);
  r.details.push(`Tools: ${res.toolCalls.map(t => t.name).join(", ")}`);
  r.details.push(`Push contents: ${res.pushContents.length}`);

  // Analyze push_content results
  for (const pc of res.pushContents) {
    const dataLen = (pc.data || "").length;
    r.details.push(`  PC: title="${pc.title}" data=${dataLen}ch`);
    if (!pc.data || dataLen === 0) {
      r.details.push(`  WARNING: EMPTY DATA`);
    }
  }

  // Check for empty data warnings in logs
  const warnLogs = checkLogs(/push_content.*empty data/i);
  r.details.push(`Empty data warnings in logs: ${warnLogs.found.length}`);

  // Navigate and screenshot
  await takeScreenshot(page, sid, "fix1-02-result.png");

  // Check frontend rendering: look for push content cards
  const pushCards = await page.$$eval(".push-content-card, [class*='push-content'], [class*='PushContent']", els =>
    els.map(el => ({ text: el.textContent?.slice(0, 100), hasContent: (el.textContent?.length || 0) > 10 }))
  ).catch(() => []);

  r.details.push(`Push cards in DOM: ${pushCards.length}`);
  for (const card of pushCards.slice(0, 5)) {
    r.details.push(`  Card: hasContent=${card.hasContent} text="${card.text?.slice(0, 50)}..."`);
  }

  r.passed = res.done && res.pushContents.length > 0 && res.pushContents.every(pc => (pc.data || "").length > 0);

  await page.close();
  return r;
}

async function testFix3(browser) {
  console.log("\n=== Fix 3: doc_grep FTS ===");
  const r = { name: "Fix 3", passed: false, details: [] };
  const page = await browser.newPage();

  const sid = await createSession(BIGTEST_KB, "Fix3-docgrep");
  r.details.push(`Session: ${sid}`);

  await takeScreenshot(page, sid, "fix3-01-created.png");

  const res = await runAgentSSE(sid,
    `请使用 doc_grep 工具搜索知识库中包含「报告」关键词的内容，返回搜索结果数量和前5条匹配。`, 180000);

  r.details.push(`Done: ${res.done}, Output: ${res.fullOutput?.length}ch`);
  r.details.push(`Tools: ${res.toolCalls.map(t => t.name).join(", ")}`);

  const grepCalls = res.toolCalls.filter(t => t.name === "doc_grep");
  r.details.push(`doc_grep calls: ${grepCalls.length}`);

  // Check for FTS errors
  const ftsErrors = checkLogs(/FTS query failed|could not determine data type/i);
  r.details.push(`FTS errors in logs: ${ftsErrors.found.length}`);
  if (ftsErrors.found.length > 0) {
    r.details.push(`  Error: ${ftsErrors.found[0]}`);
  }

  // Check for FTS success
  const ftsSuccess = checkLogs(/doc_grep.*fts|fts.*mode/i);
  r.details.push(`FTS success hints: ${ftsSuccess.found.length}`);

  await takeScreenshot(page, sid, "fix3-02-result.png");

  r.passed = res.done && grepCalls.length > 0 && ftsErrors.found.length === 0;

  await page.close();
  return r;
}

async function testFix4(browser) {
  console.log("\n=== Fix 4: Multimodal guidance ===");
  const r = { name: "Fix 4", passed: false, details: [] };
  const page = await browser.newPage();

  const sid = await createSession(BIGTEST_KB, "Fix4-multimodal");
  r.details.push(`Session: ${sid}`);

  await takeScreenshot(page, sid, "fix4-01-created.png");

  const res = await runAgentSSE(sid,
    `请分析知识库中的图片文件。步骤：
1. 先用 run_sql 查询所有图片类型文档（file_type包含png/jpg/jpeg）
2. 对前5张图片用 expand 获取 L1 内容，检查 VLM 描述是否完整
3. 如果有图片的 VLM 描述不完整，使用 tool_discover 获取 image_analysis 工具重新分析
4. 汇总所有图片内容`, 300000);

  r.details.push(`Done: ${res.done}, Output: ${res.fullOutput?.length}ch`);
  r.details.push(`Tools: ${res.toolCalls.map(t => t.name).join(", ")}`);

  const expandCalls = res.toolCalls.filter(t => t.name === "expand");
  const discoverCalls = res.toolCalls.filter(t => t.name === "tool_discover");
  const imgAnalysisCalls = res.toolCalls.filter(t => t.name === "image_analysis");

  r.details.push(`expand: ${expandCalls.length}, tool_discover: ${discoverCalls.length}, image_analysis: ${imgAnalysisCalls.length}`);

  // Check if tool_discover was used for image_analysis
  const discoverForImg = discoverCalls.filter(t =>
    JSON.stringify(t.input).includes("image_analysis")
  );
  r.details.push(`tool_discover for image_analysis: ${discoverForImg.length}`);

  if (discoverCalls.length > 0) {
    r.details.push(`tool_discover inputs: ${discoverCalls.map(t => JSON.stringify(t.input)).join("; ")}`);
  }

  await takeScreenshot(page, sid, "fix4-02-result.png");

  // Pass if agent used expand first, and either used tool_discover or completed successfully
  // Key: image_analysis should NOT appear without prior tool_discover (unless the agent didn't need it)
  const imgAnalysisWithoutDiscover = imgAnalysisCalls.length > 0 && discoverForImg.length === 0;

  if (imgAnalysisWithoutDiscover) {
    r.details.push(`WARNING: image_analysis used WITHOUT tool_discover — tool may not be properly deferred`);
  }

  r.passed = res.done && expandCalls.length > 0 && !imgAnalysisWithoutDiscover;

  await page.close();
  return r;
}

async function testFix2(browser) {
  console.log("\n=== Fix 2: Compaction fallback ===");
  const r = { name: "Fix 2", passed: false, details: [] };
  const page = await browser.newPage();

  const sid = await createSession(BIGTEST_KB, "Fix2-compaction");
  r.details.push(`Session: ${sid}`);

  await takeScreenshot(page, sid, "fix2-01-created.png");

  // Heavy query to trigger compaction
  const res = await runAgentSSE(sid,
    `请全面分析这个知识库。逐步完成：
1. 列出所有文档及其类型（用run_sql查询）
2. 对每个文档用expand获取L1摘要
3. 对所有文档内容进行分类整理
4. 找出文档间的关联
5. 生成完整的分析报告
确保每一步都输出详细内容。`, 300000);

  r.details.push(`Done: ${res.done}, Output: ${res.fullOutput?.length}ch`);
  r.details.push(`Tool calls: ${res.toolCalls.length}`);
  r.details.push(`Push contents: ${res.pushContents.length}`);

  // Check for compaction fallback in logs
  const fallbackLogs = checkLogs(/truncation fallback/i);
  const failureLogs = checkLogs(/generateMiddleSummary failed/i);
  r.details.push(`Truncation fallback used: ${fallbackLogs.found.length}`);
  r.details.push(`Compaction failures: ${failureLogs.found.length}`);

  // Check for any uncaught errors
  const crashLogs = checkLogs(/unhandledRejection|Uncaught exception|FATAL/i);
  r.details.push(`Uncaught errors: ${crashLogs.found.length}`);

  await takeScreenshot(page, sid, "fix2-02-result.png");

  // Pass if agent completed without crash
  r.passed = res.done && crashLogs.found.length === 0;

  await page.close();
  return r;
}

async function testFix5(browser) {
  console.log("\n=== Fix 5: Identifier preservation ===");
  const r = { name: "Fix 5", passed: false, details: [] };

  // Source code verification
  const compactionSrc = fs.readFileSync(
    "/mnt/d/code/deepanalyze/deepanalyze/src/services/agent/compaction.ts", "utf-8"
  );
  const match = compactionSrc.match(/MAX_PRESERVED_IDENTIFIERS\s*=\s*(\d+)/);
  const limit = match ? parseInt(match[1]) : 0;
  r.details.push(`MAX_PRESERVED_IDENTIFIERS = ${limit}`);

  const runnerSrc = fs.readFileSync(
    "/mnt/d/code/deepanalyze/deepanalyze/src/services/agent/agent-runner.ts", "utf-8"
  );
  const slices = [...runnerSrc.matchAll(/slice\(0,\s*(\d+)\)/g)];
  const idSlices = slices.filter(m => m[1] === "300" || m[1] === "150");
  r.details.push(`Identifier slices: ${idSlices.map(m => m[1]).join(", ")}`);

  // Functional test
  const page = await browser.newPage();
  const sid = await createSession(BIGTEST_KB, "Fix5-identifiers");

  await takeScreenshot(page, sid, "fix5-01-created.png");

  const res = await runAgentSSE(sid,
    `请展开知识库中的前30个文档，获取每个文档的L1内容，然后整理出完整的文档清单，包含每个文档的ID、标题和摘要。`, 300000);

  r.details.push(`Done: ${res.done}, Output: ${res.fullOutput?.length}ch`);
  r.details.push(`Tool calls: ${res.toolCalls.length}`);

  // Count unique identifiers in output
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const idsInOutput = (res.fullOutput.match(uuidPattern) || []).length;
  r.details.push(`UUIDs in output: ${idsInOutput}`);

  await takeScreenshot(page, sid, "fix5-02-result.png");

  r.passed = limit === 300 && idSlices.some(m => m[1] === "300") && res.done;

  await page.close();
  return r;
}

// =====================================================
// Main
// =====================================================

async function main() {
  console.log("Enhanced E2E Fix Verification V2\n");

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: "zh-CN",
  });

  // Replace browser.newPage to use our context
  const origNewPage = browser.newPage.bind(browser);
  browser.newPage = () => ctx.newPage();

  // Home screenshot
  const homePage = await ctx.newPage();
  await homePage.goto(BASE, { waitUntil: "networkidle" });
  await homePage.screenshot({ path: `${SHOTS}/00-home.png`, fullPage: true });
  await homePage.close();

  const results = [];

  // Run tests sequentially
  for (const [name, fn] of [
    ["Fix 1", testFix1],
    ["Fix 3", testFix3],
    ["Fix 4", testFix4],
    ["Fix 2", testFix2],
    ["Fix 5", testFix5],
  ]) {
    try {
      results.push(await fn(browser));
    } catch (e) {
      results.push({ name, passed: false, details: [`Exception: ${e.message}\n${e.stack?.slice(0, 300)}`] });
    }
  }

  await browser.close();

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("TEST RESULTS SUMMARY");
  console.log("=".repeat(60));

  let passed = 0, failed = 0;
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    console.log(`\n[${status}] ${r.name}`);
    for (const d of r.details) console.log(`  ${d}`);
    r.passed ? passed++ : failed++;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Screenshots: ${SHOTS}`);
  console.log("=".repeat(60));

  fs.writeFileSync(`${SHOTS}/results.json`, JSON.stringify(results, null, 2));
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
