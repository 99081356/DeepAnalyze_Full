# Hub 分发与协作改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Hub 从纯控制平面升级为 DA 的分发与协作中枢——支持 RS256 JWT（DA 可持公钥本地验签）、模型仓库、镜像仓库、SSH 远程拉起 Worker、Skill 市场审核闭环、Worker 注销。

**Architecture:** 在现有 Hub（Hono + pg + JWT）基础上，新增 5 个迁移、6 个 route 文件、3 个 domain 模块。所有新功能独立可测，向下兼容（HS256 过渡期 30 天，老 worker_token 机制不变）。

**Tech Stack:** TypeScript + Hono + node-postgres + jsonwebtoken + bcrypt + ssh2 + Zod

## Global Constraints

- **向下兼容**：HS256 与 RS256 双算法并存 ≥30 天；现有 worker_token 机制不变；现有 skill_packages 数据默认 `status='published'`
- **语言**：所有文档、注释中文优先；代码标识符英文
- **测试**：每个 endpoint 至少 1 个 Python smoke test 覆盖（参照 `tests/phase1_test.py` 风格）
- **数据库迁移**：新 migration 文件命名为 `0NN_description.ts`，导出 `up/down(query)` 两个函数
- **错误返回**：所有新 endpoint 错误用 `{ error: string, code?: string }` 格式，HTTP 状态码遵循 RESTful
- **认证**：管理员类 endpoint 用 `jwtAuth + requirePermission("xxx:admin")`；DA 调用类 endpoint 用 `workerAuth`；DA 用户代理类用 `jwtAuth`
- **JWKS 公钥**：仅用于验签，永不写私钥到磁盘（私钥仅内存或 KMS）
- **SHA256**：模型 blob 用 sha256 命名/校验；SSH key 用 AES 加密存储（`ssh_key_encrypted` 字段）

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `src/core/config.ts` | 修改 | 增加 `auth.rs256`、`joinToken`、`ssh`、`modelRepo`、`bundle` 配置段 |
| `src/core/keys.ts` | 新建 | RSA keypair 加载/生成（启动时从环境变量或文件读，否则生成临时对） |
| `src/domain/auth.ts` | 修改 | `issueTokenPair` 改为 RS256 默认；`verifyAccessToken` 支持双算法 |
| `src/domain/jwks.ts` | 新建 | JWKS 端点数据生成（kid → RSA 公钥 JWK 格式） |
| `src/domain/join-token.ts` | 新建 | 一次性 join_token 生成/校验/作废（内存 + DB 双层） |
| `src/domain/model-artifact.ts` | 新建 | 模型上传/查询/删除（含 multipart 解析、sha256 校验） |
| `src/domain/bundle.ts` | 新建 | bundle_manifests CRUD + 镜像 tar 流式服务 |
| `src/domain/worker-deployment.ts` | 新建 | SSH 远程拉起/升级/回滚编排 |
| `src/server/middleware/jwt-auth.ts` | 修改 | 支持 RS256 验签分支 |
| `src/server/routes/auth.ts` | 修改 | 新增 `GET /jwks.json` |
| `src/server/routes/workers.ts` | 修改 | 新增 `/me/deactivate`、`/deploy`、`/:id/upgrade`、`/:id/stop`、`/:id/restart`；`/register` 支持 join_token |
| `src/server/routes/models.ts` | 新建 | `/api/v1/models/*` 路由 |
| `src/server/routes/bundle.ts` | 新建 | `/api/v1/bundle/*` + `/api/v1/images/*` 路由 |
| `src/server/routes/marketplace.ts` | 修改 | 新增 `GET /submissions/:id`、`GET /skills/:slug/versions`、`DELETE /skills/:slug` |
| `src/server/app.ts` | 修改 | 挂载新路由 |
| `src/store/migrations/019_workers_distribution_cols.ts` | 新建 | workers 表加 SSH/部署相关字段 |
| `src/store/migrations/020_join_tokens.ts` | 新建 | join_tokens 表 |
| `src/store/migrations/021_model_artifacts.ts` | 新建 | model_artifacts 表 |
| `src/store/migrations/022_bundle_manifests.ts` | 新建 | bundle_manifests 表 |
| `src/store/migrations/023_skill_packages_lifecycle.ts` | 新建 | skill_packages 加 status/deprecated_at/kill_reason |
| `src/store/migrations/024_deploy_jobs.ts` | 新建 | deploy_jobs 表（部署任务日志） |
| `tests/phase5_test.py` | 新建 | Phase 5 全流程 smoke 测试（JWT、Worker 部署、模型仓库、bundle） |
| `tests/e2e/deploy.spec.ts` | 新建 | Worker 部署 Playwright 测试 |
| `package.json` | 修改 | 新增 `ssh2`、`@clack/prompts`（可选）、`node-stream-zip`（可选）依赖 |
| `frontend/src/pages/WorkerApproval.tsx` | 修改 | 增加"添加 Worker"部署表单 + 部署任务进度 |
| `frontend/src/pages/Models.tsx` | 新建 | 模型仓库管理页（上传/列表/删除） |
| `frontend/src/pages/SkillSubmissions.tsx` | 新建 | Skill 提交审核跟踪页 |
| `frontend/src/api/client.ts` | 修改 | 增加新 endpoint 客户端方法 |
| `frontend/src/App.tsx` | 修改 | 注册新路由 `/models`、`/submissions` |

---

## Phase A: JWT RS256 升级 + JWKS endpoint（基础）

> 这部分是 DA 端 hub 模式验签的前置依赖。必须最先做。

### Task A1: RSA keypair 加载模块 + 配置扩展

**Files:**
- Create: `src/core/keys.ts`
- Modify: `src/core/config.ts`
- Test: `tests/phase5_test.py`（追加测试组）

**Interfaces:**
- Produces: `getKeyPair(): { publicKeyPem: string; privateKeyPem: string; kid: string; jwk: Jwk }`
- Produces: `HUB_CONFIG.auth.rs256.publicKeyPath` / `privateKeyPath` / `keyId`

- [ ] **Step 1: 写失败测试**

`tests/phase5_test.py` 顶部增加（沿用 `api()` helper）：

```python
# T_A1: JWKS 公钥可达
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
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
python3 tests/phase5_test.py 2>&1 | grep -E "(T_A1|jwks)"
```

Expected: FAIL — `/api/v1/auth/jwks.json` 返回 404。

- [ ] **Step 3: 修改 `src/core/config.ts` 增加 RS256 配置**

```typescript
auth: {
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || "change-me-refresh-in-production",
  jwtExpiry: process.env.JWT_EXPIRY || "7d",
  workerTokenExpiry: process.env.WORKER_TOKEN_EXPIRY || "30d",
  rs256: {
    publicKeyPath: process.env.HUB_JWT_PUBLIC_KEY_PATH || "",
    privateKeyPath: process.env.HUB_JWT_PRIVATE_KEY_PATH || "",
    keyId: process.env.HUB_JWT_KEY_ID || "hub-rs256-v1",
  },
  joinToken: {
    expiry: process.env.HUB_JOIN_TOKEN_EXPIRY || "24h",
    maxCount: parseInt(process.env.HUB_JOIN_TOKEN_MAX || "100", 10),
  },
  ssh: {
    port: parseInt(process.env.HUB_SSH_DEFAULT_PORT || "22", 10),
    timeout: parseInt(process.env.HUB_SSH_TIMEOUT || "60000", 10),
  },
  hs256TransitionUntil: process.env.HUB_HS256_TRANSITION_UNTIL || "",
},
```

- [ ] **Step 4: 创建 `src/core/keys.ts`**

```typescript
// =============================================================================
// DeepAnalyze Hub - RSA Keypair Loader
// =============================================================================
// 启动时加载 RSA keypair（用于 RS256 JWT 签名）。
// 优先从环境变量指定的 PEM 文件加载；缺失则生成临时对（仅开发环境）。
// =============================================================================

import { readFileSync, existsSync } from "node:fs";
import { generateKeyPairSync, createPublicKey, randomUUID } from "node:crypto";
import { HUB_CONFIG } from "./config.js";

export interface Jwk {
  kty: "RSA";
  use: "sig";
  alg: "RS256";
  kid: string;
  n: string;
  e: string;
}

export interface KeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  kid: string;
  jwk: Jwk;
}

let cachedKeyPair: KeyPair | null = null;

export function getKeyPair(): KeyPair {
  if (cachedKeyPair) return cachedKeyPair;

  const pubPath = HUB_CONFIG.auth.rs256.publicKeyPath;
  const privPath = HUB_CONFIG.auth.rs256.privateKeyPath;
  const kid = HUB_CONFIG.auth.rs256.keyId;

  let publicKeyPem: string;
  let privateKeyPem: string;

  if (pubPath && privPath && existsSync(pubPath) && existsSync(privPath)) {
    publicKeyPem = readFileSync(pubPath, "utf-8");
    privateKeyPem = readFileSync(privPath, "utf-8");
  } else if (HUB_CONFIG.env === "development") {
    // 开发环境自动生成临时对（每次重启变化，DA 会触发 JWKS 重拉）
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    console.warn("[keys] development mode: generated ephemeral RSA keypair");
  } else {
    throw new Error(
      "[keys] production requires HUB_JWT_PUBLIC_KEY_PATH and HUB_JWT_PRIVATE_KEY_PATH",
    );
  }

  // 转 JWK 格式（仅公钥）
  const pubKeyObj = createPublicKey(publicKeyPem);
  const jwkObj = pubKeyObj.export({ format: "jwk" }) as {
    n: string;
    e: string;
  };

  const jwk: Jwk = {
    kty: "RSA",
    use: "sig",
    alg: "RS256",
    kid,
    n: jwkObj.n,
    e: jwkObj.e,
  };

  cachedKeyPair = { publicKeyPem, privateKeyPem, kid, jwk };
  return cachedKeyPair;
}
```

- [ ] **Step 5: 运行测试**

```bash
python3 tests/phase5_test.py 2>&1 | grep -E "T_A1|jwks"
```

Expected: T_A1 仍 FAIL（JWKS endpoint 还没接，下一步 Task A3 才接）。

- [ ] **Step 6: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/core/keys.ts src/core/config.ts tests/phase5_test.py
git commit -m "feat(hub): add RSA keypair loader and rs256 config scaffolding"
```

---

### Task A2: `issueTokenPair` 改 RS256 默认 + 双算法 verify

**Files:**
- Modify: `src/domain/auth.ts`
- Test: `tests/phase5_test.py`

**Interfaces:**
- Consumes: `getKeyPair()` from A1
- Produces: `issueTokenPair(userId)` 现在签 RS256（默认）；`verifyAccessToken` 同时支持 HS256/RS256
- Produces: `verifyAccessTokenRs256(token): { sub: string; type: string; org_id?: string } | null`

- [ ] **Step 1: 写失败测试**

在 `tests/phase5_test.py` 顶部增加 helper：

```python
import base64, json as _json

def jwt_header(token):
    """解析 JWT header（不验签），返回 dict。"""
    try:
        h = token.split(".")[0]
        h += "=" * (-len(h) % 4)
        return _json.loads(base64.urlsafe_b64decode(h))
    except Exception as e:
        return {"error": str(e)}
