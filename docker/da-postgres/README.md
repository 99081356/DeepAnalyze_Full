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
