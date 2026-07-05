# Hub Server 全面优化设计

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DA Hub 从"满是 e2e 测试残留数据 + 内联样式硬编码 + 无设计系统"的半成品，升级为可对外演示的企业级多租户管理后台。

**Architecture:** 数据层（schema 强化 + 真实测试公司 seed）+ UI 层（移植 DA design tokens + 15 个通用组件 + 5 个 Hub 专属组件）+ 信息架构重写（7 个页面：Dashboard / Skills 市场 / Skill 详情 / 组织树 / 共享 / Worker / 安全网关）。

**Tech Stack:** Hono + PostgreSQL（后端）、React + Vite + TypeScript（前端）、Playwright（E2E）。

---

## 1. 背景与诊断

### 1.1 当前状态

通过实际访问运行中的 Hub（端口 22000）+ 查询 `deepanalyze_hub` 数据库 + 阅读 `frontend/src/` 源码，确认 4 类核心缺陷：

| ID | 类别 | 现象 |
|---|---|---|
| D1 | 数据质量 | 数据库全是 e2e 残留：`u_1781966194`、`system-skill-1781968547`、`Org_e2e68_mqn42hbg`；用户名是时间戳、组织名是测试 stamp、skill description 大量 NULL |
| D2 | 元数据缺失 | Skill 包缺 description/category/tags/icon；版本缺 change_summary；共享缺 usage_intent。打开列表就是一行名字，无法判断用途 |
| D3 | UI 系统缺失 | 全部用内联样式硬编码颜色（`#1f2937`/`#2563eb`/`#f3f4f6`），没有 design tokens、没有组件库、没有主题切换、没有 Toast/Modal/Tooltip 基础设施 |
| D4 | 信息架构差 | 侧边栏 7 个一级菜单都是平铺表格；没有 Dashboard 概览；点开 Skill 才在右侧弹详情；没有审计/用量可视化；没有 Worker 在线状态指示 |

### 1.2 用户决策记录

经 brainstorming 对话确认：
- **目标产物**：设计文档 + 实施计划（先评审再实施）
- **测试公司场景**：AI/科技公司（贴近实际业务）
- **范围**：D1 + D2 + D3 + D4 全做
- **UI 策略**：整体移植 DA design tokens + 组件库
- **数据策略**：TRUNCATE + 真实 seed
- **元数据策略**：DB 约束 + 应用层校验双层

---

## 2. 数据层设计

### 2.1 测试公司：「深度智能科技」

**组织树（12 节点，5 层级）**：

```
深度智能科技（DSI, company）
├── 产品研发中心（PRC, department）
│   ├── 基础平台部（INFRA, department）
│   │   ├── Agent 引擎组（AGENT, team）   ← 王思远（org_admin）
│   │   └── 数据基础设施组（DATA, team）    ← 林雨晴
│   └── 应用产品部（APP, department）
│       └── 知识库产品组（KB, team）        ← 陈一帆（org_admin）
├── 商业化中心（COMM, department）
│   ├── 解决方案部（SOL, department）       ← 周明朗（org_admin）
│   └── 客户成功部（CS, department）
└── 安全合规部（SEC, department）           ← 赵瑞华（org_admin + auditor）
```

**用户（约 19 人，真实姓名 + 拼音 username）**：
- 顶层：`admin`（保留为超管，display_name="系统管理员"）
- 部门负责人：王思远（INFRA/AGENT）、林雨晴（INFRA/DATA）、陈一帆（APP/KB）、周明朗（COMM/SOL）、赵瑞华（SEC）
- 普通员工：刘天宇（AGENT）、孙佳怡（KB）、吴浩然（SOL）、郑心怡（CS）、黄子轩（SEC）等

**角色绑定**（验证 RBAC）：
- `wang.siyuan` / `chen.yifan` / `zhou.minglang` / `zhao.ruihua` → `org_admin`（限本子树）
- `zhao.ruihua` 额外绑定 `auditor`（跨部门只读）
- 普通员工 → `analyst`（仅 `skill:subscribe` + `usage:read`）

