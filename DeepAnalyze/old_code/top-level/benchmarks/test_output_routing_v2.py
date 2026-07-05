#!/usr/bin/env python3
"""
Comprehensive E2E test for multi-agent output routing - v2.
Properly parses SSE event/data format.
"""
import json, time, sys, os, requests
from datetime import datetime

BASE = "http://localhost:21000"
KB_ID = "0f329774-cc0f-48fe-b5c1-393e3a80bc0a"
TIMEOUT = 300

def create_session(title, kb_scope=None):
    body = {"title": title}
    if kb_scope:
        body["kbScope"] = kb_scope
    r = requests.post(f"{BASE}/api/sessions", json=body)
    r.raise_for_status()
    return r.json()["id"]

def run_sync(sid, inp, scope=None, max_turns=20):
    body = {"sessionId": sid, "input": inp, "maxTurns": max_turns}
    if scope:
        body["scope"] = scope
    r = requests.post(f"{BASE}/api/agents/run", json=body, timeout=TIMEOUT)
    return r.json() if r.status_code == 200 else {"error": f"HTTP {r.status_code}", "body": r.text[:500]}

def parse_sse_events(response_iter):
    """Parse SSE format: event: type\ndata: json\n\n"""
    events = []
    current_event = None
    for line in response_iter:
        line = line.decode("utf-8") if isinstance(line, bytes) else line
        line = line.rstrip("\n\r")
        if line.startswith("event: "):
            current_event = {"__sse_type": line[7:]}
        elif line.startswith("data: "):
            data_str = line[6:]
            try:
                data = json.loads(data_str)
                if current_event:
                    data["__event"] = current_event["__sse_type"]
                    current_event = None
                events.append(data)
            except json.JSONDecodeError:
                if current_event:
                    current_event["__raw_data"] = data_str
                    events.append(current_event)
                    current_event = None
        elif line == "" and current_event:
            events.append(current_event)
            current_event = None
        elif line.startswith(": "):
            events.append({"__event": "keepalive"})
    return events

def run_stream(sid, inp, scope=None, max_turns=30):
    """Run with streaming, collect all SSE events."""
    body = {"sessionId": sid, "input": inp, "maxTurns": max_turns}
    if scope:
        body["scope"] = scope
    try:
        with requests.post(f"{BASE}/api/agents/run-stream", json=body, stream=True, timeout=TIMEOUT) as r:
            return parse_sse_events(r.iter_lines())
    except requests.exceptions.Timeout:
        return [{"__event": "timeout"}]
    except Exception as e:
        return [{"__event": "error", "error": str(e)}]

def analyze_events(events):
    """Analyze events for output routing verification."""
    a = {
        "total_events": len(events),
        "text_deltas": 0,
        "text_parts": [],
        "tool_calls": [],
        "tool_results": [],
        "push_contents": [],
        "thinking_deltas": 0,
        "has_complete": False,
        "has_done": False,
        "has_error": False,
        "error_msg": None,
        "task_id": None,
        "turns_used": 0,
        "complete_output": "",
        "events_by_type": {},
    }
    for e in events:
        t = e.get("__event", e.get("type", "unknown"))
        a["events_by_type"][t] = a["events_by_type"].get(t, 0) + 1
        if t == "start":
            a["task_id"] = e.get("taskId")
        elif t == "content_delta":
            a["text_deltas"] += 1
            a["text_parts"].append(e.get("delta", ""))
        elif t == "thinking_delta":
            a["thinking_deltas"] += 1
        elif t == "tool_call":
            a["tool_calls"].append({
                "name": e.get("toolName", ""),
                "turn": e.get("turn", 0),
                "has_input": bool(e.get("input")),
            })
        elif t == "tool_result":
            result = str(e.get("result", ""))[:200]
            a["tool_results"].append({
                "name": e.get("toolName", ""),
                "result_preview": result,
                "turn": e.get("turn", 0),
            })
        elif t == "push_content":
            card = e.get("contentCard", e.get("data", {}))
            if isinstance(card, str):
                try:
                    card = json.loads(card)
                except:
                    card = {}
            if not isinstance(card, dict):
                card = {}
            a["push_contents"].append({
                "type": card.get("type", ""),
                "title": card.get("title", ""),
            })
        elif t == "complete":
            a["has_complete"] = True
            a["complete_output"] = str(e.get("output", ""))[:500]
        elif t == "done":
            a["has_done"] = True
            a["turns_used"] = e.get("turnsUsed", 0)
        elif t == "error":
            a["has_error"] = True
            a["error_msg"] = e.get("error", "")
    a["full_text"] = "".join(a["text_parts"])
    return a

