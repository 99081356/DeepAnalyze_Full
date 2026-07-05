#!/bin/bash
# Multi-turn compaction robustness test using curl
# Requires: curl, jq, python3
set -e

BASE="http://localhost:21000"

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

# Run agent stream, parse SSE events with timeout
run_agent() {
    local sid="$1" input="$2" timeout_sec="${3:-120}"
    local result
    result=$(timeout "$timeout_sec" curl -s -N -X POST "$BASE/api/agents/run-stream" \
        -H "Content-Type: application/json" \
        -d "{\"sessionId\":\"$sid\",\"input\":$(echo "$input" | jq -Rs .)}" 2>/dev/null || true)

    # Parse compaction events
    local compactions
    compactions=$(echo "$result" | grep -A1 "^event: compaction" | grep "^data:" | sed 's/^data: //' | jq -s 'length' 2>/dev/null || echo "0")

    # Parse tool calls
    local tools
    tools=$(echo "$result" | grep -A1 "^event: tool_call" | grep "^data:" | sed 's/^data: //' | jq -r '.toolName' 2>/dev/null | sort | uniq -c | sort -rn | head -10 || echo "none")

    # Parse output text
    local output
    output=$(echo "$result" | grep -A1 "^event: content_delta" | grep "^data:" | sed 's/^data: //' | jq -r '.delta' 2>/dev/null | tr -d '\n' | head -c 500 || echo "")

    # Check done
    local done
    done=$(echo "$result" | grep -c "^event: done" || echo "0")

    # Parse compaction details
    local compact_details
    compact_details=$(echo "$result" | grep -A1 "^event: compaction" | grep "^data:" | sed 's/^data: //' | jq -r '.method + " saved=" + (.tokensSaved|tostring)' 2>/dev/null || echo "")

    echo "COMPACT_COUNT=$compactions"
    echo "DONE=$done"
    echo "TOOLS=$tools"
    echo "OUTPUT_LEN=${#output}"
    echo "OUTPUT_PREVIEW=$output"
    if [ -n "$compact_details" ]; then
        echo "COMPACT_DETAILS=$compact_details"
    fi
}

# ====================================================================
echo "======================================================================"
echo "COMPACTION ROBUSTNESS TEST SUITE (low threshold)"
echo "======================================================================"

# Verify backend
health=$(api GET /api/health)
if [ -z "$health" ]; then
    echo "ERROR: Backend not running"
    exit 1
fi
echo "Backend: $health"
echo ""

# ====================================================================
# TEST 1: Three independent questions
# ====================================================================
echo "======================================================================"
echo "TEST 1: Three independent questions"
echo "======================================================================"
SID=$(create_session "T1-compact-curl")
echo "Session: $SID"

echo ""
echo "--- Q1: Document types ---"
r1=$(run_agent "$SID" "列出知识库中有哪些文档类型？每种类型多少个？" 120)
echo "$r1"
comp1=$(echo "$r1" | grep "^COMPACT_COUNT=" | cut -d= -f2)

echo ""
echo "--- Q2: Search arrest documents ---"
r2=$(run_agent "$SID" "搜索包含逮捕关键词的文档，告诉我有哪些相关文件" 120)
echo "$r2"
comp2=$(echo "$r2" | grep "^COMPACT_COUNT=" | cut -d= -f2)
out2=$(echo "$r2" | grep "^OUTPUT_PREVIEW=" | cut -d= -f2-)

# Check for old task leakage in Q2
if echo "$out2" | grep -q "文档类型统计"; then
    echo "  ⚠️ Q2 re-mentions Q1 topic (文档类型统计)"
else
    echo "  ✓ Q2 focused on current task"
fi

echo ""
echo "--- Q3: Entity names ---"
r3=$(run_agent "$SID" "知识库中出现了哪些人名实体？列出主要人物" 120)
echo "$r3"
comp3=$(echo "$r3" | grep "^COMPACT_COUNT=" | cut -d= -f2)
out3=$(echo "$r3" | grep "^OUTPUT_PREVIEW=" | cut -d= -f2-)

if echo "$out3" | grep -q "文档类型统计"; then
    echo "  ⚠️ Q3 re-mentions Q1 topic"
else
    echo "  ✓ Q3 focused on current task"
fi

total=$((comp1 + comp2 + comp3))
echo ""
echo "  Total compactions: $total"
delete_session "$SID"