### 2.2 Skill 包清单（6 个，覆盖三种 scope）

| 包名 | scope | category | icon | 描述 | tags |
|---|---|---|---|---|---|
| `da-agent-debug` | system | engineering | 🔧 | DA Agent 调试技巧：如何定位工具调用失败、流式中断、上下文超限 | agent, debug, streaming |
| `kb-report-writing` | system | writing | 📝 | 知识库报告写作：结构化输出规范、引用校验、避免幻觉 | report, citation, anti-hallucination |
| `infra-cost-opt` | org (DSI) | operations | ⚙️ | AWS/阿里云成本优化 checklist：闲置资源识别、reserved instance 决策 | aws, cost, ri |
| `customer-onboarding` | org (SOL) | business | 💼 | 新客户 onboarding 流程：需求确认 → 环境配置 → 培训 → 验收 | onboarding, sop |
| `security-audit-prep` | org (SEC) | security | 🛡️ | 等保 2.0 审计准备清单：日志保留、访问审计、漏洞扫描证据 | compliance, audit, 等保 |
| `personal-note-taking` | user | productivity | 🗒️ | 个人笔记整理习惯：obsidian tag 体系、Zettelkasten 实践 | obsidian, notes |

每个包至少 1 个 `skill_version`：
- content 是真实 Markdown（80-300 字），含 H2/H3 标题、代码块、经验卡片
- `change_summary` 非空（如"初版发布" / "增加引用校验章节"）

### 2.3 元数据 schema 强化

**migration `002_metadata_enrichment.ts`**（不破坏现有数据）：

```sql
ALTER TABLE skill_packages
  ADD COLUMN category TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN icon TEXT NOT NULL DEFAULT '📦',
  ADD COLUMN use_cases JSONB NOT NULL DEFAULT '[]';

ALTER TABLE skill_versions
  ALTER COLUMN change_summary SET DEFAULT '';

ALTER TABLE skill_sharings
  ADD COLUMN usage_intent TEXT,
  ADD COLUMN business_justification TEXT;
```

**migration `003_metadata_constraints.ts`**（seed 跑完后强制约束）：

```sql
ALTER TABLE skill_packages
  ALTER COLUMN description SET NOT NULL,
  ALTER COLUMN category SET NOT NULL
    ADD CONSTRAINT category CHECK (category IN (
      'engineering','writing','operations','business',
      'security','productivity','general'
    )),
  ALTER COLUMN tags SET NOT NULL;

ALTER TABLE skill_versions
  ALTER COLUMN change_summary SET NOT NULL;
```

### 2.4 后端路由校验

| 端点 | 必填字段 | 错误响应 |
|---|---|---|
| `POST /skills` | `name`, `description`（≥10 字符）, `category`（枚举）, `scope`, `tags`（数组） | 400 + 字段级错误 |
| `POST /skills/:id/versions` | `version`, `content`, `change_summary`（≥5 字符） | 400 |
| `POST /sharings` | `package_id`, `source_org_id`, `target_org_id`, `usage_intent`（≥5 字符） | 400 |

用 zod 校验，错误信息格式：
```json
{ "error": "Validation failed", "fields": { "description": "min 10 chars" } }
```

### 2.5 数据清理脚本

**`scripts/seed-realistic.ts`**（Bun 直跑，幂等）：

```typescript
// 1. 安全门：生产环境拒绝运行
if (process.env.NODE_ENV === 'production') {
  throw new Error("seed script refused in production");
}

// 2. TRUNCATE 业务表（保留 roles / permissions / role_permissions / skill_sync_queue）
await query(`TRUNCATE skill_audit_logs, skill_usage_logs, skill_subscriptions,
  skill_sharings, skill_versions, skill_packages, workers, api_keys,
  totp_secrets, users, organizations CASCADE`);

// 3. 创建组织树（12 节点）
// 4. 创建用户（19 人）
// 5. 绑定角色
// 6. 创建 skill 包 + 版本（6 个，带完整元数据）
// 7. 创建 1-2 个 sharing（INFRA → SOL）
// 8. 输出统计
```

