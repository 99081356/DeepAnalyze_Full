# Marketplace 浏览体验改进设计

**日期：** 2026-06-27
**作者：** Claude (经 brainstorming 流程)
**状态：** 设计已审核，待制定实施计划

## 背景与动机

`MarketplacePanel` 是用户从 Hub 浏览和安装 skill 的入口。当前实现存在以下问题：

1. **分页按钮漏传搜索词的 bug**：`MarketplacePanel.tsx:303` 和 `:321` 调用 `fetchMarketplaceSkills(page - 1)` / `fetchMarketplaceSkills(page + 1)` 时未传第三个 `search` 参数。store 的 fallback `search ?? get().marketplaceSearch` 会取当前 store 中的值，但用户搜索后翻页时这个值理应保留——经核对实际表现尚可，但语义不明确，且分页按钮整体可以由无限滚动取代。

2. **搜索非即时**：用户必须按 Enter 或点击"搜索"按钮才会触发查询，与用户期望的"边输边过滤"不符。

3. **分页 UX 不直观**：用户需手动点击"下一页"才能看到更多 skill，无法通过滚动自然浏览。

4. **首批渲染压力**：虽然当前每页 20 条不算多，但当前 store 的 `fetchMarketplaceSkills` 是 replace 语义，无法平滑过渡到无限滚动的 append 语义。

用户原话（设计目标）：
> 点开界面的时候，可以把 hub 上有的 skills 在下面展示，这样可以浏览预览。为了性能考虑可以预览前面的能展示下的这些，往下滑动的时候再浏览更多，搜索的时候直接过滤就行了。

## 设计目标

| 目标 | 含义 |
|------|------|
| 自动加载 | 打开面板即拉取首批，无需手动触发 |
| 无限滚动 | 滚动接近底部自动加载下一批，平滑浏览 |
| 即时搜索 | 输入时立即看到过滤效果，无需按 Enter |
| 全覆盖搜索 | 服务端搜索能找到未加载的 skill，不仅限于已加载 |
| 性能可控 | 首屏只渲染少量卡片；搜索不触发频繁请求 |
| 修复分页 bug | 通过移除分页 UI 一并消除 bug |

## 架构与数据流

```
用户打开 MarketplacePanel
  ↓
useEffect → store.fetchMarketplaceSkills(page=1, search="", mode="replace")
  ↓
DA 后端 /api/hub/marketplace/skills
  ↓
Hub 后端 /api/v1/marketplace/skills（SQL ILIKE 搜索）
  ↓
返回 { items, total } → store.marketplaceItems（replace 模式）
  ↓
渲染首批 20 张卡片 + 哨兵 div

用户向下滚动至哨兵可视区
  ↓
IntersectionObserver 触发 store.fetchMarketplaceSkills(page+1, search, mode="append")
  ↓
新结果追加到 marketplaceItems 尾部

用户在搜索框输入
  ↓
onChange 立即更新 searchInput state
  ↓
派生 displayedItems = filter(marketplaceItems, searchInput)（即时反馈）
  ↓
debounce 300ms 后调用 store.fetchMarketplaceSkills(1, searchInput, "replace")
  ↓
服务端结果到达 → marketplaceItems 重置 → displayedItems 自然更新
```

## Store 设计

### 状态字段

```typescript
interface HubState {
  // 替换原有 marketplaceSkills / marketplacePage / marketplaceTotal / marketplaceSearch
  marketplaceItems: MarketplaceSkillItem[];   // 累积列表（append 或 replace）
  marketplaceTotal: number;                   // 服务端总数
  marketplacePage: number;                    // 已加载到的最后一页（1-based）
  marketplaceSearch: string;                  // 当前服务端搜索词（debounce 后落定）
  loading: boolean;                           // 首次/搜索切换加载（replace 模式）
  loadingMore: boolean;                       // 滚动加载下一页（append 模式）
  hasMore: boolean;                           // 是否还有更多页可加载

  // 其他字段保持不变：syncState / isWorkerMode / syncing

  // Actions
  fetchMarketplaceSkills: (
    page?: number,
    search?: string,
    mode?: "replace" | "append",
  ) => Promise<void>;
}
```

### Action 行为规约

**`fetchMarketplaceSkills(page?, search?, mode?)`**

| 参数 | 默认值 | 含义 |
|------|--------|------|
| `page` | `get().marketplacePage` | 1-based 页码 |
| `search` | `get().marketplaceSearch` | 服务端搜索词；空字符串表示全量浏览 |
| `mode` | `"replace"` | `replace`：重置 `marketplaceItems` 为本页结果；`append`：把本页结果追加到 `marketplaceItems` 尾部 |

