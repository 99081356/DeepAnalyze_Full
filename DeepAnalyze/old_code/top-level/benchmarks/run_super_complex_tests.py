#!/usr/bin/env python3
"""
Super Complex Test Suite - 20 Multi-Agent System Verification Tests
====================================================================
Comprehensive end-to-end testing of the DeepAnalyze multi-agent system.
Tests cover: full KB analysis, evidence chain construction, academic analysis,
murder mystery reasoning, financial calculation, multimodal analysis,
cross-KB analysis, fact verification, and concurrent stress testing.

Usage:
    # List all test cases
    python3 benchmarks/run_super_complex_tests.py --list

    # Run a single case
    python3 benchmarks/run_super_complex_tests.py --case-id SC01

    # Run by category
    python3 benchmarks/run_super_complex_tests.py --category full-kb-analysis

    # Run all (skip evaluation for speed)
    python3 benchmarks/run_super_complex_tests.py --skip-eval

    # Run in batches
    python3 benchmarks/run_super_complex_tests.py --batch 1 --batch-size 5

    # Resume from a previous run
    python3 benchmarks/run_super_complex_tests.py --resume results/super-complex-results.json

    # Report only
    python3 benchmarks/run_super_complex_tests.py --report-only results/super-complex-results.json
"""

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_URL = os.environ.get("DEEPANALYZE_URL", "http://localhost:21000")

# Evaluation LLM config
EVAL_MODEL = os.environ.get("EVAL_MODEL", "glm-5.1")
EVAL_ENDPOINT = os.environ.get("EVAL_ENDPOINT", "https://api.z.ai/api/anthropic")
EVAL_API_KEY = os.environ.get(
    "EVAL_API_KEY", "59a816c2acd54338a773936fefc0cb77.FgAcgymYXgYQmEbk"
)

# KB name -> UUID mapping
KB_IDS = {
    "bigtest3": "89ee4db6-0626-4636-8c66-49a575d05832",
    "lbctest": "f65cb573-05c7-4098-ba7d-c26c006986ee",
}

# Benchmark QA file for SC05
BENCHMARK_QA_FILE = Path(__file__).parent / "agent-ability-test-50.json"

TEST_FILE = Path(__file__).parent / "super-complex-test-cases.json"
RESULTS_DIR = Path(__file__).parent / "results"
RESULTS_DIR.mkdir(parents=True, exist_ok=True)
RESULT_FILE = RESULTS_DIR / "super-complex-results.json"

DEFAULT_TIMEOUT = 1800  # 30 minutes
MAX_OUTPUT_CHARS = 80000  # Max chars to keep from output for evaluation


# ---------------------------------------------------------------------------
# HTTP Helpers
# ---------------------------------------------------------------------------


def api_request(
    method: str, path: str, data: dict | None = None, timeout: int = 30
) -> Any:
    """Make an API request and return parsed JSON response."""
    url = f"{BASE_URL}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode() if e.fp else ""
        return {"error": f"HTTP {e.code}: {error_body[:500]}"}
    except Exception as e:
        return {"error": str(e)}


def sse_stream(path: str, data: dict, timeout: int = 1800):
    """Send a request and yield SSE events as (event_type, data_dict) tuples."""
    url = f"{BASE_URL}{path}"
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "text/event-stream")

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            event_type = None
            data_buf = ""
            for raw_line in resp:
                line = (
                    raw_line.decode("utf-8", errors="replace")
                    .rstrip("\n")
                    .rstrip("\r")
                )
                if line.startswith(":"):
                    continue  # keepalive
                if line.startswith("event: "):
                    event_type = line[7:].strip()
                elif line.startswith("data: "):
                    data_buf += line[6:]
                elif line == "":
                    if event_type and data_buf:
                        try:
                            parsed = json.loads(data_buf)
                        except json.JSONDecodeError:
                            parsed = {"raw": data_buf}
                        yield event_type, parsed
                    event_type = None
                    data_buf = ""
    except Exception as e:
        yield "error", {"error": str(e)}


# ---------------------------------------------------------------------------
# Test Case Loading
# ---------------------------------------------------------------------------


def load_test_cases() -> list[dict]:
    """Load test cases from super-complex-test-cases.json."""
    if not TEST_FILE.exists():
        print(f"ERROR: Test file not found: {TEST_FILE}")
        sys.exit(1)

    with open(TEST_FILE, "r", encoding="utf-8") as f:
        cases = json.load(f)

    # Map kb_scope names to UUIDs
    for case in cases:
        kb_scope_uuids = []
        for name in case.get("kb_scope", []):
            if name in KB_IDS:
                kb_scope_uuids.append(KB_IDS[name])
            else:
                print(f"WARNING: Unknown KB name '{name}' in case {case['id']}")
        case["_kb_scope_uuids"] = kb_scope_uuids

        # Also resolve UUIDs for concurrent tasks
        for ct in case.get("concurrent_tasks", []):
            ct_uuids = []
            for name in ct.get("kb_scope", []):
                if name in KB_IDS:
                    ct_uuids.append(KB_IDS[name])
            ct["_kb_scope_uuids"] = ct_uuids

    return cases