**运行方式**：`bun run scripts/seed-realistic.ts`

---

## 3. UI 基础设施

### 3.1 从 DA 移植的设计资产

直接复制到 `deepanalyze-hub/frontend/src/styles/`（不改名、不改语义）：

```
design-tokens.css    # 颜色/间距/圆角/阴影/字体/动效 token
themes.css           # 浅色（默认）+ 深色主题
base.css             # 全局 reset + body + 滚动条
animations.css       # spin / fade-in / slide-up 关键帧
markdown.css         # Skill 内容渲染用
```

**token 摘录**（来自 DA `design-tokens.css`）：
- Spacing：`--space-0/1/2/3/4/5/6/8/10/12/16`（4px 基数）
- Radius：`--radius-sm/md/lg/xl/2xl/3xl/full`
- Typography：`--text-xs/sm/base/md/lg/xl/2xl/3xl/4xl`
- Shadow：`--shadow-xs/sm/md/lg/xl/2xl`（5 级）
- Transition：`--transition-fast/base/slow/spring`
- Color：`--color-primary-*` / `--color-success-*` / `--color-warning-*` / `--color-danger-*` / `--color-neutral-*`（每色 50-900 共 10 阶）

### 3.2 从 DA 移植的通用组件（15 个）

路径：`frontend/src/components/ui/`

| 组件 | 用途 |
|---|---|
| `Button` | 主/次/危险/链接 4 种 variant + 3 种 size |
| `Badge` | scope 标签、状态标签、角色标签 |
| `Input` / `TextArea` / `Select` | 表单输入 |
| `Modal` | 创建组织/skill/sharing 弹窗 |
| `Toast` | 操作反馈（订阅成功、kill 完成） |
| `Tooltip` | 表头说明、字段解释 |
| `Tabs` | Skill 详情页"内容/版本/审计/共享/统计"切换 |
| `EmptyState` | 列表为空时的引导 |
| `Skeleton` | 加载中占位 |
| `ConfirmDialog` | Kill switch / delete 等危险操作 |
| `SearchBar` | Skills 市场搜索 |
| `DropZone` | Skill 内容上传 SKILL.md |
| `ThemeToggle` | 浅色/深色切换 |

### 3.3 新增 Hub 专属组件（5 个）

路径：`frontend/src/components/hub/`

| 组件 | 用途 |
|---|---|
| `OrgTreeNode` | 组织树节点（icon + name + type badge + user_count + 折叠箭头） |
| `SkillCard` | Skill 卡片（icon + name + scope badge + version + 维护人 + 描述 + tags + 订阅/评分） |
| `PermissionMatrix` | 角色 × 权限矩阵（可视化 RBAC） |
| `AuditTimeline` | 审计日志时间轴（actor + action + 时间） |
| `StatusBadge` | Worker 在线/离线/pending 状态指示 |

### 3.4 主题系统

- 默认**浅色主题**（跟 DA 一致）
- 右上角 `ThemeToggle` 切换深色，持久化到 `localStorage` key `hub_theme`
- 首次访问跟随系统 `prefers-color-scheme`
- 用 CSS 变量切换，**不重新加载页面**

### 3.5 应用 Shell

**`App.tsx` 重写**：

- **左侧 Sidebar**：可折叠（默认展开 240px，折叠后 64px 只留图标），用 `--color-bg-sidebar` token，激活项有左侧 3px 主色指示条
- **顶部 Header**：面包屑（当前页面路径）+ 全局 SearchBar（`⌘K` 唤起）+ ThemeToggle + 用户头像下拉菜单（个人中心 / 修改密码 / 退出）
- **主内容区**：最大宽度 1400px 居中，`--space-6` (24px) padding
- **响应式**：< 768px 时 sidebar 自动折叠成抽屉

---

## 4. 页面级重设计

### 4.1 设计语言（已在浏览器 mockup 中确认）

