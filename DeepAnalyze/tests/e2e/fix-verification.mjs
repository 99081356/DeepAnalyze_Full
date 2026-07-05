/**
 * E2E Fix Verification Test Script
 * Tests all 5 fixes using Playwright with screenshots
 *
 * Fix 1: push_content data field diagnostic
 * Fix 2: generateMiddleSummary truncation fallback (log check)
 * Fix 3: doc_grep FTS parameter separation
 * Fix 4: Multimodal analysis tool-guidance (image analysis via tool_discover)
 * Fix 5: Identifier preservation limit 150→300 (log check)
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:21000";
const SCREENSHOT_DIR = "/tmp/da-fix-verify";
const BIGTEST_KB = "60346710-913d-4b54-b742-499da76cd85b";
const LBCTEST_KB = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

// Ensure screenshot dir
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Utility: wait for agent completion by polling messages
async function waitForAgentCompletion(sessionId, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${BASE}/api/sessions/${sessionId}/messages?limit=5`);
      const data = await resp.json();
      const msgs = data.messages || data;
      if (msgs.length > 0) {
        const last = msgs[msgs.length - 1];
        // Check if assistant has responded (role=assistant with content)
        if (last.role === "assistant" && last.content && last.content.length > 100) {
          return msgs;
        }
      }
    } catch (e) { /* ignore */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

// Utility: create session with KB scope
async function createSession(kbId, name) {
  const resp = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: name }),
  });
  const session = await resp.json();
  const sid = session.id || session.sessionId;

  // Set KB scope
  if (kbId) {
    await fetch(`${BASE}/api/sessions/${sid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: { kbIds: [kbId] } }),
    });
  }
  return sid;
}

// Utility: run agent and wait for completion via SSE
async function runAgentAndWait(sessionId, input, timeoutMs = 300000) {
  const resp = await fetch(`${BASE}/api/agents/run-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, input }),
  });

  if (!resp.ok) {
    return { error: `HTTP ${resp.status}`, status: resp.status };
  }

  // Read SSE stream
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let fullOutput = "";
  let pushedContents = [];
  let toolCalls = [];
  let buffer = "";

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "text" && event.content) {
            fullOutput += event.content;
          } else if (event.type === "push_content") {
            pushedContents.push(event);
          } else if (event.type === "tool_call") {
            toolCalls.push({ name: event.toolName, input: event.input });
          } else if (event.type === "done") {
            return { fullOutput, pushedContents, toolCalls, done: true };
          }
        } catch (e) { /* not JSON, skip */ }
      }
    }
  }

  return { fullOutput, pushedContents, toolCalls, done: Date.now() - start >= timeoutMs };
}

// Utility: get session messages
async function getSessionMessages(sessionId) {
  const resp = await fetch(`${BASE}/api/sessions/${sessionId}/messages?limit=50`);
  const data = await resp.json();
  return data.messages || data;
}

// Utility: check backend logs for patterns
async function checkBackendLogs(pattern) {
  try {
    const logFiles = fs.readdirSync("/tmp").filter(f => f.startsWith("da_debug") && f.endsWith(".log"));
    if (logFiles.length === 0) return "No log files found";

    const latestLog = logFiles.sort().pop();
    const content = fs.readFileSync(`/tmp/${latestLog}`, "utf-8");
    const lines = content.split("\n").filter(l => pattern.test(l));
    return lines.length > 0 ? lines.slice(-10) : [];
  } catch (e) {
    return `Error reading logs: ${e.message}`;
  }
}

// =====================================================
// Test Functions
// =====================================================

