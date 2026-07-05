#!/usr/bin/env python3
"""
AgentEscapeBench Test Runner for DeepAnalyze
==============================================
Synthetic test set matching AgentEscapeBench's capabilities:
- Multi-step DAG reasoning (5/10/15/20/25 step chains)
- Hidden state tracking
- Intermediate result propagation

Tests DA's ability to maintain coherent long chains of reasoning,
track intermediate results, and produce comprehensive outputs.

Usage:
    # Run all tests (no evaluation)
    python3 benchmarks/run_agent_escape_bench.py --skip-eval

    # Run by difficulty level
    python3 benchmarks/run_agent_escape_bench.py --difficulty 5

    # Run first 3 tests (group 1)
    python3 benchmarks/run_agent_escape_bench.py --limit 3

    # Resume interrupted run
    python3 benchmarks/run_agent_escape_bench.py --resume results/aeb-results.json

    # Specific test ID
    python3 benchmarks/run_agent_escape_bench.py --case-id AEB-D5-001
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_URL = os.environ.get("DEEPANALYZE_URL", "http://localhost:21000")

# Evaluation LLM config (using MiniMax OpenAI-compatible API)
EVAL_MODEL = os.environ.get("EVAL_MODEL", "MiniMax-M2.7")
EVAL_ENDPOINT = os.environ.get("EVAL_ENDPOINT", "https://api.minimaxi.com/v1")
EVAL_API_KEY = os.environ.get(
    "EVAL_API_KEY",
    "sk-cp-zOIn7SyOwew3KxO3mHW9k6wj9qcLpSQ_bJOKi0Cokk9kRwD1NaTukssxooQW7ybKyH7fEFtbKmgIkYe9vMbEVAdFLsrXKYwABc1PN6EY7GqfBEsquQkhEhE"
)

# KB name -> UUID mapping
KB_IDS = {
    "bigtest3": "89ee4db6-0626-4636-8c66-49a575d05832",
    "lbctest": "f65cb573-05c7-4098-ba7d-c26c006986ee",
    "dabstep": "0f329774-cc0f-48fe-b5c1-393e3a80bc0a",
}

# Timeout by difficulty
DIFFICULTY_TIMEOUTS = {
    5: 600,    # 10 min
    10: 1200,  # 20 min
    15: 1800,  # 30 min
    20: 2400,  # 40 min
    25: 3600,  # 60 min
}

# Pass threshold for LLM evaluation
PASS_THRESHOLD = 95  # >= 95%

TEST_FILE = Path(__file__).parent / "agent-escape-bench.json"
RESULTS_DIR = Path(__file__).parent / "results"


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


def sse_stream(path: str, data: dict, timeout: int = 600):
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
                line = raw_line.decode("utf-8", errors="replace").rstrip("\n").rstrip("\r")
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
    """Load test cases from agent-escape-bench.json."""
    if not TEST_FILE.exists():
        print(f"ERROR: Test file not found: {TEST_FILE}")
        sys.exit(1)

    with open(TEST_FILE, "r", encoding="utf-8") as f:
        cases = json.load(f)

    for case in cases:
        kb_scope_uuids = []
        for name in case.get("kb_scope", []):
            if name in KB_IDS:
                kb_scope_uuids.append(KB_IDS[name])
            else:
                print(f"WARNING: Unknown KB name '{name}' in case {case['id']}")
        case["_kb_scope_uuids"] = kb_scope_uuids

    return cases


# ---------------------------------------------------------------------------
# Session Management
# ---------------------------------------------------------------------------


def create_session(title: str, kb_scope_uuids: list[str]) -> str:
    """Create a test session with KB scope and return its ID."""
    result = api_request(
        "POST",
        "/api/sessions",
        {"title": title, "kbScope": kb_scope_uuids},
    )
    if "error" in result:
        raise RuntimeError(f"Failed to create session: {result['error']}")
    return result["id"]


def delete_session(session_id: str):
    """Delete a test session."""
    api_request("DELETE", f"/api/sessions/{session_id}")


def get_session_messages(session_id: str) -> list[dict]:
    """Get all messages from a session (includes full content after reload)."""
    result = api_request("GET", f"/api/sessions/{session_id}/messages")
    if isinstance(result, list):
        return result
    return result.get("messages", result.get("items", []))


# ---------------------------------------------------------------------------
# Test Execution
# ---------------------------------------------------------------------------


def run_single_test(case: dict) -> dict:
    """Execute a single test case and collect all process data."""
    difficulty = case.get("difficulty", 5)
    timeout = DIFFICULTY_TIMEOUTS.get(difficulty, 600)

    session_id = create_session(
        f"aeb-{case['id']}-{datetime.now().strftime('%H%M%S')}",
        case["_kb_scope_uuids"],
    )

    result = {
        "case_id": case["id"],
        "difficulty": difficulty,
        "category": case.get("category", ""),
        "kb_scope": case.get("kb_scope", []),
        "session_id": session_id,
        "question": case["question"],
        "expected_answer": case.get("expected_answer", ""),
        "min_steps": case.get("min_steps", difficulty),
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
        "step_tracking": {},  # Track which steps were completed
    }

    print(f"\n  {'='*60}")
    print(f"  Case: {case['id']} (Difficulty {difficulty}, Min Steps: {case.get('min_steps', difficulty)})")
    print(f"  Session: {session_id}")
    print(f"  Query: {case['question'][:100]}...")
    print(f"  Timeout: {timeout}s")
    print(f"  {'='*60}")

    try:
        for event_type, event_data in sse_stream(
            "/api/agents/run-stream",
            {"sessionId": session_id, "input": case["question"]},
            timeout=timeout,
        ):
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
                tool_info = {
                    "tool": event_data.get("toolName"),
                    "input": event_data.get("input"),
                    "status": "running",
                    "turn": result["turns"],
                }
                result["tool_calls"].append(tool_info)
                # Track step progress
                tool_name = event_data.get("toolName", "")
                result["step_tracking"][f"tool_{len(result['tool_calls'])}"] = {
                    "tool": tool_name,
                    "turn": result["turns"],
                }
            elif event_type == "tool_result":
                tool_name = event_data.get("toolName", "")
                tool_output = str(event_data.get("output", ""))
                for tc in reversed(result["tool_calls"]):
                    if tc["tool"] == tool_name and tc["status"] == "running":
                        tc["status"] = "completed"
                        tc["output_preview"] = tool_output[:500]
                        tc["output_length"] = len(tool_output)
                        break
            elif event_type == "push_content":
                pc_info = {
                    "type": event_data.get("type"),
                    "title": event_data.get("title"),
                    "data_length": event_data.get("dataLength", 0),
                }
                result["push_contents"].append(pc_info)
                # Track push_content data for evaluation
                push_data = event_data.get("data", "")
                if push_data:
                    result.setdefault("push_data_texts", []).append(
                        str(push_data)[:10000]
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
                result.setdefault("compactions", []).append(event_data)
            elif event_type == "thinking":
                thinking_delta = event_data.get("delta", "")
                result["thinking_deltas"].append(thinking_delta)
                result.setdefault("full_thinking", "")
                result["full_thinking"] += thinking_delta

            # Progress indication
            if event_type == "tool_call":
                print(f"    [Turn {result['turns']}] Tool: {event_data.get('toolName')}")
            elif event_type == "turn":
                print(f"    [Turn {event_data.get('turn')}]")

    except Exception as e:
        result["errors"].append(f"Stream error: {str(e)}")

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

    # Get full messages from server (includes push_content and complete text)
    try:
        messages = get_session_messages(session_id)
        if messages:
            result["server_messages"] = messages
            # Extract full assistant content from server
            for msg in messages:
                if msg.get("role") == "assistant":
                    content = msg.get("content", "")
                    if content and len(content) > len(result["full_content"]):
                        result["full_content_from_server"] = content
            # Also extract push_content data from message metadata
            for msg in messages:
                if msg.get("role") == "assistant":
                    # Check for toolCalls that contain push_content data
                    tool_calls = msg.get("toolCalls", [])
                    for tc in tool_calls:
                        if tc.get("toolName") == "push_content":
                            tc_output = str(tc.get("output", ""))
                            if tc_output and len(tc_output) > 100:
                                result.setdefault("push_data_texts", [])
                                result["push_data_texts"].append(tc_output[:15000])
                        elif tc.get("toolName") == "write_file":
                            # write_file input contains the content
                            tc_input = tc.get("input", {})
                            if isinstance(tc_input, dict):
                                file_content = tc_input.get("content", "")
                                if file_content and len(file_content) > 200:
                                    result.setdefault("write_file_contents", [])
                                    result["write_file_contents"].append(file_content[:30000])
    except Exception as e:
        result["message_fetch_error"] = str(e)

    # Print summary
    print(f"\n  Summary for {case['id']}:")
    print(f"    Turns: {result['turns']}, Tools: {tool_counts}")
    print(f"    Duration: {result['duration_seconds']:.1f}s")
    print(f"    Output: {len(result['full_content'])} chars")
    if result.get("full_thinking"):
        print(f"    Thinking: {len(result['full_thinking'])} chars")
    if result["push_contents"]:
        print(f"    Push contents: {len(result['push_contents'])}")
    if result.get("compactions"):
        print(f"    Compactions: {len(result['compactions'])}")
    if result["errors"]:
        print(f"    Errors: {result['errors']}")
    if result.get("push_data_texts"):
        total_push = sum(len(t) for t in result["push_data_texts"])
        print(f"    Push data total: {total_push} chars")

    return result


# ---------------------------------------------------------------------------
# LLM-based Evaluation
# ---------------------------------------------------------------------------


def evaluate_result(case: dict, result: dict) -> dict:
    """Evaluate a test result using LLM assessment with strict >=95% threshold."""
    # Collect all output text
    answer_text = result.get("full_content", "")

    # Include server-side full content if available (more complete)
    server_content = result.get("full_content_from_server", "")
    if server_content and len(server_content) > len(answer_text):
        answer_text = server_content

    if not result["completed"] and not answer_text:
        return {
            "score": 0,
            "verdict": "FAIL",
            "reason": "Agent failed to produce any output",
            "issues": ["no_output"],
            "steps_completed": 0,
            "steps_total": case.get("min_steps", 5),
        }

    # Include push_content data in evaluation
    push_texts = result.get("push_data_texts", [])
    if push_texts:
        combined_push = "\n\n".join(push_texts)
        if combined_push.strip():
            answer_text += f"\n\n[以下是Agent通过push_content输出的内容]\n{combined_push[:20000]}"

    # Include write_file content (for reports generated as files)
    write_contents = result.get("write_file_contents", [])
    if write_contents:
        combined_write = "\n\n".join(write_contents)
        if combined_write.strip() and len(combined_write) > len(answer_text):
            answer_text += f"\n\n[以下是Agent通过write_file生成的报告内容]\n{combined_write[:20000]}"

    # Include thinking content (shows reasoning process)
    thinking = result.get("full_thinking", "")

    # Build evaluation criteria text
    criteria_text = "\n".join(f"- {c}" for c in case.get("evaluation_criteria", []))
    if not criteria_text:
        criteria_text = "准确回答问题，完整执行所有步骤，不编造信息"

    # Build tool call summary for evaluation
    tool_summary = "\n".join(
        f"- {tool}: {count}次" for tool, count in result.get("tool_call_summary", {}).items()
    )

    # Build evaluation prompt
    eval_prompt = f"""你是一个极其严格的测试评估员。请评估以下AI Agent针对一个多步骤复杂推理任务的输出质量。