def print_analysis(a, test_num, test_name, elapsed):
    print(f"  Events: {a['total_events']} | Text: {len(a['full_text'])} chars ({a['text_deltas']} deltas) | Thinking: {a['thinking_deltas']}", flush=True)
    print(f"  Tool calls: {len(a['tool_calls'])} | Push: {len(a['push_contents'])} | Turns: {a['turns_used']} | Time: {elapsed:.1f}s", flush=True)
    tool_names = list(set(tc['name'] for tc in a['tool_calls']))
    if tool_names:
        print(f"  Tools: {', '.join(sorted(tool_names))}", flush=True)
    for pc in a['push_contents']:
        print(f"  Push: [{pc['type']}] {pc['title']}", flush=True)
    if a['has_error']:
        print(f"  ERROR: {a['error_msg']}", flush=True)
    if a['full_text']:
        print(f"  Text preview: {a['full_text'][:200]}...", flush=True)
    elif a['complete_output']:
        print(f"  Complete preview: {a['complete_output'][:200]}...", flush=True)
    print(f"  Event types: {a['events_by_type']}", flush=True)

all_results = []
def run_test(test_num, test_name, sid, inp, scope=None, max_turns=30):
    print(f"\n{'='*60}\nTest #{test_num}: {test_name}\n{'='*60}", flush=True)
    start = time.time()
    events = run_stream(sid, inp, scope, max_turns)
    elapsed = time.time() - start
    a = analyze_events(events)
    a["test_num"] = test_num
    a["test_name"] = test_name
    a["elapsed"] = round(elapsed, 1)
    print_analysis(a, test_num, test_name, elapsed)
    all_results.append(a)
    return a

# ======================================================================
# RUN ALL 20 TESTS
# ======================================================================

print(f"\n{'#'*60}\nDeepAnalyze Output Routing E2E Test Suite\n{datetime.now().isoformat()}\n{'#'*60}", flush=True)

# --- GROUP A: Single Agent Basics (T1-T4) ---
print("\n--- GROUP A: Single Agent Basics ---", flush=True)

run_test(1, "简单问候（无工具）",
    create_session("T1"), "你好，请用50字介绍你能做什么", max_turns=3)

run_test(2, "通用知识问答（无KB）",
    create_session("T2"), "请用200字解释量子计算的基本原理", max_turns=3)

run_test(3, "KB问答（单Agent+搜索）",
    create_session("T3", {"kbIds": [KB_ID]}),
    "搜索知识库找出所有支付方式及手续费率，用表格回答",
    scope={"kbIds": [KB_ID]})

run_test(4, "多步分析（单Agent+多工具）",
    create_session("T4", {"kbIds": [KB_ID]}),
    "分析知识库中的商户数据：1)搜索了解有哪些类型 2)查看merchant_data结构 3)统计各类数量",
    scope={"kbIds": [KB_ID]})

# --- GROUP B: Sub-Agent Routing (T5-T8) ---
print("\n--- GROUP B: Sub-Agent Routing ---", flush=True)

