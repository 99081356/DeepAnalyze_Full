#!/bin/bash
# =============================================================================
# DeepAnalyze Hub — Comprehensive E2E Test Suite
# =============================================================================
# Tests all Server endpoints, Worker communication, edge cases, and error scenarios.

set -euo pipefail

BASE="http://localhost:22000"
PASS=0
FAIL=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok() { TOTAL=$((TOTAL+1)); PASS=$((PASS+1)); echo -e "  ${GREEN}✓${NC} $1"; }
fail() { TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1)); echo -e "  ${RED}✗${NC} $1"; }
section() { echo -e "\n${CYAN}═══ $1 ═══${NC}"; }

# ═══════════════════════════════════════════════════════════════════════════════
# 1. Health Check
# ═══════════════════════════════════════════════════════════════════════════════
section "1. Health Check"

HEALTH=$(curl -s "$BASE/api/health")
VERSION=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('version',''))")
APPNAME=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('appName',''))")

[[ "$VERSION" == "0.1.0" ]] && ok "Health returns version 0.1.0" || fail "Health version mismatch: $VERSION"
[[ "$APPNAME" == "DeepAnalyze Hub" ]] && ok "Health returns correct appName" || fail "Health appName mismatch: $APPNAME"

# ═══════════════════════════════════════════════════════════════════════════════
# 2. Worker Registration
# ═══════════════════════════════════════════════════════════════════════════════
section "2. Worker Registration"

# 2.1 Basic registration
REG=$(curl -s -X POST "$BASE/api/v1/workers/register" \
  -H "Content-Type: application/json" \
  -d '{"workerId":"w-test-001","hostname":"test-host-1","version":"0.20.0","endpoint":"http://192.168.1.100:21000","capabilities":{"cpuCores":8,"memoryGB":16,"gpuAvailable":false,"os":"Linux 6.6","daVersion":"0.20.0","runMode":"standalone"}}')

WID=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerId',''))" 2>/dev/null || echo "")
TOKEN=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerToken',''))" 2>/dev/null || echo "")
SVER=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('serverVersion',''))" 2>/dev/null || echo "")

[[ "$WID" == "w-test-001" ]] && ok "Registration returns correct workerId" || fail "Registration workerId: expected 'w-test-001', got '$WID'"
[[ -n "$TOKEN" && "$TOKEN" == wkt_* ]] && ok "Registration returns workerToken with correct prefix" || fail "Registration token missing or wrong prefix: '$TOKEN'"
[[ "$SVER" == "0.1.0" ]] && ok "Registration returns serverVersion" || fail "Registration serverVersion: '$SVER'"

# 2.2 Missing workerId
MISSING=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/workers/register" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"test"}')
[[ "$MISSING" == "400" || "$MISSING" == "500" ]] && ok "Registration with missing workerId returns error" || fail "Missing workerId should fail, got: $MISSING"

# 2.3 Re-registration (upsert)
REREG=$(curl -s -X POST "$BASE/api/v1/workers/register" \
  -H "Content-Type: application/json" \
  -d '{"workerId":"w-test-001","hostname":"test-host-1-updated","version":"0.21.0","endpoint":"http://192.168.1.100:21000","capabilities":{"cpuCores":16,"memoryGB":32,"gpuAvailable":true,"os":"Linux 6.8","daVersion":"0.21.0","runMode":"docker"}}')

NEWTOKEN=$(echo "$REREG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerToken',''))" 2>/dev/null || echo "")
[[ -n "$NEWTOKEN" ]] && ok "Re-registration returns new token" || fail "Re-registration should return new token"

# 2.4 Second worker
REG2=$(curl -s -X POST "$BASE/api/v1/workers/register" \
  -H "Content-Type: application/json" \
  -d '{"workerId":"w-test-002","hostname":"test-host-2","version":"0.20.0","endpoint":"","capabilities":{"cpuCores":4,"memoryGB":8,"gpuAvailable":false,"os":"Windows 11","daVersion":"0.20.0","runMode":"standalone"}}')

TOKEN2=$(echo "$REG2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerToken',''))" 2>/dev/null || echo "")
[[ -n "$TOKEN2" ]] && ok "Second worker registration succeeds" || fail "Second worker registration failed"

