# Spec 2 backlog: Worker 备份生命周期（B + C）

**Status:** 未 brainstorming，待 Spec 1（Hub 加固）实施完后启动
**Created:** 2026-07-05
**Related plan (Spec 1):** `docs/superpowers/plans/2026-07-05-hub-hardening.md`

本文档是**设计讨论备忘录**，不是 spec。目的是把 brainstorming 阶段（2026-07-05 对话）的结论、约束、待决问题留存下来，防止对话压缩后信息丢失。当 B+C 正式启动 brainstorming 时，本文档作为输入。

## 背景与动机

企业多租户验收（T01-T21）的 T19 实现了 `worker_backups` 表 + 升级/回滚流程，但**故意只做 metadata**（commit history 明确标注）。生产环境前需要补全两件事：

- **B（备份保留 cron）**: `expires_at` 字段写了 30 天后过期，但**没有任何代码标记 `'expired'` 状态**，也没有任何代码删除过期文件。结果：DB 行永久挂着、磁盘文件无限累积。
- **C（真实 SSH 备份执行）**: T19 在 `worker-backup.ts` 写了占位路径 `/opt/da/${workerId}/backups/${ts}.dump` 但**从未通过 SSH 执行任何 `pg_dump` / `tar` 命令**。升级前没有真实备份，回滚只能切镜像（DB schema 改动后起不来）。

B 和 C 高度耦合，**作为一个 spec 设计**：
- C 创建真实文件，B 管理这些文件的过期清理
- 没有 C，B 只是"标 DB 行 expired"（半成品）
- 没有 B，C 产生的文件无限累积撑爆磁盘
- 共享同一套调度基础设施（B 需要周期触发，C 需要异步执行）

## 探索阶段（2026-07-05）发现的关键事实

### T19 当前状态（来自 Explore 报告）

**`worker_backups` 表实际 schema**（migration 035）:
```
id TEXT PK
worker_id TEXT FK→workers(id) ON DELETE CASCADE
backup_type TEXT CHECK IN ('pre_upgrade','manual','scheduled')
from_tag TEXT, to_tag TEXT
pg_dump_path TEXT, data_archive_path TEXT  -- 都是占位字符串，没真文件
size_bytes BIGINT
status TEXT CHECK IN ('created','verified','restored','failed','expired')
deploy_job_id TEXT FK→deploy_jobs(id) ON DELETE SET NULL
created_by TEXT
created_at TIMESTAMPTZ
expires_at TIMESTAMPTZ  -- 写了 now()+30天，但没人读它
```

**`upgradeWorker` 当前流程**（`worker-deployment.ts:257-340`）:
1. SELECT worker SSH 凭据 + 当前 image_tag
2. 如果非 `skipBackup`：创建 `pre_upgrade` backup record，写占位 `pg_dump_path` / `data_archive_path`，**但没真的 pg_dump**
3. 调用 `deployWorker(newTag)` — 这一步真的 SSH 进 host 跑 `docker run`
4. 成功 → UPDATE backup.status='verified'；失败 → UPDATE backup.status='failed'
5. `rollbackWorker` 也是调 `upgradeWorker(oldTag)`，所以**回滚也不还原数据**，只换镜像

**`deleteBackup` domain 函数**（`worker-backup.ts:142`）注释明确写："file deletion is the caller's responsibility" — 但**没人在调**

### SSH 基础设施已具备

- 用 `ssh2` 库（`package.json:22`）
- `host_servers.ssh_key_encrypted` 列存 AES-256-GCM 密文
- `decryptSshKey(hostServerId)` helper 在 `worker-deployment.ts:463` 已存在
- `connectSsh(conn)` + `execRemote(conn, cmd, onLine)` helpers 在 `worker-deployment.ts:182-234`
- `deployWorker` 已经用这套跑 `docker run` / `docker pull` / `curl | docker load`
- **复用同一条 SSH 通道多跑 `pg_dump` + `tar` 是自然延伸**

### Bundle manifests 是文件存储的参考模型（但本身也不完整）

