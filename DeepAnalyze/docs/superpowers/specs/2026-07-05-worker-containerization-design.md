# Spec 2: Worker 容器化部署模型 + 备份生命周期

**Status:** 设计已确认，待写实施 plan
**Created:** 2026-07-05
**Supersedes:** `2026-07-05-backup-lifecycle-backlog.md`（备忘录已被本 spec 正式覆盖）
**Related:** Spec 1 = `2026-07-05-hub-hardening-design.md`（已完成）

---

## 1. 背景

企业多租户验收（T01-T21）后的 P2 cleanup 拆成两类：
- **A 类（Spec 1）**：Hub 自身加固（`worker:deploy` 权限 seed、`HostServerRepo.update` SQL 注入、typing cast 清理）— 已完成
- **B+C 类（本 Spec 2）**：worker 备份保留 cron + 真实 SSH 备份执行 — 但 brainstorming 阶段发现现状部署模型存在更大问题，scope 扩大

### 1.1 发现的根本问题

brainstorming 中用户提出：既然每用户一个独立容器，为什么不用 `docker commit` 做备份？调查后发现：

1. **`docker commit` 设计上不抓 volume 数据** — 无论 PG 装在哪，生产部署必须用 volume 持久化，commit 抓不到
2. **DA 容器是 `FROM oven/bun:1`**，不包含 PostgreSQL
3. **PG 在 docker-compose 里是独立 service**（dev 模式），但生产部署 (`deployWorker`) **完全不传 PG 环境变量给 DA 容器**
4. **`workers` 表没有任何 PG 连接字段** — PG 来源对 Hub 是黑盒
5. **T19 的 `worker_backups` 表是纯 metadata**，从未执行真实 `pg_dump` / `tar`

结论：现状部署模型对 PG 是模糊的。Spec 2 不只是补备份，而是**重构 worker 容器化部署模型**，让 PG 成为 Hub 显式管理的资源。

### 1.2 已确认的设计决策

| 决策点 | 选择 | 理由 |
|-------|------|------|
| 主用例 | 仅升级安全（不做灾难恢复） | 用户明确选择 |
| 备份内容 | PostgreSQL 数据 + DA `/app/data` 上传文件 | 用户明确选择 |
| PG 部署架构 | **方案 B**：每 worker 一个独立 PG 容器，与 DA 容器成对 | 隔离强度匹配多租户 RBAC；运维心智模型清晰 |
| 容器标识 | 三层：命名规范 + docker labels + 专属 network | 人类可读 + 程序可识别 + 网络隔离 |
| 现有 worker 迁移 | 写迁移脚本，检测 + 自动迁移 | 用户明确选择 |
| docker commit | **不采用**（即使 all-in-one 也不可行） | volume 数据抓不到 |

---

## 2. 总体架构（B 模型）

### 2.1 worker 容器拓扑

每个 worker 在 host 上是一个「成对单元」，由 4 个 docker 资源组成：

```
worker-abc123 @ host
├── network:   da-net-worker-abc123
├── container: da-pg-worker-abc123     (da-postgres:16-tuned)
├── container: da-app-worker-abc123    (DA image)
├── volume:    da-pg-data-worker-abc123
└── volume:    da-app-data-worker-abc123
```

DA 容器通过容器名 `da-pg-<workerId>` 作为 `PG_HOST` 连接 PG，网络层完全隔离不暴露 host 端口。

### 2.2 三层成对标识

#### 标识 1：命名规范（人类可读）

| 资源 | 命名 | 示例 |
|------|------|------|
| DA 容器 | `da-app-<workerId>` | `da-app-worker-abc123` |
| PG 容器 | `da-pg-<workerId>` | `da-pg-worker-abc123` |
| Network | `da-net-<workerId>` | `da-net-worker-abc123` |
| DA volume | `da-app-data-<workerId>` | `da-app-data-worker-abc123` |
| PG volume | `da-pg-data-<workerId>` | `da-pg-data-worker-abc123` |

`docker ps` 即可看清归属，无需查 DB。

#### 标识 2：Docker labels（程序可识别）

每个容器打 3 个标签：
- `com.deepanalyze.workerId=<workerId>`
- `com.deepanalyze.orgId=<orgId>`
- `com.deepanalyze.role=app|pg`

