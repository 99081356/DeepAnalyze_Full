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

# --- T_C2: skill submission query, version list, author withdraw ---
print("\n--- T_C2: skill marketplace endpoints ---")

# Ensure the 'system' user exists (submit endpoint hardcodes submitter_id='system')
bun_query_sysuser = (
    "const pg = require('pg'); "
    "const pool = new pg.Pool({ "
    "  host: process.env.PG_HOST || 'localhost', "
    "  port: parseInt(process.env.PG_PORT || '5432'), "
    "  database: process.env.PG_DATABASE || 'deepanalyze_hub', "
    "  user: process.env.PG_USER || 'deepanalyze', "
    "  password: process.env.PG_PASSWORD || 'deepanalyze_dev', "
    "}); "
    "pool.query(\"INSERT INTO users (id, username, display_name, role, status, auth_source, is_super_admin) "
    "  VALUES ('system', 'system', 'System', 'admin', 'active', 'system', TRUE) "
    "  ON CONFLICT (id) DO NOTHING\") "
    "  .then(() => { console.log('OK'); return pool.end(); }) "
    "  .catch(e => { console.error(e.message); process.exit(1); });"
)
subprocess.run(
    ["bun", "-e", bun_query_sysuser],
    capture_output=True, text=True, cwd="/mnt/d/code/deepanalyze/deepanalyze-hub",
)

# Register a worker to obtain a worker_token (prior tests don't preserve one)
# Use protocol_version 1 for auto-approval (no join_token needed)
code, data = api("POST", "/api/v1/workers/register",
                  data={"hostname": f"c2-test-{ts}", "protocol_version": 1})
worker_token = data.get("worker_token") or data.get("workerToken") or ""
test("worker registered for C2", code == 200 and worker_token, str(data)[:200])

sub_id = ""
skill_slug = f"test-skill-{ts}"
if worker_token:
    # Submit a skill — endpoint expects name + prompt (slug auto-generated)
    skill_name = f"Test Skill {ts}"
    code, data = api("POST", "/api/v1/marketplace/skills/submit",
                      token=worker_token,
                      data={"name": skill_name, "prompt": "test prompt",
                            "description": "C2 test skill"})
    sub_id = data.get("submissionId", "")
    test("submission created", code in (200, 201) and sub_id, str(data)[:200])

    if sub_id:
        # Query submission status by id
        code, data = api("GET", f"/api/v1/marketplace/submissions/{sub_id}",
                          token=worker_token)
        test("submission status query", code == 200 and "review_status" in data, str(data)[:200])

# Version list (public endpoint — returns 200 + versions key)
code, data = api("GET", f"/api/v1/marketplace/skills/{skill_slug}/versions")
test("skill versions list", code == 200 and "versions" in data, str(data)[:200])

# Withdraw (soft-delete) — admin is super_admin so permission check passes
# Use the slug we just submitted (if submission succeeded) or the fallback slug
withdraw_slug = skill_slug
code, data = api("DELETE", f"/api/v1/marketplace/skills/{withdraw_slug}",
                  token=admin_token)
test("skill withdraw", code in (200, 204), str(data)[:200])

# --- T_D1: model_artifacts table (Phase D model repository schema) ---
print("\n--- T_D1: model_artifacts table ---")

# Check the table exists with all 10 expected columns
bun_query_d1 = (
    "const pg = require('pg'); "
    "const pool = new pg.Pool({ "
    "  host: process.env.PG_HOST || 'localhost', "
    "  port: parseInt(process.env.PG_PORT || '5432'), "
    "  database: process.env.PG_DATABASE || 'deepanalyze_hub', "
    "  user: process.env.PG_USER || 'deepanalyze', "
    "  password: process.env.PG_PASSWORD || 'deepanalyze_dev', "
    "}); "
    "pool.query(\"SELECT column_name, data_type FROM information_schema.columns "
    "  WHERE table_name='model_artifacts' ORDER BY ordinal_position\") "
    "  .then(r => { console.log(r.rows.map(x => x.column_name+':'+x.data_type).join('|')); return pool.end(); }) "
    "  .catch(e => { console.error(e.message); process.exit(1); });"
)
r = subprocess.run(
    ["bun", "-e", bun_query_d1],
    capture_output=True, text=True, cwd="/mnt/d/code/deepanalyze/deepanalyze-hub",
)
col_lines = r.stdout.strip().split("|") if r.stdout.strip() else []
col_map = {}
for line in col_lines:
    if ":" in line:
        cn, dt = line.split(":", 1)
        col_map[cn] = dt
