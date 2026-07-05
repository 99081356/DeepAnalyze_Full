# Phase 2 (P1): 模块B — 统一搜索系统

> 返回 [索引](./2026-04-14-system-redesign.md) | 上一步 [Phase 1](./2026-04-14-system-redesign-phase1.md) | 下一步 [Phase 3](./2026-04-14-system-redesign-phase3.md)

---

## Task 6: 统一搜索后端API + 多层级搜索

**文件：** 创建 `src/server/routes/search.ts`，修改 `src/wiki/retriever.ts`

**步骤：**

- [ ] 6.1 在 `src/wiki/retriever.ts` 中添加多层级搜索和关键词高亮功能

在 Retriever 类中添加新方法：

```typescript
// 在 retriever.ts 的 Retriever 类中添加

/** 多层级搜索，返回按层级分组的结果并带关键词高亮 */
async searchByLevels(
  query: string,
  options: {
    kbIds?: string[];
    levels?: Array<"L0" | "L1" | "L2">;
    includeEntities?: boolean;
    limit?: number;
  } = {}
): Promise<{
  results: {
    L0: LeveledSearchResult[];
    L1: LeveledSearchResult[];
    L2: LeveledSearchResult[];
  };
  entities: EntitySearchResult[];
  total: number;
}> {
  const { kbIds = [], levels = ["L0", "L1", "L2"] as const, includeEntities = true, limit = 10 } = options;

  const pageTypeMap: Record<string, string> = {
    L0: "abstract",
    L1: "overview",
    L2: "fulltext",
  };

  const results: Record<string, LeveledSearchResult[]> = { L0: [], L1: [], L2: [] };

  // 按层级并行搜索
  const levelPromises = levels.map(async (level) => {
    const pageType = pageTypeMap[level];
    const raw = await this.search(query, {
      kbIds,
      pageTypes: [pageType],
      topK: limit,
    });

    results[level] = raw.results.map((r: any) => ({
      pageId: r.pageId,
      title: r.title,
      snippet: this.highlightKeywords(r.snippet || r.content?.slice(0, 200) || "", query),
      highlights: this.extractHighlights(r.content || "", query),
      level,
      score: r.score,
      kbId: r.kbId,
      docId: r.docId,
    }));
  });

  await Promise.all(levelPromises);

  // 实体搜索
  let entities: EntitySearchResult[] = [];
  if (includeEntities) {
    const entityResults = await this.search(query, {
      kbIds,
      pageTypes: ["entity"],
      topK: limit,
    });
    entities = entityResults.results.map((r: any) => ({
      name: r.title,
      type: (r.metadata?.entityType as string) || "unknown",
      count: (r.metadata?.mentionCount as number) || 1,
      relatedPages: r.links?.map((l: any) => l.targetPageId) || [],
    }));
  }

  const total = results.L0.length + results.L1.length + results.L2.length + entities.length;
  return { results: results as any, entities, total };
}

/** 关键词高亮：在文本中用 <mark> 标签包裹匹配词 */
private highlightKeywords(text: string, query: string): string {
  if (!text || !query) return text;
  const tokens = query.split(/\s+/).filter(Boolean);
  let result = text;
  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    result = result.replace(regex, "<mark class=\"search-highlight\">$&</mark>");
  }
  // 截断到300字符（在高亮标签之外）
  if (result.length > 400) {
    result = result.slice(0, 400) + "...";
  }
  return result;
}

/** 提取关键词在文中的位置和上下文 */
private extractHighlights(content: string, query: string): Array<{ text: string; position: number }> {
  const highlights: Array<{ text: string; position: number }> = [];
  if (!content || !query) return highlights;

  const tokens = query.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    let match;
    while ((match = regex.exec(content)) !== null && highlights.length < 5) {
      const start = Math.max(0, match.index - 50);
      const end = Math.min(content.length, match.index + token.length + 50);
      highlights.push({
        text: content.slice(start, end),
        position: match.index,
      });
    }
  }
  return highlights;
}
```

在文件顶部添加类型定义：

