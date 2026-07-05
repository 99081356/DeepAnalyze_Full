#!/usr/bin/env python3
"""
Toolathlon + AgencyBench Benchmark Runner for DeepAnalyze
==========================================================
Runs all 108 Toolathlon tasks and 138 AgencyBench tasks against DeepAnalyze,
evaluates results with LLM, and records detailed observations.

Usage:
    # List all test cases
    python3 benchmarks/run_toolathlon_agencybench.py --list

    # Run first group of 3 Toolathlon tasks
    python3 benchmarks/run_toolathlon_agencybench.py --dataset toolathlon --group 0

    # Run all Toolathlon tasks (groups of 3)
    python3 benchmarks/run_toolathlon_agencybench.py --dataset toolathlon --all

    # Run all AgencyBench tasks
    python3 benchmarks/run_toolathlon_agencybench.py --dataset agencybench --all

    # Run specific task
    python3 benchmarks/run_toolathlon_agencybench.py --task-id finalpool-academic-pdf-report

    # Resume from previous results
    python3 benchmarks/run_toolathlon_agencybench.py --dataset toolathlon --all --resume

    # Skip LLM evaluation (faster)
    python3 benchmarks/run_toolathlon_agencybench.py --dataset toolathlon --all --skip-eval
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
EVAL_ENDPOINT = os.environ.get("EVAL_ENDPOINT", "https://api.z.ai/api/anthropic/v1/messages")
EVAL_API_KEY = os.environ.get(
    "EVAL_API_KEY", "59a816c2acd54338a773936fefc0cb77.FgAcgymYXgYQmEbk"
)

# Timeout settings
DEFAULT_TIMEOUT = 600  # 10 minutes per task
LONG_TIMEOUT = 1800   # 30 minutes for complex tasks

# KB name -> UUID mapping (default knowledge base for testing)
DEFAULT_KB_UUID = "89ee4db6-0626-4636-8c66-49a575d05832"

RESULTS_DIR = Path(__file__).parent / "results"
TOOLATHLET_TASKS_FILE = Path(__file__).parent / "toolathlon-tasks" / "all-tasks.json"
AGENCYBENCH_TASKS_FILE = Path(__file__).parent / "agencybench-tasks" / "all-tasks.json"
GROUP_SIZE = 3  # Tasks per group


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
# Task Loading
# ---------------------------------------------------------------------------


def load_toolathlon_tasks() -> list[dict]:
    """Load all Toolathlon tasks."""
    if not TOOLATHLET_TASKS_FILE.exists():
        print(f"ERROR: Toolathlon tasks file not found: {TOOLATHLET_TASKS_FILE}")
        print("Run download-remaining-tasks.py first.")
        sys.exit(1)

    with open(TOOLATHLET_TASKS_FILE, encoding="utf-8") as f:
        tasks = json.load(f)

    # Filter to only tasks with prompts
    valid = [t for t in tasks if t.get("prompt")]
    print(f"Toolathlon: {len(valid)}/{len(tasks)} tasks have prompts")
    return valid


def load_agencybench_tasks() -> list[dict]:
    """Load all AgencyBench tasks."""
    if not AGENCYBENCH_TASKS_FILE.exists():
        print(f"ERROR: AgencyBench tasks file not found: {AGENCYBENCH_TASKS_FILE}")
        print("Run download-remaining-tasks.py first.")
        sys.exit(1)

    with open(AGENCYBENCH_TASKS_FILE, encoding="utf-8") as f:
        tasks = json.load(f)

    valid = [t for t in tasks if t.get("description") or t.get("prompt")]
    print(f"AgencyBench: {len(valid)}/{len(tasks)} tasks have descriptions")
    return tasks


def load_all_tasks(dataset: str = "all") -> list[dict]:
    """Load tasks from specified dataset."""
    tasks = []
    if dataset in ("all", "toolathlon"):
        tasks.extend(load_toolathlon_tasks())
    if dataset in ("all", "agencybench"):
        tasks.extend(load_agencybench_tasks())
    return tasks


def group_tasks(tasks: list[dict], group_size: int = GROUP_SIZE) -> list[list[dict]]:
    """Split tasks into groups."""
    return [tasks[i:i + group_size] for i in range(0, len(tasks), group_size)]


# ---------------------------------------------------------------------------
# Session Management
# ---------------------------------------------------------------------------


def create_session(title: str, kb_scope_uuids: list[str] | None = None) -> str:
    """Create a test session with optional KB scope."""
    data = {"title": title}
    if kb_scope_uuids:
        data["kbScope"] = kb_scope_uuids
    result = api_request("POST", "/api/sessions", data)
    if "error" in result:
        raise RuntimeError(f"Failed to create session: {result['error']}")
    return result["id"]


def delete_session(session_id: str):
    """Delete a test session."""
    api_request("DELETE", f"/api/sessions/{session_id}")


# ---------------------------------------------------------------------------
# Test Execution
# ---------------------------------------------------------------------------


def run_single_task(task: dict, session_id: str | None = None) -> dict:
    """Execute a single benchmark task and collect all process data."""
    prompt = task.get("prompt") or task.get("description", "")
    task_id = task.get("id", task.get("task_name", "unknown"))

    if not prompt:
        return {
            "task_id": task_id,
            "dataset": task.get("dataset", "unknown"),
            "completed": False,
            "errors": ["No prompt/description available"],
            "full_content": "",
        }

    # Create session if not provided
    own_session = session_id is None
    if own_session:
        session_id = create_session(
            f"bench-{task_id}-{datetime.now().strftime('%H%M%S')}",
            [DEFAULT_KB_UUID],
        )

    timeout = LONG_TIMEOUT if len(prompt) > 500 else DEFAULT_TIMEOUT

    result = {
        "task_id": task_id,
        "task_name": task.get("task_name", ""),
        "dataset": task.get("dataset", "Toolathlon"),
        "capability": task.get("capability", ""),
        "session_id": session_id,
        "prompt": prompt[:500],
        "needed_tools": task.get("needed_tools", []),
        "started_at": datetime.now().isoformat(),
        "tool_calls": [],
        "push_contents": [],
        "content_deltas": [],
        "turns": 0,
        "full_content": "",
        "errors": [],
        "completed": False,
        "timeout": timeout,
    }

    print(f"\n  [{task_id}] Session: {session_id}")
    print(f"  Query: {prompt[:100]}...")
    print(f"  Timeout: {timeout}s")

    try:
        for event_type, event_data in sse_stream(
            "/api/agents/run-stream",
            {"sessionId": session_id, "input": prompt},
            timeout=timeout,
        ):
            if event_type == "start":
                result["task_id_internal"] = event_data.get("taskId")
            elif event_type == "content_delta":
                # Streaming delta — preferred for content accumulation
                delta = event_data.get("delta", "")
                if delta:
                    result["content_deltas"].append(delta)
                    result["full_content"] += delta
            elif event_type == "content":
                # Full content snapshot — only use if no deltas accumulated
                # (avoid double-counting since progress events also carry this)
                pass
            elif event_type == "progress":
                ptype = event_data.get("type", "")
                if ptype == "text":
                    # Skip — content_delta already captures this
                    pass
                elif ptype == "tool_call":
                    tool_name = event_data.get("toolName", "")
                    if tool_name:
                        result["tool_calls"].append({
                            "tool": tool_name,
                            "input": event_data.get("toolInput", {}),
                        })
                elif ptype == "tool_result":
                    pass  # Tool completed
            elif event_type == "turn":
                result["turns"] = event_data.get("turn", 0)
            elif event_type == "tool_call":
                result["tool_calls"].append({
                    "tool": event_data.get("toolName", ""),
                    "input": event_data.get("input", {}),
                })
            elif event_type == "tool_result":
                pass  # Tool result received
            elif event_type == "push_content":
                result["push_contents"].append({
                    "title": event_data.get("title", ""),
                    "type": event_data.get("type", ""),
                    "data_length": len(event_data.get("data", "")),
                })
            elif event_type == "complete":
                result["completed"] = True
                result["output"] = event_data.get("output", "")
                # Use complete event's output as fallback if no deltas accumulated
                if not result["full_content"] and result["output"]:
                    result["full_content"] = result["output"]
                # If full_content is shorter than output, prefer output
                if result["output"] and len(result["full_content"]) < len(result["output"]):
                    result["full_content"] = result["output"]
            elif event_type == "done":
                result["completed"] = True
                result["turns"] = event_data.get("turnsUsed", result["turns"])
                result["usage_summary"] = event_data.get("usage", {})
            elif event_type == "error":
                result["errors"].append(event_data.get("error", "unknown error"))
            elif event_type == "compaction":
                result.setdefault("compactions", []).append({
                    "before": event_data.get("beforeTokens", 0),
                    "after": event_data.get("afterTokens", 0),
                })
    except Exception as e:
        result["errors"].append(str(e))

    result["ended_at"] = datetime.now().isoformat()
    result["duration_seconds"] = (
        datetime.fromisoformat(result["ended_at"])
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
    print(f"  Output: {len(result['full_content'])} chars, Completed: {result['completed']}")
    if result["errors"]:
        print(f"  Errors: {result['errors']}")

    if own_session:
        # Don't delete session so we can inspect later
        pass

    return result


# ---------------------------------------------------------------------------
# LLM-based Evaluation
# ---------------------------------------------------------------------------


def evaluate_result(task: dict, result: dict) -> dict:
    """Evaluate a test result using LLM assessment."""
    if not result["completed"] and not result["full_content"]:
        return {
            "score": 0,
            "verdict": "FAIL",
            "reason": "Agent failed to produce any output",
            "issues": ["no_output"],
        }

    answer_text = result["full_content"]

    # Include finish tool summary if present
    for tc in result.get("tool_calls", []):
        if tc.get("tool") == "finish" and tc.get("input", {}).get("summary"):
            finish_summary = tc["input"]["summary"]
            if finish_summary and len(finish_summary) > 10:
                answer_text += f"\n\n[Agent's finish summary]:\n{finish_summary}"
            break

    # Build evaluation criteria
    criteria = task.get("evaluation_criteria", "")
    if not criteria:
        criteria = "Task completion and output quality"

    eval_prompt = f"""你是一个严格的测试评估员。请评估以下AI Agent的任务执行质量。

