# Phase 1 (P0): 模块A — 文件上传 + 状态持久化

> 返回 [索引](./2026-04-14-system-redesign.md) | 下一步 [Phase 2](./2026-04-14-system-redesign-phase2.md)

---

## Task 1: 上传API客户端改进（超时 + 重试）

**文件：** 修改 `frontend/src/api/client.ts`

**步骤：**

- [ ] 1.1 在 `frontend/src/api/client.ts` 中添加 `uploadDocumentWithRetry` 函数

```typescript
// 添加到 frontend/src/api/client.ts 文件末尾（api对象之后导出之前）

export interface UploadResult {
  docId: string;
  kbId: string;
  filename: string;
  status: string;
}

export async function uploadDocumentWithRetry(
  kbId: string,
  file: File,
  opts: {
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
  } = {}
): Promise<UploadResult> {
  const MAX_ATTEMPTS = 3;
  const TIMEOUT_MS = 30_000;
  let attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // 如果外部已取消，直接抛出
    if (opts.signal?.aborted) {
      throw new DOMException("Upload cancelled", "AbortError");
    }
    // 外部取消联动
    opts.signal?.addEventListener("abort", () => controller.abort(), { once: true });

    try {
      return await new Promise<UploadResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `/api/knowledge/${kbId}/documents`);
        xhr.responseType = "json";

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 40); // Upload阶段占0-40%
            opts.onProgress?.(pct);
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(xhr.response as UploadResult);
          } else {
            reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
          }
        };

        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.ontimeout = () => reject(new Error("Upload timed out"));

        const formData = new FormData();
        formData.append("file", file);
        xhr.send(formData);

        // AbortController联动
        controller.signal.addEventListener("abort", () => {
          xhr.abort();
          reject(new DOMException("Upload cancelled", "AbortError"));
        }, { once: true });
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (attempt >= MAX_ATTEMPTS) throw err;
      // 指数退避: 1s, 2s
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error("Unreachable");
}

/** 轮询文档状态（WebSocket断开时的回退方案） */
export async function fetchDocumentStatus(
  kbId: string,
  docId: string
): Promise<{ stage: string; progress: number; error?: string }> {
  const res = await fetch(`/api/knowledge/${kbId}/documents/${docId}/status`);
  if (!res.ok) throw new Error(`Failed to fetch status: ${res.status}`);
  return res.json();
}
```

- [ ] 1.2 验证编译通过

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit --project frontend/tsconfig.json 2>&1 | head -20
```

- [ ] 1.3 提交

```bash
git add frontend/src/api/client.ts && git commit -m "feat(upload): add upload with retry, timeout, and polling fallback"
```

---

## Task 2: 后端上传确认改进 + 文档状态端点

**文件：** 修改 `src/server/routes/knowledge.ts`

**步骤：**

- [ ] 2.1 在 `src/server/routes/knowledge.ts` 中添加文档状态查询端点

在现有路由定义区域（文件中 knowledgeRoutes 对象内部）添加新路由：

```typescript
// 在 knowledgeRoutes 中添加（在已有 doc_delete 路由之后）

// GET /knowledge/:kbId/documents/:docId/status — 文档处理状态轮询端点
app.get("/knowledge/:kbId/documents/:docId/status", async (c) => {
  const kbId = c.req.param("kbId");
  const docId = c.req.param("docId");

  const { DB } = await import("../../store/database.js");
  const db = DB.getInstance().raw;

  const doc = db
    .prepare("SELECT id, filename, status FROM documents WHERE id = ? AND kb_id = ?")
    .get(docId, kbId) as { id: string; filename: string; status: string } | undefined;

  if (!doc) {
    return c.json({ error: "Document not found" }, 404);
  }

  // 映射status到阶段和进度
  const stageMap: Record<string, { stage: string; progress: number }> = {
    uploaded:   { stage: "Parsing",    progress: 45 },
    parsing:    { stage: "Parsing",    progress: 50 },
    compiling:  { stage: "Compiling",  progress: 60 },
    indexing:   { stage: "Indexing",   progress: 75 },
    linking:    { stage: "Linking",    progress: 90 },
    ready:      { stage: "Ready",      progress: 100 },
    error:      { stage: "Error",      progress: 0 },
  };

  const info = stageMap[doc.status] ?? { stage: doc.status, progress: 0 };

  return c.json({
    docId: doc.id,
    filename: doc.filename,
    stage: info.stage,
    progress: info.progress,
    status: doc.status,
  });
});
```

- [ ] 2.2 确认现有上传端点 `POST /knowledge/:kbId/documents` 已返回 `{ docId, kbId, filename, status }` 格式响应（检查现有代码，如果已经返回则无需修改）

- [ ] 2.3 验证编译

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] 2.4 提交

```bash
git add src/server/routes/knowledge.ts && git commit -m "feat(upload): add document status polling endpoint for retry fallback"
```

---

## Task 3: KnowledgePanel非阻塞上传 + 进度阶段 + 批量操作

**文件：** 修改 `frontend/src/components/knowledge/KnowledgePanel.tsx`

**步骤：**

- [ ] 3.1 添加上传状态和批量操作的类型定义（在文件顶部import区域之后）

```typescript
// 上传状态跟踪
interface UploadState {
  docId: string;
  filename: string;
  stage: string;
  progress: number;
  error?: string;
  retrying?: boolean;
}
```

- [ ] 3.2 在组件中添加上传状态管理和批量选择逻辑

在组件函数体内添加：

```typescript
// 上传状态
const [uploads, setUploads] = useState<UploadState[]>([]);
const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
const [wsConnected, setWsConnected] = useState(true);

