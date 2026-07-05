# Hub 分发与协作配置

## 概述

本文档描述 DeepAnalyze Hub 的分发、认证、Worker 管理与部署相关的配置。
所有配置通过环境变量传入，源代码定义于 [`src/core/config.ts`](src/core/config.ts)，
少数变量（`HUB_DATA_KEY`、`HUB_EXTERNAL_URL`）由使用方模块直接从 `process.env` 读取。

> 基础变量（`PORT`、`PG_*`、`JWT_SECRET`、`JWT_EXPIRY`、`WORKER_TOKEN_EXPIRY`）参见 [`.env.example`](.env.example)。
> 本文档仅覆盖 Phase A–F 引入的分发相关变量。

---

## 必需环境变量

### JWT / RS256 签名（Phase A）

Hub 默认签发 RS256 JWT。公钥用于 JWKS `/api/v1/auth/jwks.json`，私钥用于签名。

| 变量 | 说明 | 默认值 | 示例 |
|------|------|--------|------|
| `HUB_JWT_PUBLIC_KEY_PATH` | RS256 公钥 PEM 文件路径。未设置则 RS256 禁用。 | `""` | `/etc/hub/keys/pub.pem` |
| `HUB_JWT_PRIVATE_KEY_PATH` | RS256 私钥 PEM 文件路径。未设置则 RS256 禁用。 | `""` | `/etc/hub/keys/priv.pem` |
| `HUB_JWT_KEY_ID` | JWT `kid` header / JWKS 中的 key id | `hub-rs256-v1` | `hub-rs256-v1` |
| `HUB_HS256_TRANSITION_UNTIL` | HS256 验证回退截止时间（ISO 日期）。空则禁用回退。 | `""` | `2026-08-15T00:00:00Z` |

### Worker 加入令牌（Phase B）

通过 `/api/v1/workers/join-tokens` 签发一次性 join_token，新 Worker 凭此注册。

| 变量 | 说明 | 默认值 | 示例 |
|------|------|--------|------|
| `HUB_JOIN_TOKEN_EXPIRY` | join_token 有效期（_duration string_） | `24h` | `48h` |
| `HUB_JOIN_TOKEN_MAX` | 同时有效的 join_token 上限 | `100` | `200` |

### SSH 部署参数（Phase B / F）

Hub 通过 SSH 推送镜像、启动/停止/重启 Worker 容器。以下为连接默认值。

| 变量 | 说明 | 默认值 | 示例 |
|------|------|--------|------|
| `HUB_SSH_DEFAULT_PORT` | SSH 默认端口（未在 DB 指定时使用） | `22` | `2222` |
| `HUB_SSH_TIMEOUT` | SSH 单次连接超时（毫秒） | `60000` | `30000` |

### 模型仓库（Phase D）

`/api/v1/models/*` 端点的内部模型存储。

| 变量 | 说明 | 默认值 | 示例 |
|------|------|--------|------|
| `HUB_MODEL_REPO_DIR` | 模型文件存储目录 | `./data/model-repo` | `/data/model-repo` |
| `HUB_MODEL_MAX_SIZE` | 单个模型文件大小上限（字节） | `5368709120` (5 GiB) | `10737418240` |

### Bundle / 镜像（Phase E）

`/api/v1/bundle/*` 与 `/api/v1/images/*` 端点的离线 bundle 与镜像 tar 存储。

| 变量 | 说明 | 默认值 | 示例 |
|------|------|--------|------|
| `HUB_BUNDLE_IMAGES_DIR` | 镜像 tar 文件存储目录 | `./data/bundle/images` | `/data/bundle/images` |
| `HUB_BUNDLE_DIR` | 离线 bundle 元数据/manifests 根目录 | `./data/bundle` | `/data/bundle` |

### 部署 / 加密（Phase F）

| 变量 | 说明 | 默认值 | 示例 |
|------|------|--------|------|
| `HUB_EXTERNAL_URL` | DA Worker 反向访问 Hub 的基础 URL（用于 `curl` 拉取镜像） | `http://localhost:22000` | `https://hub.corp.com:22000` |
| `HUB_DATA_KEY` | SSH 私钥 AES-256-GCM 加密主密钥（≥32 字符）。未设置则回退到 `JWT_SECRET`。 | _回退到 `JWT_SECRET`_ | `<random-32-char-string>` |

> **安全提示**：生产环境必须显式设置 `HUB_DATA_KEY` 为独立的高熵随机字符串，
> 不要复用 `JWT_SECRET`。参见 [`src/core/crypto.ts`](src/core/crypto.ts)。

---

## 生成 RSA Keypair

