/**
 * T60: 端到端全链路——KB创建→上传→预处理→深度分析→证据链→报告→下载
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:21000";
const OUT = "/tmp/da-60test";
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

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; }
  catch { return { status: r.status, data: text }; }
}

async function uploadFile(kbId, filePath, fileName) {
  const fileContent = fs.readFileSync(filePath);
  const formData = new FormData();
  formData.append("file", new Blob([fileContent]), fileName);
  const r = await fetch(`${BASE}/api/knowledge/kbs/${kbId}/upload`, { method: "POST", body: formData });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; }
  catch { return { status: r.status, data: text }; }
}

async function main() {
  console.log("=== T60: 端到端全链路测试 ===");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

  // Step 1: Create KB
  console.log("\n--- Step 1: Create KB ---");
  const createRes = await api("POST", "/api/knowledge/kbs", { name: "T60-E2E全链路测试", description: "End-to-end lifecycle test" });
  const kbId = createRes.data?.id || createRes.data?.kbId;
  console.log(`  KB created: ${kbId}, status=${createRes.status}`);

  // Step 2: Upload test documents
  console.log("\n--- Step 2: Upload documents ---");
  const testDir = "/tmp/da-t60-files";
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  // Create diverse test files
  fs.writeFileSync(`${testDir}/legal-brief.txt`, 
    "民事起诉状\n\n原告：张某\n被告：李某\n\n诉讼请求：\n1. 判令被告偿还借款本金50万元\n2. 判令被告支付利息10万元\n3. 本案诉讼费用由被告承担\n\n事实与理由：\n2024年3月15日，被告向原告借款50万元，约定2024年12月31日前归还，年利率8%。借款到期后被告拒绝偿还。\n\n证据清单：\n1. 借款合同原件\n2. 转账凭证\n3. 微信聊天记录截图\n4. 证人王某某的证言");
  
  fs.writeFileSync(`${testDir}/evidence-notes.md`,
    "# 证据分析笔记\n\n## 证据1：借款合同\n- 签订日期：2024年3月15日\n- 借款金额：50万元\n- 还款期限：2024年12月31日\n- 利率：年利率8%\n\n## 证据2：转账凭证\n- 转账日期：2024年3月15日\n- 转账金额：50万元\n- 收款人：李某\n- 转账银行：中国工商银行\n\n## 证据3：微信记录\n- 记录时间：2024年11月-12月\n- 关键内容：被告承认欠款但表示资金周转困难\n\n## 证据4：证人证言\n- 证人：王某某\n- 证言要点：见证了借款合同签订过程");
  
  fs.writeFileSync(`${testDir}/case-timeline.csv`,
    "日期,事件,当事人,备注\n2024-03-15,签订借款合同,张某/李某,借款50万\n2024-03-15,银行转账,张某→李某,50万元\n2024-06-01,催款(微信),张某,李某承诺还款\n2024-11-15,催款(微信),张某,李某表示困难\n2024-12-31,借款到期,,被告未还款\n2025-01-10,发送律师函,张某,要求15日内还款\n2025-01-25,起诉,张某,被告李某");

  const uploads = [];
  for (const file of ["legal-brief.txt", "evidence-notes.md", "case-timeline.csv"]) {
    const r = await uploadFile(kbId, `${testDir}/${file}`, file);
    console.log(`  Upload ${file}: status=${r.status}`);
    uploads.push(r);
  }

  // Step 3: Wait for processing
  console.log("\n--- Step 3: Wait for processing ---");
  await new Promise(r => setTimeout(r, 8000));
  
  const docsRes = await api("GET", `/api/knowledge/kbs/${kbId}/documents`);
  const docs = docsRes.data?.documents || docsRes.data || [];
  console.log(`  Documents: ${Array.isArray(docs) ? docs.length : "N/A"}`);
  
  let allReady = true;
  if (Array.isArray(docs)) {
    for (const doc of docs) {
      console.log(`    ${doc.filename || doc.name}: status=${doc.status}`);
      if (doc.status !== "ready" && doc.status !== "completed") allReady = false;
    }
  }

  // Step 4: Create session and trigger analysis
  console.log("\n--- Step 4: Create session + analyze ---");
  const sRes = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T60-E2E-analysis" }) });
  const sData = await sRes.json();
  const sid = sData.id || sData.sessionId;
  console.log(`  Session: ${sid}`);
  
  await fetch(`${BASE}/api/sessions/${sid}/scope`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kbScope: { kbIds: [kbId] } }) });

  // Send analysis request
  const analysisPrompt = `请对知识库中的所有文档进行完整的司法证据链分析，要求：
1. 列出所有文档并分类（诉讼文书/证据材料/其他）
2. 构建完整的时间线
3. 梳理人物关系
4. 给出综合案件分析结论
5. 使用 push_content 推送分析报告`;

  const msgRes = await fetch(`${BASE}/api/agents/run-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: sid, input: analysisPrompt }),
  });

  const raw = await msgRes.text();
  const events = parseSSE(raw);
  const done = events.find(e => e.type === "done");
  const complete = events.find(e => e.type === "complete");
  const textParts = events.filter(e => e.type === "progress" && e.data?.type === "text").map(e => e.data.content || "");
  const output = complete?.data?.output || textParts.join("") || "";
  const toolCalls = events.filter(e => e.type === "tool_call").map(e => e.data?.toolName);
  const pushContents = events.filter(e => e.type === "push_content").map(e => e.data);
  
  console.log(`  Done: ${!!done}`);
  console.log(`  Output: ${output.length} chars`);
  console.log(`  Tool calls: ${toolCalls.length} [${[...new Set(toolCalls)].join(", ")}]`);
  console.log(`  Push contents: ${pushContents.length}`);
  
  const hasAnalysis = output.includes("张某") || output.includes("李某") || output.includes("借款") || output.includes("证据");
  console.log(`  Has case analysis: ${hasAnalysis}`);

  // Step 5: Verify KB search
  console.log("\n--- Step 5: KB search verification ---");
  const searchRes = await api("GET", `/api/knowledge/${kbId}/search?query=借款&topK=5`);
  const searchResults = searchRes.data?.results || searchRes.data || [];
  console.log(`  Search '借款': ${Array.isArray(searchResults) ? searchResults.length : 0} results`);

  // Step 6: Screenshot
  await page.goto(`${BASE}/#/sessions/${sid}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/T60-99-analysis.png`, fullPage: true });

  // Step 7: Delete KB
  console.log("\n--- Step 7: Delete KB ---");
  const delRes = await api("DELETE", `/api/knowledge/kbs/${kbId}`);
  console.log(`  Delete KB: status=${delRes.status}`);
  
  // Verify deletion
  const verifyRes = await api("GET", `/api/knowledge/kbs/${kbId}`);
  console.log(`  Verify 404: ${verifyRes.status}`);

  // Summary
  const kbCreated = createRes.status === 200 || createRes.status === 201;
  const allUploaded = uploads.every(u => u.status === 200 || u.status === 201);
  const analysisOk = !!done && hasAnalysis;
  const kbDeleted = verifyRes.status === 404;

  const pass = kbCreated && allUploaded && analysisOk && kbDeleted;
  console.log(`\nT60 VERDICT: ${pass ? "PASS" : "NEEDS REVIEW"}`);
  console.log(`  KB create: ${kbCreated}, Upload: ${allUploaded}, Analysis: ${analysisOk}, Delete: ${kbDeleted}`);
  console.log(`  Console errors: ${consoleErrors.length}`);
  
  fs.writeFileSync(`${OUT}/T60-result.json`, JSON.stringify({
    id: "T60", done: pass,
    kbCreated, allUploaded, docCount: Array.isArray(docs) ? docs.length : 0,
    allReady, analysisOk, pushCount: pushContents.length,
    kbDeleted, consoleErrors: consoleErrors.slice(0, 5),
    outputLen: output.length, toolCalls: toolCalls.length,
  }, null, 2));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