# ====================================================================
# TEST 2: Complex analysis → topic switch
# ====================================================================
echo ""
echo "======================================================================"
echo "TEST 2: Complex analysis → topic switch"
echo "======================================================================"
SID=$(create_session "T2-compact-curl")
echo "Session: $SID"

echo ""
echo "--- Q1: Complex PDF analysis ---"
r1=$(run_agent "$SID" "分析知识库中所有PDF文档的概况，包括数量、文件名列表、主要内容摘要" 180)
echo "$r1"

echo ""
echo "--- Q2: Topic switch to banking ---"
r2=$(run_agent "$SID" "搜索知识库中与银行或账户相关的所有内容" 120)
echo "$r2"
out2=$(echo "$r2" | grep "^OUTPUT_PREVIEW=" | cut -d= -f2-)

if echo "$out2" | grep -q "PDF文档的概况"; then
    echo "  ⚠️ Q2 re-mentions old task content!"
else
    echo "  ✓ Q2 focuses on new topic"
fi

delete_session "$SID"

# ====================================================================
# TEST 3: Report + independent Q&A
# ====================================================================
echo ""
echo "======================================================================"
echo "TEST 3: Report + independent Q&A"
echo "======================================================================"
SID=$(create_session "T3-compact-curl")
echo "Session: $SID"

echo ""
echo "--- Q1: Case type distribution ---"
r1=$(run_agent "$SID" "分析知识库中的案件类型分布情况，给出统计结果" 120)
echo "$r1"

echo ""
echo "--- Q2: Audio files ---"
r2=$(run_agent "$SID" "知识库中有哪些音频文件？它们的文件名是什么？" 120)
echo "$r2"
out2=$(echo "$r2" | grep "^OUTPUT_PREVIEW=" | cut -d= -f2-)

if echo "$out2" | grep -q "案件类型分布" && ! echo "$out2" | grep -q "音频"; then
    echo "  ⚠️ Q2 re-analyzes cases instead of audio!"
else
    echo "  ✓ Q2 focuses on audio files"
fi

delete_session "$SID"

# ====================================================================
# TEST 4: Workflow + simple question
# ====================================================================
echo ""
echo "======================================================================"
echo "TEST 4: Workflow + simple question"
echo "======================================================================"
SID=$(create_session "T4-compact-curl")
echo "Session: $SID"

echo ""
echo "--- Q1: Parallel analysis ---"
r1=$(run_agent "$SID" "对知识库中的前3个文档进行并行深度分析，每个文档提取关键信息和摘要" 180)
echo "$r1"
tools1=$(echo "$r1" | grep "^TOOLS=" | cut -d= -f2-)
wf1=$(echo "$tools1" | grep -c "workflow_run" || echo "0")
echo "  workflow_run calls in Q1: $wf1"

echo ""
echo "--- Q2: Simple question ---"
r2=$(run_agent "$SID" "知识库的名称是什么？里面有多少个文档？" 120)
echo "$r2"
tools2=$(echo "$r2" | grep "^TOOLS=" | cut -d= -f2-)
wf2=$(echo "$tools2" | grep -c "workflow_run" || echo "0")

if [ "$wf2" -gt 0 ]; then
    echo "  ⚠️ Q2 triggered workflow_run - old task re-execution!"
else
    echo "  ✓ Q2 did not trigger workflow"
fi

delete_session "$SID"

# ====================================================================
# TEST 5: 6-question pressure test
# ====================================================================
echo ""
echo "======================================================================"
echo "TEST 5: 6-question pressure test"
echo "======================================================================"
SID=$(create_session "T5-compact-curl")
echo "Session: $SID"

QUESTIONS=(
    "知识库中有多少个文档？列出文件类型统计"
    "搜索与起诉相关的文档，列出文件名"
    "知识库中有哪些图片文件？"
    "搜索包含合同或协议的内容"
    "列出知识库中的所有Excel表格文件"
    "知识库中有没有视频文件？如果有，文件名是什么？"
)

total_compactions=0
q_num=0
for q in "${QUESTIONS[@]}"; do
    q_num=$((q_num + 1))
    echo ""
    echo "--- Q${q_num}: ${q:0:40}... ---"
    r=$(run_agent "$SID" "$q" 180)
    echo "$r"
    comp=$(echo "$r" | grep "^COMPACT_COUNT=" | cut -d= -f2)
    total_compactions=$((total_compactions + comp))
done

echo ""
echo "  Total compactions across 6 questions: $total_compactions"

delete_session "$SID"

echo ""
echo "======================================================================"
echo "ALL TESTS COMPLETED"
echo "======================================================================"