run_test(5, "skill_invoke inline模式",
    create_session("T5", {"kbIds": [KB_ID]}),
    "请用precise-qa技能以inline模式回答：知识库中有哪些收单国家？",
    scope={"kbIds": [KB_ID]})

run_test(6, "skill_invoke sub_agent模式（关键路由测试）",
    create_session("T6", {"kbIds": [KB_ID]}),
    "请使用precise-qa技能以sub_agent模式分析：比较不同收单国家的手续费差异",
    scope={"kbIds": [KB_ID]})

# Test 7: fork mode - first establish context then fork
print(f"\n{'='*60}\nTest #7: skill_invoke fork模式（继承上下文）\n{'='*60}", flush=True)
sid7 = create_session("T7", {"kbIds": [KB_ID]})
r7a = run_sync(sid7, "请搜索知识库中的fees数据，了解费率结构", scope={"kbIds": [KB_ID]}, max_turns=15)
print(f"  Context setup: {len(r7a.get('output',''))} chars", flush=True)
run_test(7, "skill_invoke fork模式（继承上下文）",
    sid7,
    "基于之前对话中的fees数据，请用deep-research技能以fork模式深入分析费率中是否有异常收费",
    scope={"kbIds": [KB_ID]})

run_test(8, "delegate_task（子Agent委托）",
    create_session("T8", {"kbIds": [KB_ID]}),
    "请使用delegate_task委托子Agent去分析知识库中的merchant_category_codes数据，统计各类别数量和占比",
    scope={"kbIds": [KB_ID]})

# --- GROUP C: Multi-Agent Workflows (T9-T12) ---
print("\n--- GROUP C: Multi-Agent Workflows ---", flush=True)

run_test(9, "workflow_run parallel模式",
    create_session("T9", {"kbIds": [KB_ID]}),
    "请使用workflow_run以parallel模式：Agent A分析payments.csv支付方式分布，Agent B分析merchant_data.json商户类型分布。分别分析后汇总。",
    scope={"kbIds": [KB_ID]}, max_turns=40)

run_test(10, "workflow_run pipeline模式",
    create_session("T10", {"kbIds": [KB_ID]}),
    "请使用workflow_run以pipeline模式：第一步Agent收集知识库数据文件结构，第二步Agent基于第一步结果生成综合分析报告",
    scope={"kbIds": [KB_ID]}, max_turns=40)

run_test(11, "workflow_run council模式（交叉审核）",
    create_session("T11", {"kbIds": [KB_ID]}),
    "请使用workflow_run以council模式分析知识库：Agent A从商户角度分析，Agent B从支付通道角度分析，开启crossReview互相审核",
    scope={"kbIds": [KB_ID]}, max_turns=50)

run_test(12, "报告生成+push_content推送",
    create_session("T12", {"kbIds": [KB_ID]}),
    "对知识库支付数据做全面分析，生成结构化报告，用push_content推送到前端。报告包含：数据概览、关键发现、统计摘要",
    scope={"kbIds": [KB_ID]})

# --- GROUP D: Complex Scenarios (T13-T16) ---
print("\n--- GROUP D: Complex Scenarios ---", flush=True)

run_test(13, "多Skill顺序调用",
    create_session("T13", {"kbIds": [KB_ID]}),
    "先用doc_grep搜索知识库中'fee'相关内容，然后调用chunked-analysis技能分析搜索结果，最后write_file保存分析结果",
    scope={"kbIds": [KB_ID]})

run_test(14, "deep-research技能（长输出路由）",
    create_session("T14", {"kbIds": [KB_ID]}),
    "请调用deep-research技能以sub_agent模式对知识库所有数据做深度研究，输出详尽报告",
    scope={"kbIds": [KB_ID]}, max_turns=50)

run_test(15, "cross-table-analysis技能（多表关联）",
    create_session("T15", {"kbIds": [KB_ID]}),
    "请调用cross-table-analysis技能分析payments.csv、fees.json和merchant_data.json三张表的关联关系",
    scope={"kbIds": [KB_ID]}, max_turns=40)