```bash
# 生成 2048 位 RSA 私钥
openssl genpkey -algorithm RSA -out priv.pem -pkeyopt rsa_keygen_bits:2048

# 导出对应公钥
openssl rsa -pubout -in priv.pem -out pub.pem
```

将 `priv.pem` 与 `pub.pem` 路径分别配置到 `HUB_JWT_PRIVATE_KEY_PATH` 与 `HUB_JWT_PUBLIC_KEY_PATH`。
生产环境妥善保管 `priv.pem`（文件权限 `600`，避免入库）。

---

## HS256 → RS256 过渡

升级后 Hub 默认签发 RS256 token。**已经存在的 HS256 token** 在 `HUB_HS256_TRANSITION_UNTIL`
指定的时间之前仍可被验证（向后兼容窗口）。

- 推荐过渡期 **30 天**（在升级当日加 30 天作为截止）。
- 截止时间到达后，HS256 验证分支自动失效，仅 RS256 被接受。
- 过渡期结束后，可将 `HUB_HS256_TRANSITION_UNTIL` 置空并删除遗留 HS256 配置。

示例：

```bash
# 升级日（今天）+ 30 天
HUB_HS256_TRANSITION_UNTIL=2026-08-02T00:00:00Z
```

---

## SSH 部署流程

Worker 的部署/升级/停止/重启/回滚由 Hub 通过 SSH 远程执行。
端点定义于 [`src/server/routes/workers.ts`](src/server/routes/workers.ts)，
核心编排逻辑在 [`src/domain/worker-deployment.ts`](src/domain/worker-deployment.ts)。

1. **上传镜像**：管理员通过 `/api/v1/models/upload` 上传，或直接将 tar 文件放入 `HUB_BUNDLE_IMAGES_DIR`。
2. **发起部署**：调用 `/api/v1/workers/:id/deploy`（可先 `dry_run: true` 预览命令）。
3. **Hub 远程执行**：Hub SSH 到目标机，依次执行
   - `curl <HUB_EXTERNAL_URL>/api/v1/images/:tag/stream | docker load`
   - `docker run -d --name da-<workerId> -p <port>:21000 ...`
4. **健康检查**：容器启动后 Hub 轮询 `http://<host>:<port>/healthz`，通过后标记部署成功。
5. **失败回滚**：任意步骤失败时自动回滚到 `previous_image_tag`，并在 `deploy_jobs` 表记录详细日志。
6. **状态查询**：通过 `/api/v1/workers/:id/deploy/status` 查看部署日志与结果。

SSH 私钥在 Hub 数据库中以 **AES-256-GCM 密文** 存储（`ssh_key_encrypted` 列），
加密主密钥来自 `HUB_DATA_KEY`（或回退到 `JWT_SECRET`）。

---

## 本地 Docker 部署（用户-Worker 一对一绑定）

除 SSH 远程部署外，Hub 还支持**本地 Docker 部署模式**：Hub 容器通过挂载宿主机
Docker socket + docker CLI 直接管理本机容器，为每个用户自动创建专属 DA Worker 容器栈。

### 适用场景

- 开发/测试环境（Hub 与 Worker 在同一台机器）
- 小型企业内网部署（不需要多机分发）
- 用户登录后直接进入主界面（跳过 DA SetupWizard）

### 前置条件

1. Hub 容器挂载 Docker socket：`/var/run/docker.sock:/var/run/docker.sock`
2. Hub 镜像包含 docker CLI（见 [`Dockerfile`](Dockerfile) 中的静态二进制安装步骤）
3. 宿主机已拉取 DA 镜像（`deepanalyze/da:latest`）和 PG 镜像（`pgvector/pgvector:pg16`）

### 部署流程

1. **管理员登录 Hub** → 用户列表页
2. **点击「部署Worker」按钮** → Hub 自动执行：
   - 分配端口（21000-21099 范围内扫描可用端口）
   - 创建 Docker 网络 `da-net-<workerId>`
   - 创建 PG 容器 `da-pg-<workerId>`（带 healthcheck）
   - 创建 DA 容器 `da-app-<workerId>`（预置配置，跳过 SetupWizard）
   - 在 `workers` 表创建记录，绑定 `assigned_user_id`
3. **用户登录 Hub** → `/auth/login` 响应包含 `da_worker_id` 和 `da_url`
4. **前端自动 SSO 跳转** → DA Worker `/api/auth/sso/callback`
5. **DA 验证 ticket** → 校验 `ticket.user_id === worker.assigned_user_id`
6. **签发本地 session cookie** → 用户进入主界面

### 自动跳过 SetupWizard

Hub 部署 Worker 时，在 DA 容器启动后立即写入以下文件：

- `data/setup-complete.flag` — 标记 setup 已完成，前端跳过 wizard
- `data/config.yaml` — 默认配置（全云端模型策略，跳过本地模型下载）