# 2.5 List workers
WORKERS=$(curl -s "$BASE/api/v1/workers")
WCOUNT=$(echo "$WORKERS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('workers',[])))" 2>/dev/null || echo "0")
[[ "$WCOUNT" == "2" ]] && ok "Workers list returns 2 workers" || fail "Workers list count: $WCOUNT (expected 2)"

# 2.6 Get worker detail
WDETAIL=$(curl -s "$BASE/api/v1/workers/w-test-001")
WHOST=$(echo "$WDETAIL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hostname',''))" 2>/dev/null || echo "")
[[ "$WHOST" == "test-host-1-updated" ]] && ok "Worker detail shows updated hostname after re-registration" || fail "Worker detail hostname: '$WHOST'"

# 2.7 Get non-existent worker
W404=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/workers/nonexistent")
[[ "$W404" == "404" ]] && ok "Non-existent worker returns 404" || fail "Non-existent worker should be 404, got: $W404"

# ═══════════════════════════════════════════════════════════════════════════════
# 3. Worker Heartbeat
# ═══════════════════════════════════════════════════════════════════════════════
section "3. Worker Heartbeat"

# Use the updated token from re-registration
TOKEN=$NEWTOKEN

# 3.1 Valid heartbeat
HB=$(curl -s -X POST "$BASE/api/v1/workers/heartbeat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"workerId":"w-test-001","status":"idle","activeSessions":2,"activeTasks":1,"resourceUsage":{"cpuPercent":25,"memoryUsedGB":5.2,"memoryTotalGB":16,"diskUsedGB":10,"diskTotalGB":100},"uptime":300}')

ACK=$(echo "$HB" | python3 -c "import sys,json; print(json.load(sys.stdin).get('acknowledged',''))" 2>/dev/null || echo "")
[[ "$ACK" == "True" ]] && ok "Heartbeat acknowledged" || fail "Heartbeat ack: '$ACK'"
ST=$(echo "$HB" | python3 -c "import sys,json; d=json.load(sys.stdin); print('serverTime' in d)" 2>/dev/null || echo "")
[[ "$ST" == "True" ]] && ok "Heartbeat response includes serverTime" || fail "Heartbeat missing serverTime"

# 3.2 Heartbeat without auth
HB401=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/workers/heartbeat" \
  -H "Content-Type: application/json" \
  -d '{"workerId":"w-test-001","status":"idle","activeSessions":0,"activeTasks":0,"resourceUsage":{"cpuPercent":10,"memoryUsedGB":4,"memoryTotalGB":16,"diskUsedGB":10,"diskTotalGB":100},"uptime":60}')
[[ "$HB401" == "401" ]] && ok "Heartbeat without auth returns 401" || fail "Unauth heartbeat: $HB401"

# 3.3 Heartbeat with wrong token
HB401B=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/workers/heartbeat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer wkt_invalid_token" \
  -d '{"workerId":"w-test-001","status":"idle","activeSessions":0,"activeTasks":0,"resourceUsage":{"cpuPercent":10,"memoryUsedGB":4,"memoryTotalGB":16,"diskUsedGB":10,"diskTotalGB":100},"uptime":60}')
[[ "$HB401B" == "401" ]] && ok "Heartbeat with invalid token returns 401" || fail "Invalid token heartbeat: $HB401B"

# 3.4 Heartbeat with status=busy (should map to online in DB)
HB2=$(curl -s -X POST "$BASE/api/v1/workers/heartbeat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"workerId":"w-test-001","status":"busy","activeSessions":5,"activeTasks":3,"resourceUsage":{"cpuPercent":80,"memoryUsedGB":12,"memoryTotalGB":16,"diskUsedGB":10,"diskTotalGB":100},"uptime":600}')
ACK2=$(echo "$HB2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('acknowledged',''))" 2>/dev/null || echo "")
[[ "$ACK2" == "True" ]] && ok "Heartbeat with status=busy succeeds" || fail "Busy heartbeat failed"

# 3.5 Verify heartbeat data in worker detail
WD=$(curl -s "$BASE/api/v1/workers/w-test-001")
ASESS=$(echo "$WD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('active_sessions',0))" 2>/dev/null || echo "0")
[[ "$ASESS" == "5" ]] && ok "Worker detail reflects active_sessions from heartbeat" || fail "Active sessions: $ASESS (expected 5)"

# 3.6 Heartbeat with second worker
HB3=$(curl -s -X POST "$BASE/api/v1/workers/heartbeat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d '{"workerId":"w-test-002","status":"online","activeSessions":0,"activeTasks":0,"resourceUsage":{"cpuPercent":5,"memoryUsedGB":2,"memoryTotalGB":8,"diskUsedGB":5,"diskTotalGB":50},"uptime":30}')
ACK3=$(echo "$HB3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('acknowledged',''))" 2>/dev/null || echo "")
[[ "$ACK3" == "True" ]] && ok "Second worker heartbeat succeeds" || fail "Second worker heartbeat failed"

# ═══════════════════════════════════════════════════════════════════════════════
# 4. Config Management
# ═══════════════════════════════════════════════════════════════════════════════
section "4. Config Management"

# 4.1 No config available yet
CV1=$(curl -s "$BASE/api/v1/config/versions" -H "Authorization: Bearer $TOKEN")
CVA=$(echo "$CV1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('available',''))" 2>/dev/null || echo "")
[[ "$CVA" == "False" ]] && ok "Config version returns available=false when no config" || fail "Config available: '$CVA'"

# 4.2 Get recommended config when none exists
RC1=$(curl -s "$BASE/api/v1/config/recommended" -H "Authorization: Bearer $TOKEN")
RC1A=$(echo "$RC1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('available',''))" 2>/dev/null || echo "")
[[ "$RC1A" == "False" ]] && ok "Recommended config returns available=false when none exists" || fail "Recommended config available: '$RC1A'"

# 4.3 Create config version
CC1=$(curl -s -X POST "$BASE/api/v1/config" \
  -H "Content-Type: application/json" \
  -d '{"version":"20260519-001","configData":{"version":"20260519-001","updatedAt":"2026-05-19T10:00:00Z","providers":{"providers":[{"id":"ollama","name":"Ollama","type":"ollama","endpoint":"http://localhost:11434/v1","apiKey":"","models":{"main":"qwen2.5:14b"},"enabled":true}],"defaults":{"main":"ollama"}},"agentSettings":{"maxTurns":30},"doclingConfig":{"timeout":60}},"description":"Initial recommended config"}')

CC1S=$(echo "$CC1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success',''))" 2>/dev/null || echo "")
[[ "$CC1S" == "True" ]] && ok "Create config version succeeds" || fail "Create config: $CC1"

# 4.4 Config version now available
CV2=$(curl -s "$BASE/api/v1/config/versions" -H "Authorization: Bearer $TOKEN")
CV2V=$(echo "$CV2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('latestVersion',''))" 2>/dev/null || echo "")
CV2A=$(echo "$CV2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('available',''))" 2>/dev/null || echo "")
[[ "$CV2A" == "True" ]] && ok "Config version now available" || fail "Config available after create: '$CV2A'"
[[ "$CV2V" == "20260519-001" ]] && ok "Config version matches" || fail "Config version: '$CV2V'"

# 4.5 Get recommended config
RC2=$(curl -s "$BASE/api/v1/config/recommended" -H "Authorization: Bearer $TOKEN")
RC2V=$(echo "$RC2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || echo "")
[[ "$RC2V" == "20260519-001" ]] && ok "Recommended config returns correct version" || fail "Recommended config version: '$RC2V'"

# 4.6 Duplicate config version
DUP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/config" \
  -H "Content-Type: application/json" \
  -d '{"version":"20260519-001","configData":{"version":"20260519-001","updatedAt":"2026-05-19T10:00:00Z","providers":{"providers":[],"defaults":{}}}}')
[[ "$DUP" == "500" ]] && ok "Duplicate config version returns error" || fail "Duplicate config should fail: $DUP"

# 4.7 Create second config version
CC2=$(curl -s -X POST "$BASE/api/v1/config" \
  -H "Content-Type: application/json" \
  -d '{"version":"20260519-002","configData":{"version":"20260519-002","updatedAt":"2026-05-19T12:00:00Z","providers":{"providers":[],"defaults":{"main":"test"}},"agentSettings":{"maxTurns":50}},"description":"Updated config with higher maxTurns"}')
CC2S=$(echo "$CC2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success',''))" 2>/dev/null || echo "")
[[ "$CC2S" == "True" ]] && ok "Create second config version succeeds" || fail "Create second config: $CC2"

# 4.8 Latest version is now 002
CV3=$(curl -s "$BASE/api/v1/config/versions" -H "Authorization: Bearer $TOKEN")
CV3V=$(echo "$CV3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('latestVersion',''))" 2>/dev/null || echo "")
[[ "$CV3V" == "20260519-002" ]] && ok "Latest config version is 002" || fail "Latest version: '$CV3V'"

# 4.9 Config without auth
CV401=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/config/recommended")
[[ "$CV401" == "401" ]] && ok "Config recommended requires auth" || fail "Config recommended without auth: $CV401"

# 4.10 List config versions
CLIST=$(curl -s "$BASE/api/v1/config/list")
CLCNT=$(echo "$CLIST" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('versions',[])))" 2>/dev/null || echo "0")
[[ "$CLCNT" == "2" ]] && ok "Config list returns 2 versions" || fail "Config list count: $CLCNT"

# ═══════════════════════════════════════════════════════════════════════════════
# 5. Marketplace: Skills
# ═══════════════════════════════════════════════════════════════════════════════
section "5. Marketplace: Skills"

# 5.1 Empty marketplace (no approved skills)
MSE=$(curl -s "$BASE/api/v1/marketplace/skills")
MSEC=$(echo "$MSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',-1))" 2>/dev/null || echo "-1")
[[ "$MSEC" == "0" ]] && ok "Empty marketplace returns total=0" || fail "Marketplace total: $MSEC"

# 5.2 Submit skill
SS1=$(curl -s -X POST "$BASE/api/v1/marketplace/skills/submit" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"deep-research","description":"Comprehensive deep research skill for thorough analysis","prompt":"You are a deep research analyst. Conduct thorough analysis step by step.","tools":["*"],"modelRole":"main","tags":["research","analysis","deep"]}')

SSID=$(echo "$SS1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('submissionId',''))" 2>/dev/null || echo "")
SSSTAT=$(echo "$SS1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
[[ -n "$SSID" ]] && ok "Skill submission returns submissionId" || fail "Skill submission ID empty"
[[ "$SSSTAT" == "submitted" ]] && ok "Skill submission status = submitted" || fail "Skill submission status: $SSSTAT"

# 5.3 Submit duplicate skill name
DUPSK=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/marketplace/skills/submit" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"deep-research","description":"Duplicate","prompt":"Test","tools":["*"],"modelRole":"main"}')
[[ "$DUPSK" == "409" ]] && ok "Duplicate skill name returns 409" || fail "Duplicate skill: $DUPSK"

# 5.4 Submit skill without required fields
SSMISS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/marketplace/skills/submit" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"test"}')
[[ "$SSMISS" == "400" ]] && ok "Skill submit without prompt returns 400" || fail "Missing prompt: $SSMISS"

# 5.5 Submit second skill
SS2=$(curl -s -X POST "$BASE/api/v1/marketplace/skills/submit" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN2" \
  -d '{"name":"summarizer","description":"Document summarization skill","prompt":"Summarize the given document concisely.","tools":["*"],"modelRole":"main","tags":["summary","document"]}')
SSID2=$(echo "$SS2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('submissionId',''))" 2>/dev/null || echo "")
[[ -n "$SSID2" ]] && ok "Second skill submission succeeds" || fail "Second skill submit failed"

# 5.6 Submit Chinese name skill
SS3=$(curl -s -X POST "$BASE/api/v1/marketplace/skills/submit" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"智能检索","description":"智能检索增强技能","prompt":"你是智能检索助手","tools":["*"],"modelRole":"main","tags":["检索"]}')
SSID3=$(echo "$SS3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('submissionId',''))" 2>/dev/null || echo "")
[[ -n "$SSID3" ]] && ok "Chinese name skill submission succeeds" || fail "Chinese name skill submit failed"

# 5.7 Still empty marketplace (pending, not approved)
MS2=$(curl -s "$BASE/api/v1/marketplace/skills")
MS2T=$(echo "$MS2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',-1))" 2>/dev/null || echo "-1")
[[ "$MS2T" == "0" ]] && ok "Marketplace still empty before approval" || fail "Marketplace should be empty: $MS2T"

# 5.8 Admin: list pending skills
AP=$(curl -s "$BASE/api/v1/marketplace/admin/skills?status=pending")
APC=$(echo "$AP" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('skills',[])))" 2>/dev/null || echo "0")
[[ "$APC" == "3" ]] && ok "Admin pending skills count = 3" || fail "Pending skills: $APC (expected 3)"

# 5.9 Admin: approve first skill
APP1=$(curl -s -X POST "$BASE/api/v1/marketplace/admin/skills/$SSID/approve")
APP1S=$(echo "$APP1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success',''))" 2>/dev/null || echo "")
[[ "$APP1S" == "True" ]] && ok "Approve first skill succeeds" || fail "Approve first skill: $APP1"

# 5.10 Approve second skill
APP2=$(curl -s -X POST "$BASE/api/v1/marketplace/admin/skills/$SSID2/approve")
APP2S=$(echo "$APP2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success',''))" 2>/dev/null || echo "")
[[ "$APP2S" == "True" ]] && ok "Approve second skill succeeds" || fail "Approve second skill: $APP2"

# 5.11 Marketplace now has 2 approved skills
MS3=$(curl -s "$BASE/api/v1/marketplace/skills")
MS3T=$(echo "$MS3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',-1))" 2>/dev/null || echo "-1")
[[ "$MS3T" == "2" ]] && ok "Marketplace has 2 approved skills" || fail "Marketplace total: $MS3T"

# 5.12 Get skill detail
SD=$(curl -s "$BASE/api/v1/marketplace/skills/deep-research")
SDN=$(echo "$SD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('name',''))" 2>/dev/null || echo "")
SDP=$(echo "$SD" | python3 -c "import sys,json; d=json.load(sys.stdin); print('prompt' in d and len(d['prompt']) > 0)" 2>/dev/null || echo "")
[[ "$SDN" == "deep-research" ]] && ok "Skill detail returns correct name" || fail "Skill detail name: '$SDN'"
[[ "$SDP" == "True" ]] && ok "Skill detail includes prompt" || fail "Skill detail missing prompt"

# 5.13 Download skill (increments download count)
DL=$(curl -s "$BASE/api/v1/marketplace/skills/deep-research/download" -H "Authorization: Bearer $TOKEN")
DLN=$(echo "$DL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('name',''))" 2>/dev/null || echo "")
[[ "$DLN" == "deep-research" ]] && ok "Download skill returns skill data" || fail "Download skill name: '$DLN'"

# 5.14 Download count incremented
SD2=$(curl -s "$BASE/api/v1/marketplace/skills/deep-research")
SD2DC=$(echo "$SD2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('downloadCount',0))" 2>/dev/null || echo "0")
[[ "$SD2DC" == "1" ]] && ok "Download count incremented to 1" || fail "Download count: $SD2DC"

# 5.15 Reject third skill
REJ=$(curl -s -X POST "$BASE/api/v1/marketplace/admin/skills/$SSID3/reject" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Needs more detailed prompt"}')
REJS=$(echo "$REJ" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success',''))" 2>/dev/null || echo "")
[[ "$REJS" == "True" ]] && ok "Reject skill succeeds" || fail "Reject skill: $REJ"

# 5.16 Marketplace still has 2 (rejected not shown)
MS4=$(curl -s "$BASE/api/v1/marketplace/skills")
MS4T=$(echo "$MS4" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',-1))" 2>/dev/null || echo "-1")
[[ "$MS4T" == "2" ]] && ok "Marketplace still 2 after rejection" || fail "Marketplace after rejection: $MS4T"

# 5.17 Get non-existent skill
SNF=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/marketplace/skills/nonexistent")
[[ "$SNF" == "404" ]] && ok "Non-existent skill returns 404" || fail "Non-existent skill: $SNF"

# 5.18 Get rejected skill (should be 404 from public) — use URL-encoded Chinese slug
SREJ=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/marketplace/skills/%E6%99%BA%E8%83%BD%E6%A3%80%E7%B4%A2")
[[ "$SREJ" == "404" ]] && ok "Rejected skill not visible in marketplace" || fail "Rejected skill should be 404: $SREJ"

# 5.19 Search skills
SSEARCH=$(curl -s "$BASE/api/v1/marketplace/skills?search=summar")
SST=$(echo "$SSEARCH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',0))" 2>/dev/null || echo "0")
[[ "$SST" == "1" ]] && ok "Search 'summar' returns 1 result" || fail "Search result: $SST"

# 5.20 Submit without auth
SS401=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/marketplace/skills/submit" \
  -H "Content-Type: application/json" \
  -d '{"name":"test","prompt":"test","tools":["*"],"modelRole":"main"}')
[[ "$SS401" == "401" ]] && ok "Skill submit without auth returns 401" || fail "Unauth submit: $SS401"

# 5.21 Download without auth
DL401=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/marketplace/skills/deep-research/download")
[[ "$DL401" == "401" ]] && ok "Skill download without auth returns 401" || fail "Unauth download: $DL401"

# ═══════════════════════════════════════════════════════════════════════════════
# 6. Marketplace: Plugins
# ═══════════════════════════════════════════════════════════════════════════════
section "6. Marketplace: Plugins"

# 6.1 Empty plugin marketplace
MPE=$(curl -s "$BASE/api/v1/marketplace/plugins")
MPET=$(echo "$MPE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',-1))" 2>/dev/null || echo "-1")
[[ "$MPET" == "0" ]] && ok "Empty plugin marketplace" || fail "Plugin marketplace total: $MPET"

# 6.2 Submit plugin
SP1=$(curl -s -X POST "$BASE/api/v1/marketplace/plugins/submit" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"pdf-enhancer","description":"Enhanced PDF processing plugin","manifest":{"version":"1.0.0","skills":["pdf-parse","pdf-ocr"],"config":{"timeout":120}}}')

SPID=$(echo "$SP1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('submissionId',''))" 2>/dev/null || echo "")
[[ -n "$SPID" ]] && ok "Plugin submission returns submissionId" || fail "Plugin submission failed"

# 6.3 Approve plugin
APP=$(curl -s -X POST "$BASE/api/v1/marketplace/admin/plugins/$SPID/approve")
APPS=$(echo "$APP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success',''))" 2>/dev/null || echo "")
[[ "$APPS" == "True" ]] && ok "Plugin approval succeeds" || fail "Plugin approval: $APP"

# 6.4 Plugin marketplace now has 1
MP1=$(curl -s "$BASE/api/v1/marketplace/plugins")
MP1T=$(echo "$MP1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',-1))" 2>/dev/null || echo "-1")
[[ "$MP1T" == "1" ]] && ok "Plugin marketplace has 1 plugin" || fail "Plugin marketplace: $MP1T"

# 6.5 Plugin detail
PD=$(curl -s "$BASE/api/v1/marketplace/plugins/pdf-enhancer")
PDN=$(echo "$PD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('name',''))" 2>/dev/null || echo "")
[[ "$PDN" == "pdf-enhancer" ]] && ok "Plugin detail returns correct name" || fail "Plugin detail: '$PDN'"

# 6.6 Plugin download
PDL=$(curl -s "$BASE/api/v1/marketplace/plugins/pdf-enhancer/download" -H "Authorization: Bearer $TOKEN")
PDLN=$(echo "$PDL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('name',''))" 2>/dev/null || echo "")
[[ "$PDLN" == "pdf-enhancer" ]] && ok "Plugin download succeeds" || fail "Plugin download: '$PDLN'"

# ═══════════════════════════════════════════════════════════════════════════════
# 7. Worker Status Endpoints (via Worker's /api/worker/* routes)
# ═══════════════════════════════════════════════════════════════════════════════
section "7. Worker Status Routes (Worker-side)"

# These are on port 21000 (Worker), only in worker mode
# In standalone mode they should return 404
WS404=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:21000/api/worker/status 2>/dev/null || echo "000")
[[ "$WS404" == "404" ]] && ok "Worker status routes 404 in standalone mode" || fail "Worker status in standalone: $WS404"

WV404=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:21000/api/worker/version 2>/dev/null || echo "000")
[[ "$WV404" == "404" ]] && ok "Worker version routes 404 in standalone mode" || fail "Worker version in standalone: $WV404"

WH404=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:21000/api/hub/sync-state 2>/dev/null || echo "000")
[[ "$WH404" == "404" ]] && ok "Hub sync-state routes 404 in standalone mode" || fail "Hub routes in standalone: $WH404"

# ═══════════════════════════════════════════════════════════════════════════════
# 8. Edge Cases and Error Handling
# ═══════════════════════════════════════════════════════════════════════════════
section "8. Edge Cases and Error Handling"

# 8.1 404 on unknown route
NF=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/nonexistent")
[[ "$NF" == "404" ]] && ok "Unknown route returns 404" || fail "Unknown route: $NF"

# 8.2 Approve already approved skill (should 404)
DAPP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/marketplace/admin/skills/$SSID/approve")
[[ "$DAPP" == "404" ]] && ok "Re-approve already approved skill returns 404" || fail "Re-approve: $DAPP"

# 8.3 Approve non-existent skill
ANFS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/marketplace/admin/skills/nonexistent-id/approve")
[[ "$ANFS" == "404" ]] && ok "Approve non-existent skill returns 404" || fail "Approve nonexistent: $ANFS"

# 8.4 Reject already rejected skill
DRJ=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/marketplace/admin/skills/$SSID3/reject" \
  -H "Content-Type: application/json" -d '{"reason":"duplicate"}')
[[ "$DRJ" == "404" ]] && ok "Re-reject already rejected skill returns 404" || fail "Re-reject: $DRJ"

# 8.5 Config recommended without auth
CR401=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/config/recommended")
[[ "$CR401" == "401" ]] && ok "Config recommended without auth returns 401" || fail "Config unauth: $CR401"

# 8.6 Config versions without auth
CV401B=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/config/versions")
[[ "$CV401B" == "401" ]] && ok "Config versions without auth returns 401" || fail "Config versions unauth: $CV401B"

# 8.7 Skill versions endpoint (placeholder)
SV=$(curl -s "$BASE/api/v1/marketplace/skills/deep-research/versions")
SVV=$(echo "$SV" | python3 -c "import sys,json; print(json.load(sys.stdin).get('versions','NOTFOUND'))" 2>/dev/null || echo "ERR")
[[ "$SVV" == "[]" ]] && ok "Skill versions returns empty array (placeholder)" || fail "Skill versions: $SVV"

# 8.8 Marketplace pagination
MP=$(curl -s "$BASE/api/v1/marketplace/skills?page=1&pageSize=1")
MPT=$(echo "$MP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total',0))" 2>/dev/null || echo "0")
MPP=$(echo "$MP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('items',[])))" 2>/dev/null || echo "0")
[[ "$MPT" == "2" ]] && ok "Pagination total correct (2)" || fail "Pagination total: $MPT"
[[ "$MPP" == "1" ]] && ok "Pagination pageSize=1 returns 1 item" || fail "Pagination items: $MPP"

# ═══════════════════════════════════════════════════════════════════════════════
# 9. CORS and Headers
# ═══════════════════════════════════════════════════════════════════════════════
section "9. CORS and Headers"

CORS=$(curl -s -I "$BASE/api/health" | grep -i "access-control-allow-origin" | tr -d '\r\n')
[[ "$CORS" == *"access-control-allow-origin: *"* || "$CORS" == *"Access-Control-Allow-Origin: *"* ]] && ok "CORS header present" || fail "CORS header missing: '$CORS'"

CT=$(curl -s -I "$BASE/api/health" | grep -i "content-type" | tr -d '\r\n')
[[ "$CT" == *"application/json"* ]] && ok "Content-Type is application/json" || fail "Content-Type: '$CT'"

# ═══════════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════════
section "Summary"

echo ""
echo -e "  ${GREEN}PASS${NC}: $PASS"
echo -e "  ${RED}FAIL${NC}: $FAIL"
echo -e "  ${CYAN}TOTAL${NC}: $TOTAL"
echo ""

if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}ALL TESTS PASSED${NC}"
else
  echo -e "${RED}$FAIL TEST(S) FAILED${NC}"
fi

exit $FAIL