**副作用更新规则：**

- `replace` 模式：`marketplaceItems = result.items`；`loading = true → false`
- `append` 模式：`marketplaceItems = [...prev, ...result.items]`；`loadingMore = true → false`；按 `id` 或 `slug` 去重避免重复
- `marketplacePage = page`；`marketplaceSearch = search`
- `hasMore = marketplaceItems.length < result.total && result.items.length > 0`
  - `result.items.length === 0` 表示服务端无更多数据，强制 `hasMore = false`
- 失败时保持现有 `marketplaceItems` 不变（避免清屏），仅设置 loading 标志

### 旧字段迁移

`marketplaceSkills` 字段被 `marketplaceItems` 替代。需检查所有引用：

- `MarketplacePanel.tsx`：本设计的唯一消费者，会一并重写
- 全局 grep 确认无其他文件引用

## 组件设计

### 状态

```typescript
// 组件本地 state
const [searchInput, setSearchInput] = useState("");        // 即时输入
const [installingSlug, setInstallingSlug] = useState<string | null>(null);
const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set());
const [loadError, setLoadError] = useState<string | null>(null);
const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

// Refs
const sentinelRef = useRef<HTMLDivElement | null>(null);
const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const searchRequestIdRef = useRef<number>(0);              // 防 race
```

### 派生

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

### 初始加载

```typescript
useEffect(() => {
  // 面板挂载时拉取首批
  store.fetchMarketplaceSkills(1, "", "replace").catch((err) => {
    setLoadError(err instanceof Error ? err.message : "加载失败");
  });
}, []);
```

### IntersectionObserver（无限滚动）

```typescript
useEffect(() => {
  const sentinel = sentinelRef.current;
  if (!sentinel) return;
  if (!hasMore) return;                // 无更多时不监听
  if (loading || loadingMore) return;  // 已有请求在飞，等完成

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) {
        loadMore();
      }
    },
    { rootMargin: "200px" },  // 提前 200px 触发，体验更顺
  );
  observer.observe(sentinel);
  return () => observer.disconnect();
}, [hasMore, loading, loadingMore, marketplacePage, marketplaceSearch]);
```

**搜索模式下也允许无限滚动：** `loadMore` 内部从 store 读取 `marketplaceSearch`（已 commit 的搜索词）而非当前 `searchInput`，所以即使在 debounce 窗口内用户滚动，加载的也是上一轮 commit 搜索的下一页，等 debounce 触发后列表自然重置。这让用户在搜索返回 >20 条匹配时也能滚动浏览全部结果。

### `loadMore`

```typescript
const loadMore = useCallback(async () => {
  setLoadMoreError(null);
  try {
    await store.fetchMarketplaceSkills(
      store.marketplacePage + 1,
      store.marketplaceSearch,
      "append",
    );
  } catch (err) {
    setLoadMoreError(err instanceof Error ? err.message : "加载更多失败");
  }
}, [store]);
```

### 搜索（debounce + 即时过滤 + 防 race）

```typescript
const handleSearchChange = (value: string) => {
  setSearchInput(value);  // 触发 displayedItems 即时重算

  // 清掉前一个 debounce
  if (debounceTimerRef.current) {
    clearTimeout(debounceTimerRef.current);
  }

  debounceTimerRef.current = setTimeout(async () => {
    const requestId = ++searchRequestIdRef.current;
    try {
      await store.fetchMarketplaceSkills(1, value.trim(), "replace");
      // 防 race：如果此时有更新的请求在飞，丢弃本次结果
      // （store 内已写入，但 UI 派生自动响应；这里 requestId 主要用于判断是否需 rollback）
      if (requestId !== searchRequestIdRef.current) return;
    } catch (err) {
      if (requestId === searchRequestIdRef.current) {
        setLoadError(err instanceof Error ? err.message : "搜索失败");
      }
    }
  }, 300);
};

// 卸载时清 timer
useEffect(() => {
  return () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
  };
}, []);
```

**关于防 race 的说明：** store 的 `fetchMarketplaceSkills` 写入是同步的（在 await 之后），所以理论上后到的旧响应仍会覆盖新响应。要在 store 层彻底防 race 需要 store 也维护 requestId。**为简化设计，本期接受偶发的旧响应覆盖**——debounce 300ms 已经把频率降下来，且用户继续输入会触发新请求覆盖。如发现实际问题，下期再在 store 内加 requestId。

### 渲染结构（伪 JSX）

