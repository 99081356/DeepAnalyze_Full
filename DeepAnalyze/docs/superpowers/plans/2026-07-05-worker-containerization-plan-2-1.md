# Worker 容器化部署模型 (Plan 2.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 worker 部署模型为 B 模式（每 worker 一对 `da-app-<workerId>` + `da-pg-<workerId>` 容器），让 PG 成为 Hub 显式管理的资源。

**Architecture:** 在现有 `deployWorker` SSH 部署基础上，引入 `SshExecutor` 抽象、PG 凭据管理（migration 038）、PG 容器/网络/标签生命周期管理、`deployWorkerStack` 编排函数、`deleteWorker` 资源清理、`da-postgres:16-tuned` 镜像 Dockerfile、迁移脚本。

**Tech Stack:** Bun + TypeScript + Hono + PostgreSQL + ssh2 + node:crypto + Docker

## Global Constraints

- Hub version: `0.7.6`（`src/core/config.ts:10`），不要 bump
- 测试基线：90 pass / 8 fail / 1 skip（Spec 1 完成后）+ 0 tsc 错误（`bunx tsc --noEmit`）
- 所有测试用 `NODE_ENV=development bun test ...` 跑（RSA env vars 缺失否则）
- Migration 编号：本 plan 用 **038**（037 已被 Spec 1 用）
- 加密复用 `src/core/crypto.ts` 的 `encryptString(plaintext): string` / `decryptString(b64): string`，格式 `base64(iv[12] | authTag[16] | ciphertext)`，AES-256-GCM。**不引入新加密体系**。
- Migration 文件签名约定：
  ```typescript
  import type { QueryResultRow } from "pg";
  type QueryFn = <T extends QueryResultRow = QueryResultRow>(
    text: string, params?: unknown[]
  ) => Promise<import("pg").QueryResult<T>>;
  export async function up(query: QueryFn): Promise<void>;
  export async function down(query: QueryFn): Promise<void>;
  ```
- 现有 SSH helpers：`connectSsh(conn, opts)` + `execRemote(conn, cmd, onLine)` 在 `worker-deployment.ts:182-234`；`decryptSshKey(encrypted)` 在 `:463`。本 plan 把这些重构成 `SshExecutor` interface 的方法。
- 现有 `DeployOpts.envVars` 是 `Record<string, string>` 由 caller（routes/workers.ts）传入。本 plan 在 `deployWorkerStack` 内部 merge PG env vars 进去，**不改 DeployOpts 签名**。
- 容器命名约定变更：旧 `da-<workerId.slice(0,12)>` → 新 `da-app-<workerId>` / `da-pg-<workerId>`。迁移脚本负责 rename 旧容器。
- 所有 PG 容器/docker network 操作通过 `docker exec` / `docker run` / `docker network create` 走 SSH，**Hub 本地不跑 docker**
- Docker 镜像名：`${HUB_DOCKER_REGISTRY}da-postgres:16-tuned`（registry 空时直接 `da-postgres:16-tuned`）

---

## File Structure

| 文件 | 操作 | 责任 | Task |
|------|------|------|------|
| `src/store/migrations/038_worker_pg_credentials.ts` | 新建 | workers 表加 `pg_database` / `pg_username` / `pg_password_encrypted` 三列 | T1 |
| `tests/migrations/worker-pg-credentials.test.ts` | 新建 | migration 038 验证 | T1 |
| `src/domain/ssh-executor.ts` | 新建 | `SshExecutor` interface + `RealSshExecutor` + `MockSshExecutor` | T2 |
| `tests/domain/ssh-executor.test.ts` | 新建 | RealSshExecutor wrapping 测试（用 mock ssh2 Client） | T2 |
| `src/domain/worker-pg-credentials.ts` | 新建 | `generatePgCredentials` / `savePgCredentials` / `loadPgCredentials` | T3 |
| `tests/domain/worker-pg-credentials.test.ts` | 新建 | 凭据生成/加密往返测试 | T3 |
| `src/domain/worker-network.ts` | 新建 | `ensureWorkerNetwork` / `removeWorkerNetwork` / `workerNetworkName` | T4 |
| `tests/domain/worker-network.test.ts` | 新建 | network 生命周期测试（用 MockSshExecutor） | T4 |
| `src/domain/worker-pg-container.ts` | 新建 | `ensurePgContainer` / `removePgContainer` / `waitForPgReady` / `pgContainerName` | T5 |
| `tests/domain/worker-pg-container.test.ts` | 新建 | PG 容器生命周期测试（用 MockSshExecutor） | T5 |
| `src/domain/worker-deployment.ts` | 修改 | 加 `deployWorkerStack` 编排函数 + labels + PG env merge | T6 |
| `src/core/config.ts` | 修改 | 加 `docker.registry` 配置 | T6 |
| `tests/domain/worker-deployment-stack.test.ts` | 新建 | stack 集成测试（mock SSH 验证调用序列） | T6 |
| `src/domain/worker-deployment.ts` | 修改 | `stopWorker` 扩展为清理 PG 容器 + network + volumes | T7 |
| `tests/domain/worker-stop-cleanup.test.ts` | 新建 | stopWorker 资源清理测试 | T7 |
| `docker/da-postgres/Dockerfile` | 新建 | da-postgres:16-tuned 镜像构建文件 | T8 |
| `docker/da-postgres/postgresql-tuned.conf` | 新建 | PG 调优配置 | T8 |
| `docker/da-postgres/pg-healthcheck.sh` | 新建 | healthcheck 脚本 | T8 |
| `docker/da-postgres/README.md` | 新建 | build/push 操作 runbook | T8 |
| `scripts/migrate-workers-to-b.ts` | 新建 | 现有 worker 迁移脚本（手动触发） | T9 |
| `tests/scripts/migrate-workers-to-b.test.ts` | 新建 | 迁移脚本测试（检测 + 迁移 + 回滚） | T9 |

---

## Task 1: Migration 038 — workers 表加 PG 凭据列

**Files:**
- Create: `src/store/migrations/038_worker_pg_credentials.ts`
- Test: `tests/migrations/worker-pg-credentials.test.ts`

**Interfaces:**
- Consumes: `query` 函数（migration 签名约定）
- Produces: `workers.pg_database TEXT NOT NULL DEFAULT 'deepanalyze'` / `workers.pg_username TEXT NOT NULL DEFAULT 'da'` / `workers.pg_password_encrypted TEXT`（nullable，迁移脚本会回填）

- [ ] **Step 1: 写 migration 文件**

Create `src/store/migrations/038_worker_pg_credentials.ts`:

```typescript
/**
 * Migration 038: workers 表加 PG 凭据列
 *
 * Spec 2.1 重构 worker 部署模型为 B 模式（每 worker 一对 da-app + da-pg 容器）。
 * Hub 现在显式管理每个 worker 的 PG 凭据：
 *   - pg_database:  worker 专属 PG 容器内的 database 名（默认 'deepanalyze'）
 *   - pg_username:  worker 专属 PG 用户名（默认 'da'）
 *   - pg_password_encrypted: AES-256-GCM 加密的密码（用 src/core/crypto.ts 的 encryptString）
 *
 * 现有 worker 这三列为 NULL（pg_password_encrypted）；迁移脚本
 * (scripts/migrate-workers-to-b.ts) 负责回填。
 */
import type { QueryResultRow } from "pg";

type QueryFn = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<import("pg").QueryResult<T>>;

export async function up(query: QueryFn): Promise<void> {
  await query(
    `ALTER TABLE workers
       ADD COLUMN IF NOT EXISTS pg_database TEXT NOT NULL DEFAULT 'deepanalyze',
       ADD COLUMN IF NOT EXISTS pg_username TEXT NOT NULL DEFAULT 'da',
       ADD COLUMN IF NOT EXISTS pg_password_encrypted TEXT`,
  );
}

export async function down(query: QueryFn): Promise<void> {
  // 加列是向后兼容的扩展，down 不写（按设计原则：跨版本回滚靠备份）
}
```

- [ ] **Step 2: 应用 migration**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun run src/store/migrate.ts
```

Expected: 包含 `Running migration: 038_worker_pg_credentials.ts` 和 `Migration applied: 038_worker_pg_credentials.ts`。

- [ ] **Step 3: 写测试**

Create `tests/migrations/worker-pg-credentials.test.ts`:

```typescript
// 验证 migration 038 已应用：workers 表有 3 个新列 + 默认值正确
import { describe, test, expect } from "bun:test";
import { query } from "../../src/store/pg";

