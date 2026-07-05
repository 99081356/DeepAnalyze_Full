import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:21000";
const OUT = "/tmp/da-60test";
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

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
  const s = await r.json(); const sid = s.id || s.sessionId;
  if (kbId) {
    const kbIds = Array.isArray(kbId) ? kbId : [kbId];
    await fetch(`${BASE}/api/sessions/${sid}/scope`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kbScope: { kbIds } }) });
  }
  return sid;
}

async function sendMsg(sid, input, timeoutMs = 600000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs + 30000);
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
    const toolResults = events.filter(e => e.type === "tool_result").map(e => ({ name: e.data?.toolName, hasResult: !!(e.data?.result || e.data?.output || e.data?.content) }));
    const pushContents = events.filter(e => e.type === "push_content").map(e => e.data);
    const done = events.find(e => e.type === "done");
    const complete = events.find(e => e.type === "complete");
    const fullOutput = complete?.data?.output || textParts.join("") || "";
    const allTypes = [...new Set(events.map(e => e.type))];
    return { fullOutput, toolCalls, toolResults, pushContents, done: !!done, elapsed: Date.now() - t0, rawLen: raw.length, eventTypes: allTypes, events };
  } catch (e) { return { error: e.message, elapsed: Date.now() - t0 }; }
  finally { clearTimeout(timer); }
}

async function screenshot(page, sid, file) {
  try {
    await page.goto(`${BASE}/#/sessions/${sid}`, { waitUntil: "domcontentloaded" });
    // Wait for actual session content (not sidebar navigation)
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(500);
      const ok = await page.evaluate(() => {
        // Check for push content cards specifically
        const pushCards = document.querySelectorAll('[data-testid="push-content-card"]');
        if (pushCards.length > 0) return true;
        // Check for substantial markdown content (assistant messages)
        const mdEls = document.querySelectorAll('[class*="markdown-content"]');
        for (const el of mdEls) if (el.textContent && el.textContent.trim().length > 100) return true;
        // Fallback: check for any article/pre with substantial text
        const contentEls = document.querySelectorAll('article,pre,[class*="message-content"]');
        for (const el of contentEls) if (el.textContent && el.textContent.trim().length > 100) return true;
        return false;
      });
      if (ok) break;
    }
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
  } catch (e) { console.log("Screenshot err:", e.message); }
}

async function analyzePage(page) {
  return await page.evaluate(() => {
    const r = { bodyTextLen: 0, pushCards: 0, toolCards: 0, msgCount: 0, links: 0 };
    r.bodyTextLen = document.body.innerText.length;
    // PushContentCard uses data-testid="push-content-card"
    r.pushCards = document.querySelectorAll('[data-testid="push-content-card"]').length;
    // ToolCallCard uses <details> element
    r.toolCards = document.querySelectorAll('details').length;
    // Messages rendered in scrollable container
    r.msgCount = document.querySelectorAll('[class*="markdown-content"]').length;
    // Evidence links
    r.links = document.querySelectorAll('a[href*="da-evidence"],a[href*="kb://"]').length;
    return r;
  });
}

// ═══ Read args ═══
const testId = process.argv[2]; // e.g. T02
const kbId = process.argv[3];   // BIGTEST or LBCTEST or null
const promptFile = process.argv[4]; // file with prompt
const timeoutMs = parseInt(process.argv[5] || "600000");

if (!testId) { console.log("Usage: node run-single.mjs T02 BIGTEST prompt.txt [timeout]"); process.exit(1); }

const KB_MAP = {
  "BIGTEST": "60346710-913d-4b54-b742-499da76cd85b",
  "LBCTEST": "9ae696db-3e54-4be4-be6c-b2ceae466fc7",
  "DUAL": ["60346710-913d-4b54-b742-499da76cd85b", "9ae696db-3e54-4be4-be6c-b2ceae466fc7"],
  "null": null,
  "NONE": null,
};