```typescript
export interface LeveledSearchResult {
  pageId: string;
  title: string;
  snippet: string;
  highlights: Array<{ text: string; position: number }>;
  level: "L0" | "L1" | "L2";
  score: number;
  kbId: string;
  docId?: string;
}

export interface EntitySearchResult {
  name: string;
  type: string;
  count: number;
  relatedPages: string[];
}
```

- [ ] 6.2 创建 `src/server/routes/search.ts`

```typescript
import { Hono } from "hono";
import type { Retriever } from "../../wiki/retriever.js";

export function createSearchRoutes(getRetriever: () => Promise<Retriever>): Hono {
  const app = new Hono();

  // GET /knowledge/:kbId/search — 统一搜索
  app.get("/knowledge/:kbId/search", async (c) => {
    const kbId = c.req.param("kbId");
    const q = c.req.query("q") || "";
    const levelsParam = c.req.query("levels") || "L0,L1,L2";
    const entities = c.req.query("entities") !== "false";
    const limit = parseInt(c.req.query("limit") || "10", 10);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    if (!q.trim()) {
      return c.json({ query: "", results: { L0: [], L1: [], L2: [] }, entities: [], total: 0 });
    }

    const levels = levelsParam.split(",") as Array<"L0" | "L1" | "L2">;
    const retriever = await getRetriever();

    const result = await retriever.searchByLevels(q, {
      kbIds: [kbId],
      levels,
      includeEntities: entities,
      limit,
    });

    return c.json({
      query: q,
      results: result.results,
      entities: result.entities,
      total: result.total,
      offset,
      limit,
    });
  });

  return app;
}
```

- [ ] 6.3 在 `src/server/app.ts` 中挂载搜索路由

```typescript
// 在 app.ts 的路由注册区域添加:
import { createSearchRoutes } from "./routes/search.js";

// 在路由注册处（其他路由之后）:
app.route("/api", createSearchRoutes(async () => {
  const { getRetriever } = await import("../wiki/retriever.js");
  // Retriever 通过 agent-system 初始化
  const { getOrchestrator } = await import("../services/agent/agent-system.js");
  const orch = await getOrchestrator();
  // Orchestrator 持有 runner -> toolRegistry -> retriever 的引用
  // 需要从 agent-system 导出 retriever 或直接创建
  const { DEEPANALYZE_CONFIG } = await import("../core/config.js");
  const { ModelRouter } = await import("../models/router.js");
  const { EmbeddingManager } = await import("../models/embedding.js");
  const { Indexer } = await import("../wiki/indexer.js");
  const { Linker } = await import("../wiki/linker.js");
  const { Retriever } = await import("../wiki/retriever.js");
  // 使用单例模式避免重复初始化
  const linker = new Linker();
  const modelRouter = new ModelRouter();
  await modelRouter.initialize();
  const embMgr = new EmbeddingManager(modelRouter);
  await embMgr.initialize();
  const indexer = new Indexer(embMgr);
  return new Retriever(indexer, linker, embMgr);
}));
```

**优化方案：** 更好的做法是在 `agent-system.ts` 中导出 `getRetriever()` 函数：

```typescript
// 在 agent-system.ts 中添加：
let retrieverInstance: Retriever | null = null;

export async function getRetriever(): Promise<Retriever> {
  if (!retrieverInstance) {
    await getOrchestrator(); // 触发完整初始化
  }
  return retrieverInstance!;
}
```

然后在 `initializeOrchestrator()` 中设置 `retrieverInstance = retriever;`

- [ ] 6.4 验证编译

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] 6.5 提交

```bash
git add src/wiki/retriever.ts src/server/routes/search.ts src/server/app.ts src/services/agent/agent-system.ts && git commit -m "feat(search): add multi-level search API with keyword highlighting"
```

---

## Task 7: 统一搜索前端UI

**文件：** 创建 `frontend/src/components/search/UnifiedSearch.tsx`，创建 `frontend/src/components/search/SearchResultCard.tsx`

**步骤：**

- [ ] 7.1 创建 `frontend/src/components/search/SearchResultCard.tsx`

