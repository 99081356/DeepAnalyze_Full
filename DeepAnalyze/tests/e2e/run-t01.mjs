import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:21000";
const OUT = "/tmp/da-60test";
const BIGTEST = "60346710-913d-4b54-b742-499da76cd85b";
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function parseSSE(raw) {
  const events = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) { cur = { type: line.slice(7).trim(), data: null }; }
    else if (line.startsWith("data: ") && cur) {
      try { cur.data = JSON.parse(line.slice(6)); } catch { cur.data = line.slice(6); }
      events.push(cur); cur = null;
    } else if (line.trim() === "") { cur = null; }
  }
  return events;
}

async function mkSession(kbId, title) {
  const r = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
  const s = await r.json();
  const sid = s.id || s.sessionId;
  if (kbId) await fetch(`${BASE}/api/sessions/${sid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: { kbIds: [kbId] } }) });
  return sid;
}

async function runAgent(sid, input, timeoutMs = 900000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs + 60000);
  const t0 = Date.now();
  try {
    const resp = await fetch(`${BASE}/api/agents/run-stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, input }), signal: ctrl.signal,
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}`, elapsed: Date.now() - t0 };
    const raw = await resp.text();
    const events = parseSSE(raw);
    const textParts = events.filter(e => e.type === "progress" && e.data?.type === "text").map(e => e.data.content || "").filter(Boolean);
    const toolCalls = events.filter(e => e.type === "tool_call").map(e => ({ name: e.data?.toolName, input: e.data?.input }));
    const pushContents = events.filter(e => e.type === "push_content").map(e => e.data);
    const done = events.find(e => e.type === "done");
    const complete = events.find(e => e.type === "complete");
    const fullOutput = complete?.data?.output || textParts.join("\n") || "";
    return { fullOutput, toolCalls, pushContents, done: !!done, elapsed: Date.now() - t0, rawLength: raw.length };
  } catch (e) { return { error: e.message, elapsed: Date.now() - t0 }; }
  finally { clearTimeout(timer); }
}

async function screenshot(page, sid, file) {
  try {
    await page.goto(`${BASE}/?session=${sid}`, { waitUntil: "domcontentloaded" });
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(800);
      const has = await page.evaluate(() => {
        const els = document.querySelectorAll('[class*="markdown"],[class*="message"],[class*="content"],article,pre,[class*="push"]');
        for (const el of els) if (el.textContent && el.textContent.trim().length > 30) return true;
        return false;
      });
      if (has) break;
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
  } catch (e) { console.log("Screenshot err:", e.message); }
}

async function main() {
  console.log("=== T01: bigtest Full KB Analysis ===");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();

  const sid = await mkSession(BIGTEST, "T01-FullKB");
  console.log("Session:", sid);
  await screenshot(page, sid, "T01-00-initial.png");

  const res = await runAgent(sid, `请对知识库进行全面分析。步骤：
1. 先用 wiki_browse 查看分类结构
2. 用 run_sql 统计各类型文档数量
3. 对论文类：展开3-5篇代表性论文L1内容，分析技术主题
4. 对剧本杀类：选择一个分析核心推理逻辑和证据链
5. 对表格类：查看Excel的L0摘要
6. 对图片/音视频：查看VLM描述和ASR转写质量
7. 用 push_content 推送一份综合分析摘要卡片
每个类别至少分析2-3个文档。`, 900000);

  if (res.error) {
    console.log("ERROR:", res.error);
  } else {
    console.log("Done:", res.done);
    console.log("Output:", res.fullOutput?.length, "chars");
    console.log("Time:", (res.elapsed / 1000).toFixed(1), "s");
    console.log("Tool calls:", res.toolCalls.length);
    const tc = {};
    for (const t of res.toolCalls) tc[t.name] = (tc[t.name] || 0) + 1;
    console.log("Tool breakdown:", Object.entries(tc).map(([k, v]) => `${k}=${v}`).join(", "));
    console.log("Push contents:", res.pushContents.length);
    for (const pc of res.pushContents) {
      console.log(`  PC "${pc.title}": ${(pc.data || "").length}ch`);
    }
    await screenshot(page, sid, "T01-99-final.png");

    // Save result
    const result = {
      id: "T01", name: "bigtest Full KB Analysis",
      done: res.done, outputChars: res.fullOutput?.length || 0,
      toolCalls: res.toolCalls.length, toolBreakdown: tc,
      pushContents: res.pushContents.map(pc => ({ title: pc.title, dataLen: (pc.data || "").length })),
      elapsed: res.elapsed,
    };
    fs.writeFileSync(`${OUT}/T01-result.json`, JSON.stringify(result, null, 2));

    // Evaluate
    const pass = res.done && res.toolCalls.length >= 10 && (res.fullOutput?.length || 0) >= 3000;
    console.log("\nRESULT:", pass ? "PASS" : "FAIL");
  }

  await browser.close();
}
main().catch(e => console.error(e));
