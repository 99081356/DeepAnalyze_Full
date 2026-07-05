# DeepAnalyze 分发、认证与 Hub 协作设计

- **日期**：2026-07-03
- **状态**：设计已确认，待编写实施计划
- **作者**：leotangcw + Claude
- **相关项目**：
  - DeepAnalyze（DA）本体：`https://github.com/leotangcw/DeepAnalyze`
  - deepanalyze-hub（控制平面）：`https://github.com/leotangcw/deepanalyze-hub`
- **相关文档**：
  - `2026-05-19-server-worker-architecture-design.md`（DA-Worker 协议基础）
  - `2026-06-20-hub-server-multi-tenant-design.md`（Hub 多租户设计）
  - `2026-06-28-hub-worker-skills-admin-design.md`（Hub Skill 市场管理）

---

## 1. 背景与目标

### 1.1 当前现状

经过 Hub Phase 1-4 的完整落地，DA 与 Hub 形成了一套"控制平面 / 数据平面分离"的雏形：

**DA（数据平面）**：
- 完整的单租户通用 Agent 平台
- 已有 HubClient v2 协议（HTTP REST + 30s 心跳 + SkillSync 5 指令）
- 完整的 ModelRouter / EmbeddingManager / Provider 抽象（10 种模型角色）
- **零认证中间件**——前端无登录页，所有 API 完全开放
- **完全单用户**——sessions / knowledge_bases / settings 全局共享，`owner_id` 字段存在但默认 `default-user`、从未过滤
- 通过环境变量 `DA_SERVER_URL + DA_WORKER_TOKEN` 触发 Worker 模式，**没有首次启动引导**
- 本地模型体积庞大（BGE-M3 2.2G + Whisper + Docling + PaddleOCR-VL ≈ **5GB**），与软件包深度耦合
- Docker 镜像预装 torch/docling/onnxruntime/whisper，**镜像本身 ~3GB**
- 无 CI/CD、无 release workflow、无桌面安装包，仅源码 + Docker 分发

**Hub（控制平面）**：
- 完整的 JWT（access 7d + refresh 30d）+ RBAC（super_admin/org_admin/analyst/auditor）
- 树形 Organization + 跨组织 Skill 共享 + Security Gateway
- Worker 注册与审批（v1 自动 / v2 待审批）+ 5 类 SkillSync 指令（sync/force_update/kill/rollback/policy_refresh）
- Skill 市场双轨制（marketplace_skills + skill_packages）+ Plugin 市场
- **JWT 使用 HS256（HMAC 共享密钥）**，不支持非对称验签

**两套并行的认证体系，零交叉**：
- DA 内部用户对 Hub 完全不可见
- DA 实例作为 Worker 连 Hub（`wkt_<uuid>` token），与 Hub 用户身份完全分离
- 没有"DA 用户登录到 Hub"或"Hub 用户单点登录到 DA"的能力

### 1.2 核心痛点

| 痛点 | 影响 |
|---|---|
| DA 无认证、无登录 | 企业部署无法控制访问；多人共用一台 DA 实例时无操作归属 |
| DA 与本地模型深度耦合 | 镜像巨大（~3GB），下载慢、磁盘紧张；不同企业场景的模型组合差异大 |
| 无安装引导 | 企业新 Worker 加入门槛高，全靠 env var 手动配置 |
| 无离线部署方案 | 大量企业内网（air-gapped）场景无法落地 |
| 无统一认证 | 企业员工需在 Hub 和 DA 各自维护账号；密码不一致；审计割裂 |
| DA ↔ Hub 协作链路不完整 | 缺模型分发、镜像分发、远程拉起、JWKS 同步等关键端点 |
| 个人版 vs 企业版形态模糊 | 用户场景差异巨大，但当前是"同一份代码硬塞两种场景" |

### 1.3 设计目标

**一句话**：让 DA 能以"个人独立 Agent 系统"和"企业员工专属 Agent 容器"两种形态优雅存在，认证统一、分发简单、模型按需、离线可用。

具体目标：
1. **DA 保持个人 Agent 系统的本质**——永远单租户，内部不做多用户/多角色/多组织隔离
2. **Hub 是分发机构 + 治理层**——所有"多"的味道（多用户、多组织、权限、审核、共享）都在 Hub 端发生
3. **认证互通**——同一密码既能登 Hub 也能登 DA，密码源唯一
4. **镜像瘦身**——基础镜像 ~500MB（vs 当前 ~3GB），模型权重运行时按需装载
5. **离线一体化部署**——外网打整包，内网解压即用，全程零外网依赖
6. **DA ↔ Hub 协作链路完整**——补齐模型分发、镜像分发、远程拉起、JWKS 同步
7. **个人版可后续接入 Hub**——员工自带的个人 DA 能加入企业 Hub 同步 Skill/配置

### 1.4 与既有设计文档的关系

本文档**不取代**而是**衔接**以下既有设计：

- `2026-05-19-server-worker-architecture-design.md`：DA-Worker 协议基础，本文档在此基础上**扩展**端点（认证、模型、镜像）
- `2026-06-20-hub-server-multi-tenant-design.md`：Hub 多租户设计，本文档**复用**其组织树、RBAC、Skill 市场、Worker 审批机制
- `2026-06-28-hub-worker-skills-admin-design.md`：Hub 端 Skill 市场管理，本文档**对齐**其 Skill 审核工作流

本文档**新增**的内容：DA 认证改造、镜像分层、安装向导、模型权重管理、离线一体化部署、Hub 端配套端点与 schema 改动。

### 1.5 不做的事（明确边界）

为保持系统简单，**以下事项不在本设计范围内**：

| 不做的事 | 原因 |
|---|---|
| DA 内部多租户（visibility / RBAC / 审计 / 用户级配额） | 隔离靠容器级，不靠 DA 内部 |
| DA 多账号登录（虽然有 users 表但不启用） | 一人一 DA，多人共用就让那个 DA 实例的所有登录用户平等共享 |
| DA 主动推送数据到 Hub（使用统计、操作日志上报） | Pull 模型保持现状，避免 DA 变重 |
| DA 内部多 Worker 协同 | 每个 DA 独立，互不知道 |
| DA 端做 Kill Switch 自主判断 | 指令来自 Hub，DA 只执行 |
| 标准 OIDC / SAML / LDAP 集成 | 第一版用自签 JWT 简化；标准协议是后续增强 |

这些选择的核心动机：**简单优先**。DA 是"个人 Agent 系统"，不应该背着"企业 SaaS 多租户"的复杂度包袱。

---

## 2. 核心设计原则

### 2.1 DA = 个人 Agent 系统（永远单租户）

DA 的本质定位是**个人 Agent 系统**。一个 DA 容器 = 一个用户 = 一份数据。即使在企业场景，每个员工也是分到自己的独立 DA 容器，数据物理隔离。

DA 内部不引入：
- 多用户表（虽有 `users` 表但保持闲置）
- 角色权限（无 admin/analyst/viewer）
- 资源可见性分级（无 private/shared/public）
- 操作归属审计（无 audit_logs）
- 跨用户协作（无 session_shares）

### 2.2 隔离靠容器级（一人一 DA）

```
企业 Hub 给每个员工分发独立 DA：
  员工 A → da-container-A（独立 docker volume: A-data）
  员工 B → da-container-B（独立 docker volume: B-data）
  员工 C → da-container-C（独立 docker volume: C-data）

A 永远看不到 B/C 的数据（物理隔离）
```

### 2.3 Hub = 分发机构 + 治理层

Hub 端承担所有"多"的味道：
- 多组织 / 多用户 / RBAC
- Skill 市场审核工作流（提交 → 审核 → 发布 → 强推 → Kill Switch）
- 跨组织 Skill 共享审批
- Worker 申请审批
- 模型 / 镜像 / Skill 分发治理
- 审计日志（在 Hub 层记录"谁、什么时候、对哪个 DA、做了什么"）

### 2.4 同一份镜像，三种形态

不是三个镜像，而是**同一份 `da:base` 镜像**通过启动配置 + 安装向导演化出三种形态：
- **DA Personal**：个人单机（authMode=none 或 local，可选 Hub 连接）
- **DA Team / Enterprise**：企业员工专属（authMode=hub，由 Hub 远程拉起）
- **DA Hub**：控制平面（独立镜像 `da-hub:latest`）

### 2.5 模型与软件包解耦

基础镜像不含本地模型权重，运行时按需下载或手动拷贝。模型版本与 DA 版本解耦（manifest 远程拉取）。

### 2.6 Pull 模型保持现状

DA ↔ Hub 全部 HTTP REST + 30s 心跳轮询。**Hub 永不主动推送**——所有指令通过心跳响应下发，DA 端按需调用 Hub API。这保证 Hub 短时不可达不影响 DA 正常工作。

---

## 3. 整体架构总览

### 3.1 三种产品形态

