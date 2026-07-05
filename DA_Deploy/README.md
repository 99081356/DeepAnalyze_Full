# DeepAnalyze Hub 正式部署 Kit

本目录是 DeepAnalyze Hub 控制面的生产部署工具集，覆盖**离线 / 在线**两种部署方式，并附带备份、恢复、升级、密钥管理脚本。

> Hub 是中央控制面。Worker（即 DeepAnalyze 实例）由 Hub 通过 **SSH 远程部署** 或 **本地 Docker 部署** 模式自动派发，本 kit 不直接管 Worker。

---

## 架构

**部署模式：local Docker（Hub 与 Worker 同机）**

```
┌─────────────────────────────────────────────────────────────────┐
│                       目标机（生产服务器）                        │
│                                                                  │
│   ┌───────────────┐         ┌──────────────────────────────┐   │
│   │  PostgreSQL 16 │ <────── │  Hub (port 22000)            │   │
│   │  (da-hub-pg)   │         │  - Hono + Bun                │   │
│   │  postgres:16-  │         │  - 40 migrations 自动执行     │   │
│   │  alpine        │         │  - 内置 docker CLI            │   │
│   └───────────────┘          │  - 挂载 docker.sock           │   │
│                              └──────────────┬───────────────┘   │
│   命名卷: da-hub-pgdata,                     │ docker.sock       │
│           da-hub-data                        ▼                   │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │  控制台部署时 Hub 在本机拉起 Worker 容器栈                  │  │
│   │   da-app-<workerId> ← deepanalyze/da:latest             │  │
│   │   da-pg-<workerId>  ← pgvector/pgvector:pg16 (含向量扩展)│  │
│   │   da-net-<workerId> ← 容器网络                            │  │
│   └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**4 个必需镜像**（部署前必须 `docker load` 到目标机）：

| 镜像 | 用途 |
|---|---|
| `deepanalyze-hub:latest` | Hub 控制面 |
| `postgres:16-alpine` | Hub 的 PG（关系数据，无 pgvector） |
| `deepanalyze/da:latest` | DA Worker 单体（前后端 + 模型） |
| `pgvector/pgvector:pg16` | Worker 的 PG（**含 pgvector**，向量检索必需）|

> Hub 与 Worker 的 PG 是**两个不同镜像**，不可合并：Hub 不需要向量扩展，Worker 必须有。

---

## 目录结构

```
DA_Deploy/
├── README.md                      ← 本文档
├── docker-compose.prod.yml        生产 compose（Hub + PG）
├── .env.production.example        环境变量模板
├── offline/                       离线打包 / 加载
│   ├── README.md
│   ├── build-bundle.sh            （构建机）打镜像 + kit 成 tar.gz
│   └── load-images.sh             （目标机）docker load 镜像
├── scripts/                       运维脚本
│   ├── generate-secrets.sh        生成所有密钥写入 .env
│   ├── backup.sh                  pg_dump + 数据卷备份
│   ├── restore.sh                 从备份恢复
│   ├── upgrade.sh                 升级 + 健康检查 + 自动回滚
│   ├── hub-backup.service         systemd service 示例
│   └── hub-backup.timer           systemd timer 示例（每日 03:00）
└── nginx/                         可选 nginx 反代（TLS 终止）
    ├── nginx.conf
    └── README.md
```

---

## 前置要求

- **目标机**：Linux x86_64，已安装 Docker 24+ 和 Docker Compose v2（`docker compose` 命令）
- **目标机**：可用磁盘 ≥ 30 GB（数据卷 + 模型仓库）
- **构建机**（仅离线流程）：有公网访问，安装 Docker、openssl
- **端口**：22000（Hub Web/API），可选 80/443（nginx）

---

## 流程 A：在线部署（目标机能上公网）

```bash
# 0. clone 仓库到目标机
git clone <repo-url> DeepAnalyze-Hub
cd DeepAnalyze-Hub/DA_Deploy

# 1. 生成密钥（自动写入 .env）
./scripts/generate-secrets.sh

# 2. 编辑 .env，至少确认 HUB_EXTERNAL_URL
#    HUB_EXTERNAL_URL=http://<本机内网IP>:22000
$EDITOR .env

# 3. 构建并启动（首次需要本机构建镜像）
HUB_IMAGE=deepanalyze-hub:latest \
  docker compose -f docker-compose.prod.yml build hub
docker compose -f docker-compose.prod.yml up -d