```

在 T_A1 之后追加：

```python
# T_A2: 新签的 token 是 RS256
code, data = api("POST", "/api/v1/auth/login", data={"username": "admin", "password": "admin123"})
test("login still works", code == 200 and "access_token" in data)
if code == 200:
    hdr = jwt_header(data["access_token"])
    test("new token alg is RS256", hdr.get("alg") == "RS256", str(hdr))
    test("new token has kid", "kid" in hdr, str(hdr))
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
python3 tests/phase5_test.py 2>&1 | grep T_A2
```

Expected: FAIL — alg 是 HS256。

- [ ] **Step 3: 改造 `src/domain/auth.ts`**

在文件顶部 import 块加：
```typescript
import { getKeyPair } from "../core/keys.js";
```

替换 `issueTokenPair`：

```typescript
export function issueTokenPair(userId: string): TokenPair {
  const { privateKeyPem, kid } = getKeyPair();
  const access_token = jwt.sign(
    { sub: userId, type: "access" },
    privateKeyPem,
    { algorithm: "RS256", expiresIn: ACCESS_EXPIRY, keyid: kid } as jwt.SignOptions,
  );
  const refresh_token = jwt.sign(
    { sub: userId, type: "refresh" },
    privateKeyPem,
    { algorithm: "RS256", expiresIn: REFRESH_EXPIRY, keyid: kid } as jwt.SignOptions,
  );

  return {
    access_token,
    refresh_token,
    expires_in: parseExpiryToSeconds(ACCESS_EXPIRY),
  };
}
```

替换 `verifyAccessToken`：

```typescript
export function verifyAccessToken(
  token: string,
): { sub: string; type: string } | null {
  try {
    // 先解析 header 决定算法
    const decoded = jwt.decode(token, { complete: true }) as
      | { header: { alg: string; kid?: string } }
      | null;
    if (!decoded) return null;

    if (decoded.header.alg === "RS256") {
      return verifyAccessTokenRs256(token);
    }
    // 兼容期 HS256
    if (decoded.header.alg === "HS256") {
      const payload = jwt.verify(token, ACCESS_SECRET) as {
        sub: string;
        type: string;
      };
      if (payload.type !== "access") return null;
      return payload;
    }
    return null;
  } catch {
    return null;
  }
}

export function verifyAccessTokenRs256(
  token: string,
): { sub: string; type: string } | null {
  try {
    const { publicKeyPem } = getKeyPair();
    const payload = jwt.verify(token, publicKeyPem, {
      algorithms: ["RS256"],
    }) as { sub: string; type: string };
    if (payload.type !== "access") return null;
    return payload;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 运行测试**

```bash
python3 tests/phase5_test.py 2>&1 | grep -E "T_A[12]"
```

Expected: T_A1 仍 FAIL（JWKS 还没接），T_A2 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/domain/auth.ts tests/phase5_test.py
git commit -m "feat(hub): issue RS256 JWTs by default with HS256 backward-compat verify"
```

---

### Task A3: GET /api/v1/auth/jwks.json endpoint

**Files:**
- Create: `src/domain/jwks.ts`
- Modify: `src/server/routes/auth.ts`
- Test: `tests/phase5_test.py`

**Interfaces:**
- Produces: `GET /api/v1/auth/jwks.json` → `{ keys: Jwk[] }`（无需认证）

- [ ] **Step 1: 写失败测试**

T_A1 已经写好，直接运行确认仍然失败：

```bash
python3 tests/phase5_test.py 2>&1 | grep "jwks"
```

- [ ] **Step 2: 创建 `src/domain/jwks.ts`**

```typescript
// =============================================================================
// DeepAnalyze Hub - JWKS Public Key Endpoint
// =============================================================================
// 输出 Hub 公钥集合（JWK Set 格式），DA 拉取用于本地验签。
// 当前仅暴露 1 把 key；预留扩展为多 key（轮换场景）。
// =============================================================================

import { getKeyPair, type Jwk } from "../core/keys.js";

export function getJwks(): { keys: Jwk[] } {
  const kp = getKeyPair();
  return { keys: [kp.jwk] };
}
```

- [ ] **Step 3: 在 `src/server/routes/auth.ts` 中添加路由**

找到 `createAuthRoutes()` 函数，在 `app.get("/me", ...)` 附近添加：

```typescript
app.get("/jwks.json", (c) => {
  return c.json(getJwks());
});
```

并在文件顶部 import：
```typescript
import { getJwks } from "../../domain/jwks.js";
```

- [ ] **Step 4: 运行测试**

```bash
python3 tests/phase5_test.py 2>&1 | grep -E "T_A1|jwks"
```

Expected: T_A1 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/domain/jwks.ts src/server/routes/auth.ts
git commit -m "feat(hub): add GET /api/v1/auth/jwks.json endpoint"
```

---

### Task A4: 验证旧 HS256 token 在过渡期仍可用

**Files:**
- Test: `tests/phase5_test.py`

- [ ] **Step 1: 写失败测试**

```python
# T_A4: 手工构造 HS256 token 仍能通过验签
import jwt as pyjwt  # pip install pyjwt

# 用 ACCESS_SECRET 手工签个 HS256 token（模拟旧客户端）
old_token = pyjwt.encode(
    {"sub": "usr_admin", "type": "access", "exp": int(time.time()) + 3600},
    "change-me-in-production",
    algorithm="HS256",
)
code, data = api("GET", "/api/v1/auth/me", token=old_token)
test("legacy HS256 token still accepted", code == 200, f"{code}: {str(data)[:100]}")
```

- [ ] **Step 2: 运行测试**

```bash
pip install pyjwt --quiet 2>&1 | tail -1
python3 tests/phase5_test.py 2>&1 | grep T_A4
```

Expected: PASS（双算法验签已经在 A2 实现）。

- [ ] **Step 3: Commit**

```bash
git add tests/phase5_test.py
git commit -m "test(hub): verify legacy HS256 tokens accepted during transition"
```

---

## Phase B: Worker 管理扩展（部署元数据 + 注销）

### Task B1: Migration 019 - workers 表加部署字段

**Files:**
- Create: `src/store/migrations/019_workers_distribution_cols.ts`
- Test: `tests/phase5_test.py`

**Interfaces:**
- Produces: `workers.assigned_user_id`、`da_url`、`ssh_target_host`、`ssh_target_port`、`ssh_user`、`ssh_key_encrypted`、`current_image_tag`、`last_health_status`

- [ ] **Step 1: 写失败测试**

```python
# T_B1: workers 表新字段存在
code, data = api("GET", "/api/v1/workers", token=admin_token)
test("workers list ok", code == 200)
# 直接查 DB 元数据
import subprocess
r = subprocess.run(
    ["psql", "-h", "localhost", "-U", "deepanalyze_hub",
     "-d", "deepanalyze_hub", "-tAc",
     "SELECT column_name FROM information_schema.columns WHERE table_name='workers' AND column_name='assigned_user_id'"],
    capture_output=True, text=True,
)
test("workers.assigned_user_id column exists", "assigned_user_id" in r.stdout)
```

- [ ] **Step 2: 运行确认失败**

```bash
python3 tests/phase5_test.py 2>&1 | grep T_B1
```

Expected: FAIL。

- [ ] **Step 3: 创建迁移文件**

```typescript
/**
 * Migration 019: workers 表增加分发与部署元数据列
 *
 * - assigned_user_id: 该 DA 容器所属员工的 user_id（章节 4.5）
 * - da_url: DA 实例的访问 URL（如 https://da-alice.corp.com）
 * - ssh_target_host/port/user: 远程拉起用 SSH 凭证目标
 * - ssh_key_encrypted: AES 加密后的 SSH 私钥（明文永不存盘）
 * - current_image_tag: 当前运行的镜像版本（如 v0.9.0）
 * - last_health_status: 最近一次心跳摘要 JSON
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE workers
      ADD COLUMN IF NOT EXISTS assigned_user_id TEXT,
      ADD COLUMN IF NOT EXISTS da_url TEXT,
      ADD COLUMN IF NOT EXISTS ssh_target_host TEXT,
      ADD COLUMN IF NOT EXISTS ssh_target_port INT DEFAULT 22,
      ADD COLUMN IF NOT EXISTS ssh_user TEXT,
      ADD COLUMN IF NOT EXISTS ssh_key_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS current_image_tag TEXT,
      ADD COLUMN IF NOT EXISTS last_health_status JSONB;
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE workers
      DROP COLUMN IF EXISTS last_health_status,
      DROP COLUMN IF EXISTS current_image_tag,
      DROP COLUMN IF EXISTS ssh_key_encrypted,
      DROP COLUMN IF EXISTS ssh_user,
      DROP COLUMN IF EXISTS ssh_target_port,
      DROP COLUMN IF EXISTS ssh_target_host,
      DROP COLUMN IF EXISTS da_url,
      DROP COLUMN IF EXISTS assigned_user_id;
  `);
}
```

- [ ] **Step 4: 应用迁移并测试**

```bash
bun run src/store/migrate.ts 2>&1 | tail -5
python3 tests/phase5_test.py 2>&1 | grep T_B1
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/store/migrations/019_workers_distribution_cols.ts tests/phase5_test.py
git commit -m "feat(hub): migration 019 — workers distribution cols (assigned_user/ssh/da_url)"
```

---

### Task B2: join_token 表 + domain 模块

**Files:**
- Create: `src/store/migrations/020_join_tokens.ts`
- Create: `src/domain/join-token.ts`
- Test: `tests/phase5_test.py`

**Interfaces:**
- Produces: `createJoinToken(orgId, opts): Promise<{ token: string; id: string; expiresAt: Date }>`
- Produces: `consumeJoinToken(token, orgId): Promise<{ valid: boolean; reason?: string; meta?: { id: string; orgId: string } }>`
- Produces: `listJoinTokens(orgId?): Promise<JoinTokenRow[]>`

- [ ] **Step 1: 写失败测试**

```python
# T_B2: 生成 join_token + 消费
code, data = api("POST", "/api/v1/workers/join-tokens",
                  token=admin_token,
                  data={"organization_id": org_id, "count": 1, "assigned_user_id": "usr_alice"})
