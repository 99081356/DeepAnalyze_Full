#!/bin/bash
# Phase 1 冒烟测试——启动 Hub，运行关键测试，关闭 Hub
set -euo pipefail

cd /mnt/d/code/deepanalyze/deepanalyze-hub

# 启动 Hub
echo "[1] Starting Hub..."
PORT=22000 bun run src/main.ts &
HUB_PID=$!
sleep 3

# 确保退出时关闭 Hub
trap "kill $HUB_PID 2>/dev/null || true" EXIT

HUB_URL="http://localhost:22000"
PASS=0
FAIL=0

assert_contains() {
  local name="$1" actual="$2" pattern="$3"
  if echo "$actual" | grep -q "$pattern"; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name (pattern=$pattern not found in: $actual)"
    FAIL=$((FAIL + 1))
  fi
}

assert_status() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name (expected HTTP $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "=== Phase 1 Smoke Tests ==="

# T1: 健康检查
echo "[T1] Health check"
HEALTH=$(curl -s "$HUB_URL/api/health")
assert_contains "health ok" "$HEALTH" '"ok"'

# T2: admin 登录
echo "[T2] Admin login"
LOGIN=$(curl -s -X POST "$HUB_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}')
ADMIN_TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null || echo "")
assert_contains "admin token issued" "$LOGIN" 'access_token'
[ -n "$ADMIN_TOKEN" ] || { echo "FATAL: no admin token"; exit 1; }

# T3: /me 端点
echo "[T3] /me endpoint"
ME=$(curl -s "$HUB_URL/api/v1/auth/me" -H "Authorization: Bearer $ADMIN_TOKEN")
assert_contains "is_super_admin true" "$ME" '"is_super_admin":true'

# T4: 创建组织
echo "[T4] Create organization"
E2E_TS=$(date +%s)
ORG=$(curl -s -X POST "$HUB_URL/api/v1/orgs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"E2E测试公司_$E2E_TS\",\"code\":\"E2E_TEST_$E2E_TS\",\"type\":\"company\"}")
ORG_ID=$(echo "$ORG" | python3 -c "import sys,json; print(json.load(sys.stdin)['organization']['id'])" 2>/dev/null || echo "")
assert_contains "org created" "$ORG" '"id"'
[ -n "$ORG_ID" ] || { echo "FATAL: no org id"; exit 1; }
echo "    org_id=$ORG_ID"

# T5: 创建子部门
echo "[T5] Create sub-department"
CHILD=$(curl -s -X POST "$HUB_URL/api/v1/orgs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"技术部\",\"code\":\"E2E_TECH_$E2E_TS\",\"type\":\"department\",\"parent_id\":\"$ORG_ID\"}")
CHILD_ID=$(echo "$CHILD" | python3 -c "import sys,json; print(json.load(sys.stdin)['organization']['id'])" 2>/dev/null || echo "")
assert_contains "child created" "$CHILD" '"id"'

# T6: 组织树
echo "[T6] Org tree"
TREE=$(curl -s "$HUB_URL/api/v1/orgs/$ORG_ID/tree" -H "Authorization: Bearer $ADMIN_TOKEN")
assert_contains "tree has children" "$TREE" '"children"'

# T7: 创建普通用户
echo "[T7] Create regular user"
USER=$(curl -s -X POST "$HUB_URL/api/v1/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"e2e_user_$E2E_TS\",\"password\":\"test123\",\"display_name\":\"E2E用户\",\"organization_id\":\"$ORG_ID\"}")
assert_contains "user created" "$USER" '"id"'

# T8: 普通用户登录
echo "[T8] Regular user login"
USER_LOGIN=$(curl -s -X POST "$HUB_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"e2e_user_$E2E_TS\",\"password\":\"test123\"}")
USER_TOKEN=$(echo "$USER_LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null || echo "")
assert_contains "user token issued" "$USER_LOGIN" 'access_token'

# T9: 权限隔离
echo "[T9] Permission isolation - user cannot create org"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$HUB_URL/api/v1/orgs" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"hack","code":"HACK","type":"company"}')
assert_status "user forbidden from org:create" "403" "$HTTP_CODE"

# T10: 普通用户读 /me
echo "[T10] User can read own info"
OWN_ME=$(curl -s "$HUB_URL/api/v1/auth/me" -H "Authorization: Bearer $USER_TOKEN")
assert_contains "user is_super_admin false" "$OWN_ME" '"is_super_admin":false'

# T11: Worker v1 自动审批
echo "[T11] Worker v1 auto-approve"
V1=$(curl -s -X POST "$HUB_URL/api/v1/workers/register" \
  -H 'Content-Type: application/json' \
  -d '{"name":"e2e-worker-v1","hostname":"localhost","protocol_version":1}')
assert_contains "v1 auto approved" "$V1" '"workerToken"'

# T12: Worker v2 申请-审批
echo "[T12] Worker v2 apply-approve flow"
V2_APPLY=$(curl -s -X POST "$HUB_URL/api/v1/workers/register" \
  -H 'Content-Type: application/json' \
  -d '{"name":"e2e-worker-v2","hostname":"localhost","protocol_version":2}')
assert_contains "v2 pending" "$V2_APPLY" '"status":"pending"'
V2_ID=$(echo "$V2_APPLY" | python3 -c "import sys,json; print(json.load(sys.stdin)['worker_id'])" 2>/dev/null || echo "")
echo "    v2_worker_id=$V2_ID"

# 审批
APPROVE=$(curl -s -X POST "$HUB_URL/api/v1/workers/$V2_ID/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
assert_contains "approved with token" "$APPROVE" 'worker_token'

# T13: 列出待审批 worker
echo "[T13] List pending workers"
PENDING_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$HUB_URL/api/v1/workers/pending" \
  -H "Authorization: Bearer $ADMIN_TOKEN")
assert_status "pending endpoint works" "200" "$PENDING_HTTP"

# T14: API Key 创建和使用
echo "[T14] API Key creation"
APIKEY=$(curl -s -X POST "$HUB_URL/api/v1/auth/apikey" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"e2e-test-key","scope":"read"}')
assert_contains "apikey issued" "$APIKEY" 'api_key'
API_KEY_VAL=$(echo "$APIKEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])" 2>/dev/null || echo "")

# 用 API Key 访问 /me
ME_VIA_KEY=$(curl -s "$HUB_URL/api/v1/auth/me" -H "X-API-Key: $API_KEY_VAL")
assert_contains "apikey works for /me" "$ME_VIA_KEY" 'admin'

# T15: RBAC - 列出角色
echo "[T15] List roles"
ROLES=$(curl -s "$HUB_URL/api/v1/rbac/roles" -H "Authorization: Bearer $ADMIN_TOKEN")
assert_contains "super admin role exists" "$ROLES" '超级管理员'

# T16: RBAC - 列出权限
echo "[T16] List permissions"
PERMS=$(curl -s "$HUB_URL/api/v1/rbac/permissions" -H "Authorization: Bearer $ADMIN_TOKEN")
assert_contains "org:create permission exists" "$PERMS" 'org:create'

# T17: 创建 org_admin 用户并验证数据隔离
echo "[T17] Org admin isolation"
ORG_ADMIN=$(curl -s -X POST "$HUB_URL/api/v1/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"e2e_orgadmin_$E2E_TS\",\"password\":\"test123\",\"organization_id\":\"$ORG_ID\",\"is_org_admin\":true}")
assert_contains "org admin created" "$ORG_ADMIN" '"id"'

OA_LOGIN=$(curl -s -X POST "$HUB_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"e2e_orgadmin_$E2E_TS\",\"password\":\"test123\"}")
OA_TOKEN=$(echo "$OA_LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null || echo "")

ORG_USERS=$(curl -s "$HUB_URL/api/v1/users" -H "Authorization: Bearer $OA_TOKEN")
assert_contains "org admin sees org users" "$ORG_USERS" "e2e_user_$E2E_TS"

# T18: 错误密码登录失败
echo "[T18] Wrong password login fails"
WRONG_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$HUB_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"wrong"}')
assert_status "wrong password rejected" "401" "$WRONG_HTTP"

# T19: 无 token 访问受保护端点
echo "[T19] No token access denied"
NO_TOKEN_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$HUB_URL/api/v1/users")
assert_status "no token denied" "401" "$NO_TOKEN_HTTP"

# T20: refresh token
echo "[T20] Refresh token flow"
REFRESH=$(curl -s -X POST "$HUB_URL/api/v1/auth/refresh" \
  -H 'Content-Type: application/json' \
  -H "Cookie: refresh_token=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('refresh_token',''))" 2>/dev/null || echo "")" \
  -d '{}')
# refresh_token is in cookie, but we set it via Set-Cookie. Let's test with body
REFRESH2=$(curl -s -X POST "$HUB_URL/api/v1/auth/refresh" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c "
import json, sys
login = json.loads('''$LOGIN''')
# We need refresh_token which is set via cookie, not in body
# For test, let's just check the endpoint exists
print('{}')
" 2>/dev/null || echo '{}')")
# Note: refresh token is in HttpOnly cookie set during login, hard to extract in shell
# Just verify the endpoint doesn't crash
REFRESH_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$HUB_URL/api/v1/auth/refresh" \
  -H 'Content-Type: application/json' \
  -d '{"refresh_token":"invalid"}')
assert_status "invalid refresh rejected" "401" "$REFRESH_HTTP"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
exit $FAIL