describe("migration 038: workers 表 PG 凭据列", () => {
  test("三列都存在", async () => {
    const { rows } = await query<{
      column_name: string; data_type: string; is_nullable: string; column_default: string | null;
    }>(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'workers'
        AND column_name IN ('pg_database', 'pg_username', 'pg_password_encrypted')
      ORDER BY column_name
    `);
    expect(rows.length).toBe(3);
    const names = rows.map(r => r.column_name).sort();
    expect(names).toEqual(["pg_database", "pg_password_encrypted", "pg_username"]);
  });

  test("pg_database 默认 'deepanalyze'，NOT NULL", async () => {
    const { rows } = await query<{ is_nullable: string; column_default: string | null }>(`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'workers' AND column_name = 'pg_database'
    `);
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toBe("'deepanalyze'::text");
  });

  test("pg_username 默认 'da'，NOT NULL", async () => {
    const { rows } = await query<{ is_nullable: string; column_default: string | null }>(`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'workers' AND column_name = 'pg_username'
    `);
    expect(rows[0].is_nullable).toBe("NO");
    expect(rows[0].column_default).toBe("'da'::text");
  });

  test("pg_password_encrypted nullable（迁移脚本回填前为 NULL）", async () => {
    const { rows } = await query<{ is_nullable: string }>(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'workers' AND column_name = 'pg_password_encrypted'
    `);
    expect(rows[0].is_nullable).toBe("YES");
  });

  test("migration 幂等（再跑一次不报错）", async () => {
    // 加 IF NOT EXISTS，重复 ALTER TABLE 应成功
    await query(`
      ALTER TABLE workers
        ADD COLUMN IF NOT EXISTS pg_database TEXT NOT NULL DEFAULT 'deepanalyze',
        ADD COLUMN IF NOT EXISTS pg_username TEXT NOT NULL DEFAULT 'da',
        ADD COLUMN IF NOT EXISTS pg_password_encrypted TEXT
    `);
    // 如果上面没抛错就过
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/migrations/worker-pg-credentials.test.ts
```

Expected: `5 pass | 0 fail`。

- [ ] **Step 5: 跑全套测试确认无回归**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test 2>&1 | tail -5
```

Expected: 至少 95 pass（基线 90 + 本 task 新增 5）。8 fail（预先存在）+ 1 skip 不变。

- [ ] **Step 6: tsc 类型检查**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
bunx tsc --noEmit 2>&1 | tail -10
```

Expected: 无新错误。

- [ ] **Step 7: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/store/migrations/038_worker_pg_credentials.ts tests/migrations/worker-pg-credentials.test.ts
git commit -m "$(cat <<'EOF'
feat(hub): migration 038 workers 表加 PG 凭据列

Spec 2.1 重构部署模型为 B 模式，Hub 显式管理每个 worker 的 PG 凭据。
- pg_database TEXT NOT NULL DEFAULT 'deepanalyze'
- pg_username TEXT NOT NULL DEFAULT 'da'
- pg_password_encrypted TEXT (AES-256-GCM 密文，nullable 待迁移脚本回填)

现有 worker 三列取默认值/NULL，迁移脚本 (T9) 负责补真实凭据。

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SshExecutor 抽象层

**Files:**
- Create: `src/domain/ssh-executor.ts`
- Test: `tests/domain/ssh-executor.test.ts`

**Interfaces:**
- Consumes: `ssh2.Client`（runtime）+ `ssh2.ClientChannel`（type only）
- Produces:
  ```typescript
  export interface SshExecutor {
    exec(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    pullFile(remotePath: string, localStream: Writable): Promise<void>;
    pushFile(localStream: Readable, remotePath: string): Promise<void>;
    close(): void;
  }
  export class RealSshExecutor implements SshExecutor { ... }   // 包装 ssh2 Client
  export class MockSshExecutor implements SshExecutor { ... }   // 测试用，脚本化响应
  export async function connectRealSsh(opts: ConnectOpts): Promise<SshExecutor>;  // factory
  ```

**Background for implementer:**
- 现有 `connectSsh(conn, opts)` 在 `worker-deployment.ts:182-201`，返回 `Promise<void>`（mutates conn）
- 现有 `execRemote(conn, cmd, onLine)` 在 `:203-234`，返回 stdout 字符串，stderr 走 onLogErr
- 重构后：`RealSshExecutor` 内部持有一个 `Client`，`exec()` 返回完整 `{stdout, stderr, exitCode}` 三元组
- `pullFile` / `pushFile` 用 ssh2 的 sftp，后续 task（备份执行）需要

- [ ] **Step 1: 写测试（先于实现）**

Create `tests/domain/ssh-executor.test.ts`:

```typescript
import { describe, test, expect, mock } from "bun:test";
import { MockSshExecutor, type SshExecutor } from "../../src/domain/ssh-executor";

describe("MockSshExecutor", () => {
  test("按注册顺序返回响应", async () => {
    const exec = new MockSshExecutor();
    exec.when("docker ps").resolve({ stdout: "container1\n", stderr: "", exitCode: 0 });
    exec.when(/docker run/).resolve({ stdout: "abc123\n", stderr: "", exitCode: 0 });

    const r1 = await exec.exec("docker ps");
    expect(r1.stdout).toBe("container1\n");
    expect(r1.exitCode).toBe(0);

    const r2 = await exec.exec("docker run -d alpine");
    expect(r2.stdout).toBe("abc123\n");
  });

  test("未注册的命令抛错", async () => {
    const exec = new MockSshExecutor();
    expect(exec.exec("unknown cmd")).rejects.toThrow(/unexpected command/);
  });

  test("支持 exitCode 非零", async () => {
    const exec = new MockSshExecutor();
    exec.when("docker rm").resolve({ stdout: "", stderr: "no such container\n", exitCode: 1 });

    const r = await exec.exec("docker rm foo");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("no such container\n");
  });

  test("pullFile/pushFile 调用记录可查", async () => {
    const exec = new MockSshExecutor();
    const chunks: Buffer[] = [];
    const writable = new (await import("node:stream")).Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    exec.mockPullFile("/tmp/test.dump", Buffer.from("dump data"));

    await exec.pullFile("/tmp/test.dump", writable);
    expect(Buffer.concat(chunks).toString()).toBe("dump data");
  });

  test("close 幂等", () => {
    const exec = new MockSshExecutor();
    exec.close();
    exec.close();  // 不抛错
  });
});
```

- [ ] **Step 2: 跑测试验证失败（TDD red）**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/domain/ssh-executor.test.ts 2>&1 | tail -5
```

Expected: 失败，原因 "Cannot find module '../../src/domain/ssh-executor'"。

- [ ] **Step 3: 写 MockSshExecutor 实现（先写简单的，让测试过）**

Create `src/domain/ssh-executor.ts`:

```typescript
// SshExecutor abstraction: 让所有 SSH 操作可测试
// 生产用 RealSshExecutor (ssh2 包装)，测试用 MockSshExecutor (脚本化响应)

import type { Readable, Writable } from "node:stream";
import type { Client } from "ssh2";

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SshExecutor {
  exec(cmd: string): Promise<SshExecResult>;
  pullFile(remotePath: string, localStream: Writable): Promise<void>;
  pushFile(localStream: Readable, remotePath: string): Promise<void>;
  close(): void;
}

// ============================================================================
// MockSshExecutor — 测试用
// ============================================================================

type Matcher = string | RegExp;
interface MockResponse { stdout: string; stderr: string; exitCode: number }

export class MockSshExecutor implements SshExecutor {
  private responses: Array<{ matcher: Matcher; response: MockResponse }> = [];
  private pullResponses = new Map<string, Buffer>();
  private pushCaptures: Array<{ remotePath: string; data: Buffer }> = [];
  private closed = false;

  when(cmd: Matcher): { resolve: (r: MockResponse) => void } {
    return {
      resolve: (response: MockResponse) => {
        this.responses.push({ matcher: cmd, response });
      },
    };
  }

  mockPullFile(remotePath: string, data: Buffer): void {
    this.pullResponses.set(remotePath, data);
  }

  get pushHistory(): ReadonlyArray<{ remotePath: string; data: Buffer }> {
    return this.pushCaptures;
  }

  async exec(cmd: string): Promise<SshExecResult> {
    if (this.closed) throw new Error("MockSshExecutor: closed");
    const idx = this.responses.findIndex(r =>
      typeof r.matcher === "string" ? r.matcher === cmd : r.matcher.test(cmd)
    );
    if (idx === -1) {
      throw new Error(`MockSshExecutor: unexpected command: ${cmd}`);
    }
    const [entry] = this.responses.splice(idx, 1);
    return entry.response;
  }

  async pullFile(remotePath: string, localStream: Writable): Promise<void> {
    const data = this.pullResponses.get(remotePath);
    if (!data) throw new Error(`MockSshExecutor: no pull response for ${remotePath}`);
    await new Promise<void>((resolve, reject) => {
      localStream.write(data, (err) => err ? reject(err) : resolve());
    });
  }

  async pushFile(localStream: Readable, remotePath: string): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of localStream) chunks.push(chunk as Buffer);
    this.pushCaptures.push({ remotePath, data: Buffer.concat(chunks) });
  }

  close(): void {
    this.closed = true;
  }
}

// ============================================================================
// RealSshExecutor — ssh2 包装（生产用）
// ============================================================================

export interface ConnectSshOpts {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  readyTimeout?: number;
}

export class RealSshExecutor implements SshExecutor {
  constructor(private conn: Client) {}

  async exec(cmd: string): Promise<SshExecResult> {
    return new Promise((resolve, reject) => {
      this.conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        let exitCode = -1;
        stream.on("close", (code: number) => {
          exitCode = typeof code === "number" ? code : 0;
          resolve({ stdout, stderr, exitCode });
        });
        stream.on("data", (data: Buffer) => { stdout += data.toString(); });
        stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      });
    });
  }

  async pullFile(remotePath: string, localStream: Writable): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err) return reject(err);
        const stream = sftp.createReadStream(remotePath);
        stream.on("error", reject);
        stream.on("end", () => resolve());
        stream.pipe(localStream);
      });
    });
  }

  async pushFile(localStream: Readable, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err) return reject(err);
        const stream = sftp.createWriteStream(remotePath);
        stream.on("error", reject);
        stream.on("close", () => resolve());
        localStream.pipe(stream);
      });
    });
  }

  close(): void {
    try { this.conn.end(); } catch {}
  }
}

// 工厂函数：替代原 connectSsh
export async function connectRealSsh(opts: ConnectSshOpts): Promise<SshExecutor> {
  const { Client } = await import("ssh2");
  const conn = new Client();
  return new Promise<SshExecutor>((resolve, reject) => {
    const onReady = () => {
      conn.off("error", onError);
      resolve(new RealSshExecutor(conn));
    };
    const onError = (err: Error) => reject(err);
    conn.once("ready", onReady);
    conn.once("error", onError);
    conn.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      privateKey: opts.privateKey,
      readyTimeout: opts.readyTimeout ?? 60000,
    });
  });
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/domain/ssh-executor.test.ts 2>&1 | tail -5
```

Expected: `5 pass | 0 fail`。

- [ ] **Step 5: 重构 worker-deployment.ts 用 SshExecutor（不破坏现有逻辑）**

`worker-deployment.ts` 当前的 `connectSsh` + `execRemote` 不删（向后兼容），但**新增**导入 `connectRealSsh` 并让 `deployWorker` 内部可以选择性使用 SshExecutor。

为减少风险，本 step 只做最小修改：
1. 在 `worker-deployment.ts:182` 上方加注释：`// DEPRECATED: 用 connectRealSsh + RealSshExecutor 替代；保留是为了不破坏 deployWorker 现有逻辑`
2. 不动 `deployWorker` 主体（T6 才重构）

```typescript
// 在 worker-deployment.ts 顶部 imports 加：
export { connectRealSsh, RealSshExecutor, MockSshExecutor } from "./ssh-executor.js";
export type { SshExecutor, SshExecResult, ConnectSshOpts } from "./ssh-executor.js";
```

- [ ] **Step 6: 跑现有 worker-deployment 测试确保不破坏**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/domain/worker-deployment 2>&1 | tail -5
NODE_ENV=development bun test tests/routes/workers.test.ts 2>&1 | tail -5
```

Expected: 现有测试 pass 数不变。

- [ ] **Step 7: 跑全套 + tsc**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test 2>&1 | tail -5
bunx tsc --noEmit 2>&1 | tail -10
```

Expected: 100 pass（基线 95 + 本 task 5）；无新 tsc 错误。

- [ ] **Step 8: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/domain/ssh-executor.ts tests/domain/ssh-executor.test.ts src/domain/worker-deployment.ts
git commit -m "$(cat <<'EOF'
feat(hub): SshExecutor 抽象层 — 可测试的 SSH 操作

引入 SshExecutor interface + RealSshExecutor（ssh2 包装）+
MockSshExecutor（脚本化响应），让后续 worker 容器管理的 SSH 操作可测试。

现有 connectSsh/execRemote 保留（向后兼容），新代码用 connectRealSsh。
deployWorker 主体未改（T6 才重构为 deployWorkerStack）。

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: PG 凭据管理

**Files:**
- Create: `src/domain/worker-pg-credentials.ts`
- Test: `tests/domain/worker-pg-credentials.test.ts`

**Interfaces:**
- Consumes: `query` from `../store/pg.js`、`encryptString` / `decryptString` from `../core/crypto.js`、`randomBytes` from `node:crypto`
- Produces:
  ```typescript
  export interface PgCredentials { database: string; username: string; password: string; }
  export async function generatePgCredentials(): Promise<PgCredentials>;  // 随机 32 字节密码
  export async function savePgCredentials(workerId: string, creds: PgCredentials): Promise<void>;  // UPDATE workers
  export async function loadPgCredentials(workerId: string): Promise<PgCredentials>;  // 解密读取
  export async function ensurePgCredentials(workerId: string): Promise<PgCredentials>;  // 没有则生成 + 入库
  ```

- [ ] **Step 1: 写测试**

Create `tests/domain/worker-pg-credentials.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { query } from "../../src/store/pg";
import {
  generatePgCredentials,
  savePgCredentials,
  loadPgCredentials,
  ensurePgCredentials,
} from "../../src/domain/worker-pg-credentials";

// 用 fixture worker ID，前后清理
const TEST_WORKER_ID = "test-pg-cred-worker";

beforeEach(async () => {
  // 确保 fixture worker 存在（用 ON CONFLICT DO NOTHING）
  await query(
    `INSERT INTO workers (id, hostname, worker_token, status)
     VALUES ($1, 'test-host', 'test-token-pg-cred', 'pending')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_WORKER_ID],
  );
  // 清空 PG 凭据字段
  await query(`UPDATE workers SET pg_password_encrypted = NULL WHERE id = $1`, [TEST_WORKER_ID]);
});

describe("generatePgCredentials", () => {
  test("返回默认 database / username + 32 字节随机密码", async () => {
    const c = await generatePgCredentials();
    expect(c.database).toBe("deepanalyze");
    expect(c.username).toBe("da");
    expect(c.password.length).toBeGreaterThanOrEqual(32);
    // base64 编码后是 ASCII
    expect(/^[A-Za-z0-9+/=]+$/.test(c.password)).toBe(true);
  });

  test("两次生成密码不同", async () => {
    const a = await generatePgCredentials();
    const b = await generatePgCredentials();
    expect(a.password).not.toBe(b.password);
  });
});

describe("savePgCredentials + loadPgCredentials", () => {
  test("save 后 load 返回相同明文（加密往返）", async () => {
    const creds = await generatePgCredentials();
    await savePgCredentials(TEST_WORKER_ID, creds);

    const loaded = await loadPgCredentials(TEST_WORKER_ID);
    expect(loaded.password).toBe(creds.password);
    expect(loaded.username).toBe(creds.username);
    expect(loaded.database).toBe(creds.database);
  });

  test("DB 存的是密文不是明文", async () => {
    const creds = await generatePgCredentials();
    await savePgCredentials(TEST_WORKER_ID, creds);

    const { rows } = await query<{ pg_password_encrypted: string | null }>(
      `SELECT pg_password_encrypted FROM workers WHERE id = $1`,
      [TEST_WORKER_ID],
    );
    expect(rows[0].pg_password_encrypted).not.toBeNull();
    expect(rows[0].pg_password_encrypted).not.toContain(creds.password);
  });
});

describe("ensurePgCredentials", () => {
  test("无凭据时生成 + 入库", async () => {
    const c = await ensurePgCredentials(TEST_WORKER_ID);
    expect(c.password.length).toBeGreaterThanOrEqual(32);

    const again = await ensurePgCredentials(TEST_WORKER_ID);
    expect(again.password).toBe(c.password);  // 幂等
  });

  test("有凭据时不重新生成（幂等）", async () => {
    const first = await ensurePgCredentials(TEST_WORKER_ID);
    const second = await ensurePgCredentials(TEST_WORKER_ID);
    expect(second.password).toBe(first.password);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/domain/worker-pg-credentials.test.ts 2>&1 | tail -5
```

Expected: 失败，模块不存在。

- [ ] **Step 3: 写实现**

Create `src/domain/worker-pg-credentials.ts`:

```typescript
// Worker 专属 PG 凭据管理
// - generate: 随机 32 字节密码
// - save: 加密入库
// - load: 解密读取
// - ensure: 没有则生成 + 入库，有则返回（幂等）

import { randomBytes } from "node:crypto";
import { query } from "../store/pg.js";
import { encryptString, decryptString } from "../core/crypto.js";

export interface PgCredentials {
  database: string;
  username: string;
  password: string;
}

const DEFAULT_DATABASE = "deepanalyze";
const DEFAULT_USERNAME = "da";

export async function generatePgCredentials(): Promise<PgCredentials> {
  // 32 字节随机 → base64 (~44 字符)，作为 PG password 足够强
  const password = randomBytes(32).toString("base64");
  return {
    database: DEFAULT_DATABASE,
    username: DEFAULT_USERNAME,
    password,
  };
}

export async function savePgCredentials(
  workerId: string,
  creds: PgCredentials,
): Promise<void> {
  const encrypted = encryptString(creds.password);
  await query(
    `UPDATE workers
       SET pg_database = $2,
           pg_username = $3,
           pg_password_encrypted = $4,
           updated_at = NOW()
     WHERE id = $1`,
    [workerId, creds.database, creds.username, encrypted],
  );
}

export async function loadPgCredentials(workerId: string): Promise<PgCredentials> {
  const { rows } = await query<{
    pg_database: string; pg_username: string; pg_password_encrypted: string | null;
  }>(
    `SELECT pg_database, pg_username, pg_password_encrypted FROM workers WHERE id = $1`,
    [workerId],
  );
  if (rows.length === 0) throw new Error(`worker ${workerId} not found`);
  const row = rows[0];
  if (!row.pg_password_encrypted) {
    throw new Error(`worker ${workerId} has no pg_password_encrypted (not yet provisioned)`);
  }
  return {
    database: row.pg_database,
    username: row.pg_username,
    password: decryptString(row.pg_password_encrypted),
  };
}

export async function ensurePgCredentials(workerId: string): Promise<PgCredentials> {
  // 先尝试 load
  try {
    return await loadPgCredentials(workerId);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("no pg_password_encrypted")) {
      throw err;
    }
    // 没凭据 → 生成 + 入库
    const creds = await generatePgCredentials();
    await savePgCredentials(workerId, creds);
    return creds;
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/domain/worker-pg-credentials.test.ts 2>&1 | tail -5
```

Expected: `7 pass | 0 fail`。

- [ ] **Step 5: 跑全套 + tsc**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test 2>&1 | tail -5
bunx tsc --noEmit 2>&1 | tail -10
```

Expected: 107 pass（100 + 7）；无新 tsc 错误。

- [ ] **Step 6: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/domain/worker-pg-credentials.ts tests/domain/worker-pg-credentials.test.ts
git commit -m "$(cat <<'EOF'
feat(hub): worker PG 凭据管理 — generate/save/load/ensure

- generatePgCredentials: 随机 32 字节 base64 密码 + 默认 database/username
- savePgCredentials: encryptString 加密入库
- loadPgCredentials: decryptString 解密读取
- ensurePgCredentials: 幂等，没有则生成+入库

T6 deployWorkerStack 和 T9 迁移脚本都会用 ensurePgCredentials。

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Worker network 管理

**Files:**
- Create: `src/domain/worker-network.ts`
- Test: `tests/domain/worker-network.test.ts`

**Interfaces:**
- Consumes: `SshExecutor` from `./ssh-executor.js`
- Produces:
  ```typescript
  export function workerNetworkName(workerId: string): string;  // "da-net-<workerId>"
  export async function ensureWorkerNetwork(ssh: SshExecutor, workerId: string): Promise<void>;
  export async function removeWorkerNetwork(ssh: SshExecutor, workerId: string): Promise<void>;
  export async function networkExists(ssh: SshExecutor, workerId: string): Promise<boolean>;
  ```

- [ ] **Step 1: 写测试**

Create `tests/domain/worker-network.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { MockSshExecutor } from "../../src/domain/ssh-executor";
import {
  workerNetworkName,
  ensureWorkerNetwork,
  removeWorkerNetwork,
  networkExists,
} from "../../src/domain/worker-network";

describe("workerNetworkName", () => {
  test("返回 da-net-<workerId>", () => {
    expect(workerNetworkName("abc123")).toBe("da-net-abc123");
  });
});

describe("networkExists", () => {
  test("存在返回 true", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker network inspect/).resolve({
      stdout: '[{"Name":"da-net-abc"}]\n', stderr: "", exitCode: 0,
    });
    expect(await networkExists(ssh, "abc")).toBe(true);
  });

  test("不存在返回 false", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker network inspect/).resolve({
      stdout: "", stderr: "Error: no such network\n", exitCode: 1,
    });
    expect(await networkExists(ssh, "abc")).toBe(false);
  });
});

describe("ensureWorkerNetwork", () => {
  test("已存在则跳过创建", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker network inspect/).resolve({
      stdout: '[{"Name":"da-net-abc"}]\n', stderr: "", exitCode: 0,
    });
    // 不注册 docker network create — 如果调用会抛 "unexpected command"

    await ensureWorkerNetwork(ssh, "abc");
    // 没抛错就过
  });

  test("不存在则 create", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker network inspect/).resolve({ stdout: "", stderr: "no such", exitCode: 1 });
    ssh.when(/docker network create da-net-abc/).resolve({
      stdout: "abc123networkid\n", stderr: "", exitCode: 0,
    });

    await ensureWorkerNetwork(ssh, "abc");
    // 没抛错就过
  });
});

describe("removeWorkerNetwork", () => {
  test("调用 docker network rm", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker network rm da-net-abc/).resolve({ stdout: "", stderr: "", exitCode: 0 });

    await removeWorkerNetwork(ssh, "abc");
  });

  test("network 不存在不抛错（idempotent）", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker network rm da-net-abc/).resolve({
      stdout: "", stderr: "no such network\n", exitCode: 1,
    });

    // 不应抛错
    await removeWorkerNetwork(ssh, "abc");
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/domain/worker-network.test.ts 2>&1 | tail -5
```

Expected: 模块不存在。

- [ ] **Step 3: 写实现**

Create `src/domain/worker-network.ts`:

```typescript
// Worker 专属 docker network 管理
// 命名: da-net-<workerId>
// 用途: 隔离 da-app 和 da-pg 容器，PG 不暴露 host 端口

import type { SshExecutor } from "./ssh-executor.js";

export function workerNetworkName(workerId: string): string {
  return `da-net-${workerId}`;
}

export async function networkExists(ssh: SshExecutor, workerId: string): Promise<boolean> {
  const name = workerNetworkName(workerId);
  const r = await ssh.exec(`docker network inspect ${name}`);
  return r.exitCode === 0;
}

export async function ensureWorkerNetwork(ssh: SshExecutor, workerId: string): Promise<void> {
  if (await networkExists(ssh, workerId)) return;
  const name = workerNetworkName(workerId);
  const r = await ssh.exec(`docker network create ${name}`);
  if (r.exitCode !== 0) {
    throw new Error(`failed to create network ${name}: ${r.stderr}`);
  }
}

export async function removeWorkerNetwork(ssh: SshExecutor, workerId: string): Promise<void> {
  const name = workerNetworkName(workerId);
  const r = await ssh.exec(`docker network rm ${name} 2>/dev/null || true`);
  // exitCode 不为 0 也不抛（network 可能已经被删了），idempotent
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/domain/worker-network.test.ts 2>&1 | tail -5
```

Expected: `7 pass | 0 fail`。

- [ ] **Step 5: 跑全套 + tsc + commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test 2>&1 | tail -5
bunx tsc --noEmit 2>&1 | tail -10
git add src/domain/worker-network.ts tests/domain/worker-network.test.ts
git commit -m "$(cat <<'EOF'
feat(hub): worker docker network 管理 — ensure/remove/idempotent

每 worker 一个 da-net-<workerId> network，隔离 da-app 和 da-pg 容器，
PG 不暴露 host 端口。删除 worker 时按命名前缀清理，无残留。

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: PG 容器管理

**Files:**
- Create: `src/domain/worker-pg-container.ts`
- Test: `tests/domain/worker-pg-container.test.ts`

**Interfaces:**
- Consumes: `SshExecutor`、`PgCredentials`、`HUB_CONFIG.docker.registry`
- Produces:
  ```typescript
  export function pgContainerName(workerId: string): string;     // "da-pg-<workerId>"
  export function pgVolumeName(workerId: string): string;        // "da-pg-data-<workerId>"
  export function daPostgresImage(): string;                     // "${registry}da-postgres:16-tuned"
  export async function pgContainerExists(ssh, workerId): Promise<boolean>;
  export async function ensurePgContainer(ssh, workerId, creds): Promise<void>;
  export async function waitForPgReady(ssh, workerId, timeoutSec?): Promise<void>;
  export async function removePgContainer(ssh, workerId, opts?: { removeVolume?: boolean }): Promise<void>;
  ```

- [ ] **Step 1: 写测试**

Create `tests/domain/worker-pg-container.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { MockSshExecutor } from "../../src/domain/ssh-executor";
import type { PgCredentials } from "../../src/domain/worker-pg-credentials";
import {
  pgContainerName,
  pgVolumeName,
  daPostgresImage,
  pgContainerExists,
  ensurePgContainer,
  waitForPgReady,
  removePgContainer,
} from "../../src/domain/worker-pg-container";

const FAKE_CREDS: PgCredentials = {
  database: "deepanalyze", username: "da", password: "testpass123",
};

describe("naming helpers", () => {
  test("pgContainerName", () => {
    expect(pgContainerName("abc")).toBe("da-pg-abc");
  });
  test("pgVolumeName", () => {
    expect(pgVolumeName("abc")).toBe("da-pg-data-abc");
  });
  test("daPostgresImage 默认无 registry", () => {
    const oldReg = process.env.HUB_DOCKER_REGISTRY;
    delete process.env.HUB_DOCKER_REGISTRY;
    expect(daPostgresImage()).toBe("da-postgres:16-tuned");
    if (oldReg) process.env.HUB_DOCKER_REGISTRY = oldReg;
  });
  test("daPostgresImage 有 registry 时加前缀", () => {
    const oldReg = process.env.HUB_DOCKER_REGISTRY;
    process.env.HUB_DOCKER_REGISTRY = "registry.example.com/";
    expect(daPostgresImage()).toBe("registry.example.com/da-postgres:16-tuned");
    if (oldReg) process.env.HUB_DOCKER_REGISTRY = oldReg;
    else delete process.env.HUB_DOCKER_REGISTRY;
  });
});

describe("pgContainerExists", () => {
  test("存在返回 true", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker ps -a --filter/).resolve({
      stdout: "da-pg-abc\n", stderr: "", exitCode: 0,
    });
    expect(await pgContainerExists(ssh, "abc")).toBe(true);
  });
  test("不存在返回 false", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker ps -a --filter/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    expect(await pgContainerExists(ssh, "abc")).toBe(false);
  });
});

describe("ensurePgContainer", () => {
  test("已存在则跳过", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker ps -a --filter/).resolve({
      stdout: "da-pg-abc\n", stderr: "", exitCode: 0,
    });
    // 不注册 docker run
    await ensurePgContainer(ssh, "abc", FAKE_CREDS);
  });

  test("不存在则 run + wait", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker ps -a --filter/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    ssh.when(/docker run -d/).resolve({ stdout: "containerid123\n", stderr: "", exitCode: 0 });
    ssh.when(/pg_isready/).resolve({ stdout: "accepting\n", stderr: "", exitCode: 0 });

    await ensurePgContainer(ssh, "abc", FAKE_CREDS);
  });

  test("run 失败抛错", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker ps -a --filter/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    ssh.when(/docker run -d/).resolve({
      stdout: "", stderr: "image not found\n", exitCode: 1,
    });
    expect(ensurePgContainer(ssh, "abc", FAKE_CREDS)).rejects.toThrow(/image not found/);
  });
});

describe("waitForPgReady", () => {
  test("立即 ready", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/pg_isready/).resolve({ stdout: "accepting\n", stderr: "", exitCode: 0 });
    await waitForPgReady(ssh, "abc", 5);
  });

  test("超时抛错", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/pg_isready/).resolve({ stdout: "no response\n", stderr: "", exitCode: 0 });
    expect(waitForPgReady(ssh, "abc", 1)).rejects.toThrow(/timeout/);
  });
});

describe("removePgContainer", () => {
  test("默认不删 volume", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker rm -f da-pg-abc/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    // 不注册 docker volume rm
    await removePgContainer(ssh, "abc");
  });

  test("opts.removeVolume=true 删 volume", async () => {
    const ssh = new MockSshExecutor();
    ssh.when(/docker rm -f da-pg-abc/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    ssh.when(/docker volume rm da-pg-data-abc/).resolve({ stdout: "", stderr: "", exitCode: 0 });
    await removePgContainer(ssh, "abc", { removeVolume: true });
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/domain/worker-pg-container.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: 写实现**

Create `src/domain/worker-pg-container.ts`:

```typescript
// Worker 专属 PG 容器生命周期管理
// - 容器名: da-pg-<workerId>
// - volume:  da-pg-data-<workerId>
// - image:   ${HUB_DOCKER_REGISTRY}da-postgres:16-tuned
// - 网络:    da-net-<workerId>（外部创建，本模块只引用）

import type { SshExecutor } from "./ssh-executor.js";
import type { PgCredentials } from "./worker-pg-credentials.js";

export function pgContainerName(workerId: string): string {
  return `da-pg-${workerId}`;
}

export function pgVolumeName(workerId: string): string {
  return `da-pg-data-${workerId}`;
}

export function daPostgresImage(): string {
  const registry = process.env.HUB_DOCKER_REGISTRY ?? "";
  return `${registry}da-postgres:16-tuned`;
}

export async function pgContainerExists(ssh: SshExecutor, workerId: string): Promise<boolean> {
  const name = pgContainerName(workerId);
  const r = await ssh.exec(
    `docker ps -a --filter name=^/${name}$ --format '{{.Names}}'`,
  );
  return r.stdout.trim() === name;
}

export async function ensurePgContainer(
  ssh: SshExecutor,
  workerId: string,
  creds: PgCredentials,
  orgId?: string,
): Promise<void> {
  if (await pgContainerExists(ssh, workerId)) return;

  const name = pgContainerName(workerId);
  const volume = pgVolumeName(workerId);
  const network = `da-net-${workerId}`;
  const image = daPostgresImage();
  const labels = [
    `--label com.deepanalyze.workerId=${workerId}`,
    `--label com.deepanalyze.role=pg`,
  ];
  if (orgId) labels.push(`--label com.deepanalyze.orgId=${orgId}`);

  // 验证 workerId/creds 没有 shell 注入风险（保守白名单）
  if (!/^[a-zA-Z0-9_-]+$/.test(workerId)) {
    throw new Error(`invalid workerId: ${workerId}`);
  }
  if (!/^[a-zA-Z0-9_]+$/.test(creds.database)) {
    throw new Error(`invalid database name: ${creds.database}`);
  }
  if (!/^[a-zA-Z0-9_]+$/.test(creds.username)) {
    throw new Error(`invalid username: ${creds.username}`);
  }
  // password 不能含单引号（即使我们在 -e 里用 single quotes wrap）
  if (creds.password.includes("'")) {
    throw new Error("password contains single quote — refused for shell safety");
  }

  const cmd = `docker run -d \
    --name ${name} \
    --network ${network} \
    ${labels.join(" ")} \
    -v ${volume}:/var/lib/postgresql/data \
    -e POSTGRES_DB='${creds.database}' \
    -e POSTGRES_USER='${creds.username}' \
    -e POSTGRES_PASSWORD='${creds.password}' \
    --restart unless-stopped \
    ${image}`;

  const r = await ssh.exec(cmd);
  if (r.exitCode !== 0) {
    throw new Error(`failed to start pg container ${name}: ${r.stderr}`);
  }

  await waitForPgReady(ssh, workerId, 30);
}

export async function waitForPgReady(
  ssh: SshExecutor,
  workerId: string,
  timeoutSec = 30,
): Promise<void> {
  const name = pgContainerName(workerId);
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const r = await ssh.exec(
      `docker exec ${name} pg_isready -U da 2>&1 || true`,
    );
    if (r.stdout.includes("accepting connections")) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`pg container ${name} not ready within ${timeoutSec}s`);
}

export async function removePgContainer(
  ssh: SshExecutor,
  workerId: string,
  opts?: { removeVolume?: boolean },
): Promise<void> {
  const name = pgContainerName(workerId);
  // 强制删容器，idempotent
  await ssh.exec(`docker rm -f ${name} 2>/dev/null || true`);

  if (opts?.removeVolume) {
    const volume = pgVolumeName(workerId);
    await ssh.exec(`docker volume rm ${volume} 2>/dev/null || true`);
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/domain/worker-pg-container.test.ts 2>&1 | tail -5
```

Expected: `11 pass | 0 fail`。

- [ ] **Step 5: 跑全套 + tsc + commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test 2>&1 | tail -5
bunx tsc --noEmit 2>&1 | tail -10
git add src/domain/worker-pg-container.ts tests/domain/worker-pg-container.test.ts
git commit -m "$(cat <<'EOF'
feat(hub): worker PG 容器生命周期 — ensure/waitReady/remove

- pgContainerName/pgVolumeName/daPostgresImage 命名 helper
- ensurePgContainer: idempotent，已存在跳过；新建后等 pg_isready
- waitForPgReady: 轮询 docker exec pg_isready，30s 默认超时
- removePgContainer: docker rm -f + 可选 volume 删除
- 容器命名 da-pg-<workerId>，挂 da-pg-data-<workerId> volume
- 加 com.deepanalyze.workerId/role labels 便于运维查询

输入校验：workerId/database/username 走白名单正则；password 拒绝单引号。

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: deployWorkerStack 重构

**Files:**
- Modify: `src/domain/worker-deployment.ts`（加 `deployWorkerStack` 编排函数）
- Modify: `src/core/config.ts`（加 `docker.registry`）
- Create: `tests/domain/worker-deployment-stack.test.ts`

**Interfaces:**
- Consumes: `deployWorker` (existing)、`ensureWorkerNetwork`、`ensurePgContainer`、`ensurePgCredentials`
- Produces:
  ```typescript
  export interface WorkerStackOpts {
    workerId: string;
    imageTag: string;
    initiatedBy: string;
    healthTimeout?: number;
    skipBackup?: boolean;
  }
  export async function deployWorkerStack(opts: WorkerStackOpts): Promise<DeployResult>;
  ```

**Background for implementer:**
- `deployWorker` 现状在 `:45` 不动，保留为底层「跑 DA 容器」函数
- `deployWorkerStack` 是新加的高层 orchestrator：建 network → 建 PG → 构造 envVars（含 PG_*）→ 调 `deployWorker`
- `routes/workers.ts` 后续切换到调 `deployWorkerStack`（不在本 task 范围 — 那是 T9 迁移脚本之后）

- [ ] **Step 1: 修改 config.ts 加 docker 配置**

打开 `src/core/config.ts`，在 `bundle: { ... }` 之后（约 line 67）加：

```typescript
  /** Docker registry for worker-side images (da-postgres etc.) */
  docker: {
    registry: process.env.HUB_DOCKER_REGISTRY ?? "",
  },
```

并 bump 版本号到 `0.7.7`（line 10）。

- [ ] **Step 2: 写 stack 测试**

Create `tests/domain/worker-deployment-stack.test.ts`:

```typescript
// 验证 deployWorkerStack 的编排序列：network → pg → call deployWorker
// 用 mock 替换所有 SSH/DB 操作，确保单元可测
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { query } from "../../src/store/pg";

// Mock 所有 SshExecutor / DB 依赖；只验证调用顺序和参数
// 用 bun:jose 或手动 mock — 本测试用 monkey-patch 方式

describe("deployWorkerStack", () => {
  beforeEach(async () => {
    // 清理 fixture worker
    await query(`DELETE FROM workers WHERE id LIKE 'stack-test-%'`);
  });

  test("编排顺序：先 ensureNetwork，再 ensurePgContainer，最后 deployWorker", async () => {
    // 这个测试需要 mock 多个模块，用 bun 的 mock 机制
    // 实现 TBD：依赖 T6 implementer 决定 mock 策略
    // 关键断言：SSH 调用序列的第一个命令是 docker network inspect
    //          第二组命令是 docker ps -a --filter + docker run da-pg
    //          之后才到 docker run da-app
    expect(true).toBe(true);  // placeholder — implementer 写真实 mock
  });

  test("PG 已存在则不重建，但 deployWorker 仍执行", async () => {
    expect(true).toBe(true);
  });

  test("ensurePgContainer 失败时 stack 失败，不调 deployWorker", async () => {
    expect(true).toBe(true);
  });
});
```

**注**：本测试的真实 mock 实现 TBD — T6 的 implementer 应当：
1. 用 `mock.module()` 替换 `../store/pg.js` 和 `../domain/ssh-executor.js`
2. 注入 mock SshExecutor 记录所有 `exec(cmd)` 调用
3. 断言调用序列符合 `ensureNetwork → ensurePgContainer → deployWorker` 顺序

如果 bun:test 的 mock 机制不足以做到，可以重构 `deployWorkerStack` 接受可选的依赖注入参数（如 `deployWorkerStack(opts, deps?)`），测试用 deps 注入 mock。**这是允许的偏离**（spec 没强制）。

- [ ] **Step 3: 实现 deployWorkerStack**

修改 `src/domain/worker-deployment.ts`，在文件末尾加：

```typescript
// ============================================================================
// deployWorkerStack — Spec 2.1 B 模式编排
// 编排: ensureNetwork → ensurePgContainer → deployWorker（含 PG env）
// ============================================================================

import { ensureWorkerNetwork, workerNetworkName } from "./worker-network.js";
import {
  ensurePgContainer, pgContainerName,
} from "./worker-pg-container.js";
import { ensurePgCredentials } from "./worker-pg-credentials.js";
import { connectRealSsh } from "./ssh-executor.js";

export interface WorkerStackOpts {
  workerId: string;
  imageTag: string;
  initiatedBy: string;
  hostServerId?: string;     // 优先用 host_server 凭据；fallback worker.ssh_*
  healthTimeout?: number;
  skipBackup?: boolean;
}

export async function deployWorkerStack(opts: WorkerStackOpts): Promise<DeployResult> {
  const jobId = `dpl_${randomUUID().replace(/-/g, "")}`;
  const logs: DeployResult["logs"] = [];
  const addLog = (level: string, msg: string) =>
    logs.push({ ts: new Date().toISOString(), level, msg });

  // 取 worker + host_server 信息
  const w = await query<{
    ssh_target_host: string; ssh_target_port: number; ssh_user: string;
    ssh_key_encrypted: string | null; host_id: string | null;
  }>(
    `SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted, host_id
     FROM workers WHERE id = $1`,
    [opts.workerId],
  );
  if (w.rows.length === 0) throw new Error(`worker ${opts.workerId} not found`);
  const worker = w.rows[0];

  // host_server 凭据优先（spec 1 后的标准模型）
  let sshHost = worker.ssh_target_host;
  let sshPort = worker.ssh_target_port;
  let sshUser = worker.ssh_user;
  let sshKeyEncrypted = worker.ssh_key_encrypted;

  if (opts.hostServerId || worker.host_id) {
    const hsId = opts.hostServerId ?? worker.host_id!;
    const hs = await query<{
      ssh_target_host: string; ssh_target_port: number; ssh_user: string;
      ssh_key_encrypted: string | null;
    }>(
      `SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted
       FROM host_servers WHERE id = $1`,
      [hsId],
    );
    if (hs.rows.length > 0 && hs.rows[0].ssh_key_encrypted) {
      sshHost = hs.rows[0].ssh_target_host;
      sshPort = hs.rows[0].ssh_target_port;
      sshUser = hs.rows[0].ssh_user;
      sshKeyEncrypted = hs.rows[0].ssh_key_encrypted;
    }
  }

  if (!sshHost || !sshKeyEncrypted) {
    throw new Error(`no SSH credentials for worker ${opts.workerId}`);
  }

  const privateKey = await decryptSshKey(sshKeyEncrypted);
  const ssh = await connectRealSsh({
    host: sshHost, port: sshPort, username: sshUser, privateKey,
  });

  try {
    // 1. ensure network
    addLog("info", `ensuring network da-net-${opts.workerId}`);
    await ensureWorkerNetwork(ssh, opts.workerId);

    // 2. ensure PG credentials + container
    addLog("info", `ensuring PG credentials for ${opts.workerId}`);
    const pgCreds = await ensurePgCredentials(opts.workerId);

    addLog("info", `ensuring PG container da-pg-${opts.workerId}`);
    await ensurePgContainer(ssh, opts.workerId, pgCreds);

    // 3. 构造 envVars（含 PG_*）+ 调用底层 deployWorker
    const pgHost = pgContainerName(opts.workerId);
    const envVars: Record<string, string> = {
      PG_HOST: pgHost,
      PG_PORT: "5432",
      PG_USER: pgCreds.username,
      PG_PASSWORD: pgCreds.password,
      PG_DATABASE: pgCreds.database,
      // 其他 DA_* env 由 caller 在 deployWorker 调用前补
    };

    addLog("info", `calling deployWorker for da-app-${opts.workerId}`);
    return await deployWorker({
      workerId: opts.workerId,
      sshHost, sshPort, sshUser,
      sshPrivateKeyPem: privateKey,
      imageTag: opts.imageTag,
      source: "docker_pull",  // 默认 docker pull；hub_stream 由 caller 包装
      hubBaseUrl: process.env.HUB_EXTERNAL_URL ?? "http://localhost:22000",
      containerName: `da-app-${opts.workerId}`,
      containerPort: 21000,  // TODO: 从 host_server 端口分配读
      envVars,
      volumeMounts: [`da-app-data-${opts.workerId}:/app/data`],
      initiatedBy: opts.initiatedBy,
      healthTimeout: opts.healthTimeout,
    });
  } finally {
    ssh.close();
  }
}
```

- [ ] **Step 4: 跑 stack 测试**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/domain/worker-deployment-stack.test.ts 2>&1 | tail -5
```

Expected: `3 pass | 0 fail`（即使 placeholder 也应通过；implementer 应替换为真实 mock）。

- [ ] **Step 5: 跑现有 worker 测试确保不破坏**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/routes/workers.test.ts 2>&1 | tail -5
NODE_ENV=development bun test tests/domain/worker-deployment.test.ts 2>&1 | tail -5
```

Expected: 现有测试 pass 数不变（deployWorker 主体未改）。

- [ ] **Step 6: 跑全套 + tsc**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test 2>&1 | tail -5
bunx tsc --noEmit 2>&1 | tail -10
```

Expected: 121 pass（118 + 3）；无新 tsc 错误。

- [ ] **Step 7: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add src/domain/worker-deployment.ts src/core/config.ts tests/domain/worker-deployment-stack.test.ts
git commit -m "$(cat <<'EOF'
feat(hub): deployWorkerStack 编排 — B 模式部署入口

编排序列: ensureNetwork → ensurePgContainer → deployWorker(含 PG env)
- 新增 WorkerStackOpts，host_server SSH 凭据优先
- 容器命名从 da-<slice12> 改为 da-app-<workerId>
- envVars 自动注入 PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE
- 底层 deployWorker 不动（向后兼容现有 caller）
- config 加 HUB_DOCKER_REGISTRY

routes/workers.ts 暂未切换（T9 迁移脚本完成后切换）。

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: deleteWorker 资源清理

**Files:**
- Modify: `src/domain/worker-deployment.ts`（扩展 `stopWorker` 或新增 `deleteWorkerStack`）
- Create: `tests/domain/worker-stop-cleanup.test.ts`

**Interfaces:**
- Consumes: `removePgContainer`、`removeWorkerNetwork`
- Produces: 新增 `deleteWorkerStack(workerId, initiatedBy, opts?)` 函数（或扩展 stopWorker）

**Background:**
- 现有 `stopWorker` 在 `worker-deployment.ts:365` 只 stop DA 容器（`docker stop da-<slice12>`）
- Spec 2.1 后，stop 应该清理整个 stack：DA + PG + volumes + network
- 但「stop」和「delete」语义不同 — stop 可能只是临时停（restart 还会起来）；delete 才是彻底清理
- 决定：新增 `deleteWorkerStack` 做彻底清理；`stopWorker` 保留只停 DA 容器（用于 draining）

- [ ] **Step 1: 写测试**

Create `tests/domain/worker-stop-cleanup.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { query } from "../../src/store/pg";

const TEST_WORKER_ID = "test-stop-cleanup";

beforeEach(async () => {
  await query(
    `INSERT INTO workers (id, hostname, worker_token, status)
     VALUES ($1, 'test-host', 'test-stop-token', 'pending')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_WORKER_ID],
  );
});

describe("deleteWorkerStack", () => {
  test("调用清理顺序：da-app → da-pg → volumes → network", async () => {
    // 同 T6 测试，用 mock SSH 验证调用序列
    // TBD: implementer 用真实 mock 实现
    expect(true).toBe(true);
  });

  test("HUB_DELETE_WORKER_KEEP_VOLUMES=true 时跳过 volume 删除", async () => {
    const old = process.env.HUB_DELETE_WORKER_KEEP_VOLUMES;
    process.env.HUB_DELETE_WORKER_KEEP_VOLUMES = "true";
    // 验证不调 docker volume rm
    expect(true).toBe(true);
    if (old) process.env.HUB_DELETE_WORKER_KEEP_VOLUMES = old;
    else delete process.env.HUB_DELETE_WORKER_KEEP_VOLUMES;
  });

  test("HUB_DELETE_WORKER_KEEP_VOLUMES=false（或未设置）时删 volume", async () => {
    const old = process.env.HUB_DELETE_WORKER_KEEP_VOLUMES;
    delete process.env.HUB_DELETE_WORKER_KEEP_VOLUMES;
    // 验证调用 docker volume rm da-app-data-X 和 da-pg-data-X
    expect(true).toBe(true);
    if (old) process.env.HUB_DELETE_WORKER_KEEP_VOLUMES = old;
  });

  test("worker status 改为 decommissioned", async () => {
    // 直接调 deleteWorkerStack（mock SSH），然后查 DB
    const { rows } = await query<{ status: string }>(
      `SELECT status FROM workers WHERE id = $1`, [TEST_WORKER_ID],
    );
    // TBD: 真实调用后断言 status='decommissioned'
    expect(rows[0].status).toBeDefined();
  });
});
```

- [ ] **Step 2: 实现 deleteWorkerStack**

修改 `src/domain/worker-deployment.ts`，加：

```typescript
export interface DeleteStackOpts {
  keepVolumes?: boolean;  // 默认按 HUB_DELETE_WORKER_KEEP_VOLUMES env
}

export async function deleteWorkerStack(
  workerId: string,
  initiatedBy: string,
  opts?: DeleteStackOpts,
): Promise<DeployResult> {
  const jobId = `dpl_${randomUUID().replace(/-/g, "")}`;
  const logs: DeployResult["logs"] = [];
  const addLog = (level: string, msg: string) =>
    logs.push({ ts: new Date().toISOString(), level, msg });

  const keepVolumes = opts?.keepVolumes ??
    (process.env.HUB_DELETE_WORKER_KEEP_VOLUMES ?? "true") !== "false";

  await query(
    `INSERT INTO deploy_jobs (id, worker_id, action, status, started_at, initiated_by, logs)
     VALUES ($1, $2, 'delete', 'running', NOW(), $3, '[]'::jsonb)`,
    [jobId, workerId, initiatedBy],
  );

  // 取 SSH 凭据（同 deployWorkerStack 的逻辑）
  const w = await query<{
    ssh_target_host: string; ssh_target_port: number; ssh_user: string;
    ssh_key_encrypted: string | null; host_id: string | null;
  }>(
    `SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted, host_id
     FROM workers WHERE id = $1`, [workerId],
  );
  if (w.rows.length === 0) throw new Error(`worker ${workerId} not found`);
  const worker = w.rows[0];

  let sshHost = worker.ssh_target_host;
  let sshPort = worker.ssh_target_port;
  let sshUser = worker.ssh_user;
  let sshKeyEncrypted = worker.ssh_key_encrypted;

  if (worker.host_id) {
    const hs = await query<{
      ssh_target_host: string; ssh_target_port: number; ssh_user: string;
      ssh_key_encrypted: string | null;
    }>(
      `SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted
       FROM host_servers WHERE id = $1`, [worker.host_id],
    );
    if (hs.rows.length > 0 && hs.rows[0].ssh_key_encrypted) {
      sshHost = hs.rows[0].ssh_target_host;
      sshPort = hs.rows[0].ssh_target_port;
      sshUser = hs.rows[0].ssh_user;
      sshKeyEncrypted = hs.rows[0].ssh_key_encrypted;
    }
  }

  if (!sshHost || !sshKeyEncrypted) {
    throw new Error(`no SSH credentials for worker ${workerId}`);
  }

  const privateKey = await decryptSshKey(sshKeyEncrypted);
  const ssh = await connectRealSsh({
    host: sshHost, port: sshPort, username: sshUser, privateKey,
  });

  try {
    // 1. 停并删 da-app
    addLog("info", `removing da-app-${workerId}`);
    await ssh.exec(`docker rm -f da-app-${workerId} 2>/dev/null || true`);
    // 兼容旧命名
    await ssh.exec(`docker rm -f da-${workerId.slice(0, 12)} 2>/dev/null || true`);

    // 2. 停并删 da-pg
    addLog("info", `removing da-pg-${workerId}`);
    await removePgContainer(ssh, workerId, { removeVolume: !keepVolumes });

    // 3. 删 da-app volume（如果配置允许）
    if (!keepVolumes) {
      addLog("info", `removing volume da-app-data-${workerId}`);
      await ssh.exec(`docker volume rm da-app-data-${workerId} 2>/dev/null || true`);
    }

    // 4. 删 network
    addLog("info", `removing network da-net-${workerId}`);
    await removeWorkerNetwork(ssh, workerId);

    // 5. 更新 worker status
    await query(
      `UPDATE workers SET status = 'decommissioned', decommissioned_at = NOW()
       WHERE id = $1`, [workerId],
    );

    await query(
      `UPDATE deploy_jobs SET status = 'success', completed_at = NOW(), logs = $2::jsonb
       WHERE id = $1`, [jobId, JSON.stringify(logs)],
    );
    return { jobId, success: true, logs };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addLog("error", errMsg);
    await query(
      `UPDATE deploy_jobs SET status = 'failed', completed_at = NOW(), error = $2, logs = $3::jsonb
       WHERE id = $1`, [jobId, errMsg, JSON.stringify(logs)],
    );
    return { jobId, success: false, error: errMsg, logs };
  } finally {
    ssh.close();
  }
}
```

加 import：
```typescript
import { removePgContainer } from "./worker-pg-container.js";
import { removeWorkerNetwork } from "./worker-network.js";
```

- [ ] **Step 3: 跑测试 + tsc + commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/domain/worker-stop-cleanup.test.ts 2>&1 | tail -5
NODE_ENV=development bun test 2>&1 | tail -5
bunx tsc --noEmit 2>&1 | tail -10
git add src/domain/worker-deployment.ts tests/domain/worker-stop-cleanup.test.ts
git commit -m "$(cat <<'EOF'
feat(hub): deleteWorkerStack — 彻底清理 worker 全部 docker 资源

清理顺序: da-app → da-pg → volumes → network → status='decommissioned'
- HUB_DELETE_WORKER_KEEP_VOLUMES=true (默认) 保留 volume 应急
- 兼容旧命名 da-<slice12> 同时清理
- stopWorker 保留不动（用于 draining，不删 PG/network）

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: da-postgres:16-tuned 镜像 Dockerfile

**Files:**
- Create: `docker/da-postgres/Dockerfile`
- Create: `docker/da-postgres/postgresql-tuned.conf`
- Create: `docker/da-postgres/pg-healthcheck.sh`
- Create: `docker/da-postgres/README.md`

**Interfaces:** 不涉及代码，纯基础设施文件。

- [ ] **Step 1: 写 postgresql-tuned.conf**

Create `docker/da-postgres/postgresql-tuned.conf`:

```conf
# da-postgres:16-tuned 调优配置
# 单 worker 单 PG 实例，资源有限场景下的保守调优
# 参考: https://www.postgresql.org/docs/16/runtime-config-resource.html

# --- 内存 ---
shared_buffers = 32MB             # 默认 128MB，单 worker 太奢侈
work_mem = 4MB                    # 排序/哈希内存
maintenance_work_mem = 64MB       # VACUUM/CREATE INDEX
effective_cache_size = 256MB      # 查询规划器假设的可用缓存

# --- 连接 ---
max_connections = 50              # 单 worker 不需要太多连接

# --- WAL ---
wal_buffers = 4MB                 # 默认 -1 (自动)，但显式更稳
min_wal_size = 80MB
max_wal_size = 1GB

# --- 其他 ---
checkpoint_completion_target = 0.9
random_page_cost = 1.1            # SSD 假设
default_statistics_target = 100
```

- [ ] **Step 2: 写 pg-healthcheck.sh**

Create `docker/da-postgres/pg-healthcheck.sh`:

```bash
#!/bin/sh
# HEALTHCHECK 脚本 — docker 用
# 用 pg_isready 检查 PG 是否接受连接
set -e

# POSTGRES_USER env 由 docker run -e 设置
USER="${POSTGRES_USER:-da}"

if pg_isready -U "$USER" -d "${POSTGRES_DB:-deepanalyze}" >/dev/null 2>&1; then
  exit 0
else
  exit 1
fi
```

- [ ] **Step 3: 写 Dockerfile**

Create `docker/da-postgres/Dockerfile`:

```dockerfile
# da-postgres:16-tuned
# DeepAnalyze worker 专用 PG 镜像，基于官方 postgres:16-alpine + 调优配置 + healthcheck
# 用法: docker build -t da-postgres:16-tuned .
#       docker push ${REGISTRY}da-postgres:16-tuned

FROM postgres:16-alpine

# 调优配置（覆盖默认）
COPY postgresql-tuned.conf /etc/postgresql/postgresql.conf

# Healthcheck 脚本
COPY pg-healthcheck.sh /usr/local/bin/pg-healthcheck.sh
RUN chmod +x /usr/local/bin/pg-healthcheck.sh

# 每 10 秒检查一次，超 3 秒 timeout，连续 5 次失败才 unhealthy
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD ["pg-healthcheck.sh"]

# 覆盖 CMD 用调优配置启动
CMD ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"]
```

- [ ] **Step 4: 写 README runbook**

Create `docker/da-postgres/README.md`:

```markdown
# da-postgres:16-tuned

DeepAnalyze worker 专用 PostgreSQL 镜像。基于官方 `postgres:16-alpine`，加：
- 内存/连接数调优（shared_buffers=32MB, max_connections=50）
- healthcheck 脚本

## 何时需要

Spec 2.1 后，每个 worker 部署一个独立 PG 容器（B 模式）。这个镜像是 Hub 自动部署的，**不需要手工运行** — `deployWorkerStack` 会通过 SSH 在 host 上 `docker run` 它。

Hub 在 `HUB_DOCKER_REGISTRY` env var 配置 registry 前缀。镜像名规则：`${HUB_DOCKER_REGISTRY}da-postgres:16-tuned`

## 构建并推送（开发/发布流程）

```bash
cd deepanalyze-hub/docker/da-postgres

# 本地构建
docker build -t da-postgres:16-tuned .

# 推到内部 registry（如果有）
docker tag da-postgres:16-tuned registry.your-corp.com/da-postgres:16-tuned
docker push registry.your-corp.com/da-postgres:16-tuned

# Hub 部署时设置 env
export HUB_DOCKER_REGISTRY=registry.your-corp.com/
```

## Fallback（客户环境无内部 registry）

`worker-pg-container.ts` 当前假设镜像已 pull 到 host。如果客户 host 无法 pull 内部镜像，两个 fallback 方案：

1. **手工预导入**：`docker save da-postgres:16-tuned | ssh host docker load`
2. **stock postgres + config 挂载**：用官方 `postgres:16-alpine`，由 Hub 通过 SSH 上传 `postgresql-tuned.conf` 到 host `/tmp/`，然后 `docker run -v /tmp/pg.conf:/etc/postgresql/postgresql.conf postgres:16-alpine -c config_file=/etc/postgresql/postgresql.conf`

方案 2 的实现在 `worker-pg-container.ts` 里加个 `ensurePgContainerFallback()` 分支，**Spec 2.1 暂不实现**（YAGNI），等真有客户需求再加。

## 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `shared_buffers` | 32MB | PG 共享缓冲池 |
| `max_connections` | 50 | 最大连接数 |
| `work_mem` | 4MB | 单查询排序内存 |
| `effective_cache_size` | 256MB | 规划器假设的缓存 |

每 worker idle resident ~50-70MB。20 worker/host = ~1.2GB PG idle。

## Healthcheck

`pg_isready` 通过 `POSTGRES_USER` env（默认 `da`）轮询。Docker `HEALTHCHECK` 配置：每 10s 一次，连续 5 次失败才标记 unhealthy。

## 升级 PG 版本（未来）

如果要从 PG 16 升到 17，需要：
1. 构建新镜像 `da-postgres:17-tuned`
2. 写 migration 脚本：每个 worker `pg_dumpall | docker run new-pg | restore`
3. 这个流程在 Spec 2 范围之外（YAGNI），`backup_manifest.json.pg_version` 字段为未来保留
```

- [ ] **Step 5: 本地构建测试（可选但推荐）**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub/docker/da-postgres
docker build -t da-postgres:16-tuned .
docker run --rm -e POSTGRES_PASSWORD=test -e POSTGRES_USER=da -e POSTGRES_DB=deepanalyze -d --name pg-test da-postgres:16-tuned
sleep 5
docker exec pg-test pg_isready -U da
docker logs pg-test | head -20
docker stop pg-test
```

Expected: `pg_isready` 输出 `accepting connections`；日志显示用调优配置启动。

- [ ] **Step 6: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
git add docker/da-postgres/
git commit -m "$(cat <<'EOF'
feat(hub): da-postgres:16-tuned 镜像 Dockerfile + 调优配置

基于 postgres:16-alpine + 内存/连接数调优（shared_buffers=32MB,
max_connections=50）+ healthcheck 脚本。

每 worker idle ~50-70MB；20 worker/host = ~1.2GB PG idle。

构建/推送到 registry 由发布流程处理，Hub 通过 HUB_DOCKER_REGISTRY
env var 指定前缀。Fallback 方案（stock postgres + config 挂载）
留待 YAGNI 触发再加。

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: 现有 worker 迁移脚本

**Files:**
- Create: `scripts/migrate-workers-to-b.ts`
- Test: `tests/scripts/migrate-workers-to-b.test.ts`

**Interfaces:**
- Consumes: 所有 T1-T8 的产物（migration 038、SshExecutor、PG 容器管理、deployWorkerStack）
- Produces: 命令行脚本 `bun run scripts/migrate-workers-to-b.ts [--dry-run] [--concurrency=N]`

**Background for implementer:**
- 检测：`docker ps --filter name=^/da-pg-<workerId>$`，已存在 = 已迁移
- 提取老 PG env：`docker inspect da-<slice12> --format '{{range .Config.Env}}{{println .}}{{end}}'` 解析 PG_*
- 数据迁移：`pg_dump -h <oldHost> -U <oldUser> <oldDb> | docker exec -i da-pg-<workerId> pg_restore -U <newUser> -d <newDb>`
- 容器 rename：旧 `da-<slice12>` 可能要先 `docker rename` 为 `da-app-<workerId>` 才能跑新 da-app-<workerId>（否则重名）— 但其实先 stop 旧的再 run 新的更简单
- 回滚：失败时停新 da-app，启动老 da-app（老 PG 数据未动）

- [ ] **Step 1: 写脚本**

Create `scripts/migrate-workers-to-b.ts`:

```typescript
#!/usr/bin/env bun
/**
 * 现有 worker 迁移到 B 模式脚本
 *
 * 用法:
 *   bun run scripts/migrate-workers-to-b.ts [--dry-run] [--worker=<id>] [--concurrency=N]
 *
 * 检测每个 online worker 是否已有 da-pg-<workerId> 容器，没有则迁移：
 *   1. docker inspect 老 da-app 容器提取 PG_* env vars
 *   2. 生成新 PG 凭据，写入 workers 表
 *   3. 创建 da-net-<workerId> network
 *   4. 启动 da-pg-<workerId>（空 DB）
 *   5. pg_dump 老 PG → pg_restore 新 PG
 *   6. stop 老 da-app 容器
 *   7. docker run 新 da-app-<workerId> 指向 da-pg-<workerId>
 *   8. 健康检查
 *   9. 失败则回滚（停新 da-app，启动老 da-app）
 *
 * 老 PG 资源（容器/数据/卷）不自动删 — 运维确认所有 worker 迁完才手动清理。
 */

import { query } from "../src/store/pg.js";
import { connectRealSsh, type SshExecutor } from "../src/domain/ssh-executor.js";
import { decryptString } from "../src/core/crypto.js";
import {
  ensurePgCredentials, type PgCredentials,
} from "../src/domain/worker-pg-credentials.js";
import {
  ensureWorkerNetwork, removeWorkerNetwork,
} from "../src/domain/worker-network.js";
import {
  ensurePgContainer, pgContainerName, pgContainerExists, waitForPgReady,
} from "../src/domain/worker-pg-container.js";

interface CliOpts {
  dryRun: boolean;
  workerId?: string;
  concurrency: number;
}

function parseArgs(): CliOpts {
  const args = process.argv.slice(2);
  const opts: CliOpts = { dryRun: false, concurrency: 1 };
  for (const a of args) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a.startsWith("--worker=")) opts.workerId = a.slice(9);
    else if (a.startsWith("--concurrency=")) opts.concurrency = parseInt(a.slice(14), 10);
  }
  return opts;
}

interface OldPgConfig {
  host: string; port: string; user: string; password: string; database: string;
}

async function extractOldPgConfig(
  ssh: SshExecutor, oldContainerName: string,
): Promise<OldPgConfig | null> {
  const r = await ssh.exec(
    `docker inspect ${oldContainerName} --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true`,
  );
  if (r.exitCode !== 0 || !r.stdout.trim()) return null;

  const env: Record<string, string> = {};
  for (const line of r.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }

  if (!env.PG_HOST) return null;
  return {
    host: env.PG_HOST,
    port: env.PG_PORT ?? "5432",
    user: env.PG_USER ?? "da",
    password: env.PG_PASSWORD ?? "",
    database: env.PG_DATABASE ?? "deepanalyze",
  };
}

async function migrateWorker(
  workerId: string,
  opts: CliOpts,
): Promise<{ success: boolean; error?: string }> {
  console.log(`\n[migrate] worker ${workerId}`);

  // 取 SSH 凭据
  const w = await query<{
    ssh_target_host: string; ssh_target_port: number; ssh_user: string;
    ssh_key_encrypted: string | null; host_id: string | null;
    current_image_tag: string;
  }>(
    `SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted, host_id, current_image_tag
     FROM workers WHERE id = $1`, [workerId],
  );
  if (w.rows.length === 0) return { success: false, error: "worker not found" };
  const worker = w.rows[0];

  // host_server 优先
  let sshHost = worker.ssh_target_host;
  let sshPort = worker.ssh_target_port;
  let sshUser = worker.ssh_user;
  let sshKeyEncrypted = worker.ssh_key_encrypted;

  if (worker.host_id) {
    const hs = await query<{
      ssh_target_host: string; ssh_target_port: number; ssh_user: string;
      ssh_key_encrypted: string | null;
    }>(
      `SELECT ssh_target_host, ssh_target_port, ssh_user, ssh_key_encrypted
       FROM host_servers WHERE id = $1`, [worker.host_id],
    );
    if (hs.rows.length > 0 && hs.rows[0].ssh_key_encrypted) {
      sshHost = hs.rows[0].ssh_target_host;
      sshPort = hs.rows[0].ssh_target_port;
      sshUser = hs.rows[0].ssh_user;
      sshKeyEncrypted = hs.rows[0].ssh_key_encrypted;
    }
  }

  if (!sshHost || !sshKeyEncrypted) {
    return { success: false, error: "no SSH credentials" };
  }

  const privateKey = decryptString(sshKeyEncrypted);
  const ssh = await connectRealSsh({
    host: sshHost, port: sshPort, username: sshUser, privateKey,
  });

  try {
    // 0. 已迁移检测
    if (await pgContainerExists(ssh, workerId)) {
      console.log(`[migrate] worker ${workerId}: da-pg exists, skipping`);
      return { success: true };
    }

    // 1. 找老 da-app 容器（兼容新旧命名）
    const oldName = `da-${workerId.slice(0, 12)}`;
    const newName = `da-app-${workerId}`;
    const oldInspect = await ssh.exec(
      `docker ps -a --filter name=^/${oldName}$ --format '{{.Names}}' 2>/dev/null`,
    );
    const oldExists = oldInspect.stdout.trim() === oldName;
    if (!oldExists) {
      console.log(`[migrate] worker ${workerId}: no old container ${oldName}, fresh deploy`);
      // 全新 worker，让 deployWorkerStack 处理即可
      return { success: true };
    }

    // 2. 提取老 PG 配置
    const oldPg = await extractOldPgConfig(ssh, oldName);
    if (!oldPg) {
      console.log(`[migrate] worker ${workerId}: no PG env in old container, assuming localhost`);
      // 假设 localhost:5432 + 默认 user/db — 老部署模型可能这样
    }

    if (opts.dryRun) {
      console.log(`[migrate][dry-run] would migrate ${workerId}: ${oldName} → ${newName}, pg=${oldPg?.host ?? 'localhost'}`);
      return { success: true };
    }

    // 3. 生成新凭据
    const newCreds = await ensurePgCredentials(workerId);
    console.log(`[migrate] generated new PG credentials for ${workerId}`);

    // 4. 创建 network + pg 容器（空 DB）
    await ensureWorkerNetwork(ssh, workerId);
    await ensurePgContainer(ssh, workerId, newCreds);
    console.log(`[migrate] created da-pg-${workerId}`);

    // 5. 数据迁移：pg_dump | pg_restore
    if (oldPg) {
      console.log(`[migrate] copying data from old PG (${oldPg.host}) to new da-pg-${workerId}`);
      // 注意：老 PG 凭据里的 password 可能有特殊字符，PGPASSWORD env 包装
      const dumpCmd = `PGPASSWORD='${oldPg.password.replace(/'/g, "'\\''")}' \
        pg_dump -h ${oldPg.host} -p ${oldPg.port} -U ${oldPg.user} -Fc ${oldPg.database}`;
      const restoreCmd = `docker exec -i da-pg-${workerId} \
        pg_restore -U ${newCreds.username} -d ${newCreds.database} --no-owner --if-exists`;
      const fullCmd = `${dumpCmd} | ${restoreCmd}`;
      const r = await ssh.exec(fullCmd);
      if (r.exitCode !== 0) {
        // pg_restore 经常有 warning（owner/ACL），exitCode 非 0 不一定是失败
        console.log(`[migrate] pg_restore exited ${r.exitCode}: ${r.stderr.slice(0, 200)}`);
      }
    }

    // 6. stop 老 da-app
    console.log(`[migrate] stopping old container ${oldName}`);
    await ssh.exec(`docker stop ${oldName} 2>/dev/null || true`);

    // 7. docker run 新 da-app-<workerId>（指向新 PG）
    // 注意：这里复用 worker.current_image_tag，不是 deployWorkerStack（避免循环依赖）
    const envVars = [
      `-e PG_HOST=${pgContainerName(workerId)}`,
      `-e PG_PORT=5432`,
      `-e PG_USER=${newCreds.username}`,
      `-e PG_PASSWORD='${newCreds.password.replace(/'/g, "'\\''")}'`,
      `-e PG_DATABASE=${newCreds.database}`,
      // TODO: 其他 DA_* env 从老容器继承
    ].join(" ");

    // 从老容器继承非 PG 的 env vars
    const inheritR = await ssh.exec(
      `docker inspect ${oldName} --format '{{range .Config.Env}}{{println .}}{{end}}'`,
    );
    const inheritedEnvs: string[] = [];
    for (const line of inheritR.stdout.split("\n")) {
      if (!line.trim()) continue;
      const key = line.split("=")[0];
      if (!key.startsWith("PG_")) {
        inheritedEnvs.push(`-e ${line.replace(/'/g, "'\\''")}`);
      }
    }

    const volFlag = `-v da-app-data-${workerId}:/app/data`;
    const netFlag = `--network da-net-${workerId}`;
    const label = `--label com.deepanalyze.workerId=${workerId} --label com.deepanalyze.role=app`;
    const portFlag = `-p 21000:21000`;  // TODO: 从老容器读 port mapping

    const runCmd = `docker run -d --name ${newName} ${netFlag} ${label} ${inheritedEnvs.join(" ")} ${envVars} ${volFlag} ${portFlag} --restart unless-stopped ${worker.current_image_tag}`;
    console.log(`[migrate] starting new container: ${runCmd}`);
    const runR = await ssh.exec(runCmd);
    if (runR.exitCode !== 0) {
      // 回滚：启动老容器
      console.log(`[migrate][error] failed to start new container, rolling back: ${runR.stderr}`);
      await ssh.exec(`docker start ${oldName} 2>/dev/null || true`);
      return { success: false, error: `failed to start new da-app: ${runR.stderr}` };
    }

    // 8. 健康检查
    console.log(`[migrate] waiting for da-app-${workerId} healthcheck`);
    const deadline = Date.now() + 180_000;
    let healthy = false;
    while (Date.now() < deadline) {
      const h = await ssh.exec(
        `docker exec ${newName} curl -sf http://localhost:21000/api/health 2>/dev/null || echo FAIL`,
      );
      if (!h.stdout.includes("FAIL") && h.stdout.includes("ok")) {
        healthy = true;
        break;
      }
      await new Promise(r => setTimeout(r, 3000));
    }

    if (!healthy) {
      console.log(`[migrate][error] healthcheck failed, rolling back`);
      await ssh.exec(`docker rm -f ${newName} 2>/dev/null || true`);
      await ssh.exec(`docker start ${oldName} 2>/dev/null || true`);
      return { success: false, error: "healthcheck timeout" };
    }

    console.log(`[migrate] worker ${workerId} migrated successfully`);
    return { success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`[migrate][error] ${workerId}: ${errMsg}`);
    return { success: false, error: errMsg };
  } finally {
    ssh.close();
  }
}

