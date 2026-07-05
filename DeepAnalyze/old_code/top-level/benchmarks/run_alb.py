#!/usr/bin/env python3
"""
Agent Long Bench Test Runner for DeepAnalyze
==============================================
Tests long-context understanding by sending ALB prompts directly to the agent.
No knowledge base needed — the full prompt is the input.
"""

import json
import os
import sys
import time
import urllib.request
import re
from datetime import datetime
from pathlib import Path

BASE_URL = os.environ.get("DEEPANALYZE_URL", "http://localhost:21000")
RESULTS_DIR = Path("/mnt/d/code/deepanalyze/deepanalyze/test-reports/agent-long-bench-v2")

def api_request(method, path, data=None, timeout=30):
    url = f"{BASE_URL}{path}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.read().decode()[:300]}"}
    except Exception as e:
        return {"error": str(e)}


def run_alb_case(case, session_id=None):
    """Run a single ALB test case. For long prompts (>100K chars), writes to file first."""
    case_id = case["id"]
    prompt = case["prompt"]
    expected = case["expected_answer"]
    category = case.get("category", "")
    prompt_len = len(prompt)

    # Create a fresh session
    if not session_id:
        result = api_request("POST", "/api/sessions", {"title": f"ALB-{case_id}"})
        if "error" in result:
            return {"id": case_id, "error": f"Session creation failed: {result['error']}"}
        session_id = result["id"]

    result = {
        "id": case_id,
        "category": category,
        "session_id": session_id,
        "expected_answer": str(expected),
        "prompt_length": prompt_len,
        "started_at": datetime.now().isoformat(),
        "tool_calls": [],
        "full_content": "",
        "turns": 0,
        "errors": [],
    }

    print(f"  Running {case_id} [{category}] prompt={prompt_len:>6} chars expected={str(expected)[:50]}")

    # For long prompts: write to file and instruct agent to use tools
    if prompt_len > 80000:
        # Write the long text to a temp file that the agent can access via tools
        tmp_dir = Path("/tmp/alb-data")
        tmp_dir.mkdir(exist_ok=True)
        tmp_file = tmp_dir / f"{case_id}.txt"
        tmp_file.write_text(prompt)
        print(f"    Written to {tmp_file} ({prompt_len} chars)")

        # Build agent instruction: read file and answer question
        # The prompt typically ends with a question; extract it
        lines = prompt.strip().split('\n')
        # Find the last non-empty line as the question
        question = ""
        for line in reversed(lines):
            if line.strip():
                question = line.strip()
                break

        agent_input = (
            f"下面是一个很长的文件，已经保存在 {tmp_file} 中（共 {prompt_len} 字符）。\n"
            f"这个文件的内容是一个 Pokemon 猜谜游戏的完整对话历史。文件末尾有一个最终问题需要你回答。\n\n"
            f"请按以下步骤操作：\n"
            f"1. 先用 tail 命令查看文件末尾，找到最终问题\n"
            f"2. 根据问题类型，用 grep/bash 等工具在文件中搜索关键信息\n"
            f"3. 不要试图一次性读取整个文件（太长），应该用 grep/sed 精确搜索\n"
            f"4. 只给出精确答案（数字、名称或布尔值），不需要解释\n\n"
            f"文件路径: {tmp_file}\n"
        )
    else:
        # Short enough to fit in context
        agent_input = prompt

    try:
        url = f"{BASE_URL}/api/agents/run-stream"
        body = json.dumps({"sessionId": session_id, "input": agent_input}).encode()
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "text/event-stream")

        with urllib.request.urlopen(req, timeout=600) as resp:
            event_type = None
            data_buf = ""
            for raw_line in resp:
                line = raw_line.decode("utf-8", errors="replace").rstrip("\n").rstrip("\r")
                if line.startswith(":"):
                    continue
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

                        if event_type == "content_delta":
                            result["full_content"] += parsed.get("delta", "")
                        elif event_type == "turn":
                            result["turns"] = parsed.get("turn", 0)
                        elif event_type == "tool_call":
                            result["tool_calls"].append({
                                "tool": parsed.get("toolName"),
                                "input": parsed.get("input"),
                            })
                        elif event_type == "complete":
                            result["completed"] = True
                        elif event_type == "error":
                            result["errors"].append(parsed.get("error", "unknown"))
                    event_type = None
                    data_buf = ""
    except Exception as e:
        result["errors"].append(f"Stream error: {str(e)}")

    result["finished_at"] = datetime.now().isoformat()
    result["duration_seconds"] = (
        datetime.fromisoformat(result["finished_at"])
        - datetime.fromisoformat(result["started_at"])
    ).total_seconds()

    # Evaluate: extract answer from content
    # Priority: finish tool summary > last content line
    finish_summary = None
    for tc in result["tool_calls"]:
        if tc["tool"] == "finish":
            finish_summary = tc.get("input", {}).get("summary", "")
            break

    if finish_summary:
        result["raw_answer"] = finish_summary.strip()
    else:
        result["raw_answer"] = extract_answer(result["full_content"])

    result["match"] = check_match(result["raw_answer"], expected)
    result["pass"] = result["match"]

    status = "PASS" if result["pass"] else "FAIL"
    print(f"    {status} | Turns:{result['turns']} Duration:{result['duration_seconds']:.0f}s")
    print(f"    Expected: {str(expected)[:80]}")
    print(f"    Got:      {str(result['raw_answer'])[:80]}")
    if result["errors"]:
        print(f"    Errors: {result['errors']}")

    return result


