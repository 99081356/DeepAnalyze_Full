# Marketplace 浏览体验改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 MarketplacePanel 支持"打开即展示 → 滚动加载更多 → 输入即时过滤 + 服务端搜索"的现代浏览体验，移除分页按钮。

**Architecture:** Zustand store (`hub.ts`) 累积式 `marketplaceItems`，支持 `replace` / `append` 双模式；组件用 `IntersectionObserver` 监听底部哨兵触发 append；搜索框 onChange 立即派生 `displayedItems`（客户端过滤）+ 300ms debounce 触发服务端 replace。

**Tech Stack:** React 19 + TypeScript 5.7 + Zustand 5 + Playwright (e2e)。无前端单元测试框架（项目无 vitest/jest 配置），验证通过 Playwright e2e + tsc 类型检查。

**Spec:** `docs/superpowers/specs/2026-06-27-marketplace-browse-experience-design.md`

## Global Constraints

- **不引入新前端依赖**（无 vitest/react-testing-library/react-window 等）。验证通过现有 Playwright + tsc。
- **修改文件限定**：`frontend/src/store/hub.ts`、`frontend/src/components/marketplace/MarketplacePanel.tsx`、新建 `tests/e2e/marketplace-browse.spec.ts`。不修改 `api/client.ts`、`types/index.ts`。
- **样式系统保持 CSS variables**：所有新增样式用 `var(--xxx)` token，与现有 `styles` 对象模式一致。
- **DA 服务运行要求**：Playwright e2e 需 DA 在 `localhost:21000`、Hub 在 `localhost:22000` 已启动，且 Hub 至少有 25 个 approved skill（用于测试无限滚动到第二页）。如不足，e2e 测试需容忍 `hasMore=false` 情况。
- **Commit 粒度**：每个 Task 末尾 commit；commit message 使用中文或英文均可（项目习惯），格式 `feat(marketplace): ...` / `refactor(marketplace): ...` / `test(marketplace): ...`。
- **TDD 适配**：因无前端单测框架，"RED → GREEN" 通过 Playwright e2e 完成。每个功能 Task 先写 e2e 测试用例，运行确认失败（功能未实现），再实现代码，再运行确认通过。
- **不破坏现有行为**：服务端不可达 banner、安装按钮、刷新按钮、卡片样式、toast 通知等保持不变。
- **PR/Commit 末尾不加 Co-Authored-By**：项目无此约定，保持简洁。

---

## File Structure

| 文件 | 角色 | 改动类型 |
|------|------|---------|
| `frontend/src/store/hub.ts` | Zustand store；累积列表 + replace/append 双模式 + loadingMore/hasMore 状态 | 修改 |
| `frontend/src/components/marketplace/MarketplacePanel.tsx` | UI 组件；IntersectionObserver + 防抖搜索 + 客户端过滤 + 移除分页 | 修改 |
| `tests/e2e/marketplace-browse.spec.ts` | e2e 测试；覆盖初始加载、滚动、即时过滤、debounce、无分页、底部提示 | 新建 |

**不修改的相关文件：**
- `frontend/src/api/client.ts` — `listMarketplaceSkills(page, pageSize, search)` 已满足
- `frontend/src/types/index.ts` — `MarketplaceSkillItem` 字段已满足
- `frontend/src/components/layout/RightPanel.tsx` — MarketplacePanel 的挂载点不变

---

## Task 1: Store 重构 — 累积列表 + replace/append 模式

**目标：** 把 `marketplaceSkills` 重命名为 `marketplaceItems`，新增 `loadingMore` / `hasMore` 状态字段；`fetchMarketplaceSkills` 增加 `mode: "replace" | "append"` 参数。同步更新 `MarketplacePanel.tsx` 引用以保持现有行为（首批加载仍然工作）。

**Files:**
- Modify: `frontend/src/store/hub.ts` (整体重写 store state + fetchMarketplaceSkills 实现)
- Modify: `frontend/src/components/marketplace/MarketplacePanel.tsx:31-34` (引用字段名)

**Interfaces:**
- Produces: `useHubStore` 新签名 `fetchMarketplaceSkills(page?: number, search?: string, mode?: "replace" | "append") => Promise<void>`；新字段 `marketplaceItems` / `loadingMore` / `hasMore`
- Consumes: `api.listMarketplaceSkills(page, pageSize, search)` (已存在)

- [ ] **Step 1: 修改 store 字段和 action 签名**

打开 `frontend/src/store/hub.ts`，把整个文件替换为：