# 4. 等待就绪
curl http://localhost:22000/api/health
```

## 流程 B：离线部署（目标机无外网）

`build-bundle.sh` 一次打包 **4 个必需镜像**（Hub + Worker 全栈），完整流程见 [`offline/README.md`](./offline/README.md)：

```bash
# 构建机（有外网）
cd DeepAnalyze-Hub/
DA_Deploy/offline/build-bundle.sh                # 4 必需镜像
# DA_Deploy/offline/build-bundle.sh v0.7.8       # 显式指定版本
# → 产出 dist/da-hub-deploy-<ver>.tar.gz

# 拷贝 tar.gz 到目标机后
tar xzf da-hub-deploy-<ver>.tar.gz
cd da-hub-deploy-<ver>/
sha256sum -c SHA256SUMS                           # 校验完整性
bash DA_Deploy/offline/load-images.sh images/     # 加载 4 个镜像

cd DA_Deploy
./scripts/generate-secrets.sh
$EDITOR .env                                      # 确认 HUB_IMAGE + HUB_EXTERNAL_URL
docker compose -f docker-compose.prod.yml up -d   # 默认挂 docker.sock，hub 起来后能拉起 worker
```

打包的镜像（4 个，全部必需）：

| 镜像 | 用途 |
|---|---|
| `deepanalyze-hub:<ver>` | Hub 控制面 |
| `postgres:16-alpine` | Hub 元数据库 |
| `deepanalyze/da:<ver>` | DA Worker 单体（前后端 + 模型） |
| `pgvector/pgvector:pg16` | Worker 的 PG（含 pgvector，向量检索必需）|

> 没有可选镜像。本 kit 走 local Docker 模式，Worker 用 `deepanalyze/da` 单体镜像（已含 embedding/whisper/docling 等全部能力）。

---

## 首次登录

1. 浏览器访问 `http://<本机IP>:22000`
2. 用户名 `admin`，密码查看 `.env` 中的 `ADMIN_INIT_PASSWORD`
3. 登录后建议立即在控制台修改密码

> 登录页**不再显示默认凭据提示**（已移除）。`admin` 是 migration 008 seed 的 super_admin，初始密码由 `ADMIN_INIT_PASSWORD` 环境变量决定，不设则回退到 dev 弱口令 `admin123`（生产环境通过 compose `${ADMIN_INIT_PASSWORD:?...}` 强制必填，缺失会拒绝启动）。

---

## 环境变量速查

| 变量 | 必填 | 默认 | 说明 |
|---|:---:|---|---|
| `ADMIN_INIT_PASSWORD` | ✅ | — | admin 账号初始密码（migration 008 使用） |
| `PG_PASSWORD` | ✅ | — | PostgreSQL 密码 |
| `JWT_SECRET` | ✅ | — | JWT HS256 签名密钥（兜底） |
| `JWT_REFRESH_SECRET` | ✅ | — | Refresh token 签名密钥 |
| `HUB_DATA_KEY` | ✅ | — | AES-256-GCM 主密钥（≥32 字符），加密 SSH 私钥 |
| `HUB_EXTERNAL_URL` | ✅ | — | Worker 回访 Hub 的 URL |
| `HUB_IMAGE` | — | `deepanalyze-hub:latest` | Hub 镜像 tag |
| `PORT` | — | `22000` | 宿主映射端口 |
| `JWT_EXPIRY` | — | `7d` | access token 过期 |
| `HUB_BACKUP_RETENTION_DAYS` | — | `30` | 控制台备份保留期 |
| `HUB_DOCKER_REGISTRY` | — | 空 | 自建 registry 地址 |
| `HUB_DA_IMAGE` | — | `deepanalyze/da:latest` | local 模式 worker 应用镜像（需先 docker load）|
| `HUB_DA_PG_IMAGE` | — | `pgvector/pgvector:pg16` | local 模式 worker 的 PG 镜像（含 pgvector）|

完整字段见 [`.env.production.example`](./.env.production.example)。`generate-secrets.sh` 一键生成所有「必填」密钥。

---

## 运维操作

### 备份

```bash
# 手动备份（产出 ./backups/hub-db-*.sql.gz + hub-data-*.tar.gz）
./scripts/backup.sh

# 定时备份（systemd）
sudo cp scripts/hub-backup.{service,timer} /etc/systemd/system/
# 编辑 service 中的 WorkingDirectory / User
sudo systemctl enable --now hub-backup.timer
```

