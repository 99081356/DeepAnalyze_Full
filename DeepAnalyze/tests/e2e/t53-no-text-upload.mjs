/**
 * T53: 附件发起对话——仅上传文件不输入文字
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
  console.log("=== T53: 附件发起对话 ===");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

  // Create session without KB
  const sRes = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T53-no-text" }) });
  const sData = await sRes.json();
  const sid = sData.id || sData.sessionId;
  console.log(`Session: ${sid}`);

  // Create a test file
  const testDir = "/tmp/da-t53-files";
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(`${testDir}/report.txt`, "2026年Q2季度报告\n\n总收入：5800万元\n净利润：1200万元\n同比增长：18%\n主要增长来源：AI产品和云计算服务\n风险因素：市场竞争加剧、监管政策变化");

  // Upload file
  const fileContent = fs.readFileSync(`${testDir}/report.txt`);
  const formData = new FormData();
  formData.append("file", new Blob([fileContent]), "report.txt");
  const uploadRes = await fetch(`${BASE}/api/sessions/${sid}/media`, { method: "POST", body: formData });
  const uploadData = await uploadRes.json();
  const mediaId = uploadData.id || uploadData.mediaId;
  console.log(`Upload: status=${uploadRes.status}, mediaId=${mediaId}`);

  // Send with empty text, only mediaIds
  const msgRes = await fetch(`${BASE}/api/agents/run-stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: sid,
      input: "",  // Empty text, only attachment
      mediaIds: [mediaId],
    }),
  });

  console.log(`Message API: status=${msgRes.status}`);
  
  if (!msgRes.ok) {
    const errText = await msgRes.text();
    console.log(`Error: ${errText.slice(0, 300)}`);
  }

  const raw = await msgRes.text();
  const events = parseSSE(raw);
  const done = events.find(e => e.type === "done");
  const complete = events.find(e => e.type === "complete");
  const textParts = events.filter(e => e.type === "progress" && e.data?.type === "text").map(e => e.data.content || "");
  const output = complete?.data?.output || textParts.join("") || "";
  
  console.log(`Done: ${!!done}`);
  console.log(`Output: ${output.length} chars`);
  
  // Check if agent auto-analyzed the file
  const analyzedFile = output.includes("收入") || output.includes("利润") || output.includes("5800") || output.includes("增长");
  console.log(`Auto-analyzed file: ${analyzedFile}`);
  
  if (output.length > 0) console.log(`Preview: ${output.slice(0, 400)}`);

  // Screenshot
  await page.goto(`${BASE}/#/sessions/${sid}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/T53-99-final.png`, fullPage: true });

  const pass = !!done && output.length > 50 && analyzedFile;
  console.log(`\nT53 VERDICT: ${pass ? "PASS" : "NEEDS REVIEW"}`);
  
  fs.writeFileSync(`${OUT}/T53-result.json`, JSON.stringify({
    id: "T53", done: pass, outputLen: output.length, analyzedFile,
    sendOk: msgRes.status === 200, consoleErrors: consoleErrors.slice(0, 5),
  }, null, 2));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