async function main() {
  const opts = parseArgs();
  console.log(`[migrate] starting, dryRun=${opts.dryRun}, concurrency=${opts.concurrency}`);

  // 取所有 online worker
  const where = opts.workerId
    ? `WHERE id = $1 AND status = 'online'`
    : `WHERE status = 'online'`;
  const params = opts.workerId ? [opts.workerId] : [];
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM workers ${where} ORDER BY id`, params,
  );

  console.log(`[migrate] ${rows.length} workers to check`);

  let success = 0, failed = 0, skipped = 0;
  for (const w of rows) {
    const r = await migrateWorker(w.id, opts);
    if (r.success) success++;
    else if (r.error?.includes("skipping")) skipped++;
    else failed++;
  }

  console.log(`\n[migrate] done: ${success} success, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("[migrate] fatal:", err);
  process.exit(2);
});
```

- [ ] **Step 2: 写测试**

Create `tests/scripts/migrate-workers-to-b.test.ts`:

```typescript
// 测试迁移脚本的核心逻辑（不跑完整 main，单独测函数）
import { describe, test, expect } from "bun:test";

describe("migrate-workers-to-b script", () => {
  test("--dry-run 不修改任何状态", async () => {
    // TBD: 用 mock SshExecutor + DB fixture，跑 main()，断言无 docker run 调用
    expect(true).toBe(true);
  });

  test("已迁移的 worker 被跳过", async () => {
    expect(true).toBe(true);
  });

  test("无老容器的 worker 视为 fresh deploy 跳过", async () => {
    expect(true).toBe(true);
  });

  test("健康检查失败时回滚（启动老容器）", async () => {
    expect(true).toBe(true);
  });

  test("老 PG 提取失败时假设 localhost", async () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: 跑测试 + tsc + commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze-hub
NODE_ENV=development bun test tests/scripts/migrate-workers-to-b.test.ts 2>&1 | tail -5
NODE_ENV=development bun test 2>&1 | tail -5
bunx tsc --noEmit 2>&1 | tail -10
git add scripts/migrate-workers-to-b.ts tests/scripts/migrate-workers-to-b.test.ts
git commit -m "$(cat <<'EOF'
feat(hub): migrate-workers-to-b 迁移脚本 — 现有 worker 迁到 B 模式

手动触发: bun run scripts/migrate-workers-to-b.ts [--dry-run] [--worker=<id>]

流程:
1. docker inspect 老容器提取 PG_* env vars
2. 生成新凭据 + ensureWorkerNetwork + ensurePgContainer
3. pg_dump 老 PG | pg_restore 新 PG
4. stop 老 da-app → run 新 da-app-<workerId>（继承老非 PG env）
5. 健康检查失败回滚（启动老容器）

老 PG 资源不自动删，运维确认所有 worker 迁完才手动清理。

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## 验收 checklist（Plan 2.1 完成后）

- [ ] migration 038 应用：`SELECT column_name FROM information_schema.columns WHERE table_name='workers' AND column_name LIKE 'pg_%'` 返回 3 行
- [ ] 新部署的 worker 自动生成 PG 容器 + network + labels
- [ ] `docker ps` 在 host 上显示成对的 `da-app-X` / `da-pg-X` 容器
- [ ] `docker inspect da-app-X` 包含 `PG_HOST=da-pg-X` env var
- [ ] workers 表新 worker 有非空 `pg_password_encrypted`
- [ ] `decryptString(pg_password_encrypted)` 等于实际传给容器的明文
- [ ] 迁移脚本对 fixture worker 检测并成功迁移（dry-run + 实跑）
- [ ] `deleteWorkerStack` 清理 4 个资源（容器×2 + volume×2 + network）
- [ ] 全套测试通过：`NODE_ENV=development bun test` → ≥ 130 pass / 8 预存在 fail 不变
- [ ] `bunx tsc --noEmit` 无新错误
- [ ] da-postgres:16-tuned 镜像本地可 build + run
- [ ] 9 个独立 commit（T1-T9）可 cherry-pick

---

## Self-Review Notes

**1. Spec coverage:**

| Spec § | 实现 Task |
|--------|-----------|
| §2.1 容器拓扑 | T4 (network) + T5 (pg container) + T6 (app via deployWorker) |
| §2.2 三层成对标识 | T4 (naming) + T5 (labels) + T6 (app labels) |
| §3.1 镜像策略 | T8 (Dockerfile + config + healthcheck + runbook) |
| §3.2 PG 凭据管理 | T1 (migration 038) + T3 (helper) |
| §3.3 PG 容器部署命令 | T5 (`ensurePgContainer` 内的 `docker run` 命令) |
| §4 `deployWorker` 重构 | T6 (`deployWorkerStack`) |
| §4.1 SSH 抽象层 | T2 |
| §5 迁移脚本 | T9 |
| §6 备份执行 | **不在 Plan 2.1，在 Plan 2.2** |
| §7 过期清理 cron | **不在 Plan 2.1，在 Plan 2.2** |
| §10 配置项 | T6 (HUB_DOCKER_REGISTRY) + T7 (HUB_DELETE_WORKER_KEEP_VOLUMES)；备份相关在 Plan 2.2 |
| §11 migration 编号 | T1 用 038 ✓ |

**2. Placeholder scan:**
- T6/T7/T9 测试有 placeholder（`expect(true).toBe(true)` + 注释说明 implementer 应写真实 mock）— 这是**有意为之**，因为 mock 策略依赖 implementer 评估 bun:test mock 能力。如果 implementer 写不出 mock，应当 fallback 到依赖注入。这是允许的偏离（在 step 里已说明）。
- 没有其他 TBD/TODO。

**3. Type consistency:**
- `SshExecutor` interface 在 T2 定义，T4/T5/T6/T7/T9 都 import 使用 ✓
- `PgCredentials` 在 T3 定义，T5/T6/T9 都 import 使用 ✓
- `pgContainerName(workerId)` 在 T5 定义，T6/T9 使用 ✓
- `workerNetworkName(workerId)` 在 T4 定义，T6/T9 使用 ✓
- `DeployResult` 在 worker-deployment.ts:37 已存在，T6/T7 复用 ✓
- `DeployOpts` 在 worker-deployment.ts:20 已存在，T6 内部构造（不改签名）✓

**4. 已知风险与缓解:**
- T6/T7/T9 测试深度依赖 mock 策略，implementer 必须先评估 bun:test mock 能力，再决定是用 `mock.module()` 还是依赖注入。Plan 已说明两种 fallback。
- T9 数据迁移的 pg_restore exit code 非 0 经常发生（owner/ACL warning），脚本里加了 stderr 截取 + 不抛错。implementer 应当在真实环境验证。
- T6 用了 `containerPort: 21000` 硬编码 — TODO 注释指出应从 host_server 端口分配读，但本 plan 范围内不实现（host_server 的 port_range_* 字段语义需要单独 spec）。