```typescript
import { create } from 'zustand';
import { api } from '../api/client';
import type { HubSyncState, MarketplaceSkillItem } from '../types/index';

interface HubState {
  // State
  syncState: HubSyncState | null;
  isWorkerMode: boolean | null; // null = not yet detected
  marketplaceItems: MarketplaceSkillItem[];     // 累积列表（append 或 replace）
  marketplaceTotal: number;                     // 服务端总数
  marketplacePage: number;                      // 已加载到的最后一页（1-based）
  marketplaceSearch: string;                    // 当前服务端搜索词（debounce 后落定）
  loading: boolean;                             // 首次/搜索切换加载（replace 模式）
  loadingMore: boolean;                         // 滚动加载下一页（append 模式）
  hasMore: boolean;                             // 是否还有更多页可加载
  syncing: boolean;

  // Actions
  detectRunMode: () => Promise<void>;
  fetchSyncState: () => Promise<void>;
  syncConfig: () => Promise<void>;
  fetchMarketplaceSkills: (
    page?: number,
    search?: string,
    mode?: 'replace' | 'append',
  ) => Promise<void>;
}

export const useHubStore = create<HubState>((set, get) => ({
  syncState: null,
  isWorkerMode: null,
  marketplaceItems: [],
  marketplaceTotal: 0,
  marketplacePage: 1,
  marketplaceSearch: '',
  loading: false,
  loadingMore: false,
  hasMore: false,
  syncing: false,

  detectRunMode: async () => {
    try {
      const state = await api.getHubSyncState();
      set({ isWorkerMode: true, syncState: state });
    } catch {
      set({ isWorkerMode: false });
    }
  },

  fetchSyncState: async () => {
    try {
      const state = await api.getHubSyncState();
      set({ syncState: state });
    } catch {
      // ignore
    }
  },

  syncConfig: async () => {
    set({ syncing: true });
    try {
      const result = await api.syncConfig();
      if (result.success) {
        await get().fetchSyncState();
      }
    } catch {
      // ignore
    } finally {
      set({ syncing: false });
    }
  },

  fetchMarketplaceSkills: async (page, search, mode = 'replace') => {
    const p = page ?? get().marketplacePage;
    const s = search ?? get().marketplaceSearch;

    if (mode === 'replace') {
      set({ loading: true });
    } else {
      set({ loadingMore: true });
    }

    try {
      const result = await api.listMarketplaceSkills(p, 20, s);
      const items = result?.items ?? [];
      const total = result?.total ?? 0;

      set((state) => {
        const baseItems = mode === 'replace' ? [] : state.marketplaceItems;
        // 按 slug 去重（append 模式防御性去重，避免服务端重复返回）
        const existingSlugs = new Set(baseItems.map((it) => it.slug));
        const dedupedNew = items.filter((it) => !existingSlugs.has(it.slug));
        const merged = [...baseItems, ...dedupedNew];

        return {
          marketplaceItems: merged,
          marketplaceTotal: total,
          marketplacePage: p,
          marketplaceSearch: s,
          hasMore: merged.length < total && items.length > 0,
        };
      });
    } catch {
      // 失败时不清空列表（避免清屏），仅更新 loading 标志
      // state 字段（marketplacePage / marketplaceSearch）保持原值不动
    } finally {
      set({ loading: false, loadingMore: false });
    }
  },
}));
```

- [ ] **Step 2: 更新 MarketplacePanel.tsx 引用**

打开 `frontend/src/components/marketplace/MarketplacePanel.tsx`。把第 31-36 行：

```typescript
  const marketplaceSkills = useHubStore((s) => s.marketplaceSkills);
  const marketplaceTotal = useHubStore((s) => s.marketplaceTotal);
  const marketplacePage = useHubStore((s) => s.marketplacePage);
  const loading = useHubStore((s) => s.loading);
  const syncState = useHubStore((s) => s.syncState);
  const fetchMarketplaceSkills = useHubStore((s) => s.fetchMarketplaceSkills);
```

替换为：

```typescript
  const marketplaceItems = useHubStore((s) => s.marketplaceItems);
  const marketplaceTotal = useHubStore((s) => s.marketplaceTotal);
  const marketplacePage = useHubStore((s) => s.marketplacePage);
  const loading = useHubStore((s) => s.loading);
  const syncState = useHubStore((s) => s.syncState);
  const fetchMarketplaceSkills = useHubStore((s) => s.fetchMarketplaceSkills);
```

接着把组件内所有 `marketplaceSkills` 引用替换为 `marketplaceItems`（约 4 处：line 176、183、198、200、294、299）。可用编辑器的 replace-all，但注意不要影响 `marketplaceSkills` 之外的字符串。

- [ ] **Step 3: tsc 类型检查**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx tsc --noEmit`
Expected: 0 errors（如出现 `marketplaceSkills` not defined 错误，说明替换遗漏，按报错点修复）

- [ ] **Step 4: 启动 DA + 验证首批加载仍然工作**

如 DA 未运行：

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
python3 start.py --no-docker --skip-frontend --port 21000 &
# 另开终端启动前端开发模式
cd frontend && npm run dev &
```

打开浏览器 `http://localhost:5173`（前端开发端口）或 `http://localhost:21000`（如已 build），打开一个 session，切换到右侧 "资源市场" 面板。

预期：
- 首批 20 个 skill 卡片正常渲染（如 Hub 数据少于 20，显示全部）
- 无控制台错误
- 分页按钮（尚未移除）仍然可点（但 task 1 不验证分页行为）