运维查询：
- `docker ps --filter label=com.deepanalyze.workerId=abc123`
- `docker ps --filter label=com.deepanalyze.role=pg`

#### 标识 3：专属 docker network（强制隔离）

每 worker 一个 network，DA 和 PG 都加入。好处：
- PG 不暴露 host 端口（避免端口冲突 + 防误连）
- 不同 worker 的 PG 网络隔离，杜绝串库
- 删 worker 时按命名前缀清理 network，无残留

### 2.3 Hub 职责扩展

Hub 现在全面管理 worker 的 docker 资源生命周期：

| 资源 | 当前 | Spec 2 后 |
|------|------|-----------|
| DA 容器 | ✓ `deployWorker` 已管 | 重构为 `deployWorkerStack` 的一部分 |
| PG 容器 | ✗ 不存在 | **新增** `ensurePgContainer` |
| Network | ✗ 不存在 | **新增** `ensureNetwork` |
| Volume | 部分（DA volume） | 显式管理 DA + PG 两个 volume |

---

## 3. PG 容器配置

### 3.1 镜像策略

构建内部镜像 `da-postgres:16-tuned`：
- 基础：`postgres:16-alpine`
- 内置调优 `postgresql.conf`：
  ```
  shared_buffers = 32MB
  work_mem = 4MB
  maintenance_work_mem = 64MB
  max_connections = 50
  effective_cache_size = 256MB
  ```
- 内置 healthcheck（`pg_isready`）

镜像 Dockerfile 放在 Hub 仓库的 `docker/da-postgres/Dockerfile`，作为发布流程的一部分构建并推到 registry。

**Registry 配置**（Hub 级 env）：
- `HUB_DOCKER_REGISTRY` env var，默认空（表示 docker hub）
- 部署时镜像名：`${HUB_DOCKER_REGISTRY}da-postgres:16-tuned`（registry 空时直接 `da-postgres:16-tuned`）

**Fallback**（客户环境无内部 registry）：
- 部署时挂载 `postgresql.conf` 到 stock `postgres:16-alpine` 容器
- 由 Hub 通过 SSH 上传 config 文件到 host `/tmp/`，再 `-v /tmp/pg.conf:/etc/postgresql/postgresql.conf`

### 3.2 PG 凭据管理

**`workers` 表新增 3 列**（migration 038）：
- `pg_database TEXT NOT NULL DEFAULT 'deepanalyze'`
- `pg_username TEXT NOT NULL DEFAULT 'da'`
- `pg_password_encrypted TEXT` — AES-256-GCM 密文

**加密复用现有 helper**（`src/core/crypto.ts`）：
- `encryptString(plaintext: string): string` — base64(iv[12] | authTag[16] | ciphertext)
- `decryptString(b64: string): string` — 反向操作

部署时随机生成 32 字节密码 → `encryptString()` 入库 → 部署时 `decryptString()` 解密 → 传给 PG 容器作 `POSTGRES_PASSWORD` env，传给 DA 容器作 `PG_PASSWORD` env。

### 3.3 PG 容器部署命令（参考）

```bash
docker run -d \
  --name da-pg-<workerId> \
  --network da-net-<workerId> \
  --label com.deepanalyze.workerId=<workerId> \
  --label com.deepanalyze.orgId=<orgId> \
  --label com.deepanalyze.role=pg \
  -v da-pg-data-<workerId>:/var/lib/postgresql/data \
  -e POSTGRES_DB=<pgDatabase> \
  -e POSTGRES_USER=<pgUsername> \
  -e POSTGRES_PASSWORD=<decryptedPassword> \
  ${HUB_DOCKER_REGISTRY}da-postgres:16-tuned
```

Hub 通过 SSH 跑这条命令前，必须轮询 `pg_isready` 确认 PG 启动完成（最长 30s 超时）。

---

## 4. `deployWorker` 重构

把现有 `deployWorker` 重构成 `deployWorkerStack(workerId, imageTag)`：