test("model_artifacts table exists with all 10 columns",
     set(col_map.keys()) == {"id", "name", "version", "category", "sha256",
                              "size_bytes", "storage_path", "manifest",
                              "uploaded_by", "created_at"},
     f"cols={sorted(col_map.keys())}")

# Spot-check key column types
test("id is TEXT", col_map.get("id") == "text", f"id={col_map.get('id')}")
test("manifest is JSONB", col_map.get("manifest") == "jsonb",
     f"manifest={col_map.get('manifest')}")
test("sha256 is TEXT", col_map.get("sha256") == "text", f"sha256={col_map.get('sha256')}")
test("created_at is TIMESTAMPTZ (typo fixed)",
     col_map.get("created_at") in ("timestamp with time zone", "timestamptz"),
     f"created_at={col_map.get('created_at')}")

# Check UNIQUE(name, version) constraint exists
bun_query_d1b = (
    "const pg = require('pg'); "
    "const pool = new pg.Pool({ "
    "  host: process.env.PG_HOST || 'localhost', "
    "  port: parseInt(process.env.PG_PORT || '5432'), "
    "  database: process.env.PG_DATABASE || 'deepanalyze_hub', "
    "  user: process.env.PG_USER || 'deepanalyze', "
    "  password: process.env.PG_PASSWORD || 'deepanalyze_dev', "
    "}); "
    "pool.query(\"SELECT indexname FROM pg_indexes WHERE tablename='model_artifacts' "
    "  AND indexdef LIKE '%(name, version)%'\") "
    "  .then(r => { console.log(r.rows.length > 0 ? 'YES' : 'NO'); return pool.end(); }) "
    "  .catch(e => { console.error(e.message); process.exit(1); });"
)
r = subprocess.run(
    ["bun", "-e", bun_query_d1b],
    capture_output=True, text=True, cwd="/mnt/d/code/deepanalyze/deepanalyze-hub",
)
test("UNIQUE(name, version) constraint exists", "YES" in r.stdout,
     f"stdout={r.stdout.strip()} stderr={r.stderr.strip()[:80]}")

# Check both indexes exist
bun_query_d1c = (
    "const pg = require('pg'); "
    "const pool = new pg.Pool({ "
    "  host: process.env.PG_HOST || 'localhost', "
    "  port: parseInt(process.env.PG_PORT || '5432'), "
    "  database: process.env.PG_DATABASE || 'deepanalyze_hub', "
    "  user: process.env.PG_USER || 'deepanalyze', "
    "  password: process.env.PG_PASSWORD || 'deepanalyze_dev', "
    "}); "
    "pool.query(\"SELECT indexname FROM pg_indexes WHERE tablename='model_artifacts' "
    "  AND indexname IN ('idx_model_artifacts_name','idx_model_artifacts_sha') "
    "  ORDER BY indexname\") "
    "  .then(r => { console.log(r.rows.map(x=>x.indexname).join(',')); return pool.end(); }) "
    "  .catch(e => { console.error(e.message); process.exit(1); });"
)
r = subprocess.run(
    ["bun", "-e", bun_query_d1c],
    capture_output=True, text=True, cwd="/mnt/d/code/deepanalyze/deepanalyze-hub",
)
idxs = r.stdout.strip().split(",") if r.stdout.strip() else []
test("both indexes (name, sha) exist",
     set(idxs) == {"idx_model_artifacts_name", "idx_model_artifacts_sha"},
     f"indexes={idxs}")