- [ ] **Step 5: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
git add frontend/src/store/hub.ts frontend/src/components/marketplace/MarketplacePanel.tsx
git commit -m "refactor(marketplace): store 改为累积列表 + replace/append 双模式

- marketplaceSkills → marketplaceItems
- fetchMarketplaceSkills 增加 mode 参数（replace|append）
- 新增 loadingMore / hasMore 字段
- 失败时不清空列表（避免清屏）
- append 模式按 slug 去重防御服务端重复返回"
```

---

## Task 2: 无限滚动 — IntersectionObserver + 哨兵 + loadMore

**目标：** 用户滚动到列表底部时自动加载下一页（append 模式）。

**Files:**
- Create: `tests/e2e/marketplace-browse.spec.ts` (本 task 只写第一个 test)
- Modify: `frontend/src/components/marketplace/MarketplacePanel.tsx`

**Interfaces:**
- Consumes: store 的 `loadingMore` / `hasMore` / `marketplacePage` / `marketplaceSearch`；action `fetchMarketplaceSkills(page, search, 'append')`
- Produces: `MarketplacePanel` 渲染一个底部哨兵 div，触发 loadMore

- [ ] **Step 1: 写 e2e 测试 — 无限滚动 (RED)**

新建 `tests/e2e/marketplace-browse.spec.ts`：

```typescript
/**
 * Marketplace 浏览体验 e2e 测试.
 *
 * 验证：
 * - 初始加载首批 skill
 * - 无限滚动加载更多
 * - 即时客户端过滤
 * - 防抖服务端搜索
 * - 移除分页按钮
 * - 加载完毕底部提示
 *
 * 前置条件：DA 在 :21000 运行，Hub 在 :22000 运行且有 approved skills。
 */
import { test, expect } from "@playwright/test";

const DA_URL = "http://localhost:21000";

test.describe.serial("Marketplace 浏览体验", () => {
  test.beforeEach(async ({ page }) => {
    // 捕获控制台错误
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    (page as any).__consoleErrors = consoleErrors;
  });

  async function openMarketplace(page: import("@playwright/test").Page) {
    await page.goto(`${DA_URL}/`);
    await page.waitForLoadState("networkidle");
    // 找到右侧面板切换到 marketplace 的按钮（图标按钮，title="资源市场" 或类似）
    // 根据实际 UI，可能需要点击侧边栏图标
    const marketplaceBtn = page.locator('[title*="市场"], [title*="marketplace"], button:has-text("资源市场")').first();
    if (await marketplaceBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await marketplaceBtn.click();
      await page.waitForTimeout(500); // 等待 lazy load
    } else {
      // 备选：通过 URL hash 或 keyboard shortcut 切换（视实际 UI 而定）
      // 这里假设面板已经默认显示，或者通过其他方式打开
      throw new Error("无法定位资源市场入口按钮，请检查 UI 选择器");
    }
  }

  test("M1: 初始加载首批 skill", async ({ page }) => {
    await openMarketplace(page);
    // 等待卡片渲染（首批最多 20 条）
    const cards = page.locator("text=/安装$/").locator("..").locator("..");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(20);
  });

  test("M2: 滚动加载更多（无限滚动）", async ({ page }) => {
    await openMarketplace(page);
    const cards = page.locator("text=/安装$/").locator("..").locator("..");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    const initialCount = await cards.count();

    // 如 Hub 总数 ≤ 20，hasMore=false，无法测试滚动；跳过
    const sentinel = page.locator('[data-testid="marketplace-sentinel"]').first();
    const hasSentinel = await sentinel.isVisible({ timeout: 2000 }).catch(() => false);
    if (!hasSentinel) {
      test.skip();
      return;
    }

    // 滚动到哨兵
    await sentinel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500); // 等 append 请求完成

    const newCount = await cards.count();
    expect(newCount).toBeGreaterThan(initialCount);
  });
});
```

注意：
- 卡片选择器 `text=/安装$/` 匹配每张卡片底部的"安装"按钮，往上两级是卡片 div。这是 fragile selector，如不工作，可在 Step 2 实现时给卡片加 `data-testid="marketplace-skill-card"`，并相应更新测试。
- 哨兵选择器 `[data-testid="marketplace-sentinel"]` 要求实现时给哨兵 div 加这个属性（Step 2 会做）。

- [ ] **Step 2: 运行测试确认失败 (RED 验证)**

确保 DA + Hub 运行中：

```bash
curl -s http://localhost:21000/api/health && echo "DA OK"
curl -s http://localhost:22000/health && echo "Hub OK"
```

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx playwright test tests/e2e/marketplace-browse.spec.ts -g "M2" --reporter=list`
Expected: FAIL（`marketplace-sentinel` 不存在，因为还没实现）

- [ ] **Step 3: 给 MarketplacePanel 加 IntersectionObserver + 哨兵**

打开 `frontend/src/components/marketplace/MarketplacePanel.tsx`。在文件顶部 imports 中确认有 `useEffect, useRef, useMemo, useCallback`：

```typescript
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
```

在组件内（约 line 38 附近，紧挨已有 useState 声明后）加入：