```
┌─────────────────────────────────────────────────────────────────────┐
│                       三种产品形态                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  【DA Personal】           【DA Team/Enterprise】      【Hub】        │
│  个人单机                   企业多用户                  控制平面      │
│  ──────────────            ──────────────────         ──────────    │
│  · 单 Docker 容器          · 多 Worker 实例            · 多组织      │
│  · mini-IdP（可选登录）    · Hub JWT 透传              · RBAC        │
│  · 本地模型/云端 API       · Hub 远程拉起              · Skill 市场  │
│  · 无 Hub 依赖            · 共享 Skill/策略           · 模型代理    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 DA 容器内部架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                      DA 容器内部架构                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐              │
│  │ Frontend    │ ←→ │ DA Backend  │ ←→ │ HubClient   │ ── HTTP ──→  │
│  │ (React SPA) │    │ (Hono+Bun)  │    │ (v2 协议)   │   Hub        │
│  └─────────────┘    └──────┬──────┘    └─────────────┘              │
│                            │                                         │
│         ┌──────────────────┼──────────────────┐                     │
│         │                  │                  │                     │
│         ↓                  ↓                  ↓                     │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐              │
│  │ Auth Layer  │    │ Model       │    │ Model       │              │
│  │ (mini-IdP + │    │ Providers   │    │ Service     │              │
│  │  Hub JWT    │    │ (LLM/Emb/   │    │ Supervisor  │              │
│  │  验签)      │    │  VLM/TTS)   │    │ (BGE/Whisp/ │              │
│  └─────────────┘    └─────────────┘    │  Docling)   │              │
│                                        └─────────────┘              │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.3 与既有架构的关系

- **HubClient**（`src/services/hub/`）：保留并扩展，新增认证代理、模型下载、镜像加载等调用
- **ModelRouter / EmbeddingManager**（`src/models/`）：保留，向导产出的配置写入 settings 表后由 Router 加载
- **4 个本地模型 Python 服务**（embedding_server / whisper-service / docling-service / paddleocr-vl-service）：保留独立进程模式，但由新增的 `ModelServiceSupervisor` 统一编排
- **DA 现有 routes**：保留，仅新增 `src/server/middleware/auth.ts` + `src/server/routes/auth.ts`

---

## 4. 认证与登录

### 4.1 认证模型（极简）

**DA 内部永远只有一个账号**。一个 DA 容器 = 一个用户 = 一个密码。没有 users 列表，没有多账号，没有角色分级。

密码来源有两种：
- **本地**（local 模式）：DA 自己存的 bcrypt hash
- **Hub**（hub 模式）：DA 代理转发到 Hub `/api/v1/auth/login` 验证

DA **永不存密码原文、永不存 Hub 密码 hash**。Hub 模式下 DA 只缓存 Hub JWKS 公钥用于本地验签。

### 4.2 三种运行模式（启动时由 `DA_AUTH_MODE` 决定）

| 模式 | 触发条件 | 登录入口 | Token 签发方 | 离线能力 |
|---|---|---|---|---|
| `none` | 个人版"免登录"选项 | 无 | 无（default-user） | 永久 |
| `local` | 个人版"启用登录" | DA 登录页 | DA mini-IdP | 永久 |
| `hub` | 企业版默认 | Hub 登录页 / DA 登录页（代理） | Hub | 7 天（已签 JWT 本地验签有效期内） |

> 早期讨论中曾提过 `hybrid` 模式（同时接受 local 和 hub token），但 4.6 的设计已覆盖迁移期场景，且 OIDC 集成后 Hub 是统一入口，hybrid 失去意义——见章节 11 的说明。

### 4.3 三种登录路径

#### 路径 A：个人版 mini-IdP（local 模式）

```
首次启动（向导 Phase 3）：
  用户选"启用登录" → 创建管理员账号（用户名 + 密码）
  DA 写入 settings 表：
    auth.mode = 'local'
    auth.username = 'admin'
    auth.password_hash = '$2b$...'  ← bcrypt

登录流程：
  用户访问 DA → 未带 token → 跳 DA 登录页
  输用户名 + 密码 → DA 后端 bcrypt 对比
  通过 → DA 用本地私钥签 JWT → 返前端
  前端后续请求附 Authorization: Bearer xxx
  DA 后端用本地公钥验签 → 通过
```

#### 路径 B：企业 SSO 从 Hub 单点跳转（hub 模式）

```
用户访问 https://hub.corp.com → 输用户名密码 → Hub 签 JWT
用户从 Hub Dashboard 点 "进入我的 DA" → 跳转 https://da-{user}.corp.com/?token=xxx
DA 前端把 token 存 localStorage → 后续请求附 Authorization: Bearer xxx
DA 后端用缓存的 Hub JWKS 公钥验签 → 提取 userId / orgId → 通过
```

#### 路径 C：企业 DA 本地登录页直接登录（hub 模式）

```
用户直接访问 https://da-{user}.corp.com → 未带 token → 跳 DA 登录页
输用户名 + 密码 → DA 后端 POST /api/auth/login (proxy mode)
DA 后端代理转发到 Hub /api/v1/auth/login → Hub 验密码 → 返 JWT
DA 把 JWT 返回前端 → 后续同路径 B
```

路径 B 与路径 C **密码都不接触 DA**——DA 永远不存密码 hash，永远代理转发。

> **安全注记**：路径 B 的 token 通过 URL query 传递（`?token=xxx`）有被代理日志记录的风险。生产部署建议改为"Hub 跳转 DA 时让 DA 反向用临时 code 换 token"（OIDC 标准 code flow）。第一版先用 query 方式简化，后续替换。

### 4.4 Hub JWKS 公钥同步机制

Hub 现状是 HS256（HMAC 共享密钥），需要升级为 RS256（非对称）才能让 DA 持公钥本地验签。

```
DA 启动时：
  GET {DA_HUB_URL}/api/v1/auth/jwks.json
  → 缓存到 data/auth/hub-jwks.json

每 6 小时后台刷新：
  - 拉取最新 JWKS
  - 旧公钥保留 7 天（避免老 JWT 突然失效）
  - 新公钥立即生效

Hub 不可达时：
  - 继续用最后一次缓存的 JWKS
  - 验签照常工作
  - 仅"签发新 JWT"受影响（需要 Hub 私钥）
```

**边界**：Hub 完全离线 7 天后所有 JWT 过期，新登录不可用。已有 refresh token 也需要 Hub 私钥才能签发新 access token，因此 refresh 同样不可用。这是"Hub 高可用是企业版前提"的合理边界。

### 4.5 Worker 自动加入流程（join_token）

```
┌──── Hub Admin Console ─────────────────────────────────────┐
│  ① "添加 Worker" 表单：                                      │
│     - 目标机器 IP / SSH 端口                                  │
│     - SSH 用户名 + 私钥/密码                                  │
│     - 部署到哪个组织（select 树）                            │
│     - 该 Worker 启用哪些 Skill 包                            │
│     - 分配给哪位员工（assigned_user_id）                     │
│  ② Hub 生成 join_token（一次性、24h 过期、绑定 org_id）       │
│  ③ Hub 通过 SSH 连接目标机器，加载镜像并启动：                │
│     在线场景：docker pull da:base                           │
│     离线场景：curl -s {hub}/api/v1/images/da-base.tar \      │
│              | docker load  （详见章节 7.1）                 │
│     docker run -d \                                         │
│       -e DA_AUTH_MODE=hub \                                 │
│       -e DA_HUB_URL=https://hub.corp.com \                  │
│       -e DA_JOIN_TOKEN={join_token} \                       │
│       -e DA_ORG_ID={org_id} \                               │
│       -v da-data-{user}:/data \                             │
│       -p 21000:21000 \                                      │
│       da:base                                               │
│  ④ Hub 监控该容器启动状态（轮询目标机器 :21000/api/health）   │
│  ⑤ DA 启动后用 join_token 调 Hub /api/v1/workers/register    │
│  ⑥ Hub 验证 join_token → 自动审批 → 返回 worker_token        │
│  ⑦ Hub UI 显示 "Worker 已上线"，记录 assigned_user_id        │
└─────────────────────────────────────────────────────────────┘
```

**join_token 设计要点**：
- 一次性（用过即作废）
- 24h 过期（防止泄露风险）
- 绑定 `org_id`（不能跨组织用）
- 支持 `--join-token-count=N` 批量生成（同一组织一次部署多个 Worker）

### 4.6 个人 DA 加入企业 Hub（事后接入）

```
场景：员工自己装了个人 DA 跑了一段时间，后来公司上了 Hub

操作：
  1. 员工在 Hub 申请加入 → Hub Admin 审批生成 join_token
  2. 员工在自己 DA 的"设置 → Hub 连接"填：
     - Hub URL：https://hub.corp.com
     - Join Token：xxx
  3. DA 调用 POST /api/v1/workers/register（带 join_token）
  4. Hub 验证 join_token → 注册成功 → 返 worker_token
  5. DA 启动心跳，开始同步 Skill

后续：
  - 员工的 DA 既保留个人数据（独立 volume）
  - 又能从 Hub 拉企业 Skill
  - Hub Admin 可见该 Worker，但 Hub 不主动干预 DA 内部数据

员工退出 Hub：
  - 在 DA 设置点 "断开 Hub"
  - DA 调 POST /api/v1/workers/me/deactivate
  - 停止心跳，企业 Skill 沉淀在 DA 本地（可继续用）
  - 后续 Hub 不再下发新指令
```

### 4.7 紧急恢复（Hub 长期不可达）

```
当 Hub 宕机 > 7 天，所有 JWT 过期，企业 DA 锁死：

  在 DA 服务器执行：
    docker exec -it da-{user} da admin emergency-reset

  该命令：
    1. 校验本机 data/auth/recovery.key（安装时生成）
    2. 临时切换 authMode 为 local
    3. 创建一个 emergency-admin 账号（24h 过期）
    4. 打印临时密码 + 提示恢复 Hub 后回切
```

### 4.8 DA 内部改造（极简）

**唯一改造点**：新增 `src/server/middleware/auth.ts` 一个文件。

```ts
// src/server/middleware/auth.ts（伪代码）