def load_benchmark_qa() -> list[dict]:
    """Load benchmark QA questions for SC05."""
    if not BENCHMARK_QA_FILE.exists():
        return []
    with open(BENCHMARK_QA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def build_sc05_prompt() -> str:
    """Build the full prompt for SC05 with all 50 benchmark questions."""
    questions = load_benchmark_qa()
    if not questions:
        return "请根据案件卷宗，回答所有相关问题。"

    # Filter lbctest questions
    lbctest_qs = [q for q in questions if "lbctest" in q.get("kb_scope", [])]
    if not lbctest_qs:
        lbctest_qs = questions[:50]

    parts = ["请根据案件卷宗，逐一回答以下问题，每个问题必须给出明确的答案和推理过程，并标注信息来源文件。\n"]
    for i, q in enumerate(lbctest_qs, 1):
        parts.append(f"\n问题{i}：{q['question']}")
        if q.get("expected_answer"):
            parts.append(f"（参考答案仅供评估用：{q['expected_answer']}）")

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Session Management
# ---------------------------------------------------------------------------


def create_session(title: str, kb_scope_uuids: list[str]) -> str:
    """Create a test session with KB scope and return its ID."""
    result = api_request(
        "POST", "/api/sessions", {"title": title, "kbScope": kb_scope_uuids}
    )
    if "error" in result:
        raise RuntimeError(f"Failed to create session: {result['error']}")
    return result["id"]


def delete_session(session_id: str):
    """Delete a test session."""
    api_request("DELETE", f"/api/sessions/{session_id}")


# ---------------------------------------------------------------------------
# Single Test Execution
# ---------------------------------------------------------------------------


def run_single_test(case: dict) -> dict:
    """Execute a single test case (non-concurrent) and collect all process data."""
    timeout = case.get("timeout", DEFAULT_TIMEOUT)

    # Handle SC05 - inject benchmark questions
    prompt = case["prompt"]
    if case["id"] == "SC05":
        prompt = build_sc05_prompt()

    session_id = create_session(
        f"sct-{case['id']}-{datetime.now().strftime('%H%M%S')}",
        case["_kb_scope_uuids"],
    )

    result = {
        "case_id": case["id"],
        "name": case.get("name", ""),
        "category": case["category"],
        "difficulty": case["difficulty"],
        "kb_scope": case.get("kb_scope", []),
        "session_id": session_id,
        "prompt": prompt[:500],
        "started_at": datetime.now().isoformat(),
        "tool_calls": [],
        "push_contents": [],
        "thinking_deltas": [],
        "content_deltas": [],
        "turns": 0,
        "full_content": "",
        "errors": [],
        "completed": False,
        "timeout": timeout,
        # Process quality metrics
        "workflow_events": [],
        "compaction_events": [],
        "todo_updates": [],
    }

    print(f"  Session: {session_id}")
    print(f"  Query: {prompt[:100]}...")
    print(f"  Timeout: {timeout}s")

    try:
        for event_type, event_data in sse_stream(
            "/api/agents/run-stream",
            {"sessionId": session_id, "input": prompt},
            timeout=timeout,
        ):
            _process_sse_event(event_type, event_data, result)
    except Exception as e:
        result["errors"].append(f"Stream error: {str(e)}")

    _finalize_result(result)
    return result


def run_concurrent_subtask(task_def: dict, task_id: str) -> dict:
    """Run a single concurrent subtask (for SC20)."""
    session_id = create_session(
        f"sct-{task_id}-{datetime.now().strftime('%H%M%S')}",
        task_def["_kb_scope_uuids"],
    )

    result = {
        "case_id": task_id,
        "name": task_def.get("name", ""),
        "session_id": session_id,
        "started_at": datetime.now().isoformat(),
        "tool_calls": [],
        "push_contents": [],
        "turns": 0,
        "full_content": "",
        "errors": [],
        "completed": False,
        "workflow_events": [],
        "compaction_events": [],
    }

    print(f"  [{task_id}] Session: {session_id}")
    print(f"  [{task_id}] Starting...")

    try:
        for event_type, event_data in sse_stream(
            "/api/agents/run-stream",
            {"sessionId": session_id, "input": task_def["prompt"]},
            timeout=DEFAULT_TIMEOUT,
        ):
            _process_sse_event(event_type, event_data, result, prefix=task_id)
    except Exception as e:
        result["errors"].append(f"Stream error: {str(e)}")

    _finalize_result(result)
    return result


def _process_sse_event(
    event_type: str, event_data: dict, result: dict, prefix: str = ""
):
    """Process a single SSE event and update result dict."""
    prefix_str = f"  [{prefix}] " if prefix else "  "

    if event_type == "start":
        result["task_id"] = event_data.get("taskId")
    elif event_type == "content_delta":
        delta = event_data.get("delta", "")
        result["content_deltas"].append(delta)
        result["full_content"] += delta
    elif event_type == "turn":
        result["turns"] = event_data.get("turn", 0)
    elif event_type == "turn_usage":
        result.setdefault("usage", []).append(event_data.get("usage", {}))
    elif event_type == "tool_call":
        result["tool_calls"].append(
            {
                "tool": event_data.get("toolName"),
                "input": event_data.get("input"),
                "status": "running",
            }
        )
    elif event_type == "tool_result":
        tool_name = event_data.get("toolName", "")
        for tc in reversed(result["tool_calls"]):
            if tc["tool"] == tool_name and tc["status"] == "running":
                tc["status"] = "completed"
                tc["output_preview"] = str(event_data.get("output", ""))[:200]
                break
    elif event_type == "push_content":
        result["push_contents"].append(
            {
                "type": event_data.get("type"),
                "title": event_data.get("title"),
                "data_length": event_data.get("dataLength", 0),
            }
        )
    elif event_type == "complete":
        result["completed"] = True
        result["turns"] = event_data.get("turns", result["turns"])
        result.setdefault("usage_summary", event_data.get("usage"))
    elif event_type == "done":
        result["done_data"] = event_data
    elif event_type == "error":
        result["errors"].append(event_data.get("error", "unknown"))
    elif event_type == "compaction":
        result["compaction_events"].append(
            {
                "timestamp": datetime.now().isoformat(),
                "type": event_data.get("type", "unknown"),
            }
        )
    elif event_type == "thinking":
        result["thinking_deltas"].append(event_data.get("delta", ""))
    elif event_type == "workflow_event":
        result["workflow_events"].append(
            {
                "timestamp": datetime.now().isoformat(),
                "event": event_data.get("event", "unknown"),
                "agentId": event_data.get("agentId", ""),
            }
        )
    elif event_type == "workflow_complete":
        result["workflow_events"].append(
            {
                "timestamp": datetime.now().isoformat(),
                "event": "workflow_complete",
                "agentCount": event_data.get("agentCount", 0),
            }
        )
    elif event_type == "todo_update":
        result["todo_updates"].append(event_data)


def _finalize_result(result: dict):
    """Compute derived metrics from raw SSE events."""
    result["finished_at"] = datetime.now().isoformat()
    result["duration_seconds"] = (
        datetime.fromisoformat(result["finished_at"])
        - datetime.fromisoformat(result["started_at"])
    ).total_seconds()

    # Tool call summary
    tool_counts = {}
    for tc in result["tool_calls"]:
        tool_counts[tc["tool"]] = tool_counts.get(tc["tool"], 0) + 1
    result["tool_call_summary"] = tool_counts
    result["total_tool_calls"] = len(result["tool_calls"])

    # Trim content for storage (keep full content but cap for evaluation)
    result["full_content_length"] = len(result["full_content"])
    if len(result["full_content"]) > MAX_OUTPUT_CHARS:
        result["full_content_trimmed"] = result["full_content"][:MAX_OUTPUT_CHARS]
    else:
        result["full_content_trimmed"] = result["full_content"]

    # Print summary
    print(
        f"  Turns: {result['turns']}, Tools: {tool_counts}, Duration: {result['duration_seconds']:.1f}s"
    )
    print(f"  Output length: {result['full_content_length']} chars")
    if result["errors"]:
        print(f"  Errors: {result['errors']}")
    if result["push_contents"]:
        print(f"  Push contents: {len(result['push_contents'])}")
    if result.get("compaction_events"):
        print(f"  Compactions: {len(result['compaction_events'])}")
    if result.get("workflow_events"):
        print(f"  Workflow events: {len(result['workflow_events'])}")


# ---------------------------------------------------------------------------
# Concurrent Test Execution (SC20)
# ---------------------------------------------------------------------------


def run_concurrent_test(case: dict) -> dict:
    """Run SC20 - concurrent stress test with two parallel sessions."""
    concurrent_tasks = case.get("concurrent_tasks", [])
    if not concurrent_tasks:
        return {
            "case_id": case["id"],
            "name": case["name"],
            "errors": ["No concurrent tasks defined"],
            "completed": False,
        }

    print(f"  Launching {len(concurrent_tasks)} concurrent sessions...")

    overall_result = {
        "case_id": case["id"],
        "name": case["name"],
        "category": case["category"],
        "difficulty": case["difficulty"],
        "kb_scope": case.get("kb_scope", []),
        "started_at": datetime.now().isoformat(),
        "subtask_results": [],
        "errors": [],
        "completed": False,
    }

    # Run all subtasks in parallel using threads
    sub_results = []
    with ThreadPoolExecutor(max_workers=len(concurrent_tasks)) as executor:
        futures = {}
        for task_def in concurrent_tasks:
            task_id = task_def["id"]
            future = executor.submit(run_concurrent_subtask, task_def, task_id)
            futures[future] = task_id

        for future in as_completed(futures):
            task_id = futures[future]
            try:
                sub_result = future.result()
                sub_results.append(sub_result)
                print(
                    f"  [{task_id}] Completed: {sub_result['full_content_length']} chars, "
                    f"{sub_result['duration_seconds']:.1f}s"
                )
            except Exception as e:
                sub_results.append(
                    {"case_id": task_id, "errors": [str(e)], "completed": False}
                )
                print(f"  [{task_id}] FAILED: {e}")

    overall_result["subtask_results"] = sub_results
    overall_result["finished_at"] = datetime.now().isoformat()
    overall_result["duration_seconds"] = (
        datetime.fromisoformat(overall_result["finished_at"])
        - datetime.fromisoformat(overall_result["started_at"])
    ).total_seconds()

    # Check isolation: verify no cross-contamination
    isolation_ok = True
    for sr in sub_results:
        content = sr.get("full_content", "")
        task_id = sr.get("case_id", "")
        # SC20A (lbctest) should not contain剧本杀 content
        # SC20B (bigtest3) should not contain 法律/criminal content from lbctest
        if "SC20A" in task_id:
            for keyword in ["自杀派对", "柯南之死", "剪烛夜行", "追凶手记"]:
                if keyword in content:
                    print(
                        f"  ISOLATION WARNING: SC20A contains bigtest3 content: {keyword}"
                    )
                    isolation_ok = False
        elif "SC20B" in task_id:
            for keyword in ["组织卖淫", "雅诗阁", "张伟", "SPA会所"]:
                if keyword in content:
                    print(
                        f"  ISOLATION WARNING: SC20B contains lbctest content: {keyword}"
                    )
                    isolation_ok = False

    overall_result["isolation_check"] = isolation_ok
    overall_result["completed"] = all(
        sr.get("completed", False) for sr in sub_results
    )

    # Combine full content for evaluation
    combined_content = "\n\n---\n\n".join(
        f"## {sr.get('case_id', 'unknown')}\n{sr.get('full_content', '')}"
        for sr in sub_results
    )
    overall_result["full_content"] = combined_content
    overall_result["full_content_length"] = len(combined_content)
    overall_result["full_content_trimmed"] = combined_content[:MAX_OUTPUT_CHARS]

    # Aggregate tool calls
    all_tools = []
    all_push = []
    for sr in sub_results:
        all_tools.extend(sr.get("tool_calls", []))
        all_push.extend(sr.get("push_contents", []))
    overall_result["tool_calls"] = all_tools
    overall_result["push_contents"] = all_push
    tool_counts = {}
    for tc in all_tools:
        tool_counts[tc["tool"]] = tool_counts.get(tc["tool"], 0) + 1
    overall_result["tool_call_summary"] = tool_counts
    overall_result["total_tool_calls"] = len(all_tools)

    print(f"\n  Overall: {overall_result['duration_seconds']:.1f}s")
    print(
        f"  Isolation: {'PASS' if isolation_ok else 'FAIL'}"
    )
    print(f"  Both completed: {overall_result['completed']}")

    return overall_result


# ---------------------------------------------------------------------------
# LLM-based Evaluation
# ---------------------------------------------------------------------------


def evaluate_result(case: dict, result: dict) -> dict:
    """Evaluate a test result using LLM assessment with domain-specific criteria."""
    answer_text = result.get("full_content", "")

    if not result.get("completed") and not answer_text:
        return {
            "completeness_score": 0,
            "accuracy_score": 0,
            "non_redundancy_score": 0,
            "collaboration_score": 0,
            "output_quality_score": 0,
            "total_score": 0,
            "verdict": "FAIL",
            "reason": "Agent failed to produce any output",
            "issues": ["no_output"],
        }

    # Include finish tool summary if present
    for tc in result.get("tool_calls", []):
        if tc.get("tool") == "finish" and tc.get("input", {}).get("summary"):
            finish_summary = tc["input"]["summary"]
            if finish_summary and len(finish_summary) > 10:
                if not answer_text.strip():
                    answer_text = (
                        f"[Agent's final answer (via finish tool)]:\n{finish_summary}"
                    )
                else:
                    answer_text += (
                        f"\n\n[Agent's final answer summary]:\n{finish_summary}"
                    )
            break

    # Build evaluation criteria text
    criteria_text = "\n".join(
        f"- {c}" for c in case.get("verification_criteria", [])
    )
    if not criteria_text:
        criteria_text = "信息准确完整，不编造信息"

    # Build expected output
    expected_text = case.get("expected_output", "无参考答案")

    # Build push content summary
    push_text = ""
    if result.get("push_contents"):
        push_text = "\n".join(
            f"### {pc.get('title', 'Untitled')} ({pc.get('type', 'unknown')})\n"
            f"[Data length: {pc.get('data_length', 0)} chars]"
            for pc in result["push_contents"]
        )

    # Build process metrics
    process_info = ""
    if result.get("tool_call_summary"):
        process_info += f"工具调用统计: {json.dumps(result['tool_call_summary'], ensure_ascii=False)}\n"
    if result.get("workflow_events"):
        process_info += f"工作流事件数: {len(result['workflow_events'])}\n"
    if result.get("compaction_events"):
        process_info += f"上下文压缩次数: {len(result['compaction_events'])}\n"
    process_info += f"输出总字符数: {result.get('full_content_length', 0)}\n"
    process_info += f"执行时间: {result.get('duration_seconds', 0):.1f}秒\n"

    # Handle SC20 concurrent test evaluation
    if case.get("concurrent"):
        subtask_info = ""
        for sr in result.get("subtask_results", []):
            subtask_info += (
                f"- {sr.get('case_id', '?')}: {sr.get('full_content_length', 0)} chars, "
                f"completed={sr.get('completed', False)}\n"
            )
        isolation = result.get("isolation_check", False)

        eval_prompt = f"""你是一个严格的测试评估员。请评估以下并发压力测试的结果质量。

## 测试类型
终极压力测试 — 同时运行两个复杂任务

## 两个并发任务
{subtask_info}

## 隔离性检查
{'通过' if isolation else '未通过（存在跨Session内容串台）'}

## 预期
两个Session互不干扰、各自输出完整、无内容串台、系统不崩溃

## 评估标准
{criteria_text}

## 评估要求
请按以下标准打分（0-100分）：
1. **完整性** (20分): 两个任务是否都完成了？
2. **准确性** (20分): 各自的内容是否准确？
3. **非冗余** (15分): 无重复内容
4. **隔离性** (15分): 两个任务互不干扰
5. **输出质量** (15分): 结构清晰、易读
6. **协作质量** (15分): Agent工作流合理

以JSON格式输出：
```json
{{
  "completeness_score": 0-20,
  "accuracy_score": 0-20,
  "non_redundancy_score": 0-15,
  "isolation_score": 0-15,
  "output_quality_score": 0-15,
  "collaboration_score": 0-15,
  "total_score": 0-100,
  "verdict": "PASS" or "FAIL",
  "reason": "简短评价",
  "issues": ["问题1", "问题2"]
}}
```
PASS标准：total_score >= 60分。"""
    else:
        eval_prompt = f"""你是一个严格的测试评估员。请评估以下AI Agent针对一个复杂分析任务的输出质量。

## 测试名称
{case.get('name', case['id'])}

## 测试提示词
{case['prompt'][:3000]}

## 评估标准
{criteria_text}

## 预期输出
{expected_text}

## 过程指标
{process_info}

## Agent的输出（截取前{MAX_OUTPUT_CHARS}字符）
{answer_text[:MAX_OUTPUT_CHARS]}
"""

        if push_text:
            eval_prompt += f"""
## Agent还通过push_content输出了以下内容卡片
{push_text}
注意：卡片内容也是Agent结果的一部分，应视为有效输出。
"""

        eval_prompt += """
## 评估要求
请按以下标准打分（0-100分）：
1. **完整性** (25分): 是否完整覆盖了所有要求的方面？有无遗漏关键信息？
2. **准确性** (25分): 信息是否准确？有没有幻觉或编造？数字、人名、日期是否精确？
3. **非冗余** (15分): 有无重复内容？推送是否多余？
4. **Agent协作质量** (15分): 是否使用了多Agent协作？分工是否合理？审计是否有效？
5. **输出质量** (20分): 结构是否清晰？信息是否易于理解？格式是否好？

以JSON格式输出：
```json
{
  "completeness_score": 0-25,
  "accuracy_score": 0-25,
  "non_redundancy_score": 0-15,
  "collaboration_score": 0-15,
  "output_quality_score": 0-20,
  "total_score": 0-100,
  "verdict": "PASS" or "FAIL",
  "reason": "简短评价",
  "issues": ["问题1", "问题2"]
}
```
PASS标准：total_score >= 60分。"""

    # Call LLM for evaluation
    try:
        payload = {
            "model": EVAL_MODEL,
            "max_tokens": 2000,
            "messages": [{"role": "user", "content": eval_prompt}],
        }
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{EVAL_ENDPOINT}/v1/messages", data=body, method="POST"
        )
        req.add_header("Content-Type", "application/json")
        req.add_header("x-api-key", EVAL_API_KEY)
        req.add_header("anthropic-version", "2023-06-01")

        with urllib.request.urlopen(req, timeout=120) as resp:
            response = json.loads(resp.read().decode())
            text = ""
            for block in response.get("content", []):
                if block.get("type") == "text":
                    text += block.get("text", "")

            eval_result = extract_json(text)
            if eval_result and "total_score" in eval_result:
                if eval_result.get("total_score", 0) >= 60:
                    eval_result.setdefault("verdict", "PASS")
                else:
                    eval_result.setdefault("verdict", "FAIL")
                return eval_result
            return {
                "total_score": 50,
                "verdict": "UNCERTAIN",
                "reason": f"Could not parse eval response: {text[:200]}",
                "raw_eval": text[:500],
            }
    except Exception as e:
        return {
            "total_score": -1,
            "verdict": "EVAL_ERROR",
            "reason": str(e),
            "issues": [str(e)],
        }