```typescript
import React from "react";

export interface SearchResultCardProps {
  pageId: string;
  title: string;
  snippet: string; // HTML with <mark> tags
  level: "L0" | "L1" | "L2";
  score: number;
  kbId: string;
  docId?: string;
  onHover?: () => void;
  onLeave?: () => void;
  onClick?: () => void;
}

const levelConfig = {
  L0: { label: "L0 摘要", color: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" },
  L1: { label: "L1 概述", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" },
  L2: { label: "L2 原文", color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400" },
};

export const SearchResultCard: React.FC<SearchResultCardProps> = ({
  title, snippet, level, score, onHover, onLeave, onClick,
}) => {
  const config = levelConfig[level];

  return (
    <div
      className="p-3 border rounded-lg hover:shadow-md transition-shadow cursor-pointer bg-white dark:bg-gray-800 dark:border-gray-700"
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${config.color}`}>
          {config.label}
        </span>
        <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 flex-1 truncate">
          {title}
        </h4>
        <span className="text-xs text-gray-400">{(score * 100).toFixed(0)}%</span>
      </div>
      <div
        className="text-xs text-gray-600 dark:text-gray-400 line-clamp-3"
        dangerouslySetInnerHTML={{ __html: snippet }}
      />
    </div>
  );
};
```

- [ ] 7.2 创建 `frontend/src/components/search/UnifiedSearch.tsx`

```typescript
import React, { useState, useCallback } from "react";
import { SearchResultCard, SearchResultCardProps } from "./SearchResultCard";
import { PreviewCard } from "./PreviewCard";

interface EntityResult {
  name: string;
  type: string;
  count: number;
  relatedPages: string[];
}

type LevelTab = "L0" | "L1" | "L2" | "entities";

interface SearchResults {
  L0: SearchResultCardProps[];
  L1: SearchResultCardProps[];
  L2: SearchResultCardProps[];
  entities: EntityResult[];
}

interface UnifiedSearchProps {
  kbId: string;
}

export const UnifiedSearch: React.FC<UnifiedSearchProps> = ({ kbId }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>({ L0: [], L1: [], L2: [], entities: [] });
  const [activeTab, setActiveTab] = useState<LevelTab>("L0");
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [previewTarget, setPreviewTarget] = useState<SearchResultCardProps | null>(null);
  const [previewPos, setPreviewPos] = useState<{ x: number; y: number } | null>(null);

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/knowledge/${kbId}/search?q=${encodeURIComponent(query)}&levels=L0,L1,L2&entities=true&limit=10`
      );
      const data = await res.json();
      setResults(data.results || { L0: [], L1: [], L2: [] });
      setResults(prev => ({ ...prev, entities: data.entities || [] }));
      setTotal(data.total || 0);
      // 自动选择有结果的第一个tab
      const tabs: LevelTab[] = ["L0", "L1", "L2", "entities"];
      for (const tab of tabs) {
        const count = tab === "entities"
          ? (data.entities || []).length
          : (data.results?.[tab] || []).length;
        if (count > 0) { setActiveTab(tab); break; }
      }
    } catch (err) {
      console.error("Search failed:", err);
    } finally {
      setLoading(false);
    }
  }, [query, kbId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") doSearch();
  };

  const tabs: Array<{ id: LevelTab; label: string; color: string; count: number }> = [
    { id: "L0", label: "L0 摘要", color: "text-green-600", count: results.L0.length },
    { id: "L1", label: "L1 概述", color: "text-blue-600", count: results.L1.length },
    { id: "L2", label: "L2 原文", color: "text-yellow-600", count: results.L2.length },
    { id: "entities", label: "实体", color: "text-purple-600", count: results.entities.length },
  ];

  const currentResults = activeTab === "entities"
    ? []
    : results[activeTab] || [];

  return (
    <div className="flex flex-col h-full">
      {/* 搜索栏 */}
      <div className="flex items-center gap-2 p-3 border-b dark:border-gray-700">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="搜索所有层级..."
          className="flex-1 px-3 py-2 border rounded-lg dark:bg-gray-800 dark:border-gray-600 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={doSearch}
          disabled={loading}
          className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
        >
          {loading ? "搜索中..." : "搜索"}
        </button>
      </div>

      {/* 层级标签 */}
      {total > 0 && (
        <div className="flex gap-1 p-2 border-b dark:border-gray-700">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-1 rounded text-sm ${
                activeTab === tab.id
                  ? `${tab.color} font-bold bg-gray-100 dark:bg-gray-700`
                  : "text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800"
              }`}
            >
              {tab.label} ({tab.count})
            </button>
          ))}
          <span className="ml-auto text-xs text-gray-400 self-center">共 {total} 条</span>
        </div>
      )}

      {/* 结果列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {activeTab === "entities" ? (
          results.entities.map((entity) => (
            <div key={entity.name} className="p-3 border rounded-lg bg-white dark:bg-gray-800 dark:border-gray-700">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded text-xs bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">
                  实体
                </span>
                <span className="font-medium text-sm text-gray-900 dark:text-gray-100">{entity.name}</span>
                <span className="text-xs text-gray-400">{entity.type} · {entity.count}次出现</span>
              </div>
            </div>
          ))
        ) : (
          currentResults.map((r) => (
            <div key={r.pageId} className="relative">
              <SearchResultCard
                {...r}
                onHover={(e) => {
                  setPreviewTarget(r);
                }}
                onLeave={() => {
                  // 延迟清除以允许鼠标移入预览卡片
                  setTimeout(() => setPreviewTarget(null), 300);
                }}
              />
            </div>
          ))
        )}
        {!loading && total === 0 && query && (
          <div className="text-center text-gray-400 py-8">无搜索结果</div>
        )}
      </div>

      {/* 预览卡片（悬停时显示） */}
      {previewTarget && (
        <PreviewCard
          kbId={kbId}
          pageId={previewTarget.pageId}
          title={previewTarget.title}
          level={previewTarget.level}
          query={query}
        />
      )}
    </div>
  );
};
```

- [ ] 7.3 验证编译

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit --project frontend/tsconfig.json 2>&1 | head -20
```