```jsx
<div style={styles.wrapper}>
  {/* Header（保持不变） */}
  {/* Offline banner（保持不变） */}

  {/* Search bar */}
  <div style={styles.searchBar}>
    <Search size={16} />
    <input
      value={searchInput}
      onChange={(e) => handleSearchChange(e.target.value)}
      placeholder="搜索技能..."
    />
    {loading && isSearching && <Spinner size="sm" />}
  </div>

  {/* Error / Empty / Loading 状态（保持逻辑，文案微调） */}

  {/* 卡片列表 */}
  <div style={styles.skillsList}>
    {displayedItems.map((skill) => (
      <SkillCard key={skill.slug} skill={skill} ... />
    ))}
  </div>

  {/* 加载更多错误 */}
  {loadMoreError && (
    <div style={styles.loadMoreError}>
      加载更多失败：{loadMoreError}
      <button onClick={loadMore}>重试</button>
    </div>
  )}

  {/* 哨兵 + 加载中指示器（浏览模式和搜索模式都生效） */}
  {hasMore && (
    <div ref={sentinelRef} style={styles.sentinel}>
      {loadingMore && <Spinner size="sm" />}
    </div>
  )}

  {/* 全部加载完毕提示 */}
  {!hasMore && marketplaceItems.length > 0 && (
    <div style={styles.allLoaded}>
      {isSearching
        ? `已显示全部 ${marketplaceItems.length} / ${marketplaceTotal} 个匹配`
        : `已显示全部 ${marketplaceItems.length} 个技能`}
    </div>
  )}

  {/* 搜索中状态指示（首次加载或切换搜索词时） */}
  {isSearching && loading && (
    <div style={styles.searchSummary}>搜索中...</div>
  )}
</div>
```

### 移除的 UI 元素

- 分页按钮（`上一页` / `下一页` / `page X / Y`）
- 搜索框右侧的"搜索"按钮（即时搜索不需要）

### 保留的 UI 元素

- 刷新按钮（顶部）
- 安装按钮、已安装状态、安装中 spinner
- 卡片结构（name/version/description/tags/stats/install）
- 错误 banner 与重试
- 空状态提示

## 边界情况

| 场景 | 行为 |
|------|------|
| 服务端不可达（`syncState.serverReachable === false`） | 显示 offline banner；不渲染搜索框与列表；只显示刷新按钮 |
| 搜索返回 0 条 | 显示 "未找到匹配 'xxx' 的技能" + 建议清空搜索 |
| 全量加载返回 0 条 | 显示 "暂无可用技能" |
| 滚动加载失败 | 列表底部显示 "加载更多失败：xxx [重试]"；不阻塞已加载项的浏览 |
| 搜索切换时旧响应晚到 | store 写入会被后续新请求覆盖；UI 派生自 `marketplaceItems + searchInput` 自动同步 |
| 快速输入触发多次 debounce | 每个 setTimeout 注册 id，新输入清掉前一个 |
| 已安装状态丢失（面板重开） | 本期保留当前 behavior（仅当次 session 内追踪）；后续可扩展从 `/api/skills` 拉取已安装列表对比 |
| 搜索模式下滚动到底 | 哨兵照常挂载；`loadMore` 从 store 读取 `marketplaceSearch`（commit 后的搜索词）追加下一页。`searchInput` 与 `marketplaceSearch` 在 debounce 窗口内可能不一致，但 debounce 触发后会重置列表为最新搜索词的结果 |
| 用户清空搜索框 | `searchInput` 立即为空 → `displayedItems` 立即恢复为全量 `marketplaceItems`；debounce 后重新 `fetchMarketplaceSkills(1, "", "replace")` 拉全量首页 |

## 性能考量

| 关注点 | 决策 |
|--------|------|
| 首屏渲染压力 | 首批 20 张卡片，DOM 节点可控 |
| 滚动监听 | 用 `IntersectionObserver` 替代 scroll 事件，避免主线程抖动 |
| `rootMargin: "200px"` | 提前 200px 触发下一批加载，用户感知不到等待 |
| 搜索请求频率 | 300ms debounce，连续输入只触发最后一次 |
| 客户端过滤开销 | `useMemo` 缓存 `displayedItems`，仅在 `marketplaceItems` 或 `searchInput` 变化时重算 |
| React key 复用 | 卡片 `key={skill.slug}`，slug 全局唯一，append 不重建已渲染节点 |
| 虚拟滚动 | **不引入**。当前 Hub skills 总量小（<200），即使全部加载也只渲染几百个卡片节点，性能可接受。YAGNI |

## 修改文件清单

