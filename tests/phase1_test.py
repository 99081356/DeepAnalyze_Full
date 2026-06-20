#!/usr/bin/env python3
"""Phase 1 smoke tests for deepanalyze-hub"""
import json
import time
import urllib.request
import urllib.error

BASE = "http://localhost:22000"
results = []

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

print("=== Phase 1 Smoke Tests ===")
ts = int(time.time())

# T1: Health
code, data = api("GET", "/api/health")
test("health", code == 200 and data.get("status") == "ok")

# T2: Login
code, data = api("POST", "/api/v1/auth/login", data={"username": "admin", "password": "admin123"})
test("login", code == 200 and "access_token" in data)
admin_token = data.get("access_token", "")

# T3: Me
code, data = api("GET", "/api/v1/auth/me", token=admin_token)
test("me is_super_admin", code == 200 and data.get("is_super_admin") == True, str(data)[:100])

# T4: Create org
code, data = api("POST", "/api/v1/orgs", token=admin_token, data={
    "name": f"E2E_{ts}", "code": f"E2E_{ts}", "type": "company"
})
test("org created", code == 201 and "id" in data.get("organization", {}), str(data)[:100])
org_id = data.get("organization", {}).get("id", "")

# T5: Sub-department
code, data = api("POST", "/api/v1/orgs", token=admin_token, data={
    "name": f"Dept_{ts}", "code": f"D_{ts}", "type": "department", "parent_id": org_id
})
test("dept created", code == 201, str(data)[:100])

# T6: Org tree
code, data = api("GET", f"/api/v1/orgs/{org_id}/tree", token=admin_token)
test("tree has children", code == 200 and "children" in data.get("tree", {}), str(data)[:100])

# T7: Create user
code, data = api("POST", "/api/v1/users", token=admin_token, data={
    "username": f"u_{ts}", "password": "t123", "organization_id": org_id
})
test("user created", code == 201 and "id" in data.get("user", {}), str(data)[:100])

# T8: User login
code, data = api("POST", "/api/v1/auth/login", data={"username": f"u_{ts}", "password": "t123"})
test("user login", code == 200 and "access_token" in data)
user_token = data.get("access_token", "")

# T9: Permission isolation
code, data = api("POST", "/api/v1/orgs", token=user_token, data={
    "name": "hack", "code": f"h_{ts}", "type": "company"
})
test("user forbidden org:create", code == 403, f"got {code}")

# T10: Worker v1
code, data = api("POST", "/api/v1/workers/register", data={
    "name": f"w1_{ts}", "hostname": "localhost", "protocol_version": 1
})
test("worker v1 auto-approve", code == 200 and "workerToken" in data, str(data)[:100])

# T11: Worker v2 apply
code, data = api("POST", "/api/v1/workers/register", data={
    "name": f"w2_{ts}", "hostname": "localhost", "protocol_version": 2
})
test("worker v2 pending", code == 202 and data.get("status") == "pending", str(data)[:100])
worker_id = data.get("worker_id", "")

# T12: Approve worker
code, data = api("POST", f"/api/v1/workers/{worker_id}/approve", token=admin_token)
test("worker approved", code == 200 and "worker_token" in data, str(data)[:100])

# T13: Pending list
code, data = api("GET", "/api/v1/workers/pending", token=admin_token)
test("pending endpoint", code == 200, f"got {code}")

# T14: API Key
code, data = api("POST", "/api/v1/auth/apikey", token=admin_token, data={"name": "test", "scope": "read"})
test("apikey created", code == 200 and "api_key" in data, str(data)[:100])
api_key = data.get("api_key", "")

# T14b: API Key works
code, data = api("GET", "/api/v1/auth/me", api_key=api_key)
test("apikey me works", code == 200 and data.get("username") == "admin", str(data)[:100])

# T15: Roles
code, data = api("GET", "/api/v1/rbac/roles", token=admin_token)
test("roles list", code == 200 and any(r.get("name") == "超级管理员" for r in data.get("roles", [])))

# T16: Permissions
code, data = api("GET", "/api/v1/rbac/permissions", token=admin_token)
test("perms list", code == 200 and any(p.get("code") == "org:create" for p in data.get("permissions", [])))

# T17: Wrong password
code, data = api("POST", "/api/v1/auth/login", data={"username": "admin", "password": "wrong"})
test("wrong password rejected", code == 401, f"got {code}")

# T18: No token
code, data = api("GET", "/api/v1/users")
test("no token denied", code == 401, f"got {code}")

# T19: Org admin sees org users
code, data = api("POST", "/api/v1/users", token=admin_token, data={
    "username": f"oa_{ts}", "password": "t123", "organization_id": org_id, "is_org_admin": True
})
test("org admin created", code == 201)

code, data = api("POST", "/api/v1/auth/login", data={"username": f"oa_{ts}", "password": "t123"})
oa_token = data.get("access_token", "")

code, data = api("GET", "/api/v1/users", token=oa_token)
usernames = [u.get("username") for u in data.get("users", [])]
test("org admin sees org users", f"u_{ts}" in usernames, f"users={usernames}")

# Summary
passed = sum(1 for _, s, _ in results if s == "PASS")
failed = sum(1 for _, s, _ in results if s == "FAIL")
print(f"\n=== Result: {passed} passed, {failed} failed ===")
exit(failed)
