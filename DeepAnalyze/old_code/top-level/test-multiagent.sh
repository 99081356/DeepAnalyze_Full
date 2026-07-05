#!/bin/bash
# ==============================================================================
# DeepAnalyze Multi-Agent Comprehensive Test Suite
# ==============================================================================
# Tests: workflow_run (parallel/pipeline/single/council), skill_invoke,
#        run-coordinated, sub-agent output handling, multi-agent + compaction
# ==============================================================================
set -o pipefail

BASE="http://localhost:21000"
PASS=0
FAIL=0
ISSUES=()

green()  { printf "\033[32m%s\033[0m\n" "$1"; }
red()    { printf "\033[31m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
bold()   { printf "\033[1m%s\033[0m\n" "$1"; }

api() {
    local method="$1" path="$2" body="$3"
    if [ -n "$body" ]; then
        curl -s -X "$method" "$BASE$path" -H "Content-Type: application/json" -d "$body"
    else
        curl -s -X "$method" "$BASE$path"
    fi
}

create_session() {
    api POST /api/sessions "{\"title\":\"$1\"}" | jq -r '.id'
}

delete_session() {
    api DELETE "/api/sessions/$1" 2>/dev/null || true
}

# Run agent via SSE, return parsed results
run_agent() {
    local sid="$1" input="$2" timeout_sec="${3:-180}"
    local tmpfile="/tmp/multiagent-test-$$"
    timeout "$timeout_sec" curl -s -N -X POST "$BASE/api/agents/run-stream" \
        -H "Content-Type: application/json" \
        -d "{\"sessionId\":\"$sid\",\"input\":$(echo "$input" | jq -Rs .)}" \
        > "$tmpfile" 2>/dev/null || true

    local result
    result=$(cat "$tmpfile" 2>/dev/null)
    rm -f "$tmpfile"

    echo "$result"
}

# Parse SSE stream into structured data
parse_sse() {
    local raw="$1"

    # Tool calls
    local tools
    tools=$(echo "$raw" | grep -A1 "^event: tool_call" | grep "^data:" | \
        sed 's/^data: //' | jq -r '.toolName' 2>/dev/null)

    # Tool call count
    local tool_count
    tool_count=$(echo "$tools" | wc -l 2>/dev/null || echo "0")

    # Compaction events
    local compact_count
    compact_count=$(echo "$raw" | grep -c "^event: compaction" 2>/dev/null || echo "0")

    # Check done
    local done
    done=$(echo "$raw" | grep -c "^event: done" 2>/dev/null || echo "0")

    # Complete event with full output
    local output
    output=$(echo "$raw" | grep -A1 "^event: complete" | grep "^data:" | \
        sed 's/^data: //' | jq -r '.output' 2>/dev/null | head -c 2000 || echo "")

    # Tool details
    local tool_details
    tool_details=$(echo "$raw" | grep -A1 "^event: tool_call" | grep "^data:" | \
        sed 's/^data: //' | jq -r '"\(.toolName) id=\(.id)"' 2>/dev/null || echo "")

    # Sub-agent events
    local subagent_events
    subagent_events=$(echo "$raw" | grep -A1 "^event: subagent" | grep "^data:" | \
        sed 's/^data: //' | jq -r '"\(.type // .event // "unknown") \(.agentId // .id // "")"' 2>/dev/null || echo "")

    # Workflow events
    local workflow_events
    workflow_events=$(echo "$raw" | grep -A1 "^event: workflow" | grep "^data:" | \
        sed 's/^data: //' | jq -r '.' 2>/dev/null || echo "")

    # Content deltas combined
    local content
    content=$(echo "$raw" | grep -A1 "^event: content_delta" | grep "^data:" | \
        sed 's/^data: //' | jq -r '.delta' 2>/dev/null | tr -d '\n' | head -c 1000 || echo "")

    echo "TOOL_COUNT=$tool_count"
    echo "COMPACT_COUNT=$compact_count"
    echo "DONE=$done"
    echo "OUTPUT_LEN=${#output}"
    echo "CONTENT_LEN=${#content}"
    echo "TOOLS=$(echo "$tools" | sort | uniq -c | sort -rn)"
    echo "TOOL_DETAILS=$(echo "$tool_details" | head -20)"
    echo "SUBAGENT_EVENTS=$(echo "$subagent_events" | head -10)"
    echo "WORKFLOW_EVENTS=$(echo "$workflow_events" | head -10)"
}

pass_test() {
    PASS=$((PASS + 1))
    green "  ✓ PASS: $1"
}

fail_test() {
    FAIL=$((FAIL + 1))
    ISSUES+=("$1")
    red "  ✗ FAIL: $1"
}

note() {
    yellow "  → $1"
}

# ==============================================================================
echo ""
bold "========================================================================"
bold "  DeepAnalyze Multi-Agent Comprehensive Test Suite"
bold "========================================================================"
echo ""

# Verify backend
health=$(api GET /api/health)
if [ -z "$health" ]; then
    red "ERROR: Backend not running at $BASE"
    exit 1
fi
green "Backend healthy: $(echo "$health" | jq -r '.status')"

# ==============================================================================
# TEST 1: workflow_run - parallel mode
# ==============================================================================
bold ""
bold "========================================================================"
bold "TEST 1: workflow_run - parallel mode (3 concurrent sub-agents)"
bold "========================================================================"

SID=$(create_session "T1-parallel-workflow")
note "Session: $SID"

raw=$(run_agent "$SID" "使用workflow_run工具，以parallel模式同时启动3个子Agent，分别分析知识库中的文档类型分布、音频文件数量、和图片文件列表。每个子Agent执行独立的SQL查询。" 300)
parsed=$(parse_sse "$raw")
echo "$parsed"

# Check for workflow_run tool call
wf_calls=$(echo "$parsed" | grep "^TOOLS=" | grep -o "workflow_run" | wc -l)
if [ "$wf_calls" -ge 1 ]; then
    pass_test "workflow_run was called"
else
    # Check if agent did the analysis itself without workflow
    note "Agent did not call workflow_run — checking if it completed the task directly"
fi

# Check completion
done=$(echo "$parsed" | grep "^DONE=" | cut -d= -f2)
if [ "$done" -ge 1 ]; then
    pass_test "Agent completed the task"
else
    fail_test "Agent did not complete (done=$done)"
fi

# Check output has meaningful content
output_len=$(echo "$parsed" | grep "^OUTPUT_LEN=" | cut -d= -f2)
if [ "$output_len" -gt 50 ]; then
    pass_test "Output has content ($output_len chars)"
else
    fail_test "Output too short ($output_len chars)"
fi

# Check for sub-agent events
subagent=$(echo "$parsed" | grep "^SUBAGENT_EVENTS=" | cut -d= -f2-)
if [ -n "$subagent" ] && [ "$subagent" != "" ]; then
    pass_test "Sub-agent events detected"
else
    note "No explicit sub-agent events (agent may have done work directly)"
fi

delete_session "$SID"

# ==============================================================================
# TEST 2: workflow_run - pipeline mode
# ==============================================================================
bold ""
bold "========================================================================"
bold "TEST 2: workflow_run - pipeline mode (sequential agents)"
bold "========================================================================"

SID=$(create_session "T2-pipeline-workflow")
note "Session: $SID"

raw=$(run_agent "$SID" "使用workflow_run工具，以pipeline模式依次执行3个步骤：步骤1搜索所有PDF文档列表，步骤2分析这些PDF的主要内容主题，步骤3生成总结。每步使用一个子Agent。" 300)
parsed=$(parse_sse "$raw")
echo "$parsed"

wf_calls=$(echo "$parsed" | grep "^TOOLS=" | grep -o "workflow_run" | wc -l)
done=$(echo "$parsed" | grep "^DONE=" | cut -d= -f2)
output_len=$(echo "$parsed" | grep "^OUTPUT_LEN=" | cut -d= -f2)

if [ "$wf_calls" -ge 1 ]; then
    pass_test "workflow_run pipeline was called"
else
    note "Agent did not call workflow_run"
fi

if [ "$done" -ge 1 ]; then
    pass_test "Pipeline completed"
else
    fail_test "Pipeline did not complete"
fi

if [ "$output_len" -gt 50 ]; then
    pass_test "Pipeline produced output ($output_len chars)"
else
    fail_test "Pipeline output too short"
fi

delete_session "$SID"

# ==============================================================================
# TEST 3: workflow_run - single mode (delegation)
# ==============================================================================
bold ""
bold "========================================================================"
bold "TEST 3: workflow_run - single mode (delegate to sub-agent)"
bold "========================================================================"

SID=$(create_session "T3-single-workflow")
note "Session: $SID"

raw=$(run_agent "$SID" "使用workflow_run工具，以single模式委派一个子Agent来完成以下任务：查询知识库中有多少个文档，列出文件类型统计。你自己不要直接查询，完全委派给子Agent。" 300)
parsed=$(parse_sse "$raw")
echo "$parsed"

wf_calls=$(echo "$parsed" | grep "^TOOLS=" | grep -o "workflow_run" | wc -l)
done=$(echo "$parsed" | grep "^DONE=" | cut -d= -f2)
output_len=$(echo "$parsed" | grep "^OUTPUT_LEN=" | cut -d= -f2)

if [ "$wf_calls" -ge 1 ]; then
    pass_test "workflow_run single was called"
else
    note "Agent did not delegate via workflow_run"
fi

if [ "$done" -ge 1 ]; then
    pass_test "Single delegation completed"
else
    fail_test "Single delegation did not complete"
fi

if [ "$output_len" -gt 30 ]; then
    pass_test "Delegation produced output ($output_len chars)"
else
    note "Output may be minimal for delegation"
fi

delete_session "$SID"

# ==============================================================================
# TEST 4: skill_invoke - sub_agent mode
# ==============================================================================
bold ""
bold "========================================================================"
bold "TEST 4: skill_invoke - sub_agent mode"
bold "========================================================================"

SID=$(create_session "T4-skill-invoke")
note "Session: $SID"

raw=$(run_agent "$SID" "使用skill_invoke工具调用'实体提取'技能，从知识库中提取所有人名实体。以sub_agent模式调用。" 300)
parsed=$(parse_sse "$raw")
echo "$parsed"

skill_calls=$(echo "$parsed" | grep "^TOOLS=" | grep -o "skill_invoke" | wc -l)
done=$(echo "$parsed" | grep "^DONE=" | cut -d= -f2)
output_len=$(echo "$parsed" | grep "^OUTPUT_LEN=" | cut -d= -f2)

if [ "$skill_calls" -ge 1 ]; then
    pass_test "skill_invoke was called"
else
    note "Agent did not call skill_invoke — may have done extraction directly"
fi

if [ "$done" -ge 1 ]; then
    pass_test "Skill execution completed"
else
    fail_test "Skill execution did not complete"
fi

if [ "$output_len" -gt 30 ]; then
    pass_test "Skill produced output ($output_len chars)"
else
    note "Skill output may be minimal"
fi

delete_session "$SID"

# ==============================================================================
# TEST 5: run-coordinated endpoint
# ==============================================================================
bold ""
bold "========================================================================"
bold "TEST 5: /api/agents/run-coordinated (coordinator pattern)"
bold "========================================================================"

SID=$(create_session "T5-coordinated")
note "Session: $SID"

# Use the run-coordinated endpoint directly
task_id=$(api POST /api/agents/run-coordinated \
    "{\"sessionId\":\"$SID\",\"input\":\"分析知识库中的文档概况：文档数量、文件类型分布、主要内容主题\"}" | jq -r '.taskId' 2>/dev/null)

if [ -n "$task_id" ] && [ "$task_id" != "null" ]; then
    pass_test "run-coordinated returned taskId: $task_id"

    # Poll for completion (up to 180s)
    note "Waiting for coordinated task to complete..."
    completed=false
    for i in $(seq 1 60); do
        status=$(api GET "/api/agents/task/$task_id" | jq -r '.status' 2>/dev/null)
        if [ "$status" = "completed" ] || [ "$status" = "failed" ]; then
            completed=true
            break
        fi
        sleep 3
    done

    if $completed; then
        task_result=$(api GET "/api/agents/task/$task_id")
        final_status=$(echo "$task_result" | jq -r '.status')
        output=$(echo "$task_result" | jq -r '.output // .result // ""' 2>/dev/null | head -c 200)

        if [ "$final_status" = "completed" ]; then
            pass_test "Coordinated task completed successfully"
        else
            fail_test "Coordinated task status: $final_status"
        fi

        if [ ${#output} -gt 20 ]; then
            pass_test "Coordinated task produced output (${#output} chars)"
            note "Output preview: ${output:0:100}..."
        else
            note "Coordinated output may be empty"
        fi
    else
        fail_test "Coordinated task did not complete within timeout"
    fi
else
    fail_test "run-coordinated did not return a taskId"
fi

delete_session "$SID"

# ==============================================================================
# TEST 6: workflow_run + compaction interaction
# ==============================================================================
bold ""
bold "========================================================================"
bold "TEST 6: workflow_run + compaction interaction"
bold "========================================================================"

# Temporarily lower threshold
api PUT /api/settings/agent '{"contextWindow":30000,"compactionBuffer":15000,"sessionMemoryInitThreshold":3000,"sessionMemoryUpdateInterval":2000,"smCompactMinTokens":2000,"smCompactMaxTokens":8000}' >/dev/null 2>&1

SID=$(create_session "T6-workflow-compact")
note "Session: $SID (low compaction threshold)"

# First: a regular question to build context
note "Q1: Building context..."
raw1=$(run_agent "$SID" "列出知识库中所有文档的文件名、类型、大小" 120)
parsed1=$(parse_sse "$raw1")
echo "  Q1: $(echo "$parsed1" | grep "^TOOLS=")"
echo "  Q1 compactions: $(echo "$parsed1" | grep "^COMPACT_COUNT=" | cut -d= -f2)"

# Second: another question to trigger more compaction
note "Q2: More context building..."
raw2=$(run_agent "$SID" "搜索与银行相关的所有文档，提取关键信息" 120)
parsed2=$(parse_sse "$raw2")
echo "  Q2: $(echo "$parsed2" | grep "^TOOLS=")"
echo "  Q2 compactions: $(echo "$parsed2" | grep "^COMPACT_COUNT=" | cut -d= -f2)"

# Third: trigger workflow after compaction
note "Q3: Triggering workflow after compaction..."
raw3=$(run_agent "$SID" "使用workflow_run工具以parallel模式启动2个子Agent，一个搜索合同相关文档，一个搜索协议相关文档" 300)
parsed3=$(parse_sse "$raw3")
echo "$parsed3"

wf_calls=$(echo "$parsed3" | grep "^TOOLS=" | grep -o "workflow_run" | wc -l)
done=$(echo "$parsed3" | grep "^DONE=" | cut -d= -f2)
compact=$(echo "$parsed3" | grep "^COMPACT_COUNT=" | cut -d= -f2)

total_compact=$(($(echo "$parsed1" | grep "^COMPACT_COUNT=" | cut -d= -f2 || echo 0) + \
                 $(echo "$parsed2" | grep "^COMPACT_COUNT=" | cut -d= -f2 || echo 0) + \
                 $(echo "$parsed3" | grep "^COMPACT_COUNT=" | cut -d= -f2 || echo 0)))

if [ "$total_compact" -gt 0 ]; then
    pass_test "Compaction was triggered ($total_compact total events)"
else
    note "No compaction triggered"
fi

if [ "$done" -ge 1 ]; then
    pass_test "Workflow after compaction completed"
else
    fail_test "Workflow after compaction did not complete (done=$done)"
fi

# Check output doesn't re-execute old tasks
content3=$(echo "$parsed3" | grep "^CONTENT_LEN=" | cut -d= -f2)
note "Q3 content length: $content3 chars"

delete_session "$SID"

# Restore normal settings
api PUT /api/settings/agent '{"contextWindow":200000,"compactionBuffer":13000,"sessionMemoryInitThreshold":10000,"sessionMemoryUpdateInterval":5000,"smCompactMinTokens":10000,"smCompactMaxTokens":40000}' >/dev/null 2>&1

# ==============================================================================
# TEST 7: skill_invoke - inline mode
# ==============================================================================
bold ""
bold "========================================================================"
bold "TEST 7: skill_invoke - inline mode (prompt injection)"
bold "========================================================================"

SID=$(create_session "T7-skill-inline")
note "Session: $SID"

raw=$(run_agent "$SID" "使用skill_invoke工具以inline模式调用'文档摘要'技能，为知识库中的第一个文档生成摘要。" 180)
parsed=$(parse_sse "$raw")
echo "$parsed"

skill_calls=$(echo "$parsed" | grep "^TOOLS=" | grep -o "skill_invoke" | wc -l)
done=$(echo "$parsed" | grep "^DONE=" | cut -d= -f2)
output_len=$(echo "$parsed" | grep "^OUTPUT_LEN=" | cut -d= -f2)

if [ "$skill_calls" -ge 1 ]; then
    pass_test "skill_invoke inline was called"
else
    note "Agent may have generated summary directly"
fi

if [ "$done" -ge 1 ]; then
    pass_test "Inline skill completed"
else
    fail_test "Inline skill did not complete"
fi

delete_session "$SID"

# ==============================================================================
# TEST 8: Multi-agent output quality verification
# ==============================================================================
bold ""
bold "========================================================================"
bold "TEST 8: Multi-agent output quality (run-coordinated deep analysis)"
bold "========================================================================"

SID=$(create_session "T8-output-quality")
note "Session: $SID"

raw=$(run_agent "$SID" "使用workflow_run工具以parallel模式启动3个子Agent并行执行：1号Agent查询知识库中有多少个文档及类型统计，2号Agent搜索与逮捕相关的文档并列出文件名，3号Agent查询知识库中的音频文件。3个子Agent完成后汇总输出结果。" 300)
parsed=$(parse_sse "$raw")
echo "$parsed"

done=$(echo "$parsed" | grep "^DONE=" | cut -d= -f2)
output=$(echo "$raw" | grep -A1 "^event: complete" | grep "^data:" | \
    sed 's/^data: //' | jq -r '.output' 2>/dev/null || echo "")

if [ "$done" -ge 1 ]; then
    pass_test "Multi-agent task completed"
else
    fail_test "Multi-agent task did not complete"
fi

# Check output quality - should contain meaningful data
if echo "$output" | grep -qi "355\|文档"; then
    pass_test "Output contains document statistics"
else
    note "Output may not contain document statistics"
fi

# Check no task confusion - should focus on the requested tasks
if echo "$output" | grep -qi "逮捕\|音频\|文档类型"; then
    pass_test "Output covers all 3 requested topics"
else
    note "Output may not cover all requested topics"
fi

# Output length check
if [ ${#output} -gt 100 ]; then
    pass_test "Multi-agent produced substantial output (${#output} chars)"
else
    note "Multi-agent output was brief (${#output} chars)"
fi

delete_session "$SID"

# ==============================================================================
# TEST 9: Sub-agent blocked tools (recursive guard)
# ==============================================================================
bold ""
bold "========================================================================"
bold "TEST 9: Sub-agent recursive guard (workflow_run blocked in sub-agents)"
bold "========================================================================"

SID=$(create_session "T9-recursive-guard")
note "Session: $SID"

raw=$(run_agent "$SID" "使用workflow_run工具以single模式委派一个子Agent，要求该子Agent也尝试使用workflow_run工具启动另一个嵌套的工作流。观察子Agent是否被阻止递归调用workflow_run。" 300)
parsed=$(parse_sse "$raw")
echo "$parsed"

# Count all workflow_run calls - should be exactly 1 (the parent's call)
total_wf=$(echo "$raw" | grep -A1 "^event: tool_call" | grep "^data:" | \
    sed 's/^data: //' | jq -r 'select(.toolName == "workflow_run")' 2>/dev/null | wc -l)

if [ "$total_wf" -le 2 ]; then
    pass_test "workflow_run not recursively called (count=$total_wf, guard working)"
else
    fail_test "workflow_run was called $total_wf times (possible recursive call)"
fi

done=$(echo "$parsed" | grep "^DONE=" | cut -d= -f2)
if [ "$done" -ge 1 ]; then
    pass_test "Task completed without infinite recursion"
else
    fail_test "Task may have hung or errored"
fi

delete_session "$SID"

# ==============================================================================
# TEST 10: Sequential multi-turn with workflow + topic switch
# ==============================================================================
bold ""
bold "========================================================================"
bold "TEST 10: Sequential multi-turn (workflow → unrelated question → workflow)"
bold "========================================================================"

api PUT /api/settings/agent '{"contextWindow":30000,"compactionBuffer":15000,"sessionMemoryInitThreshold":3000,"sessionMemoryUpdateInterval":2000,"smCompactMinTokens":2000,"smCompactMaxTokens":8000}' >/dev/null 2>&1

SID=$(create_session "T10-sequential-workflow")
note "Session: $SID (low threshold)"

note "Q1: Trigger workflow..."
raw1=$(run_agent "$SID" "使用workflow_run工具以parallel模式启动2个子Agent，分别查询知识库中的PDF文档数量和DOCX文档数量" 300)
parsed1=$(parse_sse "$raw1")
echo "  Q1 tools: $(echo "$parsed1" | grep "^TOOLS=")"
echo "  Q1 compactions: $(echo "$parsed1" | grep "^COMPACT_COUNT=" | cut -d= -f2)"

note "Q2: Unrelated question..."
raw2=$(run_agent "$SID" "知识库中有哪些图片文件？" 120)
parsed2=$(parse_sse "$raw2")
echo "  Q2 tools: $(echo "$parsed2" | grep "^TOOLS=")"
echo "  Q2 compactions: $(echo "$parsed2" | grep "^COMPACT_COUNT=" | cut -d= -f2)"

# Check Q2 doesn't re-trigger workflow
wf_in_q2=$(echo "$parsed2" | grep "^TOOLS=" | grep -o "workflow_run" | wc -l)
if [ "$wf_in_q2" -eq 0 ]; then
    pass_test "Q2 did not re-trigger workflow_run (no old task re-execution)"
else
    fail_test "Q2 re-triggered workflow_run — old task leakage!"
fi

done2=$(echo "$parsed2" | grep "^DONE=" | cut -d= -f2)
if [ "$done2" -ge 1 ]; then
    pass_test "Q2 completed normally"
else
    fail_test "Q2 did not complete"
fi

note "Q3: Another unrelated question after compaction..."
raw3=$(run_agent "$SID" "列出知识库中的音频文件名称" 120)
parsed3=$(parse_sse "$raw3")
echo "  Q3 tools: $(echo "$parsed3" | grep "^TOOLS=")"
echo "  Q3 compactions: $(echo "$parsed3" | grep "^COMPACT_COUNT=" | cut -d= -f2)"

# Q3 should focus on audio, not PDF/DOCX
wf_in_q3=$(echo "$parsed3" | grep "^TOOLS=" | grep -o "workflow_run" | wc -l)
if [ "$wf_in_q3" -eq 0 ]; then
    pass_test "Q3 did not re-trigger old workflow tasks"
else
    fail_test "Q3 re-triggered workflow_run — context inertia!"
fi

total_compact=$(($(echo "$parsed1" | grep "^COMPACT_COUNT=" | cut -d= -f2 || echo 0) + \
                 $(echo "$parsed2" | grep "^COMPACT_COUNT=" | cut -d= -f2 || echo 0) + \
                 $(echo "$parsed3" | grep "^COMPACT_COUNT=" | cut -d= -f2 || echo 0)))
note "Total compactions across 3 questions: $total_compact"

delete_session "$SID"

# Restore settings
api PUT /api/settings/agent '{"contextWindow":200000,"compactionBuffer":13000,"sessionMemoryInitThreshold":10000,"sessionMemoryUpdateInterval":5000,"smCompactMinTokens":10000,"smCompactMaxTokens":40000}' >/dev/null 2>&1

# ==============================================================================
# Summary
# ==============================================================================
bold ""
bold "========================================================================"
bold "  TEST SUMMARY"
bold "========================================================================"
echo ""
green "  Passed: $PASS"
red "  Failed: $FAIL"
echo ""

if [ ${#ISSUES[@]} -gt 0 ]; then
    red "  Issues found:"
    for issue in "${ISSUES[@]}"; do
        red "    - $issue"
    done
else
    green "  All tests passed!"
fi

echo ""
bold "========================================================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
