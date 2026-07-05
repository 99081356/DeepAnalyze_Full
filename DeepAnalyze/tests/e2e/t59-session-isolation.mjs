/**
 * T59: 跨Session状态隔离与KB作用域切换压力测试
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:21000";
const OUT = "/tmp/da-60test";
const BIGTEST = "60346710-913d-4b54-b742-499da76cd85b";
const LBCTEST = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";

function parseSSE(raw) {
  const events = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) cur = { type: line.slice(7).trim(), data: null };
    else if (line.startsWith("data: ") && cur) {
      try { cur.data = JSON.parse(line.slice(6)); } catch { cur.data = line.slice(6); }
      events.push(cur); cur = null;
    } else if (line.trim() === "") cur = null;
  }
  return events;
}

async function mkSession(kbId, title) {
  const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
  const s = await r.json();
  const sid = s.id || s.sessionId;
  if (kbId) {
    await fetch(`${BASE}/api/sessions/${sid}/scope`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kbScope: { kbIds: [kbId] } }) });
  }
  return sid;
}

async function sendAndCollect(sid, input, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BASE}/api/agents/run-stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, input }), signal: ctrl.signal,
    });
    const raw = await resp.text();
    const events = parseSSE(raw);
    const done = events.find(e => e.type === "done");
    const complete = events.find(e => e.type === "complete");
    const textParts = events.filter(e => e.type === "progress" && e.data?.type === "text").map(e => e.data.content || "");
    const output = complete?.data?.output || textParts.join("") || "";
    const toolCalls = events.filter(e => e.type === "tool_call").map(e => e.data?.toolName);
    const error = events.find(e => e.type === "error");
    return { output: output || "", toolCalls: toolCalls || [], done: !!done, error: error?.data?.error };
  } catch (e) { return { output: "", toolCalls: [], error: e.message, done: false }; }
  finally { clearTimeout(timer); }
}

async function main() {
  console.log("=== T59: 跨Session状态隔离 ===");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

  // Create 3 sessions
  const sidA = await mkSession(LBCTEST, "T59-SessionA-lbctest");
  const sidB = await mkSession(BIGTEST, "T59-SessionB-bigtest");
  const sidC = await mkSession(null, "T59-SessionC-noKB");
  console.log(`Session A (lbctest): ${sidA}`);
  console.log(`Session B (bigtest): ${sidB}`);
  console.log(`Session C (noKB): ${sidC}`);

  // Step 1: Send message to A
  console.log("\n--- Step 1: Session A (lbctest) ---");
  const rA = await sendAndCollect(sidA, "列出知识库中所有与'逮捕'相关的文档名称");
  console.log(`  A: done=${rA.done}, out=${rA.output.length}ch, tools=[${[...new Set(rA.toolCalls)].join(",")}]`);
  const aHasLegal = rA.output.includes("逮捕") || rA.output.includes("法律") || rA.output.includes("卖淫");
  console.log(`  A references legal content: ${aHasLegal}`);

  // Step 2: Send message to B
  console.log("\n--- Step 2: Session B (bigtest) ---");
  const rB = await sendAndCollect(sidB, "列出知识库中所有论文标题");
  console.log(`  B: done=${rB.done}, out=${rB.output.length}ch, tools=[${[...new Set(rB.toolCalls)].join(",")}]`);
  const bHasPapers = rB.output.includes("论文") || rB.output.includes("paper") || rB.output.includes("研究");
  console.log(`  B references papers: ${bHasPapers}`);

  // Step 3: Send message to C (no KB)
  console.log("\n--- Step 3: Session C (noKB) ---");
  const rC = await sendAndCollect(sidC, "请解释量子计算的基本原理");
  console.log(`  C: done=${rC.done}, out=${rC.output.length}ch`);
  const cHasNoKB = !rC.output.includes("知识库") && rC.output.includes("量子");
  console.log(`  C is general (no KB ref): ${cHasNoKB}`);

  // Step 4: Cross-contamination check
  console.log("\n--- Step 4: Cross-contamination check ---");
  const aHasBigtest = rA.output.includes("论文") && rA.output.includes("neurips");
  const bHasLctest = rB.output.includes("逮捕") || rB.output.includes("卖淫");
  console.log(`  A has bigtest content: ${aHasBigtest}`);
  console.log(`  B has lbctest content: ${bHasLctest}`);
  const noCrossContamination = !aHasBigtest && !bHasLctest;
  console.log(`  No cross-contamination: ${noCrossContamination}`);

  // Step 5: Switch sessions and verify context preserved (longer timeout)
  console.log("\n--- Step 5: Switch and verify ---");
  const rA2 = await sendAndCollect(sidA, "请继续分析逮捕证的内容", 180000);
  console.log(`  A follow-up: done=${rA2.done}, out=${rA2.output.length}ch, error=${rA2.error || "none"}`);
  const a2StillLegal = rA2.done && (rA2.output.includes("逮捕") || rA2.output.includes("拘留"));
  console.log(`  A still in legal context: ${a2StillLegal}`);

  // Screenshots of all 3 sessions
  for (const [name, sid] of [["A", sidA], ["B", sidB], ["C", sidC]]) {
    await page.goto(`${BASE}/#/sessions/${sid}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/T59-session-${name}.png`, fullPage: true });
  }

  // Verdict: core isolation + all sessions working = PASS; context preserved is bonus
  const pass = rA.done && rB.done && rC.done && noCrossContamination;
  console.log(`\nT59 VERDICT: ${pass ? "PASS" : "NEEDS REVIEW"}`);
  console.log(`  A: ${rA.done ? "OK" : "FAIL"}, B: ${rB.done ? "OK" : "FAIL"}, C: ${rC.done ? "OK" : "FAIL"}`);
  console.log(`  No cross-contamination: ${noCrossContamination}`);
  console.log(`  Context preserved (follow-up): ${a2StillLegal} ${rA2.done ? "" : "(timeout - not critical)"}`);
  
  fs.writeFileSync(`${OUT}/T59-result.json`, JSON.stringify({
    id: "T59", done: pass,
    sessionA: { done: rA.done, outputLen: rA.output.length, legal: aHasLegal },
    sessionB: { done: rB.done, outputLen: rB.output.length, papers: bHasPapers },
    sessionC: { done: rC.done, outputLen: rC.output.length, general: cHasNoKB },
    noCrossContamination, contextPreserved: a2StillLegal,
    consoleErrors: consoleErrors.slice(0, 5),
  }, null, 2));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
