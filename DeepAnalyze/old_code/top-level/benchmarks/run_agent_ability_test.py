#!/usr/bin/env python3
"""
Agent Ability Test Runner (Baseline)
======================================
Runs the agent ability test suite (50 core + 10 multi-agent) against the DeepAnalyze API.
Reads test cases from agent-ability-test-50.json, maps kb_scope names to UUIDs,
executes tests via SSE streaming, and optionally evaluates with LLM.

Usage:
    # List all test cases
    python3 benchmarks/run_agent_ability_test.py --list

    # Run a single case for connectivity check
    python3 benchmarks/run_agent_ability_test.py --case-id T001

    # Run by category
    python3 benchmarks/run_agent_ability_test.py --category single-document

    # Run all (skip evaluation for speed)
    python3 benchmarks/run_agent_ability_test.py --skip-eval

    # Run in batches
    python3 benchmarks/run_agent_ability_test.py --batch 1 --batch-size 10

    # Resume from a previous run
    python3 benchmarks/run_agent_ability_test.py --resume results/agent-ability-baseline.json
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

# Categories that need extra-long timeout
LONG_TIMEOUT_CATEGORIES = {"ultra-long-output"}
MULTI_AGENT_TIMEOUT_CATEGORIES = {"multi-agent"}
LONG_TIMEOUT = 3600  # 1 hour (ultra-long-output)
MULTI_AGENT_TIMEOUT = 1800  # 30 min (multi-agent needs more time for coordination)
DEFAULT_TIMEOUT = 600  # 10 minutes

TEST_FILE = Path(__file__).parent / "agent-ability-test-50.json"
RESULTS_DIR = Path(__file__).parent / "results"
BASELINE_RESULT_FILE = RESULTS_DIR / "agent-ability-baseline.json"


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
    """Load test cases from agent-ability-test-50.json."""
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


# ---------------------------------------------------------------------------
# Test Execution
# ---------------------------------------------------------------------------


def run_single_test(case: dict) -> dict:
    """Execute a single test case and collect all process data."""
    # Determine timeout based on category
    if case.get("category") in LONG_TIMEOUT_CATEGORIES:
        timeout = LONG_TIMEOUT
    elif case.get("category") in MULTI_AGENT_TIMEOUT_CATEGORIES:
        timeout = MULTI_AGENT_TIMEOUT
    else:
        timeout = DEFAULT_TIMEOUT

    session_id = create_session(
        f"aat-{case['id']}-{datetime.now().strftime('%H%M%S')}",
        case["_kb_scope_uuids"],
    )

    result = {
        "case_id": case["id"],
        "category": case["category"],
        "difficulty": case["difficulty"],
        "kb_scope": case.get("kb_scope", []),
        "session_id": session_id,
        "question": case["question"],
        "expected_answer": case.get("expected_answer", ""),
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
    }

    print(f"  Session: {session_id}")
    print(f"  Query: {case['question'][:80]}...")
    print(f"  Timeout: {timeout}s")

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
                result.setdefault("compactions", []).append(event_data)
            elif event_type == "thinking":
                result["thinking_deltas"].append(event_data.get("delta", ""))

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

    # Print summary
    print(f"  Turns: {result['turns']}, Tools: {tool_counts}, Duration: {result['duration_seconds']:.1f}s")
    print(f"  Output length: {len(result['full_content'])} chars")
    if result["errors"]:
        print(f"  Errors: {result['errors']}")
    if result["push_contents"]:
        print(f"  Push contents: {len(result['push_contents'])}")
    if result.get("compactions"):
        print(f"  Compactions: {len(result['compactions'])}")

    return result


# ---------------------------------------------------------------------------
# LLM-based Evaluation
# ---------------------------------------------------------------------------


def evaluate_result(case: dict, result: dict) -> dict:
    """Evaluate a test result using LLM assessment against evaluation_criteria."""
    if not result["completed"] and not result["full_content"]:
        return {
            "accuracy_score": 0,
            "completeness_score": 0,
            "usefulness_score": 0,
            "tool_usage_score": 0,
            "total_score": 0,
            "verdict": "FAIL",
            "reason": "Agent failed to produce any output",
            "issues": ["no_output"],
        }

    # Build the full answer text
    answer_text = result["full_content"]

    # Include finish tool summary if present
    for tc in result.get("tool_calls", []):
        if tc.get("tool") == "finish" and tc.get("input", {}).get("summary"):
            finish_summary = tc["input"]["summary"]
            if finish_summary and len(finish_summary) > 10:
                if not answer_text.strip():
                    answer_text = f"[Agent's final answer (via finish tool)]:\n{finish_summary}"
                else:
                    answer_text += f"\n\n[Agent's final answer summary]:\n{finish_summary}"
            break

    # Build evaluation criteria text
    criteria_text = "\n".join(f"- {c}" for c in case.get("evaluation_criteria", []))
    if not criteria_text:
        criteria_text = "准确回答问题，不编造信息"

    # Build evaluation prompt
    eval_prompt = f"""你是一个严格的测试评估员。请评估以下AI Agent针对一个知识库问答任务的输出质量。