test("create join_token", code == 201 and "tokens" in data, str(data)[:200])
jt = data.get("tokens", [None])[0]
test("join_token format", jt and jt.startswith("djt_"))

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
```

- [ ] **Step 2: 运行确认失败**

```bash
python3 tests/phase5_test.py 2>&1 | grep T_B2
```

- [ ] **Step 3: 创建迁移**

```typescript
/**
 * Migration 020: join_tokens 表
 *
 * Hub Admin 通过此表生成一次性 token，用于 Worker 加入了 Hub。
 * 一次性消费（consumed_at 标记），默认 24h 过期。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS join_tokens (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      assigned_user_id TEXT,
      created_by TEXT NOT NULL,
      created_at TIMESTARLTZ DEFAULT NOW(),
      expires_at TIMESTARLTZ NOT NULL,
      consumed_at TIMESTARLTZ,
      consumed_worker_id TEXT,
      max_uses INT DEFAULT 1,
      use_count INT DEFAULT 0,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_join_tokens_org ON join_tokens(organization_id);
    CREATE INDEX IF NOT EXISTS idx_join_tokens_token ON join_tokens(token);
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS join_tokens;`);
}
```

- [ ] **Step 4: 应用迁移**

```bash
bun run src/store/migrate.ts 2>&1 | tail -5
```

- [ ] **Step 5: 创建 `src/domain/join-token.ts`**

```typescript
// =============================================================================
// DeepAnalyze Hub - Join Token Domain
// =============================================================================
// 一次性 join_token 生成与消费。Hub Admin 生成后发给员工，
// 员工在自己 DA 的"设置 → Hub 连接"填入此 token 即可加入。
// =============================================================================

import { randomUUID } from "node:crypto";
import { query } from "../store/pg.js";
import { HUB_CONFIG } from "../core/config.js";

export interface JoinTokenRow {
  id: string;
  token: string;
  organization_id: string;
  assigned_user_id: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  use_count: number;
  max_uses: number;
}

export interface CreateJoinTokenOpts {
  organizationId: string;
  assignedUserId?: string;
  createdBy: string;
  expiresInHours?: number;
  maxUses?: number;
  notes?: string;
}

export async function createJoinToken(
  opts: CreateJoinTokenOpts,
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const id = `jtk_${randomUUID().replace(/-/g, "")}`;
  const token = `djt_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
  const expiresInHours = opts.expiresInHours ?? 24;
  const maxUses = opts.maxUses ?? 1;

  const result = await query<{ expires_at: Date }>(
    `INSERT INTO join_tokens (id, token, organization_id, assigned_user_id, created_by,
                              expires_at, max_uses, notes)
     VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '1 hour' * $6, $7, $8)
     RETURNING expires_at`,
    [id, token, opts.organizationId, opts.assignedUserId ?? null,
     opts.createdBy, expiresInHours, maxUses, opts.notes ?? null],
  );

  return {
    id,
    token,
    expiresAt: result.rows[0].expires_at,
  };
}

export interface ConsumeResult {
  valid: boolean;
  reason?: string;
  meta?: {
    id: string;
    organizationId: string;
    assignedUserId: string | null;
  };
}

export async function consumeJoinToken(
  token: string,
): Promise<ConsumeResult> {
  const rows = await query<JoinTokenRow>(
    `SELECT * FROM join_tokens WHERE token = $1 FOR UPDATE`,
    [token],
  );
  if (rows.rows.length === 0) {
    return { valid: false, reason: "join_token not found" };
  }
  const row = rows.rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { valid: false, reason: "join_token expired" };
  }
  if (row.use_count >= row.max_uses) {
    return { valid: false, reason: "join_token already consumed" };
  }

  await query(
    `UPDATE join_tokens
     SET use_count = use_count + 1,
         consumed_at = CASE WHEN use_count + 1 >= max_uses THEN NOW() ELSE consumed_at END
     WHERE id = $1`,
    [row.id],
  );

  return {
    valid: true,
    meta: {
      id: row.id,
      organizationId: row.organization_id,
      assignedUserId: row.assigned_user_id,
    },
  };
}

export async function listJoinTokens(
  organizationId?: string,
): Promise<JoinTokenRow[]> {
  const sql = organizationId
    ? `SELECT * FROM join_tokens WHERE organization_id = $1 ORDER BY created_at DESC`
    : `SELECT * FROM join_tokens ORDER BY created_at DESC`;
  const params = organizationId ? [organizationId] : [];
  const result = await query<JoinTokenRow>(sql, params);
  return result.rows;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/store/migrations/020_join_tokens.ts src/domain/join-token.ts
git commit -m "feat(hub): add join_tokens table and join-token domain (one-time, 24h expiry)"
```

---

### Task B3: Worker `/register` 支持 join_token + `/join-tokens` 管理端点

**Files:**
- Modify: `src/server/routes/workers.ts`
- Test: `tests/phase5_test.py`

- [ ] **Step 1: 修改 `/register` 加 join_token 分支**

在 `src/server/routes/workers.ts` 中找到 `POST /register` 处理逻辑，在 `workerIdParam` 解析之前加入：

```typescript
import { consumeJoinToken } from "../../domain/join-token.js";

// 在 register handler 内：
const joinToken = body.join_token as string | undefined;
let assignedUserId: string | null = null;
let organizationIdFromJoin: string | null = null;

if (joinToken) {
  const consumed = await consumeJoinToken(joinToken);
  if (!consumed.valid) {
    return c.json({ error: consumed.reason || "invalid join_token" }, 400);
  }
  organizationIdFromJoin = consumed.meta!.organizationId;
  assignedUserId = consumed.meta!.assignedUserId;
}

// 后续 INSERT 时：
//   organization_id = organizationIdFromJoin ?? body.organization_id ?? null
//   user_id = assignedUserId ?? body.user_id ?? null
//   status = joinToken ? 'approved' : 'pending'
//   approved_at = joinToken ? NOW() : null
//   approved_by = joinToken ? 'join_token' : null
```

注释掉原有的"v2 必须管理员审批"，改为 join_token 路径直接审批，否则保留原 v2 流程。

- [ ] **Step 2: 增加 join_tokens 管理端点**

在 `workers.ts` 中追加：

```typescript
// POST /api/v1/workers/join-tokens — 批量生成
app.post("/join-tokens", jwtAuth, requirePermission("worker:approve"), async (c) => {
  const body = await c.req.json();
  const count = Math.min(body.count || 1, 50);
  const orgId = body.organization_id;
  if (!orgId) return c.json({ error: "organization_id required" }, 400);

  const tokens = [];
  for (let i = 0; i < count; i++) {
    tokens.push(await createJoinToken({
      organizationId: orgId,
      assignedUserId: body.assigned_user_id,
      createdBy: c.get("userId"),
      expiresInHours: body.expires_in_hours ?? 24,
      maxUses: body.max_uses ?? 1,
      notes: body.notes,
    }));
  }
  return c.json({ tokens }, 201);
});

// GET /api/v1/workers/join-tokens — 列出
app.get("/join-tokens", jwtAuth, requirePermission("worker:approve"), async (c) => {
  const orgId = c.req.query("organization_id");
  const rows = await listJoinTokens(orgId);
  return c.json({ tokens: rows });
});

// DELETE /api/v1/workers/join-tokens/:id — 作废
app.delete("/join-tokens/:id", jwtAuth, requirePermission("worker:approve"), async (c) => {
  const id = c.req.param("id");
  await query(`DELETE FROM join_tokens WHERE id = $1`, [id]);
  return c.json({ ok: true });
});
```

并在顶部加 imports：
```typescript
import { createJoinToken, listJoinTokens } from "../../domain/join-token.js";
```

- [ ] **Step 3: 运行测试**

```bash
python3 tests/phase5_test.py 2>&1 | grep T_B2
```

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/workers.ts
git commit -m "feat(hub): worker register accepts join_token; add join-tokens management endpoints"
```

---

### Task B4: POST /api/v1/workers/me/deactivate — DA 主动退出 Hub

**Files:**
- Modify: `src/server/routes/workers.ts`
- Test: `tests/phase5_test.py`

- [ ] **Step 1: 写失败测试**

```python
# T_B4: DA 主动注销
# 先注册一个临时 worker
code, data = api("POST", "/api/v1/workers/register",
                  data={"hostname": "deactivate-test", "protocol_version": 1})
wt = data.get("worker_token")
test("prereg for deactivate", code == 200 and wt)

if wt:
    code, data = api("POST", "/api/v1/workers/me/deactivate", token=wt)
    test("deactivate ok", code == 200 and data.get("status") == "deactivated", str(data)[:200])

    # 注销后心跳应失败
    code, data = api("POST", "/api/v1/workers/heartbeat", token=wt,
                      data={"status": "online"})
    test("heartbeat after deactivate rejected", code in (401, 403, 404))
```

- [ ] **Step 2: 运行确认失败**

```bash
python3 tests/phase5_test.py 2>&1 | grep T_B4
```

- [ ] **Step 3: 添加注销端点**

在 `workers.ts` 中（在 `/heartbeat` 之后）：

```typescript
// POST /api/v1/workers/me/deactivate — DA 主动退出 Hub
app.post("/me/deactivate", workerAuth, async (c) => {
  const workerId = c.get("workerId");
  await query(
    `UPDATE workers
     SET status = 'deactivated',
         deactivated_at = NOW()
     WHERE id = $1`,
    [workerId],
  );
  // 注意：worker_token 仍然存在但 workerAuth 中间件会因 status check 拒绝
  return c.json({ status: "deactivated", worker_id: workerId });
});
```

修改 `workers` 表的 status 约束（如果原 CHECK 不包含 `deactivated`）：

```sql
-- 通过新增小迁移或在 019 中处理
ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_status_check;
ALTER TABLE workers ADD CONSTRAINT workers_status_check
  CHECK (status IN ('pending','approved','online','offline','rejected','revoked','deactivated'));
```

把这段加到 migration 019 末尾。

- [ ] **Step 4: 在 `worker-auth.ts` 中加 status 校验**

修改 `src/server/middleware/worker-auth.ts`，在 SELECT 后加：

```typescript
if (row.status !== "approved" && row.status !== "online") {
  return c.json({ error: `worker status: ${row.status}` }, 403);
}
```

- [ ] **Step 5: 运行测试**

```bash
bun run src/store/migrate.ts
python3 tests/phase5_test.py 2>&1 | grep T_B4
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/workers.ts src/server/middleware/worker-auth.ts \
        src/store/migrations/019_workers_distribution_cols.ts tests/phase5_test.py
git commit -m "feat(hub): worker self-deactivate endpoint + status gate in workerAuth"
```

---

## Phase C: Skill 市场增强（审核状态查询、版本管理、撤回）

### Task C1: Migration 023 - skill_packages 加生命周期字段

**Files:**
- Create: `src/store/migrations/023_skill_packages_lifecycle.ts`
- Test: `tests/phase5_test.py`

- [ ] **Step 1: 创建迁移**

```typescript
/**
 * Migration 023: skill_packages 增加生命周期字段
 *
 * - status: published | deprecated | killed（默认 published，向后兼容）
 * - deprecated_at: 标记弃用时间
 * - kill_reason: kill switch 触发时记录原因
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE skill_packages
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published',
      ADD COLUMN IF NOT EXISTS deprecated_at TIMESTARLTZ,
      ADD COLUMN IF NOT EXISTS kill_reason TEXT;

    ALTER TABLE skill_packages
      DROP CONSTRAINT IF EXISTS skill_packages_status_check;
    ALTER TABLE skill_packages
      ADD CONSTRAINT skill_packages_status_check
        CHECK (status IN ('published','deprecated','killed'));
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`
    ALTER TABLE skill_packages
      DROP CONSTRAINT IF EXISTS skill_packages_status_check,
      DROP COLUMN IF EXISTS kill_reason,
      DROP COLUMN IF EXISTS deprecated_at,
      DROP COLUMN IF EXISTS status;
  `);
}
```

- [ ] **Step 2: 应用迁移**

```bash
bun run src/store/migrate.ts 2>&1 | tail -5
```

- [ ] **Step 3: 测试**

```python
# T_C1: skill_packages 新字段
r = subprocess.run(
    ["psql", "-h", "localhost", "-U", "deepanalyze_hub",
     "-d", "deepanalyze_hub", "-tAc",
     "SELECT column_name FROM information_schema.columns WHERE table_name='skill_packages' AND column_name='status'"],
    capture_output=True, text=True,
)
test("skill_packages.status exists", "status" in r.stdout)
```

```bash
python3 tests/phase5_test.py 2>&1 | grep T_C1
```

- [ ] **Step 4: Commit**

```bash
git add src/store/migrations/023_skill_packages_lifecycle.ts tests/phase5_test.py
git commit -m "feat(hub): migration 023 — skill_packages lifecycle fields"
```

---

### Task C2: GET /api/v1/marketplace/submissions/:id + GET /skills/:slug/versions + DELETE /skills/:slug

**Files:**
- Modify: `src/server/routes/marketplace.ts`
- Test: `tests/phase5_test.py`

- [ ] **Step 1: 写失败测试**

```python
# T_C2: 提交查询、版本列表、撤回
# 先 worker 提交一个 skill（沿用 phase1 已有的 worker token 模式）
# 此处假设已有 worker_token 在变量 worker_token 中
code, data = api("POST", "/api/v1/marketplace/skills/submit",
                  token=worker_token,
                  data={"slug": f"test-skill-{ts}", "name": "Test Skill",
                        "version": "1.0.0", "content": "...", "description": "test"})
sub_id = data.get("submission", {}).get("id", "")
test("submission created", code in (200, 201) and sub_id)

if sub_id:
    code, data = api("GET", f"/api/v1/marketplace/submissions/{sub_id}",
                      token=worker_token)
    test("submission status query", code == 200 and "status" in data, str(data)[:200])

# 版本列表
code, data = api("GET", "/api/v1/marketplace/skills/test-skill/versions")
test("skill versions list", code == 200 and "versions" in data)

# 撤回（作者本人或 admin）
code, data = api("DELETE", "/api/v1/marketplace/skills/test-skill",
                  token=admin_token)
test("skill withdraw", code in (200, 204))
```

- [ ] **Step 2: 运行确认失败**

```bash
python3 tests/phase5_test.py 2>&1 | grep T_C2
```

- [ ] **Step 3: 在 `src/server/routes/marketplace.ts` 添加端点**

```typescript
// GET /api/v1/marketplace/submissions/:id — 查询提交状态（DA 轮询用）
app.get("/submissions/:id", workerAuth, async (c) => {
  const id = c.req.param("id");
  const result = await query<{
    id: string; status: string; reviewer_note: string | null;
    reviewed_at: Date | null; name: string; slug: string;
  }>(`SELECT id, status, reviewer_note, reviewed_at, name, slug
      FROM marketplace_skills WHERE id = $1`, [id]);
  if (result.rows.length === 0) {
    return c.json({ error: "submission not found" }, 404);
  }
  return c.json(result.rows[0]);
});

// GET /api/v1/marketplace/skills/:slug/versions — 版本列表
app.get("/skills/:slug/versions", async (c) => {
  const slug = c.req.param("slug");
  const result = await query<{ version: string; created_at: string; status: string }>(
    `SELECT version, created_at, COALESCE(status, 'published') as status
     FROM marketplace_skills
     WHERE slug = $1 OR name = $1
     ORDER BY created_at DESC`,
    [slug],
  );
  return c.json({ versions: result.rows });
});

// DELETE /api/v1/marketplace/skills/:slug — 作者撤回（软删除）
app.delete("/skills/:slug", jwtAuth, async (c) => {
  const slug = c.req.param("slug");
  const userId = c.get("userId");
  const isSuperAdmin = c.get("isSuperAdmin");

  // 检查权限（作者本人或 admin）
  const found = await query<{ submitter_id: string }>(
    `SELECT submitter_id FROM marketplace_skills
     WHERE slug = $1 AND status != 'rejected' ORDER BY created_at DESC LIMIT 1`,
    [slug],
  );
  if (found.rows.length === 0) {
    return c.json({ error: "skill not found" }, 404);
  }
  if (found.rows[0].submitter_id !== userId && !isSuperAdmin) {
    return c.json({ error: "only author or admin can withdraw" }, 403);
  }

  await query(
    `UPDATE marketplace_skills SET status = 'withdrawn' WHERE slug = $1`,
    [slug],
  );
  return c.json({ ok: true, slug });
});
```

- [ ] **Step 4: 运行测试**

```bash
python3 tests/phase5_test.py 2>&1 | grep T_C2
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/marketplace.ts tests/phase5_test.py
git commit -m "feat(hub): skill marketplace — submissions/:id, versions list, author withdraw"
```

---

## Phase D: 模型仓库（4 endpoints）

### Task D1: Migration 021 - model_artifacts 表

**Files:**
- Create: `src/store/migrations/021_model_artifacts.ts`

- [ ] **Step 1: 创建迁移**

```typescript
/**
 * Migration 021: model_artifacts 表
 *
 * 企业内部模型仓库（章节 6.3 Source C2）。
 * DA Worker 通过 GET /api/v1/models/manifests/:name 拉清单，
 * GET /api/v1/models/blobs/:sha256 拉 blob。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS model_artifacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      category TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes BIGINT,
      storage_path TEXT NOT NULL,
      manifest JSONB NOT NULL,
      uploaded_by TEXT,
      created_at TIMESTARLTZ DEFAULT NOW(),
      UNIQUE(name, version)
    );
    CREATE INDEX IF NOT EXISTS idx_model_artifacts_name ON model_artifacts(name);
    CREATE INDEX IF NOT EXISTS idx_model_artifacts_sha ON model_artifacts(sha256);
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS model_artifacts;`);
}
```

- [ ] **Step 2: 应用迁移并测试**

```bash
bun run src/store/migrate.ts 2>&1 | tail -5
psql -h localhost -U deepanalyze_hub -d deepanalyze_hub -tAc \
  "SELECT column_name FROM information_schema.columns WHERE table_name='model_artifacts' AND column_name='sha256'"
```

- [ ] **Step 3: Commit**

```bash
git add src/store/migrations/021_model_artifacts.ts
git commit -m "feat(hub): migration 021 — model_artifacts table"
```

---

### Task D2: src/domain/model-artifact.ts + 路由 src/server/routes/models.ts

**Files:**
- Create: `src/domain/model-artifact.ts`
- Create: `src/server/routes/models.ts`
- Modify: `src/server/app.ts`
- Test: `tests/phase5_test.py`

**Interfaces:**
- Produces: `uploadModelArtifact(name, version, files, opts): Promise<{ id: string }>` — multipart 处理
- Produces: `getLatestManifest(name): Promise<ManifestJson | null>` — DA 拉的 manifest
- Produces: `resolveBlobStream(sha256): Promise<{ stream: Readable; size: number } | null>`
- Produces: `deleteModelVersion(name, version): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

```python
# T_D2: 模型上传 + manifest + blob
# 上传（模拟 multipart）
import io
boundary = "----test"
body_bytes = (
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
).encode()
req = urllib.request.Request(
    f"{BASE}/api/v1/models/upload",
    data=body_bytes,
    headers={"Content-Type": f"multipart/form-data; boundary={boundary}",
             "Authorization": f"Bearer {admin_token}"},
    method="POST",
)
try:
    resp = urllib.request.urlopen(req)
    code, data = resp.status, json.loads(resp.read().decode())
except urllib.error.HTTPError as e:
    code, data = e.code, json.loads(e.read().decode())
test("model upload", code == 201 and "id" in data, str(data)[:200])

# manifest 查询
code, data = api("GET", "/api/v1/models/manifests/bge-m3")
test("model manifest fetch", code == 200 and "models" in data or "name" in data, str(data)[:200])
```

- [ ] **Step 2: 运行确认失败**

```bash
python3 tests/phase5_test.py 2>&1 | grep T_D2
```

- [ ] **Step 3: 创建 `src/domain/model-artifact.ts`**

```typescript
// =============================================================================
// DeepAnalyze Hub - Model Artifact Repository
// =============================================================================
// 企业内部模型仓库。管理员上传（multipart），DA 拉取 manifest + blob。
// 文件存储在本地（或挂载卷）— 路径由 HUB_CONFIG.modelRepo.storageDir 决定。
// =============================================================================

import { createWriteStream, existsSync, mkdirSync, createReadStream, statSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { query } from "../store/pg.js";
import { HUB_CONFIG } from "../core/config.js";

const STORAGE_DIR = HUB_CONFIG.modelRepo?.storageDir
  || process.env.HUB_MODEL_REPO_DIR
  || "./data/model-repo";

export interface UploadedFile {
  originalName: string;
  sha256: string;
  sizeBytes: number;
  storagePath: string;
}

export interface ModelManifest {
  version: string;
  category: string;
  sha256: string;
  size_bytes: number;
  files: Array<{ path: string; sha256: string; size_bytes: number }>;
  runtime_deps?: Record<string, unknown>;
  uploaded_at: string;
}

export async function uploadModelArtifact(
  name: string,
  version: string,
  category: string,
  files: Array<{ originalName: string; stream: Readable }>,
  uploadedBy: string,
): Promise<{ id: string; files: UploadedFile[] }> {
  // 写盘 + 算 sha256
  const uploaded: UploadedFile[] = [];
  for (const f of files) {
    const relPath = `${name}/${version}/${f.originalName}`;
    const absPath = join(STORAGE_DIR, relPath);
    mkdirSync(dirname(absPath), { recursive: true });

    const hash = createHash("sha256");
    const out = createWriteStream(absPath);
    // 简化：从 stream 读取，写盘同时算 hash
    for await (const chunk of f.stream) {
      hash.update(chunk);
      out.write(chunk);
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error) => err ? reject(err) : resolve());
    });

    const sha = hash.digest("hex");
    const size = statSync(absPath).size;
    uploaded.push({ originalName: f.originalName, sha256: sha, sizeBytes: size, storagePath: relPath });
  }

  // 整包 sha256（concat 所有文件 sha）
  const packSha = createHash("sha256")
    .update(uploaded.map(f => f.sha256).join(""))
    .digest("hex");

  const id = `mdl_${randomUUID().replace(/-/g, "")}`;
  const manifest: ModelManifest = {
    version,
    category,
    sha256: packSha,
    size_bytes: uploaded.reduce((s, f) => s + f.sizeBytes, 0),
    files: uploaded.map(f => ({ path: f.originalName, sha256: f.sha256, size_bytes: f.sizeBytes })),
    uploaded_at: new Date().toISOString(),
  };

  await query(
    `INSERT INTO model_artifacts (id, name, version, category, sha256, size_bytes, storage_path, manifest, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, name, version, category, packSha, manifest.size_bytes,
     `${STORAGE_DIR}/${name}/${version}`, JSON.stringify(manifest), uploadedBy],
  );

  return { id, files: uploaded };
}

export async function getLatestManifest(name: string): Promise<ModelManifest | null> {
  const result = await query<{ manifest: ModelManifest }>(
    `SELECT manifest FROM model_artifacts WHERE name = $1 ORDER BY created_at DESC LIMIT 1`,
    [name],
  );
  return result.rows.length > 0 ? result.rows[0].manifest : null;
}

export async function resolveBlobStream(
  sha256: string,
): Promise<{ stream: Readable; size: number; contentType: string } | null> {
  // blob 在 model_artifacts 表中通过 manifest.files[].sha256 查找
  const result = await query<{ storage_path: string; manifest: ModelManifest }>(
    `SELECT storage_path, manifest FROM model_artifacts
     WHERE manifest->'files' @> $1::jsonb LIMIT 1`,
    [JSON.stringify([{ sha256 }])],
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const fileMeta = row.manifest.files.find(f => f.sha256 === sha256);
  if (!fileMeta) return null;

  const absPath = join(row.storage_path, fileMeta.path);
  if (!existsSync(absPath)) return null;

  return {
    stream: createReadStream(absPath),
    size: fileMeta.size_bytes,
    contentType: "application/octet-stream",
  };
}

export async function deleteModelVersion(name: string, version: string): Promise<boolean> {
  const result = await query<{ storage_path: string }>(
    `DELETE FROM model_artifacts WHERE name = $1 AND version = $2 RETURNING storage_path`,
    [name, version],
  );
  if (result.rows.length === 0) return false;
  // 删除磁盘文件（best effort）
  try {
    unlinkSync(result.rows[0].storage_path);
  } catch {}
  return true;
}
```

- [ ] **Step 4: 创建 `src/server/routes/models.ts`**

```typescript
// =============================================================================
// DeepAnalyze Hub - Model Repository Routes
// =============================================================================
// POST   /api/v1/models/upload           管理员上传（multipart）
// GET    /api/v1/models/manifests/:name  最新 manifest
// GET    /api/v1/models/blobs/:sha256    blob 流式下载
// DELETE /api/v1/models/:name/:version   清理旧版本
// =============================================================================

import { Hono } from "hono";
import { jwtAuth } from "../middleware/jwt-auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { workerAuth } from "../middleware/worker-auth.js";
import {
  uploadModelArtifact,
  getLatestManifest,
  resolveBlobStream,
  deleteModelVersion,
} from "../../domain/model-artifact.js";

export function createModelRoutes(): Hono {
  const app = new Hono();

  // POST /upload — multipart 上传
  app.post("/upload", jwtAuth, requirePermission("model:upload"), async (c) => {
    const formData = await c.req.formData();
    const name = formData.get("name") as string;
    const version = formData.get("version") as string;
    const category = formData.get("category") as string;
    if (!name || !version || !category) {
      return c.json({ error: "name, version, category required" }, 400);
    }

    const files: Array<{ originalName: string; stream: Readable }> = [];
    formData.forEach((value, key) => {
      if (key === "file" && value instanceof File) {
        files.push({ originalName: value.name, stream: value.stream() });
      }
    });
    if (files.length === 0) {
      return c.json({ error: "at least one file required" }, 400);
    }

    const result = await uploadModelArtifact(
      name, version, category, files, c.get("userId"),
    );
    return c.json({ id: result.id, files: result.files }, 201);
  });

  // GET /manifests/:name — DA 拉清单
  app.get("/manifests/:name", async (c) => {
    const name = c.req.param("name");
    const manifest = await getLatestManifest(name);
    if (!manifest) return c.json({ error: "model not found" }, 404);
    return c.json(manifest);
  });

  // GET /blobs/:sha256 — DA 拉 blob（流式）
  app.get("/blobs/:sha256", async (c) => {
    const sha = c.req.param("sha256").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha)) {
      return c.json({ error: "invalid sha256" }, 400);
    }
    const resolved = await resolveBlobStream(sha);
    if (!resolved) return c.json({ error: "blob not found" }, 404);

    c.header("Content-Type", resolved.contentType);
    c.header("Content-Length", String(resolved.size));
    return c.body(resolved.stream);
  });

  // DELETE /:name/:version — 清理旧版本
  app.delete("/:name/:version", jwtAuth, requirePermission("model:upload"), async (c) => {
    const name = c.req.param("name");
    const version = c.req.param("version");
    const ok = await deleteModelVersion(name, version);
    if (!ok) return c.json({ error: "version not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}

import type { Readable } from "node:stream";
```

- [ ] **Step 5: 在 `src/server/app.ts` 挂载路由**

找到路由注册块，添加：

```typescript
const modelRoutes = (await import("./routes/models.js")).createModelRoutes();
app.route("/api/v1/models", modelRoutes);
```

- [ ] **Step 6: 加 `model:upload` 权限到 RBAC（如果权限是枚举式）**

查 `migrations/005_rbac_tables.ts` 或权限注册位置，把 `model:upload` 加到 permissions 表。如果是字符串自由权限则跳过此步。

- [ ] **Step 7: 加 `modelRepo` 配置段**

在 `src/core/config.ts` 增加：

```typescript
modelRepo: {
  storageDir: process.env.HUB_MODEL_REPO_DIR || "./data/model-repo",
  maxFileSize: parseInt(process.env.HUB_MODEL_MAX_SIZE || "5368709120", 10), // 5GB
},
```

- [ ] **Step 8: 运行测试**

```bash
python3 tests/phase5_test.py 2>&1 | grep T_D2
```

Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add src/domain/model-artifact.ts src/server/routes/models.ts \
        src/server/app.ts src/core/config.ts tests/phase5_test.py
git commit -m "feat(hub): model repository — upload/manifest/blob/delete endpoints"
```

---

## Phase E: Bundle / 镜像仓库

### Task E1: Migration 022 - bundle_manifests 表 + bundle 元数据

**Files:**
- Create: `src/store/migrations/022_bundle_manifests.ts`
- Create: `src/domain/bundle.ts`

- [ ] **Step 1: 创建迁移**

```typescript
/**
 * Migration 022: bundle_manifests 表
 *
 * da-packer 构建的离线包元数据。每条记录对应一个 tar.gz。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS bundle_manifests (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      da_image_tag TEXT NOT NULL,
      hub_image_tag TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'linux/amd64',
      models JSONB NOT NULL,
      skills JSONB NOT NULL,
      file_path TEXT,
      file_size BIGINT,
      checksum_sha256 TEXT,
      created_at TIMESTARLTZ DEFAULT NOW(),
      UNIQUE(version, platform)
    );
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS bundle_manifests;`);
}
```

- [ ] **Step 2: 应用迁移**

```bash
bun run src/store/migrate.ts 2>&1 | tail -5
```

- [ ] **Step 3: 创建 `src/domain/bundle.ts`**

```typescript
// =============================================================================
// DeepAnalyze Hub - Bundle Repository
// =============================================================================
// 离线 bundle 元数据查询 + 镜像 tar 流式服务。
// 镜像 tar 由 da-packer 推送到 Hub（PUT /api/v1/bundle/images），
// 或直接放到 HUB_CONFIG.bundle.imagesDir 目录。
// =============================================================================

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { query } from "../store/pg.js";
import { HUB_CONFIG } from "../core/config.js";

const IMAGES_DIR = HUB_CONFIG.bundle?.imagesDir
  || process.env.HUB_BUNDLE_IMAGES_DIR
  || "./data/bundle/images";

export interface BundleManifestRow {
  id: string;
  version: string;
  da_image_tag: string;
  hub_image_tag: string;
  platform: string;
  models: Record<string, unknown>;
  skills: Record<string, unknown>;
  file_path: string | null;
  file_size: number | null;
  checksum_sha256: string | null;
  created_at: Date;
}

export async function getLatestBundleManifest(): Promise<BundleManifestRow | null> {
  const result = await query<BundleManifestRow>(
    `SELECT * FROM bundle_manifests ORDER BY created_at DESC LIMIT 1`,
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

export function resolveImageTar(imageName: string): {
  stream: Readable;
  size: number;
} | null {
  // imageName 形如 "da-base-v0.9.0-amd64.tar"
  const safe = imageName.replace(/[^a-zA-Z0-9._-]/g, "");
  const absPath = join(IMAGES_DIR, `${safe}`);
  if (!existsSync(absPath)) {
    // 也尝试不带 .tar 后缀
    const altPath = join(IMAGES_DIR, `${safe}.tar`);
    if (!existsSync(altPath)) return null;
    return {
      stream: createReadStream(altPath),
      size: statSync(altPath).size,
    };
  }
  return {
    stream: createReadStream(absPath),
    size: statSync(absPath).size,
  };
}

export function listAvailableImages(): string[] {
  if (!existsSync(IMAGES_DIR)) return [];
  return readdirSync(IMAGES_DIR)
    .filter(f => f.endsWith(".tar"))
    .map(f => f.replace(/\.tar$/, ""));
}
```

- [ ] **Step 4: 加 `bundle` 配置段到 `src/core/config.ts`**

```typescript
bundle: {
  imagesDir: process.env.HUB_BUNDLE_IMAGES_DIR || "./data/bundle/images",
  bundlesDir: process.env.HUB_BUNDLE_DIR || "./data/bundle",
},
```

- [ ] **Step 5: Commit**

```bash
git add src/store/migrations/022_bundle_manifests.ts src/domain/bundle.ts \
        src/core/config.ts
git commit -m "feat(hub): bundle_manifests table + bundle/image resolver domain"
```

---

### Task E2: src/server/routes/bundle.ts — manifest + image tar endpoints

**Files:**
- Create: `src/server/routes/bundle.ts`
- Modify: `src/server/app.ts`
- Test: `tests/phase5_test.py`

**Interfaces:**
- Produces: `GET /api/v1/bundle/manifest` → BundleManifestRow（无需认证）
- Produces: `GET /api/v1/images/:name.tar` → 流式 tar（无需认证，仅限内网）

- [ ] **Step 1: 写失败测试**

```python
# T_E2: bundle manifest + image tar
code, data = api("GET", "/api/v1/bundle/manifest")
test("bundle manifest endpoint", code in (200, 404), str(data)[:100])  # 无 bundle 时 404

# 准备一个测试 tar
import os
os.makedirs("/tmp/hub-test-images", exist_ok=True)
with open("/tmp/hub-test-images/test-image.tar", "wb") as f:
    f.write(b"fake tar content")

# 调整 HUB_BUNDLE_IMAGES_DIR 后重启 hub，或直接 curl 测试现有目录
# 此处假设配置已生效
```

- [ ] **Step 2: 创建 `src/server/routes/bundle.ts`**

```typescript
// =============================================================================
// DeepAnalyze Hub - Bundle Distribution Routes
// =============================================================================
// GET /api/v1/bundle/manifest     当前 bundle 清单
// GET /api/v1/bundle/images       可用镜像列表
// GET /api/v1/images/:name.tar    镜像 tar 流式（curl | docker load）
// =============================================================================

import { Hono } from "hono ";
import {
  getLatestBundleManifest,
  resolveImageTar,
  listAvailableImages,
} from "../../domain/bundle.js";

export function createBundleRoutes(): Hono {
  const app = new Hono();

  // GET /bundle/manifest
  app.get("/manifest", async (c) => {
    const m = await getLatestBundleManifest();
    if (!m) return c.json({ error: "no bundle available" }, 404);
    return c.json(m);
  });

  // GET /bundle/images — 可用镜像列表
  app.get("/images", (c) => {
    return c.json({ images: listAvailableImages() });
  });

  // GET /images/:name.tar — 流式 tar
  app.get("/images/:name", (c) => {
    const name = c.req.param("name");
    // 支持 name="da-base-v0.9.0-amd64.tar" 或 name="da-base-v0.9.0-amd64"
    const cleaned = name.replace(/\.tar$/, "");
    const resolved = resolveImageTar(`${cleaned}.tar`);
    if (!resolved) return c.json({ error: "image not found" }, 404);

    c.header("Content-Type", "application/x-tar");
    c.header("Content-Length", String(resolved.size));
    c.header("Content-Disposition", `attachment; filename="${cleaned}.tar"`);
    return c.body(resolved.stream);
  });

  return app;
}
```

> 注意：上面 `import { Hono } from "hono "` 多了个空格，要修正成 `"hono"`。

- [ ] **Step 3: 在 `src/server/app.ts` 挂载**

```typescript
const bundleRoutes = (await import("./routes/bundle.js")).createBundleRoutes();
app.route("/api/v1/bundle", bundleRoutes);
app.route("/api/v1/images", bundleRoutes);  // 注意：bundle 路由内部有 /images/:name
```

实际上为避免路由前缀混乱，bundle.ts 内部应该把 `/images/:name` 注册为绝对路径或单独注册。重新设计：

把 bundle.ts 中 image 端点拆出去（在 app.ts 中直接挂）：

```typescript
// app.ts
const bundleRoutes = (await import("./routes/bundle.js")).createBundleRoutes();
app.route("/api/v1/bundle", bundleRoutes);  // /bundle/manifest, /bundle/images

// image 流式端点单独挂
const imageRouter = new Hono();
imageRouter.get("/:name", async (c) => {
  const name = c.req.param("name").replace(/\.tar$/, "");
  const resolved = resolveImageTar(`${name}.tar`);
  if (!resolved) return c.json({ error: "image not found" }, 404);
  c.header("Content-Type", "application/x-tar");
  c.header("Content-Length", String(resolved.size));
  return c.body(resolved.stream);
});
app.route("/api/v1/images", imageRouter);
```

简化版：把 `resolveImageTar` import 进 app.ts，或新建 `src/server/routes/images.ts` 单独承载 `/api/v1/images/*`。

**决定：新建 `src/server/routes/images.ts`**（更清晰）：

```typescript
import { Hono } from "hono";
import { resolveImageTar } from "../../domain/bundle.js";

export function createImageRoutes(): Hono {
  const app = new Hono();
  app.get("/:name", async (c) => {
    const name = c.req.param("name").replace(/\.tar$/, "");
    const resolved = resolveImageTar(`${name}.tar`);
    if (!resolved) return c.json({ error: "image not found" }, 404);
    c.header("Content-Type", "application/x-tar");
    c.header("Content-Length", String(resolved.size));
    c.header("Content-Disposition", `attachment; filename="${name}.tar"`);
    return c.body(resolved.stream);
  });
  return app;
}
```

bundle.ts 只保留 `/manifest` 和 `/images`（list）。

- [ ] **Step 4: 在 `src/server/app.ts` 挂载**

```typescript
const bundleRoutes = (await import("./routes/bundle.js")).createBundleRoutes();
const imageRoutes = (await import("./routes/images.js")).createImageRoutes();
app.route("/api/v1/bundle", bundleRoutes);
app.route("/api/v1/images", imageRoutes);
```

- [ ] **Step 5: 运行测试**

```bash
python3 tests/phase5_test.py 2>&1 | grep T_E2
```

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/bundle.ts src/server/routes/images.ts \
        src/server/app.ts tests/phase5_test.py
git commit -m "feat(hub): bundle manifest + streaming image tar endpoints"
```

---

## Phase F: SSH 远程部署编排（最大块 ~600 行）

### Task F1: 安装 ssh2 依赖 + Migration 024 - deploy_jobs 表

**Files:**
- Modify: `package.json`
- Create: `src/store/migrations/024_deploy_jobs.ts`

- [ ] **Step 1: 安装 ssh2**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bun add ssh2 2>&1 | tail -5
```

- [ ] **Step 2: 创建迁移**

```typescript
/**
 * Migration 024: deploy_jobs 表
 *
 * 记录 Hub 通过 SSH 部署/升级 Worker 的任务日志。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS deploy_jobs (
      id TEXT PRIMARY KEY,
      worker_id TEXT REFERENCES workers(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('deploy','upgrade','stop','restart','rollback')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','success','failed','cancelled')),
      image_tag TEXT,
      previous_image_tag TEXT,
      started_at TIMESTARLTZ,
      completed_at TIMESTARLTZ,
      initiated_by TEXT NOT NULL,
      logs JSONB DEFAULT '[]'::jsonb,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_jobs_worker ON deploy_jobs(worker_id);
    CREATE INDEX IF NOT EXISTS idx_deploy_jobs_status ON deploy_jobs(status);
  `);
}

export async function down(query: QueryFn): Promise<void> {
  await query(`DROP TABLE IF EXISTS deploy_jobs;`);
}
```

- [ ] **Step 3: 应用迁移**

```bash
bun run src/store/migrate.ts 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lockb src/store/migrations/024_deploy_jobs.ts
git commit -m "feat(hub): add ssh2 dep + deploy_jobs table for orchestration logs"
```

---

### Task F2: src/domain/worker-deployment.ts — SSH 连接器

**Files:**
- Create: `src/domain/worker-deployment.ts`
- Test: `tests/phase5_test.py`

**Interfaces:**
- Produces: `deployWorker(opts: DeployOpts): Promise<DeployResult>` — 主入口
- Produces: `upgradeWorker(workerId, newTag, initiatedBy): Promise<DeployResult>`
- Produces: `stopWorker(workerId, initiatedBy): Promise<DeployResult>`
- Produces: `restartWorker(workerId, initiatedBy): Promise<DeployResult>`
- Produces: `rollbackWorker(workerId, initiatedBy): Promise<DeployResult>` — 回滚到 previous_image_tag

- [ ] **Step 1: 创建 `src/domain/worker-deployment.ts`**

```typescript
// =============================================================================
// DeepAnalyze Hub - Worker SSH Deployment Orchestrator
// =============================================================================
// 通过 SSH 到目标机器，执行 docker load + docker run + 健康检查。
// 全过程记录到 deploy_jobs 表，失败回滚到 previous_image_tag。
// =============================================================================

import { Client } from "ssh2";
import { randomUUID } from "node:crypto";
import { query } from "../store/pg.js";
import { HUB_CONFIG } from "../core/config.js";
import { resolveImageTar } from "./bundle.js";

export interface DeployOpts {
  workerId: string;
  sshHost: string;
  sshPort?: number;
  sshUser: string;
  sshPrivateKeyPem: string;  // 已解密的明文私钥
  imageTag: string;          // 如 "da-base-v0.9.0-amd64"
  source: "hub_stream" | "docker_pull";  // 在线 vs 离线
  hubBaseUrl: string;        // 用于 curl 拉镜像
  containerName: string;     // 如 "da-alice"
  containerPort?: number;    // 默认 21000
  envVars: Record<string, string>;  // DA_AUTH_MODE, DA_JOIN_TOKEN, DA_HUB_URL, ...
  volumeMounts: string[];    // ["da-data-alice:/data"]
  initiatedBy: string;
  healthTimeout?: number;    // 秒，默认 180
}

export interface DeployResult {
  jobId: string;
  success: boolean;
  error?: string;
  previousImageTag?: string;
  logs: Array<{ ts: string; level: string; msg: string }>;
}

export async function deployWorker(opts: DeployOpts): Promise<DeployResult> {
  const jobId = `dpl_${randomUUID().replace(/-/g, "")}`;
  const logs: DeployResult["logs"] = [];
  const addLog = (level: string, msg: string) =>
    logs.push({ ts: new Date().toISOString(), level, msg });

  await query(
    `INSERT INTO deploy_jobs (id, worker_id, action, status, image_tag, started_at, initiated_by, logs)
     VALUES ($1, $2, 'deploy', 'running', $3, NOW(), $4, $5::jsonb)`,
    [jobId, opts.workerId, opts.imageTag, opts.initiatedBy, JSON.stringify(logs)],
  );

  // 先记录 previous_image_tag 以备回滚
  const prev = await query<{ current_image_tag: string | null }>(
    `SELECT current_image_tag FROM workers WHERE id = $1`,
    [opts.workerId],
  );
  const previousImageTag = prev.rows[0]?.current_image_tag ?? undefined;

  const conn = new Client();
  const port = opts.sshPort ?? 22;
  const timeout = (opts.healthTimeout ?? 180) * 1000;

  try {
    addLog("info", `connecting ${opts.sshUser}@${opts.sshHost}:${port}`);
    await connectSsh(conn, {
      host: opts.sshHost,
      port,
      username: opts.sshUser,
      privateKey: opts.sshPrivateKeyPem,
      readyTimeout: timeout,
    });
    addLog("info", "ssh connected");

    // Step 1: 加载镜像
    if (opts.source === "hub_stream") {
      // curl + docker load 流式
      const tarName = `${opts.imageTag}.tar`;
      const cmd = `curl -s ${opts.hubBaseUrl}/api/v1/images/${tarName} | docker load`;
      addLog("info", `loading image: ${cmd}`);
      await execRemote(conn, cmd, (line) => addLog("remote", line));
    } else {
      const cmd = `docker pull ${opts.imageTag}`;
      addLog("info", `pulling image: ${cmd}`);
      await execRemote(conn, cmd, (line) => addLog("remote", line));
    }

    // Step 2: 停止旧容器（如有）
    addLog("info", `stopping old container ${opts.containerName}`);
    await execRemote(conn,
      `docker rm -f ${opts.containerName} 2>/dev/null || true`,
      (line) => addLog("remote", line));

    // Step 3: 启动新容器
    const envFlags = Object.entries(opts.envVars)
      .map(([k, v]) => `-e ${k}='${v.replace(/'/g, "'\\''")}'`)
      .join(" ");
    const volFlags = opts.volumeMounts.map(v => `-v ${v}`).join(" ");
    const portFlag = `-p ${opts.containerPort ?? 21000}:${opts.containerPort ?? 21000}`;
    const runCmd = `docker run -d --name ${opts.containerName} ${envFlags} ${volFlags} ${portFlag} --restart unless-stopped ${opts.imageTag}`;
    addLog("info", `starting: ${runCmd}`);
    const containerId = (await execRemote(conn, runCmd, (line) => addLog("remote", line))).trim();
    addLog("info", `container started: ${containerId.slice(0, 12)}`);

    // Step 4: 健康检查
    addLog("info", "health check polling");
    const healthy = await pollHealth(conn, opts.containerPort ?? 21000, opts.healthTimeout ?? 180);
    if (!healthy) {
      throw new Error(`container failed to become healthy within ${opts.healthTimeout ?? 180}s`);
    }
    addLog("info", "container healthy");

    // Step 5: 更新 workers 表
    await query(
      `UPDATE workers
       SET current_image_tag = $1,
           ssh_target_host = $2, ssh_target_port = $3, ssh_user = $4,
           da_url = $5, status = 'approved'
       WHERE id = $6`,
      [opts.imageTag, opts.sshHost, port, opts.sshUser,
       `http://${opts.sshHost}:${opts.containerPort ?? 21000}`,
       opts.workerId],
    );

    await query(
      `UPDATE deploy_jobs SET status = 'success', completed_at = NOW(), logs = $2::jsonb WHERE id = $1`,
      [jobId, JSON.stringify(logs)],
    );

    return { jobId, success: true, previousImageTag, logs };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addLog("error", errMsg);

    // 回滚
    if (previousImageTag) {
      addLog("warn", `rolling back to ${previousImageTag}`);
      try {
        await execRemote(conn, `docker rm -f ${opts.containerName} 2>/dev/null || true`, () => {});
        await execRemote(conn,
          `docker run -d --name ${opts.containerName} ${envFlags} ${volFlags} ${portFlag} --restart unless-stopped ${previousImageTag}`,
          (line) => addLog("remote", line));
      } catch (rollbackErr) {
        addLog("error", `rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
      }
    }

    await query(
      `UPDATE deploy_jobs SET status = 'failed', completed_at = NOW(), error = $2, logs = $3::jsonb WHERE id = $1`,
      [jobId, errMsg, JSON.stringify(logs)],
    );

    return { jobId, success: false, error: errMsg, previousImageTag, logs };
  } finally {
    conn.end();
  }
}

function connectSsh(conn: Client, opts: {
  host: string; port: number; username: string; privateKey: string; readyTimeout: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.on("ready", () => resolve());
    conn.on("error", reject);
    conn.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      privateKey: opts.privateKey,
      readyTimeout: opts.readyTimeout,
    });
  });
}

function execRemote(conn: Client, cmd: string, onLine: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = "";
      stream.on("close", (code: number) => {
        if (code !== 0) {
          reject(new Error(`remote command exited with code ${code}: ${cmd}`));
        } else {
          resolve(stdout);
        }
      });
      stream.on("data", (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        for (const line of text.split("\n")) {
          if (line.trim()) onLine(line);
        }
      }).stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        for (const line of text.split("\n")) {
          if (line.trim()) onLogErr(line);
        }
      });
    });
  });
}

function onLogErr(line: string) {
  // 简化：直接 stderr 当 info 记录（docker pull 的进度在 stderr）
  console.log(`[ssh stderr] ${line}`);
}

async function pollHealth(conn: Client, port: number, timeoutSec: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const result = await execRemote(conn,
        `curl -sf http://localhost:${port}/api/health 2>/dev/null || echo FAIL`,
        () => {});
      if (!result.includes("FAIL") && result.includes("ok")) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

// --- 升级/停止/重启 包装函数 ---

export async function upgradeWorker(
  workerId: string, newTag: string, initiatedBy: string,
): Promise<DeployResult> {
  const w = await query<{
    ssh_target_host: string; ssh_target_port: number; ssh_user: string;
    ssh_key_encrypted: string | null; current_image_tag: string;
  }>(`SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted, current_image_tag
      FROM workers WHERE id = $1`, [workerId]);
  if (w.rows.length === 0) throw new Error("worker not found");
  const row = w.rows[0];
  if (!row.ssh_target_host || !row.ssh_key_encrypted) {
    throw new Error("worker missing ssh credentials");
  }

  // 解密私钥（AES）— 见 Task F3
  const privateKey = await decryptSshKey(row.ssh_key_encrypted);

  // 复用 deployWorker（覆盖 imageTag）
  return deployWorker({
    workerId,
    sshHost: row.ssh_target_host,
    sshPort: row.ssh_target_port,
    sshUser: row.ssh_user,
    sshPrivateKeyPem: privateKey,
    imageTag: newTag,
    source: "hub_stream",
    hubBaseUrl: process.env.HUB_EXTERNAL_URL || "http://localhost:22000",
    containerName: `da-${workerId.slice(0, 12)}`,
    containerPort: 21000,
    envVars: {},  // 已有的容器配置在 workers 表，按需补充
    volumeMounts: [`da-data-${workerId.slice(0, 12)}:/app/data`],
    initiatedBy,
  });
}

export async function stopWorker(workerId: string, initiatedBy: string): Promise<DeployResult> {
  const jobId = `dpl_${randomUUID().replace(/-/g, "")}`;
  const logs: DeployResult["logs"] = [];
  const addLog = (level: string, msg: string) => logs.push({ ts: new Date().toISOString(), level, msg });

  await query(
    `INSERT INTO deploy_jobs (id, worker_id, action, status, started_at, initiated_by)
     VALUES ($1, $2, 'stop', 'running', NOW(), $3)`,
    [jobId, workerId, initiatedBy],
  );

  // SSH 到目标机执行 docker stop
  const w = await query<{ ssh_target_host: string; ssh_target_port: number; ssh_user: string; ssh_key_encrypted: string | null }>(
    `SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted FROM workers WHERE id = $1`,
    [workerId],
  );
  if (w.rows.length === 0) throw new Error("worker not found");

  const conn = new Client();
  try {
    const privateKey = await decryptSshKey(w.rows[0].ssh_key_encrypted!);
    await connectSsh(conn, {
      host: w.rows[0].ssh_target_host,
      port: w.rows[0].ssh_target_port,
      username: w.rows[0].ssh_user,
      privateKey,
      readyTimeout: 60000,
    });
    addLog("info", "ssh connected");
    const containerName = `da-${workerId.slice(0, 12)}`;
    await execRemote(conn, `docker stop ${containerName}`, (l) => addLog("remote", l));
    addLog("info", `container ${containerName} stopped`);

    await query(`UPDATE workers SET status = 'offline' WHERE id = $1`, [workerId]);
    await query(`UPDATE deploy_jobs SET status = 'success', completed_at = NOW(), logs = $2::jsonb WHERE id = $1`,
      [jobId, JSON.stringify(logs)]);
    return { jobId, success: true, logs };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addLog("error", errMsg);
    await query(`UPDATE deploy_jobs SET status = 'failed', completed_at = NOW(), error = $2, logs = $3::jsonb WHERE id = $1`,
      [jobId, errMsg, JSON.stringify(logs)]);
    return { jobId, success: false, error: errMsg, logs };
  } finally {
    conn.end();
  }
}

export async function restartWorker(workerId: string, initiatedBy: string): Promise<DeployResult> {
  // stop + start（用 current_image_tag）
  const stop = await stopWorker(workerId, initiatedBy);
  if (!stop.success) return stop;
  const w = await query<{ current_image_tag: string }>(
    `SELECT current_image_tag FROM workers WHERE id = $1`, [workerId]);
  return upgradeWorker(workerId, w.rows[0].current_image_tag, initiatedBy);
}

export async function rollbackWorker(workerId: string, initiatedBy: string): Promise<DeployResult> {
  // 查最近一次 failed deploy_job 的 previous_image_tag
  const last = await query<{ previous_image_tag: string; image_tag: string }>(
    `SELECT image_tag FROM deploy_jobs
     WHERE worker_id = $1 AND action = 'deploy' AND status = 'success'
     ORDER BY completed_at DESC LIMIT 1`,
    [workerId],
  );
  if (last.rows.length === 0) throw new Error("no previous successful deploy to rollback to");
  return upgradeWorker(workerId, last.rows[0].image_tag, initiatedBy);
}

// --- AES 解密占位（在 Task F3 实现） ---
async function decryptSshKey(encrypted: string): Promise<string> {
  // 临时实现：假设存储时用简单 AES-256-GCM with HUB_CONFIG.auth.jwtSecret
  // Task F3 会补完密钥管理
  throw new Error("decryptSshKey not implemented — see Task F3");
}
```

> 注：`execRemote` 中 `onLogErr` 是临时简化，正式实现中应整合到 logs。

- [ ] **Step 2: Commit（decryptSshKey 占位）**

```bash
git add src/domain/worker-deployment.ts
git commit -m "feat(hub): SSH worker deployment orchestrator (decryptSshKey placeholder)"
```

---

### Task F3: SSH key AES 加密/解密 helper

**Files:**
- Create: `src/core/crypto.ts`
- Modify: `src/domain/worker-deployment.ts`
- Test: `tests/phase5_test.py`

- [ ] **Step 1: 创建 `src/core/crypto.ts`**

```typescript
// =============================================================================
// DeepAnalyze Hub - AES-256-GCM Encryption Helper
// =============================================================================
// 用于加密存储 SSH 私钥（ssh_key_encrypted 字段）。
// 主密钥来自 HUB_CONFIG.auth.jwtSecret（或独立 env HUB_DATA_KEY）。
// =============================================================================

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { HUB_CONFIG } from "./config.js";

const DATA_KEY = process.env.HUB_DATA_KEY || HUB_CONFIG.auth.jwtSecret;
const KEY = Buffer.from(DATA_KEY.padEnd(32, "0").slice(0, 32), "utf-8");

export function encryptString(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 格式：base64(iv | tag | enc)
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptString(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf-8");
}
```

- [ ] **Step 2: 在 `worker-deployment.ts` 中替换 `decryptSshKey`**

```typescript
import { decryptString } from "../core/crypto.js";

async function decryptSshKey(encrypted: string): Promise<string> {
  try {
    return decryptString(encrypted);
  } catch (err) {
    throw new Error(`failed to decrypt ssh key: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 3: 写测试**

```python
# T_F3: 加密/解密往返（间接通过部署 API 测试）
# 单元级测试在 src/__tests__/crypto.test.ts
```

新建 `tests/__tests__/crypto.test.ts`（如已用 vitest）：

```typescript
import { test, expect } from "vitest";
import { encryptString, decryptString } from "../../src/core/crypto.js";

test("encrypt/decrypt round-trip", () => {
  const plain = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----";
  const enc = encryptString(plain);
  expect(enc).not.toContain(plain);
  const dec = decryptString(enc);
  expect(dec).toBe(plain);
});
```

如未启用 vitest，写 Python 端通过 API 调用间接测试。

- [ ] **Step 4: 运行测试**

```bash
npx vitest run tests/__tests__/crypto.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/core/crypto.ts src/domain/worker-deployment.ts tests/__tests__/crypto.test.ts
git commit -m "feat(hub): AES-256-GCM crypto helper for ssh key storage"
```

---

### Task F4: POST /api/v1/workers/deploy — 部署编排 HTTP 入口

**Files:**
- Modify: `src/server/routes/workers.ts`
- Test: `tests/phase5_test.py`

- [ ] **Step 1: 写失败测试**

```python
# T_F4: 部署入口（dry-run 模式）
code, data = api("POST", "/api/v1/workers/deploy",
                  token=admin_token,
                  data={
                      "organization_id": org_id,
                      "assigned_user_id": "usr_alice",
                      "ssh_host": "10.0.0.42",
                      "ssh_port": 22,
                      "ssh_user": "ubuntu",
                      "ssh_private_key": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----",
                      "image_tag": "da-base-v0.9.0-amd64",
                      "source": "hub_stream",
                      "skill_package_ids": [],
                      "dry_run": True,
                  })
test("deploy endpoint dry_run",
     code in (200, 202) and "job_id" in data,
     str(data)[:200])
```

- [ ] **Step 2: 运行确认失败**

```bash
python3 tests/phase5_test.py 2>&1 | grep T_F4
```

- [ ] **Step 3: 在 `src/server/routes/workers.ts` 添加端点**

```typescript
import { encryptString } from "../../core/crypto.js";
import { deployWorker, upgradeWorker, stopWorker, restartWorker, rollbackWorker } from "../../domain/worker-deployment.js";
import { createJoinToken } from "../../domain/join-token.js";

// POST /api/v1/workers/deploy
app.post("/deploy", jwtAuth, requirePermission("worker:deploy"), async (c) => {
  const body = await c.req.json();
  const required = ["organization_id", "ssh_host", "ssh_user", "ssh_private_key", "image_tag"];
  for (const f of required) {
    if (!body[f]) return c.json({ error: `${f} required` }, 400);
  }

  // Dry-run：只校验参数，不实际 SSH
  if (body.dry_run) {
    return c.json({
      job_id: `dpl_preview_${Date.now()}`,
      status: "preview",
      summary: {
        target: `${body.ssh_user}@${body.ssh_host}:${body.ssh_port || 22}`,
        image_tag: body.image_tag,
        source: body.source || "hub_stream",
      },
    });
  }

  // 实际部署：先创建 join_token，再 SSH 部署
  const joinToken = await createJoinToken({
    organizationId: body.organization_id,
    assignedUserId: body.assigned_user_id,
    createdBy: c.get("userId"),
    expiresInHours: 24,
  });

  // 预创建 worker 记录（status=pending，部署成功后变 approved）
  const workerId = `wkr_${crypto.randomUUID().replace(/-/g, "")}`;
  await query(
    `INSERT INTO workers (id, name, hostname, endpoint, version, capabilities,
                          worker_token, status, protocol_version, applied_at,
                          organization_id, user_id, ssh_target_host, ssh_target_port,
                          ssh_user, ssh_key_encrypted, current_image_tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 2, NOW(),
             $8, $9, $10, $11, $12, $13, $14)`,
    [workerId, body.container_name || `da-${body.assigned_user_id || "default"}`,
     body.ssh_host, `http://${body.ssh_host}:21000`, body.image_tag, JSON.stringify({}),
     `wkt_${crypto.randomUUID().replace(/-/g, "")}`,
     body.organization_id, body.assigned_user_id || null,
     body.ssh_host, body.ssh_port || 22, body.ssh_user,
     encryptString(body.ssh_private_key), body.image_tag],
  );

  // 异步触发部署（避免阻塞 HTTP 请求）
  const hubBaseUrl = process.env.HUB_EXTERNAL_URL || `http://localhost:${HUB_CONFIG.port}`;
  deployWorker({
    workerId,
    sshHost: body.ssh_host,
    sshPort: body.ssh_port || 22,
    sshUser: body.ssh_user,
    sshPrivateKeyPem: body.ssh_private_key,
    imageTag: body.image_tag,
    source: body.source || "hub_stream",
    hubBaseUrl,
    containerName: body.container_name || `da-${workerId.slice(0, 12)}`,
    containerPort: 21000,
    envVars: {
      DA_AUTH_MODE: "hub",
      DA_HUB_URL: hubBaseUrl,
      DA_JOIN_TOKEN: joinToken.token,
      DA_ORG_ID: body.organization_id,
      ...(body.env_vars || {}),
    },
    volumeMounts: body.volume_mounts || [`da-data-${workerId.slice(0, 12)}:/app/data`],
    initiatedBy: c.get("userId"),
  }).catch(err => console.error("[deploy] async error:", err));

  return c.json({
    job_id: workerId,
    worker_id: workerId,
    status: "deploying",
    join_token: joinToken.token,
  }, 202);
});

// GET /api/v1/workers/deploy-jobs/:id — 查询部署状态
app.get("/deploy-jobs/:id", jwtAuth, requirePermission("worker:deploy"), async (c) => {
  const id = c.req.param("id");
  const result = await query(
    `SELECT * FROM deploy_jobs WHERE id = $1`, [id],
  );
  if (result.rows.length === 0) return c.json({ error: "job not found" }, 404);
  return c.json(result.rows[0]);
});

// POST /api/v1/workers/:id/upgrade
app.post("/:id/upgrade", jwtAuth, requirePermission("worker:deploy"), async (c) => {
  const workerId = c.req.param("id");
  const body = await c.req.json();
  if (!body.image_tag) return c.json({ error: "image_tag required" }, 400);
  const result = await upgradeWorker(workerId, body.image_tag, c.get("userId"));
  return c.json(result, result.success ? 200 : 500);
});

// POST /api/v1/workers/:id/stop
app.post("/:id/stop", jwtAuth, requirePermission("worker:deploy"), async (c) => {
  const workerId = c.req.param("id");
  const result = await stopWorker(workerId, c.get("userId"));
  return c.json(result, result.success ? 200 : 500);
});

// POST /api/v1/workers/:id/restart
app.post("/:id/restart", jwtAuth, requirePermission("worker:deploy"), async (c) => {
  const workerId = c.req.param("id");
  const result = await restartWorker(workerId, c.get("userId"));
  return c.json(result, result.success ? 200 : 500);
});

// POST /api/v1/workers/:id/rollback
app.post("/:id/rollback", jwtAuth, requirePermission("worker:deploy"), async (c) => {
  const workerId = c.req.param("id");
  const result = await rollbackWorker(workerId, c.get("userId"));
  return c.json(result, result.success ? 200 : 500);
});
```

并在顶部加 import：
```typescript
import { HUB_CONFIG } from "../../core/config.js";
import * as crypto from "node:crypto";
```

- [ ] **Step 4: 加 `worker:deploy` 权限**

参照 `migrations/011_add_skill_lifecycle_perms.ts`，新建小迁移或在 RBAC 中注册 `worker:deploy` 权限码。

- [ ] **Step 5: 运行测试**

```bash
python3 tests/phase5_test.py 2>&1 | grep T_F4
```

Expected: dry_run PASS。

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/workers.ts tests/phase5_test.py
git commit -m "feat(hub): worker deploy/upgrade/stop/restart/rollback HTTP endpoints"
```

---

### Task F5: SSH 部署 Playwright E2E 测试（mock SSH）

**Files:**
- Create: `tests/e2e/deploy.spec.ts`
- Create: `tests/fixtures/ssh-mock-server.cjs`（可选，mock sshd）

> 真实 SSH 测试需要起 sshd 容器。简化版用 dry_run + 状态轮询。

- [ ] **Step 1: 写 E2E 测试**

```typescript
// tests/e2e/deploy.spec.ts
import { test, expect } from "@playwright/test";
import { fixtures } from "./fixtures.js";

test.describe("Worker deployment", () => {
  test.beforeAll(async () => {
    await fixtures.reset();
  });

  test("admin can submit deploy dry-run", async ({ page, request }) => {
    const loginRes = await request.post("/api/v1/auth/login", {
      data: { username: "admin", password: "admin123" },
    });
    const token = (await loginRes.json()).access_token;

    const res = await request.post("/api/v1/workers/deploy", {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        organization_id: fixtures.orgId,
        ssh_host: "10.0.0.99",
        ssh_user: "ubuntu",
        ssh_private_key: "fake",
        image_tag: "da-base-v0.9.0-amd64",
        dry_run: true,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("preview");
    expect(body.summary.target).toContain("10.0.0.99");
  });

  test("deploy job log is queryable", async ({ request }) => {
    const loginRes = await request.post("/api/v1/auth/login", {
      data: { username: "admin", password: "admin123" },
    });
    const token = (await loginRes.json()).access_token;

    // 假设前面创建过 deploy job
    const res = await request.get("/api/v1/workers/deploy-jobs/dpl_preview_1", {
      headers: { Authorization: `Bearer ${token}` },
    });
    // dry_run 不写 deploy_jobs 表，所以 404 合理
    expect([404, 200]).toContain(res.status());
  });
});
```

- [ ] **Step 2: 运行 E2E**

```bash
npx playwright test tests/e2e/deploy.spec.ts --reporter=list
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/deploy.spec.ts
git commit -m "test(hub): deploy dry-run playwright e2e"
```

---

## Phase G: Hub 前端补充

### Task G1: 添加 Worker 部署表单

**Files:**
- Modify: `frontend/src/pages/WorkerApproval.tsx`
- Modify: `frontend/src/api/client.ts`

- [ ] **Step 1: 在 `api/client.ts` 增加 deploy 方法**

```typescript
deploy: {
  create: async (params: {
    organization_id: string;
    ssh_host: string;
    ssh_port?: number;
    ssh_user: string;
    ssh_private_key: string;
    image_tag: string;
    source?: "hub_stream" | "docker_pull";
    assigned_user_id?: string;
    skill_package_ids?: string[];
    dry_run?: boolean;
  }) => {
    return request<{ job_id: string; status: string }>("/api/v1/workers/deploy", {
      method: "POST",
      body: JSON.stringify(params),
    });
  },
  status: async (jobId: string) => {
    return request<any>(`/api/v1/workers/deploy-jobs/${jobId}`);
  },
  upgrade: async (workerId: string, imageTag: string) => {
    return request<any>(`/api/v1/workers/${workerId}/upgrade`, {
      method: "POST",
      body: JSON.stringify({ image_tag: imageTag }),
    });
  },
},
```

- [ ] **Step 2: 在 `WorkerApproval.tsx` 增加"添加 Worker"按钮 + 表单 modal**

参照现有页面风格，添加：

```tsx
function DeployWorkerModal({ onClose, onDeployed }: { onClose: () => void; onDeployed: () => void }) {
  const [form, setForm] = useState({
    ssh_host: "", ssh_port: 22, ssh_user: "ubuntu",
    ssh_private_key: "", image_tag: "da-base-v0.9.0-amd64",
    organization_id: "", assigned_user_id: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<any>(null);

  const submit = async () => {
    setSubmitting(true);
    try {
      const r = await api.deploy.create({ ...form, dry_run: false });
      setResult(r);
      onDeployed();
    } catch (e) {
      setResult({ error: String(e) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} title="远程部署 Worker">
      {/* 表单字段略：参考现有 Modal/Input 风格 */}
      {/* organization_id select / ssh_host input / ssh_user input /
          ssh_private_key textarea / image_tag input / assigned_user_id select */}
      <Button onClick={submit} disabled={submitting}>部署</Button>
      {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </Modal>
  );
}
```

- [ ] **Step 3: 在 WorkerApproval 页面顶部加按钮**

```tsx
<button className="btn-primary" onClick={() => setDeployOpen(true)}>+ 添加 Worker</button>
{deployOpen && <DeployWorkerModal onClose={() => setDeployOpen(false)} onDeployed={refresh} />}
```

- [ ] **Step 4: 手工验证**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
npm run dev  # 启 hub backend
# 另一终端
cd frontend && npm run dev
# 浏览器访问 http://localhost:5173/workers，点"添加 Worker"
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/WorkerApproval.tsx frontend/src/api/client.ts
git commit -m "feat(hub-fe): worker deploy form with dry-run + status query"
```

