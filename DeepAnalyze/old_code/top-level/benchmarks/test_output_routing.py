#!/usr/bin/env python3
"""
Comprehensive end-to-end test for multi-agent output routing.
Tests 20 distinct scenarios covering all output routing paths.
"""
import json
import time
import uuid
import sys
import os
import requests
from datetime import datetime

BASE = "http://localhost:21000"
KB_ID = "0f329774-cc0f-48fe-b5c1-393e3a80bc0a"  # DABstep Payment Analytics
HEADERS = {"Content-Type": "application/json"}
TIMEOUT = 300  # 5 min per test

results = []

def create_session(title, kb_scope=None):
    """Create a new session, optionally scoped to a KB."""
    body = {"title": title}
    if kb_scope:
        body["kbScope"] = kb_scope
    r = requests.post(f"{BASE}/api/sessions", json=body, headers=HEADERS)
    r.raise_for_status()
    return r.json()["id"]

def run_agent_sync(session_id, input_text, scope=None, max_turns=30):
    """Run agent synchronously and return the full response."""
    body = {
        "sessionId": session_id,
        "input": input_text,
        "maxTurns": max_turns,
    }
    if scope:
        body["scope"] = scope
    r = requests.post(f"{BASE}/api/agents/run", json=body, headers=HEADERS, timeout=TIMEOUT)
    if r.status_code != 200:
        return {"error": f"HTTP {r.status_code}", "body": r.text[:500]}
    return r.json()

def run_agent_stream(session_id, input_text, scope=None, max_turns=30):
    """Run agent with streaming, collect all events."""
    body = {
        "sessionId": session_id,
        "input": input_text,
        "maxTurns": max_turns,
    }
    if scope:
        body["scope"] = scope
    events = []
    try:
        with requests.post(f"{BASE}/api/agents/run-stream", json=body, headers=HEADERS, stream=True, timeout=TIMEOUT) as r:
            for line in r.iter_lines(decode_unicode=True):
                if not line:
                    continue
                if line.startswith("data: "):
                    try:
                        event = json.loads(line[6:])
                        events.append(event)
                    except json.JSONDecodeError:
                        events.append({"raw": line})
                elif line.startswith(": "):
                    events.append({"type": "keepalive"})
    except requests.exceptions.Timeout:
        events.append({"type": "timeout"})
    except Exception as e:
        events.append({"type": "error", "error": str(e)})
    return events

def get_session_messages(session_id):
    """Get enriched messages for a session."""
    r = requests.get(f"{BASE}/api/sessions/{session_id}/messages", headers=HEADERS)
    if r.status_code != 200:
        return []
    return r.json()

def analyze_stream_events(events):
    """Analyze stream events for output routing issues."""
    analysis = {
        "total_events": len(events),
        "text_deltas": 0,
        "tool_calls": [],
        "tool_results": [],
        "push_contents": [],
        "complete_output": "",
        "has_complete": False,
        "has_error": False,
        "error_msg": None,
        "task_id": None,
        "turns_used": 0,
    }

    text_buffer = []
    for e in events:
        t = e.get("type", "")
        if t == "start":
            analysis["task_id"] = e.get("taskId")
        elif t == "content_delta":
            analysis["text_deltas"] += 1
            text_buffer.append(e.get("delta", ""))
        elif t == "tool_call":
            analysis["tool_calls"].append({
                "name": e.get("toolName", e.get("tool", "")),
                "input_keys": list(e.get("input", {}).keys()) if isinstance(e.get("input"), dict) else [],
            })
        elif t == "tool_result":
            result = e.get("result", e.get("output", ""))
            result_str = str(result)[:200] if result else ""
            analysis["tool_results"].append({
                "name": e.get("toolName", e.get("tool", "")),
                "result_preview": result_str,
            })
        elif t == "push_content":
            analysis["push_contents"].append({
                "type": e.get("contentCard", {}).get("type", ""),
                "title": e.get("contentCard", {}).get("title", ""),
            })
        elif t == "complete":
            analysis["has_complete"] = True
            analysis["complete_output"] = e.get("output", "")[:500]
        elif t == "done":
            analysis["turns_used"] = e.get("turnsUsed", 0)
        elif t == "error":
            analysis["has_error"] = True
            analysis["error_msg"] = e.get("error", "")

    analysis["full_text"] = "".join(text_buffer)
    return analysis

def verify_output(analysis, test_name, checks):
    """Verify analysis against checks. Returns pass/fail list."""
    verdicts = []
    for check_name, check_fn in checks.items():
        try:
            passed, detail = check_fn(analysis)
            verdicts.append({
                "check": check_name,
                "passed": passed,
                "detail": detail,
            })
        except Exception as e:
            verdicts.append({
                "check": check_name,
                "passed": False,
                "detail": f"Exception: {e}",
            })
    return verdicts