const kb = KB_MAP[kbId] || null;
const prompt = (promptFile && promptFile !== "-" && fs.existsSync(promptFile))
  ? fs.readFileSync(promptFile, "utf-8")
  : (process.argv[6] || "Hello");

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();

  // Capture console errors
  const consoleErrors = [];
  page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

  console.log(`=== ${testId} ===`);
  console.log(`KB: ${kbId}`);
  console.log(`Prompt: ${prompt.slice(0, 100)}...`);

  const sid = await mkSession(kb, testId);
  console.log(`Session: ${sid}`);

  await screenshot(page, sid, `${testId}-00-initial.png`);

  console.log(`Running agent (timeout ${timeoutMs/1000}s)...`);
  const res = await sendMsg(sid, prompt, timeoutMs);

  if (res.error) {
    console.log(`ERROR: ${res.error}`);
    console.log(`Elapsed: ${(res.elapsed/1000).toFixed(1)}s`);
    await browser.close();
    process.exit(1);
  }

  console.log(`\n--- Results ---`);
  console.log(`Done: ${res.done}`);
  console.log(`Output: ${(res.fullOutput || "").length} chars`);
  console.log(`Time: ${(res.elapsed/1000).toFixed(1)}s`);
  console.log(`SSE raw: ${(res.rawLen/1024).toFixed(1)}KB`);
  console.log(`Event types: ${res.eventTypes.join(", ")}`);
  console.log(`Tool calls: ${res.toolCalls.length}`);

  const tc = {};
  for (const t of res.toolCalls) tc[t.name] = (tc[t.name] || 0) + 1;
  console.log(`Breakdown: ${Object.entries(tc).map(([k,v])=>`${k}=${v}`).join(", ")}`);

  // Tool call sequence analysis
  console.log(`\n--- Tool Call Sequence ---`);
  for (let i = 0; i < res.toolCalls.length; i++) {
    const t = res.toolCalls[i];
    const inputStr = JSON.stringify(t.input || {});
    console.log(`  ${i+1}. ${t.name}: ${inputStr.slice(0, 120)}`);
  }

  // Tool result analysis
  console.log(`\n--- Tool Results ---`);
  const resultNames = {};
  for (const tr of res.toolResults) {
    resultNames[tr.name] = (resultNames[tr.name] || 0) + (tr.hasResult ? 1 : 0);
  }
  console.log(`Results received: ${JSON.stringify(resultNames)}`);

  console.log(`\n--- Push Contents ---`);
  console.log(`Count: ${res.pushContents.length}`);
  for (const pc of res.pushContents) {
    const dl = (pc.data || "").length;
    console.log(`  "${pc.title}": data=${dl}ch ${dl > 0 ? "OK" : "EMPTY"}`);
  }

  // Duplicate push check
  const titles = res.pushContents.map(p => p.title);
  const dupes = titles.filter((t,i) => titles.indexOf(t) !== i);
  if (dupes.length > 0) console.log(`  WARNING: Duplicate titles: ${[...new Set(dupes)].join(", ")}`);

  // Frontend screenshot and analysis
  await screenshot(page, sid, `${testId}-99-final.png`);
  const fe = await analyzePage(page);
  console.log(`\n--- Frontend Analysis ---`);
  console.log(`Body text: ${fe.bodyTextLen}ch`);
  console.log(`Push cards: ${fe.pushCards}`);
  console.log(`Tool cards: ${fe.toolCards}`);
  console.log(`Messages: ${fe.msgCount}`);
  console.log(`Evidence links: ${fe.links}`);
  console.log(`Console errors: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) {
    console.log(`  Errors:`);
    for (const e of consoleErrors.slice(0, 5)) console.log(`    ${e.slice(0, 150)}`);
  }

  // Output preview
  const out = res.fullOutput || "";
  if (out.length > 0) {
    console.log(`\n--- Output Preview ---`);
    console.log(out.slice(0, 500));
    if (out.length > 500) console.log(`... (${out.length} chars total)`);
  }

  // Save result
  const result = {
    id: testId, session: sid,
    done: res.done, outputLen: out.length, elapsed: res.elapsed,
    toolCalls: res.toolCalls.length, toolBreakdown: tc,
    pushContents: res.pushContents.map(p => ({ title: p.title, dataLen: (p.data || "").length })),
    pushDuplicates: [...new Set(dupes)],
    frontend: fe, consoleErrors: consoleErrors.slice(0, 10),
    outputPreview: out.slice(0, 1000),
    rawEventCount: res.events?.length || 0,
  };
  fs.writeFileSync(`${OUT}/${testId}-result.json`, JSON.stringify(result, null, 2));

  // Quick pass/fail
  const pass = res.done && res.toolCalls.length >= 2 && !res.error;
  console.log(`\nVERDICT: ${pass ? "PASS" : "NEEDS REVIEW"}`);

  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