# --- T_D2: model upload + manifest + blob endpoints ---
print("\n--- T_D2: model repository endpoints ---")

# Manifest should return 404 before any upload (endpoint must exist)
code, data = api("GET", "/api/v1/models/manifests/bge-m3")
test("model manifest 404 before upload", code == 404, f"code={code} data={str(data)[:120]}")

# Upload via multipart (urllib.request — api() helper only does JSON)
boundary = "----deepanalyze-test"
body_str = (
    f"--{boundary}\r\n"
    'Content-Disposition: form-data; name="name"\r\n\r\n'
    "bge-m3\r\n"
    f"--{boundary}\r\n"
    'Content-Disposition: form-data; name="version"\r\n\r\n'
    "1.0.0\r\n"
    f"--{boundary}\r\n"
    'Content-Disposition: form-data; name="category"\r\n\r\n'
    "embedding\r\n"
    f"--{boundary}\r\n"
    'Content-Disposition: form-data; name="file"; filename="config.json"\r\n'
    "Content-Type: application/octet-stream\r\n\r\n"
    '{"test":1}\r\n'
    f"--{boundary}--\r\n"
)
body_bytes = body_str.encode()
req = urllib.request.Request(
    f"{BASE}/api/v1/models/upload",
    data=body_bytes,
    headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Authorization": f"Bearer {admin_token}",
    },
    method="POST",
)
upload_id = ""
try:
    resp = urllib.request.urlopen(req)
    code, data = resp.status, json.loads(resp.read().decode())
except urllib.error.HTTPError as e:
    code, data = e.code, json.loads(e.read().decode())
test("model upload returns 201", code == 201 and "id" in data, f"code={code} data={str(data)[:200]}")
upload_id = data.get("id", "")

# Manifest query after upload
code, data = api("GET", "/api/v1/models/manifests/bge-m3")
test("model manifest fetch after upload",
     code == 200 and "files" in data and data.get("version") == "1.0.0",
     f"code={code} data={str(data)[:200]}")

# Blob download (sha256 from manifest)
if code == 200 and data.get("files"):
    blob_sha = data["files"][0].get("sha256", "")
    if blob_sha:
        code2, blob_bytes = 0, b""
        try:
            blob_req = urllib.request.Request(
                f"{BASE}/api/v1/models/blobs/{blob_sha}",
                method="GET",
            )
            blob_resp = urllib.request.urlopen(blob_req)
            code2 = blob_resp.status
            blob_bytes = blob_resp.read()
        except urllib.error.HTTPError as e:
            code2 = e.code
        test("model blob download returns 200 with content",
             code2 == 200 and len(blob_bytes) > 0,
             f"code={code2} len={len(blob_bytes)}")
    else:
        test("model blob download returns 200 with content", False, "no sha256 in manifest")
else:
    test("model blob download returns 200 with content", False, "no manifest for blob test")

# Delete the version
code, data = api("DELETE", "/api/v1/models/bge-m3/1.0.0", token=admin_token)
test("model version delete",
     code == 200 and data.get("ok") is True,
     f"code={code} data={str(data)[:200]}")

# Manifest should 404 after delete
code, data = api("GET", "/api/v1/models/manifests/bge-m3")
test("model manifest 404 after delete", code == 404, f"code={code}")

# --- T_E2: bundle manifest + image tar streaming ---
print("\n--- T_E2: bundle manifest + image tar endpoints ---")

# Manifest endpoint: 404 when no bundle exists, 200 when one does
code, data = api("GET", "/api/v1/bundle/manifest")
test("bundle manifest endpoint reachable",
     code in (200, 404),
     f"code={code} data={str(data)[:120]}")

# Images list endpoint: should always return {images: [...]}
code, data = api("GET", "/api/v1/bundle/images")
test("bundle images list returns array",
     code == 200 and "images" in data and isinstance(data["images"], list),
     f"code={code} data={str(data)[:120]}")