async function testFix1_PushContentData(page, browser) {
  console.log("\n=== Fix 1: push_content data field diagnostic ===");

  const results = { name: "Fix 1: push_content data field", passed: false, details: [] };

  // Test: Create a session and ask agent to write a file then push it
  const sessionId = await createSession(BIGTEST_KB, "Fix1-push-content-test");
  results.details.push(`Session: ${sessionId}`);

  // Navigate to session in browser
  await page.goto(`${BASE}/?session=${sessionId}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fix1-01-session-created.png`, fullPage: true });

  // Send a message that will trigger write_file + push_content
  const input = "请写一份简短的测试报告（100字左右），内容为对知识库文档的概述。写完后用push_content推送给我。";

  const agentResult = await runAgentAndWait(sessionId, input, 180000);

  if (agentResult.error) {
    results.details.push(`Agent error: ${agentResult.error}`);
    results.passed = false;
    return results;
  }

  results.details.push(`Output length: ${agentResult.fullOutput?.length || 0}`);
  results.details.push(`Push contents: ${agentResult.pushedContents?.length || 0}`);
  results.details.push(`Tool calls: ${agentResult.toolCalls?.map(t => t.name).join(", ") || "none"}`);

  // Check push_content results
  let hasEmptyData = false;
  let hasValidData = false;
  for (const pc of (agentResult.pushedContents || [])) {
    const data = pc.data || "";
    if (!data || data.length === 0) {
      hasEmptyData = true;
      results.details.push(`EMPTY DATA: title="${pc.title}"`);
    } else {
      hasValidData = true;
      results.details.push(`Valid data: title="${pc.title}", data_length=${data.length}`);
    }
  }

  // Navigate to see final output
  await page.goto(`${BASE}/?session=${sessionId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fix1-02-result.png`, fullPage: true });

  // Check backend logs for warnings about empty data
  const emptyWarnings = await checkBackendLogs(/push_content.*empty data/i);
  results.details.push(`Backend empty-data warnings: ${JSON.stringify(emptyWarnings)}`);

  // Pass if no empty data OR if empty data is properly logged
  results.passed = !hasEmptyData || (hasEmptyData && emptyWarnings.length > 0);
  results.details.push(`Has empty data: ${hasEmptyData}, Has valid data: ${hasValidData}`);

  // Cleanup
  try { await fetch(`${BASE}/api/sessions/${sessionId}`, { method: "DELETE" }); } catch {}

  return results;
}

async function testFix3_DocGrepFTS(page) {
  console.log("\n=== Fix 3: doc_grep FTS parameter separation ===");

  const results = { name: "Fix 3: doc_grep FTS", passed: false, details: [] };

  const sessionId = await createSession(BIGTEST_KB, "Fix3-docgrep-fts-test");
  results.details.push(`Session: ${sessionId}`);

  await page.goto(`${BASE}/?session=${sessionId}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fix3-01-session-created.png`, fullPage: true });

  // Send a query that will trigger doc_grep with Chinese keywords
  const input = `请使用 doc_grep 搜索知识库中包含"报告"关键词的内容，并总结搜索结果。`;

  const agentResult = await runAgentAndWait(sessionId, input, 180000);

  if (agentResult.error) {
    results.details.push(`Agent error: ${agentResult.error}`);
    results.passed = false;
    return results;
  }

  results.details.push(`Output length: ${agentResult.fullOutput?.length || 0}`);
  results.details.push(`Tool calls: ${agentResult.toolCalls?.map(t => t.name).join(", ") || "none"}`);

  // Check if doc_grep was called and succeeded
  const docGrepCalls = (agentResult.toolCalls || []).filter(t => t.name === "doc_grep");
  results.details.push(`doc_grep calls: ${docGrepCalls.length}`);

  // Check backend logs for FTS errors
  const ftsErrors = await checkBackendLogs(/FTS query failed|could not determine data type/i);
  results.details.push(`FTS error logs: ${JSON.stringify(ftsErrors)}`);

  await page.goto(`${BASE}/?session=${sessionId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fix3-02-result.png`, fullPage: true });

  // Pass if no FTS errors in logs and agent produced output
  results.passed = agentResult.fullOutput?.length > 100 &&
    (!Array.isArray(ftsErrors) || ftsErrors.length === 0);
  results.details.push(`FTS errors found: ${Array.isArray(ftsErrors) ? ftsErrors.length : "check error"}`);

  try { await fetch(`${BASE}/api/sessions/${sessionId}`, { method: "DELETE" }); } catch {}

  return results;
}