## 测试问题
{case["question"]}

## 评估标准
{criteria_text}

## 参考答案（Ground Truth）
{case.get("expected_answer", "无参考答案")}

## Agent的输出
{answer_text[:16000]}
"""

    if result["push_contents"]:
        pushed_text = "\n".join(
            f"### {pc.get('title', 'Untitled')} ({pc.get('type', 'unknown')})\n"
            f"[Data length: {pc.get('data_length', 0)} chars]"
            for pc in result["push_contents"]
        )
        eval_prompt += f"""
## Agent还通过push_content输出了以下内容卡片
{pushed_text}
注意：卡片内容也是Agent结果的一部分，应视为有效输出。
"""

    eval_prompt += """
## 评估要求
请按以下标准打分（0-100分）：
1. **准确性** (40分): 信息是否准确？有没有幻觉或编造？数字、人名、日期是否精确？
2. **完整性** (30分): 是否完整回答了问题？有无遗漏关键信息？
3. **有用性** (20分): 回答结构是否清晰？信息是否易于理解？
4. **效率** (10分): 工具调用路径是否合理？有无冗余调用？

以JSON格式输出：
```json
{
  "accuracy_score": 0-40,
  "completeness_score": 0-30,
  "usefulness_score": 0-20,
  "tool_usage_score": 0-10,
  "total_score": 0-100,
  "verdict": "PASS" or "FAIL",
  "reason": "简短评价",
  "issues": ["问题1", "问题2"]
}
```
PASS标准：total_score >= 60分。
"""

    # Call LLM for evaluation
    try:
        payload = {
            "model": EVAL_MODEL,
            "max_tokens": 2000,
            "messages": [{"role": "user", "content": eval_prompt}],
        }
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{EVAL_ENDPOINT}/v1/messages",
            data=body,
            method="POST",
        )
        req.add_header("Content-Type", "application/json")
        req.add_header("x-api-key", EVAL_API_KEY)
        req.add_header("anthropic-version", "2023-06-01")

        with urllib.request.urlopen(req, timeout=60) as resp:
            response = json.loads(resp.read().decode())
            text = ""
            for block in response.get("content", []):
                if block.get("type") == "text":
                    text += block.get("text", "")

            eval_result = extract_json(text)
            if eval_result and "total_score" in eval_result:
                # Normalize verdict
                if eval_result.get("total_score", 0) >= 60:
                    eval_result.setdefault("verdict", "PASS")
                else:
                    eval_result.setdefault("verdict", "FAIL")
                return eval_result
            return {
                "accuracy_score": 0,
                "completeness_score": 0,
                "usefulness_score": 0,
                "tool_usage_score": 0,
                "total_score": 50,
                "verdict": "UNCERTAIN",
                "reason": f"Could not parse eval response: {text[:200]}",
                "raw_eval": text[:500],
            }
    except Exception as e:
        return {
            "accuracy_score": 0,
            "completeness_score": 0,
            "usefulness_score": 0,
            "tool_usage_score": 0,
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
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

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

        print(f"\n[{i+1}/{total}] {case_id}: [{case['category']}] (difficulty: {case['difficulty']})")

        # Run test
        result = run_single_test(case)

        # Run evaluation
        if not skip_eval:
            print(f"  Evaluating...")
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
        save_results(results, cases)

    return results


def save_results(results: list[dict], all_cases: list[dict]):
    """Save results to baseline JSON file."""
    # Build summary
    completed = [r for r in results if r.get("evaluation", {}).get("verdict") != "SKIPPED"]
    evaluated = [r for r in completed if r.get("evaluation", {}).get("total_score") is not None]

    # Category stats
    categories = {}
    for r in results:
        cat = r.get("category", "unknown")
        if cat not in categories:
            categories[cat] = {"total": 0, "pass": 0, "fail": 0, "error": 0, "scores": []}
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
    total_score_list = [
        r["evaluation"]["total_score"]
        for r in evaluated
        if r.get("evaluation", {}).get("total_score") is not None
    ]
    overall_avg = sum(total_score_list) / len(total_score_list) if total_score_list else None

    output = {
        "metadata": {
            "version": "1.0",
            "test_file": str(TEST_FILE.name),
            "total_cases": len(all_cases),
            "run_cases": len(results),
            "evaluated_cases": len(evaluated),
            "completed_at": datetime.now().isoformat(),
        },
        "summary": {
            "overall_avg_score": overall_avg,
            "overall_pass_rate": sum(1 for r in evaluated if r.get("evaluation", {}).get("verdict") == "PASS")
            / len(evaluated)
            * 100
            if evaluated
            else None,
            "total_pass": sum(1 for c in categories.values() for _ in range(c["pass"])),
            "total_fail": sum(1 for c in categories.values() for _ in range(c["fail"])),
            "total_error": sum(1 for c in categories.values() for _ in range(c["error"])),
            "categories": categories,
        },
        "results": results,
    }

    BASELINE_RESULT_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2))
    print(f"\n  Results saved to {BASELINE_RESULT_FILE}")


def print_report(results: list[dict]):
    """Print a summary report of the test results."""
    print(f"\n{'='*70}")
    print(f"  Agent Ability Test - Baseline Report")
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
        passed = sum(1 for r in cat_results if r.get("evaluation", {}).get("verdict") == "PASS")
        avg = sum(scores) / len(scores) if scores else 0

        print(f"\n  [{cat}] {len(cat_results)} cases, {passed}/{len(cat_results)} passed, avg: {avg:.1f}")
        for r in cat_results:
            ev = r.get("evaluation", {})
            score = ev.get("total_score", "N/A")
            verdict = ev.get("verdict", "N/A")
            reason = ev.get("reason", "")[:60]
            print(f"    {r['case_id']}: {score}/100 [{verdict}] - {reason}")

    # Overall
    all_scores = [
        r["evaluation"]["total_score"]
        for r in results
        if r.get("evaluation", {}).get("total_score") is not None
    ]
    if all_scores:
        print(f"\n{'='*70}")
        print(f"  Overall: {len(results)} cases, avg score: {sum(all_scores)/len(all_scores):.1f}")
        print(f"  Pass: {sum(1 for r in results if r.get('evaluation', {}).get('verdict') == 'PASS')}/{len(results)}")
        print(f"{'='*70}")

    # Failed cases detail
    failed = [
        r for r in results if r.get("evaluation", {}).get("verdict") in ("FAIL", "UNCERTAIN")
    ]
    if failed:
        print(f"\n  Failed Cases ({len(failed)}):")
        for r in failed:
            ev = r.get("evaluation", {})
            print(f"    {r['case_id']} [{r.get('category')}]: {ev.get('total_score', 'N/A')}/100")
            if ev.get("issues"):
                for issue in ev["issues"]:
                    print(f"      - {issue}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="Agent Ability Test Runner (Baseline)")
    parser.add_argument("--case-id", type=str, default=None, help="Run specific case ID (e.g. T001, T051)")
    parser.add_argument("--category", type=str, default=None, help="Filter by category")
    parser.add_argument("--batch", type=int, default=None, help="Batch number (1-based)")
    parser.add_argument("--batch-size", type=int, default=10, help="Cases per batch")
    parser.add_argument("--skip-eval", action="store_true", help="Skip LLM evaluation")
    parser.add_argument("--list", action="store_true", help="List all test cases")
    parser.add_argument("--resume", type=str, default=None, help="Resume from existing results file")
    parser.add_argument("--report-only", type=str, default=None, help="Print report from results file")
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
        print(f"\nAgent Ability Test Suite ({len(cases)} cases)")
        print(f"{'='*80}")
        current_cat = None
        for c in cases:
            if c["category"] != current_cat:
                current_cat = c["category"]
                print(f"\n  [{current_cat}]")
            kbs = ", ".join(c.get("kb_scope", []))
            print(f"    {c['id']:6} [{c['difficulty']:8}] (KB: {kbs})")
            print(f"           Q: {c['question'][:70]}...")
        print(f"\n  Total: {len(cases)} cases")
        return

    # Filter cases
    if args.case_id:
        cases = [c for c in cases if c["id"] == args.case_id]
        if not cases:
            print(f"Case {args.case_id} not found. Valid IDs: T001-T060")
            return
    elif args.category:
        cases = [c for c in cases if c["category"] == args.category]
        if not cases:
            valid = sorted(set(c["category"] for c in all_cases))
            print(f"No cases for category '{args.category}'. Valid: {', '.join(valid)}")
            return

    # Batch selection
    if args.batch is not None:
        start = (args.batch - 1) * args.batch_size
        batch_cases = cases[start : start + args.batch_size]
        if not batch_cases:
            print(f"No cases in batch {args.batch} (start={start}, total={len(cases)})")
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