- **配色**：深色 sidebar（`#0f172a`）+ 浅色主区（`#f8fafc`）+ 卡片白色背景
- **卡片**：12px 圆角 + 1px 边框 + `--shadow-sm` + 18px 内边距
- **图标**：彩色渐变背景方块（44×44px，10px 圆角）
- **Badge**：scope 用红/蓝/绿色编码（system=红、org=蓝、user=绿）
- **typography**：标题 `--text-xl` (18px) / 正文 `--text-base` (14px) / 标签 `--text-xs` (12px)

### 4.2 六个核心页面规格（+ 安全网关 = 7 个）

**① Dashboard（/）— 新建**
- 4 个统计卡（组织数 / Skill 数 / Worker 在线比 / 共享数）
- 最近活动流（审批请求、版本发布、新员工）
- 快速操作面板（创建 Skill / 新建组织 / 添加用户 / Kill Switch）

**② Skills 市场（/skills）— 重写**
- 顶部分类 chips（全部 / engineering / writing / operations / business / security / productivity）
- 卡片网格（3 列响应式），每张 `SkillCard` 展示完整元数据
- 排序下拉（订阅数 / 下载量 / 评分 / 最新）

**③ Skill 详情（/skills/:id）— 新建独立路由**
- Hero 区：大图标 + 名称 + scope/status badge + 描述 + 维护人 + 统计 + 订阅/复制 ID/Kill 按钮
- 5 个 Tabs：
  - 内容预览（渲染 Markdown，代码块 + 经验卡片）
  - 版本历史（时间轴，每条带 change_summary）
  - 审计日志（`AuditTimeline` 组件）
  - 共享状态（如果被共享出去）
  - 使用统计（订阅数趋势、调用成功率）

**④ 组织树（/orgs）— 重写**
- 左：缩进折叠树（每节点 icon + name + code + type badge + user_count）
- 右：选中节点详情侧栏（统计 + 成员列表含角色徽章 + 添加子节点/成员按钮）

**⑤ 跨组织共享（/sharings）— 重写**
- 顶部状态筛选 tab（全部 / 待审批 / 已通过 / 已撤销）
- 卡片列表：
  - 源组织 → 目标组织（带 icon 和组织名）
  - restrictions（max_users / expires_at / classification）
  - 4 步时间轴（发起 → 源组织批准 → 目标组织批准 → 生效/撤销）
  - 通过/拒绝按钮（待审批时）

**⑥ Worker 列表（/workers）— 重写**
- 顶部待审批队列（橙色背景卡片，每个 worker 含 hostname / version / 申请组织 / 通过/拒绝按钮）
- 已注册 Worker 表格：name / 所属组织 / 版本+平台 / 最后心跳 / 状态徽章

### 4.3 安全网关页（/security）— 微调（应用新设计 tokens）

- 状态卡（enabled / fail_open / timeout）
- 规则列表（Word engine + Regex engine）
- 测试输入框（扫描任意文本看结果）

---

## 5. 实施路径

### 5.1 五阶段顺序

```
Phase A: 后端 schema 升级 + 校验      (D2)
   ↓ 依赖
Phase B: 数据清理 + 真实 seed          (D1)
   ↓                                   ↑ 并行
Phase C: UI 基础设施（DA tokens + 组件）(D3)
   ↓ 依赖
Phase D: 7 个页面逐个重写              (D4)
   ↓
Phase E: 测试更新 + 全量回归
```

**依赖关系**：
- A → B：seed 脚本写入新字段（description 必填、category/tags/icon），schema 要先就位
- C ↔ A/B 并行：UI 基础设施（CSS/组件）跟后端无依赖
- D 依赖 A + C：页面消费新元数据 + 用新组件渲染
- E 收尾：把现有 20 个 e2e 测试 + 新增断言跑通

### 5.2 Phase A：schema 迁移

- A.1 新增 migration `002_metadata_enrichment.ts`：加列带 DEFAULT（不破坏现有数据）
- A.2 二次 migration `003_metadata_constraints.ts`：seed 跑完后强制 NOT NULL + CHECK
- A.3 后端路由 zod 校验：`description` 非空（≥10 字符）、`category` 枚举、`tags` 数组、`change_summary` 非空、`usage_intent` 非空

