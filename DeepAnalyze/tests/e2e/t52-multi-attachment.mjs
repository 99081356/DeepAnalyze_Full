/**
 * T52: 多文件混合附件上传——不同类型文件联合分析
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:21000";
const OUT = "/tmp/da-60test";
const KB = "9ae696db-3e54-4be4-be6c-b2ceae466fc7"; // lbctest

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

async function uploadMedia(sid, filePath, fileName) {
  const fileContent = fs.readFileSync(filePath);
  const formData = new FormData();
  formData.append("file", new Blob([fileContent]), fileName);
  const r = await fetch(`${BASE}/api/sessions/${sid}/media`, { method: "POST", body: formData });
  const data = await r.json();
  return { status: r.status, id: data.id || data.mediaId, data };
}

async function main() {
  console.log("=== T52: 多文件混合附件上传 ===");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

  // Create session with lbctest KB
  const sRes = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T52-multi-attachment" }) });
  const sData = await sRes.json();
  const sid = sData.id || sData.sessionId;
  console.log(`Session: ${sid}`);
  
  await fetch(`${BASE}/api/sessions/${sid}/scope`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kbScope: { kbIds: [KB] } }) });

  // Create 3 test files
  const testDir = "/tmp/da-t52-files";
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  
  // CSV
  fs.writeFileSync(`${testDir}/case-stats.csv`, "案件编号,当事人,涉案金额,状态,日期\nCASE-001,张三,500000,审理中,2025-03-15\nCASE-002,李四,320000,已结案,2025-02-20\nCASE-003,王五,780000,审理中,2025-04-01\nCASE-004,赵六,150000,已驳回,2025-01-10");
  
  // TXT
  fs.writeFileSync(`${testDir}/memo.txt`, "案件分析备忘录\n\n案件概述：本案涉及多起合同纠纷，当事人包括张三、李四、王五。\n关键证据：合同原件、转账记录、证人证言。\n法律依据：《民法典》第五编 合同法相关条款。\n争议焦点：合同效力认定、违约金计算标准。");
  
  // Markdown as "PDF" substitute
  fs.writeFileSync(`${testDir}/legal-ref.md`, "# 法律条文摘要\n\n## 民法典 第五编 合同\n\n### 第469条\n当事人订立合同，可以采用书面形式、口头形式或者其他形式。\n\n### 第577条\n当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。");

  // Upload all 3 files
  const mediaIds = [];
  for (const file of ["case-stats.csv", "memo.txt", "legal-ref.md"]) {
    const r = await uploadMedia(sid, `${testDir}/${file}`, file);
    console.log(`Upload ${file}: status=${r.status}, id=${r.id}`);
    if (r.id) mediaIds.push(r.id);
  }
  console.log(`Media IDs: ${mediaIds.length}`);

  // Send message referencing all files
  const msgRes = await fetch(`${BASE}/api/agents/run-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: sid,
      input: "我上传了三份补充材料（case-stats.csv、memo.txt、legal-ref.md），请你结合知识库中的案件信息，完成以下分析：\n1. 总结上传的三个文件各自的核心内容\n2. 将上传材料中的数据与知识库中对应文档进行交叉验证\n3. 给出基于所有材料的综合分析结论",
      mediaIds,
    }),
  });

  const raw = await msgRes.text();
  const events = parseSSE(raw);
  const done = events.find(e => e.type === "done");
  const complete = events.find(e => e.type === "complete");
  const textParts = events.filter(e => e.type === "progress" && e.data?.type === "text").map(e => e.data.content || "");
  const output = complete?.data?.output || textParts.join("") || "";
  const toolCalls = events.filter(e => e.type === "tool_call").map(e => e.data?.toolName);
  const pushContents = events.filter(e => e.type === "push_content").map(e => e.data);

  console.log(`\nDone: ${!!done}`);
  console.log(`Output: ${output.length} chars`);
  console.log(`Tool calls: ${toolCalls.length} [${[...new Set(toolCalls)].join(", ")}]`);
  console.log(`Push contents: ${pushContents.length}`);

  // Check content references
  const refsCSV = output.includes("案件") || output.includes("金额") || output.includes("张三");
  const refsMemo = output.includes("备忘录") || output.includes("合同纠纷") || output.includes("争议焦点");
  const refsKB = toolCalls.some(t => t && (t.includes("kb_search") || t.includes("expand")));
  
  console.log(`References CSV data: ${refsCSV}`);
  console.log(`References memo data: ${refsMemo}`);
  console.log(`Used KB tools: ${refsKB}`);

  if (output.length > 0) console.log(`\nPreview: ${output.slice(0, 500)}`);

  // Screenshot
  await page.goto(`${BASE}/#/sessions/${sid}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/T52-99-final.png`, fullPage: true });

  const pass = !!done && output.length > 200 && refsCSV;
  console.log(`\nT52 VERDICT: ${pass ? "PASS" : "NEEDS REVIEW"}`);
  console.log(`  Output: ${output.length}ch, CSV ref: ${refsCSV}, Memo ref: ${refsMemo}, KB tools: ${refsKB}`);
  
  fs.writeFileSync(`${OUT}/T52-result.json`, JSON.stringify({
    id: "T52", done: pass, outputLen: output.length, toolCalls: toolCalls.length,
    refsCSV, refsMemo, refsKB, pushContents: pushContents.length,
    consoleErrors: consoleErrors.slice(0, 5),
  }, null, 2));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