export const authMode = process.env.DA_AUTH_MODE || "none";

export async function authMiddleware(ctx, next) {
  // none 模式：完全跳过
  if (authMode === "none") {
    ctx.user = { id: "default-user", name: "anonymous" };
    return next();
  }

  const token = extractBearer(ctx);
  if (!token) return ctx.json({ error: "unauthorized" }, 401);

  // 按 iss 路由到不同验签器
  const { iss, kid } = parseJwtHeader(token);
  if (iss === ctx.app.state.hubUrl) {
    ctx.user = await verifyHubJwt(token, kid);  // 用 hub-jwks 缓存
  } else if (iss === "da-local") {
    ctx.user = await verifyLocalJwt(token, kid); // 用 da 自身公钥
  } else {
    return ctx.json({ error: "invalid issuer" }, 401);
  }

  await next();
}
```

**前端改造**：仅一个 Login 页（用户名+密码表单）+ 顶部菜单显示当前用户。

**Settings 改造**：增加"启用登录"开关 + 修改密码 + 配置 Hub URL。

**数据模型**：完全不动 `users` 表（继续闲置）、不增加 visibility 字段、不增加 audit_logs 表。所有认证相关配置存在 settings KV 表：
- `auth.mode`
- `auth.username`（local 模式）
- `auth.password_hash`（local 模式，bcrypt）
- `auth.hub_url`（hub 模式）
- `auth.hub_jwks_cached`（hub 模式，缓存）

**关键**：登录后所有角色等同（无 admin/analyst/viewer 区分）。`ctx.user` 仅用于"显示谁登录了"，不用于权限拦截。

---

## 5. 分发与启动

### 5.1 镜像分层（两档：base + full）

```
da:base (~500MB)            ← 默认拉取，含向导 + 后端 + 前端 + 安装器
   ├ Bun runtime
   ├ Python3 + 最小依赖（无 torch/onnxruntime/whisper）
   ├ DA backend + frontend 构建产物
   ├ ModelServiceSupervisor（启动时按需拉子服务）
   └ 安装向导 + 模型管理器

da:full (~3GB)              ← 离线场景预置，含所有 ML 依赖 + 预下载权重
   └ da:base + torch + onnxruntime + whisper + docling + 全部模型权重
```

**两种镜像的使用场景**：

| 场景 | 镜像 | 何时使用 |
|---|---|---|
| 个人默认 | `da:base` | 拉取后向导选模型策略 |
| 企业 Worker | `da:base` | Hub 远程拉起时用，策略由 Hub 注入 |
| 离线/内网 | `da:full` | 离线包预置，向导跳过模型下载 |
| 纯 API | `da:base` | 只用云端 LLM+embedding，不要本地推理（向导阶段不下载本地模型权重，也不 pip 安装 ML 库） |

**瘦身策略**：

| 当前 | 改造 | 收益 |
|---|---|---|
| torch 在基础镜像里 | 移到 `da:full` 镜像（或运行时按需 pip） | base -200MB |
| onnxruntime-node npm 依赖 | 改成可选依赖，向导选本地推理时才装 | base -50MB |
| Whisper 模型在镜像里（Dockerfile.offline） | 仅 `da:full` 包含，base 运行时下载 | base -200MB |
| Docling 默认从 HF 下载 | 向导引导（不强制） | 不变 |
| 前端 dist 内嵌到镜像 | 保持 | 0 |
| PostgreSQL server 在镜像里 | 不内置（用外部或 compose） | -100MB |

**预期**：base 镜像 ~500MB（vs 当前 ~3GB）

### 5.2 启动向导（首次启动触发，6 阶段）

```
首次启动（检测 data/config.yaml 不存在）：

┌─ Phase 1: 环境检测（自动，~5s）───────────────────┐
│ • CPU 核数 / RAM / 磁盘可用空间                    │
│ • GPU 可用性（nvidia-smi 检测）                   │
│ • 网络连通性探测（并行 ping）：                    │
│   - HuggingFace（huggingface.co）                 │
│   - 中国镜像（hf-mirror.com）                      │
│   - Hub URL（若提供）                              │
│   - 企业模型仓库（若提供）                          │
│ • 扫描 data/models/ 已有权重文件                  │
└──────────────────────────────────────────────────┘
                       ↓
┌─ Phase 2: 模式选择 ─────────────────────────────┐
│ ◯ 个人版（standalone，不接 Hub）                  │
│ ◯ 企业 Worker（输入 Hub URL + join_token）        │
│ ◯ 仅检查既有配置（已配置过后用）                    │
└──────────────────────────────────────────────────┘
                       ↓
┌─ Phase 3: 认证配置（按 Phase 2 选择）─────────────┐
│ 个人版：                                          │
│   ◯ 免登录（直接进入应用）                         │
│   ◯ 启用登录 → 创建管理员账号（用户名+密码）        │
│ 企业版：                                          │
│   跳过（用 Hub JWT）                              │
└──────────────────────────────────────────────────┘
                       ↓
┌─ Phase 4: 模型策略 ─────────────────────────────┐
│ ◯ 全部云端 API（输入各 provider 凭证）            │
│ ◯ 全部本地（按硬件推荐组合）                       │
│ ◯ 混合（云端 LLM + 本地 embedding，推荐默认）     │
│ ◯ 手动拷贝（指向已有 data/models/）              │
└──────────────────────────────────────────────────┘
                       ↓
┌─ Phase 5: 模型下载（按 Phase 4 + Phase 1）────────┐
│ • 选源：HF / 中国镜像 / 企业仓库 URL / 已就绪      │
│ • 后台并行下载 + SHA256 校验                       │
│ • 写入 data/models/{model}/                       │
│ • 进度条 + 失败重试 3 次 + 自动切换备用源           │
│ • 若选本地推理且镜像为 da:base：按需 pip install   │
│   （da:full 已预装，跳过此步）                     │
└──────────────────────────────────────────────────┘
                       ↓
┌─ Phase 6: 健康检查 ─────────────────────────────┐
│ • ModelServiceSupervisor 拉子服务                  │
│ • 端口池探测（:21001-21010）                      │
│ • 子服务 /health 探活                              │
│ • 失败时降级：embedding 失败 → FTS fallback        │
│ • 全部通过 → 向导完成，主应用接管                  │
└──────────────────────────────────────────────────┘
```

### 5.3 向导两种入口

**入口 A：Web 向导（推荐，浏览器交互）**
```
DA 启动 → 检测到未配置 → 监听 :21000/setup
用户浏览器访问 → 6 阶段引导式表单
完成 → 写 data/config.yaml → 主应用接管 :21000
```

**入口 B：CLI 向导（终端交互）**
```
DA 启动 → 检测 stdout 是 TTY → 启动 @clack/prompts 交互
适合服务器 SSH 部署（无浏览器场景）
完成 → 写 data/config.yaml → 主应用启动
```

两个入口产出**完全相同的 `data/config.yaml`**，可互换。

### 5.4 ModelServiceSupervisor

**问题**：现状有 4 个独立 Python 服务（embedding/whisper/docling/paddleocr-vl），进程管理分散、端口冲突、健康检查不统一。

**方案**：DA 内置 `ModelServiceSupervisor`

```
src/server/model-supervisor.ts
├─ 启动时根据 config 决定拉起哪些子服务
├─ 端口池自动分配（避免冲突，:21001-21010）
├─ 健康检查（每 30s 调子服务 /health）
├─ 自动重启（崩溃后 3 次重试，超过则降级）
├─ 优雅关闭（SIGTERM → 5s 等待 → SIGKILL）
└─ 资源限额（可选 cgroups 限制内存）

子服务（独立 Python 进程，按需启动）：
├─ embedding-svc  (BGE-M3)          :21001  按需
├─ whisper-svc    (ASR)             :21002  按需
├─ docling-svc    (文档解析)         :21003  按需
└─ paddleocr-svc  (VLM)             :21004  按需

不需要的服务完全不启动（不占资源、不下载权重）
```

子服务启动失败时的降级：
- embedding-svc 失败 → 主应用降级到 hash embedding（已有 fallback）
- whisper-svc 失败 → 主应用禁用 ASR 功能（用户上传音频报错）
- docling-svc 失败 → 主应用降级到 PDF 简单解析（已有 fallback）
- paddleocr-svc 失败 → 主应用禁用图像理解（已有 fallback）

前端 `SystemStatusBanner` 显示各服务状态：绿色（running）/ 黄色（degraded）/ 红色（missing_weights）/ 灰色（disabled）。

### 5.5 数据目录布局

```
data/                                  ← docker volume 挂载点
├── config.yaml                        ← 向导产出的主配置
├── setup-complete.flag                ← 标记向导已完成
├── auth/
│   ├── da-key.pem                     ← mini-IdP 私钥（仅 local 模式生成）
│   ├── da-pub.pem                     ← mini-IdP 公钥
│   ├── hub-jwks.json                  ← Hub JWKS 缓存（仅 hub 模式拉取）
│   └── recovery.key                   ← 紧急恢复密钥（首次启动生成）
├── models/
│   ├── bge-m3/                        ← embedding 权重
│   ├── whisper-tiny.pt
│   ├── whisper-base.pt
│   ├── docling/
│   └── paddleocr-vl/
├── sessions/                          ← 会话数据
├── knowledge/                         ← 知识库（向量+索引）
├── logs/
└── .worker-id                         ← Worker ID 持久化（已有）
```

### 5.6 配置加载优先级

```
启动时（高 → 低）：
  1. 环境变量 DA_*                ← Hub 远程拉起时注入，最高优先级
  2. data/config.yaml             ← 向导产出
  3. 内置 default.config.yaml     ← 兜底
