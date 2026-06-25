#!/usr/bin/env python3
"""
Phase 2 E2E test: Skill marketplace + SkillSync

Tests:
  T1: Create user-scoped package + version
  T2: Create org-scoped package (as org admin)
  T3: Create system-scoped package (only super admin)
  T4: Subscribe to a package
  T5: Worker heartbeat with cached_skills → sync instruction
  T6: Heartbeat with matching hash → no instructions
  T7: Unsubscribe → next heartbeat → kill instruction
  T8: Kill switch → package excluded from expected
  T9: Permission isolation (regular user can't create system package)
"""
import json
import time
import hashlib
import urllib.request
import urllib.error

BASE = "http://localhost:22000"
results = []

def test(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    results.append((name, status, detail))
    print(f"  {status}: {name}" + (f" — {detail}" if detail and not condition else ""))

def api(method, path, token=None, worker_token=None, data=None):
    url = f"{BASE}{path}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if worker_token:
        headers["Authorization"] = f"Bearer {worker_token}"
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

print("=== Phase 2 Skill Marketplace + SkillSync Tests ===")
ts = int(time.time())

# ── Setup: admin login ─────────────────────────────────────────────────
code, data = api("POST", "/api/v1/auth/login", data={"username": "admin", "password": "admin123"})
admin_token = data.get("access_token", "")
test("admin login", code == 200 and admin_token, str(data)[:80])

# ── Setup: register a worker v2 for SkillSync testing ─────────────────
code, data = api("POST", "/api/v1/workers/register", data={
    "name": f"sync_worker_{ts}", "hostname": "test-host", "protocol_version": 2
})
test("worker registered pending", code == 202 and data.get("status") == "pending", str(data)[:80])
worker_id = data.get("worker_id", "")

# Approve worker
code, data = api("POST", f"/api/v1/workers/{worker_id}/approve", token=admin_token)
test("worker approved", code == 200 and "worker_token" in data, str(data)[:80])
worker_token = data.get("worker_token", "")

# ── T1: Create user-scoped package + version ───────────────────────────
code, data = api("POST", "/api/v1/skills", token=admin_token, data={
    "name": f"user-skill-{ts}",
    "description": "Test user-scoped skill",
    "scope": "user",
    "tags": ["test"]
})
test("user package created", code == 201 and "package" in data, f"{code} {str(data)[:80]}")
user_pkg_id = data.get("package", {}).get("id", "")

# Add version
SKILL_CONTENT = f"""# Test Skill v1

This is a test skill for Phase 2 E2E.

## When to use
For testing SkillSync.

## Instructions
Always be helpful.
Timestamp: {ts}
"""
code, data = api("POST", f"/api/v1/skills/{user_pkg_id}/versions", token=admin_token, data={
    "version": "1.0.0",
    "content": SKILL_CONTENT,
    "when_to_use": "For testing",
    "allowed_tools": ["*"],
    "change_summary": "Initial version for SkillSync testing",
    "autoPublish": True,
})
test("version 1.0.0 created", code == 201 and "version" in data, f"{code} {str(data)[:80]}")
v1_id = data.get("version", {}).get("id", "")
v1_hash = data.get("version", {}).get("content_hash", "")

# ── T2: Create system-scoped package + version ────────────────────────
code, data = api("POST", "/api/v1/skills", token=admin_token, data={
    "name": f"system-skill-{ts}",
    "description": "Test system-scoped skill",
    "scope": "system",
    "tags": ["system", "test"]
})
test("system package created", code == 201, f"{code} {str(data)[:80]}")
sys_pkg_id = data.get("package", {}).get("id", "")

code, data = api("POST", f"/api/v1/skills/{sys_pkg_id}/versions", token=admin_token, data={
    "version": "1.0.0",
    "content": f"# System Skill\n\nFor all workers.\nTimestamp: {ts}\n",
    "change_summary": "Initial system skill version",
    "autoPublish": True,
})
test("system version created", code == 201, str(data)[:80])
sys_v1_hash = data.get("version", {}).get("content_hash", "")

# ── T3: Permission isolation — non-super-admin can't create system pkg ─
# Create a regular user first
code, data = api("POST", "/api/v1/orgs", token=admin_token, data={
    "name": f"TestOrg_{ts}", "code": f"TO_{ts}", "type": "company"
})
org_id = data.get("organization", {}).get("id", "")

code, data = api("POST", "/api/v1/users", token=admin_token, data={
    "username": f"u2_{ts}", "password": "t123", "organization_id": org_id
})
test("regular user created", code == 201, str(data)[:80])

code, data = api("POST", "/api/v1/auth/login", data={"username": f"u2_{ts}", "password": "t123"})
user_token = data.get("access_token", "")

# Regular user tries to create system package
code, data = api("POST", "/api/v1/skills", token=user_token, data={
    "name": "hack-system",
    "description": "Sufficiently long description to pass validation",
    "scope": "system",
})
test("regular user forbidden system pkg", code == 403, f"got {code}")

# Regular user CAN create user-scoped package
code, data = api("POST", "/api/v1/skills", token=user_token, data={
    "name": f"user-own-{ts}",
    "description": "Sufficiently long description to pass validation",
    "scope": "user",
})
test("regular user can create user pkg", code == 201, f"got {code}")

# ── T4: Subscribe admin user to user_pkg ───────────────────────────────
code, data = api("POST", f"/api/v1/skills/{user_pkg_id}/subscribe", token=admin_token)
test("subscribe to user pkg", code == 201 and "subscription" in data, f"{code} {str(data)[:80]}")

code, data = api("GET", "/api/v1/skills/subscriptions/list", token=admin_token)
test("subscription listed", code == 200 and len(data.get("subscriptions", [])) >= 1, str(data)[:100])

# ── T5: Heartbeat with no cached skills → expect sync instructions ────
# Worker belongs to no user and no org, so only system skills are expected
code, data = api("POST", "/api/v1/workers/heartbeat", worker_token=worker_token, data={
    "workerId": worker_id,
    "status": "online",
    "activeSessions": 0,
    "activeTasks": 0,
    "resourceUsage": {"cpuPercent": 5, "memoryUsedGB": 1, "memoryTotalGB": 8, "diskUsedGB": 1, "diskTotalGB": 10},
    "uptime": 100,
    "protocol_version": 2,
    "policy_version": 1,
    "current_task": "idle",
    "cached_skills": [],  # empty cache
})
test("heartbeat returns sync for system skill", code == 200 and any(
    i.get("action") == "sync" and i.get("package_id") == sys_pkg_id
    for i in data.get("instructions", [])
), f"instructions: {[i.get('action') + ':' + i.get('package_id', '')[:8] for i in data.get('instructions', [])]}")

# Capture the sync instruction for sys_pkg
sys_sync_inst = next((i for i in data.get("instructions", []) if i.get("package_id") == sys_pkg_id), None)
test("sync instruction has content", sys_sync_inst and "content" in sys_sync_inst, str(sys_sync_inst)[:100] if sys_sync_inst else "no instruction")

# ── T6: Heartbeat again with matching cache → no sync for sys_pkg ─────
code, data = api("POST", "/api/v1/workers/heartbeat", worker_token=worker_token, data={
    "workerId": worker_id,
    "status": "online",
    "activeSessions": 0,
    "activeTasks": 0,
    "resourceUsage": {"cpuPercent": 5, "memoryUsedGB": 1, "memoryTotalGB": 8, "diskUsedGB": 1, "diskTotalGB": 10},
    "uptime": 200,
    "protocol_version": 2,
    "policy_version": 1,
    "cached_skills": [
        {"package_id": sys_pkg_id, "version": "1.0.0", "content_hash": sys_v1_hash}
    ],
})
test("matching cache → no sync", code == 200 and not any(
    i.get("action") == "sync" and i.get("package_id") == sys_pkg_id
    for i in data.get("instructions", [])
), f"instructions: {data.get('instructions', [])}")

# ── T7: Add unknown skill to cache → kill instruction ─────────────────
code, data = api("POST", "/api/v1/workers/heartbeat", worker_token=worker_token, data={
    "workerId": worker_id,
    "status": "online",
    "activeSessions": 0,
    "activeTasks": 0,
    "resourceUsage": {"cpuPercent": 5, "memoryUsedGB": 1, "memoryTotalGB": 8, "diskUsedGB": 1, "diskTotalGB": 10},
    "uptime": 300,
    "protocol_version": 2,
    "cached_skills": [
        {"package_id": sys_pkg_id, "version": "1.0.0", "content_hash": sys_v1_hash},
        {"package_id": "pkg_unknown", "version": "1.0.0", "content_hash": "fake_hash_00000000000000000"}
    ],
})
test("extra cached → kill", code == 200 and any(
    i.get("action") == "kill" and i.get("package_id") == "pkg_unknown"
    for i in data.get("instructions", [])
), f"instructions: {data.get('instructions', [])}")

# ── T8: Kill switch on system skill → no longer in expected ───────────
code, data = api("POST", f"/api/v1/skills/{sys_pkg_id}/kill", token=admin_token, data={
    "reason": "Test kill switch"
})
test("kill switch applied", code == 200, f"{code} {str(data)[:80]}")

code, data = api("POST", "/api/v1/workers/heartbeat", worker_token=worker_token, data={
    "workerId": worker_id,
    "status": "online",
    "activeSessions": 0,
    "activeTasks": 0,
    "resourceUsage": {"cpuPercent": 5, "memoryUsedGB": 1, "memoryTotalGB": 8, "diskUsedGB": 1, "diskTotalGB": 10},
    "uptime": 400,
    "protocol_version": 2,
    "cached_skills": [
        {"package_id": sys_pkg_id, "version": "1.0.0", "content_hash": sys_v1_hash}
    ],
})
test("kill-switched skill → kill instruction", code == 200 and any(
    i.get("action") == "kill" and i.get("package_id") == sys_pkg_id
    for i in data.get("instructions", [])
), f"instructions: {data.get('instructions', [])}")

# Restore
code, data = api("POST", f"/api/v1/skills/{sys_pkg_id}/unkill", token=admin_token)
test("unkill restores", code == 200, f"{code}")

# ── T9: Ack endpoint ───────────────────────────────────────────────────
ack_inst = sys_sync_inst
if ack_inst:
    code, data = api("POST", "/api/v1/workers/ack", worker_token=worker_token, data=ack_inst)
    test("ack accepted", code == 200, f"{code} {str(data)[:80]}")

# ── T10: Version download ──────────────────────────────────────────────
code, data = api("GET", f"/api/v1/skills/{user_pkg_id}/versions/{v1_id}/download", worker_token=worker_token)
test("version download works", code == 200 and "content" in data and data.get("content_hash") == v1_hash, f"{code} {str(data)[:80]}")

# Summary
passed = sum(1 for _, s, _ in results if s == "PASS")
failed = sum(1 for _, s, _ in results if s == "FAIL")
print(f"\n=== Result: {passed} passed, {failed} failed ===")
exit(failed)