| Step | 操作 | 幂等性 |
|------|------|--------|
| 1 | `ensureNetwork`: `docker network create da-net-<workerId>` | 已存在则跳过 |
| 2 | `ensurePgContainer`: 生成/读取凭据 + run da-postgres + 等 `pg_isready` | 已存在则跳过 |
| 3 | `ensureAppContainer`: 现有逻辑（envVars 加 `PG_HOST=da-pg-<workerId>` + `PG_PASSWORD` + `PG_USER` + `PG_DATABASE`） | 已存在则报错 |
| 4 | DA 健康检查轮询（`/healthz` 200） | — |
| 5 | 写 audit log | — |

`deleteWorker(workerId)` 对称增加：
1. 停并删 DA 容器
2. 停并删 PG 容器
3. 删 DA volume 和 PG volume（可选保留 — 见 §10 配置）
4. 删 network

### 4.1 SSH 抽象层（前提条件）

`worker-deployment.ts` 当前直接 `import { Client } from "ssh2"`。为了可测试，先重构出 interface：

```typescript
interface SshExecutor {
  exec(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  pullFile(remotePath: string, localStream: Writable): Promise<void>;
  pushFile(localStream: Readable, remotePath: string): Promise<void>;
  close(): void;
}
```

生产：`RealSshExecutor`（ssh2 包装）。测试：`MockSshExecutor`（脚本化响应）。

现有 `connectSsh()` + `execRemote()` 改成 `RealSshExecutor` 的方法。

---

## 5. 现有 worker 迁移脚本

### 5.1 触发方式

手动命令 `bun run scripts/migrate-workers-to-b.ts`（不在 Hub 启动自动跑）。

理由：迁移有风险且需要停机窗口，运维应主动决定何时跑。脚本输出详细 log，每个 worker 一条记录。

### 5.2 检测逻辑

```
对每个 status='online' 的 worker:
  SSH host
  docker ps --filter name=^/da-pg-<workerId>$ --format '{{.Names}}'
  已存在 → 跳过（已迁移过）
  不存在 → 加入迁移队列
```

### 5.3 单 worker 迁移流程

```
1. 读取现有 DA 容器的 PG 配置（关键）：
   docker inspect da-app-<workerId> --format '{{range .Config.Env}}{{println .}}{{end}}'
   → 解析出 PG_HOST / PG_PORT / PG_USER / PG_PASSWORD / PG_DATABASE
   → 如果没有 PG env vars（旧部署模型），假设 localhost:5432 + 默认 user/db

2. 在 workers 表写入新凭据（pg_database / pg_username / pg_password_encrypted）

3. ensureNetwork + ensurePgContainer（启动新 PG 容器，空 DB）

4. 数据迁移（关键步骤，有停机）：
   pg_dump -h <oldHost> -U <oldUser> <oldDb> | docker exec -i da-pg-<workerId> pg_restore -U <newUser> -d <newDb>

5. docker stop 老 da-app 容器（保持运行直到这步以减少停机）

6. docker run 新 da-app 容器，PG_HOST=da-pg-<workerId> + 新凭据

7. 健康检查轮询（DA /healthz 200）

8a. 成功：写 audit log，标记迁移完成
8b. 失败：回滚（停新 da-app，启动老 da-app，老 PG 数据未动）
```

### 5.4 串行 + 可配并发

默认串行（一次迁一个 worker），减少风险。脚本支持 `--concurrency=N` 参数（默认 1），运维评估后可调。

### 5.5 老 PG 清理

迁移成功后，**老 PG 资源（容器/数据/卷）不自动删**。原因：
- 老可能是共享 PG（影响其他 worker）
- 即使是独立 PG，保留作为应急回滚源

脚本输出提示：「老 PG 资源未删除，运维确认所有 worker 迁移完成后手动清理」。

---

## 6. 备份执行（升级前）

### 6.1 触发

`upgradeWorker(workerId, newTag)` 中 `skipBackup=false` 时自动执行。备份成功后才进入实际升级流程。

### 6.2 备份内容（一个目录）

```
./data/backups/<workerId>/<backupId>/
├── pg.dump              # pg_dump -Fc（custom format，支持选择性还原）
├── app-data.tar.gz      # da-app-data-<workerId> volume 内容
└── manifest.json        # {workerId, image_tag, pg_version, sizes, sha256, created_at}
```

### 6.3 执行序列（单条 SSH 会话）

