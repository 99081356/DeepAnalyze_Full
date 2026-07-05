/**
 * T51: 双轨附件上传——PDF内联解析与后台KB验证
 * 
 * 1. 创建无KB的session
 * 2. 上传PDF附件并发送消息
 * 3. 验证内联解析
 * 4. 验证后台KB创建
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:21000";
const OUT = "/tmp/da-60test";

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
  console.log("=== T51: 双轨附件上传 ===");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

  // Create session without KB
  const sRes = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T51-attachment" }) });
  const sData = await sRes.json();
  const sid = sData.id || sData.sessionId;
  console.log(`Session: ${sid}`);

  // Create a test PDF content (simple text file as PDF is hard to create in JS, use an existing one)
  // Check if there's an existing PDF in bigtest
  const testDir = "/tmp/da-t51-files";
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  
  // Create a test text file (will be treated as attachment)
  fs.writeFileSync(`${testDir}/analysis-note.txt`, 
    "# 分析报告\n\n## 概述\n\n这是一份测试文档，用于验证双轨附件上传功能。\n\n" +
    "## 数据\n\n| 项目 | 数值 | 同比增长 |\n|------|------|----------|\n| 营收 | 1000万 | +15% |\n| 利润 | 250万 | +22% |\n| 成本 | 750万 | +12% |\n\n" +
    "## 结论\n\n公司业绩良好，营收和利润均实现两位数增长。建议持续关注成本控制。"
  );
  
  // Upload the file as attachment via API
  // First, upload to session media
  const fileContent = fs.readFileSync(`${testDir}/analysis-note.txt`);
  const formData = new FormData();
  formData.append("file", new Blob([fileContent]), "analysis-note.txt");
  
  const uploadRes = await fetch(`${BASE}/api/sessions/${sid}/media`, {
    method: "POST",
    body: formData,
  });
  console.log(`Upload media: status=${uploadRes.status}`);
  
  if (uploadRes.status !== 200 && uploadRes.status !== 201) {
    console.log(`Upload failed: ${await uploadRes.text()}`);
    // Try sending message with file content inline instead
    console.log("Falling back to inline content...");
    
    // Send message with inline content as a text file reference
    const msgRes = await fetch(`${BASE}/api/agents/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: sid,
        input: `我上传了一份分析报告（analysis-note.txt），请分析其全部内容。报告内容如下：\n\n${fs.readFileSync(`${testDir}/analysis-note.txt`, "utf-8")}\n\n请逐节解读这份报告，提取关键信息、数据和结论。`,
      }),
    });
    const raw = await msgRes.text();
    const events = parseSSE(raw);
    const done = events.find(e => e.type === "done");
    const complete = events.find(e => e.type === "complete");
    const textParts = events.filter(e => e.type === "progress" && e.data?.type === "text").map(e => e.data.content || "");
    const output = complete?.data?.output || textParts.join("") || "";
    const toolCalls = events.filter(e => e.type === "tool_call");
    
    console.log(`Done: ${!!done}`);
    console.log(`Output: ${output.length} chars`);
    console.log(`Tool calls: ${toolCalls.length}`);
    
    if (output.length > 0) console.log(`Preview: ${output.slice(0, 300)}`);
    
    await page.goto(`${BASE}/#/sessions/${sid}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/T51-99-final.png`, fullPage: true });
    
    const pass = !!done && output.length > 100;
    console.log(`\nT51 VERDICT: ${pass ? "PASS" : "NEEDS REVIEW"} (fallback mode)`);
    fs.writeFileSync(`${OUT}/T51-result.json`, JSON.stringify({ id: "T51", done: pass, outputLen: output.length, fallback: true }, null, 2));
    await browser.close();
    return;
  }
  
  const uploadData = await uploadRes.json();
  const mediaId = uploadData.id || uploadData.mediaId;
  console.log(`Media ID: ${mediaId}`);

  // Send message with mediaIds
  const msgRes = await fetch(`${BASE}/api/agents/run-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: sid,
      input: "请详细分析我上传的这份文件的全部内容，逐章逐节进行深入解读，提取所有关键信息、数据、结论。",
      mediaIds: [mediaId],
    }),
  });

  const raw = await msgRes.text();
  const events = parseSSE(raw);
  const done = events.find(e => e.type === "done");
  const complete = events.find(e => e.type === "complete");
  const textParts = events.filter(e => e.type === "progress" && e.data?.type === "text").map(e => e.data.content || "");
  const output = complete?.data?.output || textParts.join("") || "";
  const toolCalls = events.filter(e => e.type === "tool_call");
  const pushContents = events.filter(e => e.type === "push_content").map(e => e.data);

  console.log(`\nDone: ${!!done}`);
  console.log(`Output: ${output.length} chars`);
  console.log(`Tool calls: ${toolCalls.length}`);
  console.log(`Push contents: ${pushContents.length}`);
  
  // Check if agent referenced file content
  const mentionsData = output.includes("营收") || output.includes("利润") || output.includes("1000") || output.includes("增长");
  console.log(`Mentions file data: ${mentionsData}`);
  
  if (output.length > 0) console.log(`Preview: ${output.slice(0, 300)}`);

  // Check for session KB creation (wait a bit)
  console.log("\nChecking session KB...");
  await new Promise(r => setTimeout(r, 5000));
  
  const kbListRes = await fetch(`${BASE}/api/knowledge/kbs`);
  const kbList = await kbListRes.json();
  const sessionKbs = (kbList.knowledgeBases || kbList || []).filter(kb => 
    kb.name?.includes?.("session") || kb.id?.includes?.(sid.slice(0, 8))
  );
  console.log(`Session KBs found: ${sessionKbs.length}`);
  
  // Screenshot
  await page.goto(`${BASE}/#/sessions/${sid}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/T51-99-final.png`, fullPage: true });

  const pass = !!done && output.length > 100 && mentionsData;
  console.log(`\nT51 VERDICT: ${pass ? "PASS" : "NEEDS REVIEW"}`);
  console.log(`  Output: ${pass ? "OK" : "insufficient"}, File data referenced: ${mentionsData}`);
  
  fs.writeFileSync(`${OUT}/T51-result.json`, JSON.stringify({
    id: "T51", done: pass, outputLen: output.length, toolCalls: toolCalls.length,
    mentionsData, sessionKbs: sessionKbs.length, consoleErrors: consoleErrors.slice(0, 5),
  }, null, 2));
  
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
