# SubAgentPanel 紧凑展示设计 — 方案 B + 一键收起

## 背景

当前 `ChatWindow.tsx:319-326` 把所有活跃 workflow 的 `SubAgentPanel` 纵向堆叠在消息列表与输入框之间，外层包装 `flexShrink: 0`，每个面板折叠态至少占 ~55px。问题：

- 4 个并发 workflow ≈ 220px 固定占位，挤压消息列表可见空间
- 多层 delegate（synthesis-audit 自动补做）会让堆叠无限增长
- 没有分组/层级可视化，所有 workflow 视觉平级
- 没有面板自身的高度上限

用户诉求："50% 以下保持现状；超过时限制空间 + 滚动条"。本设计在此基础上优化为"渐进压缩 + 滚动兜底 + 一键收起"，避免纯滚动带来的"滚轮歧义"和"隐藏即遗忘"问题。

## 目标

1. workflow 数量少时（≤ 40vh）保持现状，零感知变化
2. workflow 数量多时自动压缩非运行中的面板到 ~28px 单行，运行中的始终展开
3. 即使压缩后仍超过 50vh，启用滚动作为最终兜底
4. 提供"一键收起"按钮快速隐藏全部细节
5. 无后端改动，纯前端 UI 重排

## 非目标

- 不引入树状嵌套可视化（用户明确选择"简单方案"）
- 不改 delegate_task 的事件投递机制（已在前序 commit 修复）
- 不改后端数据结构

## 状态模型扩展

### `frontend/src/store/workflow.ts` 新增字段

```typescript
interface WorkflowState {
  // ... existing fields ...

  /** 全局"一键收起"开关。true 时所有面板强制进入 compact 模式（userOverride 仍优先）。 */
  forceCompactAll: boolean;

  /** 用户对单个 workflow 的手动覆盖。优先级最高，避免自动压缩覆盖用户意图。 */
  userOverride: Map<string, "expanded" | "compact">;

  // Actions
  setForceCompactAll: (v: boolean) => void;
  setUserOverride: (wfId: string, mode: "expanded" | "compact" | null) => void;
}
```

初始化：`forceCompactAll: false`, `userOverride: new Map()`。

`clearWorkflow` 时同时清除对应的 `userOverride` 条目，避免 Map 无限增长。

## 面板展示模式 Selector

每个 `SubAgentPanel` 根据 workflow 状态 + 全局状态实时计算展示模式：

```typescript
type PanelMode = "expanded" | "compact";

function selectPanelMode(
  wf: ActiveWorkflow,
  ctx: {
    forceCompactAll: boolean;
    userOverride: Map<string, PanelMode>;
    autoCompact: boolean;  // 由 ChatWindow 根据整体高度启发式计算
  },
): PanelMode {
  // 1. 用户手动覆盖优先
  const override = ctx.userOverride.get(wf.workflowId);
  if (override) return override;

  // 2. 全局一键收起
  if (ctx.forceCompactAll) return "compact";

  // 3. 该 workflow 仍在运行 → 始终展开
  const hasRunning = Array.from(wf.agents.values())
    .some(a => a.status === "running" || a.status === "waiting" || a.status === "queued");
  if (hasRunning) return "expanded";

  // 4. 整体堆叠较高 → 压缩非运行中的
  if (ctx.autoCompact) return "compact";

  // 5. 默认展开（保持现状）
  return "expanded";
}
```

`autoCompact` 由 `ChatWindow` 用下面的启发式计算并通过 props 传入各 `SubAgentPanel`。

## 自动压缩启发式

用估算高度（不依赖 DOM 测量，更可靠）：

```typescript
const EXPANDED_HEIGHT_PX = 88;   // 标题栏 ~60px + chips 行 ~28px
const COMPACT_HEIGHT_PX = 28;

function computeAutoCompact(wfs: ActiveWorkflow[]): boolean {
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const normalTotal = wfs.reduce((s, w) =>
    s + (w.agents.size > 0 ? EXPANDED_HEIGHT_PX : 60), 0);
  // 40vh 阈值：低于此保持现状（符合"50% 以下保持现状"诉求，留 10vh 余量给输入框等）
  return normalTotal > vh * 0.4;
}
```

