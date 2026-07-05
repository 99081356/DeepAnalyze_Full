# 离线部署流程（local Docker 模式）

适用于目标机**无法访问公网**的内网/隔离环境。整体流程：构建机（有外网）打包 → 拷贝 → 目标机（无外网）加载部署。

## 架构（Hub + Worker 同机）

```
┌──────────────────┐   tar.gz (4 镜像+kit)  ┌──────────────────────────────────┐
│  构建机（有外网） │ ─────────────────────> │  目标机（无外网）                  │
│  build-bundle.sh │   U 盘 / scp / 内网    │  load-images.sh → docker compose  │
└──────────────────┘                        │  → Hub 起来后控制台部署 Worker     │
                                            └──────────────────────────────────┘
```

部署模式：**Hub 与 Worker 同机**。Hub 容器挂载宿主 `docker.sock`，通过控制台 `/api/v1/deploy` 在本机拉起 worker 容器（`da-app-*` + `da-pg-*`）。

## 打包的镜像（4 个必需，无可选）

| 镜像 tar | Tag | 用途 |
|---|---|---|
| `hub.tar` | `deepanalyze-hub:<ver>` | Hub 控制面 |
| `postgres.tar` | `postgres:16-alpine` | Hub 的 PG（关系数据，无 pgvector） |
| `worker.tar` | `deepanalyze/da:<ver>` | DA Worker 单体（前后端 + 模型，你 worker 容器实际用的） |
| `worker-pg.tar` | `pgvector/pgvector:pg16` | Worker 的 PG（**含 pgvector**，DA 向量检索必需）|

> `postgres.tar` 与 `worker-pg.tar` **不能合并**：Hub 的 PG 不需要向量扩展，Worker 的 PG 必须有 pgvector，分开是对的。

## 在构建机（有外网）执行

```bash
cd <repo-root>     # 即 DeepAnalyze-Hub/

# 默认从 package.json 取版本号
DA_Deploy/offline/build-bundle.sh
# 或显式指定版本号
DA_Deploy/offline/build-bundle.sh v0.7.8
```

产出 `dist/da-hub-deploy-<ver>.tar.gz`，含：
- `images/{hub,postgres,worker,worker-pg}.tar` — 4 个镜像
- `DA_Deploy/` — 完整部署 kit
- `VERSION` — 版本清单
- `SHA256SUMS` — 完整性校验

> 构建时间参考：Hub ~3 min、Worker ~10 min（含 docling/whisper Python 依赖）。总磁盘 ~2 GB（save 后去重）。

将 tar.gz 拷贝到目标机（U 盘 / scp / 内网文件服务器）。

## 在目标机（无外网）执行

```bash
# 1. 解压
tar xzf da-hub-deploy-<ver>.tar.gz
cd da-hub-deploy-<ver>/

# 2. 校验完整性（可选但推荐）
sha256sum -c SHA256SUMS

# 3. 加载 4 个镜像（hub / postgres / worker / worker-pg）
bash DA_Deploy/offline/load-images.sh images/

# 4. 生成密钥
cd DA_Deploy
./scripts/generate-secrets.sh

# 5. 编辑 .env：确认 HUB_IMAGE 与 HUB_EXTERNAL_URL
#    HUB_IMAGE 应等于 build-bundle.sh 输出的 deepanalyze-hub:<ver>
$EDITOR .env

# 6. 启动 Hub（compose 默认挂 docker.sock，让 Hub 能拉起 worker）
docker compose -f docker-compose.prod.yml up -d

# 7. 等待就绪并访问
curl http://localhost:22000/api/health
# 浏览器: http://<本机内网IP>:22000  用 admin + ADMIN_INIT_PASSWORD 登录
```

## Hub 控制台部署 Worker

Hub 启动后，4 个镜像都已 `docker load` 到目标机。在 Hub 控制台添加 Worker 时，Hub 会通过 docker.sock 在**本机**拉起两个容器：

- `da-app-<workerId>` ← `deepanalyze/da:latest`（worker 应用）
- `da-pg-<workerId>` ← `pgvector/pgvector:pg16`（worker 的 PG）

不需要再去 worker 主机操作。

## 故障排查

### `docker load` 报 `invalid tar header`
- tar.gz 拷贝过程中损坏，重新传输并 `sha256sum -c SHA256SUMS` 校验

### 启动后 `/api/health` 502 / connection refused
- `docker compose -f docker-compose.prod.yml logs hub` 看 migration 输出
- 常见原因：`.env` 中 `ADMIN_INIT_PASSWORD` 或其他 `${VAR:?...}` 必填项为空 → compose 会拒绝启动

### Hub 控制台部署 Worker 时 `docker: No such image: deepanalyze/da:latest`
- 4 个镜像没全 load。检查：`docker images | grep -E 'deepanalyze|pgvector'`，应有 `deepanalyze/da:latest` 和 `pgvector/pgvector:pg16`
- 缺则重跑 `bash DA_Deploy/offline/load-images.sh images/`

### Hub 控制台部署 Worker 时 `Cannot connect to the Docker daemon`
- compose 没挂 docker.sock。检查 `docker-compose.prod.yml` 中 hub 服务的 volumes 是否有 `- /var/run/docker.sock:/var/run/docker.sock`（默认已启用）
- Windows Docker Desktop 下确认 Docker Desktop 设置里勾选了「Expose daemon on tcp://localhost:2375」或 default socket 可用

### 构建机 build worker 时网络失败
- docling/torch/whisper 依赖大，pip 拉取可能超时
- 设镜像源重试：`docker build --network=host -t deepanalyze/da:<ver> -f DeepAnalyze/Dockerfile DeepAnalyze/`
- 或直接复用现有 worker 镜像（用 `export-images.sh` 而非 `build-bundle.sh`）