### 5.3 Phase B：seed 脚本

- B.1 `scripts/seed-realistic.ts`（Bun 直跑，幂等）
- B.2 安全门：检查 `NODE_ENV !== 'production'`
- B.3 TRUNCATE 业务表（保留 RBAC 元数据）
- B.4 创建组织树 / 用户 / 角色 / skill / sharing
- B.5 输出统计

### 5.4 Phase C：UI 基础设施移植

- C.1 复制 DA `styles/{design-tokens,themes,base,animations,markdown}.css` 到 Hub
- C.2 复制 DA 15 个组件到 `components/ui/`
- C.3 新建 Hub 5 个专属组件到 `components/hub/`
- C.4 重写 `App.tsx` Shell（折叠 sidebar + `⌘K` 搜索 + ThemeToggle）

### 5.5 Phase D：页面重写顺序

| 顺序 | 页面 | 关键改动 | 依赖组件 |
|---|---|---|---|
| D.1 | Dashboard | 新建页面，4 卡片 + 活动流 + 快速操作 | Button、Badge、EmptyState |
| D.2 | Skills 市场 | 表格→卡片网格，filter chips，订阅/评分 | SkillCard、Badge、SearchBar |
| D.3 | Skill 详情 | 新建路由 `/skills/:id`，5 Tabs | Tabs、Modal、ConfirmDialog |
| D.4 | 组织树 | 平铺→缩进折叠，节点详情侧栏 | OrgTreeNode、Badge |
| D.5 | 跨组织共享 | 表格→状态卡片 + 时间轴 | AuditTimeline、Modal |
| D.6 | Worker 列表 | 待审批队列 + 在线状态表格 | StatusBadge、ConfirmDialog |
| D.7 | 安全网关 | 状态卡 + 规则列表 | Badge、Tabs |

### 5.6 Phase E：测试更新

- E.1 更新 `tests/e2e/helpers/hubApi.ts`：构造数据时多传 `description / category / tags / icon / change_summary / usage_intent`
- E.2 新增测试：
  - T81: seed 脚本幂等性（运行 2 次结果一致）
  - T82: 元数据校验（缺 description → 400；tags 非数组 → 400）
  - T83: UI 视觉回归（6 页面截图对比 baseline）
- E.3 现有 20 个 e2e 测试（T61-T80）全部需要更新 helper 签名，但断言逻辑不变

### 5.7 风险与回滚

| 风险 | 缓解 |
|---|---|
| TRUNCATE 误删生产数据 | 脚本检查 `NODE_ENV`；生产 DB 没有 seed 脚本部署 |
| Schema 迁移失败 | 002 加列带 DEFAULT 可随时 DROP COLUMN；003 强制约束在 seed 后才跑 |
| DA 组件移植引入 bug | 单独分支 + T83 视觉回归测试兜底 |
| 主题切换导致样式塌 | 用 CSS 变量切换，不重新加载；base.css 全局 reset |

---

## 6. 文件结构

### 6.1 后端新增/修改

```
deepanalyze-hub/
├── src/
│   ├── store/migrations/
│   │   ├── 002_metadata_enrichment.ts   # 新增
│   │   └── 003_metadata_constraints.ts  # 新增
│   ├── domain/
│   │   ├── skill-package.ts             # 修改：CRUD 加 category/tags/icon
│   │   ├── skill-version.ts             # 修改：CRUD 加 change_summary
│   │   └── skill-sharing.ts             # 修改：CRUD 加 usage_intent
│   └── server/routes/
│       ├── skills.ts                    # 修改：zod 校验
│       ├── skill-workflow.ts            # 修改：zod 校验
│       └── skill-sharing.ts             # 修改：zod 校验
└── scripts/
    └── seed-realistic.ts                # 新增
```

### 6.2 前端新增/修改