## 任务描述
{case["question"][:3000]}

## 任务要求的最少步骤数
{case.get("min_steps", "未指定")}步

## 评估标准
{criteria_text}

## 参考答案
{case.get("expected_answer", "无参考答案")}

## Agent的文本输出
{answer_text[:24000]}
"""

    if thinking:
        eval_prompt += f"""
## Agent的思考过程（推理链）
{thinking[:8000]}
"""

    if result.get("tool_call_summary"):
        eval_prompt += f"""
## Agent的工具调用统计
{tool_summary}
"""

    eval_prompt += f"""
## 评估要求

请严格按以下标准打分，总分0-100：

1. **步骤完成度** (30分): Agent是否完成了要求的{case.get('min_steps', '所有')}个步骤？每少一步扣3分。
2. **准确性** (25分): 信息是否准确？有没有幻觉或编造？数字、人名、日期是否精确？
3. **完整性** (20分): 是否完整回答了问题？有无遗漏关键信息？
4. **连贯性** (15分): 各步骤之间是否有逻辑连贯？中间结果是否正确传播？
5. **效率** (10分): 工具调用路径是否合理？有无冗余调用？

## 特殊评估规则
- 如果Agent的输出包含了任务要求的{case.get('min_steps', '所有')}个步骤的关键结果，即使格式不完全对应，也应给高分
- 如果Agent在长篇输出中包含了正确答案，即使夹杂了额外解释，也应认可
- 如果Agent使用了不同但合理的方法达到正确结论，不应扣分
- 如果Agent引用了具体的文档内容（人名、数字、引文）且准确，应给高分
- 如果Agent编造了不存在的数据或信息，应严重扣分