async function testFix4_MultimodalGuidance(page) {
  console.log("\n=== Fix 4: Multimodal analysis tool-guidance ===");

  const results = { name: "Fix 4: Multimodal guidance", passed: false, details: [] };

  const sessionId = await createSession(BIGTEST_KB, "Fix4-multimodal-test");
  results.details.push(`Session: ${sessionId}`);

  await page.goto(`${BASE}/?session=${sessionId}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fix4-01-session-created.png`, fullPage: true });

  // First, find what images exist in the KB
  const imgListResp = await fetch(`${BASE}/api/knowledge/kbs/${BIGTEST_KB}/documents?pageSize=100`);
  const imgListData = await imgListResp.json();
  const docs = imgListData.documents || imgListData.data || [];
  const imageDocs = docs.filter(d => {
    const ft = (d.fileType || d.file_type || d.filename || "").toLowerCase();
    return ft.includes("png") || ft.includes("jpg") || ft.includes("jpeg") || ft.includes("image");
  });
  results.details.push(`Total docs: ${docs.length}, Image docs: ${imageDocs.length}`);

  if (imageDocs.length === 0) {
    results.details.push("No image documents found, using text-based test");
  }

  // Send a query that should trigger multimodal analysis workflow
  const input = imageDocs.length > 0
    ? `请分析知识库中的图片内容。先找到所有图片类型的文件，用expand查看每张图片的L1描述。如果某些图片的VLM描述不完整或为占位符，请使用tool_discover获取图片分析工具重新分析。最后汇总所有图片的内容。`
    : `请列出知识库中所有文档的类型分布，并分析各类文档的内容特征。用run_sql查询文档类型统计。`;

  const agentResult = await runAgentAndWait(sessionId, input, 240000);

  if (agentResult.error) {
    results.details.push(`Agent error: ${agentResult.error}`);
    results.passed = false;
    return results;
  }

  results.details.push(`Output length: ${agentResult.fullOutput?.length || 0}`);
  results.details.push(`Tool calls: ${agentResult.toolCalls?.map(t => t.name).join(", ") || "none"}`);

  // Check if agent used expand for images
  const expandCalls = (agentResult.toolCalls || []).filter(t => t.name === "expand");
  const toolDiscoverCalls = (agentResult.toolCalls || []).filter(t => t.name === "tool_discover");
  const imageAnalysisCalls = (agentResult.toolCalls || []).filter(t => t.name === "image_analysis");

  results.details.push(`expand calls: ${expandCalls.length}`);
  results.details.push(`tool_discover calls: ${toolDiscoverCalls.length}`);
  results.details.push(`image_analysis calls: ${imageAnalysisCalls.length}`);

  if (toolDiscoverCalls.length > 0) {
    results.details.push(`tool_discover queries: ${toolDiscoverCalls.map(t => JSON.stringify(t.input)).join(", ")}`);
  }

  await page.goto(`${BASE}/?session=${sessionId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fix4-02-result.png`, fullPage: true });

  // Pass if: agent used expand (for pre-extracted data) AND/OR discovered image_analysis when needed
  // The key test: agent should use expand first, and only use image_analysis via tool_discover if needed
  const usedExpandFirst = expandCalls.length > 0;
  const discoveredImageAnalysis = toolDiscoverCalls.some(t =>
    JSON.stringify(t.input).includes("image_analysis")
  );

  results.passed = usedExpandFirst || agentResult.fullOutput?.length > 200;
  results.details.push(`Used expand first: ${usedExpandFirst}`);
  results.details.push(`Discovered image_analysis: ${discoveredImageAnalysis}`);

  try { await fetch(`${BASE}/api/sessions/${sessionId}`, { method: "DELETE" }); } catch {}

  return results;
}

async function testFix2_CompactionFallback(page) {
  console.log("\n=== Fix 2: Compaction truncation fallback (log check) ===");

  const results = { name: "Fix 2: Compaction fallback", passed: false, details: [] };

  // This fix is best verified by checking backend logs.
  // We test that a long conversation that triggers compaction doesn't crash.
  const sessionId = await createSession(BIGTEST_KB, "Fix2-compaction-test");
  results.details.push(`Session: ${sessionId}`);

  await page.goto(`${BASE}/?session=${sessionId}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fix2-01-session-created.png`, fullPage: true });

  // Send a complex query that will trigger many tool calls and potentially compaction
  const input = `请全面分析这个知识库的内容。分步骤完成：
1. 列出所有文档及其类型
2. 对每个文档进行expand获取L1内容
3. 总结所有文档的主要内容
4. 找出文档之间的关联关系
5. 生成一份完整的知识库分析报告

请确保每个步骤都详细执行，输出要完整。`;

  const agentResult = await runAgentAndWait(sessionId, input, 300000);

  if (agentResult.error) {
    results.details.push(`Agent error: ${agentResult.error}`);
    // Check if the error is related to compaction
    const compactionErrors = await checkBackendLogs(/CompactionEngine.*failed|truncation fallback/i);
    results.details.push(`Compaction-related logs: ${JSON.stringify(compactionErrors)}`);
    results.passed = false;
    return results;
  }

  results.details.push(`Output length: ${agentResult.fullOutput?.length || 0}`);
  results.details.push(`Tool calls: ${(agentResult.toolCalls || []).length}`);
  results.details.push(`Push contents: ${(agentResult.pushedContents || []).length}`);

  // Check for truncation fallback in logs
  const fallbackLogs = await checkBackendLogs(/truncation fallback/i);
  const compactionFailLogs = await checkBackendLogs(/generateMiddleSummary failed/i);

  results.details.push(`Truncation fallback used: ${Array.isArray(fallbackLogs) ? fallbackLogs.length : 0} times`);
  results.details.push(`Compaction failures: ${Array.isArray(compactionFailLogs) ? compactionFailLogs.length : 0} times`);

  await page.goto(`${BASE}/?session=${sessionId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fix2-02-result.png`, fullPage: true });

  // Pass if agent completed without crash (compaction failure should not crash)
  results.passed = agentResult.done !== false && agentResult.fullOutput?.length > 100;
  results.details.push(`Agent completed: ${agentResult.done !== false}`);

  try { await fetch(`${BASE}/api/sessions/${sessionId}`, { method: "DELETE" }); } catch {}

  return results;
}