```
deepanalyze-hub/frontend/src/
├── styles/
│   ├── design-tokens.css                # 从 DA 复制
│   ├── themes.css                       # 从 DA 复制
│   ├── base.css                         # 从 DA 复制
│   ├── animations.css                   # 从 DA 复制
│   └── markdown.css                     # 从 DA 复制
├── components/
│   ├── ui/                              # 从 DA 复制 15 个
│   │   ├── Button.tsx
│   │   ├── Badge.tsx
│   │   ├── Input.tsx
│   │   ├── TextArea.tsx
│   │   ├── Select.tsx
│   │   ├── Modal.tsx
│   │   ├── Toast.tsx
│   │   ├── Tooltip.tsx
│   │   ├── Tabs.tsx
│   │   ├── EmptyState.tsx
│   │   ├── Skeleton.tsx
│   │   ├── ConfirmDialog.tsx
│   │   ├── SearchBar.tsx
│   │   ├── DropZone.tsx
│   │   └── ThemeToggle.tsx
│   └── hub/                             # 新建 5 个
│       ├── OrgTreeNode.tsx
│       ├── SkillCard.tsx
│       ├── PermissionMatrix.tsx
│       ├── AuditTimeline.tsx
│       └── StatusBadge.tsx
├── pages/
│   ├── Dashboard.tsx                    # 重写（之前是空壳）
│   ├── Skills.tsx                       # 重写（卡片网格 + 路由分离）
│   ├── SkillDetail.tsx                  # 新建（/skills/:id）
│   ├── OrgTree.tsx                      # 重写（折叠 + 侧栏）
│   ├── Sharings.tsx                     # 重写（状态卡片 + 时间轴）
│   ├── WorkerApproval.tsx               # 重写（队列 + 表格）
│   └── Security.tsx                     # 微调
├── App.tsx                              # 重写 Shell
└── main.tsx                             # 引入新 CSS
```

### 6.3 测试新增/修改

```
deepanalyze/
└── tests/e2e/
    ├── helpers/hubApi.ts                # 修改：构造数据加新字段
    └── hub/
        ├── hub-auth.spec.ts             # 修改：helper 签名变化
        ├── hub-skillsync.spec.ts        # 修改
        ├── hub-workflow.spec.ts         # 修改
        ├── hub-sharing.spec.ts          # 修改
        ├── hub-security.spec.ts         # 修改
        ├── hub-integration.spec.ts      # 修改
        ├── hub-seed.spec.ts             # 新增：T81
        ├── hub-metadata.spec.ts         # 新增：T82
        └── hub-visual.spec.ts           # 新增：T83
```

---

## 7. 验收标准

实施完成后必须满足：

1. **数据层**
   - `bun run scripts/seed-realistic.ts` 可重复运行，每次结果一致
   - Hub DB 中所有 skill_packages 行 description/category/tags 非空
   - 缺失必填字段的 POST 请求返回 400 + 字段级错误

2. **UI 层**
   - 7 个页面在浅色和深色主题下都正常渲染
   - 设计 tokens 全部从 CSS 变量读取，没有硬编码颜色
   - `⌘K` 全局搜索可唤起，主题切换持久化

3. **测试层**
   - 现有 20 个 e2e 测试（T61-T80）全部通过
   - T81/T82/T83 三个新测试通过
   - 视觉回归基线截图存在并通过对比

4. **演示就绪**
   - 打开 Hub Dashboard 看到"深度智能科技"完整组织数据
   - Skills 市场看到 6 个带完整元数据的真实 Skill 包
   - 跨组织共享页看到 INFRA → SOL 的真实共享记录

---

## 8. 不在范围内

明确不做的事（YAGNI）：

- 不实现 `DELETE /users/:id` 完整级联（需要 schema 大改，已记录为后续任务）
- 不引入 i18n（当前只有中文，YAGNI）
- 不做 PWA / 离线支持
- 不做实时通知（WebSocket），刷新页面即可看到最新状态
- 不做权限粒度到字段级（行级 RBAC 已够用）
- 不引入第三方组件库（shadcn/ui 等），保持与 DA 一致