// 非阻塞上传处理
const handleFiles = async (files: FileList) => {
  for (const file of Array.from(files)) {
    const tempId = `temp-${Date.now()}-${file.name}`;
    setUploads(prev => [...prev, { docId: tempId, filename: file.name, stage: "Upload", progress: 0 }]);

    uploadDocumentWithRetry(kbId, file, {
      onProgress: (pct) => {
        setUploads(prev => prev.map(u =>
          u.docId === tempId ? { ...u, progress: pct } : u
        ));
      },
    })
      .then((result) => {
        setUploads(prev => prev.map(u =>
          u.docId === tempId
            ? { ...u, docId: result.docId, stage: "Parsing", progress: 45 }
            : u
        ));
        // 刷新文档列表
        refreshDocuments();
      })
      .catch((err) => {
        setUploads(prev => prev.map(u =>
          u.docId === tempId
            ? { ...u, stage: "Error", progress: 0, error: err.message }
            : u
        ));
      });
  }
};

// WebSocket断开时的轮询回退
useEffect(() => {
  if (!wsConnected) {
    const interval = setInterval(async () => {
      for (const upload of uploads) {
        if (upload.stage !== "Ready" && upload.stage !== "Error" && !upload.docId.startsWith("temp-")) {
          try {
            const status = await fetchDocumentStatus(kbId, upload.docId);
            setUploads(prev => prev.map(u =>
              u.docId === upload.docId
                ? { ...u, stage: status.stage, progress: status.progress, error: status.error }
                : u
            ));
            if (status.stage === "Ready" || status.stage === "Error") {
              refreshDocuments();
            }
          } catch { /* ignore polling errors */ }
        }
      }
    }, 3000);
    return () => clearInterval(interval);
  }
}, [wsConnected, uploads, kbId]);

// 批量操作
const toggleSelect = (docId: string) => {
  setSelectedDocs(prev => {
    const next = new Set(prev);
    if (next.has(docId)) next.delete(docId);
    else next.add(docId);
    return next;
  });
};

const selectAll = () => {
  setSelectedDocs(new Set(documents.map(d => d.id)));
};

const deselectAll = () => {
  setSelectedDocs(new Set());
};

const batchDelete = async () => {
  const confirmed = await showConfirm({
    title: "批量删除",
    message: `确定删除 ${selectedDocs.size} 个文档？此操作不可撤销。`,
    confirmLabel: "删除",
    variant: "danger",
  });
  if (!confirmed) return;

  for (const docId of selectedDocs) {
    await api.delete(`/api/knowledge/${kbId}/documents/${docId}`);
  }
  setSelectedDocs(new Set());
  refreshDocuments();
};

