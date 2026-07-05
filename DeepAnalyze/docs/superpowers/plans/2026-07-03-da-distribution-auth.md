# DA 分发与认证改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DA 从"零认证单租户"升级为"三模式可认证（none/local/hub）+ 安装向导 + 模型按需下载 + Hub 代理登录"的个人 Agent 系统。永不引入多租户——隔离靠容器。

**Architecture:** 新增 5 个核心模块（auth middleware / ModelDownloader / ModelServiceSupervisor / install wizard / HubClient auth extensions），改造 Dockerfile 为 base+full 两档。所有改造通过 `DA_AUTH_MODE` 环境变量门控，未设置时行为完全等于现状（向下兼容）。

**Tech Stack:** TypeScript + Hono + React + jose (JWT/JWKS) + bcrypt + ws + commander / @clack/prompts

## Global Constraints

- **向下兼容铁律**：`DA_AUTH_MODE` 未设置 → `none` 模式 → 行为完全等于现状；`data/config.yaml` 存在 → 跳过向导
- **DA 永远单租户**：不加 users 表、不加 RBAC、不加 audit_logs；认证只用于"显示谁登录了"
- **密码永不存明文**：local 模式存 bcrypt hash；hub 模式永不存密码，只缓存 JWKS 公钥
- **所有新文件英文路径**：`src/server/middleware/auth.ts`、`src/services/model-downloader.ts`、`src/setup/wizard.ts`
- **测试**：每个模块至少 1 个 `tests/*.test.ts`（vitest）；端到端流程用 Playwright `tests/e2e/`
- **配置加载优先级**：环境变量 DA_* > data/config.yaml > 内置 default
- **语言**：所有文档中文优先；代码注释英文或中文一致即可
- **复用现有基础设施**：复用 `src/store/repos/settings.ts` 写 settings KV；复用 `global.__hubClient` 模式

---

## File Structure

| 文件 | 操作 | 责任 |
|------|------|------|
| `src/server/middleware/auth.ts` | 新建 | 唯一认证中间件（none/local/hub 三分支） |
| `src/server/middleware/index.ts` | 修改 | 导出 authMiddleware |
| `src/server/app.ts` | 修改 | 注册 authMiddleware（在 requestLogger 之后） |
| `src/services/auth/local-idp.ts` | 新建 | mini-IdP：bcrypt 校验 + 本地 RS256 签名 |
| `src/services/auth/hub-jwks.ts` | 新建 | Hub JWKS 公钥拉取 + 6h 刷新 + 离线缓存 |
| `src/services/auth/jwt-utils.ts` | 新建 | parseJwtHeader / extractBearer / verifyLocalJwt |
| `src/services/auth/recovery.ts` | 新建 | emergency-reset 命令实现 |
| `src/server/routes/auth.ts` | 新建 | `/api/auth/login` `/setup` `/me` `/logout` |
| `src/services/model-downloader.ts` | 新建 | 多源下载 + sha256 + 断点续传 |
| `src/services/model-manifest.ts` | 新建 | da-assets/manifest.json 加载与版本对比 |
| `src/server/model-supervisor.ts` | 新建 | 子服务编排（embedding/whisper/docling/paddleocr） |
| `src/setup/wizard.ts` | 新建 | 6 阶段状态机 |
| `src/setup/web-wizard-routes.ts` | 新建 | Web 向导 HTTP 路由 `/setup/*` |
| `src/setup/cli-wizard.ts` | 新建 | CLI 向导 (@clack/prompts) |
| `src/setup/environment.ts` | 新建 | Phase 1 环境检测（CPU/RAM/GPU/网络） |
| `src/services/hub/hub-client.ts` | 修改 | 新增 JWKS sync / login proxy / model fetch / deactivate |
| `src/server/routes/settings.ts` | 修改 | 新增 `/api/settings/auth` `/api/settings/hub` |
| `src/core/config.ts` | 修改 | 新增 `authMode` / `hubUrl` / `joinToken` 字段 |
| `da-assets/manifest.json` | 新建 | 模型清单（5 个模型） |
| `da-assets/default-config.yaml` | 新建 | 向导产出的默认配置模板 |
| `frontend/src/components/auth/LoginPage.tsx` | 新建 | 登录页 |
| `frontend/src/components/auth/SetupWizard.tsx` | 新建 | 6 步骤向导 UI |
| `frontend/src/components/settings/AuthPanel.tsx` | 新建 | 认证设置面板 |
| `frontend/src/components/settings/HubConnectionPanel.tsx` | 新建 | Hub 连接管理 |
| `frontend/src/router.tsx` | 修改 | 新增 `/login` `/setup` 路由 |
| `frontend/src/api/client.ts` | 修改 | 增加 auth/setup API 客户端 |
| `frontend/src/components/layout/SystemStatusBanner.tsx` | 修改 | 显示子服务状态（绿/黄/红/灰） |
| `Dockerfile.base` | 新建 | ~500MB 基础镜像（无 ML 库） |
| `Dockerfile.full` | 新建 | extends base + torch/onnx/whisper/docling + 权重 |
| `Dockerfile` | 修改 | 默认指向 Dockerfile.base |
| `docker-compose.yml` | 修改 | 默认用 base 镜像 |
| `src/setup/emergency-reset.ts` | 新建 | CLI 子命令 `da admin emergency-reset` |
| `package.json` | 修改 | 新增 `bcryptjs` `jose` `@clack/prompts` `react-router-dom` 等依赖 |
| `tests/auth.test.ts` | 新建 | 认证中间件单元测试 |
| `tests/model-downloader.test.ts` | 新建 | 下载器单元测试（mock HTTP） |
| `tests/model-supervisor.test.ts` | 新建 | 子服务编排测试 |
| `tests/wizard.test.ts` | 新建 | 向导状态机测试 |
| `tests/e2e/setup-wizard.spec.ts` | 新建 | 向导 E2E |
| `tests/e2e/auth-flow.spec.ts` | 新建 | 登录流程 E2E |

---

## Phase A: 认证中间件（核心，必须最先做）

### Task A1: 创建 auth middleware scaffold（none 模式）

**Files:**
- Create: `src/server/middleware/auth.ts`
- Modify: `src/server/middleware/index.ts`
- Modify: `src/server/app.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- Produces: `authMiddleware(ctx, next): Promise<void>` — 全局中间件
- Produces: `getAuthMode(): "none" | "local" | "hub"` — 启动时由 `DA_AUTH_MODE` 决定
- Produces: `ctx.user` 形状：`{ id: string; name: string; source: "anonymous" | "local" | "hub" }`

- [ ] **Step 1: 写失败测试**

`tests/auth.test.ts`：

```typescript
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { authMiddleware, getAuthMode } from "../src/server/middleware/auth.js";