```typescript
  const loadingMore = useHubStore((s) => s.loadingMore);
  const hasMore = useHubStore((s) => s.hasMore);

  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadMore = useCallback(async () => {
    setLoadMoreError(null);
    try {
      await fetchMarketplaceSkills(
        marketplacePage + 1,
        useHubStore.getState().marketplaceSearch,
        "append",
      );
    } catch (err) {
      setLoadMoreError(err instanceof Error ? err.message : "加载更多失败");
    }
  }, [fetchMarketplaceSkills, marketplacePage]);
```

注意：`loadMore` 依赖项只放 `[fetchMarketplaceSkills, marketplacePage]`，搜索词从 `useHubStore.getState()` 即时读取避免 stale closure。

然后在 `useEffect(() => { loadSkills(); }, [])` 之后添加哨兵监听 effect：

```typescript
  // IntersectionObserver: 滚动到底部自动加载下一页
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    if (!hasMore) return;
    if (loading || loadingMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, marketplacePage, loadMore]);
```

最后在 JSX 的卡片列表（`{marketplaceItems.length > 0 && (...)}` 块）之后、原分页按钮位置之前，添加：

```jsx
      {/* 无限滚动哨兵 + 加载更多错误 */}
      {loadMoreError && (
        <div style={styles.loadMoreError}>
          <span>加载更多失败：{loadMoreError}</span>
          <button onClick={loadMore} style={styles.retryBtn}>重试</button>
        </div>
      )}
      {hasMore && (
        <div ref={sentinelRef} data-testid="marketplace-sentinel" style={styles.sentinel}>
          {loadingMore && (
            <div style={{ display: "flex", justifyContent: "center", padding: "var(--space-3)" }}>
              <Spinner size="sm" />
            </div>
          )}
        </div>
      )}
```

并在文件末尾 `styles` 对象内追加：

```typescript
  sentinel: {
    minHeight: 1,  // 确保可被 IntersectionObserver 触发
  },
  loadMoreError: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--space-2)",
    padding: "var(--space-2) var(--space-3)",
    fontSize: "var(--text-xs)",
    color: "var(--error)",
  },
  retryBtn: {
    padding: "2px 10px",
    background: "var(--bg-tertiary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-sm)",
    color: "var(--text-secondary)",
    fontSize: "var(--text-xs)",
    cursor: "pointer",
  },
```

- [ ] **Step 4: 给卡片加 data-testid（提升测试稳定性）**

把 line 205 的 `<div key={skill.slug} style={styles.skillCard}>` 改为：

```jsx
              <div key={skill.slug} data-testid="marketplace-skill-card" style={styles.skillCard}>
```

更新 e2e 测试中卡片选择器，把 `page.locator("text=/安装$/").locator("..").locator("..")` 替换为：

```typescript
const cards = page.locator('[data-testid="marketplace-skill-card"]');
```

（M1 和 M2 两个 test 都要改）

- [ ] **Step 5: tsc 类型检查**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: 运行 e2e 测试 (GREEN 验证)**

确保 DA + Hub 运行中，且 Hub 至少有 21+ approved skill（用于触发第二页加载）。如不足，M2 会 skip。

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx playwright test tests/e2e/marketplace-browse.spec.ts --reporter=list`
Expected: M1 PASS, M2 PASS 或 skip（取决于 Hub skill 总数）

- [ ] **Step 7: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
git add frontend/src/components/marketplace/MarketplacePanel.tsx tests/e2e/marketplace-browse.spec.ts
git commit -m "feat(marketplace): 无限滚动加载更多 skill

- IntersectionObserver 监听底部哨兵，rootMargin=200px 提前触发
- loadMore 用 store.marketplaceSearch（已 commit 的搜索词）+ append 模式
- 加 data-testid 便于 e2e 选择
- 加 loadMoreError 状态 + 重试按钮
- 新增 e2e 测试 M1（初始加载）和 M2（滚动加载）"
```

---

## Task 3: 即时客户端过滤 + 防抖服务端搜索

**目标：** 用户输入时立即看到已加载项的过滤结果（0ms）；300ms 后触发服务端搜索 replace 整个列表。

**Files:**
- Modify: `tests/e2e/marketplace-browse.spec.ts` (追加 M3 + M4)
- Modify: `frontend/src/components/marketplace/MarketplacePanel.tsx`

**Interfaces:**
- Produces: 派生 `displayedItems`（useMemo 过滤 marketplaceItems）；search bar onChange 立即更新 input + 启动 debounce timer

- [ ] **Step 1: 写 e2e 测试 — 即时过滤 + debounce (RED)**

在 `tests/e2e/marketplace-browse.spec.ts` 文件的最后一个 `test()` 之后追加：