- Migration 025 + 030：`bundle_manifests` 表有 `file_path TEXT` + `file_size BIGINT` + `checksum_sha256`
- 物理存储：`./data/bundle/images/` 目录（`config.ts:64-67`，可通过 `HUB_BUNDLE_IMAGES_DIR` env 覆盖）
- `GET /bundle/images/:version/download` 用 `Bun.file()` 流式下载（`bundle.ts:44-78`）
- **但 upload 端点不存在** — `routes/bundle.ts` 没有 PUT/POST，文件靠 da-packer 在外部放进去
- **借鉴：备份文件存储可以走类似模式（本地磁盘 + DB file_path）**，但**必须自带 upload 流程**（因为备份是 Hub 自己 SSH 拉过来的，不是外部 push 的）

### 调度基础设施：完全空白

- `src/main.ts` 只有 `runMigrations()` + `createApp()` + `serve()`，**没有任何 setInterval / cron / 后台 loop**
- `package.json` 没有 `node-cron` / `node-schedule` / `bree` / `agenda` / `bull`
- 现有的"过期"逻辑（join tokens、SSO tickets、skill sharing）**全部是 consume-time 检查**：消费时 `WHERE expires_at > NOW()`，不主动清理
- worker_backups 是不同的 — 它的文件占磁盘，必须主动清理

## B 的开放设计问题（待 brainstorming 时决定）

### B-Q1: 调度方式选哪种？

| 方案 | 实现 | 优点 | 缺点 |
|------|------|------|------|
| A. main.ts setInterval | 在 main.ts 加 `setInterval(cleanupExpiredBackups, 24h)` | 零依赖；与现有进程同生命周期 | 进程崩溃即丢失（重启后会立即补一次？） |
| B. heartbeat 触发 | 在 `recordHeartbeat` 里检查上次 cleanup 时间，>24h 则跑 | 不需要新进程；与 worker 活动绑定 | 没 worker 的环境永不触发；耦合业务流量 |
| C. node-cron 库 | `import cron from "node-cron"; cron.schedule("0 3 * * *", ...)` | 标准 cron 表达式；进程内调度 | 新依赖；与 A 方案同样的崩溃问题 |
| D. 独立脚本 + 系统 cron | `bun run scripts/cleanup-backups.ts`，由 deploy 后的 cron 服务调用 | Hub 进程无需关心；运维方控制 | 增加部署复杂度；不跨平台 |

**初步倾向**：方案 A（main.ts setInterval），原因：
- Hub 进程被设计为长运行（systemd / docker 容器里都有 restart=unless-stopped）
- 没新依赖
- 简单可测（测试时可以手动调 cleanupExpiredBackups 函数）

待 brainstorming 时确认。

### B-Q2: cleanup 行为细节

- 多久跑一次？（每天 / 每小时 / 配置化）
- 标 `'expired'` 后**立即删文件**还是**宽限期再删**？（误删保护）
- 多大磁盘占用算太大？是否要按 total_size 触发紧急清理？
- 文件删除失败怎么办？（标 `deletion_failed` 状态？重试？）

### B-Q3: 调度配置如何参数化

- env vars: `HUB_BACKUP_CLEANUP_INTERVAL_HOURS=24` ?
- DB config 表里存？
- 硬编码（KISS）？

## C 的开放设计问题（待 brainstorming 时决定）

### C-Q1: 备份文件存哪儿？

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| 本地磁盘 `./data/backups/` | 跟 bundle images 一个模式 | 简单；现有模式；流式上传快 | 单机故障丢备份；磁盘有限 |
| S3 兼容对象存储 | minio / AWS S3 / Cloudflare R2 | 持久；可扩展；多机部署友好 | 新依赖（aws-sdk）、配置复杂 |
| host_server 本地保留 | 不上传到 Hub，备份就放 host 上 | 节省带宽；隔离性好 | host 故障即丢备份；Hub 不知道文件是否还在 |

**初步倾向**：本地磁盘优先（与 bundle 模式一致），S3 作为 follow-up（如果用户上量了再说）。

### C-Q2: pg_dump 怎么跑？