describe("authMiddleware - none mode", () => {
  let originalMode: string | undefined;

  beforeEach(() => {
    originalMode = process.env.DA_AUTH_MODE;
    delete process.env.DA_AUTH_MODE;
  });

  afterEach(() => {
    if (originalMode !== undefined) process.env.DA_AUTH_MODE = originalMode;
    else delete process.env.DA_AUTH_MODE;
  });

  test("none mode sets ctx.user to default-user", async () => {
    const app = new Hono();
    app.use("*", authMiddleware);
    app.get("/test", (c) => c.json({ user: c.get("user") }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toEqual({
      id: "default-user",
      name: "anonymous",
      source: "anonymous",
    });
  });

  test("getAuthMode returns none when env unset", () => {
    expect(getAuthMode()).toBe("none");
  });

  test("getAuthMode returns explicit value when env set", () => {
    process.env.DA_AUTH_MODE = "local";
    expect(getAuthMode()).toBe("local");
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
npx vitest run tests/auth.test.ts 2>&1 | tail -10
```

Expected: FAIL — `auth.ts` 模块不存在。

- [ ] **Step 3: 创建 `src/server/middleware/auth.ts`**

```typescript
// =============================================================================
// DeepAnalyze - Auth Middleware
// =============================================================================
// 三模式认证中间件（none / local / hub）。
// none: 完全跳过（默认，向后兼容）
// local: DA 自签 JWT，bcrypt 校验密码
// hub: 代理 Hub 登录 + JWKS 公钥本地验签
// =============================================================================

import type { MiddlewareHandler } from "hono";

export type AuthMode = "none" | "local" | "hub";

export interface AuthUser {
  id: string;
  name: string;
  source: "anonymous" | "local" | "hub";
  orgId?: string;
}

// 启动时决定（运行时不变）
let cachedMode: AuthMode | null = null;

export function getAuthMode(): AuthMode {
  if (cachedMode) return cachedMode;
  const raw = (process.env.DA_AUTH_MODE || "none").toLowerCase();
  cachedMode = (raw === "local" || raw === "hub") ? raw : "none";
  return cachedMode;
}

// 用于测试重置
export function _resetAuthModeCache(): void {
  cachedMode = null;
}

export const authMiddleware: MiddlewareHandler<{
  Variables: { user: AuthUser };
}> = async (c, next) => {
  const mode = getAuthMode();

  if (mode === "none") {
    c.set("user", { id: "default-user", name: "anonymous", source: "anonymous" });
    return next();
  }

  // local / hub：解析 Bearer token
  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  if (!token) {
    return c.json({ error: "unauthorized", message: "missing bearer token" }, 401);
  }

  try {
    const user = await verifyToken(token, mode);
    if (!user) {
      return c.json({ error: "invalid_token" }, 401);
    }
    c.set("user", user);
    await next();
  } catch (err) {
    return c.json({
      error: "token_verification_failed",
      message: err instanceof Error ? err.message : String(err),
    }, 401);
  }
};

// 占位：在 Task A2 / A3 实现具体逻辑
async function verifyToken(token: string, mode: AuthMode): Promise<AuthUser | null> {
  // A2: local 模式 → verifyLocalJwt
  // A3: hub 模式 → verifyHubJwt
  return null;
}
```

- [ ] **Step 4: 修改 `src/server/middleware/index.ts` 导出**

```typescript
export { errorHandler, requestLogger } from "./index.js";
export { authMiddleware, getAuthMode, type AuthMode, type AuthUser } from "./auth.js";
```

> 注意：原 `errorHandler` 和 `requestLogger` 直接定义在 `index.ts` 中。修改时仅追加 auth 导出。

- [ ] **Step 5: 修改 `src/server/app.ts` 注册**

在 `app.use("*", cors())` 之后加：

```typescript
import { authMiddleware } from "./middleware/auth.js";
// ...
app.use("*", cors());
app.use("*", authMiddleware);  // 新增
```

- [ ] **Step 6: 运行测试**

```bash
npx vitest run tests/auth.test.ts 2>&1 | tail -20
```

Expected: 3 个 none 模式测试 PASS。

- [ ] **Step 7: 启动 DA 验证不破坏现有功能**

```bash
python3 start.py --no-docker --skip-frontend --port 21000 &
sleep 3
curl -s http://localhost:21000/api/health
curl -s http://localhost:21000/api/sessions  # 应仍然能访问（none 模式）
```

- [ ] **Step 8: Commit**

```bash
git add src/server/middleware/auth.ts src/server/middleware/index.ts \
        src/server/app.ts tests/auth.test.ts
git commit -m "feat(da): add auth middleware scaffold (none mode) wired into app"
```

---

### Task A2: local 模式 — bcrypt + 本地 RS256 签名/验签

**Files:**
- Create: `src/services/auth/local-idp.ts`
- Create: `src/services/auth/jwt-utils.ts`
- Modify: `src/server/middleware/auth.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- Produces: `signLocalJwt(userId, name): Promise<string>`
- Produces: `verifyLocalJwt(token): Promise<AuthUser | null>`
- Produces: `hashPassword(plain): Promise<string>` — bcrypt
- Produces: `verifyPassword(plain, hash): Promise<boolean>`
- Produces: `ensureLocalKeypair(): Promise<void>` — 启动时从 `data/auth/da-key.pem` 加载或生成

- [ ] **Step 1: 安装依赖**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
bun add bcryptjs jose 2>&1 | tail -3
bun add -D @types/bcryptjs 2>&1 | tail -3
```

- [ ] **Step 2: 写失败测试**

在 `tests/auth.test.ts` 追加：

```typescript
import { signLocalJwt, verifyLocalJwt, hashPassword, verifyPassword } from "../src/services/auth/local-idp.js";

describe("authMiddleware - local mode", () => {
  beforeEach(() => {
    process.env.DA_AUTH_MODE = "local";
  });

  test("hashPassword and verifyPassword round-trip", async () => {
    const hash = await hashPassword("test-pass-123");
    expect(hash).not.toBe("test-pass-123");
    expect(await verifyPassword("test-pass-123", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  test("sign and verify local JWT", async () => {
    const token = await signLocalJwt("usr-admin", "admin");
    expect(token.split(".")).toHaveLength(3);

    const user = await verifyLocalJwt(token);
    expect(user).not.toBeNull();
    expect(user?.id).toBe("usr-admin");
    expect(user?.name).toBe("admin");
    expect(user?.source).toBe("local");
  });

  test("middleware rejects missing token in local mode", async () => {
    const app = new Hono();
    app.use("*", authMiddleware);
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(401);
  });

  test("middleware accepts valid local token", async () => {
    const token = await signLocalJwt("usr-admin", "admin");

    const app = new Hono();
    app.use("*", authMiddleware);
    app.get("/test", (c) => c.json({ user: c.get("user") }));

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe("usr-admin");
  });
});
```

- [ ] **Step 3: 运行确认失败**

```bash
npx vitest run tests/auth.test.ts 2>&1 | grep -E "(local|FAIL)"
```

- [ ] **Step 4: 创建 `src/services/auth/jwt-utils.ts`**

```typescript
// =============================================================================
// DeepAnalyze - JWT Utility
// =============================================================================

export function extractBearer(authHeader: string): string | null {
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
}

export function parseJwtHeader(token: string): {
  alg: string;
  kid?: string;
  iss?: string;
} | null {
  try {
    const part = token.split(".")[0];
    if (!part) return null;
    const padded = part + "=".repeat((4 - part.length % 4) % 4);
    const json = Buffer.from(padded, "base64url").toString("utf-8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: 创建 `src/services/auth/local-idp.ts`**

```typescript
// =============================================================================
// DeepAnalyze - Local mini-IdP
// =============================================================================
// local 模式：DA 自管账号 + bcrypt 密码 + 本地 RS256 JWT。
// 私钥存 data/auth/da-key.pem，公钥存 data/auth/da-pub.pem。
// =============================================================================

import bcrypt from "bcryptjs";
import { generateKeyPairSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:crypto";
import { join, resolve } from "node:path";
import { SignJWT, jwtVerify, importSPKI } from "jose";
import { getRepos } from "../../store/repos/index.js";

const ALG = "RS256";
const KID = "da-local-v1";
const ISSUER = "da-local";

let cachedPrivateKey: CryptoKey | null = null;
let cachedPublicKey: CryptoKey | null = null;

function getAuthDir(): string {
  return process.env.DA_AUTH_DIR || resolve(process.cwd(), "data/auth");
}

export async function ensureLocalKeypair(): Promise<void> {
  if (cachedPrivateKey && cachedPublicKey) return;

  const authDir = getAuthDir();
  const keyPath = join(authDir, "da-key.pem");
  const pubPath = join(authDir, "da-pub.pem");

  if (!existsSync(keyPath) || !existsSync(pubPath)) {
    // 生成新 keypair
    mkdirSync(authDir, { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    writeFileSync(keyPath, privPem, { mode: 0o600 });
    writeFileSync(pubPath, pubPem, { mode: 0o644 });

    cachedPrivateKey = await crypto.subtle.importKey(
      "pkcs8", Buffer.from(privPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"],
    );
    cachedPublicKey = await importSPKI(pubPem, ALG);
    return;
  }

  // 加载已存在 keypair
  const privPem = readFileSync(keyPath, "utf-8");
  const pubPem = readFileSync(pubPath, "utf-8");
  cachedPrivateKey = await crypto.subtle.importKey(
    "pkcs8", Buffer.from(privPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"],
  );
  cachedPublicKey = await importSPKI(pubPem, ALG);
}

export async function signLocalJwt(userId: string, name: string): Promise<string> {
  await ensureLocalKeypair();
  return new SignJWT({ name, source: "local" })
    .setProtectedHeader({ alg: ALG, kid: KID })
    .setIssuer(ISSUER)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(cachedPrivateKey!);
}

export async function verifyLocalJwt(token: string): Promise<{
  id: string;
  name: string;
  source: "local";
} | null> {
  try {
    await ensureLocalKeypair();
    const { payload } = await jwtVerify(token, cachedPublicKey!, {
      issuer: ISSUER,
      algorithms: [ALG],
    });
    if (payload.sub == null) return null;
    return {
      id: payload.sub,
      name: (payload.name as string) ?? "unknown",
      source: "local",
    };
  } catch {
    return null;
  }
}

// --- bcrypt 密码 ---

const BCRYPT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
```

- [ ] **Step 6: 在 `src/server/middleware/auth.ts` 中实现 `verifyToken`**

替换占位：

```typescript
import { verifyLocalJwt } from "../../services/auth/local-idp.js";
import { verifyHubJwt } from "../../services/auth/hub-jwks.js";  // 占位，A3 实现
import { parseJwtHeader, extractBearer } from "../../services/auth/jwt-utils.js";

async function verifyToken(token: string, mode: AuthMode): Promise<AuthUser | null> {
  if (mode === "local") {
    const u = await verifyLocalJwt(token);
    return u ? { id: u.id, name: u.name, source: "local" } : null;
  }
  if (mode === "hub") {
    const u = await verifyHubJwt(token);
    return u ? { id: u.id, name: u.name, source: "hub", orgId: u.orgId } : null;
  }
  return null;
}
```

> 注：先 import 占位，A3 创建 `hub-jwks.ts` 后即可编译。

为避免 A3 未完成时编译失败，临时简化为只调 local 分支：

```typescript
async function verifyToken(token: string, mode: AuthMode): Promise<AuthUser | null> {
  if (mode === "local") {
    const u = await verifyLocalJwt(token);
    return u ? { id: u.id, name: u.name, source: "local" } : null;
  }
  // hub mode: A3 实现
  if (mode === "hub") {
    throw new Error("hub mode not yet implemented (Task A3)");
  }
  return null;
}
```

- [ ] **Step 7: 运行测试**

```bash
npx vitest run tests/auth.test.ts 2>&1 | tail -20
```

Expected: local 模式所有测试 PASS。

- [ ] **Step 8: Commit**

```bash
git add src/services/auth/local-idp.ts src/services/auth/jwt-utils.ts \
        src/server/middleware/auth.ts tests/auth.test.ts package.json
git commit -m "feat(da): local auth mode — bcrypt password + RS256 JWT signing/verify"
```

---

### Task A3: hub 模式 — JWKS 公钥同步 + Hub JWT 验签

**Files:**
- Create: `src/services/auth/hub-jwks.ts`
- Modify: `src/server/middleware/auth.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- Produces: `verifyHubJwt(token): Promise<AuthUser | null>` — 用缓存 JWKS 公钥本地验签
- Produces: `refreshHubJwks(): Promise<void>` — 启动时拉 + 每 6h 刷新
- Produces: `getHubLoginProxy(): (creds) => Promise<{ access_token: string } | null>` — 代理 Hub `/api/v1/auth/login`

- [ ] **Step 1: 写失败测试**

```typescript
import { refreshHubJwks, verifyHubJwt } from "../src/services/auth/hub-jwks.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

describe("authMiddleware - hub mode", () => {
  beforeEach(() => {
    process.env.DA_AUTH_MODE = "hub";
    process.env.DA_HUB_URL = "http://mock-hub:22000";
  });

  test("verifyHubJwt accepts token signed by Hub key", async () => {
    // 生成 Hub 测试 keypair
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const pubJwk = await exportJWK(publicKey);

    // mock refreshHubJwks 内部 fetch：返回我们生成的公钥
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/auth/jwks.json")) {
        return new Response(JSON.stringify({
          keys: [{ ...pubJwk, kid: "hub-test-kid", kty: "RSA", alg: "RS256", use: "sig" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 404 });
    }) as any;

    await refreshHubJwks();

    // 用私钥签 token
    const token = await new SignJWT({ name: "alice", source: "hub", org_id: "org_x" })
      .setProtectedHeader({ alg: "RS256", kid: "hub-test-kid" })
      .setIssuer(process.env.DA_HUB_URL)
      .setSubject("usr_alice")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    const user = await verifyHubJwt(token);
    expect(user).not.toBeNull();
    expect(user?.id).toBe("usr_alice");
    expect(user?.orgId).toBe("org_x");

    globalThis.fetch = origFetch;
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run tests/auth.test.ts 2>&1 | grep "hub mode"
```

- [ ] **Step 3: 创建 `src/services/auth/hub-jwks.ts`**

```typescript
// =============================================================================
// DeepAnalyze - Hub JWKS Public Key Sync
// =============================================================================
// hub 模式：DA 启动时从 Hub 拉公钥，缓存到 data/auth/hub-jwks.json。
// 每 6h 后台刷新；Hub 不可达时用最后缓存的公钥继续验签。
// =============================================================================

import { createRemoteJWKSet, jwtVerify } from "jose";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { logInfo, logWarn } from "../../utils/logger.js";

interface Jwk {
  kty: string;
  kid: string;
  alg?: string;
  use?: string;
  [k: string]: unknown;
}

interface CachedJwks {
  fetchedAt: string;
  hubUrl: string;
  keys: Jwk[];
}

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours

function getAuthDir(): string {
  return process.env.DA_AUTH_DIR || resolve(process.cwd(), "data/auth");
}

function getCachePath(): string {
  return join(getAuthDir(), "hub-jwks.json");
}

function getHubUrl(): string {
  const url = process.env.DA_HUB_URL;
  if (!url) throw new Error("DA_HUB_URL not set");
  return url;
}

// 内存缓存：kid → JWK
const cachedKeys = new Map<string, Jwk>();
let cacheLoaded = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function loadCacheFromDisk(): void {
  const path = getCachePath();
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as CachedJwks;
    for (const k of data.keys) {
      cachedKeys.set(k.kid, k);
    }
    logInfo(`[hub-jwks] loaded ${data.keys.length} keys from disk cache`);
  } catch (err) {
    logWarn(`[hub-jwks] failed to read cache: ${err instanceof Error ? err.message : err}`);
  }
  cacheLoaded = true;
}

async function fetchAndCacheJwks(): Promise<boolean> {
  const url = `${getHubUrl()}/api/v1/auth/jwks.json`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      logWarn(`[hub-jwks] fetch returned ${resp.status}`);
      return false;
    }
    const data = await resp.json() as { keys: Jwk[] };
    cachedKeys.clear();
    for (const k of data.keys) {
      cachedKeys.set(k.kid, k);
    }

    // 写盘
    const cachePath = getCachePath();
    mkdirSync(getAuthDir(), { recursive: true });
    const cache: CachedJwks = {
      fetchedAt: new Date().toISOString(),
      hubUrl: getHubUrl(),
      keys: data.keys,
    };
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));

    logInfo(`[hub-jwks] fetched ${data.keys.length} keys from ${url}`);
    return true;
  } catch (err) {
    logWarn(`[hub-jwks] fetch failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

export async function refreshHubJwks(): Promise<void> {
  if (!cacheLoaded) loadCacheFromDisk();
  await fetchAndCacheJwks();
}

export function startJwksRefreshTimer(): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    fetchAndCacheJwks().catch(err => {
      logWarn(`[hub-jwks] background refresh error: ${err}`);
    });
  }, REFRESH_INTERVAL_MS);
}

export function stopJwksRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export async function verifyHubJwt(token: string): Promise<{
  id: string;
  name: string;
  source: "hub";
  orgId?: string;
} | null> {
  if (!cacheLoaded) loadCacheFromDisk();
  if (cachedKeys.size === 0) {
    logWarn("[hub-jwks] no cached keys, attempting refresh");
    await fetchAndCacheJwks();
  }
  if (cachedKeys.size === 0) {
    return null;  // 无法验签
  }

  // 构造 JWKS（从缓存）
  const jwksUrl = new URL(`${getHubUrl()}/api/v1/auth/jwks.json`);
  const remoteJwks = createRemoteJWKSet(jwksUrl);

  // 由于 createRemoteJWKSet 会自动 fetch，我们改用手动构造 JWKS：
  // 使用 jose 的 createLocalJWKST 替代 — 但它是 KMS 模式。
  // 改方案：直接遍历 cachedKeys，对每个 key 尝试验签。
  for (const [kid, jwk] of cachedKeys) {
    try {
      const keyObj = await crypto.subtle.importKey(
        "jwk",
        jwk as JsonWebKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const { payload } = await jwtVerify(token, keyObj, {
        issuer: getHubUrl(),
        algorithms: ["RS256"],
      });
      return {
        id: payload.sub ?? "unknown",
        name: (payload.name as string) ?? "unknown",
        source: "hub",
        orgId: payload.org_id as string | undefined,
      };
    } catch {
      // 此 key 验签失败，尝试下一把
      continue;
    }
  }

  return null;
}

export async function proxyHubLogin(
  username: string,
  password: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number } | null> {
  try {
    const resp = await fetch(`${getHubUrl()}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return null;
    return await resp.json() as { access_token: string };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 更新 `verifyToken`**

```typescript
import { verifyHubJwt } from "../../services/auth/hub-jwks.js";

async function verifyToken(token: string, mode: AuthMode): Promise<AuthUser | null> {
  if (mode === "local") {
    const u = await verifyLocalJwt(token);
    return u ? { id: u.id, name: u.name, source: "local" } : null;
  }
  if (mode === "hub") {
    const u = await verifyHubJwt(token);
    return u ? { id: u.id, name: u.name, source: "hub", orgId: u.orgId } : null;
  }
  return null;
}
```

- [ ] **Step 5: 运行测试**

```bash
npx vitest run tests/auth.test.ts 2>&1 | tail -30
```

Expected: hub 模式测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/services/auth/hub-jwks.ts src/server/middleware/auth.ts tests/auth.test.ts
git commit -m "feat(da): hub auth mode — JWKS sync + offline-tolerant verify"
```

---

### Task A4: 启动时初始化（加载 JWKS / 启动 6h 刷新）

**Files:**
- Modify: `src/main.ts`
- Test: 集成在 A3 测试中

- [ ] **Step 1: 在 `src/main.ts` 中加初始化**

找到 `createApp()` 调用前，加：

```typescript
import { getAuthMode } from "./server/middleware/auth.js";
import { refreshHubJwks, startJwksRefreshTimer } from "./services/auth/hub-jwks.js";

// 启动时 JWKS 预热（hub 模式）
if (getAuthMode() === "hub") {
  await refreshHubJwks().catch(err =>
    console.warn(`[startup] JWKS refresh failed: ${err.message}`),
  );
  startJwksRefreshTimer();
}
```

- [ ] **Step 2: 启动验证**

```bash
DA_AUTH_MODE=hub DA_HUB_URL=http://localhost:22000 python3 start.py --no-docker --skip-frontend --port 21000 &
sleep 5
# 日志应有 "[hub-jwks] fetched N keys"
ls -la data/auth/hub-jwks.json
```

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat(da): preload hub JWKS + start 6h refresh timer on startup"
```

---

## Phase B: Auth API endpoints

### Task B1: POST /api/auth/login（local bcrypt + hub proxy）

**Files:**
- Create: `src/server/routes/auth.ts`
- Modify: `src/server/app.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- Produces: `POST /api/auth/login` body `{ username, password }` → `{ access_token, expires_in }`
- Produces: `GET /api/auth/me` → 当前用户信息
- Produces: `POST /api/auth/logout` → 清 token（前端清 localStorage）
- Produces: `POST /api/auth/setup` body `{ username, password }` → 首次设置管理员（仅 local）

- [ ] **Step 1: 写失败测试**

```typescript
import { createAuthRoutes } from "../src/server/routes/auth.js";

describe("POST /api/auth/login (local mode)", () => {
  beforeEach(() => {
    process.env.DA_AUTH_MODE = "local";
  });

  test("setup + login flow", async () => {
    const routes = createAuthRoutes();
    // Setup
    let res = await routes.request("/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test123" }),
    });
    expect(res.status).toBe(200);

    // Login
    res = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test123" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBeTruthy();

    // Wrong password
    res = await routes.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: 创建 `src/server/routes/auth.ts`**

```typescript
// =============================================================================
// DeepAnalyze - Auth Routes
// =============================================================================
// POST /api/auth/setup    首次设置管理员（local 模式）
// POST /api/auth/login    登录
// POST /api/auth/logout   登出（前端清 localStorage）
// GET  /api/auth/me       当前用户
// =============================================================================

import { Hono } from "hono";
import { getAuthMode, type AuthUser } from "../middleware/auth.js";
import {
  hashPassword, verifyPassword, signLocalJwt,
} from "../../services/auth/local-idp.js";
import { proxyHubLogin } from "../../services/auth/hub-jwks.js";
import { getRepos } from "../../store/repos/index.js";

const AUTH_SETTINGS_KEY = "auth";

async function getAuthSettings(): Promise<{
  mode?: string;
  username?: string;
  passwordHash?: string;
}> {
  const repo = (await getRepos()).settings;
  const raw = await repo.get(AUTH_SETTINGS_KEY);
  return (raw?.value as any) ?? {};
}

async function saveAuthSettings(s: Record<string, unknown>): Promise<void> {
  const repo = (await getRepos()).settings;
  await repo.set(AUTH_SETTINGS_KEY, s as any);
}

export function createAuthRoutes(): Hono {
  const app = new Hono();

  // POST /setup — 首次设置（local 模式）
  app.post("/setup", async (c) => {
    if (getAuthMode() !== "local") {
      return c.json({ error: "setup only available in local mode" }, 400);
    }
    const body = await c.req.json<{ username: string; password: string }>();
    if (!body.username || !body.password || body.password.length < 6) {
      return c.json({ error: "username and password (≥6 chars) required" }, 400);
    }
    const existing = await getAuthSettings();
    if (existing.passwordHash) {
      return c.json({ error: "already initialized" }, 409);
    }
    const passwordHash = await hashPassword(body.password);
    await saveAuthSettings({
      mode: "local",
      username: body.username,
      passwordHash,
    });
    return c.json({ ok: true });
  });

  // POST /login
  app.post("/login", async (c) => {
    const mode = getAuthMode();
    const body = await c.req.json<{ username: string; password: string }>();

    if (mode === "local") {
      const settings = await getAuthSettings();
      if (!settings.passwordHash) {
        return c.json({ error: "not initialized — POST /api/auth/setup first" }, 400);
      }
      const ok = await verifyPassword(body.password, settings.passwordHash);
      if (!ok || body.username !== settings.username) {
        return c.json({ error: "invalid credentials" }, 401);
      }
      const token = await signLocalJwt("default-user", body.username);
      return c.json({ access_token: token, expires_in: 7 * 24 * 3600 });
    }

    if (mode === "hub") {
      const result = await proxyHubLogin(body.username, body.password);
      if (!result) {
        return c.json({ error: "hub login failed" }, 401);
      }
      return c.json(result);
    }

    return c.json({ error: "auth mode does not support login" }, 400);
  });

  // POST /logout
  app.post("/logout", (c) => {
    // 前端清 localStorage 即可
    return c.json({ ok: true });
  });

  // GET /me — 需要先过 authMiddleware（在 app.ts 中全局注册）
  app.get("/me", (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user) return c.json({ error: "not authenticated" }, 401);
    return c.json(user);
  });

  return app;
}
```

- [ ] **Step 3: 在 `src/server/app.ts` 挂载**

```typescript
import { createAuthRoutes } from "./routes/auth.js";
// ...
app.route("/api/auth", createAuthRoutes());
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run tests/auth.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/auth.ts src/server/app.ts tests/auth.test.ts
git commit -m "feat(da): auth API routes — setup/login/logout/me"
```

---

### Task B2: POST /api/auth/change-password（local 模式）

**Files:**
- Modify: `src/server/routes/auth.ts`
- Test: `tests/auth.test.ts`

- [ ] **Step 1: 加端点**

```typescript
app.post("/change-password", async (c) => {
  if (getAuthMode() !== "local") {
    return c.json({ error: "only local mode supports change-password" }, 400);
  }
  const body = await c.req.json<{ current: string; next: string }>();
  const settings = await getAuthSettings();
  if (!settings.passwordHash) {
    return c.json({ error: "not initialized" }, 400);
  }
  const ok = await verifyPassword(body.current, settings.passwordHash);
  if (!ok) {
    return c.json({ error: "current password incorrect" }, 401);
  }
  if (body.next.length < 6) {
    return c.json({ error: "new password too short" }, 400);
  }
  const newHash = await hashPassword(body.next);
  await saveAuthSettings({ ...settings, passwordHash: newHash });
  return c.json({ ok: true });
});
```

- [ ] **Step 2: 写测试**

```typescript
test("change-password flow", async () => {
  // 先 setup
  await routes.request("/setup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test123" }),
  });

  // 错误旧密码
  let res = await routes.request("/change-password", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current: "wrong", next: "newpass1" }),
  });
  expect(res.status).toBe(401);

  // 正确旧密码
  res = await routes.request("/change-password", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current: "test123", next: "newpass1" }),
  });
  expect(res.status).toBe(200);

  // 用新密码登录
  res = await routes.request("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "newpass1" }),
  });
  expect(res.status).toBe(200);
});
```

- [ ] **Step 3: 运行 + Commit**

```bash
npx vitest run tests/auth.test.ts 2>&1 | tail -5
git add src/server/routes/auth.ts tests/auth.test.ts
git commit -m "feat(da): POST /api/auth/change-password (local mode)"
```

---

## Phase C: 前端 Login 页 + 路由守卫

### Task C1: LoginPage 组件

**Files:**
- Create: `frontend/src/components/auth/LoginPage.tsx`
- Modify: `frontend/src/api/client.ts`
- Test: `tests/e2e/auth-flow.spec.ts`

- [ ] **Step 1: 在 `api/client.ts` 加 auth 方法**

```typescript
auth: {
  login: async (username: string, password: string) => {
    const r = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `Login failed (${r.status})`);
    }
    const data = await r.json();
    localStorage.setItem("da_access_token", data.access_token);
    return data;
  },
  setup: async (username: string, password: string) => {
    const r = await fetch(`${API_BASE}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Setup failed");
    return r.json();
  },
  me: async () => {
    const token = localStorage.getItem("da_access_token");
    if (!token) return null;
    const r = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      localStorage.removeItem("da_access_token");
      return null;
    }
    return r.json();
  },
  logout: () => {
    localStorage.removeItem("da_access_token");
    window.location.hash = "#/login";
  },
  getAuthMode: async () => {
    const r = await fetch(`${API_BASE}/api/auth/mode`);
    return r.json();
  },
},
```

加后端 `/api/auth/mode` 端点（在 auth.ts）：

```typescript
app.get("/mode", (c) => c.json({ mode: getAuthMode() }));
```

- [ ] **Step 2: 创建 `LoginPage.tsx`**

```tsx
// frontend/src/components/auth/LoginPage.tsx
import { useState, useEffect } from "react";
import { api } from "../../api/client";

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [mode, setMode] = useState<"none" | "local" | "hub" | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isSetup, setIsSetup] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.auth.getAuthMode().then(d => setMode(d.mode)).catch(() => setMode("none"));
  }, []);

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      if (isSetup) {
        if (password !== confirm) {
          setError("Passwords do not match");
          return;
        }
        await api.auth.setup(username, password);
      }
      await api.auth.login(username, password);
      onLoggedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!mode) return <div className="login-page">Loading...</div>;
  if (mode === "none") {
    // 不应跳到 login，但作为兜底
    return <div className="login-page">No auth required</div>;
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>DeepAnalyze</h1>
        <p className="login-subtitle">{mode === "hub" ? "企业登录（Hub SSO）" : "本地登录"}</p>

        {error && <div className="login-error">{error}</div>}

        <input
          type="text"
          placeholder="用户名"
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoComplete="username"
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        {isSetup && (
          <input
            type="password"
            placeholder="确认密码"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
          />
        )}

        <button onClick={submit} disabled={busy}>
          {busy ? "处理中..." : isSetup ? "初始化并登录" : "登录"}
        </button>

        {mode === "local" && !isSetup && (
          <button className="link" onClick={() => setIsSetup(true)}>
            首次设置管理员
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 在 router 中加 `/login` 路由**

修改 `frontend/src/router.tsx`：

```typescript
import { LoginPage } from "./components/auth/LoginPage";

// 在路由数组开头加：
{ path: "/login", element: <LoginPage onLoggedIn={() => window.location.hash = "#/chat"} /> },
{ path: "/setup", element: <LoginPage onLoggedIn={() => window.location.hash = "#/chat"} /> },
```

- [ ] **Step 4: 加路由守卫**

在 `App.tsx` 中（`RouterProvider` 之前）加：

```typescript
function useAuthGate() {
  useEffect(() => {
    api.auth.getAuthMode().then(({ mode }) => {
      if (mode === "none") return;  // 不需要登录
      const token = localStorage.getItem("da_access_token");
      if (!token) {
        window.location.hash = "#/login";
        return;
      }
      // 校验 token 有效性
      api.auth.me().then(user => {
        if (!user) {
          localStorage.removeItem("da_access_token");
          window.location.hash = "#/login";
        }
      });
    });
  }, []);
}
```

- [ ] **Step 5: 加 CSS**

参照现有页面风格，加 `.login-page` `.login-card` 等样式到 `frontend/src/index.css` 或对应样式文件。

- [ ] **Step 6: 手工验证**

```bash
DA_AUTH_MODE=local python3 start.py --no-docker --port 21000 &
# 浏览器访问 http://localhost:21000 → 应跳到 #/login
# 点"首次设置管理员"→ 输入 admin/test123 → 登录 → 跳 #/chat
```

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/auth/LoginPage.tsx \
        frontend/src/api/client.ts frontend/src/router.tsx \
        frontend/src/App.tsx src/server/routes/auth.ts
git commit -m "feat(da-fe): login page with auth-mode detection + setup flow"
```

---

### Task C2: Header user badge + logout button

**Files:**
- Modify: `frontend/src/components/layout/Header.tsx`
- Modify: `frontend/src/api/client.ts`

- [ ] **Step 1: 修改 Header 加用户显示**

```tsx
// 在 Header.tsx 中
import { api } from "../../api/client";
import { useEffect, useState } from "react";

function UserBadge() {
  const [user, setUser] = useState<{ name: string; source: string } | null>(null);
  useEffect(() => {
    api.auth.me().then(u => setUser(u)).catch(() => {});
  }, []);

  if (!user) return null;
  return (
    <div className="user-badge">
      <span>{user.name}</span>
      <button onClick={() => { api.auth.logout(); window.location.reload(); }}>
        登出
      </button>
    </div>
  );
}

// 在 Header 渲染中插入 <UserBadge />
```

- [ ] **Step 2: 手工验证**

登录后 Header 显示用户名，点"登出"返回登录页。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/layout/Header.tsx
git commit -m "feat(da-fe): header user badge with logout button"
```

---

## Phase D: Settings 加 AuthPanel + HubConnectionPanel

### Task D1: 后端 /api/settings/auth + /api/settings/hub

**Files:**
- Modify: `src/server/routes/settings.ts`
- Test: `tests/auth.test.ts`

- [ ] **Step 1: 加端点**

```typescript
// 在 createSettingsRoutes 内追加
app.get("/auth", async (c) => {
  const repo = (await getRepos()).settings;
  const raw = await repo.get("auth");
  return c.json(raw?.value ?? { mode: getAuthMode() });
});

app.put("/auth", async (c) => {
  const body = await c.req.json();
  const repo = (await getRepos()).settings;
  const existing = (await repo.get("auth"))?.value ?? {};
  await repo.set("auth", { ...existing, ...body });
  return c.json({ ok: true });
});

app.get("/hub", async (c) => {
  const repo = (await getRepos()).settings;
  const raw = await repo.get("hub_connection");
  return c.json(raw?.value ?? { connected: false });
});

app.post("/hub/connect", async (c) => {
  const body = await c.req.json<{ hubUrl: string; joinToken: string }>();
  // 调 HubClient.connectToHub() — Task J 实现
  const hubClient = global.__hubClient;
  if (!hubClient) {
    return c.json({ error: "hub client not initialized" }, 400);
  }
  try {
    const result = await (hubClient as any).connectToHub(body.hubUrl, body.joinToken);
    const repo = (await getRepos()).settings;
    await repo.set("hub_connection", { connected: true, hubUrl: body.hubUrl });
    return c.json({ ok: true, ...result });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.post("/hub/disconnect", async (c) => {
  const hubClient = global.__hubClient;
  if (hubClient && (hubClient as any).isConnected?.()) {
    await (hubClient as any).disconnectFromHub();
  }
  const repo = (await getRepos()).settings;
  await repo.set("hub_connection", { connected: false });
  return c.json({ ok: true });
});
```

- [ ] **Step 2: Commit**

```bash
git add src/server/routes/settings.ts
git commit -m "feat(da): settings API — auth + hub connection management"
```

---

### Task D2: 前端 AuthPanel + HubConnectionPanel

**Files:**
- Create: `frontend/src/components/settings/AuthPanel.tsx`
- Create: `frontend/src/components/settings/HubConnectionPanel.tsx`
- Modify: `frontend/src/components/settings/SettingsPanel.tsx`

- [ ] **Step 1: 创建 AuthPanel**

```tsx
export function AuthPanel() {
  const [settings, setSettings] = useState<any>({});
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch(`${API_BASE}/api/settings/auth`)
      .then(r => r.json())
      .then(setSettings);
  }, []);

  const changePassword = async () => {
    const r = await fetch(`${API_BASE}/api/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("da_access_token")}` },
      body: JSON.stringify({ current: currentPassword, next: newPassword }),
    });
    setMsg(r.ok ? "密码已修改" : `失败：${(await r.json()).error}`);
  };

  return (
    <div className="settings-panel">
      <h2>认证设置</h2>
      <div>当前模式：<strong>{settings.mode}</strong></div>
      {settings.mode === "local" && (
        <>
          <h3>修改密码</h3>
          <input type="password" placeholder="当前密码" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} />
          <input type="password" placeholder="新密码" value={newPassword} onChange={e => setNewPassword(e.target.value)} />
          <button onClick={changePassword}>提交</button>
          {msg && <div>{msg}</div>}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 创建 HubConnectionPanel**

```tsx
export function HubConnectionPanel() {
  const [hubUrl, setHubUrl] = useState("");
  const [joinToken, setJoinToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch(`${API_BASE}/api/settings/hub`)
      .then(r => r.json())
      .then(d => {
        setConnected(d.connected);
        setHubUrl(d.hubUrl || "");
      });
  }, []);

  const connect = async () => {
    const r = await fetch(`${API_BASE}/api/settings/hub/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hubUrl, joinToken }),
    });
    const data = await r.json();
    if (r.ok) {
      setConnected(true);
      setMsg("已连接");
    } else {
      setMsg(`失败：${data.error}`);
    }
  };

  const disconnect = async () => {
    await fetch(`${API_BASE}/api/settings/hub/disconnect`, { method: "POST" });
    setConnected(false);
    setMsg("已断开");
  };

  return (
    <div className="settings-panel">
      <h2>Hub 连接</h2>
      <div>状态：{connected ? "✓ 已连接" : "✗ 未连接"}</div>
      {!connected && (
        <>
          <input placeholder="Hub URL" value={hubUrl} onChange={e => setHubUrl(e.target.value)} />
          <input placeholder="Join Token" value={joinToken} onChange={e => setJoinToken(e.target.value)} />
          <button onClick={connect}>连接</button>
        </>
      )}
      {connected && <button onClick={disconnect}>断开</button>}
      {msg && <div>{msg}</div>}
    </div>
  );
}
```

- [ ] **Step 3: 在 SettingsPanel 加 tab**

```tsx
// 在 SettingsPanel.tsx 的 tabs 数组加：
{ id: "auth", label: "认证", component: <AuthPanel /> },
{ id: "hub", label: "Hub", component: <HubConnectionPanel /> },
```

- [ ] **Step 4: 手工验证 + Commit**

```bash
git add frontend/src/components/settings/AuthPanel.tsx \
        frontend/src/components/settings/HubConnectionPanel.tsx \
        frontend/src/components/settings/SettingsPanel.tsx
git commit -m "feat(da-fe): auth + hub connection panels in settings"
```

---

## Phase E: ModelDownloader 服务

### Task E1: src/services/model-manifest.ts — 加载 da-assets/manifest.json

**Files:**
- Create: `da-assets/manifest.json`
- Create: `src/services/model-manifest.ts`
- Test: `tests/model-downloader.test.ts`

- [ ] **Step 1: 创建 manifest**

`da-assets/manifest.json`（与设计章节 6.2 一致）：

```json
{
  "version": "1.0.0",
  "models": {
    "bge-m3": {
      "version": "1.0.0",
      "category": "embedding",
      "size_bytes": 2370000000,
      "files": [
        { "path": "pytorch_model.bin", "sha256": "TODO_FILL", "size_bytes": 2370000000 },
        { "path": "config.json", "sha256": "TODO_FILL", "size_bytes": 1200 },
        { "path": "tokenizer.json", "sha256": "TODO_FILL", "size_bytes": 8000 }
      ],
      "sources": {
        "huggingface": "https://huggingface.co/BAAI/bge-m3/resolve/main/",
        "hf_mirror": "https://hf-mirror.com/BAAI/bge-m3/resolve/main/"
      },
      "runtime_deps": { "python_packages": ["sentence-transformers>=2.7.0", "torch>=2.1.0"] },
      "min_disk_mb": 3000,
      "min_ram_mb": 2048,
      "recommended_for": ["knowledge_base"]
    },
    "whisper-tiny": { "version": "1.0.0", "category": "asr", "size_bytes": 73000000, "files": [], "sources": {} },
    "whisper-base": { "version": "1.0.0", "category": "asr", "size_bytes": 139000000, "files": [], "sources": {} },
    "docling": { "version": "1.0.0", "category": "doc_parsing", "size_bytes": 500000000, "files": [], "sources": {} },
    "paddleocr-vl": { "version": "1.0.0", "category": "vlm", "size_bytes": 2000000000, "files": [], "sources": {} }
  }
}
```

> `TODO_FILL` 占位，实施时下载文件后用 `sha256sum` 替换。

- [ ] **Step 2: 创建 manifest 加载器**

```typescript
// src/services/model-manifest.ts
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

export interface ModelManifestFile {
  path: string;
  sha256: string;
  size_bytes: number;
}

export interface ModelManifestEntry {
  version: string;
  category: string;
  size_bytes: number;
  files: ModelManifestFile[];
  sources: { huggingface?: string; hf_mirror?: string };
  runtime_deps?: { python_packages?: string[] };
  min_disk_mb?: number;
  min_ram_mb?: number;
  recommended_for?: string[];
}

export interface ModelManifest {
  version: string;
  models: Record<string, ModelManifestEntry>;
}

let cached: ModelManifest | null = null;

export function getLocalManifest(): ModelManifest {
  if (cached) return cached;
  const manifestPath = process.env.DA_MANIFEST_PATH
    || resolve(process.cwd(), "da-assets/manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath}`);
  }
  cached = JSON.parse(readFileSync(manifestPath, "utf-8"));
  return cached;
}

export async function fetchRemoteManifest(): Promise<ModelManifest | null> {
  const url = process.env.DA_MANIFEST_URL;
  if (!url) return null;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    return await resp.json() as ModelManifest;
  } catch {
    return null;
  }
}

export function getModelsDir(): string {
  return process.env.DA_MODELS_DIR || resolve(process.cwd(), "data/models");
}

export function getModelDir(modelName: string): string {
  return join(getModelsDir(), modelName);
}
```

- [ ] **Step 3: 测试**

```typescript
import { describe, test, expect } from "vitest";
import { getLocalManifest, getModelsDir } from "../src/services/model-manifest.js";

describe("model-manifest", () => {
  test("local manifest loads", () => {
    const m = getLocalManifest();
    expect(m.version).toBeTruthy();
    expect(Object.keys(m.models).length).toBeGreaterThan(0);
    expect(m.models["bge-m3"]).toBeDefined();
  });

  test("models dir resolves", () => {
    expect(getModelsDir()).toBeTruthy();
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add da-assets/manifest.json src/services/model-manifest.ts tests/model-downloader.test.ts
git commit -m "feat(da): model manifest loader + da-assets/manifest.json"
```

---

### Task E2: src/services/model-downloader.ts — 核心 + sha256 + 多源

**Files:**
- Create: `src/services/model-downloader.ts`
- Modify: `tests/model-downloader.test.ts`

**Interfaces:**
- Produces: `downloadModel(name, source, onProgress?): Promise<DownloadResult>`
- Produces: `verifyModel(name): Promise<VerifyResult>` — sha256 校验
- Produces: `listLocalModels(): ModelInfo[]`
- Produces: `removeModel(name): Promise<void>`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { downloadModel, verifyModel, listLocalModels } from "../src/services/model-downloader.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEST_DIR = resolve(process.cwd(), "tests/tmp-models");

describe("model-downloader", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.DA_MODELS_DIR = TEST_DIR;
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.DA_MODELS_DIR;
  });

  test("listLocalModels returns empty when no models", () => {
    expect(listLocalModels()).toEqual([]);
  });

  test("verifyModel detects missing files", async () => {
    const r = await verifyModel("bge-m3");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("missing");
  });

  test("verifyModel passes after manual place", async () => {
    // 创建假的模型文件
    const manifest = getLocalManifest();
    const model = manifest.models["bge-m3"];
    const modelDir = resolve(TEST_DIR, "bge-m3");
    mkdirSync(modelDir, { recursive: true });

    for (const f of model.files) {
      // 写假内容（sha 不对但测流程）
      writeFileSync(resolve(modelDir, f.path), "fake-content");
    }
    const r = await verifyModel("bge-m3");
    expect(r.ok).toBe(false);  // sha 不匹配
    expect(r.reason).toContain("sha256");
  });
});
```

- [ ] **Step 2: 创建下载器**

```typescript
// =============================================================================
// src/services/model-downloader.ts
// =============================================================================

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getLocalManifest, getModelDir, type ModelManifestEntry } from "./model-manifest.js";

export type ModelSource = "huggingface" | "hf_mirror" | "enterprise" | "hub" | "manual";

export interface DownloadProgress {
  fileName: string;
  bytesDownloaded: number;
  bytesTotal: number;
  percent: number;
}

export interface DownloadResult {
  ok: boolean;
  modelName: string;
  bytesDownloaded: number;
  duration: number;
  error?: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  missingFiles?: string[];
  mismatchedSha?: string[];
}

const MAX_RETRIES = 3;
const FALLBACK_SOURCES: ModelSource[] = ["enterprise", "hf_mirror", "huggingface"];

export async function downloadModel(
  name: string,
  source: ModelSource,
  onProgress?: (p: DownloadProgress) => void,
): Promise<DownloadResult> {
  const start = Date.now();
  const manifest = getLocalManifest();
  const entry: ModelManifestEntry | undefined = manifest.models[name];
  if (!entry) {
    return { ok: false, modelName: name, bytesDownloaded: 0, duration: 0, error: "model not in manifest" };
  }

  const modelDir = getModelDir(name);
  mkdirSync(modelDir, { recursive: true });

  const sources = resolveSourceUrls(entry, source);
  if (sources.length === 0) {
    return { ok: false, modelName: name, bytesDownloaded: 0, duration: 0, error: "no source available" };
  }

  let totalDownloaded = 0;

  for (const file of entry.files) {
    const targetPath = join(modelDir, file.path);
    mkdirSync(dirname(targetPath), { recursive: true });

    let success = false;
    let lastErr: Error | null = null;

    for (const baseUrl of sources) {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const url = `${baseUrl}/${file.path}`;
          const bytes = await downloadFile(url, targetPath, file.size_bytes, file.path, onProgress);
          totalDownloaded += bytes;

          // 校验 sha256
          const actualSha = await computeFileSha(targetPath);
          if (actualSha !== file.sha256) {
            throw new Error(`sha256 mismatch for ${file.path}: expected ${file.sha256}, got ${actualSha}`);
          }

          success = true;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          console.warn(`[downloader] ${file.path} attempt ${attempt + 1} failed: ${lastErr.message}`);
        }
      }
      if (success) break;
    }

    if (!success) {
      return {
        ok: false, modelName: name, bytesDownloaded: totalDownloaded, duration: Date.now() - start,
        error: `failed to download ${file.path}: ${lastErr?.message}`,
      };
    }
  }

  return { ok: true, modelName: name, bytesDownloaded: totalDownloaded, duration: Date.now() - start };
}

function resolveSourceUrls(entry: ModelManifestEntry, source: ModelSource): string[] {
  if (source === "manual") return [];
  if (source === "enterprise" && process.env.DA_ENTERPRISE_MODELS_URL) {
    return [`${process.env.DA_ENTERPRISE_MODELS_URL}/${entry.version}`];
  }
  if (source === "hub" && process.env.DA_HUB_URL) {
    return [`${process.env.DA_HUB_URL}/api/v1/models/blobs`];
  }
  if (source === "huggingface" && entry.sources.huggingface) {
    return [entry.sources.huggingface];
  }
  if (source === "hf_mirror" && entry.sources.hf_mirror) {
    return [entry.sources.hf_mirror];
  }
  // auto fallback
  return FALLBACK_SOURCES
    .map(s => resolveSourceUrls(entry, s)[0])
    .filter(Boolean) as string[];
}

async function downloadFile(
  url: string,
  targetPath: string,
  totalBytes: number,
  fileName: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<number> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  if (!resp.body) throw new Error("no body");

  const partPath = `${targetPath}.part`;
  let received = 0;
  const lastReport = Date.now();

  const hasher = createHash("sha256");
  const out = createWriteStream(partPath);

  // wrap body to compute sha + progress
  const countingStream = new ReadableStream({
    async start(controller) {
      const reader = resp.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        hasher.update(value);
        controller.enqueue(value);
        if (onProgress && Date.now() - lastReport > 500) {
          onProgress({
            fileName,
            bytesDownloaded: received,
            bytesTotal: totalBytes,
            percent: totalBytes > 0 ? (received / totalBytes) * 100 : 0,
          });
        }
      }
      controller.close();
    },
  });

  await pipeline(countingStream, out);
  renameSync(partPath, targetPath);
  return received;
}

async function computeFileSha(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", d => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function verifyModel(name: string): Promise<VerifyResult> {
  const manifest = getLocalManifest();
  const entry = manifest.models[name];
  if (!entry) return { ok: false, reason: "model not in manifest" };

  const modelDir = getModelDir(name);
  if (!existsSync(modelDir)) return { ok: false, reason: "model dir missing" };

  const missing: string[] = [];
  const mismatched: string[] = [];

  for (const f of entry.files) {
    const fp = join(modelDir, f.path);
    if (!existsSync(fp)) {
      missing.push(f.path);
      continue;
    }
    const actualSha = await computeFileSha(fp);
    if (actualSha !== f.sha256) {
      mismatched.push(f.path);
    }
  }

  if (missing.length > 0) {
    return { ok: false, reason: `missing ${missing.length} file(s)`, missingFiles: missing };
  }
  if (mismatched.length > 0) {
    return { ok: false, reason: `sha256 mismatch on ${mismatched.length} file(s)`, mismatchedSha: mismatched };
  }

  return { ok: true };
}

export function listLocalModels(): Array<{ name: string; sizeBytes: number }> {
  const dir = getModelDirForListing();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const path = join(dir, d.name);
      let sizeBytes = 0;
      try {
        for (const f of readdirSync(path, { recursive: true } as any)) {
          const fp = join(path, f as string);
          if (existsSync(fp) && statSync(fp).isFile()) sizeBytes += statSync(fp).size;
        }
      } catch {}
      return { name: d.name, sizeBytes };
    });
}

function getModelDirForListing(): string {
  return process.env.DA_MODELS_DIR
    || (typeof process !== "undefined" && process.cwd?.())
    ? require("node:path").resolve(process.cwd(), "data/models")
    : "data/models";
}

export async function removeModel(name: string): Promise<void> {
  const dir = getModelDir(name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
```

> 注意：上面 `getModelDirForListing` 用了 `require`，TS+ESM 项目应改用 `import`。修正：复用 `getModelsDir` from model-manifest。

- [ ] **Step 3: 修正 import**

```typescript
import { getModelsDir } from "./model-manifest.js";
// ...
function getModelDirForListing(): string { return getModelsDir(); }
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run tests/model-downloader.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src/services/model-downloader.ts tests/model-downloader.test.ts
git commit -m "feat(da): model downloader with multi-source fallback + sha256 verify"
```

---

### Task E3: 断点续传 + 失败重试

**Files:**
- Modify: `src/services/model-downloader.ts`

- [ ] **Step 1: 在 downloadFile 中加 Range 支持**

```typescript
async function downloadFile(
  url: string,
  targetPath: string,
  totalBytes: number,
  fileName: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<number> {
  const partPath = `${targetPath}.part`;
  const existingBytes = existsSync(partPath) ? statSync(partPath).size : 0;

  const headers: Record<string, string> = {};
  if (existingBytes > 0) {
    headers["Range"] = `bytes=${existingBytes}-`;
  }

  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(300000) });
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  const isResuming = resp.status === 206;
  const body = resp.body;
  if (!body) throw new Error("no body");

  let received = existingBytes;
  const hasher = createHash("sha256");

  // 续传时 hash 从已有部分开始算
  if (isResuming) {
    const existingBuf = await import("node:fs/promises").then(m => m.readFile(partPath));
    hasher.update(existingBuf);
  }

  const out = createWriteStream(partPath, { flags: isResuming ? "a" : "w" });
  const lastReport = Date.now();

  const countingStream = new ReadableStream({
    async start(controller) {
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        hasher.update(value);
        controller.enqueue(value);
        if (onProgress && Date.now() - lastReport > 500) {
          onProgress({
            fileName,
            bytesDownloaded: received,
            bytesTotal: totalBytes,
            percent: totalBytes > 0 ? (received / totalBytes) * 100 : 0,
          });
        }
      }
      controller.close();
    },
  });

  await pipeline(countingStream, out);
  renameSync(partPath, targetPath);
  return received;
}
```

- [ ] **Step 2: 运行 + Commit**

```bash
npx vitest run tests/model-downloader.test.ts 2>&1 | tail -5
git add src/services/model-downloader.ts
git commit -m "feat(da): model downloader supports resume via HTTP Range"
```

---

## Phase F: ModelServiceSupervisor

### Task F1: src/server/model-supervisor.ts — 子服务编排

**Files:**
- Create: `src/server/model-supervisor.ts`
- Test: `tests/model-supervisor.test.ts`

**Interfaces:**
- Produces: `class ModelServiceSupervisor` 单例
- Produces: `startService(name: ServiceName): Promise<void>`
- Produces: `stopService(name): Promise<void>`
- Produces: `getStatus(): Record<ServiceName, "running"|"degraded"|"missing_weights"|"disabled">`
- Produces: `start(): Promise<void>` — 启动时根据 config 拉需要的子服务

- [ ] **Step 1: 创建 supervisor**

```typescript
// =============================================================================
// src/server/model-supervisor.ts
// =============================================================================
// 启动 4 个独立 Python 子服务（embedding/whisper/docling/paddleocr）。
// 端口池自动分配（:21001-21010），崩溃重试 3 次后降级。
// =============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getRepos } from "../store/repos/index.js";
import { getModelsDir } from "../services/model-manifest.js";

export type ServiceName = "embedding" | "whisper" | "docling" | "paddleocr";
export type ServiceStatus = "running" | "degraded" | "missing_weights" | "disabled";

interface ServiceConfig {
  port: number;
  scriptPath: string;
  weightsRequired: string[];  // data/models/{name} 子目录
  healthPath: string;
}

const PORT_RANGE_START = 21001;
const PORT_RANGE_END = 21010;

const SERVICE_CONFIGS: Record<ServiceName, ServiceConfig> = {
  embedding: {
    port: 21001,
    scriptPath: "src/services/embedding/server.py",
    weightsRequired: ["bge-m3"],
    healthPath: "/health",
  },
  whisper: {
    port: 21002,
    scriptPath: "src/services/whisper/server.py",
    weightsRequired: ["whisper-tiny", "whisper-base"],
    healthPath: "/health",
  },
  docling: {
    port: 21003,
    scriptPath: "src/services/docling/server.py",
    weightsRequired: ["docling"],
    healthPath: "/health",
  },
  paddleocr: {
    port: 21004,
    scriptPath: "src/services/paddleocr/server.py",
    weightsRequired: ["paddleocr-vl"],
    healthPath: "/health",
  },
};

class ModelServiceSupervisor {
  private processes: Partial<Record<ServiceName, ChildProcess>> = {};
  private statuses: Record<ServiceName, ServiceStatus> = {
    embedding: "disabled", whisper: "disabled", docling: "disabled", paddleocr: "disabled",
  };
  private retryCount: Partial<Record<ServiceName, number>> = {};
  private healthTimers: Partial<Record<ServiceName, ReturnType<typeof setInterval>>> = {};

  async start(): Promise<void> {
    const settings = (await getRepos()).settings;
    const pipeline = (await settings.get("pipeline_strategies"))?.value as Record<string, boolean> ?? {};
    // 默认全启用（按需）
    for (const name of Object.keys(SERVICE_CONFIGS) as ServiceName[]) {
      if (pipeline[name] === false) continue;  // 显式禁用
      await this.startService(name);
    }
  }

  async startService(name: ServiceName): Promise<void> {
    const cfg = SERVICE_CONFIGS[name];

    // 检查权重
    for (const w of cfg.weightsRequired) {
      const dir = resolve(getModelsDir(), w);
      if (!existsSync(dir)) {
        this.statuses[name] = "missing_weights";
        console.warn(`[supervisor] ${name}: missing weights ${w}`);
        return;
      }
    }

    try {
      const proc = spawn("python3", [cfg.scriptPath], {
        env: {
          ...process.env,
          PORT: String(cfg.port),
          MODELS_DIR: getModelsDir(),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.on("exit", (code, signal) => {
        console.warn(`[supervisor] ${name} exited (code=${code} signal=${signal})`);
        this.statuses[name] = "degraded";
        const retries = (this.retryCount[name] ?? 0) + 1;
        this.retryCount[name] = retries;
        if (retries <= 3) {
          setTimeout(() => this.startService(name).catch(() => {}), 2000 * retries);
        } else {
          this.statuses[name] = "disabled";
        }
      });

      proc.stdout?.on("data", (data) => console.log(`[${name}] ${data}`));
      proc.stderr?.on("data", (data) => console.error(`[${name}] ${data}`));

      this.processes[name] = proc;
      this.statuses[name] = "running";
      this.retryCount[name] = 0;
      this.startHealthCheck(name);
    } catch (err) {
      this.statuses[name] = "degraded";
      console.error(`[supervisor] ${name} failed to start:`, err);
    }
  }

  private startHealthCheck(name: ServiceName): void {
    if (this.healthTimers[name]) clearInterval(this.healthTimers[name]);
    const cfg = SERVICE_CONFIGS[name];
    this.healthTimers[name] = setInterval(async () => {
      try {
        const resp = await fetch(`http://localhost:${cfg.port}${cfg.healthPath}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) this.statuses[name] = "running";
        else this.statuses[name] = "degraded";
      } catch {
        this.statuses[name] = "degraded";
      }
    }, 30000);
  }

  async stopService(name: ServiceName): Promise<void> {
    if (this.healthTimers[name]) {
      clearInterval(this.healthTimers[name]);
      delete this.healthTimers[name];
    }
    const proc = this.processes[name];
    if (proc) {
      proc.kill("SIGTERM");
      await new Promise<void>(r => {
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          r();
        }, 5000);
        proc.on("exit", () => { clearTimeout(timer); r(); });
      });
      delete this.processes[name];
    }
    this.statuses[name] = "disabled";
  }

  async stopAll(): Promise<void> {
    for (const name of Object.keys(this.processes) as ServiceName[]) {
      await this.stopService(name);
    }
  }

  getStatus(): Record<ServiceName, ServiceStatus> {
    return { ...this.statuses };
  }
}

let supervisorInstance: ModelServiceSupervisor | null = null;

export function getModelSupervisor(): ModelServiceSupervisor {
  if (!supervisorInstance) supervisorInstance = new ModelServiceSupervisor();
  return supervisorInstance;
}
```

- [ ] **Step 2: 测试**

```typescript
import { describe, test, expect } from "vitest";
import { getModelSupervisor } from "../src/server/model-supervisor.js";

describe("ModelServiceSupervisor", () => {
  test("initial status all disabled", () => {
    const s = getModelSupervisor();
    const status = s.getStatus();
    expect(status.embedding).toBe("disabled");
    expect(status.whisper).toBe("disabled");
  });

  test("missing weights detected", async () => {
    process.env.DA_MODELS_DIR = "/tmp/nonexistent-models";
    const s = getModelSupervisor();
    await s.startService("embedding");
    expect(s.getStatus().embedding).toBe("missing_weights");
    delete process.env.DA_MODELS_DIR;
  });
});
```

- [ ] **Step 3: 在 `src/main.ts` 中启动 supervisor**

```typescript
import { getModelSupervisor } from "./server/model-supervisor.js";

// 在 createApp 之前或之后：
const supervisor = getModelSupervisor();
await supervisor.start().catch(err => console.error("[supervisor] start failed:", err));

// 进程退出时清理
process.on("SIGTERM", async () => {
  await supervisor.stopAll();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await supervisor.stopAll();
  process.exit(0);
});
```

- [ ] **Step 4: Commit**

```bash
git add src/server/model-supervisor.ts src/main.ts tests/model-supervisor.test.ts
git commit -m "feat(da): model service supervisor — start/stop/health-check 4 subservices"
```

---

### Task F2: SystemStatusBanner 显示子服务状态

**Files:**
- Modify: `frontend/src/components/layout/SystemStatusBanner.tsx`
- Modify: `src/server/routes/settings.ts` (add `/api/settings/services`)

- [ ] **Step 1: 加后端 endpoint**

```typescript
import { getModelSupervisor } from "../server/model-supervisor.js";

app.get("/services", (c) => {
  const s = getModelSupervisor();
  return c.json(s.getStatus());
});
```

- [ ] **Step 2: 修改 SystemStatusBanner**

```tsx
// frontend/src/components/layout/SystemStatusBanner.tsx
import { useEffect, useState } from "react";

type ServiceStatus = "running" | "degraded" | "missing_weights" | "disabled";
const STATUS_COLOR: Record<ServiceStatus, string> = {
  running: "#28a745", degraded: "#ffc107", missing_weights: "#dc3545", disabled: "#6c757d",
};
const STATUS_LABEL: Record<ServiceStatus, string> = {
  running: "正常", degraded: "降级", missing_weights: "缺权重", disabled: "未启用",
};

export function SystemStatusBanner() {
  const [status, setStatus] = useState<Record<string, ServiceStatus>>({});

  useEffect(() => {
    const fetchStatus = () => fetch(`${API_BASE}/api/settings/services`)
      .then(r => r.json())
      .then(setStatus)
      .catch(() => {});
    fetchStatus();
    const t = setInterval(fetchStatus, 30000);
    return () => clearInterval(t);
  }, []);

  const entries = Object.entries(status);
  if (entries.length === 0) return null;

  return (
    <div className="system-status-banner">
      {entries.map(([name, st]) => (
        <span key={name} className="service-badge" style={{ background: STATUS_COLOR[st] }}>
          {name}: {STATUS_LABEL[st]}
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/settings.ts frontend/src/components/layout/SystemStatusBanner.tsx
git commit -m "feat(da): system status banner shows subservice health"
```

---

## Phase G: 安装向导（Web + CLI）

### Task G1: src/setup/environment.ts — Phase 1 环境检测

**Files:**
- Create: `src/setup/environment.ts`
- Test: `tests/wizard.test.ts`

**Interfaces:**
- Produces: `detectEnvironment(): Promise<EnvironmentReport>`

- [ ] **Step 1: 创建**

```typescript
// =============================================================================
// src/setup/environment.ts
// =============================================================================

import { existsSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getModelsDir } from "../services/model-manifest.js";

export interface EnvironmentReport {
  cpu: { cores: number };
  memory: { totalGb: number; freeGb: number };
  disk: { availableGb: number };
  gpu: { available: boolean; name?: string; vramMb?: number };
  network: {
    huggingFace: boolean;
    hfMirror: boolean;
    hubUrl?: boolean;
    enterpriseRepo?: boolean;
  };
  existingModels: string[];
  hfCacheHits: string[];
}

export async function detectEnvironment(): Promise<EnvironmentReport> {
  return {
    cpu: detectCpu(),
    memory: detectMemory(),
    disk: detectDisk(),
    gpu: detectGpu(),
    network: await detectNetwork(),
    existingModels: detectExistingModels(),
    hfCacheHits: detectHfCache(),
  };
}

function detectCpu() {
  return { cores: require("node:os").cpus().length };
}

function detectMemory() {
  const m = require("node:os").totalmem();
  const f = require("node:os").freemem();
  return { totalGb: +(m / 1e9).toFixed(1), freeGb: +(f / 1e9).toFixed(1) };
}

function detectDisk() {
  try {
    const output = execSync("df -BG . | tail -1 | awk '{print $4}'", { encoding: "utf-8" }).trim();
    return { availableGb: parseInt(output, 10) };
  } catch {
    return { availableGb: 0 };
  }
}

function detectGpu() {
  try {
    const output = execSync("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits", { encoding: "utf-8" }).trim();
    const [name, vramMb] = output.split(",").map(s => s.trim());
    return { available: true, name, vramMb: parseInt(vramMb, 10) };
  } catch {
    return { available: false };
  }
}

async function detectNetwork() {
  const targets = [
    ["huggingFace", "https://huggingface.co"],
    ["hfMirror", "https://hf-mirror.com"],
  ];
  const result: any = {};

  await Promise.all(targets.map(async ([key, url]) => {
    try {
      const resp = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      result[key] = resp.ok;
    } catch { result[key] = false; }
  }));

  if (process.env.DA_HUB_URL) {
    try {
      const resp = await fetch(`${process.env.DA_HUB_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
      result.hubUrl = resp.ok;
    } catch { result.hubUrl = false; }
  }
  if (process.env.DA_ENTERPRISE_MODELS_URL) {
    try {
      const resp = await fetch(`${process.env.DA_ENTERPRISE_MODELS_URL}/health`, { signal: AbortSignal.timeout(5000) });
      result.enterpriseRepo = resp.ok;
    } catch { result.enterpriseRepo = false; }
  }

  return result;
}

function detectExistingModels(): string[] {
  const dir = getModelsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function detectHfCache(): string[] {
  const cacheDir = join(homedir(), ".cache/huggingface/hub");
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name.replace(/^models--/, "").replace(/--/g, "/"));
}
```

> 修正：上面 `require("node:os")` 应改为 ESM `import os from "node:os"`。

- [ ] **Step 2: 测试**

```typescript
import { describe, test, expect } from "vitest";
import { detectEnvironment } from "../src/setup/environment.js";

describe("detectEnvironment", () => {
  test("returns cpu/memory/disk", async () => {
    const r = await detectEnvironment();
    expect(r.cpu.cores).toBeGreaterThan(0);
    expect(r.memory.totalGb).toBeGreaterThan(0);
    expect(r.disk.availableGb).toBeGreaterThanOrEqual(0);
  });

  test("existing models is array", async () => {
    const r = await detectEnvironment();
    expect(Array.isArray(r.existingModels)).toBe(true);
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/setup/environment.ts tests/wizard.test.ts
git commit -m "feat(da): setup wizard Phase 1 — environment detection"
```

---

### Task G2: src/setup/wizard.ts — 6 阶段状态机

**Files:**
- Create: `src/setup/wizard.ts`
- Test: `tests/wizard.test.ts`

**Interfaces:**
- Produces: `runWizard(opts): Promise<WizardResult>` — 接受各阶段输入，产出 config.yaml 内容
- Produces: `isSetupComplete(): boolean` — 检查 `data/setup-complete.flag`
- Produces: `markSetupComplete(): Promise<void>`

- [ ] **Step 1: 创建 wizard 核心**

```typescript
// =============================================================================
// src/setup/wizard.ts
// =============================================================================

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { detectEnvironment, type EnvironmentReport } from "./environment.js";

export type WizardMode = "personal" | "enterprise_worker";
export type AuthChoice = "none" | "local";
export type ModelStrategy = "all_cloud" | "all_local" | "hybrid" | "manual";
export type ModelSource = "auto" | "hf" | "hf_mirror" | "enterprise" | "manual";

export interface WizardInput {
  environment: EnvironmentReport;
  mode: WizardMode;
  authChoice?: AuthChoice;          // personal only
  adminUsername?: string;
  adminPassword?: string;
  hubUrl?: string;                  // enterprise_worker
  joinToken?: string;
  modelStrategy: ModelStrategy;
  modelSource: ModelSource;
  enterpriseModelsUrl?: string;
  providerKeys: Record<string, string>;  // cloud 模式各 provider key
}

export interface WizardResult {
  configYaml: string;
  envVars: Record<string, string>;
}

export function isSetupComplete(): boolean {
  return existsSync(getFlagPath());
}

function getFlagPath(): string {
  return process.env.DA_SETUP_FLAG || resolve(process.cwd(), "data/setup-complete.flag");
}

function getConfigPath(): string {
  return process.env.DA_CONFIG_PATH || resolve(process.cwd(), "data/config.yaml");
}

export async function markSetupComplete(): Promise<void> {
  mkdirSync(resolve(getFlagPath(), ".."), { recursive: true });
  writeFileSync(getFlagPath(), new Date().toISOString());
}

export function runWizard(input: WizardInput): WizardResult {
  const configYaml = generateConfigYaml(input);
  const envVars = generateEnvVars(input);
  return { configYaml, envVars };
}

function generateConfigYaml(input: WizardInput): string {
  const lines: string[] = [
    "# DeepAnalyze configuration (generated by setup wizard)",
    `generated_at: ${new Date().toISOString()}`,
    "",
    "models:",
    `  source: ${input.modelSource}`,
  ];
  if (input.enterpriseModelsUrl) {
    lines.push(`  enterprise_url: ${input.enterpriseModelsUrl}`);
  }
  if (input.modelStrategy === "all_cloud" || input.modelStrategy === "hybrid") {
    lines.push("", "providers:");
    for (const [k, v] of Object.entries(input.providerKeys)) {
      lines.push(`  ${k}: ${v}`);
    }
  }
  return lines.join("\n") + "\n";
}

function generateEnvVars(input: WizardInput): Record<string, string> {
  const env: Record<string, string> = {};
  if (input.mode === "enterprise_worker") {
    env.DA_AUTH_MODE = "hub";
    env.DA_HUB_URL = input.hubUrl!;
    env.DA_JOIN_TOKEN = input.joinToken!;
  } else if (input.authChoice === "local") {
    env.DA_AUTH_MODE = "local";
  } else {
    env.DA_AUTH_MODE = "none";
  }
  return env;
}

export async function saveConfig(result: WizardResult): Promise<void> {
  mkdirSync(resolve(getConfigPath(), ".."), { recursive: true });
  writeFileSync(getConfigPath(), result.configYaml);
  // 写 .env 变量追加（如果不存在）
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const { readFileSync, appendFileSync } = await import("node:fs");
    const existing = readFileSync(envPath, "utf-8");
    const newLines = Object.entries(result.envVars)
      .filter(([k]) => !existing.includes(`${k}=`))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    if (newLines) appendFileSync(envPath, "\n# Setup wizard generated\n" + newLines + "\n");
  }
  await markSetupComplete();
}
```

- [ ] **Step 2: 测试**

```typescript
import { describe, test, expect } from "vitest";
import { runWizard, isSetupComplete } from "../src/setup/wizard.js";

describe("runWizard", () => {
  test("personal + none mode", () => {
    const r = runWizard({
      environment: {} as any,
      mode: "personal", authChoice: "none",
      modelStrategy: "all_cloud", modelSource: "auto",
      providerKeys: {},
    });
    expect(r.configYaml).toContain("source: auto");
    expect(r.envVars.DA_AUTH_MODE).toBe("none");
  });

  test("enterprise worker mode", () => {
    const r = runWizard({
      environment: {} as any,
      mode: "enterprise_worker",
      modelStrategy: "all_local", modelSource: "enterprise",
      hubUrl: "https://hub.corp.com", joinToken: "djt_xxx",
      providerKeys: {},
    });
    expect(r.envVars.DA_AUTH_MODE).toBe("hub");
    expect(r.envVars.DA_HUB_URL).toBe("https://hub.corp.com");
  });

  test("local mode", () => {
    const r = runWizard({
      environment: {} as any,
      mode: "personal", authChoice: "local",
      adminUsername: "admin", adminPassword: "test123",
      modelStrategy: "hybrid", modelSource: "hf_mirror",
      providerKeys: { openrouter: "sk-xxx" },
    });
    expect(r.envVars.DA_AUTH_MODE).toBe("local");
    expect(r.configYaml).toContain("openrouter: sk-xxx");
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/setup/wizard.ts tests/wizard.test.ts
git commit -m "feat(da): setup wizard state machine — 6 phases + config.yaml generator"
```

---

### Task G3: src/setup/web-wizard-routes.ts — Web 向导 HTTP 路由

**Files:**
- Create: `src/setup/web-wizard-routes.ts`
- Modify: `src/server/app.ts`
- Test: `tests/wizard.test.ts`

**Interfaces:**
- Produces: `GET /setup/state` — 当前向导状态
- Produces: `GET /setup/environment` — Phase 1 检测结果
- Produces: `POST /setup/complete` — 提交所有阶段输入，产出 config + 标记完成

- [ ] **Step 1: 创建路由**

```typescript
// =============================================================================
// src/setup/web-wizard-routes.ts
// =============================================================================

import { Hono } from "hono";
import { detectEnvironment } from "./environment.js";
import { runWizard, saveConfig, isSetupComplete, type WizardInput } from "./wizard.js";
import { downloadModel, type ModelSource } from "../services/model-downloader.js";
import { hashPassword } from "../services/auth/local-idp.js";
import { getRepos } from "../store/repos/index.js";

export function createSetupRoutes(): Hono {
  const app = new Hono();

  // GET /api/setup/state
  app.get("/state", (c) => c.json({ complete: isSetupComplete() }));

  // GET /api/setup/environment
  app.get("/environment", async (c) => {
    const env = await detectEnvironment();
    return c.json(env);
  });

  // POST /api/setup/complete — 接受全部输入
  app.post("/complete", async (c) => {
    if (isSetupComplete()) {
      return c.json({ error: "setup already complete" }, 409);
    }
    const input = await c.req.json<WizardInput>();

    // Phase 3: 创建管理员账号（local 模式）
    if (input.mode === "personal" && input.authChoice === "local"
        && input.adminUsername && input.adminPassword) {
      const repo = (await getRepos()).settings;
      const hash = await hashPassword(input.adminPassword);
      await repo.set("auth", {
        mode: "local", username: input.adminUsername, passwordHash: hash,
      });
    }

    const result = runWizard(input);
    await saveConfig(result);

    // Phase 5: 后台触发模型下载（不阻塞响应）
    if (input.modelStrategy !== "all_cloud" && input.modelSource !== "manual") {
      // 由前端轮询触发，避免阻塞
    }

    return c.json({ ok: true, envVars: result.envVars });
  });

  // POST /api/setup/download — 触发单个模型下载（前端轮询调用）
  app.post("/download", async (c) => {
    const body = await c.req.json<{ modelName: string; source: ModelSource }>();
    // 异步启动下载（实际生产用 job queue）
    downloadModel(body.modelName, body.source, (p) => {
      console.log(`[wizard-download] ${p.fileName}: ${p.percent.toFixed(1)}%`);
    }).catch(err => console.error("[wizard-download] failed:", err));
    return c.json({ ok: true, message: "download started" }, 202);
  });

  return app;
}
```

- [ ] **Step 2: 在 app.ts 挂载**

```typescript
import { createSetupRoutes } from "./setup/web-wizard-routes.js";
// ...
app.route("/api/setup", createSetupRoutes());
```

- [ ] **Step 3: Commit**

```bash
git add src/setup/web-wizard-routes.ts src/server/app.ts
git commit -m "feat(da): setup wizard HTTP routes (state/environment/complete/download)"
```

---

### Task G4: CLI 向导 src/setup/cli-wizard.ts

**Files:**
- Modify: `package.json`（加 `@clack/prompts` 依赖）
- Create: `src/setup/cli-wizard.ts`

- [ ] **Step 1: 安装依赖**

```bash
bun add @clack/prompts 2>&1 | tail -3
```

- [ ] **Step 2: 创建 CLI 向导**

```typescript
// =============================================================================
// src/setup/cli-wizard.ts
// =============================================================================

import * as p from "@clack/prompts";
import { detectEnvironment } from "./environment.js";
import { runWizard, saveConfig, isSetupComplete, type WizardInput } from "./wizard.js";
import { hashPassword } from "../services/auth/local-idp.js";
import { getRepos } from "../store/repos/index.js";
import { downloadModel } from "../services/model-downloader.js";

export async function runCliWizard(): Promise<void> {
  p.intro("DeepAnalyze Setup");

  if (isSetupComplete()) {
    p.note("Setup already complete. Delete data/setup-complete.flag to re-run.");
    p.outro("Exiting");
    return;
  }

  // Phase 1
  p.log.step("Detecting environment...");
  const environment = await detectEnvironment();
  p.log.info(`CPU: ${environment.cpu.cores} cores | RAM: ${environment.memory.totalGb} GB`);
  p.log.info(`Disk: ${environment.disk.availableGb} GB available`);
  p.log.info(`GPU: ${environment.gpu.available ? environment.gpu.name : "not detected"}`);

  // Phase 2: 模式选择
  const mode = await p.select({
    message: "运行模式",
    options: [
      { value: "personal", label: "个人版（standalone）" },
      { value: "enterprise_worker", label: "企业 Worker（接入 Hub）" },
    ],
  });
  if (p.isCancel(mode)) { p.cancel("Cancelled"); process.exit(0); }

  let authChoice: "none" | "local" | undefined;
  let adminUsername: string | undefined;
  let adminPassword: string | undefined;
  let hubUrl: string | undefined;
  let joinToken: string | undefined;

  // Phase 3
  if (mode === "personal") {
    const choice = await p.select({
      message: "认证方式",
      options: [
        { value: "none", label: "免登录（直接进入应用）" },
        { value: "local", label: "启用登录（创建管理员账号）" },
      ],
    });
    if (p.isCancel(choice)) { p.cancel("Cancelled"); process.exit(0); }
    authChoice = choice as "none" | "local";

    if (authChoice === "local") {
      adminUsername = await p.text({ message: "管理员用户名", defaultValue: "admin" }) as string;
      const pwd = await p.password({ message: "管理员密码（≥6 位）" });
      if (typeof pwd !== "string" || pwd.length < 6) {
        p.cancel("Password too short"); process.exit(1);
      }
      adminPassword = pwd;
    }
  } else {
    hubUrl = await p.text({ message: "Hub URL", placeholder: "https://hub.corp.com:22000" }) as string;
    joinToken = await p.password({ message: "Join Token" }) as string;
  }

  // Phase 4
  const modelStrategy = await p.select({
    message: "模型策略",
    options: [
      { value: "all_cloud", label: "全部云端 API" },
      { value: "all_local", label: "全部本地（按硬件推荐）" },
      { value: "hybrid", label: "混合（云端 LLM + 本地 embedding）— 推荐" },
      { value: "manual", label: "手动拷贝（指向 data/models/）" },
    ],
  });
  if (p.isCancel(modelStrategy)) { p.cancel("Cancelled"); process.exit(0); }

  const modelSource = await p.select({
    message: "模型下载源",
    options: [
      { value: "auto", label: "自动（按可用性探测）" },
      { value: "hf", label: "HuggingFace 官方" },
      { value: "hf_mirror", label: "中国镜像（hf-mirror.com）" },
      { value: "enterprise", label: "企业内部仓库" },
      { value: "manual", label: "手动（不下载）" },
    ],
  }) as string;
  if (p.isCancel(modelSource)) { p.cancel("Cancelled"); process.exit(0); }

  // Phase 5: 触发下载（如果需要）
  // Phase 6: 健康检查（最后由 supervisor.start() 处理）

  // 完成
  const input: WizardInput = {
    environment, mode: mode as any, authChoice: authChoice as any,
    adminUsername, adminPassword, hubUrl, joinToken,
    modelStrategy: modelStrategy as any,
    modelSource: modelSource as any,
    providerKeys: {},
  };

  if (authChoice === "local" && adminUsername && adminPassword) {
    const repo = (await getRepos()).settings;
    const hash = await hashPassword(adminPassword);
    await repo.set("auth", { mode: "local", username: adminUsername, passwordHash: hash });
  }

  const result = runWizard(input);
  await saveConfig(result);

  p.outro("Setup complete! Restart DeepAnalyze to apply.");
}

// 入口：package.json bin "da-setup"
if (import.meta.url === `file://${process.argv[1]}`) {
  runCliWizard().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 3: 在 `package.json` 加 bin**

```json
"bin": {
  "da-setup": "src/setup/cli-wizard.ts"
},
```

- [ ] **Step 4: 在 `src/main.ts` 中检测：如果 stdout 是 TTY 且未完成 setup，启动 CLI 向导**

```typescript
import { isSetupComplete } from "./setup/wizard.js";
import { runCliWizard } from "./setup/cli-wizard.js";

if (process.stdout.isTTY && !isSetupComplete() && !process.env.DA_SKIP_WIZARD) {
  await runCliWizard();
}
```

- [ ] **Step 5: 测试 + Commit**

```bash
bun run src/setup/cli-wizard.ts  # 手工测试（需要 stdin 输入）
```

```bash
git add src/setup/cli-wizard.ts src/main.ts package.json
git commit -m "feat(da): CLI setup wizard via @clack/prompts"
```

---

### Task G5: 前端 SetupWizard 组件

**Files:**
- Create: `frontend/src/components/auth/SetupWizard.tsx`
- Modify: `frontend/src/router.tsx`

- [ ] **Step 1: 创建组件**

```tsx
// frontend/src/components/auth/SetupWizard.tsx
import { useState, useEffect } from "react";

const STEPS = ["环境检测", "模式选择", "认证配置", "模型策略", "模型下载", "完成"];

export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const [env, setEnv] = useState<any>(null);
  const [input, setInput] = useState<any>({});

  useEffect(() => {
    fetch(`${API_BASE}/api/setup/environment`)
      .then(r => r.json())
      .then(setEnv)
      .catch(() => setStep(0));
  }, []);

  const next = () => setStep(s => Math.min(s + 1, STEPS.length - 1));
  const prev = () => setStep(s => Math.max(s - 1, 0));

  const finish = async () => {
    await fetch(`${API_BASE}/api/setup/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    onComplete();
  };

  return (
    <div className="setup-wizard">
      <Stepper steps={STEPS} current={step} />
      <div className="setup-content">
        {step === 0 && <EnvPanel env={env} onNext={next} />}
        {step === 1 && <ModePanel input={input} setInput={setInput} onNext={next} />}
        {step === 2 && <AuthPanel input={input} setInput={setInput} onNext={next} onPrev={prev} />}
        {step === 3 && <ModelStrategyPanel input={input} setInput={setInput} onNext={next} onPrev={prev} />}
        {step === 4 && <DownloadPanel input={input} onNext={next} onPrev={prev} />}
        {step === 5 && <CompletionPanel onFinish={finish} />}
      </div>
    </div>
  );
}

// Stepper / EnvPanel / ModePanel / AuthPanel / ModelStrategyPanel / DownloadPanel / CompletionPanel
// 略：每个 panel 是表单组件，根据 input 选项更新 setInput
```

- [ ] **Step 2: 在 router 中加 `/setup`**

```typescript
import { SetupWizard } from "./components/auth/SetupWizard";
// ...
{ path: "/setup", element: <SetupWizard onComplete={() => window.location.reload()} /> },
```

- [ ] **Step 3: App.tsx 检测 setup 状态**

```typescript
// 在 useAuthGate 之前
useEffect(() => {
  fetch(`${API_BASE}/api/setup/state`)
    .then(r => r.json())
    .then(({ complete }) => {
      if (!complete) window.location.hash = "#/setup";
    });
}, []);
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/auth/SetupWizard.tsx frontend/src/router.tsx frontend/src/App.tsx
git commit -m "feat(da-fe): 6-step setup wizard UI"
```

---

## Phase H: HubClient 扩展

### Task H1: connectToHub / disconnectFromHub + JWKS sync 整合

**Files:**
- Modify: `src/services/hub/hub-client.ts`
- Test: `tests/hub-client.test.ts`

**Interfaces:**
- Produces: `hubClient.connectToHub(hubUrl, joinToken): Promise<{ workerToken: string }>` — 用 join_token 注册
- Produces: `hubClient.disconnectFromHub(): Promise<void>` — 调 `/api/v1/workers/me/deactivate`
- Produces: `hubClient.fetchModelManifest(name): Promise<any>`
- Produces: `hubClient.fetchModelBlob(sha256): Promise<Buffer>`

- [ ] **Step 1: 在 `hub-client.ts` 加方法**

```typescript
// connectToHub: 用 join_token 注册并保存 worker_token
async connectToHub(
  hubUrl: string,
  joinToken: string,
): Promise<{ workerToken: string; workerId: string }> {
  const resp = await fetch(`${hubUrl}/api/v1/workers/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      join_token: joinToken,
      hostname: os.hostname(),
      protocol_version: 2,
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Hub registration failed: ${err.error || resp.status}`);
  }
  const data = await resp.json();
  this.config.serverUrl = hubUrl;
  this.config.workerToken = data.worker_token;
  this.config.workerId = data.worker_id;

  // 持久化到 settings
  const { getRepos } = await import("../../store/repos/index.js");
  const repo = (await getRepos()).settings;
  await repo.set("hub_connection", {
    connected: true,
    hubUrl,
    workerId: data.worker_id,
    workerToken: data.worker_token,
  });

  return { workerToken: data.worker_token, workerId: data.worker_id };
}

async disconnectFromHub(): Promise<void> {
  if (!this.config.serverUrl || !this.config.workerToken) return;
  try {
    await fetch(`${this.config.serverUrl}/api/v1/workers/me/deactivate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.workerToken}` },
    });
  } catch {}

  this.stopHeartbeat();
  this.config.workerToken = undefined;
  this.config.serverUrl = undefined;

  const { getRepos } = await import("../../store/repos/index.js");
  const repo = (await getRepos()).settings;
  await repo.set("hub_connection", { connected: false });
}

isConnected(): boolean {
  return !!this.config.serverUrl && !!this.config.workerToken;
}

// 模型 manifest 拉取
async fetchModelManifest(modelName: string): Promise<any | null> {
  if (!this.config.serverUrl) return null;
  try {
    const resp = await fetch(`${this.config.serverUrl}/api/v1/models/manifests/${modelName}`, {
      headers: { Authorization: `Bearer ${this.config.workerToken}` },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

async fetchModelBlob(sha256: string): Promise<Buffer | null> {
  if (!this.config.serverUrl) return null;
  try {
    const resp = await fetch(`${this.config.serverUrl}/api/v1/models/blobs/${sha256}`, {
      headers: { Authorization: `Bearer ${this.config.workerToken}` },
    });
    if (!resp.ok) return null;
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  } catch { return null; }
}
```

- [ ] **Step 2: 测试**

```typescript
import { describe, test, expect } from "vitest";
// Mock fetch
describe("HubClient extensions", () => {
  test("connectToHub stores worker token", async () => {
    // mock fetch
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      if (url.includes("/workers/register")) {
        return new Response(JSON.stringify({
          worker_id: "wkr_test", worker_token: "wkt_test",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 404 });
    }) as any;

    const client = new HubClient({ workerId: "test" } as any);
    const result = await client.connectToHub("http://hub:22000", "djt_xxx");
    expect(result.workerToken).toBe("wkt_test");
    expect(client.isConnected()).toBe(true);

    globalThis.fetch = origFetch;
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/services/hub/hub-client.ts tests/hub-client.test.ts
git commit -m "feat(da): hubclient extensions — connect/disconnect/fetch-model-manifest"
```

---

## Phase I: Dockerfile 重构

### Task I1: Dockerfile.base（~500MB）

**Files:**
- Create: `Dockerfile.base`
- Modify: `Dockerfile`（指向 base 或重命名）

- [ ] **Step 1: 创建 Dockerfile.base**

```dockerfile
# =============================================================================
# DeepAnalyze - Base Image (~500MB)
# =============================================================================
# 仅含 Bun + Python3 + DA backend + frontend dist。
# 不含 torch/onnx/whisper/docling — 这些在 da:full 或运行时按需 pip。
# =============================================================================

FROM oven/bun:1

WORKDIR /app

# 系统依赖（最小）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖（最小：仅 docling 占位符 + 通用工具）
RUN pip3 install --no-cache-dir --break-system-packages \
    httpx

# 后端依赖
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production

# 复制源码
COPY src/ ./src/
COPY da-assets/ ./da-assets/
COPY start.py ./

# 前端构建产物（在外部 build 后复制）
COPY frontend/dist/ ./frontend/dist/

ENV NODE_ENV=production
ENV DA_AUTH_MODE=none
ENV DA_SKIP_WIZARD=true  # docker 模式不弹 TTY 向导

EXPOSE 21000
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD wget -q --spider http://localhost:21000/api/health || exit 1

CMD ["bun", "run", "src/main.ts"]
```

- [ ] **Step 2: 修改 Dockerfile 指向 base（或新建 Dockerfile.full）**

```dockerfile
# Dockerfile.full — 继承 base + 全部 ML 依赖 + 预下载权重
FROM deepanalyze/da:base AS base-full

RUN pip3 install --no-cache-dir --break-system-packages \
    torch sentence-transformers \
    onnxruntime \
    openai-whisper \
    docling \
    paddleocr-vl

# 预下载权重（可选，也可让向导处理）
# RUN python3 -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-m3')"
```

- [ ] **Step 3: 修改 docker-compose.yml 默认用 base**

```yaml
backend:
  build:
    context: .
    dockerfile: Dockerfile.base   # 改这里
  ports:
    - "21000:21000"
  volumes:
    - ./data:/app/data
```

- [ ] **Step 4: 验证镜像大小**

```bash
docker build -f Dockerfile.base -t da:base-test .
docker images da:base-test  # 检查大小 < 800MB
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile.base Dockerfile.full Dockerfile docker-compose.yml
git commit -m "feat(da): split Dockerfile into base (~500MB) + full (~3GB)"
```

---

### Task I2: emergency-reset CLI 子命令

**Files:**
- Create: `src/setup/emergency-reset.ts`
- Modify: `package.json`

- [ ] **Step 1: 创建**

```typescript
// =============================================================================
// src/setup/emergency-reset.ts
// =============================================================================
// 紧急恢复：Hub 长期不可达时，临时切换为 local 模式并创建 emergency-admin。
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { hashPassword } from "../services/auth/local-idp.js";
import { getRepos } from "../store/repos/index.js";

export async function emergencyReset(): Promise<void> {
  console.log("=== DeepAnalyze Emergency Reset ===");

  // Step 1: 校验 recovery.key
  const recoveryKeyPath = process.env.DA_RECOVERY_KEY || resolve(process.cwd(), "data/auth/recovery.key");
  if (!existsSync(recoveryKeyPath)) {
    console.error(`Recovery key not found: ${recoveryKeyPath}`);
    console.error("This command must be run on the DA server itself.");
    process.exit(1);
  }

  // Step 2: 临时切到 local 模式
  process.env.DA_AUTH_MODE = "local";

  // Step 3: 创建 emergency-admin（24h 过期）
  const tempPassword = randomBytes(8).toString("hex");
  const username = "emergency-admin";
  const hash = await hashPassword(tempPassword);

  const repo = (await getRepos()).settings;
  await repo.set("auth", {
    mode: "local",
    username,
    passwordHash: hash,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    emergency: true,
  });

  // Step 4: 输出凭证
  console.log("\n========================================");
  console.log("Emergency admin credentials (24h):");
  console.log(`  Username: ${username}`);
  console.log(`  Password: ${tempPassword}`);
  console.log("========================================\n");
  console.log("Once Hub is restored, switch back:");
  console.log("  1. Set DA_AUTH_MODE=hub");
  console.log("  2. Restart DA");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  emergencyReset().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: 在 package.json 加 bin**

```json
"bin": {
  "da-setup": "src/setup/cli-wizard.ts",
  "da-admin": "src/setup/emergency-reset.ts"
},
```

- [ ] **Step 3: 在首次启动时生成 recovery.key**

在 `src/main.ts` 启动时检查：

```typescript
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

const recoveryKeyPath = resolve(process.cwd(), "data/auth/recovery.key");
if (!existsSync(recoveryKeyPath)) {
  mkdirSync(resolve(recoveryKeyPath, ".."), { recursive: true });
  writeFileSync(recoveryKeyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
}
```

- [ ] **Step 4: Commit**

```bash
git add src/setup/emergency-reset.ts src/main.ts package.json
git commit -m "feat(da): emergency-reset CLI for hub outage recovery"
```

---

## Phase J: E2E 测试 + 文档

### Task J1: Playwright E2E — 登录流程

**Files:**
- Create: `tests/e2e/auth-flow.spec.ts`

- [ ] **Step 1: 写测试**

```typescript
import { test, expect } from "@playwright/test";

test.describe("Auth flow", () => {
  test("local mode setup + login", async ({ page }) => {
    await page.goto("http://localhost:21000/#/setup");

    // Phase 1: 环境检测自动
    await page.click("text=下一步");

    // Phase 2: 个人版
    await page.click("text=个人版");
    await page.click("text=下一步");

    // Phase 3: 启用登录
    await page.click("text=启用登录");
    await page.fill("[placeholder=用户名]", "admin");
    await page.fill("[placeholder=密码]", "test1234");
    await page.click("text=下一步");

    // Phase 4-6: 默认选项 + 完成
    for (let i = 0; i < 3; i++) {
      await page.click("text=下一步");
      await page.waitForTimeout(500);
    }

    // 登录
    await page.fill("[placeholder=用户名]", "admin");
    await page.fill("[placeholder=密码]", "test1234");
    await page.click("text=登录");

    // 应跳到 #/chat
    await page.waitForURL(/#\/chat/, { timeout: 5000 });
    expect(page.url()).toContain("#/chat");
  });

  test("none mode skips login", async ({ page, request }) => {
    // 先重置 setup
    await request.post("http://localhost:21000/api/setup/reset-test");  // 仅测试环境

    await page.goto("http://localhost:21000");
    // none 模式直接跳 #/chat，无 login
    await page.waitForURL(/#\/chat/, { timeout: 5000 });
  });
});
```

- [ ] **Step 2: 运行**

```bash
DA_AUTH_MODE=local python3 start.py --no-docker --port 21000 &
npx playwright test tests/e2e/auth-flow.spec.ts --reporter=list
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/auth-flow.spec.ts
git commit -m "test(da): e2e auth flow — setup + login + none mode skip"
```

---

### Task J2: 文档 — 分发与认证指南

**Files:**
- Create: `docs/distribution-and-auth.md`

- [ ] **Step 1: 创建文档**

```markdown
# DeepAnalyze 分发与认证指南

## 三种认证模式

| 模式 | 环境变量 | 场景 |
|------|----------|------|
| `none` | `DA_AUTH_MODE=none`（默认） | 个人开发，无需登录 |
| `local` | `DA_AUTH_MODE=local` | 个人/小团队，需要密码保护 |
| `hub` | `DA_AUTH_MODE=hub` + `DA_HUB_URL` | 企业部署，Hub SSO |

## 启动流程

1. 检测 `data/config.yaml` 是否存在
   - 存在 → 跳过向导
   - 不存在 → 启动向导（CLI TTY 自动触发，Web 端跳 `/setup`）
2. 加载配置（环境变量 > config.yaml > 默认值）
3. 启动 ModelServiceSupervisor（按需拉子服务）
4. 启动主应用

## 模型下载策略

向导 Phase 4 让用户选：
- `all_cloud` — 仅用云端 API，不下载任何模型
- `all_local` — 全部本地推理，下载所有模型（~5GB）
- `hybrid` — 云端 LLM + 本地 embedding，下载 BGE-M3（~2.2GB）
- `manual` — 用户预先把权重放到 `data/models/`

## 切换认证模式

修改 `.env` 中的 `DA_AUTH_MODE` 后重启 DA 即可：
- `none → local`：首次启动需 POST `/api/auth/setup` 设置管理员
- `local → hub`：DA 启动时自动拉取 Hub JWKS 公钥
- `hub → local`：紧急情况下 `da-admin` 命令恢复

## 紧急恢复

Hub 长期不可达（>7 天）导致 JWT 全部过期时：

```bash
docker exec -it da-{user} da-admin
```

按提示获得 24h 临时管理员账号。Hub 恢复后改回 `DA_AUTH_MODE=hub`。
```

- [ ] **Step 2: Commit**

```bash
git add docs/distribution-and-auth.md
git commit -m "docs(da): distribution and auth guide (3 modes + wizard + recovery)"
```

---

## 自检 Checklist

实施完成后逐项确认：

- [ ] **none 模式向下兼容**：`DA_AUTH_MODE` 未设 → 行为完全等于改造前（curl 能访问所有 API）
- [ ] **local 模式 setup + login**：浏览器向导走完 → 登录页可登录 → 跳 `/chat`
- [ ] **hub 模式 JWKS**：DA 启动时拉取 JWKS 公钥并写入 `data/auth/hub-jwks.json`
- [ ] **JWKS 离线降级**：Hub 关停后 DA 仍能验签已签的 JWT（用缓存公钥）
- [ ] **ModelDownloader sha256**：模拟文件篡改，下载后检测 sha 不匹配自动重试或换源
- [ ] **ModelServiceSupervisor 缺权重检测**：删除 `data/models/bge-m3/` → status 变 `missing_weights`
- [ ] **向导幂等**：`data/setup-complete.flag` 存在时跳过向导
- [ ] **Dockerfile.base 大小**：`docker images da:base` < 800MB
- [ ] **emergency-reset**：删除 `data/auth/recovery.key` 后命令拒绝运行
- [ ] **typecheck**：`tsc --noEmit` 无错误
- [ ] **现有 e2e 测试不破坏**：`tests/e2e/01-smoke.spec.ts` 在 none 模式下仍通过
```

---

## 与 Hub plan 的接口对齐

实施前确认这些端点形状与 Hub plan 完全一致：

| DA 调用 | Hub 提供端点 | 形状 |
|---------|------------|------|
| `GET {DA_HUB_URL}/api/v1/auth/jwks.json` | Hub A3 | `{ keys: Jwk[] }` |
| `POST {DA_HUB_URL}/api/v1/auth/login` | Hub 已有 | `{ access_token, refresh_token, expires_in }` |
| `POST {DA_HUB_URL}/api/v1/workers/register` body `join_token` | Hub B3 | 接受 `join_token` 字段，返回 `{ worker_id, worker_token }` |
| `POST {DA_HUB_URL}/api/v1/workers/me/deactivate` | Hub B4 | `{ status: "deactivated" }` |
| `GET {DA_HUB_URL}/api/v1/models/manifests/:name` | Hub D2 | `ModelManifest` JSON |
| `GET {DA_HUB_URL}/api/v1/models/blobs/:sha256` | Hub D2 | octet-stream |
| `GET {DA_HUB_URL}/api/v1/images/:name.tar` | Hub E2 | tar stream |