```

环境变量优先于配置文件——Hub 远程拉起时只需 `docker run -e DA_JOIN_TOKEN=xxx` 即可，不需要修改 volume。

### 5.7 升级流程（同时支持 Hub 远程 + 运维手动）

**个人版升级**：
```bash
docker pull da:base
docker restart da
# DA 检测到 setup-complete.flag → 跳过向导
# 自动迁移 schema（如有）
```

**企业版升级（Hub 远程推送）**：
```
Hub Admin → "Worker 升级" 页面：
  ① 选目标 Worker（可批量）
  ② 选目标镜像 tag（v0.9.0 / latest / stable）
  ③ 选策略：滚动 / 蓝绿 / 立即
  ④ Hub 通过 SSH 在目标机器执行：
     docker pull da:v0.9.0
     docker stop da && docker rm da
     docker run -d ... da:v0.9.0
  ⑤ 监控新版本 :21000/api/health 直到 ok
  ⑥ 失败自动回滚到上一版本
```

**企业版升级（运维手动）**：与个人版相同——`docker pull && docker restart`。Hub 端仅记录版本号变化（通过心跳上报）。

第一版要求**同时支持**两种方式：Hub 远程用于集中管理，手动方式用于紧急修复或 Hub 不可达场景。

---

## 6. 模型权重管理

### 6.1 模型清单与体量

| 模型 | 类型 | 主要文件 | 大小 | Python 依赖 |
|---|---|---|---|---|
| BGE-M3 | embedding | `pytorch_model.bin` + 配置 | **2.2GB** | sentence-transformers + torch |
| Whisper tiny | ASR（轻量） | `tiny.pt` | 73MB | openai-whisper + torch |
| Whisper base | ASR（标准） | `base.pt` | 139MB | 同上 |
| Docling | 文档解析 | 多个 onnx/table/layout | ~500MB | docling + onnxruntime |
| PaddleOCR-VL | VLM | 多个权重 | ~2GB | paddleocr-vl |
| **合计（全模型）** | | | **~5GB** | |

### 6.2 Model Manifest（与 DA 解耦）

DA 内部维护一份 `da-assets/manifest.json`，**与 DA 版本解耦**——升级 DA 时不强制升级模型。manifest 远程拉取最新版（从官方 CDN 或 Hub）。

```json
{
  "version": "1.0.0",
  "models": {
    "bge-m3": {
      "version": "1.0.0",
      "category": "embedding",
      "size_bytes": 2370000000,
      "files": [
        { "path": "pytorch_model.bin", "sha256": "abc123...", "size_bytes": 2370000000 },
        { "path": "config.json",       "sha256": "def456...", "size_bytes": 1200 },
        { "path": "tokenizer.json",    "sha256": "ghi789...", "size_bytes": 8000 }
      ],
      "sources": {
        "huggingface": "https://huggingface.co/BAAI/bge-m3/resolve/main/",
        "hf_mirror":   "https://hf-mirror.com/BAAI/bge-m3/resolve/main/"
      },
      "runtime_deps": {
        "python_packages": ["sentence-transformers>=2.7.0", "torch>=2.1.0"]
      },
      "min_disk_mb": 3000,
      "min_ram_mb":  2048,
      "recommended_for": ["knowledge_base"]
    },
    "whisper-tiny": { "category": "asr", "...": "..." },
    "whisper-base": { "category": "asr", "...": "..." },
    "docling":      { "category": "doc_parsing", "...": "..." },
    "paddleocr-vl": { "category": "vlm", "...": "..." }
  }
}
```

manifest 的版本治理：
- 每个 manifest 版本独立存在，多个 DA 版本可共用同一份 manifest
- DA 启动时检查 manifest 远程更新（不打断运行）
- 升级模型是显式动作（向导触发或 Hub 推送），不会自动进行

### 6.3 4 种下载源

**Source A: HuggingFace 官方**
```
URL 模板：https://huggingface.co/{repo}/resolve/main/{file}
特点：原始源，最新最全
适合：海外用户、企业有出海通道
```

**Source B: 中国镜像（hf-mirror.com）**
```
URL 模板：https://hf-mirror.com/{repo}/resolve/main/{file}
特点：国内 CDN 加速
适合：中国大陆用户
```

**Source C: 企业内部仓库**（两种实现路径）

```
路径 C1：HTTP 简单文件服务（推荐，nginx 即可）
  GET /manifests/{model_name}   → JSON file list + sha256
  GET /blobs/{sha256}           → 二进制流
  GET /health                   → 200 OK

路径 C2：Hub 作为模型仓库（Hub 新增模块）
  Hub 新增表：model_artifacts (id, name, version, sha256, size, storage_path, uploaded_by)
  Hub 新增路由：
    POST /api/v1/models/upload           ← 管理员上传（multipart）
    GET  /api/v1/models/manifests/{name}
    GET  /api/v1/models/blobs/{sha256}
    DELETE /api/v1/models/{name}/{version}  ← 清理旧版本

  优点：企业内部零依赖（不需要单独架 nginx）、Hub 统一治理
  缺点：Hub 存储 + 流量压力增加（每个 ~5GB × N 次下载）
```

**Source D: 手动拷贝**
```
用户预先把权重放到 data/models/{model_name}/
DA 向导 Phase 5 检测：
  - 文件齐全 + sha256 匹配 → 标记 ready，跳过下载
  - 文件缺失或 sha256 不匹配 → 报错，提示用户放置正确文件
适合：完全离线环境、U 盘分发、镜像复制
```

第一版同时支持 C1 与 C2 两种企业仓库实现——DA 端协议相同，企业自选部署形态。

### 6.4 ModelDownloader 服务

```
src/services/model-downloader.ts

核心 API：
  downloadModel(modelName, sourceType, opts) → DownloadResult
  verifyModel(modelName) → VerifyResult       ← sha256 校验
  listLocalModels() → ModelInfo[]             ← 扫描 data/models/
  removeModel(modelName) → void               ← 清理磁盘

下载策略：
  ├─ 多线程分块（4 并发 HTTP 连接）
  ├─ 断点续传（HTTP Range header + .part 临时文件）
  ├─ 失败重试 3 次 + 指数退避
  ├─ 主源连续失败 3 次 → 自动切换备用源
  ├─ SHA256 边下边校验（流式 hash）
  └─ 进度上报 → WebSocket 推送到前端向导（实时进度条）

Python 依赖按需安装（仅 da:base 镜像需要，da:full 已预装）：
  检测到需要 torch 但未装 → 调用 pip install
  使用独立 venv（data/venv/）避免污染系统
```

### 6.5 模型源选择决策树

```
向导让用户选源（radio group）：
  ◯ 自动（推荐）—— 按以下顺序探测，第一个连通的作为主源
       1. 企业仓库（如果配置了）
       2. 中国镜像（hf-mirror.com）
       3. HuggingFace 官方

  ◯ 仅 HuggingFace 官方
  ◯ 仅中国镜像
  ◯ 企业内部仓库（弹出 URL 输入框）
  ◯ 手动拷贝（不下载，检查 data/models/ 已有文件）

选完后写入 config.yaml：
  models:
    source: auto | hf | hf_mirror | enterprise | manual
    enterprise_url: http://da-models.corp.internal/
    fallback_order: [enterprise, hf_mirror, hf]   # auto 模式下的探测顺序
```

### 6.6 HuggingFace 本地缓存复用

```
向导 Phase 1 检测：
  - 扫描 ~/.cache/huggingface/hub/
  - 如果发现已缓存的 BGE-M3、Whisper 等 → 弹窗提示
  - 用户选 "复用" → 软链接到 data/models/{model}/
  - 用户选 "重新下载" → 正常下载流程

节省场景：
  - 用户机器之前跑过其他 AI 项目 → 可能已有 2-5GB 缓存
  - 多个 DA 实例共用同一台机器 → 共享缓存
```

### 6.7 模型版本治理

```
- 每个 DA 版本绑定一份 manifest.json（如 DA v0.9 → manifest v1.0）
- 不同 DA 版本可能依赖不同模型版本（BGE-M3 v1 → v1.1）
- 升级 DA 时：
  - 向导自动比对 manifest，列出需要更新的模型
  - 用户可选 "立即更新" / "稍后"（旧版本仍可用，但功能可能受限）
  - 磁盘紧张时可清理旧版本

- 模型回滚：
  - data/models/bge-m3/v1.0/  (旧版本)
  - data/models/bge-m3/v1.1/  (新版本)
  - config.yaml 指向当前版本
```

---

## 7. 企业离线一体化部署

### 7.1 核心场景流程

```
┌─ 外网开发机（官方/客户机房外网区）────────────────────┐
│                                                       │
│  $ da-packer build \                                  │
│      --da-version v0.9.0 \                            │
│      --hub-version v0.9.0 \                           │
│      --models bge-m3,whisper-tiny,whisper-base,docling,paddleocr-vl \ │
│      --skills enterprise-essentials \                 │
│      --output da-bundle-v0.9.0.tar.gz                 │
│                                                       │
│  执行：                                                 │
│    1. docker pull da:v0.9.0 + da-hub:v0.9.0 + postgres + redis │
│    2. docker save 所有镜像到 images/                   │
│    3. 从 hf-mirror.com 下载模型权重                    │
│    4. 校验 SHA256                                      │
│    5. 打包默认 Skill 集                                │
│    6. 生成 install-hub.sh + docker-compose.yml         │
│    7. tar.gz 打包                                      │
│                                                       │
│  产出：da-bundle-v0.9.0.tar.gz (~10GB)                │
└───────────────────────────────────────────────────────┘
                       ↓
              U盘 / 移动硬盘 / SCP
                       ↓
