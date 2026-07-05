# DeepAnalyze 分发与认证指南

## 三种认证模式

| 模式 | 环境变量 | 场景 |
|------|----------|------|
| `none` | `DA_AUTH_MODE=none`（默认） | 个人开发，无需登录 |
| `local` | `DA_AUTH_MODE=local` | 个人/小团队，需要密码保护 |
| `hub` | `DA_AUTH_MODE=hub` + `DA_HUB_URL` | 企业部署，Hub SSO |

## 启动流程

1. 检测 `data/setup-complete.flag` 是否存在
   - 存在 → 跳过向导
   - 不存在 → 启动向导（CLI TTY 自动触发，Web 端 App.tsx 显示 SetupWizard）
2. 加载配置（环境变量 > config.yaml > 默认值）
3. 启动 ModelServiceSupervisor（按需拉子服务 embedding/whisper/docling/paddleocr）
4. 启动主应用（HTTP + WebSocket）

## 首次设置向导

三种入口（按优先级）：

1. **CLI 向导**（TTY 环境）：`da-setup` 或 `bun run src/setup/cli-wizard.ts`
   - 在 `main.ts` 启动时，如果 stdout 是 TTY 且未完成 setup，自动触发
   - 用 `@clack/prompts` 交互式引导
2. **Web 向导**（浏览器）：访问 `http://localhost:21000`
   - App.tsx 检测 `GET /api/setup/state` 返回 `complete: false` 时渲染 SetupWizard
   - 6 步：环境检测 → 模式选择 → 认证配置 → 模型策略 → 模型下载 → 完成
3. **跳过向导**（Docker / CI）：设置 `DA_SKIP_WIZARD=true`

## 模型下载策略

向导 Phase 4 让用户选：

| 策略 | 说明 | 需要下载 |
|------|------|----------|
| `all_cloud` | 仅用云端 API（OpenRouter / GLM 等） | 无 |
| `all_local` | 全部本地推理 | 所有模型（~5GB） |
| `hybrid` | 云端 LLM + 本地 embedding（推荐） | BGE-M3（~2.2GB） |
| `manual` | 用户预先把权重放到 `data/models/` | 无 |

模型下载源（向导 Phase 4 第二步）：
- `auto` — 自动探测可用性（HuggingFace → hf-mirror）
- `hf` — HuggingFace 官方
- `hf_mirror` — 中国镜像（hf-mirror.com）
- `enterprise` — 企业内部仓库（仅 enterprise_worker 模式）
- `manual` — 不下载

## 切换认证模式

修改 `.env` 中的 `DA_AUTH_MODE` 后重启 DA 即可：

- `none → local`：首次启动时通过 Web 向导或 `POST /api/auth/setup` 设置管理员账号
- `local → hub`：DA 启动时自动拉取 Hub JWKS 公钥（`GET {DA_HUB_URL}/api/v1/auth/jwks.json`），缓存到内存，6 小时刷新
- `hub → local`：紧急情况下用 `da-admin` 命令恢复（见下文）

### Hub 模式离线降级

DA 启动时拉取 JWKS 公钥后缓存在内存。如果 Hub 后续不可达：
- 已签发的 JWT 仍可验签（使用缓存公钥）
- 新登录会失败（需要 Hub 签发新 JWT）
- 6 小时刷新定时器失败时，DA 继续使用上次成功的公钥

## 紧急恢复

当 Hub 长期不可达导致 JWT 全部过期时，可在 DA 服务器上运行：

```bash
# 本地部署
da-admin
# 或
bun run src/setup/emergency-reset.ts

# Docker 部署
docker exec -it da-backend da-admin
```

该命令会：
1. 验证 `data/auth/recovery.key` 存在（证明有服务器文件系统访问权限）
2. 临时切换到 local 模式
3. 创建 24 小时有效的 `emergency-admin` 账号
4. 输出临时用户名和密码

用临时账号登录后，在设置面板中重新配置 Hub 连接，然后改回 `DA_AUTH_MODE=hub` 并重启。

## Docker 部署

两种镜像：

| 镜像 | 大小 | 用途 |
|------|------|------|
| `da:base` | ~500MB | 云端模式，不含 ML 依赖 |
| `da:full` | ~3GB | 本地推理，含 torch/docling/whisper/paddleocr |

```bash
# 构建基础镜像
docker build -f Dockerfile.base -t da:base .

# 构建完整镜像（基于 base）
docker build -f Dockerfile.full -t da:full .
```

`docker-compose.yml` 默认使用 `Dockerfile.base`。本地推理场景改为 `Dockerfile.full`。

Docker 模式下 `DA_SKIP_WIZARD=true`（跳过 CLI 向导），使用 Web 向导进行首次配置。

## API 端点参考

### 认证 API（`/api/auth/*`）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/auth/mode` | GET | 获取当前认证模式 |
| `/api/auth/setup` | POST | 初始化管理员账号（local 模式首次设置） |
| `/api/auth/login` | POST | 登录，返回 JWT |
| `/api/auth/logout` | POST | 登出（清除客户端 token） |
| `/api/auth/me` | GET | 获取当前用户信息 |
| `/api/auth/change-password` | POST | 修改密码（local 模式） |

### 设置 API（`/api/settings/*`）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/settings/auth` | GET/PUT | 查看/修改认证配置 |
| `/api/settings/hub` | GET | 获取 Hub 连接状态 |
| `/api/settings/hub/connect` | POST | 连接到 Hub |
| `/api/settings/hub/disconnect` | POST | 断开 Hub |
| `/api/settings/services` | GET | 获取子服务健康状态 |

### 向导 API（`/api/setup/*`）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/setup/state` | GET | 获取向导完成状态 |
| `/api/setup/environment` | GET | 获取环境检测报告 |
| `/api/setup/complete` | POST | 提交向导输入，保存配置 |
| `/api/setup/download` | POST | 触发模型下载 |

## CLI 工具

| 命令 | 用途 |
|------|------|
| `da-setup` | 首次设置向导（交互式 CLI） |
| `da-admin` | 紧急恢复（Hub 不可达时创建临时管理员） |
