/**
 * Skill Scheduling End-to-End Test
 *
 * Verifies that the skill system correctly triggers (or does not trigger)
 * skills based on user input, after the recent skill optimization
 * (dedup, whenToUse, budget control, plugin sync, garbage cleanup).
 *
 * Tests T1-T8 per the test plan. Each test sends a message via the
 * run-stream SSE API and inspects tool_call events for skill_invoke.
 *
 * Run with: npx tsx tests/skill-scheduling-e2e-test.ts
 *
 * Requires: DA server running at http://localhost:21000
 */

const BASE = "http://localhost:21000";
const BIGTEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

// Per-test timeout (ms). We mainly need the skill_invoke DECISION, which
// happens in the first 1-3 turns. Skills that run long (evidence-chain etc.)
// will be interrupted by this timeout — but the invocation has already been
// captured, so the test verdict is still valid.
const PER_TEST_TIMEOUT = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string;
  data: any;
}

interface SkillInvokeRecord {
  skillName: string;
  mode: string;
  input: string;
}

interface TestCase {
  id: string;
  input: string;
  /** Expected skill name that SHOULD trigger. null = no skill expected. */
  expectedSkill: string | null;
  /** Skills that are also acceptable (for fuzzy positive cases). */
  acceptableSkills?: string[];
  /** Skills that MUST NOT trigger (negative assertions). */
  forbiddenSkills?: string[];
  needsKb: boolean;
  goal: string;
}

