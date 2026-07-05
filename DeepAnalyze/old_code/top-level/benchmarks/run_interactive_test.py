#!/usr/bin/env python3
"""
Interactive Coordinator Test
=============================
Tests the coordinator agent's ability to receive follow-up instructions
mid-execution and dynamically adjust its task planning and sub-agent dispatching.

Usage:
    python3 benchmarks/run_interactive_test.py

Scenario:
1. Start a complex analysis task on bigtest3 KB
2. After 30s, inject a follow-up to add a specific document analysis
3. After 60s, inject a follow-up to change priorities (focus on a different aspect)
4. After 90s, inject a follow-up to request a summary of work done so far
5. Observe: coordinator adjusts plan, dispatches new sub-agents, handles interruptions

This tests:
- Coordinator's ability to incorporate new instructions mid-flight
- Dynamic task re-prioritization
- Sub-agent team reconfiguration
- Context continuity across injected messages
- Push content reflects the evolving task scope
"""

import json
import sys
import time
import threading
import urllib.request
import urllib.error
from datetime import datetime

BASE_URL = "http://localhost:21000"

KB_IDS = {
    "bigtest3": "89ee4db6-0626-4636-8c66-49a575d05832",
    "lbctest": "f65cb573-05c7-4098-ba7d-c26c006986ee",
}


def api(method, path, body=None, timeout=30):
    """Make an API call and return parsed JSON."""
    url = f"{BASE_URL}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else ""
        return {"error": f"HTTP {e.code}: {error_body[:500]}"}
    except Exception as e:
        return {"error": str(e)}