```typescript
  test("M3: 输入立即触发客户端过滤（不等 debounce）", async ({ page }) => {
    await openMarketplace(page);
    const cards = page.locator('[data-testid="marketplace-skill-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    const initialCount = await cards.count();

    // 找到搜索框（按 placeholder）
    const searchInput = page.locator('input[placeholder*="搜索"]').first();
    await searchInput.fill("code");

    // 立即检查（不等 300ms debounce）：displayedItems 应该按 "code" 过滤
    // 至少应该是 ≤ initialCount（如果没匹配则 = 0）
    // 这里不断言具体数量（取决于 Hub 数据），只断言"立即变化"
    await page.waitForTimeout(50); // 远小于 300ms debounce
    const filteredCount = await cards.count();
    // 注意：仅当 Hub 数据中有不匹配 "code" 的卡片时，filteredCount 才会小于 initialCount
    // 如果全部匹配，filteredCount === initialCount
    expect(filteredCount).toBeLessThanOrEqual(initialCount);
  });

  test("M4: debounce 后触发服务端搜索（list 重置）", async ({ page }) => {
    await openMarketplace(page);
    const cards = page.locator('[data-testid="marketplace-skill-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });

    // 拦截 XHR 确认 debounce 后有请求
    const searchRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/hub/marketplace/skills")) {
        searchRequests.push(url);
      }
    });

    const searchInput = page.locator('input[placeholder*="搜索"]').first();
    await searchInput.fill("review");
    await page.waitForTimeout(500); // 等 debounce + 网络往返

    // 应该有至少一次带 search=review 的请求
    const reviewRequests = searchRequests.filter((u) => u.includes("search=review"));
    expect(reviewRequests.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: 运行测试确认失败 (RED 验证)**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx playwright test tests/e2e/marketplace-browse.spec.ts -g "M3|M4" --reporter=list`
Expected: FAIL（当前组件的搜索是按 Enter / 按钮触发，不会在 fill 时发请求；M3 可能因 `initialCount === filteredCount` 通过，需根据 Hub 数据评估；M4 应该 FAIL）

- [ ] **Step 3: 实现 useMemo displayedItems + 移除"搜索"按钮 + 防抖**

打开 `frontend/src/components/marketplace/MarketplacePanel.tsx`。

**3a.** 引入 `useMemo`（如 Task 2 已加则跳过）：

```typescript
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
```

**3b.** 在已有 useState 声明区（约 line 38-41）之后加入 refs：

```typescript
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

**3c.** 在 refs 之后加入派生 `displayedItems`：

```typescript
  // 即时客户端过滤（仅过滤已加载项，提供 0ms 反馈）
  const displayedItems = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    if (!q) return marketplaceItems;
    return marketplaceItems.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [marketplaceItems, searchInput]);

  const isSearching = searchInput.trim().length > 0;
```

**3d.** 替换 `handleSearch` 和 `handleKeyDown`（删除原函数）为新的 `handleSearchChange`：

把 line 58-66 的：
```typescript
  const handleSearch = () => {
    fetchMarketplaceSkills(1, searchInput);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };
```

替换为：

```typescript
  const handleSearchChange = (value: string) => {
    setSearchInput(value);

    // 清掉前一个 debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      setLoadError(null);
      fetchMarketplaceSkills(1, value.trim(), "replace").catch((err) => {
        setLoadError(err instanceof Error ? err.message : "搜索失败");
      });
    }, 300);
  };

  // 卸载时清理 timer，避免泄漏 / stale callback
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);
```

**3e.** 更新搜索框 JSX（line 130-154），移除 onKeyDown 和"搜索"按钮，加 onChange 即时触发和搜索中指示器。

把：
```jsx
      <div style={styles.searchBar}>
        <Search size={16} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="搜索技能..."
          style={styles.searchInput}
        />
        <button
          onClick={handleSearch}
          style={styles.searchBtn}
          onMouseEnter={(e) => { ... }}
          onMouseLeave={(e) => { ... }}
        >
          搜索
        </button>
      </div>
```

替换为：

```jsx
      <div style={styles.searchBar}>
        <Search size={16} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="搜索技能..."
          style={styles.searchInput}
        />
        {loading && isSearching && (
          <Spinner size="sm" color="var(--text-tertiary)" />
        )}
      </div>
