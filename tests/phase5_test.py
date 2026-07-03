#!/usr/bin/env python3
"""Phase 5 smoke tests for deepanalyze-hub (RSA / JWKS / Distribution)"""
import json
import time
import urllib.request
import urllib.error
import base64
import json as _json

BASE = "http://localhost:22000"
results = []

def jwt_header(token):
    """解析 JWT header（不验签），返回 dict。"""
    try:
        h = token.split(".")[0]
        h += "=" * (-len(h) % 4)
        return _json.loads(base64.urlsafe_b64decode(h))
    except Exception as e:
        return {"error": str(e)}

def test(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    results.append((name, status, detail))
    print(f"  {status}: {name}" + (f" — {detail}" if detail and not condition else ""))

def api(method, path, token=None, api_key=None, data=None):
    url = f"{BASE}{path}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if api_key:
        headers["X-API-Key"] = api_key
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req)
        return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}

print("=== Phase 5 Smoke Tests ===")
ts = int(time.time())

# --- T_A1: JWKS 公钥可达 ---
code, data = api("GET", "/api/v1/auth/jwks.json")
test("jwks endpoint exists", code == 200 and "keys" in data, str(data)[:200])
if code == 200:
    keys = data.get("keys", [])
    test("jwks has at least one key", len(keys) >= 1)
    if keys:
        k = keys[0]
        test("jwks key has kty/alg/kid",
             k.get("kty") == "RSA" and k.get("alg") == "RS256" and "kid" in k)
        test("jwks key has n and e", "n" in k and "e" in k)

# --- T_A2: 新签的 token 是 RS256 ---
code, data = api("POST", "/api/v1/auth/login", data={"username": "admin", "password": "admin123"})
test("login still works", code == 200 and "access_token" in data)
admin_token = data.get("access_token", "") if code == 200 else ""
if code == 200:
    hdr = jwt_header(data["access_token"])
    test("new token alg is RS256", hdr.get("alg") == "RS256", str(hdr))
    test("new token has kid", "kid" in hdr, str(hdr))

# --- T_A4: 手工构造 HS256 token 仍能通过验签 ---
import jwt as pyjwt  # pip install pyjwt

# 用 ACCESS_SECRET 手工签个 HS256 token（模拟旧客户端）
old_token = pyjwt.encode(
    {"sub": "u_admin", "type": "access", "exp": int(time.time()) + 3600},
    "change-me-in-production",
    algorithm="HS256",
)
code, data = api("GET", "/api/v1/auth/me", token=old_token)
test("legacy HS256 token still accepted", code == 200, f"{code}: {str(data)[:100]}")

# --- T_B1: workers 表新字段存在 ---
print("\n--- T_B1: workers distribution columns ---")
code, data = api("GET", "/api/v1/workers", token=admin_token)
test("workers list ok", code == 200, f"{code}: {str(data)[:120]}")

# psql not available in this env; query PG via bun (auto-loads .env)
import subprocess
bun_query = (
    "const pg = require('pg'); "
    "const pool = new pg.Pool({ "
    "  host: process.env.PG_HOST || 'localhost', "
    "  port: parseInt(process.env.PG_PORT || '5432'), "
    "  database: process.env.PG_DATABASE || 'deepanalyze_hub', "
    "  user: process.env.PG_USER || 'deepanalyze', "
    "  password: process.env.PG_PASSWORD || 'deepanalyze_dev', "
    "}); "
    "pool.query(\"SELECT column_name FROM information_schema.columns "
    "  WHERE table_name='workers' AND column_name='assigned_user_id'\") "
    "  .then(r => { console.log(r.rows.length > 0 ? 'YES' : 'NO'); return pool.end(); }) "
    "  .catch(e => { console.error(e.message); process.exit(1); });"
)
r = subprocess.run(
    ["bun", "-e", bun_query],
    capture_output=True, text=True, cwd="/mnt/d/code/deepanalyze/deepanalyze-hub",
)
test("workers.assigned_user_id column exists", "YES" in r.stdout, f"stdout={r.stdout.strip()} stderr={r.stderr.strip()[:80]}")

# --- T_B2: 生成 join_token + 消费 ---
print("\n--- T_B2: join_token create + consume ---")
# org_dsi is the root org seeded by scripts/seed-realistic.ts
org_id = "org_dsi"

code, data = api("POST", "/api/v1/workers/join-tokens",
                  token=admin_token,
                  data={"organization_id": org_id, "count": 1, "assigned_user_id": "usr_alice"})
test("create join_token", code == 201 and "tokens" in data, str(data)[:200])
tokens = data.get("tokens", [])
jt = tokens[0].get("token") if tokens else None
test("join_token format", jt is not None and jt.startswith("djt_"), str(data)[:200])

# 消费（DA 端会调用 register）
code, data = api("POST", "/api/v1/workers/register",
                  data={"join_token": jt, "hostname": "test-host", "protocol_version": 2})
test("register via join_token auto-approved",
     code == 200 and data.get("worker_token", "").startswith("wkt_"),
     str(data)[:200])