run_test(16, "通用写作任务（无KB）",
    create_session("T16"),
    "写一份关于AI在金融风控领域应用的技术白皮书大纲，包含行业背景、技术架构、核心算法、应用案例、未来展望，每章含子节标题和描述")

# --- GROUP E: Edge Cases (T17-T20) ---
print("\n--- GROUP E: Edge Cases ---", flush=True)

# Test 17: Follow-up in same session
print(f"\n{'='*60}\nTest #17: 会话后续追问\n{'='*60}", flush=True)
sid17 = create_session("T17", {"kbIds": [KB_ID]})
r17a = run_sync(sid17, "搜索知识库中payments数据，给出支付金额统计摘要", scope={"kbIds": [KB_ID]}, max_turns=20)
print(f"  First query output: {len(r17a.get('output',''))} chars", flush=True)
run_test(17, "会话后续追问（上下文延续）",
    sid17,
    "基于刚才的统计，金额最大的支付交易有什么特征？金额分布是否有异常？",
    scope={"kbIds": [KB_ID]})

run_test(18, "Skill写入文件+push_content",
    create_session("T18", {"kbIds": [KB_ID]}),
    "调用报告生成技能分析知识库支付数据，保存到tmp/payment_analysis.md，用push_content推送文件内容",
    scope={"kbIds": [KB_ID]})

run_test(19, "Workflow数据矛盾（交叉验证测试）",
    create_session("T19", {"kbIds": [KB_ID]}),
    "请使用workflow_run以council模式：Agent A用payments数据推算总手续费，Agent B用fees数据计算总手续费，对比是否一致",
    scope={"kbIds": [KB_ID]}, max_turns=50)

run_test(20, "搜索无结果（优雅降级）",
    create_session("T20", {"kbIds": [KB_ID]}),
    "搜索知识库中关于'量子计算'的内容",
    scope={"kbIds": [KB_ID]}, max_turns=10)

# ======================================================================
# SUMMARY
# ======================================================================
print(f"\n\n{'#'*60}\nTEST SUMMARY\n{'#'*60}", flush=True)

for r in all_results:
    n = r["test_num"]
    name = r["test_name"]
    text_len = len(r.get("full_text", ""))
    turns = r.get("turns_used", 0)
    elapsed = r.get("elapsed", 0)
    tools = len(r.get("tool_calls", []))
    push = len(r.get("push_contents", []))
    err = r.get("has_error", False)

    status = "ERROR" if err else ("OK" if text_len > 0 or r.get("has_done") else "WARN")
    print(f"  #{n:2d} [{status:4s}] {name[:45]:45s} | txt={text_len:5d} tools={tools:2d} push={push} turns={turns:2d} t={elapsed:5.1f}s", flush=True)

    # Specific routing checks
    skill_invokes = [tc for tc in r.get("tool_calls", []) if tc["name"] == "skill_invoke"]
    delegate_calls = [tc for tc in r.get("tool_calls", []) if tc["name"] == "delegate_task"]
    workflow_calls = [tc for tc in r.get("tool_calls", []) if tc["name"] == "workflow_run"]

    if skill_invokes:
        print(f"       -> skill_invoke x{len(skill_invokes)} (sub-agent routing active)", flush=True)
    if delegate_calls:
        print(f"       -> delegate_task x{len(delegate_calls)} (adaptive output routing active)", flush=True)
    if workflow_calls:
        print(f"       -> workflow_run x{len(workflow_calls)} (multi-agent coordination active)", flush=True)

# Save results
out_file = f"benchmarks/results/output-routing-test-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
os.makedirs(os.path.dirname(out_file), exist_ok=True)
with open(out_file, "w") as f:
    json.dump(all_results, f, ensure_ascii=False, indent=2, default=str)
print(f"\nResults saved to: {out_file}", flush=True)