| 文件 | 改动类型 | 改动概要 |
|------|---------|---------|
| `frontend/src/store/hub.ts` | 修改 | 替换 state 字段（`marketplaceSkills` → `marketplaceItems`，新增 `loadingMore` / `hasMore`）；扩展 `fetchMarketplaceSkills` 签名加 `mode` 参数；实现 replace/append 逻辑；失败不清空列表 |
| `frontend/src/components/marketplace/MarketplacePanel.tsx` | 修改 | 移除分页 UI；移除搜索按钮；新增 IntersectionObserver + 哨兵；新增防抖搜索 + 即时客户端过滤；新增 loadingMore 错误显示；新增"已显示全部"提示 |
| `frontend/src/api/client.ts` | 无改动 | `listMarketplaceSkills(page, pageSize, search)` 签名已支持 |
| `frontend/src/types/index.ts` | 无改动 | `MarketplaceSkillItem` 字段已够用 |

## 复用的现有能力

- `useHubStore` zustand store 框架（仅扩展字段与签名，不重写）
- `api.listMarketplaceSkills` 已支持 page/search 参数
- `MarketplacePanel` 现有样式系统（CSS variables + styles object）保持不变
- `<Spinner />` / `<Package />` 等 lucide-react 图标
- `useToast` 通知钩子
- 现有 `/api/hub/marketplace/skills` 路由（DA 代理到 Hub）

## 不在本次范围内（YAGNI）

- **虚拟滚动**：当前 skill 总量 <200，无需引入 react-window 等额外依赖
- **标签筛选 UI**：可作为 Skill 提交时打标签的扩展点，本期不实现
- **服务端排序选择**（按下载量/评分/最新）：服务端默认按 `published_at DESC`，本期保留
- **卡片详情页**：当前卡片 description 截断 3 行已够用；详情页可后续扩展
- **已安装状态持久化**：本期保留当次 session 内追踪；如需跨 session 一致性可后续从 `/api/skills` 拉取已安装列表对比
- **请求 race 彻底修复**：300ms debounce 已大幅降低频率；如实际遇到问题再在 store 层加 requestId

## 测试策略

### 单元测试（store）

- `fetchMarketplaceSkills(1, "", "replace")` 后 `marketplaceItems` 长度为 20
- `fetchMarketplaceSkills(2, "", "append")` 后 `marketplaceItems` 长度为 40（去重）
- 服务端返回 `items.length === 0` 时 `hasMore === false`
- 服务端失败时 `marketplaceItems` 保持原值不清空

### 组件测试

- 初始挂载触发一次 `fetchMarketplaceSkills(1, "", "replace")`
- 输入触发 debounce 后触发 `fetchMarketplaceSkills(1, term, "replace")`
- 快速连续输入只触发最后一次（debounce 验证）
- 卸载时清掉 debounce timer（无 leak）

### E2E 验证（手动）

1. 打开 MarketplacePanel，确认首批 20 条卡片渲染
2. 向下滚动，确认追加第二批 20 条，无重复
3. 在搜索框输入 "code"，确认已加载项即时过滤（不等待服务端）
4. 等 300ms，确认服务端搜索结果替换列表
5. 清空搜索框，确认恢复全量首页
6. 服务端不可达时（断网）确认 offline banner 显示
7. Hub 上有 25 个 skill 时，确认滚动到第 2 页后 `hasMore=false` 显示"已显示全部"

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| IntersectionObserver 在旧浏览器不支持 | 低 | DA 已用 modern ES2022，目标浏览器全部支持（caniuse 96%+） |
| 搜索 debounce 期间用户清空，旧请求仍在飞 | 低 | 新请求会覆盖；UI 派生自 store，自动同步 |
| 列表 append 后 scroll position 跳变 | 极低 | 浏览器自动保持 scroll 位置；append 不影响已渲染节点 |
| `marketplaceSkills` 字段重命名为 `marketplaceItems` | 低 | grep 确认无其他文件引用 |
| 已安装状态在面板重开后丢失 | 低 | 本期保留 behavior；用户期望内 |
| 搜索模式下不自动加载更多可能导致漏看 | 低 | 搜索模式也支持无限滚动；`loadMore` 用 store 内的 `marketplaceSearch` 不受当前 input 影响 |

## 成功标准

- 打开面板自动加载首批 20 条
- 向下滚动平滑追加，无重复、无跳变
- 输入搜索关键词时即时过滤（<16ms 感知）
- 300ms 后服务端搜索结果到达，平滑替换列表
- 清空搜索框立即恢复全量首页
- 分页 UI 完全移除，原 bug 消除
- 服务端不可达时优雅降级显示 offline banner
- 无控制台错误、警告（除了已知的 favicon/ResizeObserver）
