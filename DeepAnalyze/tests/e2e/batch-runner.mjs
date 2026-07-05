/**
 * Sequential 60-Test Batch Runner
 * Runs each test, captures results, screenshots, logs
 * Saves incremental results to /tmp/da-60test/
 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:21000";
const OUT = "/tmp/da-60test";
const BIGTEST = "60346710-913d-4b54-b742-499da76cd85b";
const LBCTEST = "9ae696db-3e54-4be4-be6c-b2ceae466fc7";
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// Parse CLI args
const args = process.argv.slice(2);
let startN = 1, endN = 60;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--start" && args[i+1]) { startN = parseInt(args[i+1]); i++; }
  if (args[i] === "--end" && args[i+1]) { endN = parseInt(args[i+1]); i++; }
}

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
    await fetch(`${BASE}/api/sessions/${sid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: { kbIds } }) });
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
    const pushContents = events.filter(e => e.type === "push_content").map(e => e.data);
    const done = events.find(e => e.type === "done");
    const complete = events.find(e => e.type === "complete");
    const fullOutput = complete?.data?.output || textParts.join("") || "";
    return { fullOutput, toolCalls, pushContents, done: !!done, elapsed: Date.now() - t0, rawLen: raw.length };
  } catch (e) { return { error: e.message, elapsed: Date.now() - t0 }; }
  finally { clearTimeout(timer); }
}

async function screenshot(page, sid, file) {
  try {
    await page.goto(`${BASE}/?session=${sid}`, { waitUntil: "domcontentloaded" });
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(500);
      const has = await page.evaluate(() => {
        const els = document.querySelectorAll('[class*="markdown"],[class*="message"],[class*="content"],article,pre,[class*="push"]');
        for (const el of els) if (el.textContent && el.textContent.trim().length > 30) return true;
        return false;
      });
      if (has) break;
    }
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
  } catch (e) { /* ignore screenshot errors */ }
}

function score(testId, res) {
  const issues = [];
  let s = 0, max = 0;

  max += 25;
  if (res.error) { issues.push(`Error: ${res.error}`); }
  else if (res.done) { s += 25; }
  else if ((res.fullOutput?.length || 0) > 100) { s += 15; issues.push("No done signal"); }
  else { issues.push("Incomplete"); }

  const tc = {};
  for (const t of (res.toolCalls || [])) tc[t.name] = (tc[t.name] || 0) + 1;

  const toolCount = (res.toolCalls || []).length;
  max += 20;
  if (toolCount >= 3) s += 20;
  else if (toolCount >= 1) s += 10;

  const outLen = (res.fullOutput || "").length;
  max += 20;
  if (outLen >= 500) s += 20;
  else if (outLen >= 50) s += 10;

  // Push content check
  const pcs = res.pushContents || [];
  max += 15;
  if (pcs.length > 0 && pcs.every(p => (p.data || "").length > 0)) s += 15;
  else if (pcs.length > 0) { s += 8; issues.push("Some push_content empty"); }

  // Duplicate push check
  const pcTitles = pcs.map(p => p.title);
  const dupes = pcTitles.filter((t, i) => pcTitles.indexOf(t) !== i);
  if (dupes.length > 0) issues.push(`Duplicate push: ${dupes.join(", ")}`);

  // Time check
  max += 10;
  if (res.elapsed && res.elapsed < 600000) s += 10;
  else if (res.elapsed) s += 5;

  max += 10;
  s += 10; // participation

  const pass = s >= max * 0.5 && !res.error;
  return { score: s, max, pass, issues, toolBreakdown: tc };
}

