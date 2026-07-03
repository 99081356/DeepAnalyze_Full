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
if code == 200:
    hdr = jwt_header(data["access_token"])
    test("new token alg is RS256", hdr.get("alg") == "RS256", str(hdr))
    test("new token has kid", "kid" in hdr, str(hdr))

# Summary
passed = sum(1 for _, s, _ in results if s == "PASS")
failed = sum(1 for _, s, _ in results if s == "FAIL")
print(f"\n=== Result: {passed} passed, {failed} failed ===")
exit(failed)
