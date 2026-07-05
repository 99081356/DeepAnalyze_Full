# 离线部署流程

适用于目标机**无法访问公网**的内网/隔离环境。整体流程：构建机（有外网）打包 → 拷贝 → 目标机（无外网）加载部署。

## 架构

```
┌──────────────────┐   tar.gz (镜像+kit)   ┌──────────────────┐
│  构建机（有外网） │ ────────────────────> │  目标机（无外网） │
│  build-bundle.sh │   U 盘 / scp / 内网   │  load-images.sh  │
└──────────────────┘                        └──────────────────┘
```

## 打包的镜像

`build-bundle.sh` 默认打 **6 个必需镜像**（Hub + Worker 全栈）：

| 镜像 tar | Tag | 用途 |
|---|---|---|
| `hub.tar` | `deepanalyze-hub:<ver>` | Hub 控制面 |
| `postgres.tar` | `postgres:16-alpine` | Hub 自己的元数据库 |
| `da-postgres.tar` | `da-postgres:16-tuned` | Worker 专用调优 PG（SSH stack 模式） |
| `da-backend.tar` | `deepanalyze-backend:<ver>` | DA Worker 应用 |
| `da-frontend.tar` | `deepanalyze-frontend:<ver>` | DA Worker nginx 前端 |
| `da-embedding.tar` | `deepanalyze-embedding:<ver>` | BGE-M3 语义搜索（默认含，可 `--no-embedding` 去掉）|

可选 GPU AI 子服务（`--with-gpu` 显式打开，仅 GPU 节点需要）：
`glm-ocr.tar` / `mineru.tar` / `paddleocr-vl.tar`

## 在构建机（有外网）执行

```bash
cd <repo-root>     # 即 DeepAnalyze-Hub/

# 默认：含 6 个必需镜像（含 embedding），不含 GPU
DA_Deploy/offline/build-bundle.sh

# 显式指定版本号
DA_Deploy/offline/build-bundle.sh v0.7.8

# GPU 节点：额外打 3 个 GPU 镜像
DA_Deploy/offline/build-bundle.sh v0.7.8 --with-gpu

# 无语义搜索需求时去掉 embedding（包更小）
DA_Deploy/offline/build-bundle.sh v0.7.8 --no-embedding
```

产出 `dist/da-hub-deploy-<ver>.tar.gz`，含：
- `images/*.tar` — 全部镜像
- `DA_Deploy/` — 完整部署 kit
- `VERSION` — 版本清单
- `SHA256SUMS` — 完整性校验

> 构建时间参考：Hub ~3 min、DA Backend ~10 min（含 docling/whisper Python 依赖）、Embedding ~5 min（含 BGE-M3 权重下载）、每个 GPU 镜像 ~10–20 min。总磁盘 ~15–25 GB（GPU 全量更大）。

将 tar.gz 拷贝到目标机（U 盘 / scp / 内网文件服务器）。

## 在目标机（无外网）执行

```bash
# 1. 解压
tar xzf da-hub-deploy-<ver>.tar.gz
cd da-hub-deploy-<ver>/

# 2. 校验完整性（可选但推荐）
sha256sum -c SHA256SUMS

# 3. 加载所有镜像（hub / postgres / da-postgres / da-backend / da-frontend / da-embedding [/*-gpu */]）
bash DA_Deploy/offline/load-images.sh images/

# 4. 生成密钥
cd DA_Deploy
./scripts/generate-secrets.sh

# 5. 编辑 .env：确认 HUB_IMAGE 与 HUB_EXTERNAL_URL
#    HUB_IMAGE 应等于 build-bundle.sh 输出的 deepanalyze-hub:<ver>
$EDITOR .env

# 6. 启动 Hub
docker compose -f docker-compose.prod.yml up -d

# 7. 等待就绪并访问
curl http://localhost:22000/api/health
# 浏览器: http://<本机内网IP>:22000  用 admin + ADMIN_INIT_PASSWORD 登录
```

## Hub 控制台部署 Worker

Hub 启动后，DA Worker 镜像（`da-backend` / `da-frontend` / `da-postgres` / `da-embedding`）已经 `docker load` 到目标机。在 Hub 控制台添加 Worker 时：

- **SSH 模式**：在 Worker 主机上也跑一遍 `load-images.sh` 加载这 4 个镜像，Hub 通过 SSH 在该主机 `docker run` 启动
- **本地 Docker 模式**（Hub 与 Worker 同机）：取消 `docker-compose.prod.yml` 中 `docker.sock` 挂载的注释，Hub 直接在本机拉起 Worker

## 故障排查

### `docker load` 报 `invalid tar header`
- tar.gz 拷贝过程中损坏，重新传输并 `sha256sum -c SHA256SUMS` 校验

### 启动后 `/api/health` 502 / connection refused
- `docker compose -f docker-compose.prod.yml logs hub` 看 migration 输出
- 常见原因：`.env` 中 `ADMIN_INIT_PASSWORD` 或其他 `${VAR:?...}` 必填项为空 → compose 会拒绝启动

### Hub 容器内 `docker: command not found`（仅本地 Docker 部署模式）
- Hub 镜像内已内置 docker CLI，但需要挂载宿主 socket。编辑 compose 取消这行注释：
  ```yaml
  - /var/run/docker.sock:/var/run/docker.sock
  ```
  仅当你要用「本地 Docker 部署模式」时才需要（默认 SSH 部署不需要）。

### Worker 部署时 `ImagePullBackOff` / `docker: No such image`
- 目标 Worker 主机没有 `da-backend` / `da-frontend` / `da-postgres` / `da-embedding` 之一。把 `images/da-*.tar` 拷过去跑 `docker load -i <file>`。

### 构建机 build `da-embedding` 卡住或失败
- BGE-M3 模型权重 ~2.2 GB，依赖 `huggingface.co` 网络。失败时：
  - 设 `HF_ENDPOINT=https://hf-mirror.com` 重试（国内镜像）
  - 或加 `--no-embedding` 跳过，部署后在 Worker 内单独配置 embedding 服务