def run_test(test_num, test_name, session_id, input_text, scope=None, max_turns=30, stream=True):
    """Run a single test and return results."""
    print(f"\n{'='*60}")
    print(f"Test #{test_num}: {test_name}")
    print(f"{'='*60}")
    print(f"Session: {session_id[:8]}...")
    print(f"Input: {input_text[:100]}...")

    start = time.time()
    if stream:
        events = run_agent_stream(session_id, input_text, scope, max_turns)
        analysis = analyze_stream_events(events)
        elapsed = time.time() - start

        analysis["test_name"] = test_name
        analysis["test_num"] = test_num
        analysis["elapsed_seconds"] = round(elapsed, 1)

        # Print summary
        print(f"  Events: {analysis['total_events']}")
        print(f"  Text deltas: {analysis['text_deltas']}")
        print(f"  Tool calls: {len(analysis['tool_calls'])}")
        tool_names = [tc['name'] for tc in analysis['tool_calls']]
        print(f"  Tools used: {', '.join(set(tool_names))}")
        print(f"  Push contents: {len(analysis['push_contents'])}")
        for pc in analysis['push_contents']:
            print(f"    - [{pc['type']}] {pc['title']}")
        print(f"  Turns used: {analysis['turns_used']}")
        print(f"  Elapsed: {elapsed:.1f}s")
        print(f"  Has error: {analysis['has_error']}")
        if analysis['has_error']:
            print(f"  Error: {analysis['error_msg']}")
        print(f"  Full text length: {len(analysis['full_text'])}")

        return analysis
    else:
        result = run_agent_sync(session_id, input_text, scope, max_turns)
        elapsed = time.time() - start
        result["test_name"] = test_name
        result["test_num"] = test_num
        result["elapsed_seconds"] = round(elapsed, 1)
        print(f"  Status: {result.get('status', 'unknown')}")
        print(f"  Output length: {len(result.get('output', ''))}")
        print(f"  Elapsed: {elapsed:.1f}s")
        return result


# =========================================================================
# 20 Test Scenarios
# =========================================================================

print("="*60)
print("DeepAnalyze Multi-Agent Output Routing - E2E Test Suite")
print(f"Started: {datetime.now().isoformat()}")
print("="*60)

all_results = []

# =========================================================================
# GROUP A: Single Agent - Basic Scenarios (Tests 1-4)
# =========================================================================

# Test 1: Simple greeting - single agent, no tools
print("\n\n" + "="*60)
print("GROUP A: Single Agent Basic Scenarios")
print("="*60)

sid1 = create_session("T1 Simple Greeting")
r1 = run_test(1, "简单问候（单Agent无工具）", sid1, "你好，请简单介绍一下你能做什么")
all_results.append(r1)

# Test 2: General knowledge Q&A - no KB
sid2 = create_session("T2 General Knowledge QA")
r2 = run_test(2, "通用知识问答（无KB）", sid2, "请解释量子计算的基本原理，以及它和经典计算的主要区别，300字以内")
all_results.append(r2)

# Test 3: KB search + answer - single agent with KB
sid3 = create_session("T3 KB Search QA", {"kbIds": [KB_ID]})
r3 = run_test(3, "KB知识库问答（单Agent有KB）", sid3,
    "请搜索知识库，找出所有支付方式及其对应的手续费率，整理成表格回答",
    scope={"kbIds": [KB_ID]})
all_results.append(r3)

# Test 4: Multi-step analysis - single agent with tools
sid4 = create_session("T4 Multi-step Analysis", {"kbIds": [KB_ID]})
r4 = run_test(4, "多步分析任务（单Agent+多工具）", sid4,
    "分析知识库中的商户数据：1)先搜索了解有哪些商户类型 2)查看merchant_data的结构 3)统计每种商户类型的数量 4)给出分析结论",
    scope={"kbIds": [KB_ID]})
all_results.append(r4)

# =========================================================================
# GROUP B: Sub-Agent Routing (Tests 5-8)
# =========================================================================

print("\n\n" + "="*60)
print("GROUP B: Sub-Agent Output Routing")
print("="*60)

# Test 5: skill_invoke inline mode
sid5 = create_session("T5 Skill Inline", {"kbIds": [KB_ID]})
r5 = run_test(5, "Skill Invoke - inline模式", sid5,
    "请用precise-qa技能回答：知识库中涉及到的收单国家有哪些？每个国家的商户数量是多少？",
    scope={"kbIds": [KB_ID]})
all_results.append(r5)

# Test 6: skill_invoke sub_agent mode
sid6 = create_session("T6 Skill Sub-Agent", {"kbIds": [KB_ID]})
r6 = run_test(6, "Skill Invoke - sub_agent模式（独立上下文）", sid6,
    "请使用precise-qa技能以sub_agent模式分析：比较不同收单国家的手续费差异，找出手续费最高和最低的国家",
    scope={"kbIds": [KB_ID]})