DA 后端 `/api/setup/state` 返回 `{ complete: true }`，前端 App.tsx 据此跳过
SetupWizard，用户登录后直接进入主界面。

### 用户-Worker 绑定安全机制

- **SSO ticket 校验**：[`src/domain/sso-ticket.ts`](src/domain/sso-ticket.ts) 的
  `exchangeTicket` 函数校验 `ticket.user_id === worker.assigned_user_id`，
  确保用户只能登录自己绑定的 Worker。
- **Bearer fallback 禁用**：DA 的 auth 中间件
  ([`DeepAnalyze/src/server/middleware/auth.ts`](DeepAnalyze/src/server/middleware/auth.ts))
  禁用 Bearer token fallback，强制走 SSO cookie 路径，防止任意 Hub 用户用
  access_token 访问任意 DA Worker。

### 相关 API

| Method + Path | 说明 |
|---|---|
| `POST /api/v1/users/:id/deploy-worker` | 为用户部署专属 DA Worker 容器栈 |
| `DELETE /api/v1/users/:id/worker` | 删除用户的 Worker 容器栈 |

### 相关代码

| 文件 | 作用 |
|---|---|
| [`src/domain/local-deployment.ts`](src/domain/local-deployment.ts) | 本地 Docker 部署核心模块 |
| [`src/server/routes/users.ts`](src/server/routes/users.ts) | 部署/删除 Worker API 路由 |
| [`src/domain/sso-ticket.ts`](src/domain/sso-ticket.ts) | SSO ticket 交换 + 用户绑定校验 |
| [`frontend/src/pages/UserList.tsx`](frontend/src/pages/UserList.tsx) | 用户列表页（部署/删除按钮） |
| [`src/store/migrations/040_workers_status_deploying.ts`](src/store/migrations/040_workers_status_deploying.ts) | workers 表 status 约束扩展 |

---

## da-packer — 离线部署打包工具

[`scripts/da-packer/`](scripts/da-packer/) 是独立 CLI，用于构建 DeepAnalyze 离线一体化部署包。
不依赖 Hub/DA 后端运行，可在外网开发机独立使用（仅打包阶段需要 Docker 拉取镜像）。

### 使用

```bash
cd scripts/da-packer
bun install

# 构建完整 bundle（DA + Hub + 模型 + Skill）
DA_REPO_PATH=/path/to/DeepAnalyze \
bun run bin/da-packer.ts build \
  --da-version v0.9.0 \
  --hub-version v0.9.0 \
  --models bge-m3,whisper-tiny,whisper-base,docling \
  --skills enterprise-essentials \
  --output da-bundle-v0.9.0.tar.gz \
  --source hf_mirror \
  --platform linux/amd64,linux/arm64

# 查看已构建的包
bun run bin/da-packer.ts list

# 验证 bundle 完整性（对比 sidecar `.sha256` 文件）
bun run bin/da-packer.ts verify da-bundle-v0.9.0.tar.gz

# 查看内容
bun run bin/da-packer.ts info da-bundle-v0.9.0.tar.gz
```

### Bundle 结构

```
da-bundle-v0.9.0/
├── bundle-manifest.json   # 内容清单（checksumSha256 字段为空，以 sidecar 为准）
├── README.md              # 中文部署文档
├── install-hub.sh         # 一键安装脚本
├── docker-compose.yml     # Hub 部署 compose
├── images/                # 所有 Docker 镜像 tar
├── models/                # 模型权重
├── skills/                # Skill 包
├── config/                # 默认配置
└── scripts/               # health-check / backup / restore
```

Bundle 同目录下还会生成 `da-bundle-v0.9.0.tar.gz.sha256`（sidecar 文件，`sha256sum` 格式），
用于离线完整性校验。`install-hub.sh` 在目标机执行 `sha256sum -c` 完成自检。

### 部署到企业内网

```bash
# 1. 拷贝 bundle + sidecar 到目标机器
scp da-bundle-v0.9.0.tar.gz da-bundle-v0.9.0.tar.gz.sha256 target-host:/opt/

# 2. 解压 + 安装
ssh target-host
cd /opt/
sha256sum -c da-bundle-v0.9.0.tar.gz.sha256   # 校验完整性
tar xzf da-bundle-v0.9.0.tar.gz
cd da-bundle-v0.9.0/
sudo ./install-hub.sh \
  --data-dir /opt/hub/data \
  --port 22000 \
  --external-url https://hub.corp.internal:22000

# 3. 浏览器访问 https://hub.corp.internal:22000/setup
```

---

## 完整环境变量示例

参见 [`.env.example`](.env.example) —— 该文件按 Phase 分组列出了所有变量与默认值，
可直接复制为 `.env` 进行修改。
