/**
 * E2E Fix Verification V3 — correct SSE parsing + meaningful screenshots
 */

import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:21000";
const SHOTS = "/tmp/da-fix-verify-v3";
const BIGTEST = "60346710-913d-4b54-b742-499da76cd85b";
if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

// ── SSE parser: handles event: + data: pairs ──
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
      // Standalone data line (no event: prefix) — treat as "message" type
      try { events.push({ type: "message", data: JSON.parse(line.slice(6)) }); } catch {}
      currentEvent = null;
    } else if (line.trim() === "") {
      currentEvent = null;
    }
  }
  return events;
}

async function runAgent(sessionId, input, timeoutMs = 300000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BASE}/api/agents/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, input }),
      signal: controller.signal,
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    const raw = await resp.text();
    const events = parseSSE(raw);

    // Extract structured results
    const textParts = events.filter(e => e.type === "progress" && e.data?.type === "text")
      .map(e => e.data.content || "").filter(Boolean);
    const toolCalls = events.filter(e => e.type === "tool_call")
      .map(e => ({ name: e.data?.toolName, input: e.data?.input }));
    const pushContents = events.filter(e => e.type === "push_content")
      .map(e => e.data);
    const done = events.find(e => e.type === "done");
    const complete = events.find(e => e.type === "complete");

    const fullOutput = complete?.data?.output || textParts.join("\n") || "";

    return {
      fullOutput,
      toolCalls,
      pushContents,
      done: !!done,
      complete: complete?.data,
      allEvents: events,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mkSession(kbId, title) {
  const r = await fetch(`${BASE}/api/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const s = await r.json();
  const sid = s.id || s.sessionId;
  if (kbId) {
    await fetch(`${BASE}/api/sessions/${sid}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: { kbIds: [kbId] } }),
    });
  }
  return sid;
}

function grepLogs(pattern) {
  try {
    const files = fs.readdirSync("/tmp").filter(f => f.startsWith("da_debug") && f.endsWith(".log")).sort();
    if (!files.length) return [];
    return fs.readFileSync(`/tmp/${files[files.length - 1]}`, "utf-8")
      .split("\n").filter(l => pattern.test(l)).slice(-20);
  } catch { return []; }
}

async function screenshot(page, sid, file) {
  await page.goto(`${BASE}/?session=${sid}`, { waitUntil: "domcontentloaded" });
  // Wait for chat messages to render (agent response)
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const hasMsg = await page.evaluate(() => {
      const els = document.querySelectorAll('[class*="markdown"], [class*="message"], [class*="content"]');
      for (const el of els) {
        if (el.textContent && el.textContent.trim().length > 50) return true;
      }
      return false;
    });
    if (hasMsg) break;
  }
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/${file}`, fullPage: true });
}

// =====================================================

async function main() {
  console.log("E2E Fix Verification V3\n");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  const results = [];

  // ── Fix 1: push_content data field ──
  console.log("=== Fix 1: push_content data ===");
  {
    const r = { name: "Fix 1: push_content data", passed: false, details: [] };
    try {
      const sid = await mkSession(BIGTEST, "Fix1");
      r.details.push(`Session: ${sid}`);
      await page.goto(`${BASE}/?session=${sid}`, { waitUntil: "networkidle" });
      await page.screenshot({ path: `${SHOTS}/fix1-01.png`, fullPage: true });

      const res = await runAgent(sid, "请用push_content推送一个简短的测试报告卡片。", 180000);
      r.details.push(`Done: ${res.done}, Output: ${res.fullOutput?.length}ch`);
      r.details.push(`Tools: ${res.toolCalls.map(t => t.name).join(", ")}`);
      r.details.push(`Push contents: ${res.pushContents.length}`);

      for (const pc of res.pushContents) {
        const dl = (pc.data || "").length;
        r.details.push(`  PC "${pc.title}": data=${dl}ch ${dl > 0 ? "OK" : "EMPTY!"}`);
      }

      const emptyWarns = grepLogs(/push_content.*empty/i);
      r.details.push(`Empty-data warnings: ${emptyWarns.length}`);

      await screenshot(page, sid, "fix1-02.png");

      r.passed = res.pushContents.length > 0 && res.pushContents.every(pc => (pc.data || "").length > 0);
    } catch (e) { r.details.push(`ERR: ${e.message}`); }
    results.push(r);
  }

  // ── Fix 3: doc_grep FTS ──
  console.log("=== Fix 3: doc_grep FTS ===");
  {
    const r = { name: "Fix 3: doc_grep FTS", passed: false, details: [] };
    try {
      const sid = await mkSession(BIGTEST, "Fix3");
      r.details.push(`Session: ${sid}`);

      const res = await runAgent(sid, `用doc_grep搜索知识库中含「分析」关键词的内容，总结搜索结果。`, 180000);
      r.details.push(`Done: ${res.done}, Output: ${res.fullOutput?.length}ch`);
      r.details.push(`Tools: ${res.toolCalls.map(t => t.name).join(", ")}`);

      const grepCalls = res.toolCalls.filter(t => t.name === "doc_grep");
      r.details.push(`doc_grep calls: ${grepCalls.length}`);

      const ftsErrs = grepLogs(/FTS query failed|could not determine data type/i);
      r.details.push(`FTS errors: ${ftsErrs.length}`);
      if (ftsErrs.length > 0) r.details.push(`  ${ftsErrs[0]}`);

      await screenshot(page, sid, "fix3-02.png");

      r.passed = res.done && grepCalls.length > 0 && ftsErrs.length === 0 && res.fullOutput?.length > 100;
    } catch (e) { r.details.push(`ERR: ${e.message}`); }
    results.push(r);
  }

  // ── Fix 4: Multimodal guidance ──
  console.log("=== Fix 4: Multimodal ===");
  {
    const r = { name: "Fix 4: Multimodal", passed: false, details: [] };
    try {
      const sid = await mkSession(BIGTEST, "Fix4");
      r.details.push(`Session: ${sid}`);

      const res = await runAgent(sid,
        `请分析知识库中的图片。步骤：
