#!/bin/bash
# DeepAnalyze Agent Test Runner
# Usage: ./run-test-batch.sh <test_file.json> <start_index> <count>
# Runs tests one by one and captures full agent output

set -euo pipefail

BASE_URL="http://localhost:21000"
RESULTS_DIR="/mnt/d/code/deepanalyze/deepanalyze/test-reports/iterative-test"

mkdir -p "$RESULTS_DIR"

TEST_FILE="${1:-/mnt/d/code/deepanalyze/test-data/gaia-tests.json}"
START_IDX="${2:-0}"
COUNT="${3:-10}"

echo "=== DeepAnalyze Test Batch Runner ==="
echo "Test file: $TEST_FILE"
echo "Start index: $START_IDX, Count: $COUNT"
echo "Results dir: $RESULTS_DIR"
echo ""

# Extract test items using python
python3 -c "
import json, sys
with open('$TEST_FILE') as f:
    tests = json.load(f)
start = $START_IDX
count = $COUNT
batch = tests[start:start+count]
for i, t in enumerate(batch):
    print(f'{start+i}\t{t[\"id\"]}\t{t.get(\"level\",\"?\")}\t{t[\"prompt\"][:80]}')
" 2>/dev/null

echo ""
echo "Starting tests..."

# Run each test
python3 << 'PYEOF'
import json, subprocess, time, sys, os

BASE_URL = "http://localhost:21000"
RESULTS_DIR = "/mnt/d/code/deepanalyze/deepanalyze/test-reports/iterative-test"

test_file = sys.argv[1] if len(sys.argv) > 1 else "/mnt/d/code/deepanalyze/test-data/gaia-tests.json"
start_idx = int(sys.argv[2]) if len(sys.argv) > 2 else 0
count = int(sys.argv[3]) if len(sys.argv) > 3 else 10

with open(test_file) as f:
    tests = json.load(f)

batch = tests[start_idx:start_idx+count]

for i, test in enumerate(batch):
    test_id = test["id"]
    prompt = test["prompt"]
    expected = test.get("answer", "")
    evaluation = test.get("evaluation", "")

    print(f"\n{'='*80}")
    print(f"TEST [{i+1}/{len(batch)}]: {test_id}")
    print(f"Level: {test.get('level', '?')}")
    print(f"Prompt: {prompt[:200]}")
    print(f"Expected: {expected}")
    print(f"{'='*80}")

    # Create session
    result = subprocess.run(
        ["curl", "-s", "-X", "POST", f"{BASE_URL}/api/sessions",
         "-H", "Content-Type: application/json", "-d", "{}"],
        capture_output=True, text=True, timeout=10
    )
    session = json.loads(result.stdout)
    session_id = session["id"]
    print(f"Session: {session_id}")

    # Run agent query
    start_time = time.time()
    try:
        result = subprocess.run(
            ["curl", "-s", "-N", "-X", "POST", f"{BASE_URL}/api/agents/run-stream",
             "-H", "Content-Type: application/json",
             "-d", json.dumps({"sessionId": session_id, "input": prompt})],
            capture_output=True, text=True, timeout=300
        )
        elapsed = time.time() - start_time

        # Parse SSE events
        output = result.stdout
        events = []
        tool_calls = []
        final_output = ""
        turns = 0
        finish_summary = ""

        for line in output.split("\n"):
            if line.startswith("event: "):
                event_type = line[7:].strip()
                events.append(event_type)
            elif line.startswith("data: "):
                try:
                    data = json.loads(line[6:])
                    if event_type == "complete":
                        final_output = data.get("output", "")
                        turns = data.get("turnsUsed", 0)
                    if event_type == "tool_call":
                        tool_calls.append({
                            "tool": data.get("toolName", ""),
                            "input": data.get("input", {}),
                        })
                    if event_type == "tool_result":
                        tc = {
                            "tool": data.get("toolName", ""),
                            "output": data.get("output", ""),
                        }
                        # Check if finish tool
                        if data.get("toolName") == "finish":
                            try:
                                finish_data = json.loads(data.get("output", "{}"))
                                finish_summary = finish_data.get("summary", "")
                            except:
                                pass
                        tool_calls.append(tc)
                except:
                    pass

        # Determine actual answer
        actual_output = finish_summary if finish_summary else final_output

        print(f"\n--- RESULT ---")
        print(f"Turns: {turns}")
        print(f"Time: {elapsed:.1f}s")
        print(f"Tool calls: {len([tc for tc in tool_calls if 'output' not in tc])}")
        print(f"Tools used: {list(set(tc.get('tool','') for tc in tool_calls if tc.get('tool')))}")
        print(f"Finish summary: {finish_summary[:200]}")
        print(f"Final output: {final_output[:200]}")
        print(f"Actual answer: {actual_output[:200]}")
        print(f"Expected: {expected}")

        # Save result
        result_entry = {
            "test_id": test_id,
            "level": test.get("level", "?"),
            "prompt": prompt,
            "expected": expected,
            "actual": actual_output,
            "finish_summary": finish_summary,
            "final_output": final_output,
            "turns": turns,
            "elapsed_seconds": round(elapsed, 1),
            "tool_calls": tool_calls,
            "events": events,
        }
        result_file = os.path.join(RESULTS_DIR, f"{test_id}-result.json")
        with open(result_file, "w") as f:
            json.dump(result_entry, f, ensure_ascii=False, indent=2)
        print(f"Result saved to: {result_file}")

    except subprocess.TimeoutExpired:
        print(f"TIMEOUT after 300s!")
    except Exception as e:
        print(f"ERROR: {e}")
    finally:
        # Cleanup session
        subprocess.run(
            ["curl", "-s", "-X", "DELETE", f"{BASE_URL}/api/sessions/{session_id}"],
            capture_output=True, text=True, timeout=5
        )

print("\n\nBatch complete!")
PYEOF