all_results.append(r6)

# Test 7: skill_invoke fork mode (inherits context)
sid7 = create_session("T7 Skill Fork", {"kbIds": [KB_ID]})
# First establish context
run_agent_sync(sid7, "请搜索知识库中的fees数据，了解费率结构", scope={"kbIds": [KB_ID]}, max_turns=15)
# Then fork - should inherit the previous conversation
r7 = run_test(7, "Skill Invoke - fork模式（继承上下文）", sid7,
    "基于我们之前的对话，请用deep-research技能以fork模式深入研究：这个费率结构中是否存在异常或不合理的收费项？",
    scope={"kbIds": [KB_ID]})
all_results.append(r7)

# Test 8: delegate_task - single sub-agent delegation
sid8 = create_session("T8 Delegate Task", {"kbIds": [KB_ID]})
r8 = run_test(8, "delegate_task - 委托子Agent完成独立任务", sid8,
    "请使用delegate_task工具委托一个子Agent去分析知识库中的merchant_category_codes数据，统计各商户类别的数量和占比，完成后把结果汇总给我",
    scope={"kbIds": [KB_ID]})
all_results.append(r8)

# =========================================================================
# GROUP C: Multi-Agent Workflow Patterns (Tests 9-12)
# =========================================================================

print("\n\n" + "="*60)
print("GROUP C: Multi-Agent Workflow Patterns")
print("="*60)

# Test 9: workflow_run parallel mode
sid9 = create_session("T9 Workflow Parallel")
r9 = run_test(9, "workflow_run - parallel模式（多Agent并行）", sid9,
    '请使用workflow_run工具，以parallel模式执行以下任务：' +
    'Agent A负责分析支付方式分类，Agent B负责分析商户类型分布。' +
    '两个Agent分别独立分析，最后汇总结果。' +
    'agents参数：[{"id":"a","role":"支付分析师","task":"分析知识库中payments.csv的支付方式分类和分布"},{"id":"b","role":"商户分析师","task":"分析知识库中merchant_data.json的商户类型和数量分布"}]',
    scope={"kbIds": [KB_ID]}, max_turns=40)
all_results.append(r9)

# Test 10: workflow_run pipeline mode
sid10 = create_session("T10 Workflow Pipeline")
r10 = run_test(10, "workflow_run - pipeline模式（串行流程）", sid10,
    '请使用workflow_run工具，以pipeline模式执行：' +
    '第一步Agent先收集知识库中所有数据文件的结构信息，' +
    '第二步Agent基于第一步的结果生成综合分析报告。',
    scope={"kbIds": [KB_ID]}, max_turns=40)
all_results.append(r10)

# Test 11: workflow_run council mode with cross-review
sid11 = create_session("T11 Workflow Council")
r11 = run_test(11, "workflow_run - council模式（多视角+交叉审核）", sid11,
    '请使用workflow_run工具，以council模式分析知识库：' +
    'Agent A从商户角度分析数据，Agent B从支付通道角度分析数据，' +
    '开启crossReview让两个Agent互相审核发现的问题。',
    scope={"kbIds": [KB_ID]}, max_turns=50)
all_results.append(r11)

# Test 12: report generation with push_content
sid12 = create_session("T12 Report Gen", {"kbIds": [KB_ID]})
r12 = run_test(12, "报告生成+push_content推送", sid12,
    "请对知识库中的支付数据做全面分析，然后生成一份结构化的分析报告，用push_content推送到前端展示。报告应包含：数据概览、关键发现、统计摘要",
    scope={"kbIds": [KB_ID]}, max_turns=30)
all_results.append(r12)

# =========================================================================
# GROUP D: Complex Multi-Agent Scenarios (Tests 13-16)
# =========================================================================

print("\n\n" + "="*60)
print("GROUP D: Complex Multi-Agent Scenarios")
print("="*60)

# Test 13: Multi-skill sequential invocation
sid13 = create_session("T13 Multi-Skill Sequential")
r13 = run_test(13, "多Skill顺序调用", sid13,
    "请先用doc_grep搜索知识库中所有包含'fee'的内容，然后用skill_invoke调用chunked-analysis技能分析搜索结果，最后用write_file把分析结果保存到文件",
    scope={"kbIds": [KB_ID]}, max_turns=30)
all_results.append(r13)

# Test 14: Deep research skill (produces long output that needs routing)
sid14 = create_session("T14 Deep Research", {"kbIds": [KB_ID]})
r14 = run_test(14, "deep-research技能（长输出路由测试）", sid14,
    "请调用deep-research技能，以sub_agent模式对知识库中的所有数据进行深度研究：分析支付流程、费率体系、商户分布、收单国家等所有维度，输出详尽的研究报告",
    scope={"kbIds": [KB_ID]}, max_turns=50)