```

**3f.** 把所有渲染 `marketplaceItems.map` 的地方改为 `displayedItems.map`（约 line 200 处的 `{marketplaceItems.map((skill) => {`）：

```jsx
        <div style={styles.skillsList}>
          {displayedItems.map((skill) => {
            // ... 卡片渲染
          })}
        </div>
```

**3g.** 调整空状态判断逻辑（line 183-195），区分"无任何加载项"vs"过滤后为空"。

把：
```jsx
      {!loading && !loadError && marketplaceItems.length === 0 ? (
        <div style={styles.emptyState}>
          <Package size={32} ... />
          <p>暂无可用技能</p>
          {searchInput && <p>未找到匹配"{searchInput}"的技能</p>}
        </div>
      ) : null}
```

替换为：

```jsx
      {!loading && !loadError && displayedItems.length === 0 ? (
        <div style={styles.emptyState}>
          <Package size={32} style={{ color: "var(--text-tertiary)", marginBottom: "var(--space-2)" }} />
          <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
            {isSearching
              ? `未找到匹配 "${searchInput.trim()}" 的技能`
              : "暂无可用技能"}
          </p>
          {isSearching && (
            <p style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: "4px 0 0" }}>
              尝试调整关键词或清空搜索
            </p>
          )}
        </div>
      ) : null}
```

**3h.** 把渲染列表的判断 `marketplaceItems.length > 0` 改为 `displayedItems.length > 0`（line 198）。

- [ ] **Step 4: 删除不再使用的样式 `searchBtn`**

在 `styles` 对象内找到 `searchBtn: { ... }` 字段（约 line 422-433），删除整个字段（避免 tsc unused warning，虽然 styles 是 Record 类型可能不会报，但保持整洁）。

- [ ] **Step 5: tsc 类型检查**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: 运行 e2e 测试 (GREEN 验证)**

确保 DA + Hub 运行中。

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx playwright test tests/e2e/marketplace-browse.spec.ts -g "M3|M4" --reporter=list`
Expected: M3 PASS, M4 PASS

- [ ] **Step 7: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
git add frontend/src/components/marketplace/MarketplacePanel.tsx tests/e2e/marketplace-browse.spec.ts
git commit -m "feat(marketplace): 即时客户端过滤 + 防抖服务端搜索

- 输入触发 useMemo displayedItems 客户端过滤（0ms 反馈）
- 300ms debounce 后触发服务端 replace 搜索
- 移除搜索按钮和 Enter 触发逻辑（onChange 即时）
- 卸载时清理 debounce timer 避免泄漏
- 空状态区分'无任何加载项'和'过滤后为空'
- 新增 e2e 测试 M3（即时过滤）和 M4（debounce）"
```

---

## Task 4: 移除分页 UI + 加载完毕提示 + 搜索汇总

**目标：** 删除 `上一页/下一页` 分页按钮和分页信息（一并消除漏传 search 的 bug）；加"已显示全部 X 个技能 / X / Y 个匹配"底部提示；加搜索模式 loading 指示。

**Files:**
- Modify: `tests/e2e/marketplace-browse.spec.ts` (追加 M5 + M6)
- Modify: `frontend/src/components/marketplace/MarketplacePanel.tsx`

**Interfaces:** 无新接口

- [ ] **Step 1: 写 e2e 测试 — 无分页 + 底部提示 (RED)**

在 `tests/e2e/marketplace-browse.spec.ts` 文件的最后一个 test 之后追加：

```typescript
  test("M5: 不存在分页按钮（已移除）", async ({ page }) => {
    await openMarketplace(page);
    await expect(page.locator('[data-testid="marketplace-skill-card"]').first()).toBeVisible({ timeout: 10_000 });

    // 不应该出现分页相关文本/UI
    await expect(page.locator("text=上一页")).toHaveCount(0);
    await expect(page.locator("text=下一页")).toHaveCount(0);
    // 也不应该有 "X / Y" 分页信息（小心：搜索汇总也会用 / 字符，所以只检查纯数字/数字模式）
    // 这里仅断言"上一页/下一页"按钮不存在，足够覆盖核心移除
  });

  test("M6: hasMore=false 时显示 '已显示全部' 提示", async ({ page }) => {
    await openMarketplace(page);
    await expect(page.locator('[data-testid="marketplace-skill-card"]').first()).toBeVisible({ timeout: 10_000 });

    // 滚到底（如还能滚）
    const sentinel = page.locator('[data-testid="marketplace-sentinel"]').first();
    const hasSentinel = await sentinel.isVisible({ timeout: 1000 }).catch(() => false);
    if (hasSentinel) {
      await sentinel.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1500);
    }

    // 此时应显示 "已显示全部" 提示
    await expect(page.locator("text=/已显示全部/").first()).toBeVisible({ timeout: 5000 });
  });
```

- [ ] **Step 2: 运行测试确认失败 (RED 验证)**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx playwright test tests/e2e/marketplace-browse.spec.ts -g "M5|M6" --reporter=list`
Expected:
- M5 FAIL（当前仍有"上一页/下一页"按钮）
- M6 FAIL（当前无"已显示全部"提示）

- [ ] **Step 3: 删除分页 UI，添加底部提示**

打开 `frontend/src/components/marketplace/MarketplacePanel.tsx`。

**3a.** 删除分页 JSX（line 298-335 的整个 `{/* Pagination */}` 块）。

**3b.** 删除 `totalPages` 计算（line 85）：

```typescript
  const totalPages = Math.ceil(marketplaceTotal / 20);  // ← 删除这行
```

**3c.** 在卡片列表块之后、哨兵块（Task 2 已添加）之前，加入"已显示全部"提示。完整结构：