```bash
# 1. PG 备份（在 PG 容器内 pg_dump，输出重定向到 host 临时文件）
docker exec da-pg-<workerId> pg_dump -U <user> -Fc <db> > /tmp/<backupId>.dump

# 2. DA /app/data volume 备份（用临时 alpine 容器读 volume）
docker run --rm -v da-app-data-<workerId>:/data:ro -v /tmp:/out alpine \
  tar czf /out/<backupId>-data.tar.gz -C /data .

# 3. manifest 生成（在 host 上）
cat > /tmp/<backupId>-manifest.json <<EOF
{...}
EOF

# 4. Hub 通过 SFTP 拉三个文件到本地
# （或者用 cat 流式：ssh host "cat /tmp/<backupId>.dump" | hub-side-write）

# 5. host 清理
rm /tmp/<backupId>*
```

### 6.4 状态机（`worker_backups.status`）

| 状态 | 含义 |
|------|------|
| `created` | 备份进行中（pg.dump + tar 还在跑） |
| `verified` | 全部成功，文件已落到 Hub 本地，可进入升级 |
| `failed` | 任一步失败，Hub 端清理已生成的部分文件，upgradeWorker abort |
| `expired` | 过期清理 cron 已删除文件，DB 行保留作历史 |
| `deletion_failed` | 清理 cron 删文件失败，下次重试 |

### 6.5 manifest.json 字段

```json
{
  "backupId": "backup-abc123-20260705-103000",
  "workerId": "abc123",
  "workerImageTag": "v0.9.1",
  "pgVersion": "16.4",
  "pgDumpFormat": "custom",
  "files": {
    "pg.dump": { "sizeBytes": 1234567, "sha256": "..." },
    "app-data.tar.gz": { "sizeBytes": 2345678, "sha256": "..." }
  },
  "createdAt": "2026-07-05T10:30:00Z",
  "expiresAt": "2026-08-04T10:30:00Z"
}
```

未来还原时校验完整性 + 检测 PG 版本兼容性（如 old PG 16 → new PG 17 不直接兼容）。

### 6.6 `worker_backups` 表 schema 扩展

当前 schema（migration 035）有 `pg_dump_path` / `data_archive_path` / `size_bytes` 字段，但语义是占位符。Spec 2 给字段补实际语义：

- `pg_dump_path` → 存 `pg.dump` 相对路径（相对 `HUB_BACKUP_DIR`）
- `data_archive_path` → 存 `app-data.tar.gz` 相对路径
- `size_bytes` → `pg.dump` + `app-data.tar.gz` 总大小
- 新增 `manifest_path TEXT`（migration 039）→ 存 `manifest.json` 相对路径
- 新增 `pg_version TEXT`（migration 039）→ 用于版本兼容检查

`HUB_BACKUP_DIR` config 新增（默认 `./data/backups`）。

---

## 7. 过期清理 cron

### 7.1 触发

`src/main.ts` 加 setInterval：

```typescript
const CLEANUP_INTERVAL_MS =
  Number(process.env.HUB_BACKUP_CLEANUP_INTERVAL_HOURS ?? "24") * 3600_000;

// 启动后 1 分钟跑一次（快速清理积累的过期备份）
setTimeout(() => {
  cleanupExpiredBackups().catch(err =>
    console.error("[backup-cleanup] failed:", err)
  );
}, 60_000);

// 周期触发
setInterval(() => {
  cleanupExpiredBackups().catch(err =>
    console.error("[backup-cleanup] failed:", err)
  );
}, CLEANUP_INTERVAL_MS);
```

### 7.2 清理逻辑

```sql
SELECT id, worker_id, pg_dump_path, data_archive_path, manifest_path
FROM worker_backups
WHERE expires_at < NOW()
  AND status IN ('verified', 'failed')
```

对每行：
1. 删 Hub 上 `./data/backups/<workerId>/<backupId>/` 目录
2. 成功 → `UPDATE status='expired'`
3. 失败（权限/IO 错误）→ `UPDATE status='deletion_failed'`，记 audit log，下次 cron 重试

### 7.3 配置参数

加到 `src/core/config.ts`：