候选命令（伪代码）：
```bash
# 在 host 上通过 docker exec 跑
ssh host "docker exec $container pg_dump -U $user -Fc $db > /tmp/$ts.dump"
ssh host "docker cp $container:/app/data /tmp/$ts-data.tar"
ssh host "tar -czf /tmp/$ts-data.tar.gz -C /tmp $ts-data"
# 然后从 hub 拉过来
ssh host "cat /tmp/$ts.dump" > $hubStorage/$backupId.dump
```

或者用 sftp 流式：
```typescript
const sftp = await conn.getSftp();
const stream = sftp.createReadStream("/tmp/$ts.dump");
// pipeline 到 Bun.file("$hubStorage/$backupId.dump").writer()
```

**待决定**：
- 跑 `pg_dump` 是在 container 内（`docker exec`）还是 container 外直连 PG？
- 文件传输用 `exec + cat` 流式 vs SFTP？
- 中间临时文件（host 上的 /tmp/*.dump）什么时候删？

### C-Q3: 还原流程

回滚目前调 `upgradeWorker(oldTag)`，但加上真实备份后应该是：
1. SSH host
2. `docker stop $container`
3. `docker exec` 还原 pg_dump（先 drop+recreate 或 truncate？）
4. `docker cp` 还原 data.tar
5. `docker run` 用 old image_tag
6. 启动后健康检查

**待决定**：
- 还原是 in-place（覆盖现有 DB）还是创建新容器？
- DB schema 不兼容（new_tag 加了列，old_tag 不知道）怎么办？
- 还原前要不要再创建一个 "rollback-snapshot" 备份？

### C-Q4: 错误处理与状态机

- `backup.status` 从 `'created'` → `'verified'`（pg_dump 成功）/ `'failed'`（SSH 失败）
- 中间态怎么处理？部分文件成功了一半怎么办？
- 超大 DB（10GB+）备份超时怎么处理？

### C-Q5: 测试策略

- SSH 不能在 CI 真跑 → 需要 mock ssh2 Client
- 现有 `worker-deployment.ts` 没有 mock 层（直接 import ssh2）— 是否要先重构出 `SshExecutor` interface 让测试注入？
- 集成测试用什么 DB？docker pg 容器？

## B + C 共享的设计决策

### BC-D1: 备份文件元数据

需要在 `worker_backups` 表加列吗？
- 实际 `file_path` 已有（`pg_dump_path` + `data_archive_path`）— 但语义是占位符
- 加 `file_size_bytes` 已有（`size_bytes`）
- 加 `checksum_sha256` 验证完整性？
- 加 `storage_type`（'local' / 's3'）？

### BC-D2: 与 deploy_jobs 的关联

T19 已经把 `deploy_jobs.backup_id` 加了（migration 036）。需要反向关联吗（`worker_backups.deploy_job_id` 已有）。

## 不在 Spec 2 范围

- bundle upload 端点补全（独立 task）
- ssh_key_encrypted 在 PATCH 时是否正确加密客户端明文输入（独立 audit task）
- Hub 的整体 scheduler 基础设施（如果有其他周期任务需求再说）
- 多机部署时的备份同步（YAGNI）

## 已知约束（从探索阶段确定）

- Migration 编号从 **038** 开始（037 已分配给 Spec 1）
- 测试必须用 `NODE_ENV=development` 跑（否则 RSA env vars 缺失）
- `worker-deployment.ts` 当前直接 `import { Client } from "ssh2"` — 测试要 mock 必须先重构
- `HostServerRepo.update` 现在已有列白名单（Spec 1 T2 后）— 备份相关表结构的 ALTER 不受影响
- `audit_logs` 表存在（被 worker 部署等操作写入）— 备份/还原操作应当也写审计日志

## 启动 brainstorming 时的第一步

1. 确认 B+C 拆分是否仍然合理（也可以分别 brainstorm）
2. 决定 B-Q1（调度方案）和 C-Q1（存储方案）— 这两个决定其余设计
3. C-Q5（测试策略）是设计早期必须回答的（否则 TDD 无从下手）
4. 写 spec 到 `docs/superpowers/specs/2026-07-XX-backup-lifecycle-design.md`
5. 写 plan 到 `docs/superpowers/plans/2026-07-XX-backup-lifecycle.md`