- [ ] 7.4 提交

```bash
git add frontend/src/components/search/SearchResultCard.tsx frontend/src/components/search/UnifiedSearch.tsx && git commit -m "feat(search): add unified search UI with level tabs and entity results"
```

---

## Task 8: 悬停预览卡片 + 层级切换器

**文件：** 创建 `frontend/src/components/search/PreviewCard.tsx`，创建 `frontend/src/components/search/LevelSwitcher.tsx`

**步骤：**

- [ ] 8.1 创建 `frontend/src/components/search/PreviewCard.tsx`

```typescript
import React, { useState, useEffect } from "react";

interface PreviewCardProps {
  kbId: string;
  pageId: string;
  title: string;
  level: "L0" | "L1" | "L2";
  query: string;
}

export const PreviewCard: React.FC<PreviewCardProps> = ({ kbId, pageId, title, level, query }) => {
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [size, setSize] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/knowledge/${kbId}/pages/${pageId}/preview?level=${level}&q=${encodeURIComponent(query)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setContent(data.snippet || data.content?.slice(0, 500) || "无预览内容");
          setSize(data.size || "");
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [kbId, pageId, level, query]);

  const levelLabels = { L0: "L0 摘要", L1: "L1 概述", L2: "L2 原文" };

  return (
    <div className="absolute right-0 top-0 w-80 max-h-64 overflow-y-auto bg-white dark:bg-gray-800 border dark:border-gray-600 rounded-lg shadow-xl z-50 text-sm">
      <div className="flex items-center justify-between p-2 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-750">
        <span className="font-medium truncate text-gray-900 dark:text-gray-100">{title}</span>
        <span className="text-xs text-gray-400">{levelLabels[level]} {size && `· ${size}`}</span>
      </div>
      <div className="p-2">
        {loading ? (
          <div className="text-center py-4 text-gray-400">加载中...</div>
        ) : (
          <div
            className="text-xs text-gray-600 dark:text-gray-400 line-clamp-8"
            dangerouslySetInnerHTML={{ __html: content }}
          />
        )}
      </div>
      <div className="p-2 border-t dark:border-gray-700 text-right">
        <a href={`#/knowledge/${kbId}`} className="text-xs text-blue-500 hover:underline">
          打开完整页面 →
        </a>
      </div>
    </div>
  );
};
```

- [ ] 8.2 创建 `frontend/src/components/search/LevelSwitcher.tsx`

```typescript
import React, { useState, useEffect } from "react";