```typescript
backup: {
  retentionDays: parseInt(process.env.HUB_BACKUP_RETENTION_DAYS || "30", 10),
  cleanupIntervalHours: parseInt(process.env.HUB_BACKUP_CLEANUP_INTERVAL_HOURS || "24", 10),
  storageDir: process.env.HUB_BACKUP_DIR || "./data/backups",
},
```

写 `worker_backups.expires_at` 时用 `now() + retentionDays * interval '1 day'`。

---

## 8. Scope 拆分（两个 plan 顺序执行）

### Plan 2.1: 容器化部署模型（先做）

依赖关系：备份逻辑必须搭在新部署模型上，所以先做。

涵盖：
- §4 SSH 抽象层（前提）
- §2 三层成对标识
- §4 `deployWorkerStack` 重构
- §3 PG 容器配置（镜像、凭据、网络）
- §5 迁移脚本
- migration 038（workers 表加 PG 凭据列）

预计 7-9 个 task。

### Plan 2.2: 备份生命周期（后做）

涵盖：
- §6 备份执行
- §6.6 `worker_backups` schema 扩展（migration 039）
- §7 过期清理 cron
- §6.5 manifest 生成与校验

预计 4-5 个 task。

---

## 9. 测试策略

### 9.1 单元测试

- `deployWorkerStack` 命令序列（用 MockSshExecutor，验证调用顺序和参数）
- `cleanupExpiredBackups` 状态转换（DB fixture + 文件系统 mock）
- 迁移脚本检测逻辑（fixture workers 表）
- 备份执行流程（MockSshExecutor，验证 SSH 命令序列 + 文件操作）

### 9.2 集成测试

- 启动真实 PG 容器（testcontainers 或本地 docker），验证 pg_dump → pg_restore 往返
- 真实文件系统操作（备份目录创建/删除/读取 manifest）

### 9.3 E2E 测试

- 全 stack 部署到一个 host（CI 用 docker-in-docker 或本地 docker）
- 备份 → 升级失败 → 回滚流程

### 9.4 SSH mock 层

§4.1 描述的 `SshExecutor` interface 是测试前提。所有涉及 SSH 的逻辑都通过此 interface 注入 mock。

---

## 10. 配置项汇总

| Config key | Env var | 默认值 | 用途 |
|-----------|---------|--------|------|
| `HUB_DOCKER_REGISTRY` | 同名 | `""` | da-postgres 镜像 registry 前缀 |
| `HUB_BACKUP_DIR` | 同名 | `./data/backups` | 备份文件根目录 |
| `HUB_BACKUP_RETENTION_DAYS` | 同名 | `30` | 备份保留天数（写 expires_at 用） |
| `HUB_BACKUP_CLEANUP_INTERVAL_HOURS` | 同名 | `24` | cron 周期 |
| `HUB_DELETE_WORKER_KEEP_VOLUMES` | 同名 | `true` | 删 worker 时是否保留 volume（应急保留） |

---

## 11. migration 编号

- **037** 已分配给 Spec 1（worker:deploy 权限 seed）
- **038** = Spec 2.1 — workers 表加 PG 凭据列（`pg_database`, `pg_username`, `pg_password_encrypted`）
- **039** = Spec 2.2 — `worker_backups` 表加 `manifest_path`、`pg_version` 列

---

## 12. 风险与开放问题

### 12.1 已识别的风险

| 风险 | 缓解 |
|------|------|
| 迁移脚本停机时间过长（大 DB pg_dump+restore） | 默认串行；大 DB 客户可手工分批；监控迁移时间，超过阈值告警 |
| 老 PG 是共享 PG，迁移影响其他 worker | 检测脚本只读 `docker ps`，不动 PG；实际迁移单 worker 时只 pg_dump 该 worker 的 DB，不动其他 DB |
| `da-postgres:16-tuned` 镜像在客户环境无法 pull | 提供 stock postgres + config 挂载 fallback |
| `pg_dump` 与目标 PG 版本不一致导致 restore 失败 | manifest 记录 `pgVersion`，restore 前检查兼容性 |
| Hub 重启时 cron 任务丢失 | setTimeout 启动后 1 分钟跑一次补偿；status='deletion_failed' 的会下次重试 |
| 删 worker 时误删其他 worker 的 volume | 命名严格前缀 `da-pg-data-<workerId>` + 删除前校验 label |

### 12.2 留待 plan 阶段细化的开放问题