// ═══ TEST CASES ═══
const TESTS = {
  T02: { name: "lbctest Judicial Analysis", kb: LBCTEST, prompt: `请完成以下分析任务：\n1. 详细分析整个案件，按人、时、地、事、物整理关键信息\n2. 还原整个案件的完整时间线\n3. 梳理资金关系和流向\n4. 提供量刑标准和法律指导意见\n5. 使用司法证据链标准 skill 输出符合司法证据链要求的文档报告`, timeout: 900000 },
  T03: { name: "Ultra-Long Single Doc Analysis", kb: BIGTEST, prompt: `请从知识库中选择"5241自杀派对"这个剧本杀游戏，对每个角色的剧本、线索进行深度分析。要求：列出所有角色信息、分析每条线索、构建完整推理链。`, timeout: 900000 },
  T04: { name: "Multi-KB Cross Analysis", kb: [BIGTEST, LBCTEST], prompt: `请同时分析 bigtest 和 lbctest 两个知识库。对比两个知识库的文档类型分布和内容主题差异。如果 bigtest 中有法律相关的剧本杀内容，与 lbctest 中的真实诉讼文书做对比。`, timeout: 900000 },
  T05: { name: "Academic Paper Evolution", kb: BIGTEST, prompt: `请分析知识库中的所有学术论文。要求：每篇论文的核心贡献、引用关系和技术演进路径、方法论对比、未来研究方向预测。输出结构化分析报告。`, timeout: 900000 },
  T06: { name: "Anti-Hallucination Numbers", kb: BIGTEST, prompt: `请从知识库中找出所有涉及金额、数量、日期、百分比等数字的内容，整理成结构化表格。每个数字必须标注来源文档名称。不允许出现原文中不存在的数字。`, timeout: 600000 },
  T07: { name: "Table Data Analysis", kb: BIGTEST, prompt: `请详细分析知识库中的Excel表格数据。要求：整体表格描述、每列统计分析、关键发现、数据质量评估。所有统计数字必须通过 run_sql 或 bash(python3) 实际计算。`, timeout: 600000 },
  T08: { name: "Multimodal Content Analysis", kb: BIGTEST, prompt: `请分析知识库中的所有图片、音频和视频文件。用 expand 获取每张图片的VLM描述，检查描述质量。如果描述不完整，使用 tool_discover 获取 image_analysis 重新分析。`, timeout: 600000 },
  T09: { name: "Web Search General Agent", kb: null, prompt: `请根据 DeepSeek、Qwen、Kimi、MiniMax 等国产模型的最新技术报告，写一份详细的AI发展现状技术报告。完成后编写一份综合PPT大纲。`, timeout: 600000 },
  T10: { name: "Consistency 3x", kb: LBCTEST, prompt: `请列出本案件涉及的所有资金转账记录，包括金额、日期、转出方、接收方。按时间顺序排列。`, multiRun: 3, timeout: 600000 },
  T11: { name: "Parallel Sub-Agents", kb: BIGTEST, prompt: `请使用 workflow_run parallel 模式，将知识库中的所有文档按类型分为5组，每组分配一个子Agent进行深度分析。所有子Agent完成后，主Agent汇总输出综合分析报告。`, timeout: 900000 },
  T12: { name: "Pipeline Serial Chain", kb: LBCTEST, prompt: `请使用 workflow_run pipeline 模式按串行步骤分析案件：信息收集 → 事实提取 → 证据链构建 → 法律分析 → 报告生成。`, timeout: 900000 },
  T13: { name: "Council Cross Review", kb: BIGTEST, prompt: `请使用 council 模式安排3个不同视角的子Agent分析知识库中的学术论文：技术评估者、应用分析师、批判审阅者。第一轮完成后进行交叉审阅。`, timeout: 900000 },
  T14: { name: "Graph DAG Dependencies", kb: BIGTEST, prompt: `使用 graph 模式分析知识库。设置：基础调研Agent(无依赖) → 论文分析+剧本杀分析+多媒体分析(并行,依赖基础调研) → 综合报告(依赖全部)。`, timeout: 900000 },
  T15: { name: "Long Tool Chain 50+", kb: BIGTEST, prompt: `请逐个阅读知识库中所有PDF论文的L1内容，对每篇论文输出：标题和作者、核心方法、关键指标、主要局限性。每篇必须先 expand 获取 L1。`, timeout: 900000 },
  T16: { name: "Main+Sub Hybrid", kb: LBCTEST, prompt: `分析这个案件。首先你搜索和阅读关键文档形成初步理解。然后派遣2个子Agent分别分析不同的证据组。子Agent完成后，你综合所有信息输出最终分析。`, timeout: 900000 },
  T17: { name: "Partial Failure Tolerance", kb: BIGTEST, prompt: `请使用 workflow_run parallel 模式分成5个子Agent分析知识库的不同部分：PDF论文、剧本杀、图片、Excel表格、音频视频。如果某个子Agent失败，其他应继续。`, timeout: 900000 },
  T18: { name: "Nested Workflow", kb: BIGTEST, prompt: `请将知识库按主题分为3大组，每组使用一个子Agent进行分析。如果论文太多，子Agent应进一步派遣更细粒度的分析任务。`, timeout: 900000 },
  T19: { name: "Super-Long 100+ Steps", kb: [BIGTEST, LBCTEST], prompt: `请完成以下综合任务：1.浏览bigtest文档分类 2.展开论文分析 3.剧本杀推理 4.浏览lbctest文档 5.提取时间线 6.构建证据链 7.交叉对比 8.生成报告`, timeout: 900000 },
  T20: { name: "Cancel and Resume", kb: BIGTEST, prompt: `请对知识库进行全面分析。`, resumeWith: "请简单告诉我知识库里有多少文档？主要有哪些类型？", timeout: 600000 },
  T21: { name: "Skill Auto-Activation", kb: BIGTEST, prompt: `请对知识库进行全面知识库分析并生成分析报告。`, timeout: 600000 },
  T22_multi: { name: "Skill Create-Verify-Invoke", kb: null, turns: [
    `请帮我创建一个新的skill，名为"市场分析助手"，用于分析市场数据和竞争格局。要求：1)先搜索相关市场数据 2)创建竞品对比表格 3)输出SWOT分析。保存到数据库。`,
    `验证刚创建的skill，使用 list_skills 检查是否在列表中。`,
    `请使用这个skill分析当前中国新能源汽车市场现状。`,
  ], timeout: 600000 },
  T23_multi: { name: "Skill Modify & Compare", kb: BIGTEST, turns: [
    `使用"报告生成"skill对知识库中的论文生成分析报告。`,
    `修改"报告生成"skill，增加要求"每个分析点都必须有数据支撑，禁止无数据的主观判断"。`,
    `再次使用修改后的"报告生成"skill生成分析报告。`,
  ], timeout: 600000 },
  T24: { name: "Evidence Chain Skill", kb: LBCTEST, prompt: `请使用"evidence-chain" skill 分析本案证据链完整性。收集所有证据材料，构建证据链关系图，评估完整性，生成带原文引用链接的报告。`, timeout: 900000 },
  T25: { name: "Timeline + Entity Network", kb: LBCTEST, prompt: `请分别使用"timeline-reconstruction"和"entity-network"技能分析案件。先构建时间线，再梳理人物关系。最后综合输出全景分析。`, timeout: 900000 },
  T26: { name: "Skill Hub Search", kb: null, prompt: `请搜索 Skill Hub 中与"数据分析"相关的技能，选择最合适的一个安装并使用。`, timeout: 300000 },
  T27: { name: "Skill Auto-Evolution", kb: BIGTEST, prompt: `请分析知识库中的论文，根据分析过程中遇到的困难自动优化分析skill。记录优化差异。`, timeout: 600000 },
  T28: { name: "Plugin Enable/Disable", kb: LBCTEST, prompt: `请先禁用 judicial-analysis 插件，然后尝试进行案件分析。观察分析结果有什么不同。然后重新启用插件再次分析。`, timeout: 600000 },
  T29: { name: "KB Full Lifecycle", kb: null, prompt: `请帮我创建一个新的知识库，名称为"测试知识库"。然后告诉我这个新知识库的ID。`, timeout: 120000 },
  T30: { name: "Cross-KB Search", kb: [BIGTEST, LBCTEST], prompt: `请同时搜索两个知识库中包含"证据"关键词的内容，对比两个知识库的搜索结果。`, timeout: 300000 },
  T31: { name: "Deep Preprocessing Check", kb: BIGTEST, prompt: `请检查知识库中所有文档的预处理状态。对每种文件类型分别查看L0、L1层内容完整性。报告哪些文档的预处理可能存在问题。`, timeout: 600000 },
  T32: { name: "Document Reprocess", kb: BIGTEST, prompt: `请列出知识库中所有图片类型的文档，检查VLM描述质量。如果VLM描述为空或占位符，用 image_analysis 重新分析。`, timeout: 300000 },
  T33: { name: "Search Modes Compare", kb: BIGTEST, prompt: `请分别用 kb_search、doc_grep、bash(grep) 三种方式搜索知识库中包含"推理"关键词的内容。对比结果数量和覆盖范围。`, timeout: 300000 },
  T34: { name: "Search Saturation", kb: BIGTEST, prompt: `请对知识库进行极其全面的搜索。使用多种关键词反复搜索，直到搜索结果开始大量重复。`, timeout: 300000 },
  T35: { name: "Anchor System", kb: BIGTEST, prompt: `请展开知识库中第一个PDF论文的L2内容，然后尝试使用锚点定位到特定章节。`, timeout: 300000 },
  T36: { name: "KB CRUD Stress", kb: BIGTEST, prompt: `请执行：1.浏览分类 2.每个分类文档数 3.前10个文档展开L1 4.搜索5个关键词 5.统计各类型文档数`, timeout: 300000 },
  T37: { name: "MCP Server Lifecycle", kb: null, prompt: `请列出当前所有可用的MCP服务器，检查连接状态。尝试使用web_search搜索"2026年AI最新进展"。`, timeout: 300000 },
  T38: { name: "Model Switching", kb: BIGTEST, prompt: `请分析知识库中的第一个文档，给出简要摘要。`, timeout: 180000 },
  T39: { name: "Multi-Role Models", kb: BIGTEST, prompt: `请使用workflow_run安排3个子Agent使用不同角色分析同一个文档：技术专家、普通读者、批评家。`, timeout: 300000 },
  T40: { name: "Provider Circuit Breaker", kb: BIGTEST, prompt: `请连续搜索知识库10次，每次用不同关键词。观察系统在高频请求下的行为。`, timeout: 300000 },
  T41: { name: "Frontend Streaming", kb: BIGTEST, prompt: `请写一篇关于知识库内容概览的详细报告，包括文档分类、每类数量、主题分析。要求输出足够长以便观察流式渲染。`, timeout: 300000 },
  T42: { name: "Tool Call Cards", kb: BIGTEST, prompt: `请对知识库执行：搜索"推理"、展开第一个结果L1、用doc_grep搜"时间线"、查看wiki分类。`, timeout: 300000 },
  T43: { name: "Push Content Cards", kb: BIGTEST, prompt: `请分析知识库中的论文部分，生成3个push_content卡片：论文概览、技术演进分析、未来研究方向。每个不少于500字。`, timeout: 300000 },
  T44: { name: "Multi-Panel Switch", kb: BIGTEST, prompt: `请分析知识库并生成报告。展示工具调用面板和报告面板的交互。`, timeout: 300000 },
  T45: { name: "Compaction Info Retention", kb: BIGTEST, prompt: `请展开知识库前20个文档获取L1内容，列出每个文档的ID和摘要。确保所有文档ID都被完整保留。`, timeout: 900000 },
  T46: { name: "SSE Reconnect", kb: BIGTEST, prompt: `请分析知识库中的剧本杀内容，输出详细的角色分析和线索梳理。`, timeout: 300000 },
  T47: { name: "Large File Upload", kb: null, prompt: `请告诉我如何上传文件到知识库，以及支持哪些文件类型。`, timeout: 120000 },
  T48: { name: "Concurrent Session", kb: BIGTEST, prompt: `请搜索知识库中包含"分析"关键词的内容。`, timeout: 180000 },
  T49: { name: "Error Recovery", kb: BIGTEST, prompt: `请先搜索一个不存在的超长关键词"zzzzzzzzzzzz nonexistent 12345"，然后正常搜索"分析"验证恢复。`, timeout: 180000 },
  T50: { name: "Full Chain Stress", kb: BIGTEST, prompt: `请执行完整流程：浏览分类→搜索"论文"→展开前3个结果→对比内容→生成摘要→推送分析报告卡片。`, timeout: 300000 },
  T51_multi: { name: "Multi-Turn Context", kb: BIGTEST, turns: [
    "请搜索知识库中关于剧本杀的文档，列出所有剧本杀的名称。",
    "第二个剧本杀叫什么名字？有多少个文档？",
    "请展开第一个剧本杀的前3个文档的L1内容。",
  ], timeout: 300000 },
  T52: { name: "Attachment Inline Parse", kb: null, prompt: `我接下来会上传一个文件请你分析。请告诉我你支持哪些文件类型的分析。`, timeout: 120000 },
  T53: { name: "Report Generation", kb: BIGTEST, prompt: `请使用报告生成skill生成一份关于知识库论文部分的分析报告。包含：摘要、方法论分析、实验结果对比、结论。`, timeout: 600000 },
  T54: { name: "Bash First-Class", kb: BIGTEST, prompt: `请使用 bash 工具执行 python3 脚本来统计知识库中文档类型分布。然后用 grep 搜索磁盘文件。`, timeout: 300000 },
  T55: { name: "Long Output Continuation", kb: BIGTEST, prompt: `请对知识库中的每个剧本杀逐个进行详细分析，每个不少于3000字：角色分析、线索解读、推理过程、故事还原。`, timeout: 900000 },
  T56: { name: "Empty KB Handling", kb: null, prompt: `请分析我的知识库中的所有文档。`, timeout: 120000 },
  T57: { name: "Tool Discovery", kb: BIGTEST, prompt: `请使用 tool_discover 工具查找 image_analysis 工具，然后用它分析知识库中的第一张图片。`, timeout: 300000 },
  T58: { name: "Compaction Trigger", kb: BIGTEST, prompt: `请展开知识库中所有文档的L1内容，对每个文档进行简要分析。`, timeout: 900000 },
  T59: { name: "Multi-Language", kb: BIGTEST, prompt: `Please analyze the documents in the knowledge base and provide a brief summary in English of the main categories and themes found.`, timeout: 300000 },
  T60: { name: "System Health Final", kb: BIGTEST, prompt: `请执行验证：1.搜索知识库 2.展开一个文档L1 3.用push_content推送测试卡片 4.总结系统健康状态`, timeout: 300000 },
};