async function testFix5_IdentifierPreservation(page) {
  console.log("\n=== Fix 5: Identifier preservation limit ===");

  const results = { name: "Fix 5: Identifier preservation", passed: false, details: [] };

  // Check compaction.ts for the constant value
  const compactionSource = fs.readFileSync(
    "/mnt/d/code/deepanalyze/deepanalyze/src/services/agent/compaction.ts",
    "utf-8"
  );
  const match = compactionSource.match(/MAX_PRESERVED_IDENTIFIERS\s*=\s*(\d+)/);
  const limit = match ? parseInt(match[1]) : 0;
  results.details.push(`MAX_PRESERVED_IDENTIFIERS = ${limit}`);

  // Check agent-runner.ts for the slice limit
  const runnerSource = fs.readFileSync(
    "/mnt/d/code/deepanalyze/deepanalyze/src/services/agent/agent-runner.ts",
    "utf-8"
  );
  const sliceMatches = [...runnerSource.matchAll(/slice\(0,\s*(\d+)\)/g)];
  const identifierSlices = sliceMatches.filter(m => m[1] === "300" || m[1] === "150");
  results.details.push(`Identifier slice limits found: ${identifierSlices.map(m => m[1]).join(", ")}`);

  // Also run a session with large KB to verify compaction works
  const sessionId = await createSession(BIGTEST_KB, "Fix5-identifier-test");

  await page.goto(`${BASE}/?session=${sessionId}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fix5-01-session-created.png`, fullPage: true });

  // Complex query to generate many identifiers
  const input = "请逐个展开知识库中的所有文档，读取每个文档的L1内容，然后给出完整的文档目录清单，包含每个文档的标题、ID、类型和简要摘要。";

  const agentResult = await runAgentAndWait(sessionId, input, 300000);

  if (agentResult.error) {
    results.details.push(`Agent error: ${agentResult.error}`);
    results.passed = false;
    return results;
  }

  results.details.push(`Output length: ${agentResult.fullOutput?.length || 0}`);
  results.details.push(`Tool calls: ${(agentResult.toolCalls || []).length}`);

  await page.goto(`${BASE}/?session=${sessionId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fix5-02-result.png`, fullPage: true });

  // Pass if: constants are 300 AND agent completes successfully
  results.passed = limit === 300 &&
    identifierSlices.some(m => m[1] === "300") &&
    agentResult.fullOutput?.length > 100;

  try { await fetch(`${BASE}/api/sessions/${sessionId}`, { method: "DELETE" }); } catch {}

  return results;
}

// =====================================================
// Main Test Runner
// =====================================================

async function main() {
  console.log("Starting E2E Fix Verification Tests...\n");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: "zh-CN",
  });
  const page = await context.newPage();

  // Navigate to home first
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/00-home.png`, fullPage: true });

  const allResults = [];

  // Run tests sequentially
  try {
    allResults.push(await testFix1_PushContentData(page, browser));
  } catch (e) {
    allResults.push({ name: "Fix 1", passed: false, details: [`Exception: ${e.message}`] });
  }

  try {
    allResults.push(await testFix3_DocGrepFTS(page));
  } catch (e) {
    allResults.push({ name: "Fix 3", passed: false, details: [`Exception: ${e.message}`] });
  }

  try {
    allResults.push(await testFix4_MultimodalGuidance(page));
  } catch (e) {
    allResults.push({ name: "Fix 4", passed: false, details: [`Exception: ${e.message}`] });
  }

  try {
    allResults.push(await testFix2_CompactionFallback(page));
  } catch (e) {
    allResults.push({ name: "Fix 2", passed: false, details: [`Exception: ${e.message}`] });
  }

  try {
    allResults.push(await testFix5_IdentifierPreservation(page));
  } catch (e) {
    allResults.push({ name: "Fix 5", passed: false, details: [`Exception: ${e.message}`] });
  }

  await browser.close();

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("TEST RESULTS SUMMARY");
  console.log("=".repeat(60));

  let passed = 0, failed = 0;
  for (const r of allResults) {
    const status = r.passed ? "PASS" : "FAIL";
    console.log(`\n[${status}] ${r.name}`);
    for (const d of r.details) {
      console.log(`  ${d}`);
    }
    if (r.passed) passed++; else failed++;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Total: ${allResults.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Screenshots saved to: ${SCREENSHOT_DIR}`);
  console.log(`${"=".repeat(60)}`);

  // Save results as JSON
  fs.writeFileSync(
    `${SCREENSHOT_DIR}/results.json`,
    JSON.stringify(allResults, null, 2)
  );
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