interface LevelSwitcherProps {
  pageId: string;
  kbId: string;
  currentLevel: "L0" | "L1" | "L2";
  availableLevels: Array<"L0" | "L1" | "L2">;
  onLevelChange: (level: "L0" | "L1" | "L2", content: string) => void;
  keywords?: string[];
}

const levelLabels: Record<string, string> = {
  L0: "L0 摘要",
  L1: "L1 概述",
  L2: "L2 原文",
};

export const LevelSwitcher: React.FC<LevelSwitcherProps> = ({
  pageId, kbId, currentLevel, availableLevels, onLevelChange, keywords,
}) => {
  const [activeLevel, setActiveLevel] = useState(currentLevel);
  const [loading, setLoading] = useState(false);

  // 从 localStorage 恢复默认层级偏好
  useEffect(() => {
    const saved = localStorage.getItem("deepanalyze-default-level") as "L0" | "L1" | "L2" | null;
    if (saved && availableLevels.includes(saved)) {
      handleSwitch(saved);
    }
  }, []); // 仅初始化时

  const handleSwitch = async (level: "L0" | "L1" | "L2") => {
    if (level === activeLevel) return;
    setLoading(true);
    setActiveLevel(level);
    localStorage.setItem("deepanalyze-default-level", level);

    try {
      const res = await fetch(`/api/knowledge/${kbId}/pages/${pageId}?level=${level}`);
      const data = await res.json();
      onLevelChange(level, data.content);
    } catch (err) {
      console.error("Failed to load level:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-1">
      {availableLevels.map((level) => (
        <button
          key={level}
          onClick={() => handleSwitch(level)}
          disabled={loading}
          className={`px-3 py-1 text-xs rounded transition-colors ${
            activeLevel === level
              ? "bg-blue-500 text-white font-medium"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          } disabled:opacity-50`}
        >
          {loading && activeLevel === level ? "..." : levelLabels[level]}
        </button>
      ))}
    </div>
  );
};
```

- [ ] 8.3 在 `src/server/routes/knowledge.ts` 中为页面API添加层级参数支持

在现有的 wiki page 端点中添加 level 查询参数处理：

```typescript
// 修改现有的 GET /knowledge/:kbId/pages/:pageId 路由
// 添加对 ?level=L1 查询参数的支持

// 在路由处理器中：
app.get("/knowledge/:kbId/pages/:pageId", async (c) => {
  const kbId = c.req.param("kbId");
  const pageId = c.req.param("pageId");
  const level = c.req.query("level"); // 新增：可选层级参数

  // ... 现有获取页面的逻辑 ...

  // 如果指定了level，获取对应层级的页面
  if (level) {
    const pageTypeMap: Record<string, string> = { L0: "abstract", L1: "overview", L2: "fulltext" };
    const targetPageType = pageTypeMap[level];

    // 查找同文档的同层级页面
    const linkedPage = db
      .prepare(`
        SELECT p.* FROM wiki_pages p
        JOIN wiki_pages original ON original.id = ?
        WHERE p.doc_id = original.doc_id AND p.page_type = ? AND p.kb_id = ?
      `)
      .get(pageId, targetPageType, kbId);

    if (linkedPage) {
      // 获取该文档所有可用层级
      const availableLevels = db
        .prepare(`
          SELECT DISTINCT
            CASE page_type
              WHEN 'abstract' THEN 'L0'
              WHEN 'overview' THEN 'L1'
              WHEN 'fulltext' THEN 'L2'
            END as level
          FROM wiki_pages WHERE doc_id = ? AND page_type IN ('abstract', 'overview', 'fulltext')
        `)
        .all(linkedPage.doc_id)
        .map((r: any) => r.level)
        .filter(Boolean);

      return c.json({
        ...linkedPage,
        level,
        availableLevels,
        levelMeta: {
          L0: { size: "...", generated: true },
          L1: { size: "...", generated: true },
          L2: { size: "...", generated: false },
        },
      });
    }
  }

  // 原有逻辑...
});

// 添加预览端点
app.get("/knowledge/:kbId/pages/:pageId/preview", async (c) => {
  const kbId = c.req.param("kbId");
  const pageId = c.req.param("pageId");
  const level = c.req.query("level") || "L1";
  const q = c.req.query("q") || "";

  const { getPageContent } = await import("../../store/wiki-pages.js");
  const page = await getPageContent(pageId);

  if (!page) {
    return c.json({ error: "Page not found" }, 404);
  }

  let snippet = page.content.slice(0, 500);
  if (q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      snippet = snippet.replace(new RegExp(escaped, "gi"), "<mark>$&</mark>");
    }
  }

  return c.json({
    pageId,
    title: page.title,
    level,
    size: `${(page.content.length / 1024).toFixed(1)}KB`,
    snippet,
  });
});
```

- [ ] 8.4 验证编译

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] 8.5 提交

```bash
git add frontend/src/components/search/PreviewCard.tsx frontend/src/components/search/LevelSwitcher.tsx src/server/routes/knowledge.ts && git commit -m "feat(search): add hover preview card and reusable level switcher component"
```

---

## Task 9: 知识面板三合一集成

**文件：** 修改 `frontend/src/components/knowledge/KnowledgePanel.tsx`，修改 `src/server/routes/knowledge.ts`

**步骤：**

- [ ] 9.1 重构 `KnowledgePanel.tsx` 的布局为统一搜索优先

```typescript
// KnowledgePanel.tsx 布局重构
// 在现有 import 中添加:
import { UnifiedSearch } from "../search/UnifiedSearch";
import { LevelSwitcher } from "../search/LevelSwitcher";

// 在组件 JSX 中重构布局:
// 新布局结构:
// +--------------------------------------------------+
// | [统一搜索栏 - 始终可见]                            |
// +--------------------------------------------------+
// | L0 (3) | L1 (7) | L2 (9) | Entities (4)          |  <- 搜索结果标签
// +--------------------------------------------------+
// | [搜索结果 / Wiki浏览 / 文档列表]                    |
// |   - 搜索结果带悬停预览                              |
// |   - Wiki区域可展开                                 |
// |   - 每个文档/页面带LevelSwitcher                   |
// +--------------------------------------------------+
```

具体修改：在 KnowledgePanel 中，将原有的 tab 结构（documents / wiki / entities / graph / search / settings）保留，但在顶部始终显示统一搜索栏。搜索结果直接覆盖显示在主内容区。

```tsx
{/* 知识面板顶部 - 统一搜索栏始终可见 */}
<div className="border-b dark:border-gray-700">
  <UnifiedSearch kbId={kbId} />
</div>

{/* 原有 tab 内容区域 */}
<div className="flex-1 overflow-y-auto">
  {activeTab === "documents" && (
    <div>
      {/* 文档列表 + 上传状态（Task 3） + 批量操作 */}
    </div>
  )}
  {activeTab === "wiki" && (
    <div>
      {/* Wiki 浏览，每个页面带 LevelSwitcher */}
      {selectedPage && (
        <LevelSwitcher
          pageId={selectedPage.id}
          kbId={kbId}
          currentLevel="L1"
          availableLevels={["L0", "L1", "L2"]}
          onLevelChange={(level, content) => {
            setPageContent(content);
          }}
        />
      )}
    </div>
  )}
  {/* ... 其他 tab ... */}
</div>
```

- [ ] 9.2 验证编译和UI渲染

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit --project frontend/tsconfig.json 2>&1 | head -20
```

- [ ] 9.3 手动验证搜索、Wiki浏览、LevelSwitcher 功能

- [ ] 9.4 提交

```bash
git add frontend/src/components/knowledge/KnowledgePanel.tsx && git commit -m "feat(knowledge): integrate unified search, level switcher, and wiki browsing"
```

---

**Phase 2 完成。** 继续到 [Phase 3](./2026-04-14-system-redesign-phase3.md)