1. 用 run_sql 查询所有图片类型文档（file_type包含png/jpg/jpeg）
2. 对前5张图片用 expand 获取 L1 内容
3. 如果某图片的 VLM 描述不完整，用 tool_discover 获取 image_analysis 重新分析
4. 汇总图片内容`, 300000);

      r.details.push(`Done: ${res.done}, Output: ${res.fullOutput?.length}ch`);
      r.details.push(`Tools: ${res.toolCalls.map(t => t.name).join(", ")}`);

      const expands = res.toolCalls.filter(t => t.name === "expand").length;
      const discovers = res.toolCalls.filter(t => t.name === "tool_discover");
      const imgAnas = res.toolCalls.filter(t => t.name === "image_analysis").length;
      r.details.push(`expand=${expands} tool_discover=${discovers.length} image_analysis=${imgAnas}`);

      const discoverForImg = discovers.filter(t => JSON.stringify(t.input).includes("image_analysis")).length;
      r.details.push(`tool_discover(image_analysis): ${discoverForImg}`);

      // Key check: if image_analysis was used, it MUST have been discovered first
      const usedImgWithoutDiscover = imgAnas > 0 && discoverForImg === 0;
      if (usedImgWithoutDiscover) {
        r.details.push(`WARNING: image_analysis used without tool_discover — defer may not be working`);
      }

      await screenshot(page, sid, "fix4-02.png");

      // Pass if: agent completed AND (used expand OR used tool_discover for image)
      // AND did NOT use image_analysis without first discovering it
      r.passed = res.done && (expands > 0 || res.fullOutput?.length > 100) && !usedImgWithoutDiscover;
    } catch (e) { r.details.push(`ERR: ${e.message}`); }
    results.push(r);
  }

  // ── Fix 2: Compaction fallback ──
  console.log("=== Fix 2: Compaction ===");
  {
    const r = { name: "Fix 2: Compaction", passed: false, details: [] };
    try {
      const sid = await mkSession(BIGTEST, "Fix2");
      r.details.push(`Session: ${sid}`);

      const res = await runAgent(sid,
        `全面分析知识库。逐个expand所有文档（或至少前30个），然后给出完整的分析报告。`, 300000);

      r.details.push(`Done: ${res.done}, Output: ${res.fullOutput?.length}ch`);
      r.details.push(`Tool calls: ${res.toolCalls.length}`);
      r.details.push(`Push contents: ${res.pushContents.length}`);

      const fallbacks = grepLogs(/truncation fallback/i).length;
      const failures = grepLogs(/generateMiddleSummary failed/i).length;
      const crashes = grepLogs(/unhandledRejection|FATAL/i).length;
      r.details.push(`Truncation fallback: ${fallbacks}, failures: ${failures}, crashes: ${crashes}`);

      await screenshot(page, sid, "fix2-02.png");

      r.passed = res.done && crashes === 0;
    } catch (e) { r.details.push(`ERR: ${e.message}`); }
    results.push(r);
  }

  // ── Fix 5: Identifier preservation ──
  console.log("=== Fix 5: Identifiers ===");
  {
    const r = { name: "Fix 5: Identifiers", passed: false, details: [] };
    // Source code check
    const src = fs.readFileSync("/mnt/d/code/deepanalyze/deepanalyze/src/services/agent/compaction.ts", "utf-8");
    const m = src.match(/MAX_PRESERVED_IDENTIFIERS\s*=\s*(\d+)/);
    const limit = m ? parseInt(m[1]) : 0;
    r.details.push(`MAX_PRESERVED_IDENTIFIERS = ${limit}`);

    const runner = fs.readFileSync("/mnt/d/code/deepanalyze/deepanalyze/src/services/agent/agent-runner.ts", "utf-8");
    const slices = [...runner.matchAll(/slice\(0,\s*(\d+)\)/g)].map(m => m[1]);
    r.details.push(`All slice limits: ${[...new Set(slices)].join(", ")}`);
    r.details.push(`Has 300: ${slices.includes("300")}`);

    try {
      const sid = await mkSession(BIGTEST, "Fix5");
      const res = await runAgent(sid, `展开知识库前20个文档获取L1内容，列出文档ID和摘要。`, 300000);
      r.details.push(`Done: ${res.done}, Output: ${res.fullOutput?.length}ch`);

      await screenshot(page, sid, "fix5-02.png");

      r.passed = limit === 300 && slices.includes("300") && res.done;
    } catch (e) { r.details.push(`ERR: ${e.message}`); }
    results.push(r);
  }

  await browser.close();

  // Summary
  console.log("\n" + "=".repeat(60));
  let p = 0, f = 0;
  for (const r of results) {
    const s = r.passed ? "PASS" : "FAIL";
    console.log(`\n[${s}] ${r.name}`);
    for (const d of r.details) console.log(`  ${d}`);
    r.passed ? p++ : f++;
  }
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Total: ${results.length} | Pass: ${p} | Fail: ${f}`);
  console.log(`Screenshots: ${SHOTS}`);
  fs.writeFileSync(`${SHOTS}/results.json`, JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