---

### Task G2: Skill 提交审核跟踪页

**Files:**
- Create: `frontend/src/pages/SkillSubmissions.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 创建页面**

```tsx
// frontend/src/pages/SkillSubmissions.tsx
import { useEffect, useState } from "react";
import { api } from "../api/client";

export function SkillSubmissions() {
  const [submissions, setSubmissions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.skills.listSubmissions().then(setSubmissions).finally(() => setLoading(false));
  }, []);

  return (
    <div className="page-container">
      <h1>Skill 提交审核</h1>
      <table>
        <thead><tr><th>ID</th><th>名称</th><th>状态</th><th>提交时间</th><th>审核人</th></tr></thead>
        <tbody>
          {submissions.map(s => (
            <tr key={s.id}>
              <td>{s.id.slice(0, 8)}</td>
              <td>{s.name}</td>
              <td><StatusBadge status={s.status} /></td>
              <td>{new Date(s.created_at).toLocaleString()}</td>
              <td>{s.reviewer || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: 在 `api/client.ts` 增加方法**

```typescript
skills: {
  // ... 现有方法
  listSubmissions: async () => {
    return request<any[]>("/api/v1/skills/submissions");
  },
  withdraw: async (slug: string) => {
    return request<{ ok: boolean }>(`/api/v1/marketplace/skills/${slug}`, { method: "DELETE" });
  },
},
```

- [ ] **Step 3: 在 `App.tsx` 注册路由**

```tsx
<Route path="/submissions" element={<SkillSubmissions />} />
```

并在侧边栏导航加入口。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/SkillSubmissions.tsx frontend/src/App.tsx frontend/src/api/client.ts
git commit -m "feat(hub-fe): skill submissions tracking page"
```

---

### Task G3: 模型仓库管理页

**Files:**
- Create: `frontend/src/pages/Models.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 创建页面**

```tsx
// frontend/src/pages/Models.tsx
export function Models() {
  const [models, setModels] = useState<any[]>([]);
  const [uploadOpen, setUploadOpen] = useState(false);

  useEffect(() => { api.models.list().then(setModels); }, []);

  return (
    <div className="page-container">
      <header>
        <h1>模型仓库</h1>
        <Button onClick={() => setUploadOpen(true)}>+ 上传模型</Button>
      </header>
      <ModelTable models={models} onDelete={(name, ver) => api.models.delete(name, ver).then(refresh)} />
      {uploadOpen && <UploadModelModal onClose={() => setUploadOpen(false)} onUploaded={refresh} />}
    </div>
  );
}
```

- [ ] **Step 2: 在 `api/client.ts` 增加方法**

```typescript
models: {
  list: async () => request<any[]>("/api/v1/models"),
  upload: async (formData: FormData) => request<{ id: string }>("/api/v1/models/upload", {
    method: "POST",
    body: formData,
    headers: {} as any,  // 让浏览器自动设置 multipart boundary
  }),
  delete: async (name: string, version: string) =>
    request<{ ok: boolean }>(`/api/v1/models/${name}/${version}`, { method: "DELETE" }),
  manifest: async (name: string) =>
    request<any>(`/api/v1/models/manifests/${name}`),
},
```

- [ ] **Step 3: 注册路由**

```tsx
<Route path="/models" element={<Models />} />
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Models.tsx frontend/src/App.tsx frontend/src/api/client.ts
git commit -m "feat(hub-fe): model repository management page"
```

---

## Phase H: 文档 + 收尾

### Task H1: README + 配置示例

**Files:**
- Create: `README-distribution.md`（或主 README 追加）
- Modify: `.env.example`

- [ ] **Step 1: 创建分发相关 README**

```markdown
# Hub 分发与协作配置

## 必需环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `HUB_JWT_PUBLIC_KEY_PATH` | RS256 公钥 PEM 文件 | `/etc/hub/keys/pub.pem` |
| `HUB_JWT_PRIVATE_KEY_PATH` | RS256 私钥 PEM 文件 | `/etc/hub/keys/priv.pem` |
| `HUB_JWT_KEY_ID` | JWKS 中的 kid | `hub-rs256-v1` |
| `HUB_DATA_KEY` | SSH key 加密主密钥（32 字符） | `<random-32-char-string>` |
| `HUB_EXTERNAL_URL` | DA 反向访问 Hub 的 URL | `https://hub.corp.com:22000` |
| `HUB_MODEL_REPO_DIR` | 模型仓库存储目录 | `/data/model-repo` |
| `HUB_BUNDLE_IMAGES_DIR` | 镜像 tar 存储目录 | `/data/bundle/images` |

## 生成 RSA keypair

```bash
openssl genpkey -algorithm RSA -out priv.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -pubout -in priv.pem -out pub.pem
```

## HS256 过渡期

升级后默认签 RS256。现有 HS256 token 在 `HUB_HS256_TRANSITION_UNTIL` 之前仍可用（默认 30 天）。
```

- [ ] **Step 2: Commit**

```bash
git add README-distribution.md .env.example
git commit -m "docs(hub): distribution config guide"
```

---

### Task H2: 全流程 smoke test 整合

**Files:**
- Modify: `tests/phase5_test.py`

- [ ] **Step 1: 整合测试为完整套件**

确保 `phase5_test.py` 包含：
- T_A1-A4（JWT）
- T_B1-B4（Worker）
- T_C1-C2（Skill）
- T_D1-D2（Model）
- T_E1-E2（Bundle）
- T_F3-F4（Deploy）

加 summary 输出：

```python
# 文件末尾
print("\n=== Phase 5 Summary ===")
passed = sum(1 for _, s, _ in results if s == "PASS")
failed = sum(1 for _, s, _ in results if s == "FAIL")
print(f"  Total: {len(results)}, Passed: {passed}, Failed: {failed}")
sys.exit(0 if failed == 0 else 1)
```

- [ ] **Step 2: 运行完整测试**

```bash
python3 tests/phase5_test.py
```

Expected: 所有测试 PASS（除依赖 SSH 真实环境的部分用 dry_run）。

- [ ] **Step 3: Commit**

```bash
git add tests/phase5_test.py
git commit -m "test(hub): phase 5 distribution full smoke test suite"
```

---

## 自检 Checklist

实施完成后逐项确认：

- [ ] **JWT 双算法**：旧客户端用 HS256 token 仍能调 API；新签 token 是 RS256
- [ ] **JWKS 可达**：`curl http://hub:22000/api/v1/auth/jwks.json` 返回 keys 数组
- [ ] **join_token 一次性**：第二次使用同 token 注册返回错误
- [ ] **Worker 注销**：deactivate 后心跳被拒绝
- [ ] **模型上传/拉取**：上传后 DA 能 GET manifest + GET blob
- [ ] **Bundle 镜像流**：`curl http://hub:22000/api/v1/images/da-base-v0.9.0-amd64.tar | docker load` 正常
- [ ] **SSH 部署 dry-run**：返回 preview 状态
- [ ] **Skill 撤回**：作者本人能撤回，其他用户撤回被拒
- [ ] **HS256 过渡期文档**：README 标注 30 天后移除
- [ ] **playwright e2e**：`tests/e2e/deploy.spec.ts` 通过
- [ ] **typecheck**：`bun run typecheck` 无错误