┌─ 企业内网（air-gapped）──────────────────────────────┐
│                                                       │
│  # 1. 拷贝包 + 解压                                    │
│  $ tar xzf da-bundle-v0.9.0.tar.gz -C /opt/           │
│  $ cd /opt/da-bundle-v0.9.0/                          │
│                                                       │
│  # 2. 一键装 Hub                                       │
│  $ sudo ./install-hub.sh \                            │
│      --data-dir /opt/hub/data \                       │
│      --port 22000 \                                   │
│      --external-url https://hub.corp.internal:22000   │
│                                                       │
│  install-hub.sh 执行：                                 │
│    ① docker load < images/*.tar                       │
│    ② mkdir -p /opt/hub/data/{models,skills,db}        │
│    ③ cp -r models/* /opt/hub/data/models/             │
│    ④ cp -r skills/* /opt/hub/data/skills/             │
│    ⑤ docker compose up -d（启动 hub + postgres）      │
│    ⑥ 轮询 :22000/api/health 直到 ok                   │
│    ⑦ 提示浏览器访问完成 super_admin 创建              │
│                                                       │
│  → Hub 已上线，自托管模型源 + 镜像源                  │
└───────────────────────────────────────────────────────┘
                       ↓
┌─ Hub 控制台（浏览器 :22000）──────────────────────────┐
│                                                       │
│  管理员登录 → "添加 Worker"：                          │
│  ① 填目标机器 IP + SSH 端口 + 凭证                    │
│  ② 选 Worker 镜像（下拉框，本包内置 da:v0.9.0）       │
│  ③ 选模型组合（下拉框，本包内置 5 个模型）            │
│  ④ 选 Skill 包（多选）                                │
│  ⑤ 选组织                                             │
│  ⑥ 选分配员工（assigned_user_id）                     │
│                                                       │
│  Hub 远程拉起 Worker（关键：内网零外网依赖）：          │
│    SSH 到目标机器执行：                                │
│    # ① 加载镜像（从 Hub HTTP 拉镜像 tar 流式 load）   │
│    curl -s https://hub:22000/api/v1/images/da-v0.9.0.tar \ │
│      | docker load                                    │
│    # ② 启动容器                                       │
│    docker run -d \                                    │
│      -e DA_AUTH_MODE=hub \                            │
│      -e DA_HUB_URL=https://hub.corp.internal:22000 \  │
│      -e DA_JOIN_TOKEN={token} \                       │
│      -e DA_MODELS_SOURCE=hub \                        │
│      -v /opt/worker-data-{user}:/app/data \           │
│      -p 21000:21000 \                                 │
│      da:v0.9.0                                        │
│                                                       │
│  Worker 启动后从 Hub 拉模型（HTTP，内网）：             │
│    GET /api/v1/models/manifests/bge-m3                │
│    GET /api/v1/models/blobs/{sha256}                  │
│    SHA256 校验 → 写入 data/models/                    │
│                                                       │
│  → Worker 上线，全程零外网依赖                         │
└───────────────────────────────────────────────────────┘
```

### 7.2 da-packer 工具（独立 CLI，新组件）

```
位置：deepanalyze-hub/scripts/da-packer/（或独立 npm 包）
语言：TypeScript（与主项目一致）
分发：npm i -g @deepanalyze/da-packer

CLI 命令：
  da-packer build       构建离线包
  da-packer list        列出已构建的包
  da-packer verify      校验包完整性
  da-packer info        查看包内容清单

build 参数：
  --da-version v0.9.0                    DA Worker 镜像版本
  --hub-version v0.9.0                   Hub 镜像版本
  --models bge-m3,whisper-tiny,...       模型组合
  --skills enterprise-essentials         Skill 包集
  --output da-bundle-v0.9.0.tar.gz       输出文件
  --source hf_mirror                     下载源（hf / hf_mirror / enterprise / 已缓存）
  --enterprise-url URL                   企业镜像（可选）
  --platform linux/amd64,linux/arm64     目标架构（多平台）

build 流程：
  1. 解析 manifest.json（拉取最新的 da-assets/manifest.json）
  2. 拉镜像：docker pull --platform={target} {image}:{tag}
  3. docker save → images/{name}.tar
  4. 下载模型权重（多线程 + sha256 校验）
  5. 拉默认 Skill 包（从公网 Hub or 本地构建）
  6. 生成 install-hub.sh / docker-compose.yml / README.md
  7. 生成 bundle-manifest.json（包内容清单）
  8. tar.gz 打包（支持分卷：--split 2GB）
```

### 7.3 离线包结构

```
da-bundle-v0.9.0/
├── bundle-manifest.json         # 包内容清单（版本、模型列表、sha256）
├── README.md                    # 中文部署文档（含拓扑图）
├── INSTALL.md                   # 详细安装步骤
├── install-hub.sh               # Hub 一键安装脚本
├── install-worker.sh            # Worker 手动安装（备用方案）
├── uninstall.sh                 # 卸载脚本
├── docker-compose.yml           # Hub 部署 compose
├── images/                      # 所有 Docker 镜像
│   ├── da-base-v0.9.0-amd64.tar
│   ├── da-full-v0.9.0-amd64.tar
│   ├── da-hub-v0.9.0-amd64.tar
│   ├── postgres-17-pgvector.tar
│   └── redis-7.tar
├── models/                      # 模型权重（按 manifest 结构）
│   ├── bge-m3/
│   ├── whisper-tiny.pt
│   ├── whisper-base.pt
│   ├── docling/
│   └── paddleocr-vl/
├── skills/                      # 默认 Skill 包
│   ├── code-review-expert/
│   ├── contract-review/
│   └── ...
├── config/
│   ├── hub-default.yaml         # Hub 默认配置
│   └── da-worker-default.yaml   # DA Worker 默认配置
└── scripts/
    ├── start-hub.sh
    ├── stop-hub.sh
    ├── backup.sh                # 数据备份
    ├── restore.sh               # 数据恢复
    └── health-check.sh
```

### 7.4 install-hub.sh 执行流程

```bash
#!/bin/bash
# 智能检测 + 引导式安装

# Phase 1: 环境检测
detect_os()                  # linux/macos
detect_arch()                # x86_64/arm64
detect_docker()              # 是否装了 Docker（没装则提示）
detect_disk_space()          # /opt 可用空间（要求 ≥ 30GB）
detect_port_conflict(22000)  # 端口冲突检查

# Phase 2: 加载镜像
for img_tar in images/*.tar; do
  echo "Loading $img_tar..."
  docker load < "$img_tar"
done

# Phase 3: 创建数据目录
mkdir -p "$DATA_DIR"/{models,skills,db,logs,secrets}

# Phase 4: 复制模型和 Skill
cp -r models/* "$DATA_DIR/models/"
cp -r skills/* "$DATA_DIR/skills/"

# Phase 5: 生成配置
envsubst < config/hub-default.yaml > "$DATA_DIR/hub.yaml"
# 注入：external_url、admin_init_password、jwt_secret 等

# Phase 6: 启动 Hub + Postgres
docker compose up -d

# Phase 7: 健康检查轮询
for i in {1..60}; do
  if curl -sf http://localhost:22000/api/health > /dev/null; then
    echo "✓ Hub is up at http://localhost:22000"
    break
  fi
  sleep 2
done

# Phase 8: 引导首次访问
cat << EOF
✓ Hub 部署完成！

请用浏览器访问：http://localhost:22000/setup
按页面引导：
  1. 创建 super_admin 账号
  2. 配置组织树
  3. 添加 Worker 节点（自动派发独立 DA 给员工）
EOF
```

### 7.5 Hub 自托管（双模式）

Hub 启动时根据环境变量决定模型源：
```
DA_BUNDLE_PATH=/opt/da-bundle    ← 离线模式（自托管）
DA_BUNDLE_PATH=（空）             ← 在线模式（按需从公网下载）
```

**在线模式**下，Hub 作为"模型代理缓存"：
- Worker 请求模型 → Hub 检查本地缓存
- 缓存命中 → 直接返回（命中率高 = 节省带宽）
- 缓存未命中 → Hub 从公网下载 → 缓存 → 返回 Worker
- 多 Worker 共享同一 Hub 缓存

**两种模式的统一接口**：
```
Hub 新增模块：src/server/routes/bundle.ts

  GET  /api/v1/bundle/manifest                  ← 返回 bundle-manifest.json
  GET  /api/v1/images/{name}.tar                ← 流式返回镜像 tar
  GET  /api/v1/models/manifests/{name}          ← 已有，但读取本地路径
  GET  /api/v1/models/blobs/{sha256}            ← 已有
  GET  /api/v1/skills/{slug}/download           ← 已有
```

Worker 添加流程使用 bundle 资源（关键：内网零外网依赖）：
```
Hub SSH 到目标机器：
  # 用 curl + docker load 流式加载（不落盘）
  curl -s https://hub:22000/api/v1/images/da-base-v0.9.0-amd64.tar \
    | docker load

  # 启动容器
  docker run -d \
    -e DA_HUB_URL=https://hub.corp.internal:22000 \
    -e DA_JOIN_TOKEN={token} \
    -e DA_MODELS_SOURCE=hub \
    ...

Worker 启动后从 Hub 拉模型（HTTP）：
  ModelDownloader 识别 DA_MODELS_SOURCE=hub
    → GET {hub_url}/api/v1/models/manifests/bge-m3
    → GET {hub_url}/api/v1/models/blobs/{sha256}
    → SHA256 校验 → 写入 data/models/
```

### 7.6 镜像多平台支持

```
da-packer build 时支持 --platform 参数：
  --platform linux/amd64            # 只打 x86_64
  --platform linux/arm64            # 只打 ARM（Apple Silicon / 鲲鹏）
  --platform linux/amd64,linux/arm64 # 双架构（推荐，镜像稍大但全适配）

bundle-manifest.json 记录每个镜像的多架构 sha256：
  Hub 远程拉起时自动选目标机器架构对应的镜像
```

### 7.7 Skill 包内嵌

```
da-packer 把默认 Skill 包打入 bundle/skills/：
  - 每个 Skill 一个目录（含 SKILL.md + 资源）
  - bundle-manifest.json 记录版本

Hub 启动时扫描 /opt/da-bundle/skills/ → 批量注册为 system-level Skill
（所有组织可见，org_admin 可订阅）
```

### 7.8 全场景覆盖矩阵

| 场景 | da-packer | Hub | 部署方式 |
|---|---|---|---|
| **个人开发** | 不用 | 不用 | `docker pull da:base` + Web 向导 |
| **个人离线** | 用（仅 DA） | 不用 | `da-packer build --mini` → 拷贝 → docker load |
| **小团队（在线）** | 不用 | 用（公网部署） | docker compose + Hub 在线分发 |
| **小团队（离线）** | 用 | 用 | bundle 拷贝 → install-hub.sh → Hub 派发 Worker |
| **企业（在线）** | 不用 | 用 | docker compose + Hub 缓存代理 |
| **企业（离线）** | 用（核心） | 用 | **bundle 拷贝 → install-hub.sh → Hub 派发** |

---

## 8. DA ↔ Hub 完整协作矩阵

### 8.1 整体交互图

```
┌────────────────────────────────────────────────────────────────────┐
│                       Hub（控制平面 / 多租户）                       │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │  组织/用户  │  │  RBAC    │  │ Skill 市场 │  │  模型仓库  │            │
│  │  /Worker  │  │  权限    │  │ + 审核   │  │ + 镜像仓库 │            │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘  └─────┬────┘            │
│        │             │             │             │                  │
│        └─────────────┴─────────────┴─────────────┘                  │
│                          HTTP REST API                              │
│                          + SSH 远程（部署）                          │
└────────────────────────────────┬───────────────────────────────────┘
                                  │
            ┌─────────────────────┼─────────────────────┐
            │                     │                     │
     ┌──────┴──────┐       ┌──────┴──────┐       ┌──────┴──────┐
     │  DA 员工 A   │       │  DA 员工 B   │       │  DA 员工 C   │
     │             │       │             │       │             │
     │ authMode=   │       │ authMode=   │       │ authMode=   │
     │   hub       │       │   hub       │       │   hub       │
     │             │       │             │       │             │
     │ volume:     │       │ volume:     │       │ volume:     │
     │   A-data    │       │   B-data    │       │   C-data    │
     └─────────────┘       └─────────────┘       └─────────────┘
       (独立容器)             (独立容器)             (独立容器)
```

### 8.2 完整交互矩阵

| 域 | 交互 | 发起 | Endpoint / 通道 | 频率 | 数据流向 |
|---|---|---|---|---|---|
| **A. 认证身份** | Hub 登录代理验证 | DA | `POST /api/v1/auth/login`（代理转发） | 用户登录时 | DA → Hub 密码 → JWT 返 DA |
|  | JWKS 公钥同步 | DA | `GET /api/v1/auth/jwks.json` | 启动 + 每 6h | Hub → DA（公钥） |
|  | 用户从 Hub 跳 DA | 用户 | URL `?token=xxx` | 用户点击 | Hub → 浏览器 → DA |
| **B. Worker 生命周期** | 注册（带 join_token） | DA | `POST /api/v1/workers/register` | 一次性 | DA → Hub |
|  | 心跳（含 cached_skills） | DA | `POST /api/v1/workers/heartbeat` | 每 30s | DA → Hub → 指令返 |
|  | 指令 ack | DA | `POST /api/v1/workers/ack` | 指令执行后 | DA → Hub |
|  | Worker 申请审批 | Hub Admin | Hub UI 内部 | 按需 | Hub 内部 |
|  | Worker 注销 | DA / Hub | `POST /api/v1/workers/me/deactivate` | 退出时 | DA → Hub |
| **C. Skill 市场** | 浏览市场 | DA | `GET /api/v1/marketplace/skills` | 用户浏览时 | Hub → DA |
|  | 下载 Skill | DA | `GET /api/v1/marketplace/skills/:slug/download` | 安装时 | Hub → DA |
|  | 提交 Skill 到市场 | DA | `POST /api/v1/marketplace/skills/submit` | 作者发布时 | DA → Hub |
|  | 查询提交审核状态 | DA | `GET /api/v1/marketplace/submissions/:id` | 提交后轮询 | Hub → DA |
|  | 撤回已发布 Skill | DA | `DELETE /api/v1/marketplace/skills/:slug` | 作者撤回 | DA → Hub |
|  | Skill 版本升级 | DA | `GET /api/v1/marketplace/skills/:slug/versions` | 检查更新 | Hub → DA |
| **D. Plugin 市场** | 浏览/下载/提交 | DA | `/api/v1/marketplace/plugins/*`（同 C） | 同上 | 同 C |
| **E. 配置策略** | 推荐配置拉取 | DA | `GET /api/v1/config/recommended` | 启动 + 心跳捎带版本检查 | Hub → DA |
|  | 配置版本检查 | DA | `GET /api/v1/config/versions` | 心跳前 | Hub → DA |
|  | Force Update（强制更新 Skill） | Hub（心跳响应） | 心跳指令 `force_update` | 按需 | Hub → DA |
|  | Kill Switch（禁用 Skill） | Hub（心跳响应） | 心跳指令 `kill` | 按需 | Hub → DA |
|  | Rollback（回滚 Skill） | Hub（心跳响应） | 心跳指令 `rollback` | 按需 | Hub → DA |
|  | Policy Refresh（策略刷新） | Hub（心跳响应） | 心跳指令 `policy_refresh` | 按需 | Hub → DA |
| **F. 模型分发** | 模型 manifest 拉取 | DA | `GET /api/v1/models/manifests/:name` | 启动 + 按需 | Hub → DA |
|  | 模型 blob 下载 | DA | `GET /api/v1/models/blobs/:sha256` | 按需 | Hub → DA（流式） |
|  | 管理员上传模型 | Hub Admin | `POST /api/v1/models/upload`（multipart） | 一次性 | Admin → Hub |
| **G. 镜像分发** | 镜像 tar 流式下载 | 目标机器（curl） | `GET /api/v1/images/:name.tar` | 部署/升级时 | Hub → 目标机器 |
|  | 镜像清单查询 | 目标机器 | `GET /api/v1/bundle/manifest` | 部署前 | Hub → 目标机器 |
| **H. 部署运维** | 远程拉起 DA 容器 | Hub | SSH 通道 | Hub Admin 触发 | Hub → 目标机器 |
|  | 远程升级 DA | Hub | SSH 通道 | Hub Admin 触发 | Hub → 目标机器 |
|  | 远程停止/重启 | Hub | SSH 通道 | Hub Admin 触发 | Hub → 目标机器 |
|  | 部署日志回传 | 目标机器 | SSH stdout | 部署中 | 目标机器 → Hub |
|  | DA 健康状态上报 | DA | 心跳含 status | 每 30s | DA → Hub |
| **I. Hub Dashboard 跳转** | "我的 DA" 入口 | 用户 | URL `?token=xxx` | 用户点击 | Hub → 浏览器 → DA |
|  | 员工卡片显示 DA URL | Hub Admin | Hub UI 内部 | 按需 | Hub 内部 |

### 8.3 Skill 全生命周期（7 阶段）

```
┌─ 阶段 1：作者创建 Skill ──────────────────────────────────────────┐
│                                                                    │
│  DA 员工 A 在自己的 DA 里：                                         │
│    1. 在 DA SkillEditor 编写 Skill（prompt + 工具配置 + 元数据）    │
│    2. 本地测试通过                                                  │
│    3. 点击 "发布到市场"                                             │
│                                                                    │
│  DA 端动作：                                                       │
│    POST /api/v1/marketplace/skills/submit                          │
│    Body: { name, version, description, prompt, tools, visibility } │
│    Authorization: Bearer {作者的 Hub JWT}                           │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌─ 阶段 2：Hub 端审核 ─────────────────────────────────────────────┐
│                                                                    │
│  Hub 收到提交：                                                     │
│    - 写入 skill_submissions 表（status='pending'）                  │
│    - 通知 org_admin / super_admin（邮件 / UI 红点）                 │
│                                                                    │
│  Hub Admin 在审核面板：                                             │
│    - 查看 Skill 内容（prompt、工具、测试报告）                       │
│    - 决策：approve / reject / request_changes                       │
│    - approve → 写入 skill_packages 表（status='published'）        │
│      + 进入 marketplace_skills（市场列表）                          │
│    - reject → status='rejected'，通知作者                           │
│                                                                    │
│  DA 端轮询审核状态：                                                │
│    GET /api/v1/marketplace/submissions/{id}                        │
│    返回 { status: 'pending' | 'approved' | 'rejected' }            │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌─ 阶段 3：发布到市场，其他用户可浏览 ──────────────────────────────┐
│                                                                    │
│  DA 员工 B 在自己的 DA：                                            │
│    1. 打开 Skill Browser                                           │
│    2. GET /api/v1/marketplace/skills?category=...                  │
│    3. 看到员工 A 发布的 Skill                                       │
│    4. 点击 "安装到我的 DA"                                          │
│                                                                    │
│  DA 端动作：                                                       │
│    GET /api/v1/marketplace/skills/{slug}/download                  │
│    → 流式下载 Skill 包（zip / tarball）                             │
│    → 解压到本地 agent_skills/                                       │
│    → 注册到本地 DB                                                  │
│    → 员工 B 的 DA 现在可以使用该 Skill                              │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌─ 阶段 4：Hub 强制分发（企业管理员推送） ─────────────────────────┐
│                                                                    │
│  Hub Admin 决定让全员都用某 Skill：                                 │
│    1. 在 Hub UI 标记该 Skill 为 "mandatory"                        │
│    2. 给目标组织 / 用户群绑定                                       │
│                                                                    │
│  下次心跳时：                                                       │
│    DA 员工 C → POST /api/v1/workers/heartbeat                      │
│      Body: { cached_skills: [...], policy_version: N }             │
│                                                                    │
│    Hub 响应：                                                       │
│      instructions: [{                                              │
│        action: "sync",                       ← 推送新 Skill        │
│        package_id: "skill-xxx",                                    │
│        version_id: "v1.2",                                         │
│        priority: "mandatory"                                       │
│      }]                                                            │
│                                                                    │
│  DA 端：                                                           │
│    - 自动下载安装（mandatory）                                      │
│    - 或弹窗提示用户安装（recommended）                              │
│    - 安装完成后 POST /api/v1/workers/ack { instruction_id, ok }    │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌─ 阶段 5：作者发布新版本 → Hub 推升级 ────────────────────────────┐
│                                                                    │
│  DA 员工 A 修改 Skill：                                             │
│    1. 在本地改 prompt                                              │
│    2. 测试通过                                                     │
│    3. 点击 "发布新版本"（版本号从 v1.0 → v1.1）                     │
│                                                                    │
│  DA 端：                                                           │
│    POST /api/v1/marketplace/skills/submit（version='v1.1'）        │
│                                                                    │
│  Hub 审核通过：                                                     │
│    skill_packages 新增 v1.1 记录                                    │
│    旧 v1.0 status='deprecated'（保留，便于回滚）                    │
│                                                                    │
│  下次心跳时 Hub 推升级指令：                                        │
│    instructions: [{                                                │
│      action: "force_update",                 ← 强制升级             │
│      package_id: "skill-xxx",                                      │
│      version_id: "v1.1",                                           │
│      deadline: "2026-07-15"                                        │
│    }]                                                              │
│                                                                    │
│  DA 员工 B 的 DA：                                                 │
│    - 自动下载 v1.1                                                 │
│    - 备份当前 v1.0（便于 rollback）                                 │
│    - 切换到 v1.1                                                   │
│    - ack Hub                                                       │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌─ 阶段 6：发现问题 → Kill Switch ─────────────────────────────────┐
│                                                                    │
│  场景：发现 v1.1 有严重 bug                                        │
│                                                                    │
│  Hub Admin 紧急操作：                                               │
│    - 标记 skill-xxx v1.1 status='killed'                           │
│                                                                    │
│  下次心跳时 Hub 推 kill 指令：                                      │
│    instructions: [{                                                │
│      action: "kill",                         ← 立即禁用             │
│      package_id: "skill-xxx",                                      │
│      reason: "critical bug in v1.1"                                │
│    }]                                                              │
│                                                                    │
│  DA 端：                                                           │
│    - 立即禁用该 Skill（不能调用）                                   │
│    - 弹窗提示用户："此 Skill 被企业禁用，原因：critical bug"        │
│    - 不自动删除（保留数据）                                         │
│    - ack Hub                                                       │
│                                                                    │
│  或 Hub Admin 推 rollback：                                        │
│    instructions: [{                                                │
│      action: "rollback",                     ← 回滚到 v1.0          │
│      package_id: "skill-xxx",                                      │
│      version_id: "v1.0"                                            │
│    }]                                                              │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌─ 阶段 7：跨组织共享 ─────────────────────────────────────────────┐
│                                                                    │
│  场景：技术中心写了"代码 Review 专家" Skill，想共享给产品中心       │
│                                                                    │
│  在 Hub UI 操作：                                                   │
│    1. 技术中心 org_admin 找到该 Skill                               │
│    2. 点击 "跨组织共享"                                             │
│    3. 选择目标组织：产品中心                                        │
│    4. 写申请理由                                                    │
│                                                                    │
│  Hub 端：                                                           │
│    - 写入 skill_sharings 表（status='pending'）                     │
│    - 通知产品中心 org_admin                                         │
│                                                                    │
│  产品中心 org_admin 审批：                                          │
│    - approve → status='approved'                                   │
│    - 该 Skill 出现在产品中心用户的 Skill Browser                    │
│    - reject → 通知技术中心                                          │
│                                                                    │
│  注意：DA 端完全无感知，Hub 内部完成                                │
└────────────────────────────────────────────────────────────────────┘
```

### 8.4 Pull 模型原则

所有 DA ↔ Hub 交互保持 Pull 模型：
- DA 主动发起所有 HTTP 请求
- Hub 永不主动推送——所有"下发"通过心跳响应携带
- DA 端不暴露任何给 Hub 调用的端口（除健康检查）

这保证：
- DA 在 Hub 短时不可达时正常工作
- DA 容器无需暴露公网端口（除了用户访问的 :21000）
- 简化网络配置（DA 只需要 outbound，不需要 inbound 来自 Hub 的连接）

### 8.5 不做的事

| 不做的事 | 原因 |
|---|---|
| DA 端做 Skill 审核工作流 | 只在 Hub 端发生 |
| DA 端做跨组织共享审批 | 只在 Hub 端发生 |
| DA 主动上报使用统计 | 涉及隐私，未来可加但要可选 |
| DA 做 Kill Switch 自主判断 | 指令来自 Hub，DA 只执行 |
| DA 主动联系 Hub 推送数据 | 除非用户触发"发布"动作 |
| DA 多 Worker 协同 | 每个 DA 独立，互不知道 |

---

## 9. Hub 端配套改造

### 9.1 新增 endpoint 清单

```
认证（章节 4）：
  ✅ POST /api/v1/auth/login            （已有，DA 代理调用）
  ➕ GET  /api/v1/auth/jwks.json        （新增，DA 拉公钥；要求 Hub JWT 升级 RS256）

模型仓库（章节 6）：
  ➕ POST /api/v1/models/upload         （新增，admin 上传模型权重）
  ➕ GET  /api/v1/models/manifests/:name （新增）
  ➕ GET  /api/v1/models/blobs/:sha256   （新增）
  ➕ DELETE /api/v1/models/:name/:version （新增）

镜像仓库（章节 7）：
  ➕ GET  /api/v1/bundle/manifest       （新增，bundle 内容清单）
  ➕ GET  /api/v1/images/:name.tar      （新增，流式返回镜像 tar）

Skill 市场（已有 + 补充）：
  ✅ GET  /api/v1/marketplace/skills
  ✅ GET  /api/v1/marketplace/skills/:slug/download
  ✅ POST /api/v1/marketplace/skills/submit
  ➕ GET  /api/v1/marketplace/submissions/:id   （新增，审核状态查询）
  ➕ GET  /api/v1/marketplace/skills/:slug/versions  （新增，版本列表）
  ➕ DELETE /api/v1/marketplace/skills/:slug     （新增，作者撤回）

Worker 生命周期（已有 + 注销）：
  ✅ POST /api/v1/workers/register
  ✅ POST /api/v1/workers/heartbeat
  ✅ POST /api/v1/workers/ack
  ➕ POST /api/v1/workers/me/deactivate  （新增，DA 主动退出 Hub）

部署运维（章节 7，SSH 通道，非 HTTP）：
  ➕ SSH 远程拉起 Worker
  ➕ SSH 远程升级 Worker
  ➕ SSH 远程停止/重启 Worker
```

**新增统计**：4（认证+模型）+ 2（镜像）+ 3（Skill 市场）+ 1（Worker 注销）= **10 个新 HTTP endpoint + 3 类 SSH 操作**

### 9.2 数据库 schema 改动

```sql
-- 已有表，加字段：
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS assigned_user_id TEXT,      -- 章节 4.5：员工的 DA 入口
  ADD COLUMN IF NOT EXISTS da_url TEXT,                -- 章节 4.5：DA 访问 URL
  ADD COLUMN IF NOT EXISTS ssh_target_host TEXT,       -- 章节 7：远程拉起用
  ADD COLUMN IF NOT EXISTS ssh_target_port INT DEFAULT 22,
  ADD COLUMN IF NOT EXISTS ssh_user TEXT,
  ADD COLUMN IF NOT EXISTS ssh_key_encrypted TEXT,     -- AES 加密的 SSH 私钥
  ADD COLUMN IF NOT EXISTS current_image_tag TEXT,     -- 当前镜像版本
  ADD COLUMN IF NOT EXISTS last_health_status JSONB;   -- 最近心跳摘要

-- 新增表（章节 6）：模型仓库
CREATE TABLE model_artifacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT,
  storage_path TEXT NOT NULL,
  uploaded_by TEXT,
  created_at TIMESTARLTZ DEFAULT NOW(),
  UNIQUE(name, version)
);

-- 新增表（章节 7）：bundle 元数据
CREATE TABLE bundle_manifests (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  da_image_tag TEXT,
  hub_image_tag TEXT,
  models JSONB,                  -- 含哪些模型
  skills JSONB,                  -- 含哪些 Skill
  file_path TEXT,                -- tar.gz 在服务器上的位置
  file_size BIGINT,
  created_at TIMESTARLTZ DEFAULT NOW()
);

-- Skill 市场相关（已有 skill_packages, skill_submissions 表）
-- 章节 8.3 阶段 5：新增版本管理支持
ALTER TABLE skill_packages ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'published';
  -- published | deprecated | killed
ALTER TABLE skill_packages ADD COLUMN IF NOT EXISTS deprecated_at TIMESTARLTZ;
ALTER TABLE skill_packages ADD COLUMN IF NOT EXISTS kill_reason TEXT;
```

### 9.3 改造量评估

| 模块 | 改造点 | 量级 |
|---|---|---|
| Hub JWT | HS256 → RS256（向下兼容保留 HS256 过渡期）+ JWKS endpoint | ~200 行 |
| Hub 模型仓库 | 4 个 endpoint + model_artifacts 表 | ~400 行 |
| Hub 镜像仓库 | 2 个 endpoint + bundle_manifests 表 + 静态文件服务 | ~300 行 |
| Hub Skill 市场 | 3 个新 endpoint（submissions 状态、versions、撤回） | ~200 行 |
| Hub Worker 管理 | workers 表加字段 + 注销 endpoint | ~100 行 |
| Hub 部署编排 | SSH 远程拉起 / 升级 / 回滚 + 部署日志 | ~600 行 |
| **Hub 端合计** | | **~1800 行** |
| DA auth middleware | 新增 1 个文件 + Login 页 | ~300 行 |
| DA 安装向导 | 6 阶段 + Web/CLI 双入口 | ~800 行 |
| DA ModelDownloader | 新增服务 | ~400 行 |
| DA ModelServiceSupervisor | 新增服务 | ~300 行 |
| DA HubClient 扩展 | 新增 endpoint 调用 | ~200 行 |
| DA 前端 Login + Settings | 新增页面 | ~300 行 |
| **DA 端合计** | | **~2300 行** |
| da-packer | 独立 CLI 工具 | ~800 行 |
| **总计** | | **~4900 行** |

---

## 10. 升级路径与向下兼容

### 10.1 现状 → 目标的升级路径

| 维度 | 现状 | 目标 | 改造点 |
|---|---|---|---|
| DA 零 auth | 支持三种 authMode（none/local/hub） | 新增 `src/server/middleware/auth.ts` + Login 页 |
| DA 无登录页 | 前端新增 Login 页 | `frontend/src/pages/Login.tsx` |
| DA 无安装向导 | 启动时交互式向导 | 新增 `src/setup/wizard.ts` |
| DA 镜像 ~3GB | base ~500MB + full ~3GB | 重构 Dockerfile |
| Hub HS256 JWT | Hub 升级 RS256 + 新增 JWKS endpoint | Hub 改造（向下兼容：保留 HS256 一个过渡期） |
| 无模型分发 | Hub 自托管模型源 + 4 种下载源 | 新增模块 |
| 无镜像分发 | Hub 自托管镜像源 + bundle 系统 | 新增模块 |
| 无远程拉起 | Hub SSH 编排 + join_token 流程 | 新增模块 |
| 无离线包 | da-packer CLI + install-hub.sh | 新增工具 |

### 10.2 向下兼容保证

**对现有 DA 用户（个人版）**：
- `DA_AUTH_MODE` 未设置 → 默认 `none`，行为完全等于现状
- `DA_SERVER_URL` 未设置 → 不连 Hub，行为完全等于现状
- `data/config.yaml` 已存在 → 跳过向导，直接进入主应用
- 所有现有 sessions / KB / settings 数据零迁移

**对现有 Hub 用户（已部署 Phase 1-4）**：
- 现有 HS256 JWT 在过渡期内继续可用
- 新增 RS256 与 HS256 并存（验证时按 token header 决定算法）
- 现有 worker_token 机制不变
- 现有 SkillSync 5 指令不变

**对现有 Skill/Plugin 数据**：
- skill_packages 表只新增字段（status / deprecated_at / kill_reason），不删字段
- 默认 status='published'，所有现有 Skill 视为已发布

### 10.3 历史数据迁移

```sql
-- 现有 DA 实例升级到新版本时：
--   1. 启动检测 data/config.yaml 是否存在
--      - 存在 → 跳过向导（setup-complete.flag 自动生成）
--      - 不存在 → 启动向导
--   2. 检测 .env 或环境变量 DA_AUTH_MODE
--      - 未设置 → 默认 none（保持现状）
--      - 设置 → 按新模式运行
--   3. settings 表无强制 schema 变更，auth 配置写入新 KV 即可

-- 现有 Hub 实例升级时：
--   1. 应用新 migrations（workers 加字段、新增 model_artifacts / bundle_manifests 表）
--   2. 现有 workers 记录新字段为 NULL，按需补充
--   3. JWT 算法升级：新增 RS256 keypair，HS256 保留过渡期（默认 30 天）
--   4. 30 天后移除 HS256 支持（在版本说明中明示）
```

---

## 11. 后续增强（不在第一版）

以下功能在设计讨论中提及，但**不在第一版（v0.9.0）范围内**，留作后续增强：

| 功能 | 描述 | 触发版本 |
|---|---|---|
| 标准 OIDC / SAML / LDAP 集成 | 替代自签 JWT，接入企业 IdP（Azure AD / Okta / Keycloak）。**自带 authorization code flow**，4.3 路径 B 的 URL query token 风险随之消除 | v0.10+ |
| 多账号登录（用户级配额） | 一个 DA 支持多账号、按账号设配额 | v0.11+（仅在企业客户明确需求时） |
| 实时协作 | 多人同一 session，类似 Google Docs | v0.12+ |
| 资源使用统计 | DA 上报 Skill 使用情况 / token 消耗到 Hub（隐私敏感，需可选） | v0.11+ |
| K8s operator 部署 | Hub 作为 K8s 控制台，WorkerGroup 自定义资源 | v1.0+（需要明确企业 K8s 场景） |

> **关于 `hybrid` authMode**：早期讨论中曾列出"同时接受 local 和 hub token"的 hybrid 模式，但 4.6「个人 DA 加入企业 Hub」已通过"切换 authMode + 旧 local 账号向下兼容"覆盖了迁移期场景。一旦 Hub 接入企业 IdP（OIDC），Hub 就是统一身份入口，DA 只需验 Hub JWT，hybrid 失去存在意义。因此第一版不实现，后续也不计划补做。

---

## 附录 A：术语表

| 术语 | 含义 |
|---|---|
| **DA** | DeepAnalyze，个人 Agent 系统 |
| **Hub** | deepanalyze-hub，控制平面 |
| **Worker** | DA 实例作为 Hub 的客户端时的称呼 |
| **authMode** | DA 的认证模式（none / local / hub） |
| **mini-IdP** | DA 内置的本地账号系统（local 模式） |
| **join_token** | 一次性 token，用于 Worker 加入 Hub（24h 过期） |
| **worker_token** | Worker 注册成功后获得的长期 token（`wkt_<uuid>`） |
| **JWKS** | JSON Web Key Set，Hub 的公钥集合，DA 拉取用于本地验签 |
| **bundle** | da-packer 产出的离线一体化部署包（tar.gz） |
| **SkillSync 指令** | Hub 通过心跳响应下发给 DA 的 5 类指令（sync / force_update / kill / rollback / policy_refresh） |
| **da:base / da:full** | DA 的两档镜像（500MB / 3GB） |
| **ModelServiceSupervisor** | DA 内置的子服务统一编排器 |
| **ModelDownloader** | DA 内置的模型权重下载服务 |
| **da-packer** | 独立 CLI 工具，用于构建离线部署包 |

---

## 附录 B：决策记录（关键设计选择的理由）

| 决策 | 备选 | 选择理由 |
|---|---|---|
| DA 单租户 + 容器级隔离 | DA 内部多租户 | 用户明确"DA 是个人 Agent 系统"，简化优先；隔离靠容器最简单 |
| JWT 公钥本地验签 | 共享 HMAC 密钥 | 公钥泄露无害，安全性更高；本地验签离线可用 |
| 同一份镜像三种形态 | 三个独立镜像 | 维护成本低、升级路径简单 |
| 镜像仅 base + full 两档 | base + full + slim 三档 | 用户决策：slim 价值不高，两档够用 |
| 4 种模型源用户选 | 仅 HuggingFace 或仅 Hub | 覆盖海外/国内/企业/离线全场景 |
| da-packer 独立 CLI | 集成到 Hub Web UI | packer 需在外网机器跑，不依赖 Hub 在线 |
| Hub SSH 远程拉起 | 仅运维手动 / K8s operator | 用户选择"类似 K8s agent join"模式，企业体验好 |
| Skill 审核工作流在 Hub | 在 DA 端 | 多人协作的"多"的味道都在 Hub，DA 不掺和 |
| Pull 模型保持现状 | WebSocket / SSE 推送 | 简单、可靠、Hub 短时不可达不影响 DA |
