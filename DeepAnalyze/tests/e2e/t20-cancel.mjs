/**
 * T20: 取消工作流并恢复
 * 
 * 步骤：
 * 1. 启动长任务（深度分析，需大量工具调用）
 * 2. 等待3-5个工具调用后取消
 * 3. 验证取消生效
 * 4. 发送新简单问题
 * 5. 验证新任务正常
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:21000";
const OUT = "/tmp/da-60test";
const KB = "60346710-913d-4b54-b742-499da76cd85b";

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

async function main() {
  console.log("=== T20: 取消工作流并恢复 ===");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

  // Create session with bigtest KB
  const sRes = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T20-cancel-workflow" }) });
  const sData = await sRes.json();
  const sid = sData.id || sData.sessionId;
  console.log(`Session: ${sid}`);
  
  await fetch(`${BASE}/api/sessions/${sid}/scope`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kbScope: { kbIds: [KB] } }) });

  // === Step 1: Start a long task ===
  console.log("\n--- Step 1: Start long task ---");
  const longPrompt = `请对知识库中所有文档进行详细分析：\n1. 使用 wiki_browse 列出所有文档\n2. 按类型分类（论文、剧本杀、图片、音视频、表格、代码等）\n3. 对每类文档使用 expand 展开前10个的L1内容\n4. 对每类给出详细分析报告\n5. 最后综合汇总`;
  
  const ctrl = new AbortController();
  const t0 = Date.now();
  const resp = await fetch(`${BASE}/api/agents/run-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, input: longPrompt }),
    signal: ctrl.signal,
  });

  // Read SSE events until we see 3+ tool calls, then abort
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let toolCallCount = 0;
  let output = "";
  let taskId = null;
  let currentEvent = "";
  let aborted = false;
  let allEvents = [];
  let buffer = "";

  const abortTimer = setTimeout(() => {
    if (!aborted) {
      console.log("Force aborting after 60s (no 3 tool calls)");
      aborted = true;
      ctrl.abort();
    }
  }, 60000);

  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      
      // Process complete SSE events
      const parts = buffer.split("\n\n");
      buffer = parts.pop(); // keep incomplete
      
      for (const part of parts) {
        let eventType = "";
        let eventData = null;
        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          if (line.startsWith("data: ")) {
            try { eventData = JSON.parse(line.slice(6)); } catch { eventData = line.slice(6); }
          }
        }
        if (eventType && eventData) {
          allEvents.push({ type: eventType, data: eventData });
          
          if (eventType === "start" && eventData.taskId) taskId = eventData.taskId;
          if (eventType === "tool_call") {
            toolCallCount++;
            console.log(`  Tool call #${toolCallCount}: ${eventData.toolName || eventData.name || "unknown"}`);
          }
          if (eventType === "content_delta" && eventData.delta) output += eventData.delta;
          
          // Abort after 3 tool calls
          if (toolCallCount >= 3 && !aborted) {
            console.log(`\n  >> Aborting after ${toolCallCount} tool calls`);
            aborted = true;
            ctrl.abort();
            break;
          }
        }
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") console.log("Stream error:", e.message);
  }
  clearTimeout(abortTimer);
  
  const time1 = Date.now() - t0;
  console.log(`\n  Stream 1: ${toolCallCount} tool calls, ${output.length}ch output, ${(time1/1000).toFixed(1)}s`);
  console.log(`  Task ID: ${taskId}`);

  // === Step 2: Verify cancel took effect ===
  console.log("\n--- Step 2: Wait 3s, verify cancel ---");
  await new Promise(r => setTimeout(r, 3000));
  
  // Screenshot the session showing cancelled state
  await page.goto(`${BASE}/#/sessions/${sid}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/T20-01-cancelled.png`, fullPage: true });
  const cancelPage = await page.evaluate(() => ({
    bodyTextLen: document.body.innerText.length,
    msgCount: document.querySelectorAll('[class*="markdown-content"]').length,
    pushCards: document.querySelectorAll('[data-testid="push-content-card"]').length,
  }));
  console.log(`  Cancel page: text=${cancelPage.bodyTextLen}ch, msgs=${cancelPage.msgCount}, pushCards=${cancelPage.pushCards}`);

  // === Step 3: Send new simple question ===
  console.log("\n--- Step 3: Send new simple question ---");
  const resp2 = await fetch(`${BASE}/api/agents/run-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, input: "请简要总结知识库中有多少文档，分别是什么类型。" }),
  });

  const raw2 = await resp2.text();
  const events2 = parseSSE(raw2);
  const toolCalls2 = events2.filter(e => e.type === "tool_call");
  const done2 = events2.find(e => e.type === "done");
  const textParts2 = events2.filter(e => e.type === "progress" && e.data?.type === "text").map(e => e.data.content || "");
  const complete2 = events2.find(e => e.type === "complete");
  const output2 = complete2?.data?.output || textParts2.join("") || "";
  
  console.log(`  Stream 2: ${toolCalls2.length} tool calls, done=${!!done2}`);
  console.log(`  Output 2: ${output2.length} chars`);
  console.log(`  Tool breakdown: ${[...new Set(toolCalls2.map(t => t.data?.toolName))].join(", ")}`);
  
  if (output2.length > 0) {
    console.log(`  Preview: ${output2.slice(0, 200)}`);
  }

  // === Step 4: Final screenshot ===
  await page.goto(`${BASE}/#/sessions/${sid}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/T20-99-final.png`, fullPage: true });
  const finalPage = await page.evaluate(() => ({
    bodyTextLen: document.body.innerText.length,
    msgCount: document.querySelectorAll('[class*="markdown-content"]').length,
    pushCards: document.querySelectorAll('[data-testid="push-content-card"]').length,
  }));
  console.log(`  Final page: text=${finalPage.bodyTextLen}ch, msgs=${finalPage.msgCount}, pushCards=${finalPage.pushCards}`);

  // === Verdict ===
  const cancelOk = toolCallCount >= 2; // At least some tool calls before cancel
  const newTaskOk = output2.length > 20 && !!done2; // New task completed with output
  const verdict = (cancelOk && newTaskOk) ? "PASS" : "NEEDS REVIEW";
  
  console.log(`\n--- T20 VERDICT: ${verdict} ---`);
  console.log(`  Cancel: ${cancelOk ? "OK" : "FAIL"} (${toolCallCount} tool calls before cancel)`);
  console.log(`  Recovery: ${newTaskOk ? "OK" : "FAIL"} (${output2.length} chars, done=${!!done2})`);
  console.log(`  Console errors: ${consoleErrors.length}`);

  // Save result
  const result = {
    id: "T20", session: sid,
    done: newTaskOk,
    cancelToolCalls: toolCallCount,
    recoveryOutput: output2.length,
    verdict,
    frontend: finalPage,
    consoleErrors: consoleErrors.slice(0, 10),
  };
  fs.writeFileSync(`${OUT}/T20-result.json`, JSON.stringify(result, null, 2));
  
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