- `pg_dump` 在 host 上的临时文件位置（`/tmp` vs `/var/tmp` vs 专用目录）
- 大 DB（>10GB）的超时策略（默认无超时？可配置？）
- Hub 磁盘空间不足时备份失败的前置检查（开始备份前 `df -h`）
- 迁移脚本如果检测到 worker 既有 da-pg 容器又有外部 PG 引用（部分迁移状态），如何处理

---

## 13. 验收 checklist

### Plan 2.1 完成后

- [ ] 新部署的 worker 自动生成 PG 容器 + network + labels
- [ ] `docker ps` 在 host 上显示成对的 da-app / da-pg 容器，命名规范一致
- [ ] `docker inspect da-app-X` 显示 PG_HOST=da-pg-X env var
- [ ] workers 表新 worker 有非空 pg_password_encrypted
- [ ] `decryptString(pg_password_encrypted)` 等于实际传给容器的明文
- [ ] 迁移脚本对现有 worker 检测并成功迁移（集成测试用 fixture）
- [ ] `deleteWorker` 清理 4 个资源（容器×2 + volume×2 + network）
- [ ] 全套测试通过，无新 fail
- [ ] `bunx tsc --noEmit` 无新错误

### Plan 2.2 完成后

- [ ] `upgradeWorker(skipBackup=false)` 在 host 上执行 pg_dump + tar
- [ ] 备份目录结构和 manifest.json 内容符合 §6.5 规范
- [ ] 备份失败时 upgradeWorker abort，无部分升级
- [ ] cron 每 24h 跑一次，过期备份标 `'expired'`，文件已删
- [ ] `HUB_BACKUP_RETENTION_DAYS=7` 时新备份 expires_at = created_at + 7 天
- [ ] 还原测试：从备份 pg_restore 到空 PG，DA 启动后能读出原数据
- [ ] 全套测试通过，无新 fail

---

## 14. 不在 Spec 2 范围

- bundle upload 端点补全（独立 task）
- ssh_key_encrypted 在 PATCH 时是否正确加密客户端明文输入（独立 audit task）
- 多机部署时的备份同步（YAGNI）
- Hub 整体 scheduler 框架（如果有其他周期任务需求再说，目前只需一个 setInterval）
- PG 跨大版本升级（16→17）的 pg_upgrade 流程（YAGNI，预留 manifest.pg_version 字段供未来用）
- S3 等远程对象存储后端（YAGNI，本地磁盘优先；用户上量后再说）

---

## 附录 A：当前代码状态（grep 验证）

### workers 表 schema（截至 migration 037）

- migration 001: id, hostname, endpoint, version, capabilities, status, worker_token, ...
- migration 019: + assigned_user_id, da_url, ssh_target_host/port/user, ssh_key_encrypted, current_image_tag, last_health_status
- migration 029: + host_id, host_port, port_block_size, gpu_device, decommissioned_at, labels, last_heartbeat_at, last_heartbeat_ok, da_version, uptime_seconds
- **没有任何 PG 连接字段** ← Spec 2 §3.2 补

### `worker-deployment.ts` 当前不传 PG env vars

grep 结果：`PG_HOST|PG_PASSWORD|PG_USER|PG_DATABASE|PG_PORT` 在 `worker-deployment.ts` 中**无任何匹配**。

envVars 由调用方传入（注释列出 `DA_AUTH_MODE, DA_JOIN_TOKEN, DA_HUB_URL, ...`），不含 PG。这是 Spec 2 §4 要消除的歧义。

### host_servers 表无 docker_registry 字段

migration 027 schema 完整字段见代码，无 docker_registry。Spec 2 §3.1 用 Hub 级 env var（`HUB_DOCKER_REGISTRY`）替代。

### 加密 helper 签名（`src/core/crypto.ts`）

```typescript
export function encryptString(plaintext: string): string;
export function decryptString(b64: string): string;
```

格式：`base64(iv[12] | authTag[16] | ciphertext)`，AES-256-GCM。

注：`host_servers.ssh_key_salt` 列存在但 crypto.ts 不使用 salt（key 来自 `HUB_DATA_KEY` env 直接 padEnd 到 32 字节）。这是预存在的 oddity，不在 Spec 2 范围。