`ChatWindow` 在 `useMemo` 中根据当前 `activeWorkflows` + `window.innerHeight` 计算此值，监听 `resize` 事件重算。

> 不使用 ResizeObserver 是为了避免测量循环（measure → setState → re-render → measure）。

## 三种渲染模式（`SubAgentPanel.tsx`）

| 模式 | 触发 | 高度 | 内容 |
|------|------|------|------|
| `expanded`（默认） | `panelMode === "expanded"` 且 `panelExpanded === false` | ~88px | 标题栏 + 全部 agent 状态芯片（**现状**） |
| `compact`（新） | `panelMode === "compact"` | ~28px | 仅一行：状态点 + teamName + mode 徽章 + 计时 + "X/Y 完成" 摘要 |
| `expanded-detail`（现有） | 用户点击标题 → `panelExpanded === true` | 内部 maxHeight: `calc(100vh - 200px)` + 滚动 | 完整 SubAgentSlot 列表（**现状不变**） |

**关键不变量：** `compact` 模式下点击行依然切换 `panelExpanded`，进入 `expanded-detail`。三者正交，不互相干扰。

**`compact` 行内容（精确）：**

```
[●状态点] [teamName 截断]  [mode徽章]  [⏱ elapsed]  [✓ X/Y]   [⌄ chevron]
```

示例：
```
● workflow-b  delegate  ⏱ 1m  ✓ 3/3
```

仅一行，无换行。所有元素 `flexShrink: 0`，teamName 用 `text-overflow: ellipsis`。

## 布局改动（`ChatWindow.tsx`）

```
┌─ MessageList (flex: 1, overflow: hidden) ──────────┐
└────────────────────────────────────────────────────┘
┌─ Workflow Stack Wrapper ───────────────────────────┐
│ maxHeight: 50vh; overflowY: auto; flexShrink: 0    │
│ ┌─ Stack Header (新增) ─────────────────────────┐  │
│ │ [N active · M running]      [收起全部/展开全部] │  │
│ └───────────────────────────────────────────────┘  │
│ ┌─ SubAgentPanel (expanded, running) ───────────┐  │
│ │ ...                                           │  │
│ └───────────────────────────────────────────────┘  │
│ ┌─ SubAgentPanel (compact, completed) ─────────┐  │
│ │ ● workflow-b · delegate · ⏱ 1m · ✓ 3/3       │  │
│ └───────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
┌─ MessageInput ────────────────────────────────────┐
└────────────────────────────────────────────────────┘
```

**Stack Header（新增）：**
- 仅在 `sessionWorkflowIds.length > 0` 时渲染
- 左侧摘要：`{N} 个工作流 · {M} 个运行中`（同步 CSS 动画脉动以呼应运行态）
- 右侧按钮：单按钮在 `forceCompactAll === false` 时显示"收起全部"，反之显示"展开全部"
- 高度 ~32px，`border-bottom: 1px solid var(--border-primary)`

**Wrapper 样式：**
```css
{
  flexShrink: 0,
  maxHeight: "50vh",
  overflowY: "auto",
  transition: "max-height 0.2s ease",
  borderBottom: "1px solid var(--border-primary)",
  background: "var(--bg-secondary)",
}
```

> 滚动条样式沿用浏览器默认（项目无自定义滚动条规范）。

## 用户交互

| 用户动作 | 系统行为 |
|---------|---------|
| 点击 `expanded` 模式的标题栏 | 进入 `expanded-detail`（现状） |
| 点击 `compact` 模式的整行 | 进入 `expanded-detail`；同时 `setUserOverride(wfId, "expanded")` 锁定展开 |
| 在 `expanded-detail` 中再次点击标题 | 回到上一模式（compact 或 expanded）；清除 `userOverride` |
| 点击 Stack Header 的"收起全部" | `setForceCompactAll(true)`；所有非 userOverride 的面板进入 compact |
| 点击 Stack Header 的"展开全部" | `setForceCompactAll(false)`；恢复自动模式 |
| workflow 完成（30 秒后 clearWorkflow） | 同时清除其 `userOverride` 条目 |