## 任务描述
{task.get("prompt", task.get("description", ""))}

## 需要的工具
{", ".join(task.get("needed_tools", ["通用"]))}

## 评估标准
{criteria}

## Agent的输出（截断到前16000字符）
{answer_text[:16000]}

## 工具调用记录
{json.dumps(result.get("tool_call_summary", {}), ensure_ascii=False)}

## push_content 输出
{len(result.get("push_contents", []))} 个push_content输出

请用以下JSON格式回答（不要包含其他内容）：
{{
    "score": <0-100的整数分数>,
    "task_completed": <true/false>,
    "output_quality": "<low/medium/high>",
    "tool_usage_appropriate": <true/false>,
    "reason": "<简短的评估理由>",
    "issues": ["<问题1>", "<问题2>"],
    "suggestions": ["<优化建议1>", "<优化建议2>"]
}}"""

    # Call evaluation LLM
    try:
        eval_body = json.dumps({
            "model": EVAL_MODEL,
            "max_tokens": 1024,
            "messages": [
                {"role": "user", "content": eval_prompt}
            ]
        }).encode()

        req = urllib.request.Request(EVAL_ENDPOINT, data=eval_body, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("x-api-key", EVAL_API_KEY)
        req.add_header("anthropic-version", "2023-06-01")

        with urllib.request.urlopen(req, timeout=60) as resp:
            resp_data = json.loads(resp.read().decode())
            eval_text = resp_data["content"][0]["text"]

            # Extract JSON from response
            json_match = re.search(r'\{[\s\S]*\}', eval_text)
            if json_match:
                return json.loads(json_match.group())
            else:
                return {
                    "score": 50,
                    "verdict": "UNCLEAR",
                    "reason": f"Could not parse evaluation: {eval_text[:200]}",
                    "issues": [],
                    "suggestions": [],
                }
    except Exception as e:
        return {
            "score": -1,
            "verdict": "EVAL_ERROR",
            "reason": f"Evaluation failed: {e}",
            "issues": ["eval_error"],
            "suggestions": [],
        }


# ---------------------------------------------------------------------------
# Results Management
# ---------------------------------------------------------------------------


def get_result_file(dataset: str) -> Path:
    """Get the result file path for a dataset."""
    RESULTS_DIR.mkdir(exist_ok=True)
    return RESULTS_DIR / f"{dataset}-results.json"


def load_existing_results(dataset: str) -> dict[str, dict]:
    """Load existing results for resume capability."""
    result_file = get_result_file(dataset)
    if not result_file.exists():
        return {}

    with open(result_file, encoding="utf-8") as f:
        results = json.load(f)

    return {r["task_id"]: r for r in results if "task_id" in r}


def save_results(results: list[dict], dataset: str):
    """Save results to file."""
    result_file = get_result_file(dataset)
    RESULTS_DIR.mkdir(exist_ok=True)
    with open(result_file, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\nResults saved to {result_file}")


def save_group_observations(group_results: list[dict], group_idx: int, dataset: str):
    """Save detailed observations for a group of test results."""
    obs_dir = RESULTS_DIR / dataset / "observations"
    obs_dir.mkdir(parents=True, exist_ok=True)

    obs_file = obs_dir / f"group-{group_idx:03d}.md"
    with open(obs_file, "w", encoding="utf-8") as f:
        f.write(f"# {dataset.upper()} Group {group_idx} - Test Observations\n\n")
        f.write(f"Date: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n")

        for r in group_results:
            f.write(f"## Task: {r.get('task_id', 'unknown')}\n\n")
            f.write(f"- **Status**: {'Completed' if r.get('completed') else 'Failed'}\n")
            f.write(f"- **Duration**: {r.get('duration_seconds', 0):.1f}s\n")
            f.write(f"- **Turns**: {r.get('turns', 0)}\n")
            f.write(f"- **Tool Calls**: {json.dumps(r.get('tool_call_summary', {}), ensure_ascii=False)}\n")
            f.write(f"- **Output Length**: {len(r.get('full_content', ''))} chars\n")

            if r.get("errors"):
                f.write(f"- **Errors**: {r['errors']}\n")

            if r.get("eval"):
                ev = r["eval"]
                f.write(f"- **Score**: {ev.get('score', 'N/A')}\n")
                f.write(f"- **Quality**: {ev.get('output_quality', 'N/A')}\n")
                f.write(f"- **Issues**: {ev.get('issues', [])}\n")
                f.write(f"- **Suggestions**: {ev.get('suggestions', [])}\n")

            # Include truncated output
            content = r.get("full_content", "")
            if content:
                f.write(f"\n### Output Preview\n```\n{content[:2000]}\n```\n")

            f.write("\n---\n\n")

    print(f"  Observations saved to {obs_file}")


# ---------------------------------------------------------------------------
# Main Execution
# ---------------------------------------------------------------------------


def run_group(
    tasks: list[dict],
    group_idx: int,
    dataset: str,
    skip_eval: bool = False,
    existing: dict[str, dict] | None = None,
) -> list[dict]:
    """Run a group of tasks."""
    print(f"\n{'='*60}")
    print(f"Group {group_idx}: {len(tasks)} tasks")
    print(f"{'='*60}")

    results = []
    for task in tasks:
        task_id = task.get("id", task.get("task_name", "unknown"))

        # Skip if already completed
        if existing and task_id in existing:
            prev = existing[task_id]
            if prev.get("completed") and prev.get("eval", {}).get("score", 0) >= 95:
                print(f"\n  [{task_id}] Skipping (already passed with score {prev['eval']['score']})")
                results.append(prev)
                continue

        print(f"\n--- Task: {task_id} ---")
        result = run_single_task(task)
        result["dataset"] = dataset

        # Evaluate
        if not skip_eval and result["full_content"]:
            print(f"  Evaluating...")
            result["eval"] = evaluate_result(task, result)
            score = result["eval"].get("score", 0)
            print(f"  Score: {score}/100")
            if result["eval"].get("issues"):
                print(f"  Issues: {result['eval']['issues']}")

        results.append(result)
        time.sleep(2)  # Brief pause between tasks

    # Save group observations
    save_group_observations(results, group_idx, dataset)

    return results


def run_all(
    dataset: str = "all",
    skip_eval: bool = False,
    resume: bool = False,
    start_group: int = 0,
    end_group: int | None = None,
):
    """Run all tasks in groups of GROUP_SIZE."""
    # Check backend health
    health = api_request("GET", "/api/health")
    if "error" in health:
        print(f"ERROR: Backend not reachable at {BASE_URL}")
        sys.exit(1)
    print(f"Backend: {health.get('version', 'unknown')}")

    all_tasks = load_all_tasks(dataset)
    if not all_tasks:
        print("No tasks to run.")
        return

    groups = group_tasks(all_tasks)
    print(f"Total: {len(all_tasks)} tasks in {len(groups)} groups")

    all_results = []

    # Load existing results for resume
    existing = {}
    if resume:
        existing = load_existing_results(dataset)
        print(f"Loaded {len(existing)} existing results for resume")

    for idx, group in enumerate(groups):
        if idx < start_group:
            continue
        if end_group is not None and idx > end_group:
            break

        group_results = run_group(
            group, idx, dataset, skip_eval=skip_eval, existing=existing if resume else None
        )
        all_results.extend(group_results)

        # Save progress after each group
        save_results(all_results, dataset)

    # Print final report
    print_report(all_results, dataset)


def run_single(task_id: str, skip_eval: bool = False):
    """Run a single task by ID."""
    health = api_request("GET", "/api/health")
    if "error" in health:
        print(f"ERROR: Backend not reachable at {BASE_URL}")
        sys.exit(1)

    # Find task
    for loader in [load_toolathlon_tasks, load_agencybench_tasks]:
        tasks = loader()
        for t in tasks:
            if t.get("id") == task_id or t.get("task_name") == task_id:
                print(f"Found task: {t.get('id')}")
                result = run_single_task(t)
                result["dataset"] = t.get("dataset", "unknown")

                if not skip_eval and result["full_content"]:
                    result["eval"] = evaluate_result(t, result)
                    print(f"\nScore: {result['eval'].get('score', 'N/A')}/100")

                # Save
                result_file = RESULTS_DIR / f"single-{task_id}.json"
                RESULTS_DIR.mkdir(exist_ok=True)
                with open(result_file, "w", encoding="utf-8") as f:
                    json.dump([result], f, ensure_ascii=False, indent=2)
                print(f"Result saved to {result_file}")
                return

    print(f"Task '{task_id}' not found.")


def list_tasks(dataset: str = "all"):
    """List all available tasks."""
    tasks = load_all_tasks(dataset)
    groups = group_tasks(tasks)

    for idx, group in enumerate(groups):
        print(f"\nGroup {idx}:")
        for t in group:
            tid = t.get("id", t.get("task_name", "?"))
            prompt_preview = (t.get("prompt") or t.get("description", ""))[:60]
            tools = ", ".join(t.get("needed_tools", [])[:3])
            print(f"  {tid}: {prompt_preview}... [{tools}]")


def print_report(results: list[dict], dataset: str):
    """Print a summary report."""
    total = len(results)
    completed = sum(1 for r in results if r.get("completed"))
    failed = total - completed

    scores = [r["eval"]["score"] for r in results if r.get("eval", {}).get("score") is not None]
    avg_score = sum(scores) / len(scores) if scores else 0
    pass_count = sum(1 for s in scores if s >= 95)

    print(f"\n{'='*60}")
    print(f"BENCHMARK REPORT: {dataset.upper()}")
    print(f"{'='*60}")
    print(f"Total tasks: {total}")
    print(f"Completed: {completed} ({completed/total*100:.0f}%)")
    print(f"Failed: {failed}")
    print(f"Average score: {avg_score:.1f}/100")
    print(f"Passed (>=95): {pass_count}/{len(scores)} ({pass_count/len(scores)*100:.0f}%)" if scores else "")

    # Score distribution
    if scores:
        ranges = [(0, 20), (20, 40), (40, 60), (60, 80), (80, 95), (95, 101)]
        print(f"\nScore distribution:")
        for lo, hi in ranges:
            count = sum(1 for s in scores if lo <= s < hi)
            bar = "#" * count
            label = f"{lo}-{hi}" if hi <= 100 else f"{lo}+"
            print(f"  {label:>8}: {bar} ({count})")

    # Common issues
    all_issues = []
    for r in results:
        if r.get("eval", {}).get("issues"):
            all_issues.extend(r["eval"]["issues"])
    if all_issues:
        from collections import Counter
        issue_counts = Counter(all_issues)
        print(f"\nCommon issues:")
        for issue, count in issue_counts.most_common(10):
            print(f"  {issue}: {count}")

    # Suggestions
    all_suggestions = []
    for r in results:
        if r.get("eval", {}).get("suggestions"):
            all_suggestions.extend(r["eval"]["suggestions"])
    if all_suggestions:
        from collections import Counter
        sug_counts = Counter(all_suggestions)
        print(f"\nTop optimization suggestions:")
        for sug, count in sug_counts.most_common(10):
            print(f"  [{count}x] {sug}")

    print(f"\n{'='*60}")


def main():
    parser = argparse.ArgumentParser(description="Toolathlon + AgencyBench Runner for DeepAnalyze")
    parser.add_argument("--list", action="store_true", help="List all test cases")
    parser.add_argument("--dataset", choices=["toolathlon", "agencybench", "all"], default="toolathlon")
    parser.add_argument("--task-id", type=str, help="Run a specific task by ID")
    parser.add_argument("--group", type=int, help="Run a specific group number")
    parser.add_argument("--all", action="store_true", help="Run all tasks")
    parser.add_argument("--skip-eval", action="store_true", help="Skip LLM evaluation")
    parser.add_argument("--resume", action="store_true", help="Resume from previous results")
    parser.add_argument("--start-group", type=int, default=0, help="Start from this group")
    parser.add_argument("--end-group", type=int, help="End at this group (inclusive)")

    args = parser.parse_args()

    if args.list:
        list_tasks(args.dataset)
    elif args.task_id:
        run_single(args.task_id, skip_eval=args.skip_eval)
    elif args.group is not None:
        # Run a specific group
        tasks = load_all_tasks(args.dataset)
        groups = group_tasks(tasks)
        if args.group < len(groups):
            results = run_group(groups[args.group], args.group, args.dataset, skip_eval=args.skip_eval)
            save_results(results, args.dataset)
        else:
            print(f"Group {args.group} not found. Total groups: {len(groups)}")
    elif args.all:
        run_all(
            dataset=args.dataset,
            skip_eval=args.skip_eval,
            resume=args.resume,
            start_group=args.start_group,
            end_group=args.end_group,
        )
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