def run_interactive_test():
    print("=" * 70)
    print("Interactive Coordinator Test")
    print("=" * 70)

    # Step 1: Create a session
    print("\n[1] Creating session...")
    session = api("POST", "/api/sessions", {
        "title": "Interactive Coordinator Test",
        "kbScope": json.dumps([KB_IDS["bigtest3"]]),
    })
    session_id = session["id"]
    print(f"    Session: {session_id}")

    # Step 2: Start a complex analysis task via SSE stream
    # Use a prompt complex enough to trigger workflow_run (multi-agent dispatching)
    initial_prompt = (
        "请对知识库进行全面的深度分析。知识库包含多种类型的内容："
        "学术论文、剧本杀、表格数据、音频文件等。"
        "请针对每一类内容安排独立的子Agent进行深入分析："
        "1）学术论文：分析技术演进关系和未来方向；"
        "2）剧本杀：每个剧本杀分别分析推理逻辑和凶手判定；"
        "3）表格数据：统计分析数据内容和趋势；"
        "4）音频文件：分析音频内容和关联信息。"
        "最后综合所有子Agent的分析结果，给出整体知识库的深度分析报告。"
        "每个类别的分析报告都要推送给用户。"
    )
    print(f"\n[2] Starting initial task...")
    print(f"    Prompt: {initial_prompt[:80]}...")

    # Shared state
    task_id = None
    task_done = threading.Event()
    events = []
    push_contents = []
    workflow_events = []
    tool_calls = []
    start_time = time.time()
    lock = threading.Lock()

    # SSE reader thread
    def read_sse():
        nonlocal task_id
        url = f"{BASE_URL}/api/agents/run-stream"
        body = json.dumps({
            "sessionId": session_id,
            "input": initial_prompt,
            "scope": {"kbIds": [KB_IDS["bigtest3"]]},
        }).encode()
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "text/event-stream")

        try:
            with urllib.request.urlopen(req, timeout=1800) as resp:
                event_type = None
                data_buf = ""
                for raw_line in resp:
                    line = raw_line.decode("utf-8", errors="replace").rstrip("\n").rstrip("\r")
                    if line.startswith(":"):
                        continue  # keepalive
                    if line.startswith("event: "):
                        event_type = line[7:].strip()
                    elif line.startswith("data: "):
                        data_buf += line[6:]
                    elif line == "" and event_type and data_buf:
                        # Empty line = end of event
                        try:
                            event_data = json.loads(data_buf)
                        except:
                            event_data = data_buf
                        data_buf = ""

                        with lock:
                            t = time.time() - start_time
                            events.append({"type": event_type, "data": event_data, "time": t})

                        # Process event
                        if event_type == "start" and isinstance(event_data, dict):
                            task_id = event_data.get("taskId")
                            print(f"    Task started: {task_id}")

                        elif event_type == "push_content" and isinstance(event_data, dict):
                            title = event_data.get("title", "?")[:50]
                            elapsed = time.time() - start_time
                            print(f"    @{elapsed:.0f}s [PUSH] {title}")
                            with lock:
                                push_contents.append(event_data)

                        elif event_type == "workflow_event" and isinstance(event_data, dict):
                            wtype = event_data.get("type", "?")
                            if "agent_start" in wtype:
                                role = event_data.get("role", "?")
                                elapsed = time.time() - start_time
                                print(f"    @{elapsed:.0f}s [WORKFLOW] Agent started: {role}")
                            elif "agent_complete" in wtype:
                                role = event_data.get("agentId", "?")
                                elapsed = time.time() - start_time
                                print(f"    @{elapsed:.0f}s [WORKFLOW] Agent completed: {role}")
                            elif "complete" in wtype and "agent" not in wtype:
                                elapsed = time.time() - start_time
                                print(f"    @{elapsed:.0f}s [WORKFLOW] Workflow complete")
                            with lock:
                                workflow_events.append(event_data)

                        elif event_type == "tool_call" and isinstance(event_data, dict):
                            tool_name = event_data.get("toolName", "?")
                            if tool_name not in ("think",):
                                elapsed = time.time() - start_time
                                with lock:
                                    tool_calls.append((elapsed, tool_name))

                        elif event_type == "done":
                            elapsed = time.time() - start_time
                            print(f"    @{elapsed:.0f}s [DONE] Task completed")
                            task_done.set()

                        elif event_type == "error":
                            elapsed = time.time() - start_time
                            print(f"    @{elapsed:.0f}s [ERROR] {event_data}")

                        event_type = None
        except Exception as e:
            if not task_done.is_set():
                print(f"    [SSE] Error: {e}")
                task_done.set()

    sse_thread = threading.Thread(target=read_sse, daemon=True)
    sse_thread.start()

    # Wait for taskId
    print("\n[3] Waiting for task to start...")
    for _ in range(30):
        if task_id:
            break
        time.sleep(1)
    if not task_id:
        print("    ERROR: Task never started!")
        return
    print(f"    Task ID: {task_id}")

    # Step 3: Inject follow-up messages at intervals
    inject_schedule = [
        (45, "追加任务：我发现知识库里还有一些视频文件，请增加一个子Agent来分析视频内容，"
             "结合其他模态的数据进行跨模态关联分析。请把这个任务加入到工作计划中。"),
        (90, "方向调整：我现在最关心的是所有剧本杀内容的深度分析结果。"
             "如果还没有开始分析剧本杀，请优先安排。"
             "另外请把每个剧本杀的分析结果单独推送给我，我需要看详细推理过程。"),
        (150, "进度检查：请汇总一下目前已完成的子Agent工作和推送的报告。"
             "告诉我还有哪些任务在进行中或尚未开始。"
             "如果有些任务来不及完成，请告诉我哪些最重要。"),
    ]

    for delay, message in inject_schedule:
        elapsed = time.time() - start_time
        remaining = delay - elapsed
        if remaining > 0:
            print(f"\n    Waiting {remaining:.0f}s before next injection...")
            # Check every second if task is done
            for _ in range(int(remaining)):
                if task_done.is_set():
                    break
                time.sleep(1)

        if task_done.is_set():
            print("    Task already completed, skipping injection.")
            break

        print(f"\n[INJECT @{delay}s] {message[:80]}...")
        result = api("POST", f"/api/agents/inject/{task_id}", {"message": message})
        print(f"    Result: {result}")

    # Step 4: Wait for task completion (with timeout)
    print("\n[4] Waiting for task completion...")
    max_wait = 600  # 10 minutes total
    task_done.wait(timeout=max_wait - (time.time() - start_time))

    total_time = time.time() - start_time

    # Step 5: Analyze results
    print("\n" + "=" * 70)
    print("RESULTS ANALYSIS")
    print("=" * 70)

    with lock:
        total_events = len(events)
        total_pushes = len(push_contents)
        total_workflows = len(workflow_events)
        total_tools = len(tool_calls)

    print(f"\nTotal time: {total_time:.0f}s")
    print(f"Total events: {total_events}")
    print(f"Push contents: {total_pushes}")
    print(f"Workflow events: {total_workflows}")
    print(f"Tool calls: {total_tools}")
    print(f"Task completed: {task_done.is_set()}")

    # Analyze sub-agent dispatching
    with lock:
        agent_starts = [e for e in events
                        if e["type"] == "workflow_event"
                        and isinstance(e["data"], dict)
                        and "agent_start" in e["data"].get("type", "")]
    print(f"\n--- Sub-agents Dispatched: {len(agent_starts)} ---")
    for e in agent_starts:
        data = e["data"]
        role = data.get("role", "?")
        agent_time = e["time"]
        print(f"  @{agent_time:.0f}s: {role}")

    # Analyze push contents
    print(f"\n--- Push Contents: {total_pushes} ---")
    with lock:
        for i, pc in enumerate(push_contents):
            title = pc.get("title", "?")[:60]
            # Find the event time for this push
            push_time = 0
            for e in events:
                if e["type"] == "push_content" and e["data"] is pc:
                    push_time = e["time"]
                    break
            print(f"  [{i+1}] @{push_time:.0f}s: {title}")

    # Analyze injection responses
    print("\n--- Injection Response Analysis ---")
    for i, (delay, msg) in enumerate(inject_schedule):
        # Find tool calls within 30s after injection
        with lock:
            nearby_tools = [(t, name) for t, name in tool_calls
                           if delay < t < delay + 30]
        if nearby_tools:
            print(f"  Inject {i+1} (@{delay}s): {len(nearby_tools)} tool calls in next 30s")
            for t, name in nearby_tools[:5]:
                print(f"    @{t:.0f}s: {name}")
        else:
            print(f"  Inject {i+1} (@{delay}s): No tool calls detected in next 30s")

    # Save results
    with lock:
        result_data = {
            "testName": "interactive-coordinator-test",
            "sessionId": session_id,
            "taskId": task_id,
            "totalTime": total_time,
            "totalEvents": total_events,
            "pushCount": total_pushes,
            "workflowCount": total_workflows,
            "toolCallCount": total_tools,
            "taskCompleted": task_done.is_set(),
            "injectMessages": [(d, m[:80]) for d, m in inject_schedule],
            "pushTitles": [pc.get("title", "?") for pc in push_contents],
            "subAgentRoles": [e["data"].get("role", "?") for e in agent_starts],
            "events": [{"type": e["type"], "time": round(e["time"], 1),
                         "data": str(e["data"])[:200]} for e in events],
        }

    output_file = "benchmarks/results/interactive-test-result.json"
    with open(output_file, "w") as f:
        json.dump(result_data, f, ensure_ascii=False, indent=2)
    print(f"\nResults saved to {output_file}")

    return result_data


if __name__ == "__main__":
    result = run_interactive_test()