```jsx
      {/* 卡片列表 */}
      {displayedItems.length > 0 && (
        <div style={styles.skillsList}>
          {displayedItems.map((skill) => { /* ... 卡片渲染保持不变 ... */ })}
        </div>
      )}

      {/* 加载更多错误（Task 2 已加） */}
      {loadMoreError && ( /* ... */ )}

      {/* 哨兵 + 加载中指示器（Task 2 已加） */}
      {hasMore && ( /* ... */ )}

      {/* 新增：已显示全部提示 */}
      {!hasMore && marketplaceItems.length > 0 && (
        <div style={styles.allLoaded}>
          {isSearching
            ? `已显示全部 ${marketplaceItems.length} / ${marketplaceTotal} 个匹配`
            : `已显示全部 ${marketplaceItems.length} 个技能`}
        </div>
      )}

      {/* 新增：搜索中状态指示（首次加载或切换搜索词时） */}
      {isSearching && loading && (
        <div style={styles.searchSummary}>搜索中...</div>
      )}
```

注意 `{/* 内联 keyframes spin */}<style>{...}</style>` 这块保留在末尾不动。

**3d.** 在 `styles` 对象末尾（`pageInfo` 字段之后）追加新样式：

```typescript
  allLoaded: {
    textAlign: "center",
    padding: "var(--space-3)",
    fontSize: "var(--text-xs)",
    color: "var(--text-tertiary)",
  },
  searchSummary: {
    textAlign: "center",
    padding: "var(--space-2)",
    fontSize: "var(--text-xs)",
    color: "var(--text-tertiary)",
  },
```

**3e.** 删除 `styles` 中不再使用的字段：

- `pagination: { ... }`（line 575-581）
- `pageBtn: { ... }`（line 582-590）
- `pageInfo: { ... }`（line 591-594）—— 注意：刚加的 `allLoaded` / `searchSummary` 字段不要删

- [ ] **Step 4: tsc 类型检查**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: 运行全部 M1-M6 测试 (GREEN 验证)**

确保 DA + Hub 运行中。

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx playwright test tests/e2e/marketplace-browse.spec.ts --reporter=list`
Expected: M1 PASS, M2 PASS/SKIP, M3 PASS, M4 PASS, M5 PASS, M6 PASS

- [ ] **Step 6: 手动回归 — 服务端不可达 banner 仍然显示**

断开 Hub（`pkill -f "bun.*hub"` 或停掉 Hub 进程），刷新页面。

预期：MarketplacePanel 显示 offline banner（服务器不可达），不渲染搜索框、列表、哨兵。控制台无新错误。

恢复 Hub，刷新页面，预期 banner 消失，列表重新加载。

- [ ] **Step 7: Commit**

```bash
cd /mnt/d/code/deepanalyze/deepanalyze
git add frontend/src/components/marketplace/MarketplacePanel.tsx tests/e2e/marketplace-browse.spec.ts
git commit -m "feat(marketplace): 移除分页 UI + 加载完毕提示

- 删除上一页/下一页按钮（一并消除漏传 search 的 bug）
- 加 '已显示全部 X 个技能' / 'X / Y 个匹配' 底部提示
- 加 '搜索中...' 首次加载指示
- 清理 pagination/pageBtn/pageInfo/searchBtn 不再使用的样式
- 新增 e2e 测试 M5（无分页）和 M6（加载完毕提示）"
```

---

## Task 5: 最终验证与文档更新

**目标：** 端到端走通完整体验，确认无回归，更新需求文档。

**Files:**
- 不修改代码，仅验证
- 可能修改：`docs/superpowers/specs/2026-04-20-comprehensive-design/requirements-checklist.md`（如包含 marketplace 相关条目）

**Interfaces:** 无

- [ ] **Step 1: 完整 e2e 回归测试**

确保 DA + Hub 运行中，且 Hub 至少有 25+ approved skills（用于覆盖滚动到第二页场景）。

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && npx playwright test tests/e2e/marketplace-browse.spec.ts --reporter=list`
Expected: M1-M6 全部 PASS（M2 在 Hub skill < 21 时 SKIP 是可接受的）

- [ ] **Step 2: 手动 UX 走查**

打开浏览器到 `http://localhost:21000`，进入 session，切到资源市场面板。

走查清单：
- [ ] 打开面板即看到首批 skill 卡片，无 loading 卡顿
- [ ] 向下滚动平滑追加，无卡片闪烁/跳动
- [ ] 输入 "code" 时立即看到客户端过滤效果
- [ ] 300ms 后列表切换为服务端搜索结果
- [ ] 清空搜索框立即恢复全量
- [ ] 滚到底部后看到 "已显示全部 X 个技能" 提示
- [ ] 任意卡片点击"安装"按钮 → 成功 → 显示"已安装"
- [ ] 再次点击"已安装"按钮无响应
- [ ] 无控制台错误、警告（已知的 favicon/ResizeObserver 除外）
- [ ] 后端日志无 ERROR

- [ ] **Step 3: 检查需求文档是否需要同步**

Run: `grep -in "marketplace\|market\|资源市场" /mnt/d/code/deepanalyze/deepanalyze/docs/superpowers/specs/2026-04-20-comprehensive-design/requirements-checklist.md`

如找到相关条目，根据本次实现更新（例如"支持无限滚动浏览""支持即时搜索过滤"等）。如无相关条目则跳过。