async function runOne(browser, testId, def) {
  const page = await browser.newPage();
  const result = { id: testId, name: def.name, passed: false, score: 0, details: [], issues: [], elapsed: 0 };

  try {
    if (def.multiRun) {
      // Multi-run consistency test
      const outputs = [];
      const allTC = [];
      for (let run = 0; run < def.multiRun; run++) {
        const sid = await mkSession(def.kb, `${testId}-run${run}`);
        result.details.push(`Run ${run+1}: ${sid}`);
        const res = await sendMsg(sid, def.prompt, def.timeout);
        if (res.error) { result.details.push(`  ERR: ${res.error}`); result.issues.push(res.error); outputs.push(""); continue; }
        outputs.push(res.fullOutput || "");
        allTC.push(...res.toolCalls);
        result.details.push(`  Done=${res.done} Tools=${res.toolCalls.length} Out=${(res.fullOutput||"").length}ch`);
        await screenshot(page, sid, `${testId}-run${run}.png`);
      }
      const tc = {};
      for (const t of allTC) tc[t.name] = (tc[t.name] || 0) + 1;
      result.toolBreakdown = tc;
      result.totalToolCalls = allTC.length;
      result.outputLens = outputs.map(o => o.length);
      // Simple consistency: extract numbers
      const nums = outputs.map(o => (o.match(/\d+[\.\d]*/g) || []).sort().slice(0, 20).join(","));
      result.consistent = nums.every(n => n === nums[0]);
      result.details.push(`Number consistency: ${result.consistent ? "YES" : "DIFFERENT"}`);
      result.passed = outputs.filter(o => o.length > 0).length === def.multiRun;

    } else if (def.turns) {
      // Multi-turn test
      const sid = await mkSession(def.kb, `${testId}-mt`);
      result.details.push(`Session: ${sid}`);
      const allTC = [];
      let allOut = "";
      for (let i = 0; i < def.turns.length; i++) {
        result.details.push(`Turn ${i+1}: "${def.turns[i].slice(0, 50)}..."`);
        const res = await sendMsg(sid, def.turns[i], def.timeout);
        if (res.error) { result.details.push(`  ERR: ${res.error}`); result.issues.push(res.error); continue; }
        allTC.push(...res.toolCalls);
        allOut += (allOut ? "\n" : "") + (res.fullOutput || "");
        result.details.push(`  Done=${res.done} Tools=${res.toolCalls.length} Out=${(res.fullOutput||"").length}ch`);
      }
      const tc = {};
      for (const t of allTC) tc[t.name] = (tc[t.name] || 0) + 1;
      result.toolBreakdown = tc;
      result.totalToolCalls = allTC.length;
      result.outputLen = allOut.length;
      await screenshot(page, sid, `${testId}-final.png`);
      result.passed = allTC.length >= def.turns.length && allOut.length > 100;

    } else if (def.resumeWith) {
      // Cancel+Resume test
      const sid = await mkSession(def.kb, `${testId}-cr`);
      result.details.push(`Session: ${sid}`);
      const r1 = await sendMsg(sid, def.prompt, def.timeout);
      result.details.push(`Run1: Done=${r1.done} Tools=${r1.toolCalls?.length || 0}`);
      await screenshot(page, sid, `${testId}-run1.png`);
      const r2 = await sendMsg(sid, def.resumeWith, 180000);
      if (r2.error) { result.issues.push(r2.error); }
      else { result.details.push(`Run2: Done=${r2.done} Tools=${r2.toolCalls?.length || 0} Out=${(r2.fullOutput||"").length}ch`); }
      await screenshot(page, sid, `${testId}-run2.png`);
      result.passed = r2.done && !r2.error;

    } else {
      // Standard single-run
      const sid = await mkSession(def.kb, testId);
      result.details.push(`Session: ${sid}`);
      await screenshot(page, sid, `${testId}-00.png`);

      const res = await sendMsg(sid, def.prompt, def.timeout);
      if (res.error) {
        result.details.push(`ERROR: ${res.error}`);
        result.issues.push(res.error);
        result.elapsed = res.elapsed;
      } else {
        result.elapsed = res.elapsed;
        result.details.push(`Done: ${res.done}`);
        result.details.push(`Output: ${(res.fullOutput||"").length}ch`);
        result.details.push(`Time: ${(res.elapsed/1000).toFixed(1)}s`);
        result.details.push(`Tools: ${res.toolCalls.length}`);
        const tc = {};
        for (const t of res.toolCalls) tc[t.name] = (tc[t.name] || 0) + 1;
        result.toolBreakdown = tc;
        result.details.push(`Breakdown: ${Object.entries(tc).map(([k,v])=>`${k}=${v}`).join(", ")}`);
        result.details.push(`Push contents: ${res.pushContents.length}`);
        for (const pc of res.pushContents) {
          const dl = (pc.data || "").length;
          result.details.push(`  PC "${pc.title}": ${dl}ch ${dl > 0 ? "OK" : "EMPTY"}`);
          if (dl === 0) result.issues.push(`Empty push: ${pc.title}`);
        }
        // Dupe check
        const titles = res.pushContents.map(p => p.title);
        const dupes = titles.filter((t,i) => titles.indexOf(t) !== i);
        if (dupes.length > 0) result.issues.push(`Duplicate push titles: ${[...new Set(dupes)].join(", ")}`);

        result.totalToolCalls = res.toolCalls.length;
        result.outputLen = (res.fullOutput || "").length;
        result.pushCount = res.pushContents.length;
        result.pushDataLens = res.pushContents.map(p => (p.data || "").length);

        await screenshot(page, sid, `${testId}-99.png`);

        const sc = score(testId, res);
        result.score = sc.score;
        result.maxScore = sc.max;
        result.issues.push(...sc.issues);
        result.passed = sc.pass;
      }
    }
  } catch (e) {
    result.details.push(`EXCEPTION: ${e.message}`);
    result.issues.push(e.message);
  }

  await page.close();
  return result;
}