def extract_json(text: str) -> dict | None:
    """Extract JSON from text that may contain markdown code blocks."""
    match = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    match = re.search(r'\{[^{}]*"total_score"[^{}]*\}', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    return None


# ---------------------------------------------------------------------------
# SC05 Specific Evaluation (Benchmark QA)
# ---------------------------------------------------------------------------


def evaluate_sc05_benchmark(result: dict) -> dict:
    """Evaluate SC05 against the benchmark QA for automatic scoring."""
    questions = load_benchmark_qa()
    lbctest_qs = [q for q in questions if "lbctest" in q.get("kb_scope", [])]
    if not lbctest_qs:
        lbctest_qs = questions[:50]

    answer_text = result.get("full_content", "")
    if not answer_text:
        return {"score": 0, "total": len(lbctest_qs), "details": []}

    # Simple keyword matching for each question
    correct = 0
    details = []
    for q in lbctest_qs:
        expected = q.get("expected_answer", "")
        question = q.get("question", "")
        # Check if key facts from expected answer appear in the output
        # Extract key numbers and names from expected answer
        key_terms = extract_key_terms(expected)
        found = sum(1 for term in key_terms if term in answer_text)
        ratio = found / len(key_terms) if key_terms else 0
        is_correct = ratio >= 0.5  # At least half the key terms found

        if is_correct:
            correct += 1
        details.append(
            {
                "question": question[:100],
                "expected": expected[:100],
                "key_terms_found": f"{found}/{len(key_terms)}",
                "correct": is_correct,
            }
        )

    accuracy = correct / len(lbctest_qs) * 100 if lbctest_qs else 0
    return {
        "score": correct,
        "total": len(lbctest_qs),
        "accuracy": f"{accuracy:.1f}%",
        "details": details,
    }


def extract_key_terms(text: str) -> list[str]:
    """Extract key terms (numbers, dates, names) from text for matching."""
    terms = []
    # Extract numbers (including Chinese format)
    terms.extend(re.findall(r"\d+\.?\d*[万%]?", text))
    # Extract dates
    terms.extend(re.findall(r"\d{4}年\d{1,2}月\d{1,2}日?", text))
    terms.extend(re.findall(r"\d{1,2}月\d{1,2}日", text))
    # Extract names (2-3 char Chinese names)
    terms.extend(re.findall(r"[\u4e00-\u9fff]{2,3}", text)[:5])
    # Extract other significant terms
    for term in ["组织卖淫", "深圳", "南山", "福田", "雅诗阁", "SPA"]:
        if term in text:
            terms.append(term)

    return [t for t in terms if len(t) >= 2]


# ---------------------------------------------------------------------------
# Process Quality Analysis
# ---------------------------------------------------------------------------


def analyze_process_quality(result: dict) -> dict:
    """Analyze the quality of the agent's process (tool calls, workflow, etc.)."""
    tool_calls = result.get("tool_calls", [])
    tool_summary = result.get("tool_call_summary", {})

    # Check for workflow usage
    used_workflow = any(
        tc["tool"] == "workflow_run" for tc in tool_calls
    )
    workflow_event_count = len(result.get("workflow_events", []))

    # Check tool diversity
    unique_tools = len(tool_summary)

    # Check for compaction
    compaction_count = len(result.get("compaction_events", []))

    # Check tool specialization (if one tool >60% of calls)
    total_calls = len(tool_calls)
    over_specialized = False
    dominant_tool = None
    if total_calls > 5:
        for tool, count in tool_summary.items():
            if count / total_calls > 0.6:
                over_specialized = True
                dominant_tool = tool
                break

    # Estimate collaboration quality
    collaboration_indicators = 0
    if used_workflow:
        collaboration_indicators += 3
    if workflow_event_count > 0:
        collaboration_indicators += 2
    if unique_tools >= 4:
        collaboration_indicators += 1

    return {
        "used_workflow": used_workflow,
        "workflow_event_count": workflow_event_count,
        "unique_tools": unique_tools,
        "total_tool_calls": total_calls,
        "compaction_count": compaction_count,
        "over_specialized": over_specialized,
        "dominant_tool": dominant_tool,
        "collaboration_indicators": collaboration_indicators,
    }


# ---------------------------------------------------------------------------
# Batch Runner
# ---------------------------------------------------------------------------


def load_existing_results(result_file: Path) -> dict[str, dict]:
    """Load existing results for resume support. Returns {case_id: result}."""
    if not result_file.exists():
        return {}
    try:
        data = json.loads(result_file.read_text(encoding="utf-8"))
        results_list = data.get("results", [])
        return {r["case_id"]: r for r in results_list}
    except Exception:
        return {}


def run_tests(
    cases: list[dict],
    skip_eval: bool = False,
    resume_file: Path | None = None,
) -> list[dict]:
    """Run test cases and return results."""
    # Load existing results for resume
    existing = {}
    if resume_file:
        existing = load_existing_results(resume_file)
        if existing:
            print(f"Loaded {len(existing)} existing results from {resume_file}")

    results = []
    total = len(cases)

    for i, case in enumerate(cases):
        case_id = case["id"]

        # Skip if already completed
        if case_id in existing:
            print(f"\n[{i+1}/{total}] {case_id}: SKIPPED (already in results)")
            results.append(existing[case_id])
            continue

        print(
            f"\n{'='*70}"
        )
        print(
            f"[{i+1}/{total}] {case_id}: {case.get('name', '')}"
        )
        print(f"  Category: {case['category']}, Difficulty: {case['difficulty']}")
        print(f"  KB: {', '.join(case.get('kb_scope', []))}")

        # Run test
        try:
            if case.get("concurrent"):
                result = run_concurrent_test(case)
            else:
                result = run_single_test(case)
        except Exception as e:
            result = {
                "case_id": case_id,
                "name": case.get("name", ""),
                "errors": [f"Test execution error: {str(e)}"],
                "completed": False,
                "full_content": "",
            }
            print(f"  EXECUTION ERROR: {e}")

        # Process quality analysis
        result["process_quality"] = analyze_process_quality(result)

        # Run evaluation
        if not skip_eval:
            print(f"  Evaluating...")

            # Special evaluation for SC05
            if case_id == "SC05":
                benchmark_eval = evaluate_sc05_benchmark(result)
                result["benchmark_evaluation"] = benchmark_eval
                print(
                    f"  Benchmark: {benchmark_eval['score']}/{benchmark_eval['total']} "
                    f"({benchmark_eval['accuracy']})"
                )

            eval_result = evaluate_result(case, result)
            result["evaluation"] = eval_result
            score = eval_result.get("total_score", "N/A")
            verdict = eval_result.get("verdict", "N/A")
            print(f"  Score: {score}/100 - {verdict}")
            if eval_result.get("issues"):
                for issue in eval_result["issues"]:
                    print(f"    Issue: {issue}")
        else:
            result["evaluation"] = {"verdict": "SKIPPED", "total_score": None}
            print(f"  Evaluation: SKIPPED")

        results.append(result)

        # Save intermediate results after each case
        save_results(results)

    return results


# ---------------------------------------------------------------------------
# Results Persistence
# ---------------------------------------------------------------------------


def save_results(results: list[dict]):
    """Save results to JSON file with summary statistics."""
    # Build summary
    categories = {}
    for r in results:
        cat = r.get("category", "unknown")
        if cat not in categories:
            categories[cat] = {
                "total": 0,
                "pass": 0,
                "fail": 0,
                "error": 0,
                "scores": [],
            }
        categories[cat]["total"] += 1
        verdict = r.get("evaluation", {}).get("verdict", "UNKNOWN")
        if verdict == "PASS":
            categories[cat]["pass"] += 1
        elif verdict in ("FAIL", "UNCERTAIN"):
            categories[cat]["fail"] += 1
        elif verdict in ("EVAL_ERROR",):
            categories[cat]["error"] += 1

        score = r.get("evaluation", {}).get("total_score")
        if score is not None:
            categories[cat]["scores"].append(score)

    # Calculate averages
    for cat in categories.values():
        cat["avg_score"] = (
            sum(cat["scores"]) / len(cat["scores"]) if cat["scores"] else None
        )
        cat["pass_rate"] = (
            cat["pass"] / cat["total"] * 100 if cat["total"] > 0 else 0
        )

    # Overall stats
    all_scores = [
        r["evaluation"]["total_score"]
        for r in results
        if r.get("evaluation", {}).get("total_score") is not None
    ]
    overall_avg = sum(all_scores) / len(all_scores) if all_scores else None
    overall_pass = sum(
        1 for r in results if r.get("evaluation", {}).get("verdict") == "PASS"
    )

    output = {
        "metadata": {
            "version": "2.0",
            "test_file": str(TEST_FILE.name),
            "total_cases": 20,
            "run_cases": len(results),
            "completed_at": datetime.now().isoformat(),
        },
        "summary": {
            "overall_avg_score": overall_avg,
            "overall_pass_rate": (
                overall_pass / len(results) * 100 if results else None
            ),
            "total_pass": overall_pass,
            "total_fail": sum(
                1
                for r in results
                if r.get("evaluation", {}).get("verdict") in ("FAIL", "UNCERTAIN")
            ),
            "total_error": sum(
                1
                for r in results
                if r.get("evaluation", {}).get("verdict") == "EVAL_ERROR"
            ),
            "categories": categories,
        },
        "results": results,
    }

    RESULT_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2))
    print(f"\n  Results saved to {RESULT_FILE}")


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def print_report(results: list[dict]):
    """Print a comprehensive summary report."""
    print(f"\n{'='*70}")
    print(f"  Super Complex Test Suite - Results Report")
    print(f"{'='*70}")

    # Category breakdown
    categories = {}
    for r in results:
        cat = r.get("category", "unknown")
        if cat not in categories:
            categories[cat] = []
        categories[cat].append(r)

    for cat, cat_results in sorted(categories.items()):
        scores = [
            r["evaluation"]["total_score"]
            for r in cat_results
            if r.get("evaluation", {}).get("total_score") is not None
        ]
        passed = sum(
            1 for r in cat_results if r.get("evaluation", {}).get("verdict") == "PASS"
        )
        avg = sum(scores) / len(scores) if scores else 0

        print(
            f"\n  [{cat}] {len(cat_results)} cases, {passed}/{len(cat_results)} passed, avg: {avg:.1f}"
        )
        for r in cat_results:
            ev = r.get("evaluation", {})
            score = ev.get("total_score", "N/A")
            verdict = ev.get("verdict", "N/A")
            reason = ev.get("reason", "")[:80]
            pq = r.get("process_quality", {})
            duration = r.get("duration_seconds", 0)
            output_len = r.get("full_content_length", 0)

            print(f"    {r['case_id']}: {score}/100 [{verdict}] - {reason}")
            print(
                f"      Duration: {duration:.0f}s, Output: {output_len} chars, "
                f"Tools: {pq.get('unique_tools', 0)}, "
                f"Workflow: {'Yes' if pq.get('used_workflow') else 'No'}, "
                f"Compactions: {pq.get('compaction_count', 0)}"
            )

            if ev.get("issues"):
                for issue in ev["issues"]:
                    print(f"      Issue: {issue}")

            # Show SC05 benchmark results
            if r.get("benchmark_evaluation"):
                be = r["benchmark_evaluation"]
                print(
                    f"      Benchmark: {be['score']}/{be['total']} ({be['accuracy']})"
                )

            # Show SC20 isolation results
            if r.get("isolation_check") is not None:
                print(
                    f"      Isolation: {'PASS' if r['isolation_check'] else 'FAIL'}"
                )

    # Overall
    all_scores = [
        r["evaluation"]["total_score"]
        for r in results
        if r.get("evaluation", {}).get("total_score") is not None
    ]
    if all_scores:
        print(f"\n{'='*70}")
        print(
            f"  Overall: {len(results)} cases, avg score: {sum(all_scores)/len(all_scores):.1f}"
        )
        pass_count = sum(
            1 for r in results if r.get("evaluation", {}).get("verdict") == "PASS"
        )
        print(f"  Pass: {pass_count}/{len(results)}")
        print(f"{'='*70}")

    # Score distribution
    if all_scores:
        print(f"\n  Score Distribution:")
        brackets = {"90-100": 0, "80-89": 0, "70-79": 0, "60-69": 0, "<60": 0}
        for s in all_scores:
            if s >= 90:
                brackets["90-100"] += 1
            elif s >= 80:
                brackets["80-89"] += 1
            elif s >= 70:
                brackets["70-79"] += 1
            elif s >= 60:
                brackets["60-69"] += 1
            else:
                brackets["<60"] += 1
        for bracket, count in brackets.items():
            bar = "#" * count
            print(f"    {bracket}: {bar} ({count})")

    # Process quality summary
    print(f"\n  Process Quality Summary:")
    total_tools = sum(
        r.get("process_quality", {}).get("total_tool_calls", 0) for r in results
    )
    total_compactions = sum(
        r.get("process_quality", {}).get("compaction_count", 0) for r in results
    )
    workflow_users = sum(
        1
        for r in results
        if r.get("process_quality", {}).get("used_workflow", False)
    )
    avg_duration = sum(r.get("duration_seconds", 0) for r in results) / len(
        results
    )
    total_output = sum(r.get("full_content_length", 0) for r in results)

    print(f"    Total tool calls: {total_tools}")
    print(f"    Total compactions: {total_compactions}")
    print(f"    Cases using workflow: {workflow_users}/{len(results)}")
    print(f"    Average duration: {avg_duration:.0f}s")
    print(f"    Total output: {total_output:,} chars")

    # Failed cases detail
    failed = [
        r
        for r in results
        if r.get("evaluation", {}).get("verdict") in ("FAIL", "UNCERTAIN")
    ]
    if failed:
        print(f"\n  Failed Cases ({len(failed)}):")
        for r in failed:
            ev = r.get("evaluation", {})
            print(
                f"    {r['case_id']} [{r.get('category')}]: {ev.get('total_score', 'N/A')}/100"
            )
            if ev.get("issues"):
                for issue in ev["issues"]:
                    print(f"      - {issue}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Super Complex Test Suite - 20 Multi-Agent Verification Tests"
    )
    parser.add_argument(
        "--case-id",
        type=str,
        default=None,
        help="Run specific case ID (e.g. SC01, SC20)",
    )
    parser.add_argument(
        "--category",
        type=str,
        default=None,
        help="Filter by category",
    )
    parser.add_argument(
        "--batch",
        type=int,
        default=None,
        help="Batch number (1-based)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=5,
        help="Cases per batch",
    )
    parser.add_argument(
        "--skip-eval",
        action="store_true",
        help="Skip LLM evaluation",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List all test cases",
    )
    parser.add_argument(
        "--resume",
        type=str,
        default=None,
        help="Resume from existing results file",
    )
    parser.add_argument(
        "--report-only",
        type=str,
        default=None,
        help="Print report from results file",
    )
    args = parser.parse_args()

    # Report-only mode
    if args.report_only:
        fpath = Path(args.report_only)
        if fpath.exists():
            data = json.loads(fpath.read_text(encoding="utf-8"))
            print_report(data.get("results", []))
        else:
            print(f"File not found: {fpath}")
        return

    # Load test cases
    cases = load_test_cases()
    all_cases = list(cases)

    # List mode
    if args.list:
        print(f"\nSuper Complex Test Suite ({len(cases)} cases)")
        print(f"{'='*80}")
        current_cat = None
        for c in cases:
            if c["category"] != current_cat:
                current_cat = c["category"]
                print(f"\n  [{current_cat}]")
            kbs = ", ".join(c.get("kb_scope", []))
            concurrent = " (CONCURRENT)" if c.get("concurrent") else ""
            print(
                f"    {c['id']:6} [{c['difficulty']:8}] (KB: {kbs}){concurrent}"
            )
            print(f"           {c.get('name', '')}")
            print(f"           Timeout: {c.get('timeout', DEFAULT_TIMEOUT)}s")
        print(f"\n  Total: {len(cases)} cases")
        return

    # Filter cases
    if args.case_id:
        cases = [c for c in cases if c["id"] == args.case_id]
        if not cases:
            print(
                f"Case {args.case_id} not found. Valid IDs: SC01-SC20"
            )
            return
    elif args.category:
        cases = [c for c in cases if c["category"] == args.category]
        if not cases:
            valid = sorted(set(c["category"] for c in all_cases))
            print(
                f"No cases for category '{args.category}'. Valid: {', '.join(valid)}"
            )
            return

    # Batch selection
    if args.batch is not None:
        start = (args.batch - 1) * args.batch_size
        batch_cases = cases[start : start + args.batch_size]
        if not batch_cases:
            print(
                f"No cases in batch {args.batch} (start={start}, total={len(cases)})"
            )
            return
        cases = batch_cases

    # Check backend connectivity
    print("Checking backend connectivity...")
    health = api_request("GET", "/api/health")
    if "error" in health:
        print(f"ERROR: Backend not reachable at {BASE_URL}")
        print(f"  {health['error']}")
        sys.exit(1)
    print(f"Backend OK: {health}")

    # Run tests
    resume_file = Path(args.resume) if args.resume else None
    results = run_tests(cases, skip_eval=args.skip_eval, resume_file=resume_file)

    # Print report
    print_report(results)


if __name__ == "__main__":
    main()