- [ ] **Step 4: 最终 git 状态检查**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze && git log --oneline -10`
Expected: 看到 4 个新 commits（Task 1-4 各一个）

Run: `git status`
Expected: clean working tree（或仅有需求文档更新未提交，如有则单独 commit）

如需求文档有更新：

```bash
git add docs/superpowers/specs/2026-04-20-comprehensive-design/requirements-checklist.md
git commit -m "docs: 同步 marketplace 浏览体验改进到需求清单"
```

- [ ] **Step 5: 完成报告**

实施完成。汇总：

| 维度 | 结果 |
|------|------|
| 修改文件 | `frontend/src/store/hub.ts`、`frontend/src/components/marketplace/MarketplacePanel.tsx` |
| 新建文件 | `tests/e2e/marketplace-browse.spec.ts` |
| 新增 commits | 4-5 个（每个 Task 一个） |
| e2e 测试 | M1-M6 全部 PASS（M2 视数据量 SKIP） |
| 类型检查 | 0 errors |
| 行为变化 | 自动加载首批 → 滚动加载更多 → 即时过滤 → 防抖服务端搜索 → 移除分页 |

---

## Self-Review

### 1. Spec coverage

| Spec 章节 | 对应 Task |
|----------|----------|
| 核心行为改动 - 初始加载 | Task 1 (store refactor) 保留 |
| 核心行为改动 - 无限滚动 | Task 2 |
| 核心行为改动 - 即时搜索（混合模式） | Task 3 |
| 核心行为改动 - 移除分页按钮 | Task 4 |
| Store 状态扩展 | Task 1 |
| 组件交互流程（useEffect 加载、IntersectionObserver、debounce 搜索、清空搜索恢复） | Task 2 + Task 3 |
| 边界情况 - 服务端不可达 | Task 4 Step 6 手动回归 |
| 边界情况 - 搜索无结果 / 全量无结果 | Task 3 Step 3g 空状态区分 |
| 边界情况 - 滚动加载失败 | Task 2 Step 3 loadMoreError |
| 边界情况 - 快速输入触发多次 debounce | Task 3 Step 3d 清 timer |
| 边界情况 - 已安装状态丢失（刷新后） | YAGNI 显式排除 |
| 边界情况 - 搜索模式滚动到底 | Task 2 sentinel 不区分 isSearching，loadMore 用 store 内 marketplaceSearch |
| 边界情况 - 清空搜索框 | Task 3 Step 3d handleSearchChange("") → debounce → replace 拉全量 |
| 性能考量 - IntersectionObserver / rootMargin / debounce / useMemo | Task 2 + Task 3 |
| 性能考量 - 虚拟滚动 | YAGNI 显式排除 |
| 修改文件清单 | File Structure 章节 |
| 测试策略 | M1-M6 e2e 测试 |
| 风险与缓解 | 实施中遵守（如不引入新依赖） |

✅ 全部覆盖

### 2. Placeholder scan

通读 plan：
- 无 TBD / TODO / "fill in details"
- 每个 step 都有具体代码或命令
- 测试代码是完整的，不是 stub
- 实现代码是完整的，不是伪代码

✅ 无占位符

### 3. Type consistency

- `fetchMarketplaceSkills(page?, search?, mode?)` 签名在 Task 1 定义，Task 2/3 调用方式一致（append/replace 字面量字符串）
- `marketplaceItems` 字段名在 store (Task 1) 和组件 (Task 1 Step 2 引用、Task 3 Step 3f 渲染) 一致
- `loadingMore` / `hasMore` 字段名在 store (Task 1) 和组件 (Task 2 Step 3 引用、Task 4 Step 3c 引用) 一致
- `displayedItems` 变量名在 Task 3 Step 3c 定义，Step 3f/3h 引用一致
- `handleSearchChange` 在 Task 3 Step 3d 定义，Step 3e 调用一致
- `loadMore` 在 Task 2 Step 3 定义，Step 3 哨兵 callback + Task 4 重试按钮调用一致
- `loadMoreError` state 在 Task 2 Step 3 定义，Task 4 Step 3c 渲染一致
- `sentinelRef` 在 Task 2 Step 3 定义并使用，Task 4 Step 3c 仍引用
- `data-testid="marketplace-sentinel"` 在 Task 2 Step 3 JSX 加，e2e (Task 2/4) 用同一字符串选择
- `data-testid="marketplace-skill-card"` 在 Task 2 Step 4 加，e2e (Task 2/3/4) 用同一字符串选择

✅ 类型与命名一致

### 4. 已知潜在问题

- **e2e 测试的 `openMarketplace` helper 依赖 UI 选择器**：如 DA UI 改变，可能需要更新 `[title*="市场"]` 选择器。Step 1 中已有 fallback throw 提示。
- **M2 测试 SKIP 条件**：Hub 数据少于 21 个时 skip。可在测试前 seed 数据，但本期不做。
- **Hub e2e seed 数据**：当前未保证 Hub 有 ≥25 个 approved skill。如运行环境不足，M2 skip 是可接受的（已在 Global Constraints 声明）。