以JSON格式输出：
```json
{{
  "step_score": 0-30,
  "accuracy_score": 0-25,
  "completeness_score": 0-20,
  "coherence_score": 0-15,
  "efficiency_score": 0-10,
  "total_score": 0-100,
  "steps_completed": <估算的步骤完成数>,
  "steps_total": {case.get('min_steps', '?')},
  "verdict": "PASS" or "FAIL",
  "pass_threshold": {PASS_THRESHOLD},
  "reason": "简短评价（一句话）",
  "strengths": ["优点1", "优点2"],
  "issues": ["问题1", "问题2"],
  "missing_steps": ["未完成的步骤描述"]
}}
```

PASS标准：total_score >= {PASS_THRESHOLD}分。
"""

    # Call LLM for evaluation (OpenAI-compatible API)
    try:
        payload = {
            "model": EVAL_MODEL,
            "max_tokens": 3000,
            "messages": [{"role": "user", "content": eval_prompt}],
        }
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{EVAL_ENDPOINT}/chat/completions",
            data=body,
            method="POST",
        )
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", f"Bearer {EVAL_API_KEY}")

        with urllib.request.urlopen(req, timeout=120) as resp:
            response = json.loads(resp.read().decode())
            text = ""
            # OpenAI-compatible response format
            choices = response.get("choices", [])
            if choices:
                text = choices[0].get("message", {}).get("content", "")
            if not text:
                # Fallback: try Anthropic format
                for block in response.get("content", []):
                    if block.get("type") == "text":
                        text += block.get("text", "")

            eval_result = extract_json(text)
            if eval_result and "total_score" in eval_result:
                # Normalize: use total_score as score
                eval_result["score"] = eval_result["total_score"]
                if eval_result.get("score", 0) >= PASS_THRESHOLD:
                    eval_result.setdefault("verdict", "PASS")
                else:
                    eval_result.setdefault("verdict", "FAIL")
                return eval_result
            return {
                "score": 50,
                "verdict": "UNCERTAIN",
                "reason": f"Could not parse eval response: {text[:200]}",
                "raw_eval": text[:500],
            }
    except Exception as e:
        return {
            "score": -1,
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
    # Try to find the largest JSON object
    match = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    return None


# ---------------------------------------------------------------------------
# Batch Runner
# ---------------------------------------------------------------------------


def load_existing_results(result_file: Path) -> dict[str, dict]:
    """Load existing results for resume support."""
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
    group_size: int = 3,
) -> list[dict]:
    """Run test cases and return results."""
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    # Load existing results for resume
    existing = {}
    if resume_file:
        existing = load_existing_results(resume_file)
        if existing:
            print(f"Loaded {len(existing)} existing results from {resume_file}")

    results = []
    total = len(cases)
    group_num = 0

    for i, case in enumerate(cases):
        # Skip if already done
        if case["id"] in existing:
            print(f"\n[{i+1}/{total}] Skipping {case['id']} (already done)")
            results.append(existing[case["id"]])
            continue

        group_num = (i // group_size) + 1
        print(f"\n{'#'*70}")
        print(f"# Group {group_num} | Test {i+1}/{total} | {case['id']}")
        print(f"# Difficulty: {case['difficulty']} | Category: {case.get('category', '')}")
        print(f"{'#'*70}")

        result = run_single_test(case)

        if not skip_eval:
            print(f"\n  Evaluating {case['id']}...")
            eval_result = evaluate_result(case, result)
            result["evaluation"] = eval_result
            score = eval_result.get("score", 0)
            verdict = eval_result.get("verdict", "UNKNOWN")
            reason = eval_result.get("reason", "")
            print(f"  Score: {score}/100 | Verdict: {verdict} | {reason}")
            if eval_result.get("issues"):
                print(f"  Issues: {eval_result['issues']}")
            if eval_result.get("missing_steps"):
                print(f"  Missing steps: {eval_result['missing_steps']}")
        else:
            result["evaluation"] = {"verdict": "SKIPPED", "score": -1}

        # Clean up session
        try:
            delete_session(result["session_id"])
        except Exception:
            pass

        results.append(result)

        # Save incremental results after each test
        save_results(results, case.get("difficulty", 0))

        # Group analysis
        if (i + 1) % group_size == 0 or i == total - 1:
            print(f"\n{'='*70}")
            print(f"  GROUP {group_num} ANALYSIS ({min(i+1, group_size)} tests)")
            print(f"{'='*70}")
            analyze_group(results[-group_size:], skip_eval)

    return results


def analyze_group(results: list[dict], skip_eval: bool):
    """Analyze a group of test results and print findings."""
    if skip_eval:
        # Just print basic stats
        for r in results:
            print(f"  {r['case_id']}: {r['turns']} turns, {r['total_tool_calls']} tools, "
                  f"{len(r['full_content'])} chars, {r['duration_seconds']:.0f}s")
        return

    scores = []
    for r in results:
        ev = r.get("evaluation", {})
        score = ev.get("score", 0)
        scores.append(score)
        status = "PASS" if score >= PASS_THRESHOLD else "FAIL"
        print(f"  {r['case_id']}: Score={score}/100 [{status}] "
              f"({r['turns']} turns, {r['total_tool_calls']} tools, "
              f"{len(r['full_content'])} chars, {r['duration_seconds']:.0f}s)")
        if ev.get("issues"):
            print(f"    Issues: {ev['issues']}")
        if ev.get("missing_steps"):
            print(f"    Missing: {ev['missing_steps']}")

    avg_score = sum(scores) / len(scores) if scores else 0
    pass_count = sum(1 for s in scores if s >= PASS_THRESHOLD)
    print(f"\n  Group Summary: Avg={avg_score:.1f}, Pass={pass_count}/{len(scores)}")
    if pass_count < len(scores):
        print(f"  FAILED tests need optimization!")


def save_results(results: list[dict], difficulty: int):
    """Save results to JSON file."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    result_file = RESULTS_DIR / f"aeb-results.json"

    # Calculate summary
    scores = [r.get("evaluation", {}).get("score", -1) for r in results if r.get("evaluation", {}).get("score", -1) >= 0]
    pass_count = sum(1 for s in scores if s >= PASS_THRESHOLD)

    summary = {
        "timestamp": timestamp,
        "total_tests": len(results),
        "completed": sum(1 for r in results if r.get("completed")),
        "evaluated": len(scores),
        "passed": pass_count,
        "failed": len(scores) - pass_count,
        "avg_score": sum(scores) / len(scores) if scores else 0,
        "pass_rate": f"{pass_count}/{len(scores)}" if scores else "N/A",
        "pass_threshold": PASS_THRESHOLD,
    }

    output = {
        "summary": summary,
        "results": results,
    }

    result_file.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  Results saved to {result_file}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="AgentEscapeBench Test Runner")
    parser.add_argument("--skip-eval", action="store_true", help="Skip LLM evaluation")
    parser.add_argument("--difficulty", type=int, choices=[5, 10, 15, 20, 25],
                       help="Run only tests at this difficulty level")
    parser.add_argument("--limit", type=int, help="Run only first N tests")
    parser.add_argument("--case-id", type=str, help="Run specific test case by ID")
    parser.add_argument("--list", action="store_true", help="List all test cases")
    parser.add_argument("--resume", type=str, help="Resume from results file")
    parser.add_argument("--group-size", type=int, default=3, help="Tests per group (default 3)")
    args = parser.parse_args()

    cases = load_test_cases()

    # Filter by difficulty
    if args.difficulty:
        cases = [c for c in cases if c.get("difficulty") == args.difficulty]

    # Filter by case ID
    if args.case_id:
        cases = [c for c in cases if c["id"] == args.case_id]

    # Limit
    if args.limit:
        cases = cases[:args.limit]

    if args.list:
        print(f"\nAgentEscapeBench - {len(cases)} test cases\n")
        print(f"{'ID':<15} {'Diff':>4} {'Category':<25} {'Min Steps':>9} {'KB Scope'}")
        print("-" * 80)
        for c in cases:
            kbs = ", ".join(c.get("kb_scope", []))
            print(f"{c['id']:<15} {c['difficulty']:>4} {c.get('category',''):<25} "
                  f"{c.get('min_steps','?'):>9} {kbs}")
        return

    print(f"\n{'='*70}")
    print(f"  AgentEscapeBench - Synthetic Multi-Step Reasoning Tests")
    print(f"  Total: {len(cases)} tests | Eval threshold: {PASS_THRESHOLD}%")
    print(f"  Server: {BASE_URL}")
    print(f"{'='*70}")

    resume_file = Path(args.resume) if args.resume else None
    results = run_tests(cases, skip_eval=args.skip_eval, resume_file=resume_file,
                       group_size=args.group_size)

    # Final summary
    print(f"\n\n{'='*70}")
    print(f"  FINAL SUMMARY")
    print(f"{'='*70}")

    if not args.skip_eval:
        scores = [r.get("evaluation", {}).get("score", -1) for r in results]
        valid_scores = [s for s in scores if s >= 0]
        if valid_scores:
            pass_count = sum(1 for s in valid_scores if s >= PASS_THRESHOLD)
            fail_count = len(valid_scores) - pass_count
            print(f"  Total: {len(results)} tests")
            print(f"  Pass: {pass_count}/{len(valid_scores)} ({100*pass_count/len(valid_scores):.0f}%)")
            print(f"  Fail: {fail_count}/{len(valid_scores)}")
            print(f"  Average score: {sum(valid_scores)/len(valid_scores):.1f}/100")
            print(f"  Pass threshold: {PASS_THRESHOLD}%")

            # List failures
            failures = [r for r in results if r.get("evaluation", {}).get("score", 0) < PASS_THRESHOLD]
            if failures:
                print(f"\n  Failed tests:")
                for f in failures:
                    ev = f["evaluation"]
                    print(f"    {f['case_id']}: {ev.get('score', 0)}/100 - {ev.get('reason', '')}")
                    if ev.get("issues"):
                        for issue in ev["issues"]:
                            print(f"      - {issue}")
    else:
        print(f"  Total: {len(results)} tests (evaluation skipped)")
        for r in results:
            print(f"  {r['case_id']}: {r['turns']} turns, {r['total_tool_calls']} tools, "
                  f"{len(r['full_content'])} chars")


if __name__ == "__main__":
    main()