# 二次消费应失败
code, data = api("POST", "/api/v1/workers/register",
                  data={"join_token": jt, "hostname": "test-host2", "protocol_version": 2})
test("join_token single-use",
     code in (400, 409) or data.get("status") == "rejected",
     str(data)[:200])

# --- T_B4: DA 主动注销 (self-deactivate) ---
print("\n--- T_B4: worker self-deactivate ---")
code, data = api("POST", "/api/v1/workers/register",
                  data={"hostname": "deactivate-test", "protocol_version": 1})
wt = data.get("worker_token") or data.get("workerToken")
test("prereg for deactivate", code == 200 and wt, str(data)[:200])

if wt:
    code, data = api("POST", "/api/v1/workers/me/deactivate", token=wt)
    test("deactivate ok", code == 200 and data.get("status") == "deactivated", str(data)[:200])

    # 注销后心跳应失败
    code, data = api("POST", "/api/v1/workers/heartbeat", token=wt,
                      data={"status": "online"})
    test("heartbeat after deactivate rejected", code in (401, 403, 404),
         f"code={code} data={str(data)[:120]}")

# --- T_C1: skill_packages lifecycle columns ---
print("\n--- T_C1: skill_packages lifecycle fields ---")
bun_query_c1 = (
    "const pg = require('pg'); "
    "const pool = new pg.Pool({ "
    "  host: process.env.PG_HOST || 'localhost', "
    "  port: parseInt(process.env.PG_PORT || '5432'), "
    "  database: process.env.PG_DATABASE || 'deepanalyze_hub', "
    "  user: process.env.PG_USER || 'deepanalyze', "
    "  password: process.env.PG_PASSWORD || 'deepanalyze_dev', "
    "}); "
    "pool.query(\"SELECT column_name FROM information_schema.columns "
    "  WHERE table_name='skill_packages' AND column_name='status'\") "
    "  .then(r => { console.log(r.rows.length > 0 ? 'YES' : 'NO'); return pool.end(); }) "
    "  .catch(e => { console.error(e.message); process.exit(1); });"
)
r = subprocess.run(
    ["bun", "-e", bun_query_c1],
    capture_output=True, text=True, cwd="/mnt/d/code/deepanalyze/deepanalyze-hub",
)
test("skill_packages.status column exists", "YES" in r.stdout, f"stdout={r.stdout.strip()} stderr={r.stderr.strip()[:80]}")

bun_query_c1b = (
    "const pg = require('pg'); "
    "const pool = new pg.Pool({ "
    "  host: process.env.PG_HOST || 'localhost', "
    "  port: parseInt(process.env.PG_PORT || '5432'), "
    "  database: process.env.PG_DATABASE || 'deepanalyze_hub', "
    "  user: process.env.PG_USER || 'deepanalyze', "
    "  password: process.env.PG_PASSWORD || 'deepanalyze_dev', "
    "}); "
    "pool.query(\"SELECT column_name FROM information_schema.columns "
    "  WHERE table_name='skill_packages' AND column_name IN ('status','deprecated_at','kill_reason') "
    "  ORDER BY column_name\") "
    "  .then(r => { console.log(r.rows.map(x=>x.column_name).join(',')); return pool.end(); }) "
    "  .catch(e => { console.error(e.message); process.exit(1); });"
)
r = subprocess.run(
    ["bun", "-e", bun_query_c1b],
    capture_output=True, text=True, cwd="/mnt/d/code/deepanalyze/deepanalyze-hub",
)
cols = r.stdout.strip().split(",") if r.stdout.strip() else []
test("skill_packages has all 3 lifecycle columns",
     set(cols) == {"status", "deprecated_at", "kill_reason"},
     f"found={cols}")

# Verify CHECK constraint allows the 3 statuses
bun_query_c1c = (
    "const pg = require('pg'); "
    "const pool = new pg.Pool({ "
    "  host: process.env.PG_HOST || 'localhost', "
    "  port: parseInt(process.env.PG_PORT || '5432'), "
    "  database: process.env.PG_DATABASE || 'deepanalyze_hub', "
    "  user: process.env.PG_USER || 'deepanalyze', "
    "  password: process.env.PG_PASSWORD || 'deepanalyze_dev', "
    "}); "
    "pool.query(\"SELECT constraint_name FROM information_schema.table_constraints "
    "  WHERE table_name='skill_packages' AND constraint_name='skill_packages_status_check'\") "
    "  .then(r => { console.log(r.rows.length > 0 ? 'YES' : 'NO'); return pool.end(); }) "
    "  .catch(e => { console.error(e.message); process.exit(1); });"
)
r = subprocess.run(
    ["bun", "-e", bun_query_c1c],
    capture_output=True, text=True, cwd="/mnt/d/code/deepanalyze/deepanalyze-hub",
)
test("skill_packages_status_check constraint exists", "YES" in r.stdout, f"stdout={r.stdout.strip()}")

# Summary
passed = sum(1 for _, s, _ in results if s == "PASS")
failed = sum(1 for _, s, _ in results if s == "FAIL")
print(f"\n=== Result: {passed} passed, {failed} failed ===")
exit(failed)