all_results.append(r14)

# Test 15: Cross-table analysis skill
sid15 = create_session("T15 Cross-Table Analysis", {"kbIds": [KB_ID]})
r15 = run_test(15, "cross-table-analysis技能（多表交叉分析）", sid15,
    "请调用cross-table-analysis技能分析知识库中的payments.csv、fees.json和merchant_data.json三张表之间的关联关系",
    scope={"kbIds": [KB_ID]}, max_turns=40)
all_results.append(r15)

# Test 16: General writing task (no KB needed)
sid16 = create_session("T16 General Writing")
r16 = run_test(16, "通用写作任务（无KB）", sid16,
    "请帮我写一份关于人工智能在金融风控领域应用的技术白皮书大纲，包含：1)行业背景 2)技术架构 3)核心算法 4)应用案例 5)未来展望。每个章节需要包含子节标题和简要描述",
    max_turns=15)
all_results.append(r16)

# =========================================================================
# GROUP E: User Interaction & Edge Cases (Tests 17-20)
# =========================================================================

print("\n\n" + "="*60)
print("GROUP E: User Interaction & Edge Cases")
print("="*60)

# Test 17: Complex analysis with follow-up in same session
sid17 = create_session("T17 Follow-up Analysis", {"kbIds": [KB_ID]})
r17a = run_agent_sync(sid17, "请搜索知识库中payments的数据，给出支付金额的统计摘要（总数、均值、最大值、最小值）",
    scope={"kbIds": [KB_ID]}, max_turns=20)
print(f"\n  T17a First query output length: {len(r17a.get('output', ''))}")

r17 = run_test(17, "会话后续追问（上下文延续）", sid17,
    "基于刚才的统计结果，请进一步分析：金额最大的支付交易有什么特征？金额分布是否有异常？",
    scope={"kbIds": [KB_ID]})
all_results.append(r17)

# Test 18: Skill invocation that triggers write_file (file output)
sid18 = create_session("T18 File Output", {"kbIds": [KB_ID]})
r18 = run_test(18, "Skill写入文件（文件路由测试）", sid18,
    "请调用报告生成技能，对知识库中的支付数据生成一份Markdown格式的分析报告，保存到tmp/payment_analysis.md文件中，然后用push_content推送文件内容",
    scope={"kbIds": [KB_ID]}, max_turns=30)
all_results.append(r18)

# Test 19: Workflow with conflicting data (should trigger cross-verification)
sid19 = create_session("T19 Conflicting Data")
r19 = run_test(19, "Workflow数据矛盾场景（交叉验证测试）", sid19,
    '请使用workflow_run工具以council模式分析：让两个Agent分别用不同的方法估算知识库中的总手续费金额（一个用payments数据推算，一个用fees数据计算），然后对比结果看是否一致',
    scope={"kbIds": [KB_ID]}, max_turns=50)
all_results.append(r19)

# Test 20: Empty/minimal result handling
sid20 = create_session("T20 Empty Result")
r20 = run_test(20, "搜索无结果场景（优雅降级测试）", sid20,
    "请搜索知识库中关于'量子计算'的内容，如果找不到相关内容，请说明知识库中没有这方面的数据",
    scope={"kbIds": [KB_ID]}, max_turns=10)
all_results.append(r20)

# =========================================================================
# Summary
# =========================================================================

print("\n\n" + "="*60)
print("TEST SUMMARY")
print("="*60)

passed = 0
failed = 0
errors = 0

for r in all_results:
    test_num = r.get("test_num", "?")
    test_name = r.get("test_name", "?")
    has_error = r.get("has_error", False)
    has_complete = r.get("has_complete", False)
    output_len = len(r.get("full_text", r.get("output", "")))
    turns = r.get("turns_used", r.get("turns", 0))
    elapsed = r.get("elapsed_seconds", 0)

    # Determine status
    if has_error or r.get("error"):
        status = "ERROR"
        errors += 1
    elif output_len > 0 or has_complete:
        status = "PASS"
        passed += 1
    else:
        status = "FAIL"
        failed += 1

    print(f"  #{test_num:2d} [{status:5s}] {test_name[:50]:50s} | out={output_len:5d} turns={turns:2d} time={elapsed:5.1f}s")

print(f"\n  Total: {len(all_results)} | Passed: {passed} | Failed: {failed} | Errors: {errors}")

# Save detailed results
output_file = f"benchmarks/results/output-routing-test-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
os.makedirs(os.path.dirname(output_file), exist_ok=True)
with open(output_file, "w") as f:
    json.dump(all_results, f, ensure_ascii=False, indent=2, default=str)
print(f"\nDetailed results saved to: {output_file}")