const retryFailed = async (docId: string) => {
  setUploads(prev => prev.map(u =>
    u.docId === docId ? { ...u, stage: "Retrying", progress: 0, error: undefined, retrying: true } : u
  ));
  // 重新触发处理管道
  await api.post(`/api/knowledge/${kbId}/documents/${docId}/reprocess`);
};
```

- [ ] 3.3 在JSX中添加批量操作工具栏和状态指示器

在文档列表上方添加：

```tsx
{/* 批量操作工具栏 */}
{selectedDocs.size > 0 && (
  <div className="flex items-center gap-2 p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg mb-2">
    <span className="text-sm text-blue-700 dark:text-blue-300">
      已选择 {selectedDocs.size} 个文档
    </span>
    <button onClick={batchDelete} className="px-3 py-1 text-sm bg-red-500 text-white rounded hover:bg-red-600">
      批量删除
    </button>
    <button onClick={deselectAll} className="px-3 py-1 text-sm bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300">
      取消选择
    </button>
  </div>
)}

{/* 选择控制 */}
<div className="flex items-center gap-2 mb-2">
  <input
    type="checkbox"
    checked={selectedDocs.size === documents.length && documents.length > 0}
    onChange={() => selectedDocs.size === documents.length ? deselectAll() : selectAll()}
  />
  <span className="text-xs text-gray-500">全选</span>
</div>
```

每个文档行添加复选框和状态指示：

```tsx
{/* 文档行内：复选框 */}
<input type="checkbox" checked={selectedDocs.has(doc.id)} onChange={() => toggleSelect(doc.id)} />

{/* 文档行内：状态指示器 */}
{doc.status === "ready" && <span className="text-green-500">✓</span>}
{doc.status === "error" && (
  <button onClick={() => retryFailed(doc.id)} className="text-red-500 hover:text-red-700">
    ⟳ 重试
  </button>
)}
{["parsing","compiling","indexing","linking"].includes(doc.status) && (
  <span className="text-blue-500 animate-spin">⏳</span>
)}
```

- [ ] 3.4 验证编译

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit --project frontend/tsconfig.json 2>&1 | head -20
```

- [ ] 3.5 提交

```bash
git add frontend/src/components/knowledge/KnowledgePanel.tsx && git commit -m "feat(knowledge): non-blocking upload with progress stages and batch operations"
```

---

## Task 4: URL路由系统

**文件：** 创建 `frontend/src/router.tsx`，修改 `frontend/src/App.tsx`

**步骤：**

- [ ] 4.1 安装 react-router-dom

```bash
cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npm install react-router-dom@6
```

- [ ] 4.2 创建 `frontend/src/router.tsx`

```typescript
import { createHashRouter, Navigate } from "react-router-dom";
import { lazy, Suspense } from "react";

// 懒加载视图
const ChatWindow = lazy(() => import("./components/ChatWindow"));
const KnowledgePanel = lazy(() => import("./components/knowledge/KnowledgePanel"));
const ReportPanel = lazy(() => import("./components/ReportPanel"));
const TaskPanel = lazy(() => import("./components/TaskPanel"));

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
    </div>
  );
}

function withSuspense(Component: React.LazyExoticComponent<React.ComponentType>) {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <Component />
    </Suspense>
  );
}

export const router = createHashRouter([
  {
    path: "/chat",
    element: withSuspense(ChatWindow),
  },
  {
    path: "/knowledge/:kbId",
    element: withSuspense(KnowledgePanel),
  },
  {
    path: "/knowledge/:kbId/search",
    element: withSuspense(KnowledgePanel),
  },
  {
    path: "/reports",
    element: withSuspense(ReportPanel),
  },
  {
    path: "/reports/:reportId",
    element: withSuspense(ReportPanel),
  },
  {
    path: "/tasks",
    element: withSuspense(TaskPanel),
  },
  {
    path: "/sessions/:sessionId",
    element: withSuspense(ChatWindow),
  },
  {
    path: "/",
    element: <Navigate to="/chat" replace />,
  },
]);
```

- [ ] 4.3 修改 `frontend/src/App.tsx` — 用 RouterProvider 替换 ViewRouter

```typescript
// 替换 App.tsx 中的 ViewRouter 为路由版本
// 在 App.tsx 中:
// 1. 删除 ViewRouter 组件
// 2. 导入 RouterProvider 和 router
// 3. 在 return JSX 中用 <RouterProvider router={router} /> 替换 <ViewRouter />

import { RouterProvider } from "react-router-dom";
import { router } from "./router";

// ... 在 App 组件的 return 中:
// return (
//   <div className={containerClasses}>
//     <Sidebar />
//     <main className="flex-1 overflow-hidden">
//       <RouterProvider router={router} />
//     </main>
//     <RightPanel />
//   </div>
// );
```