## 边界场景

1. **0 个 workflow**：Stack Header 与 wrapper 一并隐藏（现状）
2. **1 个 workflow**：永不触发 autoCompact（88px << 40vh）；行为完全同现状
3. **workflow 内 agents = 0**：标题栏 60px，不显示 chips 行；compact 模式下显示 `等待启动...`
4. **用户展开 compact 面板后 workflow 完成**：`userOverride` 保留 30 秒后随 clearWorkflow 清除，不残留
5. **同 session 多 task 触发大量 workflow**：autoCompact 启发式按总高度判断，会优先压缩非运行中的；运行中的始终可见
6. **窗口 resize**：`useMemo` 依赖 `window.innerHeight`，配合 `resize` listener 重算 autoCompact

## 测试

### 单元测试（新建 `tests/frontend/panel-mode.test.ts`）

纯函数测试 `selectPanelMode` 和 `computeAutoCompact`：

- `selectPanelMode`：5 个分支（userOverride / forceCompactAll / hasRunning / autoCompact / default）各覆盖
- `computeAutoCompact`：临界点（恰好 40vh）、远低、远高、`agents.size === 0`

### E2E 测试（扩展现有 `tests/e2e/workflow-event-delivery.spec.ts`）

新增测试用例：

- **TC-COMPACT-1**：触发 5+ 个 delegate_task 后台 workflow
  - 断言 Stack Header 出现
  - 断言运行中的面板显示 chips 行（`expanded`）
  - 断言已完成的面板高度 ≤ 32px（`compact`）
  - 断言 wrapper `scrollHeight ≤ viewport * 0.5 + 32`（含 header）

- **TC-COMPACT-2**：点击"收起全部"
  - 所有面板进入 compact，运行中的也被压缩
  - 按钮文案变为"展开全部"
  - 再次点击恢复

- **TC-COMPACT-3**：点击 compact 行展开
  - 进入 expanded-detail
  - `userOverride` 被设置
  - 此时切换"收起全部"不影响该面板

- **TC-COMPACT-4**：单 workflow 场景
  - 无 Stack Header（或隐藏），无 compact 触发
  - 行为完全同改动前

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `frontend/src/store/workflow.ts` | 新增 `forceCompactAll` + `userOverride` + setter；`clearWorkflow` 清除 override |
| `frontend/src/components/ChatWindow.tsx` | wrapper 加 maxHeight/overflow；新增 Stack Header |
| `frontend/src/components/teams/SubAgentPanel.tsx` | 新增 `compact` 渲染分支；接收 `panelMode` prop |
| `tests/e2e/workflow-event-delivery.spec.ts` | 追加 TC-COMPACT-1~4 |
| `tests/frontend/panel-mode.test.ts` | 新建，纯函数测试 |

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 启发式估算高度与实际不符（agent 角色名超长换行） | 估算保守（88px 偏大），实际更长只会更早进入 compact，符合预期方向 |
| 卡片高度变化跳变 | 加 CSS `transition: height 0.15s ease`；现有 chips 行用 flex-wrap，高度变化连续 |
| 用户混淆三种模式 | compact 行点击行为与现状一致（点击展开详情），无需学习 |
| 50vh 在窄屏（< 600px 高）下仍嫌小 | 后续可加响应式断点（本次不做） |
| ResizeObserver 循环 | 已规避：用估算高度而非 DOM 测量 |

## 不做的事

- 不引入 workflow 树状嵌套可视化
- 不改 delegate_task 后端逻辑
- 不改 workflow 事件投递机制
- 不自定义滚动条样式
- 不做响应式断点（留给后续迭代）
- 不在 compact 行显示 agent 列表（只显示计数摘要）