interface TestResult {
  case: TestCase;
  invokedSkills: SkillInvokeRecord[];
  allToolCalls: string[];
  contentSnippet: string;
  timedOut: boolean;
  error?: string;
  passed: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

const TESTS: TestCase[] = [
  {
    id: "T1",
    input: "帮我做一个关于AI发展趋势的PPT，5页",
    expectedSkill: "PPT生成",
    needsKb: false,
    goal: "正向：easy case 触发 PPT生成",
  },
  {
    id: "T2",
    input: "深度调研大语言模型在医疗领域的应用",
    expectedSkill: "deep-research",
    needsKb: false,
    goal: "正向：builtin whenToUse 触发",
  },
  {
    id: "T3",
    input: "你好，介绍一下你自己",
    expectedSkill: null,
    needsKb: false,
    goal: "负向：通用对话不触发任何 skill",
  },
  {
    id: "T4",
    input: "总结一下知识库里所有文档的要点",
    expectedSkill: null,
    acceptableSkills: ["文档摘要", "全面知识库分析", "报告生成", "progressive-report"],
    forbiddenSkills: ["evidence-chain", "deep-case-analysis", "知识库预处理", "entity-network", "timeline-reconstruction"],
    needsKb: true,
    goal: "负向：高成本司法 skill 不误触发",
  },
  {
    id: "T5",
    input: "从文档中提取人物名称和组织机构",
    expectedSkill: "实体提取",
    forbiddenSkills: ["entity-network"],
    needsKb: true,
    goal: "边缘：实体提取 vs entity-network 区分",
  },
  {
    id: "T6",
    input: "请对案件材料进行证据链分析",
    expectedSkill: "evidence-chain",
    needsKb: true,
    goal: "正向：司法 skill 触发",
  },
  {
    id: "T7",
    input: "根据案件文档构建完整时间线",
    expectedSkill: "timeline-reconstruction",
    needsKb: true,
    goal: "正向：司法 skill 触发",
  },
  {
    id: "T8",
    input: "遇到bug，代码结果和预期不一致，需要系统化排查",
    expectedSkill: "systematic-debugging",
    needsKb: false,
    goal: "正向：builtin whenToUse 触发",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createSession(title: string): Promise<string> {
  const resp = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!resp.ok) {
    throw new Error(`Failed to create session: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.id;
}

async function deleteSession(id: string): Promise<void> {
  await fetch(`${BASE}/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

/**
 * Send a message via run-stream and collect SSE events.
 * Stops early when a "complete" event is seen or the expected skill
 * has been invoked (and acknowledged by a tool_result).
 */
async function runStream(
  sessionId: string,
  input: string,
  scope: Record<string, unknown> | undefined,
  expectedSkill: string | null,
  timeoutMs: number,
): Promise<{ events: SSEEvent[]; fullContent: string; timedOut: boolean; error?: string }> {
  const url = `${BASE}/api/agents/run-stream`;
  const body: Record<string, unknown> = { sessionId, input };
  if (scope) body.scope = scope;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const events: SSEEvent[] = [];
  let fullContent = "";
  let timedOut = false;
  let error: string | undefined;

  // Track whether we've seen the expected skill_invoke get a tool_result,
  // so we can stop early on positive tests.
  let expectedSkillInvoked = false;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      return { events: [{ event: "error", data: text }], fullContent: "", timedOut: false, error: `HTTP ${res.status}: ${text}` };
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent = "";
      let currentData = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          currentData = line.slice(6);
          if (currentEvent) {
            let parsed: any;
            try {
              parsed = JSON.parse(currentData);
            } catch {
              parsed = currentData;
            }
            events.push({ event: currentEvent, data: parsed });

            if (currentEvent === "content_delta") {
              fullContent += parsed.delta || parsed.content || "";
            }

            // Early-stop: task completed
            if (currentEvent === "complete") {
              clearTimeout(timer);
              return { events, fullContent, timedOut: false };
            }

            // Early-stop: expected skill invoked + acknowledged
            if (expectedSkill && currentEvent === "tool_call" &&
                parsed.toolName === "skill_invoke") {
              const sn = parsed.input?.skill_name ?? parsed.input?.name;
              if (sn === expectedSkill) {
                expectedSkillInvoked = true;
              }
            }
            // Once the expected skill's invocation is followed by ANY tool_result
            // for skill_invoke, the decision is locked in — stop early.
            if (expectedSkillInvoked && currentEvent === "tool_result" &&
                parsed.toolName === "skill_invoke") {
              clearTimeout(timer);
              return { events, fullContent, timedOut: false };
            }

            currentEvent = "";
            currentData = "";
          }
        }
      }
    }
  } catch (err: any) {
    if (err.name === "AbortError") {
      timedOut = true;
    } else {
      error = err.message;
    }
  } finally {
    clearTimeout(timer);
  }

  return { events, fullContent, timedOut, error };
}

function extractSkillInvokes(events: SSEEvent[]): SkillInvokeRecord[] {
  return events
    .filter((e) => e.event === "tool_call" && e.data?.toolName === "skill_invoke")
    .map((e) => ({
      skillName: e.data.input?.skill_name ?? e.data.input?.name ?? "?",
      mode: e.data.input?.mode ?? "(default)",
      input: (e.data.input?.input ?? "").slice(0, 120),
    }));
}

function extractAllToolNames(events: SSEEvent[]): string[] {
  return events
    .filter((e) => e.event === "tool_call")
    .map((e) => e.data?.toolName ?? "?");
}

/**
 * Evaluate whether a test case passed based on invoked skills.
 */
function evaluate(tc: TestCase, invoked: SkillInvokeRecord[]): { passed: boolean; reason: string } {
  const invokedNames = invoked.map((s) => s.skillName);

  // Check forbidden skills
  if (tc.forbiddenSkills) {
    const triggered = invokedNames.filter((n) => tc.forbiddenSkills!.includes(n));
    if (triggered.length > 0) {
      return { passed: false, reason: `触发了禁止的 skill: ${triggered.join(", ")}` };
    }
  }

  if (tc.expectedSkill === null) {
    // Negative test: no skill (or only acceptable skills) should trigger
    if (invokedNames.length === 0) {
      return { passed: true, reason: "未触发任何 skill（符合预期）" };
    }
    const acceptable = tc.acceptableSkills ?? [];
    const unacceptable = invokedNames.filter((n) => !acceptable.includes(n));
    if (unacceptable.length > 0) {
      return { passed: false, reason: `不应触发但触发了: ${unacceptable.join(", ")}` };
    }
    return { passed: true, reason: `触发了可接受的 skill: ${invokedNames.join(", ")}` };
  }

  // Positive test: expected skill should be among invoked
  const wanted = [tc.expectedSkill, ...(tc.acceptableSkills ?? [])];
  const matched = invokedNames.filter((n) => wanted.includes(n));
  if (matched.length > 0) {
    const extra = invokedNames.filter((n) => !wanted.includes(n));
    if (extra.length > 0) {
      return { passed: true, reason: `触发了 ${matched.join(", ")}（同时误触发了 ${extra.join(", ")}，但预期 skill 已命中）` };
    }
    return { passed: true, reason: `正确触发: ${matched.join(", ")}` };
  }

  return { passed: false, reason: `未触发预期 skill "${tc.expectedSkill}"。实际触发: ${invokedNames.length > 0 ? invokedNames.join(", ") : "（无）"}` };
}

// ---------------------------------------------------------------------------
// Dedup verification
// ---------------------------------------------------------------------------

/**
 * Replicate the dedup logic from agent-runner.ts:1664-1672 against the
 * live skill list, and report collisions + the winning source per name.
 */
async function verifyDedup(): Promise<void> {
  console.log("\n" + "=".repeat(70));
  console.log("=== Skill 列表去重验证 ===");
  console.log("=".repeat(70));

  const resp = await fetch(`${BASE}/api/agent-skills`);
  const allSkills = (await resp.json()) as any[];
  const active = allSkills.filter((s) => s.isActive !== false && s.isActive !== 0);

  // Group by name
  const byName = new Map<string, any[]>();
  for (const s of active) {
    const arr = byName.get(s.name) ?? [];
    arr.push(s);
    byName.set(s.name, arr);
  }

  const collisions = [...byName.entries()].filter(([, arr]) => arr.length > 1);
  if (collisions.length === 0) {
    console.log("  未发现同名 skill 冲突。");
  } else {
    console.log(`  发现 ${collisions.length} 个同名冲突（去重后应各保留 1 个）：\n`);
    const sourcePriority: Record<string, number> = { builtin: 0, hub: 1, plugin: 2, manual: 3 };
    for (const [name, arr] of collisions) {
      const sources = arr.map((s) => s.source).join(", ");
      const winner = arr.sort(
        (a, b) => (sourcePriority[a.source] ?? 99) - (sourcePriority[b.source] ?? 99),
      )[0];
      console.log(`  • "${name}"`);
      console.log(`    来源: ${sources}`);
      console.log(`    去重后保留: ${winner.source} ✓`);
      console.log("");
    }
  }

  // Quality gate: count skills with empty/short descriptions
  const shortDesc = active.filter((s) => !s.description || s.description.trim().length < 10);
  if (shortDesc.length > 0) {
    console.log(`  ⚠️ ${shortDesc.length} 个 skill 描述过短（<10字），会被质量门过滤:`);
    for (const s of shortDesc) console.log(`    - [${s.source}] ${s.name}`);
  }

  // Budget estimate
  let budget = 0;
  let visible = 0;
  const MAX_BUDGET = 6000;
  const deduped = new Map<string, any>();
  for (const s of active) {
    const existing = deduped.get(s.name);
    const sp: Record<string, number> = { builtin: 0, hub: 1, plugin: 2, manual: 3 };
    if (!existing || (sp[s.source] ?? 99) < (sp[existing.source] ?? 99)) {
      deduped.set(s.name, s);
    }
  }
  const visibleSkills = [...deduped.values()].filter((s) => s.description && s.description.trim().length >= 10);
  let omitted = 0;
  for (const s of visibleSkills) {
    const isHighCost = s.description.startsWith("[高成本/按需触发]");
    const prefix = isHighCost ? "🔴 " : "";
    const line = `${prefix}${s.name}: ${s.description}`;
    if (budget + line.length + 1 > MAX_BUDGET && visible > 0) {
      omitted = visibleSkills.length - visible;
      break;
    }
    budget += line.length + 1;
    visible++;
  }
  console.log(`\n  预算控制: 去重后 ${visibleSkills.length} 个有效 skill，预算 ${budget}/${MAX_BUDGET} 字符，可见 ${visible} 个${omitted > 0 ? `（省略 ${omitted} 个）` : ""}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Optional CLI filter: pass test IDs to run only those (e.g. "T1 T3")
  const filterIds = process.argv.slice(2).filter((a) => /^T\d+$/.test(a));
  const testsToRun = filterIds.length > 0
    ? TESTS.filter((t) => filterIds.includes(t.id))
    : TESTS;

  console.log("=".repeat(70));
  console.log("  Skill 系统端到端测试 — 调度验证");
  console.log("=".repeat(70));
  console.log(`  Server: ${BASE}`);
  console.log(`  bigtest KB: ${BIGTEST_KB_ID}`);
  console.log(`  Per-test timeout: ${PER_TEST_TIMEOUT / 1000}s`);
  console.log(`  Tests: ${testsToRun.map((t) => t.id).join(", ")}${filterIds.length === 0 ? " (全部)" : ""}`);
  console.log("");

  // Preflight: verify server is up
  const ping = await fetch(`${BASE}/api/sessions`).catch(() => null);
  if (!ping || !ping.ok) {
    console.error("ERROR: DA server is not running at " + BASE);
    process.exit(1);
  }

  // Dedup verification first
  await verifyDedup();

  const results: TestResult[] = [];
  const createdSessions: string[] = [];

  for (const tc of testsToRun) {
    console.log("\n" + "-".repeat(70));
    console.log(`[${tc.id}] ${tc.goal}`);
    console.log(`  输入: "${tc.input}"`);
    console.log(`  期望: ${tc.expectedSkill ? `触发 "${tc.expectedSkill}"` : "不触发 skill"}${tc.needsKb ? " (bigtest KB)" : ""}`);
    console.log("-".repeat(70));

    let sessionId: string;
    try {
      sessionId = await createSession(`skill-test-${tc.id}`);
      createdSessions.push(sessionId);
    } catch (e: any) {
      console.log(`  [ERROR] 无法创建 session: ${e.message}`);
      results.push({
        case: tc, invokedSkills: [], allToolCalls: [], contentSnippet: "",
        timedOut: false, error: e.message, passed: false, reason: "session 创建失败",
      });
      continue;
    }

    const scope = tc.needsKb
      ? { knowledgeBases: [{ kbId: BIGTEST_KB_ID }] }
      : undefined;

    const { events, fullContent, timedOut, error } = await runStream(
      sessionId, tc.input, scope, tc.expectedSkill, PER_TEST_TIMEOUT,
    );

    const invokedSkills = extractSkillInvokes(events);
    const allToolCalls = extractAllToolNames(events);
    const { passed, reason } = evaluate(tc, invokedSkills);

    const status = passed ? "PASS" : "FAIL";
    const tmo = timedOut ? " (timeout — 决策已捕获)" : error ? ` (error: ${error})` : "";

    console.log(`  skill_invoke 调用: ${invokedSkills.length === 0 ? "（无）" : ""}`);
    for (const s of invokedSkills) {
      console.log(`    → ${s.skillName}  [mode=${s.mode}]  input="${s.input}"`);
    }
    console.log(`  工具调用序列: ${allToolCalls.length > 0 ? allToolCalls.join(" → ") : "（无）"}`);
    console.log(`  超时/错误: ${timedOut ? "是" : "否"}${error ? " / " + error : ""}`);
    console.log(`  输出摘要: ${fullContent.slice(0, 200).replace(/\n/g, " ")}${fullContent.length > 200 ? "..." : ""}`);
    console.log(`  结果: [${status}] ${reason}${tmo}`);

    results.push({
      case: tc,
      invokedSkills,
      allToolCalls,
      contentSnippet: fullContent.slice(0, 300),
      timedOut,
      error,
      passed,
      reason,
    });
  }

  // Cleanup sessions
  for (const sid of createdSessions) await deleteSession(sid);

  // Summary
  printSummary(results);
}

function printSummary(results: TestResult[]): void {
  console.log("\n" + "=".repeat(70));
  console.log("  测试汇总报告");
  console.log("=".repeat(70));
  console.log("");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  // Table header
  const cols = ["#", "期望", "实际触发", "结果", "说明"];
  const rows = results.map((r) => {
    const expected = r.case.expectedSkill ?? "（无）";
    const actual = r.invokedSkills.length > 0
      ? r.invokedSkills.map((s) => s.skillName).join(",")
      : "（无）";
    return [
      r.case.id,
      expected.length > 22 ? expected.slice(0, 20) + ".." : expected,
      actual.length > 22 ? actual.slice(0, 20) + ".." : actual,
      r.passed ? "PASS" : "FAIL",
      r.reason.length > 30 ? r.reason.slice(0, 28) + ".." : r.reason,
    ];
  });

  // Compute column widths
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => String(r[i] ?? "").length)),
  );

  const fmtRow = (cells: string[]) =>
    "| " + cells.map((c, i) => String(c).padEnd(widths[i])).join(" | ") + " |";
  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";

  console.log(sep);
  console.log(fmtRow(cols));
  console.log(sep);
  for (const row of rows) console.log(fmtRow(row));
  console.log(sep);

  console.log(`\n  通过: ${passed}/${results.length}    失败: ${failed}/${results.length}`);

  // Detailed pass criteria check
  console.log("\n  通过标准检查:");
  const criteria = [
    { ids: ["T1", "T2", "T6", "T7", "T8"], desc: "正确触发预期 skill" },
    { ids: ["T3"], desc: "不触发任何 skill" },
    { ids: ["T4"], desc: "不触发高成本司法 skill" },
    { ids: ["T5"], desc: '触发"实体提取"而非"entity-network"' },
  ];
  for (const c of criteria) {
    const details = c.ids.map((id) => {
      const r = results.find((x) => x.case.id === id);
      return r ? `${id}=${r.passed ? "✓" : "✗"}` : `${id}=?`;
    }).join("  ");
    const allPass = c.ids.every((id) => results.find((x) => x.case.id === id)?.passed);
    console.log(`    [${allPass ? "✓" : "✗"}] ${c.desc}: ${details}`);
  }

  // Failed test details
  const failedResults = results.filter((r) => !r.passed);
  if (failedResults.length > 0) {
    console.log("\n  失败详情:");
    for (const r of failedResults) {
      console.log(`    [${r.case.id}] ${r.reason}`);
      if (r.invokedSkills.length > 0) {
        console.log(`         触发: ${r.invokedSkills.map((s) => s.skillName).join(", ")}`);
      }
    }
  }

  console.log("\n" + "=".repeat(70));
  if (failed === 0) {
    console.log("  ✓ 全部测试通过");
  } else {
    console.log(`  ✗ ${failed} 个测试未通过`);
  }
  console.log("=".repeat(70));
}

main().then(() => {
  // Force exit — dangling fetch/reader handles may keep the loop alive
  process.exit(0);
}).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