### 恢复

```bash
# 从最新备份恢复（交互确认）
./scripts/restore.sh ./backups

# 指定特定备份
./scripts/restore.sh ./backups hub-db-20260101_030000.sql.gz
```

### 升级（带自动回滚）

```bash
# 在线升级（拉新镜像）
./scripts/upgrade.sh v0.7.8

# 离线升级（先 docker load 新镜像）
./scripts/upgrade.sh v0.7.8 --load

# 升级前自动备份；如不想备份（不推荐）加 --no-backup
```

升级流程：备份 → 切镜像 → `up -d` → 90s 健康检查 → 失败自动回滚到旧 tag。

### 日志

```bash
docker compose -f docker-compose.prod.yml logs -f hub
docker compose -f docker-compose.prod.yml logs -f postgres
```

---

## 故障排查

### compose 启动报 `variable is not set` / `${VAR:?...}`
`.env` 中对应必填项为空。运行 `./scripts/generate-secrets.sh` 自动补齐。

### `/api/health` 502 / Hub 起不来
```bash
docker compose -f docker-compose.prod.yml logs --tail=100 hub
```
常见原因：
- migration 报错（数据库连接失败）→ 检查 `PG_*` 变量
- RSA keypair 权限/路径错误 → 检查 `secrets/keys/` 是否挂载进容器
- `ADMIN_INIT_PASSWORD` 含特殊字符导致 shell 解析问题 → 用引号包裹

### Worker 无法连 Hub（SSO 失败 / bundle 拉不到）
`HUB_EXTERNAL_URL` 必须是 Worker 能访问到的地址。`localhost` 仅适用于本机部署，远程 Worker 必须用 Hub 的内网 IP / 域名。

### Hub 控制台部署 Worker 时 `Cannot connect to the Docker daemon`
本 kit 走 local Docker 模式，Hub 容器必须挂载 `docker.sock`。检查 `docker-compose.prod.yml` 中 hub 服务 volumes 是否有 `- /var/run/docker.sock:/var/run/docker.sock`（默认已启用，不要注释）。

⚠ 这等同于把宿主 root 权限授予 Hub 容器。本 kit 假设部署在受控内网，Hub 已通过其他手段隔离。

### Hub 控制台部署 Worker 时 `docker: No such image: deepanalyze/da:latest`
4 个镜像没全 load。检查：`docker images | grep -E 'deepanalyze|pgvector'`，应有 `deepanalyze/da:latest` 和 `pgvector/pgvector:pg16`。缺则重跑 `bash DA_Deploy/offline/load-images.sh images/`。

### 升级后业务异常 / migration 报错
`./scripts/upgrade.sh` 自带回滚；若回滚后仍异常，用备份恢复：
```bash
./scripts/restore.sh ./backups
```

---

## 安全说明

- **默认凭据已移除**：登录页不再显示 `admin/admin123` 提示，用户名不再预填
- **强制强密码**：生产 compose 用 `${ADMIN_INIT_PASSWORD:?...}` 语法，不设密钥拒绝启动
- **JWT RS256**：RSA keypair 由 `generate-secrets.sh` 显式生成，存于 `secrets/keys/`（与卷绑定），可备份/迁移
- **AES-256-GCM**：SSH 私钥等敏感数据由 `HUB_DATA_KEY` 加密存储；**该 key 丢失会导致数据无法解密，务必备份**
- **docker.sock**：本 kit 走 local 模式，**默认挂载** docker.sock（Hub 需要它拉起 worker 容器）。这等同于把宿主 root 权限授予 Hub 容器，仅适用于受控内网且 Hub 已隔离的场景
- **TLS**：内网默认 HTTP 直连；如需 HTTPS 走 nginx（见 [`nginx/README.md`](./nginx/README.md)）

---

## 备份清单（部署后请妥善保存）

| 文件 | 重要性 | 用途 |
|---|---|---|
| `DA_Deploy/.env` | ⭐⭐⭐⭐⭐ | 所有密钥，丢了无法恢复已有数据 |
| `DA_Deploy/secrets/keys/priv.pem` | ⭐⭐⭐⭐⭐ | JWT 签名私钥，丢了所有现有 token 失效 |
| `backups/` | ⭐⭐⭐⭐ | 数据库 + 数据卷快照 |

建议：把这三项一起 tar 加密后存到独立介质（NAS / 异地）。