# Image tar streaming: create a real test tar file, then fetch it via API
import os
images_dir = os.environ.get("HUB_BUNDLE_IMAGES_DIR", "./data/bundle/images")
os.makedirs(images_dir, exist_ok=True)
test_tar_path = os.path.join(images_dir, "test-image.tar")
test_tar_content = b"fake tar content for streaming test"
with open(test_tar_path, "wb") as f:
    f.write(test_tar_content)

# Fetch the tar via raw urllib (binary response, not JSON)
code_img = 0
img_bytes = b""
try:
    img_req = urllib.request.Request(
        f"{BASE}/api/v1/images/test-image.tar",
        method="GET",
    )
    img_resp = urllib.request.urlopen(img_req)
    code_img = img_resp.status
    img_bytes = img_resp.read()
except urllib.error.HTTPError as e:
    code_img = e.code
    try:
        img_bytes = e.read()
    except:
        pass
except Exception as e:
    code_img = 0

test("image tar stream returns 200",
     code_img == 200,
     f"code={code_img}")
test("image tar content matches",
     code_img == 200 and img_bytes == test_tar_content,
     f"code={code_img} got_len={len(img_bytes)} expected_len={len(test_tar_content)}")

# Clean up the test tar
try:
    os.remove(test_tar_path)
except OSError:
    pass

# --- T_F3: AES-256-GCM encrypt/decrypt round-trip ---
print("\n--- T_F3: crypto round-trip ---")
r = subprocess.run(
    ["bun", "-e", """
import {encryptString, decryptString} from './src/core/crypto.ts';
const plain = 'test-secret-key-' + Date.now();
const enc = encryptString(plain);
const dec = decryptString(enc);
console.log(JSON.stringify({ok: dec === plain, hasPlain: enc.includes(plain)}));
"""],
    capture_output=True, text=True, cwd="/mnt/d/code/deepanalyze/deepanalyze-hub",
)
try:
    info = json.loads(r.stdout.strip().split("\n")[-1])
    test("crypto round-trip", info.get("ok") is True, str(info)[:200])
    test("crypto no plaintext leak", info.get("hasPlain") is False, str(info)[:200])
except Exception as e:
    test("crypto round-trip", False, f"parse error: {e}; stdout={r.stdout[:200]}")
    test("crypto no plaintext leak", False, f"parse error: {e}; stderr={r.stderr[:200]}")

# --- T_F4: worker deploy/upgrade/stop/restart/rollback endpoints ---
print("\n--- T_F4: worker deploy endpoints ---")

# Deploy dry-run: should return preview, no side effects
code, data = api("POST", "/api/v1/workers/deploy",
                  token=admin_token,
                  data={
                      "organization_id": org_id,
                      "assigned_user_id": "usr_alice",
                      "ssh_host": "10.0.0.42",
                      "ssh_port": 22,
                      "ssh_user": "ubuntu",
                      "ssh_private_key": "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----",
                      "image_tag": "da-base-v0.9.0-amd64",
                      "source": "hub_stream",
                      "skill_package_ids": [],
                      "dry_run": True,
                  })
test("deploy dry_run returns preview",
     code in (200, 202) and data.get("status") == "preview" and "job_id" in data,
     str(data)[:200])

# Missing required fields -> 400
code, data = api("POST", "/api/v1/workers/deploy",
                  token=admin_token,
                  data={"dry_run": True})  # missing ssh_host etc.
test("deploy missing fields rejected", code == 400, str(data)[:200])

# Auth required
code, data = api("POST", "/api/v1/workers/deploy",
                  data={"dry_run": True, "ssh_host": "x"})
test("deploy requires auth", code == 401, str(data)[:200])

# Deploy-job query for nonexistent ID -> 404
code, data = api("GET", "/api/v1/workers/deploy-jobs/nonexistent_dpl_id", token=admin_token)
test("deploy-job query 404 for missing", code == 404, str(data)[:200])

# Summary
passed = sum(1 for _, s, _ in results if s == "PASS")
failed = sum(1 for _, s, _ in results if s == "FAIL")
print(f"\n=== Result: {passed} passed, {failed} failed ===")
exit(failed)