// ═══ MAIN ═══
async function main() {
  console.log("=".repeat(70));
  console.log("DeepAnalyze 60-Test Batch Runner");
  console.log(`Range: T${String(startN).padStart(2,"0")} - T${String(endN).padStart(2,"0")}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log("=".repeat(70));

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "zh-CN" });
  const origNewPage = browser.newPage.bind(browser);
  browser.newPage = () => ctx.newPage();

  // Load existing results
  let allResults = [];
  try { allResults = JSON.parse(fs.readFileSync(`${OUT}/all-results.json`, "utf-8")); } catch {}

  // Build test list
  const testList = [];
  for (let n = startN; n <= endN; n++) {
    const id = `T${String(n).padStart(2, "0")}`;
    // Check multi-turn variants
    const multiId = `${id}_multi`;
    if (TESTS[multiId]) { testList.push({ id: multiId, def: TESTS[multiId] }); }
    else if (TESTS[id]) { testList.push({ id, def: TESTS[id] }); }
    else { console.log(`[SKIP] ${id}: Not defined`); }
  }

  for (const { id, def } of testList) {
    // Skip if already run
    if (allResults.find(r => r.id === id)) {
      console.log(`[SKIP] ${id}: Already run`);
      continue;
    }

    console.log(`\n${"─".repeat(70)}`);
    console.log(`[${id}] ${def.name}`);
    console.log(`${"─".repeat(70)}`);

    const t0 = Date.now();
    const result = await runOne(browser, id, def);
    result.totalElapsed = Date.now() - t0;
    allResults.push(result);

    const status = result.passed ? "PASS" : "FAIL";
    console.log(`\n[${status}] ${id}: ${def.name}`);
    console.log(`  Score: ${result.score}/${result.maxScore || "N/A"}`);
    console.log(`  Time: ${(result.totalElapsed/1000).toFixed(1)}s`);
    for (const d of result.details.slice(-6)) console.log(`  ${d}`);
    if (result.issues.length > 0) {
      console.log(`  Issues (${result.issues.length}):`);
      for (const i of result.issues) console.log(`    ! ${i}`);
    }

    // Save incremental
    fs.writeFileSync(`${OUT}/all-results.json`, JSON.stringify(allResults, null, 2));
  }

  await browser.close();

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  let p = 0, f = 0;
  for (const r of allResults) { r.passed ? p++ : f++; console.log(`[${r.passed?"PASS":"FAIL"}] ${r.id}: ${r.name} (${(r.totalElapsed/1000||0).toFixed(1)}s)`); }
  console.log(`\nTotal: ${allResults.length} | Pass: ${p} | Fail: ${f} | Rate: ${(p/allResults.length*100).toFixed(1)}%`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