def extract_answer(content):
    """Extract the final numeric/list answer from agent output."""
    if not content:
        return None

    # Look for explicit answer patterns
    patterns = [
        r'(?:answer|result|final answer|答案是|结果是)\s*(?:is|:|=)?\s*[`"\']*([^\n`"]+)',
        r'(?:The answer is|Answer:)\s*(.+)',
        r'\*\*Answer\*\*[:\s]*(.+)',
        r'最终答案[：:]\s*(.+)',
    ]
    for pat in patterns:
        m = re.search(pat, content, re.IGNORECASE)
        if m:
            return m.group(1).strip().rstrip('.')

    # For boolean answers
    if re.search(r'\b(True|False)\b', content[-500:]):
        m = re.findall(r'\b(True|False)\b', content[-500:])
        if m:
            return m[-1]

    # For numeric answers - look at the last portion
    last_part = content[-1000:]
    # Look for standalone numbers
    nums = re.findall(r'-?\d+(?:\.\d+)?', last_part)
    if nums:
        return nums[-1]

    # For list answers
    list_match = re.findall(r'\[[\d\s,\'\"]+\]', last_part)
    if list_match:
        return list_match[-1]

    # Return last non-empty line
    lines = [l.strip() for l in content.split('\n') if l.strip()]
    if lines:
        return lines[-1][:200]

    return None


def check_match(answer, expected):
    """Check if extracted answer matches expected."""
    if answer is None:
        return False

    ans_str = str(answer).strip().lower()
    exp_str = str(expected).strip().lower()

    # Direct match
    if ans_str == exp_str:
        return True

    # Numeric match
    try:
        if float(ans_str) == float(exp_str):
            return True
    except (ValueError, TypeError):
        pass

    # List match - normalize and compare
    try:
        ans_list = json.loads(ans_str) if ans_str.startswith('[') else [ans_str]
        exp_list = json.loads(exp_str) if exp_str.startswith('[') else [exp_str]
        if isinstance(ans_list, list) and isinstance(exp_list, list):
            ans_set = set(str(x).strip().lower() for x in ans_list)
            exp_set = set(str(x).strip().lower() for x in exp_list)
            if ans_set == exp_set:
                return True
    except (json.JSONDecodeError, TypeError):
        pass

    # Substring match for partial credit
    if exp_str in ans_str:
        return True

    return False


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=str, default=None, help="Comma-separated case IDs (e.g. ALB-240,ALB-242)")
    parser.add_argument("--count", type=int, default=10, help="Number of cases to run")
    parser.add_argument("--list", action="store_true", help="List available cases with sizes")
    args = parser.parse_args()

    with open("/mnt/d/code/deepanalyze/benchmarks/agent-long-bench/unified.json") as f:
        all_cases = json.load(f)

    if args.list:
        # Sort by length, show manageable ones first
        cases_sorted = sorted(all_cases, key=lambda x: len(x.get('prompt', '')))
        for c in cases_sorted[:30]:
            plen = len(c.get('prompt', ''))
            print(f"  {c['id']:8} {c.get('category',''):40} {plen:>8} chars  answer={str(c.get('expected_answer',''))[:50]}")
        print(f"\n... total {len(all_cases)} cases")
        return

    # Select cases
    if args.cases:
        ids = [x.strip() for x in args.cases.split(",")]
        cases = [c for c in all_cases if c["id"] in ids]
        if not cases:
            print(f"No matching cases found for IDs: {ids}")
            return
    else:
        # Pick cases across different size brackets for comprehensive testing
        by_cat = {}
        for item in all_cases:
            cat = item.get("category", "")
            if cat not in by_cat:
                by_cat[cat] = []
            by_cat[cat].append(item)

        cases = []
        # 2 medium (100-300K), 3 long (300K-1M), 3 very long (1-3M), 2 ultra (3M+)
        brackets = [
            (100000, 300000, 2),
            (300000, 1000000, 3),
            (1000000, 3000000, 3),
            (3000000, 10000000, 2),
        ]
        for lo, hi, cnt in brackets:
            pool = [item for item in all_cases if lo <= len(item.get("prompt", "")) < hi]
            pool.sort(key=lambda x: len(x.get("prompt", "")))
            # Pick evenly spaced
            if len(pool) >= cnt:
                step = len(pool) // cnt
                for i in range(cnt):
                    cases.append(pool[i * step])
            else:
                cases.extend(pool)

        cases = cases[:args.count]

    print(f"Running {len(cases)} Agent Long Bench cases")
    print("=" * 60)

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    results = []

    for i, case in enumerate(cases):
        print(f"\n[{i+1}/{len(cases)}] {case['id']} ({case.get('category','')})")
        result = run_alb_case(case)
        results.append(result)

        # Save after each case
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        with open(RESULTS_DIR / f"batch_result.json", "w") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    total = len(results)
    passed = sum(1 for r in results if r.get("pass"))
    print(f"Total: {total}, Passed: {passed}, Failed: {total - passed}")
    print(f"Pass Rate: {100*passed/total:.0f}%")
    print()
    for r in results:
        status = "PASS" if r.get("pass") else "FAIL"
        print(f"  [{status:4}] {r['id']:8} expected={r.get('expected_answer','?')[:40]} got={str(r.get('raw_answer',''))[:40]}")

    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
