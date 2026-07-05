#!/usr/bin/env python3
"""
Multi-turn compaction robustness test.
Creates sessions with multiple independent Q&A rounds,
triggers compaction, and verifies no old task re-execution.
"""
import json
import sys
import time
import urllib.request

BASE = "http://localhost:21000"

def api(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            if resp.status == 204:
                return None
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read()) if e.headers.get("content-type","").startswith("application/json") else {"error": str(e)}

def create_session(title):
    r = api("POST", "/api/sessions", {"title": title})
    return r["id"]

def send_message(session_id, content):
    return api("POST", "/api/chat/send", {"sessionId": session_id, "content": content})

def run_agent_stream(session_id, input_text):
    """Run agent via SSE stream, collect tool calls and compaction events"""
    req = urllib.request.Request(
        f"{BASE}/api/agents/run-stream",
        data=json.dumps({"sessionId": session_id, "input": input_text}).encode(),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")

    tool_calls = []
    compaction_events = []
    output_parts = []
    done = False

    with urllib.request.urlopen(req, timeout=300) as resp:
        buffer = ""
        current_event = ""
        current_data = ""
        while True:
            chunk = resp.read(1)
            if not chunk:
                break
            buffer += chunk.decode("utf-8", errors="replace")

            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.rstrip("\r")

                if line.startswith("event: "):
                    current_event = line[7:].strip()
                elif line.startswith("data: "):
                    current_data = line[6:]
                elif line == "" and current_event and current_data:
                    try:
                        data = json.loads(current_data)
                    except:
                        current_event = ""
                        current_data = ""
                        continue

                    if current_event == "tool_call":
                        tool_calls.append({
                            "name": data.get("toolName", "?"),
                            "id": data.get("id", "?"),
                            "status": "running",
                        })
                    elif current_event == "tool_result":
                        tc_id = data.get("id", "?")
                        for tc in tool_calls:
                            if tc["id"] == tc_id and tc["status"] == "running":
                                tc["status"] = "completed"
                                break
                    elif current_event == "compaction":
                        compaction_events.append({
                            "turn": data.get("turn"),
                            "method": data.get("method"),
                            "tokensSaved": data.get("tokensSaved"),
                        })
                    elif current_event == "content_delta":
                        output_parts.append(data.get("delta", ""))
                    elif current_event == "done":
                        done = True

                    current_event = ""
                    current_data = ""

    return {
        "tool_calls": tool_calls,
        "compaction_events": compaction_events,
        "output": "".join(output_parts),
        "done": done,
    }

def get_messages(session_id):
    return api("GET", f"/api/sessions/{session_id}/messages")

def analyze_output(output, old_task_keywords, current_task_keywords):
    """Check if output contains old task content that shouldn't be there"""
    issues = []
    for kw in old_task_keywords:
        if kw in output:
            issues.append(f"Output contains old task keyword: '{kw}'")
    for kw in current_task_keywords:
        if kw not in output:
            issues.append(f"Output missing current task keyword: '{kw}'")
    return issues

def delete_session(sid):
    try:
        api("DELETE", f"/api/sessions/{sid}")
    except:
        pass

# ============================================================================
# Test 1: Three different questions in sequence
# ============================================================================
def test_1():
    print("\n" + "="*70)
    print("TEST 1: Three independent questions in sequence")
    print("="*70)
    sid = create_session("T1-three-questions")
    print(f"Session: {sid}")

    # Q1: List documents
    print("\n--- Q1: List document types ---")
    r1 = run_agent_stream(sid, "列出知识库中有哪些文档类型？每种类型多少个？")
    print(f"  Tool calls: {len(r1['tool_calls'])}, Compactions: {len(r1['compaction_events'])}")
    print(f"  Done: {r1['done']}")
    if r1['compaction_events']:
        for ce in r1['compaction_events']:
            print(f"  Compaction: turn={ce['turn']} method={ce['method']} saved={ce['tokensSaved']}")

    # Q2: Different topic - search for a specific document
    print("\n--- Q2: Search for specific document ---")
    r2 = run_agent_stream(sid, "搜索包含'逮捕'关键词的文档，告诉我有哪些相关文件")
    print(f"  Tool calls: {len(r2['tool_calls'])}, Compactions: {len(r2['compaction_events'])}")
    print(f"  Done: {r2['done']}")
    # Check: Q2 should NOT try to re-list document types
    issues = analyze_output(r2['output'], ["文档类型统计", "文件类型分布"], ["逮捕"])
    if issues:
        print(f"  ⚠️ Issues: {issues}")
    else:
        print(f"  ✓ No old task leakage detected")

    # Q3: Completely different topic
    print("\n--- Q3: Entity analysis ---")
    r3 = run_agent_stream(sid, "知识库中出现了哪些人名实体？列出主要人物")
    print(f"  Tool calls: {len(r3['tool_calls'])}, Compactions: {len(r3['compaction_events'])}")
    print(f"  Done: {r3['done']}")
    issues = analyze_output(r3['output'], ["文档类型统计", "逮捕证"], ["人名", "人物"])
    if issues:
        print(f"  ⚠️ Issues: {issues}")
    else:
        print(f"  ✓ No old task leakage detected")

    # Verify messages
    msgs = get_messages(sid)
    print(f"\n  Total messages in session: {len(msgs)}")
    delete_session(sid)
    print("  Session cleaned up")
    return True

# ============================================================================
# Test 2: Complex analysis then topic switch
# ============================================================================
def test_2():
    print("\n" + "="*70)
    print("TEST 2: Complex analysis → topic switch")
    print("="*70)
    sid = create_session("T2-analysis-switch")
    print(f"Session: {sid}")

    # Q1: Complex multi-step analysis
    print("\n--- Q1: Complex analysis ---")
    r1 = run_agent_stream(sid, "分析知识库中所有PDF文档的概况，包括数量、文件名列表、主要内容摘要")
    print(f"  Tool calls: {len(r1['tool_calls'])}, Compactions: {len(r1['compaction_events'])}")
    for tc in r1['tool_calls']:
        print(f"    {tc['name']} ({tc['status']})")
    print(f"  Done: {r1['done']}, Output length: {len(r1['output'])}")

    # Q2: Completely different topic
    print("\n--- Q2: Topic switch to entity search ---")
    r2 = run_agent_stream(sid, "搜索知识库中与'银行'或'账户'相关的所有内容")
    print(f"  Tool calls: {len(r2['tool_calls'])}, Compactions: {len(r2['compaction_events'])}")
    print(f"  Done: {r2['done']}")

    # Check: Q2 should focus on '银行'/'账户', not re-analyze PDFs
    if "PDF文档的概况" in r2['output'] or "文件名列表" in r2['output']:
        print(f"  ⚠️ Q2 re-mentions old task content!")
    else:
        print(f"  ✓ Q2 focuses on new topic")

    delete_session(sid)
    return True

# ============================================================================
# Test 3: Report generation + independent questions
# ============================================================================
def test_3():
    print("\n" + "="*70)
    print("TEST 3: Report generation + independent questions")
    print("="*70)
    sid = create_session("T3-report-then-qa")
    print(f"Session: {sid}")

    # Q1: Generate a report
    print("\n--- Q1: Ask for analysis (may trigger report) ---")
    r1 = run_agent_stream(sid, "分析知识库中的案件类型分布情况，给出统计结果")
    print(f"  Tool calls: {len(r1['tool_calls'])}, Compactions: {len(r1['compaction_events'])}")
    pushed = [tc for tc in r1['tool_calls'] if tc['name'] == 'push_content']
    print(f"  Push content calls: {len(pushed)}")
    print(f"  Done: {r1['done']}")

    # Q2: Unrelated question
    print("\n--- Q2: Unrelated question ---")
    r2 = run_agent_stream(sid, "知识库中有哪些音频文件？它们的文件名是什么？")
    print(f"  Tool calls: {len(r2['tool_calls'])}, Compactions: {len(r2['compaction_events'])}")
    print(f"  Done: {r2['done']}")
    # Should focus on audio files, not re-analyze cases
    if "案件类型分布" in r2['output'] and "音频" not in r2['output']:
        print(f"  ⚠️ Q2 re-analyzes cases instead of answering about audio files")
    else:
        print(f"  ✓ Q2 focuses on audio files")

    delete_session(sid)
    return True

# ============================================================================
# Test 4: Workflow + simple question
# ============================================================================
def test_4():
    print("\n" + "="*70)
    print("TEST 4: Workflow + simple question")
    print("="*70)
    sid = create_session("T4-workflow-simple")
    print(f"Session: {sid}")

    # Q1: Trigger workflow
    print("\n--- Q1: Request that may trigger workflow ---")
    r1 = run_agent_stream(sid, "对知识库中的前3个文档进行并行深度分析，每个文档提取关键信息和摘要")
    wf_calls = [tc for tc in r1['tool_calls'] if tc['name'] == 'workflow_run']
    print(f"  Tool calls: {len(r1['tool_calls'])}, workflow_run calls: {len(wf_calls)}")
    print(f"  Compactions: {len(r1['compaction_events'])}")
    print(f"  Done: {r1['done']}")

    # Q2: Simple unrelated question
    print("\n--- Q2: Simple question ---")
    r2 = run_agent_stream(sid, "知识库的名称是什么？里面有多少个文档？")
    wf_in_q2 = [tc for tc in r2['tool_calls'] if tc['name'] == 'workflow_run']
    print(f"  Tool calls: {len(r2['tool_calls'])}, workflow_run calls: {len(wf_in_q2)}")
    print(f"  Done: {r2['done']}")
    if wf_in_q2:
        print(f"  ⚠️ Q2 triggered workflow_run - old task re-execution!")
    else:
        print(f"  ✓ Q2 did not trigger workflow")

    delete_session(sid)
    return True

# ============================================================================
# Test 5: 5+ questions pressure test
# ============================================================================
def test_5():
    print("\n" + "="*70)
    print("TEST 5: 5+ questions pressure test")
    print("="*70)
    sid = create_session("T5-pressure-test")
    print(f"Session: {sid}")

    questions = [
        "知识库中有多少个文档？列出文件类型统计",
        "搜索与'起诉'相关的文档，列出文件名",
        "知识库中有哪些图片文件？",
        "搜索包含'合同'或'协议'的内容",
        "列出知识库中的所有Excel表格文件",
        "知识库中有没有视频文件？如果有，文件名是什么？",
    ]

    total_compactions = 0
    for i, q in enumerate(questions):
        print(f"\n--- Q{i+1}: {q[:40]}... ---")
        r = run_agent_stream(sid, q)
        total_compactions += len(r['compaction_events'])
        tc_names = [tc['name'] for tc in r['tool_calls']]
        print(f"  Tools: {tc_names}")
        print(f"  Compactions this round: {len(r['compaction_events'])}")
        print(f"  Done: {r['done']}")
        if r['compaction_events']:
            for ce in r['compaction_events']:
                print(f"    Compaction: turn={ce['turn']} method={ce['method']} saved={ce['tokensSaved']}")

    print(f"\n  Total compactions across 6 questions: {total_compactions}")

    # Check final message count
    msgs = get_messages(sid)
    print(f"  Total messages: {len(msgs)}")
    delete_session(sid)
    return True

# ============================================================================
# Main
# ============================================================================
if __name__ == "__main__":
    print("DeepAnalyze Multi-Turn Compaction Robustness Test")
    print("="*70)

    # Verify backend
    try:
        health = api("GET", "/api/health")
        print(f"Backend: {health}")
    except Exception as e:
        print(f"ERROR: Backend not running: {e}")
        sys.exit(1)

    tests = [test_1, test_2, test_3, test_4, test_5]
    for t in tests:
        try:
            t()
        except Exception as e:
            print(f"\n  ❌ Test failed: {e}")
            import traceback
            traceback.print_exc()

    print("\n" + "="*70)
    print("All tests completed")
    print("="*70)