**注意：** 需要同时保留 `useUIStore.setActiveView` 的调用，在路由变化时同步更新 Zustand store。具体做法是在各视图组件的 `useEffect` 中调用 `setActiveView`。

- [ ] 4.4 在 `frontend/src/store/ui.ts` 中添加路由同步辅助函数

```typescript
// 在 ui.ts store 中添加 URL 同步函数

// 在 create<UIState>(...) 的 store 定义内部添加:
syncToUrl: (view: ViewId, params?: Record<string, string>) => {
  const routes: Record<ViewId, string> = {
    chat: "/chat",
    knowledge: `/knowledge/${params?.kbId || ""}`,
    reports: "/reports",
    tasks: "/tasks",
  };
  // 使用 hash 路由
  window.location.hash = routes[view];
},
```

- [ ] 4.5 验证编译和运行

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit --project frontend/tsconfig.json 2>&1 | head -20
```

- [ ] 4.6 提交

```bash
git add frontend/src/router.tsx frontend/src/App.tsx frontend/src/store/ui.ts frontend/package.json frontend/package-lock.json && git commit -m "feat(routing): add hash-based URL routing with react-router"
```

---

## Task 5: localStorage状态持久化

**文件：** 修改 `frontend/src/store/ui.ts`，修改 `frontend/src/store/chat.ts`

**步骤：**

- [ ] 5.1 在 `frontend/src/store/ui.ts` 中添加 localStorage 持久化

在 store 的 `set` 和 `get` 中间件化，添加 localStorage 读写：

```typescript
// 在 ui.ts 的 create() 调用中，增强以下函数:

setThemeMode: (mode) => {
  localStorage.setItem("deepanalyze-theme", mode);
  set((s) => {
    const resolved = resolveTheme(mode);
    applyTheme(resolved);
    return { themeMode: mode, resolvedTheme: resolved };
  });
},

setActiveView: (view) => {
  set({ activeView: view });
},

setCurrentKbId: (id) => {
  localStorage.setItem("deepanalyze-kb", id);
  set({ currentKbId: id });
},

toggleSidebar: () => {
  set((s) => {
    const next = !s.sidebarCollapsed;
    localStorage.setItem("deepanalyze-sidebar", String(next));
    return { sidebarCollapsed: next };
  });
},
```

在 store 初始化时恢复 localStorage：

```typescript
// 在 store 创建时初始化
const savedTheme = (localStorage.getItem("deepanalyze-theme") as ThemeMode) || "system";
const savedSidebar = localStorage.getItem("deepanalyze-sidebar") !== "false";
const savedKb = localStorage.getItem("deepanalyze-kb") || "";

// ... 在 create<UIState>() 的初始 state 中使用这些值:
// themeMode: savedTheme,
// resolvedTheme: resolveTheme(savedTheme),
// sidebarCollapsed: savedSidebar,
// currentKbId: savedKb,
```

- [ ] 5.2 在 `frontend/src/store/chat.ts` 中持久化当前会话ID

```typescript
// 在 chat.ts 的 setCurrentSession 或类似函数中:

// 保存当前会话ID到 localStorage
setCurrentSession: (sessionId: string) => {
  localStorage.setItem("deepanalyze-session", sessionId);
  set({ currentSessionId: sessionId });
},

// 在 store 初始化时恢复:
const savedSession = localStorage.getItem("deepanalyze-session") || "";
// ... 在初始 state 中使用:
// currentSessionId: savedSession,
```

- [ ] 5.3 添加页面刷新时的恢复流程

在 `App.tsx` 中添加初始化逻辑：

```typescript
// App.tsx 组件内的 useEffect
useEffect(() => {
  // 从 localStorage 恢复 scope
  const savedScope = localStorage.getItem("deepanalyze-scope");
  if (savedScope) {
    try {
      useChatStore.getState().setScope(JSON.parse(savedScope));
    } catch { /* ignore */ }
  }
}, []);
```

- [ ] 5.4 验证编译

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit --project frontend/tsconfig.json 2>&1 | head -20
```

- [ ] 5.5 手动验证：刷新页面后检查主题、侧边栏状态、知识库选择是否保持

- [ ] 5.6 提交

```bash
git add frontend/src/store/ui.ts frontend/src/store/chat.ts frontend/src/App.tsx && git commit -m "feat(persistence): add localStorage sync for theme, sidebar, kb, session, and scope"
```

---

**Phase 1 完成。** 继续到 [Phase 2](./2026-04-14-system-redesign-phase2.md)
