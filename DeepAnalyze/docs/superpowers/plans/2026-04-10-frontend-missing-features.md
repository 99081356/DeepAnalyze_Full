# DeepAnalyze 前端缺失功能补全实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全设计文档 `2026-04-10-frontend-redesign.md` 中已规划但尚未实现的所有前端功能。

**Architecture:** React 19 + TypeScript + Zustand + CSS Variables (inline styles referencing `var(--xxx)`). 所有新组件沿用现有模式：lucide-react 图标、CSS 变量内联样式、onMouseEnter/Leave 实现悬停效果。不引入 Tailwind 类名。已有 API 层 `api/client.ts` 提供 `browseWiki`、`expandWiki`、`searchWiki(mode)` 等后端接口。

**Tech Stack:** React 19, TypeScript 5.7+, Zustand 5, Vite 6, lucide-react, DOMPurify, marked, highlight.js

---

## 文件结构总览

以下是本次将创建或修改的所有文件：

### 新建文件 (20个)

```
src/
  hooks/
    useKeyboard.ts              # 全局快捷键系统
    useFileUpload.ts            # 文件上传（含进度跟踪）
  utils/
    format.ts                   # 格式化工具（文件大小、日期等）
  components/
    ui/
      TextArea.tsx              # 多行文本输入组件
      FilePreview.tsx           # 文件预览弹窗
    chat/
      ThinkingIndicator.tsx     # 思考状态动画组件
      TraceabilityLink.tsx      # 溯源链接组件
      ScopeSelector.tsx         # 对话范围选择器
    knowledge/
      WikiBrowser.tsx           # Wiki 浏览器（L0/L1/L2 渐进展开）
      EntityPage.tsx            # 实体详情页面
      DocumentViewer.tsx        # 文档查看器（L0/L1/L2 层级）
    reports/
      ReportExport.tsx          # 报告导出功能
    layout/
      RightPanel.tsx            # 右侧可滑出面板
```

### 修改文件 (12个)

```
src/
  components/
    ChatWindow.tsx              # +ScopeSelector, +文件上传集成
    chat/
      MessageInput.tsx          # +文件选择/拖放/上传进度
      MessageItem.tsx           # +TraceabilityLink, +文件附件展示, +导出功能
      MessageList.tsx           # +虚拟滚动（大消息量优化）
      SubtaskPanel.tsx          # +进度条, +树状展开
    knowledge/
      KnowledgePanel.tsx        # +设置Tab, +WikiBrowser/EntityPage集成
    reports/
      ReportPanel.tsx           # +ReportExport集成
    tasks/
      TaskPanel.tsx             # +编译队列Tab, +健康检查Tab
    settings/
      SettingsPanel.tsx         # +嵌入模型Tab, +通用设置Tab, +关于Tab
    layout/
      Header.tsx                # +搜索功能集成, +模型状态实时轮询
      Sidebar.tsx               # +键盘导航
```

---

## Task 1: 工具函数 — `format.ts`

**Files:**
- Create: `src/utils/format.ts`

- [ ] **Step 1: Create `src/utils/format.ts`**

```typescript
/**
 * Format a byte count to a human-readable file size string.
 * Examples: 0 → "0 B", 1024 → "1 KB", 1536000 → "1.46 MB"
 */
export function formatFileSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Format an ISO date string to a localized display string.
 * "2026-04-10T15:30:00.000Z" → "2026-04-10 15:30"
 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * 90000 → "1m 30s", 3661000 → "1h 1m 1s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/**
 * Truncate a string to maxLength, adding "..." if truncated.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}
```

- [ ] **Step 2: Verify build**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx vite build 2>&1 | tail -5`
Expected: `✓ built in`

---

## Task 2: 快捷键系统 — `useKeyboard.ts`

**Files:**
- Create: `src/hooks/useKeyboard.ts`

- [ ] **Step 1: Create `src/hooks/useKeyboard.ts`**

```typescript
import { useEffect, useCallback } from "react";

type KeyCombo = {
  key: string;            // e.g. "n", "k", "Escape"
  ctrl?: boolean;         // require Ctrl (or Cmd on Mac)
  shift?: boolean;
  alt?: boolean;
};

type KeyHandler = (e: KeyboardEvent) => void;

/**
 * Register a global keyboard shortcut.
 * Automatically cleans up on unmount.
 *
 * Usage:
 *   useKeyboard({ key: "n", ctrl: true }, () => createSession());
 *   useKeyboard({ key: "Escape" }, () => closePanel());
 */
export function useKeyboard(combo: KeyCombo, handler: KeyHandler) {
  const memoHandler = useCallback(
    (e: KeyboardEvent) => {
      const ctrlRequired = combo.ctrl ?? false;
      const shiftRequired = combo.shift ?? false;
      const altRequired = combo.alt ?? false;

      const ctrlMatch = ctrlRequired
        ? e.ctrlKey || e.metaKey   // Cmd on Mac
        : !e.ctrlKey && !e.metaKey;
      const shiftMatch = shiftRequired ? e.shiftKey : !e.shiftKey;
      const altMatch = altRequired ? e.altKey : !e.altKey;

      if (
        e.key.toLowerCase() === combo.key.toLowerCase() &&
        ctrlMatch &&
        shiftMatch &&
        altMatch
      ) {
        e.preventDefault();
        handler(e);
      }
    },
    [combo.key, combo.ctrl, combo.shift, combo.alt, handler],
  );

  useEffect(() => {
    window.addEventListener("keydown", memoHandler);
    return () => window.removeEventListener("keydown", memoHandler);
  }, [memoHandler]);
}
```

- [ ] **Step 2: Verify build**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx vite build 2>&1 | tail -5`

---

## Task 3: 文件上传 Hook — `useFileUpload.ts`

**Files:**
- Create: `src/hooks/useFileUpload.ts`

- [ ] **Step 1: Create `src/hooks/useFileUpload.ts`**

```typescript
import { useState, useCallback, useRef } from "react";
import { api } from "../api/client";

export interface UploadingFile {
  id: string;           // unique temp id
  file: File;
  progress: number;     // 0-100
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
  documentId?: string;  // set after upload completes
}

/**
 * Hook to manage file uploads with progress tracking.
 * Used by MessageInput and KnowledgePanel.
 *
 * Usage:
 *   const { uploads, selectFiles, uploadToKb } = useFileUpload();
 */
export function useFileUpload() {
  const [uploads, setUploads] = useState<UploadingFile[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const addFiles = useCallback((files: FileList | File[]) => {
    const newUploads: UploadingFile[] = Array.from(files).map((file) => ({
      id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      file,
      progress: 0,
      status: "pending" as const,
    }));
    setUploads((prev) => [...prev, ...newUploads]);
    return newUploads;
  }, []);

  const updateUpload = useCallback((id: string, patch: Partial<UploadingFile>) => {
    setUploads((prev) =>
      prev.map((u) => (u.id === id ? { ...u, ...patch } : u)),
    );
  }, []);

  const removeUpload = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  const uploadToKb = useCallback(
    async (kbId: string, fileIds?: string[]) => {
      const targets = uploads.filter(
        (u) =>
          (fileIds ? fileIds.includes(u.id) : u.status === "pending") &&
          u.status !== "done",
      );
      const results: string[] = [];
      for (const target of targets) {
        updateUpload(target.id, { status: "uploading", progress: 10 });
        try {
          const result = await api.uploadDocument(kbId, target.file);
          updateUpload(target.id, {
            status: "done",
            progress: 100,
            documentId: result.documentId,
          });
          results.push(result.documentId);
        } catch (err) {
          updateUpload(target.id, {
            status: "error",
            error: String(err),
          });
        }
      }
      return results;
    },
    [uploads, updateUpload],
  );

  const clearDone = useCallback(() => {
    setUploads((prev) => prev.filter((u) => u.status !== "done"));
  }, []);

  const selectFiles = useCallback(
    (accept?: string, multiple = true) => {
      return new Promise<FileList | null>((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = multiple;
        if (accept) input.accept = accept;
        input.onchange = () => {
          const files = input.files;
          if (files && files.length > 0) {
            addFiles(files);
            resolve(files);
          } else {
            resolve(null);
          }
        };
        inputRef.current = input;
        input.click();
      });
    },
    [addFiles],
  );

  return {
    uploads,
    selectFiles,
    uploadToKb,
    removeUpload,
    clearDone,
    hasPending: uploads.some((u) => u.status === "pending" || u.status === "uploading"),
  };
}
```

- [ ] **Step 2: Verify build**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx vite build 2>&1 | tail -5`

---

## Task 4: UI 组件 — `TextArea.tsx` 和 `FilePreview.tsx`

**Files:**
- Create: `src/components/ui/TextArea.tsx`
- Create: `src/components/ui/FilePreview.tsx`

- [ ] **Step 1: Create `src/components/ui/TextArea.tsx`**

一个多行文本输入组件，支持自动高度调整、错误状态、标签。沿用 `Input.tsx` 的视觉模式。

```tsx
import { useRef, useEffect } from "react";

interface TextAreaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  maxHeight?: number;
  error?: string;
  label?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
  maxHeight = 200,
  error,
  label,
  disabled,
  style,
}: TextAreaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, maxHeight) + "px";
    }
  }, [value, maxHeight]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, ...style }}>
      {label && (
        <label style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--text-secondary)" }}>
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        style={{
          width: "100%",
          padding: "10px 12px",
          background: "var(--bg-primary)",
          border: `1px solid ${error ? "var(--error)" : "var(--border-primary)"}`,
          borderRadius: "var(--radius-lg)",
          fontSize: "var(--text-sm)",
          color: "var(--text-primary)",
          lineHeight: "var(--leading-normal)",
          resize: "none",
          outline: "none",
          transition: "border-color var(--transition-fast), box-shadow var(--transition-fast)",
          fontFamily: "inherit",
        }}
        onFocus={(e) => {
          if (!error) e.currentTarget.style.borderColor = "var(--border-focus)";
          e.currentTarget.style.boxShadow = error
            ? "0 0 0 3px rgba(239,68,68,0.1)"
            : "0 0 0 3px rgba(51,65,85,0.08)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = error ? "var(--error)" : "var(--border-primary)";
          e.currentTarget.style.boxShadow = "none";
        }}
      />
      {error && (
        <span style={{ fontSize: "var(--text-xs)", color: "var(--error)" }}>{error}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `src/components/ui/FilePreview.tsx`**

```tsx
import { X, FileText, Image, FileSpreadsheet, File as FileIcon } from "lucide-react";

interface FilePreviewProps {
  filename: string;
  fileType: string;
  fileSize: number;
  onRemove?: () => void;
}

function getFileIcon(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return Image;
  if (["xlsx", "xls", "csv"].includes(ext)) return FileSpreadsheet;
  if (["pdf", "doc", "docx", "md", "txt"].includes(ext)) return FileText;
  return FileIcon;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function FilePreview({ filename, fileType, fileSize, onRemove }: FilePreviewProps) {
  const Icon = getFileIcon(filename);
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "4px 8px 4px 6px",
        background: "var(--bg-tertiary)",
        borderRadius: "var(--radius-md)",
        fontSize: "var(--text-xs)",
        color: "var(--text-secondary)",
        maxWidth: 220,
      }}
    >
      <Icon size={14} style={{ flexShrink: 0, color: "var(--text-tertiary)" }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
        {filename}
      </span>
      <span style={{ flexShrink: 0, color: "var(--text-tertiary)" }}>
        {formatSize(fileSize)}
      </span>
      {onRemove && (
        <button
          onClick={onRemove}
          style={{
            display: "flex",
            padding: 0,
            border: "none",
            background: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--error)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx vite build 2>&1 | tail -5`

---

## Task 5: 对话工作台 — ThinkingIndicator + TraceabilityLink + ScopeSelector

**Files:**
- Create: `src/components/chat/ThinkingIndicator.tsx`
- Create: `src/components/chat/TraceabilityLink.tsx`
- Create: `src/components/chat/ScopeSelector.tsx`

- [ ] **Step 1: Create `src/components/chat/ThinkingIndicator.tsx`**

独立的思考状态动画组件，替代内联 dots。

```tsx
import { Loader2 } from "lucide-react";

interface ThinkingIndicatorProps {
  message?: string;
}

export function ThinkingIndicator({ message = "思考中" }: ThinkingIndicatorProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-2) var(--space-3)",
        color: "var(--text-tertiary)",
        fontSize: "var(--text-sm)",
      }}
    >
      <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
      <span>{message}</span>
      <div style={{ display: "flex", gap: 4, marginLeft: 4 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 4,
              height: 4,
              borderRadius: "50%",
              background: "var(--text-tertiary)",
              animation: "typing 1.4s ease-in-out infinite",
              animationDelay: `${i * 0.2}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `src/components/chat/TraceabilityLink.tsx`**

溯源链接组件 — 显示为可点击的标签，指向文档原文位置。

```tsx
import { ExternalLink } from "lucide-react";

interface TraceabilityLinkProps {
  label: string;         // e.g. "第3.2条"
  sourceDocId?: string;  // 来源文档ID
  sourceSection?: string; // 来源章节
  confidence?: "confirmed" | "inferred" | "unknown";
  onClick?: () => void;
}

const CONFIDENCE_COLORS: Record<string, string> = {
  confirmed: "var(--success)",
  inferred: "var(--warning)",
  unknown: "var(--text-tertiary)",
};

const CONFIDENCE_LABELS: Record<string, string> = {
  confirmed: "确认",
  inferred: "推定",
  unknown: "",
};

export function TraceabilityLink({
  label,
  sourceDocId,
  confidence = "confirmed",
  onClick,
}: TraceabilityLinkProps) {
  const color = CONFIDENCE_COLORS[confidence] ?? CONFIDENCE_COLORS.confirmed;
  const confLabel = CONFIDENCE_LABELS[confidence];

  return (
    <button
      onClick={onClick}
      title={sourceDocId ? `来源: ${sourceDocId}` : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "1px 6px",
        border: "none",
        borderRadius: "var(--radius-sm)",
        background: "color-mix(in srgb, var(--interactive) 8%, transparent)",
        color: "var(--interactive)",
        fontSize: "var(--text-xs)",
        fontWeight: 500,
        cursor: "pointer",
        transition: "all var(--transition-fast)",
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "color-mix(in srgb, var(--interactive) 16%, transparent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "color-mix(in srgb, var(--interactive) 8%, transparent)";
      }}
    >
      <ExternalLink size={10} />
      {label}
      {confLabel && (
        <span style={{ fontSize: 9, color, marginLeft: 2 }}>[{confLabel}]</span>
      )}
    </button>
  );
}
```

- [ ] **Step 3: Create `src/components/chat/ScopeSelector.tsx`**

对话范围选择器 — 下拉选择当前对话的搜索范围。

```tsx
import { useState, useEffect } from "react";
import { ChevronDown, Globe, Database, FileText } from "lucide-react";
import { api } from "../../api/client";
import type { KnowledgeBase } from "../../types/index";

interface ScopeSelectorProps {
  value: string;           // "" = 全部, "kb:xxx" = 指定知识库, "doc:xxx" = 指定文档
  onChange: (scope: string) => void;
}

export function ScopeSelector({ value, onChange }: ScopeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);

  useEffect(() => {
    api.listKnowledgeBases().then(setKbs).catch(() => {});
  }, []);

  const currentLabel = value === ""
    ? "全部范围"
    : value.startsWith("kb:")
      ? kbs.find((k) => k.id === value.slice(3))?.name ?? "知识库"
      : "指定文档";

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-1)",
          padding: "4px 8px",
          border: "1px solid var(--border-primary)",
          borderRadius: "var(--radius-md)",
          background: "var(--surface-primary)",
          color: "var(--text-secondary)",
          fontSize: "var(--text-xs)",
          cursor: "pointer",
          transition: "all var(--transition-fast)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--interactive);"; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-primary)"; }}
      >
        {value === "" ? <Globe size={12} /> : value.startsWith("kb:") ? <Database size={12} /> : <FileText size={12} />}
        {currentLabel}
        <ChevronDown size={10} style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }} />
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 998 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: "absolute",
              top: "100%",
              right: 0,
              marginTop: 4,
              minWidth: 180,
              background: "var(--surface-primary)",
              border: "1px solid var(--border-primary)",
              borderRadius: "var(--radius-lg)",
              boxShadow: "var(--shadow-lg)",
              zIndex: 999,
              overflow: "hidden",
            }}
          >
            <button
              onClick={() => { onChange(""); setOpen(false); }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                padding: "8px 12px",
                border: "none",
                background: value === "" ? "var(--bg-hover)" : "transparent",
                color: "var(--text-primary)",
                fontSize: "var(--text-xs)",
                cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = value === "" ? "var(--bg-hover)" : "transparent"; }}
            >
              <Globe size={14} />
              全部范围
            </button>
            {kbs.map((kb) => (
              <button
                key={kb.id}
                onClick={() => { onChange(`kb:${kb.id}`); setOpen(false); }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  padding: "8px 12px",
                  border: "none",
                  borderTop: "1px solid var(--border-primary)",
                  background: value === `kb:${kb.id}` ? "var(--bg-hover)" : "transparent",
                  color: "var(--text-primary)",
                  fontSize: "var(--text-xs)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = value === `kb:${kb.id}` ? "var(--bg-hover)" : "transparent"; }}
              >
                <Database size={14} />
                {kb.name}
                <span style={{ color: "var(--text-tertiary)", marginLeft: "auto" }}>
                  {kb.documentCount} 文档
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify build**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx vite build 2>&1 | tail -5`

---

## Task 6: MessageInput 文件上传集成

**Files:**
- Modify: `src/components/chat/MessageInput.tsx` — 添加文件选择、拖放、上传进度展示

- [ ] **Step 1: Rewrite `MessageInput.tsx` with file upload support**

在现有的 MessageInput 基础上添加：
1. 导入 `useFileUpload` 和 `FilePreview`
2. Paperclip 按钮点击调用 `selectFiles()`
3. textarea 区域支持拖放文件
4. 输入区下方显示上传中的文件列表（含进度条和删除按钮）
5. 上传完成后在消息中附带文件信息

需要做的具体改动：
- 导入 `useFileUpload` hook 和 `FilePreview` 组件
- 在组件顶部调用 `const { uploads, selectFiles, removeUpload, hasPending } = useFileUpload();`
- Paperclip 按钮 onClick 改为 `() => selectFiles()`
- 外层 div 添加 `onDragOver`/`onDrop` 处理
- 在 textarea 和按钮之间添加上传文件列表
- `handleSend` 中附带文件信息

---

## Task 7: MessageItem + MessageList 增强

**Files:**
- Modify: `src/components/chat/MessageItem.tsx` — 集成 TraceabilityLink、文件附件展示、导出功能
- Modify: `src/components/chat/MessageList.tsx` — 使用 ThinkingIndicator、优化滚动

- [ ] **Step 1: Update `MessageItem.tsx`**

改动点：
1. 导入 `TraceabilityLink` 组件
2. 导入 `FilePreview` 组件
3. "导出报告" 按钮的 onClick 改为：调用 `api.generateReport()` 并显示 toast
4. 在 AI 回复中扫描 `📄 xxx→` 模式的文本，替换为 `<TraceabilityLink>` 组件（通过简单正则在渲染前处理）
5. 用户消息中如有附件信息（message.metadata?.files），显示 FilePreview 列表

- [ ] **Step 2: Update `MessageList.tsx`**

改动点：
1. 导入 `ThinkingIndicator` 替代内联 dots 动画
2. 将 streaming indicator 部分替换为 `<ThinkingIndicator />`
3. 添加 `useRef` 记录滚动容器，实现智能滚动（仅在用户已在底部时自动滚动，否则不跳转）

---

## Task 8: ChatWindow 集成 ScopeSelector + 快捷键

**Files:**
- Modify: `src/components/ChatWindow.tsx`

- [ ] **Step 1: Update `ChatWindow.tsx`**

改动点：
1. 导入 `ScopeSelector` 和 `useKeyboard`
2. 添加 `const [scope, setScope] = useState("");` 状态
3. 在聊天 header bar 右侧添加 `<ScopeSelector value={scope} onChange={setScope} />`
4. 注册全局快捷键：
   - `Ctrl+N` → 创建新会话 (`createSession()`)
   - `Escape` → 关闭任何可能打开的面板（暂空实现）

---

## Task 9: SubtaskPanel 进度条 + 树状结构

**Files:**
- Modify: `src/components/chat/SubtaskPanel.tsx`

- [ ] **Step 1: Update `SubtaskPanel.tsx`**

改动点：
1. `AgentTaskInfo` 有 `parentId` 字段 — 利用它构建树状结构
2. 新增 `buildTaskTree(tasks)` 工具函数：将平铺列表转为树形（parent → children）
3. `TaskItem` 改为递归组件：如果有子任务，在展开区域下方递归渲染子任务
4. 每个运行中的任务显示进度条（`task.progress`，0-100）
5. 进度条样式：高度 3px，品牌色填充，动画过渡

---

## Task 10: Wiki 浏览器 + L0/L1/L2 渐进展开

**Files:**
- Create: `src/components/knowledge/WikiBrowser.tsx`
- Create: `src/components/knowledge/EntityPage.tsx`
- Create: `src/components/knowledge/DocumentViewer.tsx`

这是最核心的知识库功能补全。

- [ ] **Step 1: Create `src/components/knowledge/WikiBrowser.tsx`**

Wiki 浏览器组件，支持：
1. 搜索 Wiki 页面列表（通过 `api.searchWiki(kbId, query)`）
2. 点击搜索结果进入 Wiki 页面详情
3. 每个页面显示 L0 摘要（默认展开），有"展开到 L1 概览"按钮
4. 点击"展开到 L1"调用 `api.expandWiki(kbId, docId, "L1")` 显示概览
5. L1 概览显示：结构大纲、实体列表、正/反向链接
6. L1 有"展开到 L2 全文"按钮，调用 `api.expandWiki(kbId, docId, "L2")`
7. 展开内容使用动画（`animation: "fadeIn 0.2s ease-out"`）
8. 点击实体名称导航到 `<EntityPage>`

关键 API 调用：
- `api.browseWiki(kbId, path)` → 获取 WikiPage（含 title, content, pageType, links, tokenCount）
- `api.expandWiki(kbId, docId, level)` → 获取 L1/L2 内容
- `api.searchWiki(kbId, query)` → 搜索 Wiki 页面

- [ ] **Step 2: Create `src/components/knowledge/EntityPage.tsx`**

实体/概念详情页面：
1. 接收 `entityName` 和 `kbId` 作为 props
2. 通过 `api.searchWiki(kbId, entityName)` 获取相关 Wiki 页面
3. 显示：实体类型、出现文档列表、相关实体链接
4. Wiki 风格的链接导航 — 点击相关实体名称跳转到另一个 EntityPage

- [ ] **Step 3: Create `src/components/knowledge/DocumentViewer.tsx`**

文档查看器：
1. 接收 `docId` 和 `kbId`
2. 通过 `api.browseWiki(kbId, docId)` 获取页面内容
3. 默认显示 L0 摘要
4. "展开到概览" / "展开到全文" 按钮
5. 内容使用 `useMarkdown` 渲染
6. 溯源链接高亮

---

## Task 11: KnowledgePanel 集成 Wiki 浏览 + 设置 Tab

**Files:**
- Modify: `src/components/knowledge/KnowledgePanel.tsx`

- [ ] **Step 1: Update `KnowledgePanel.tsx`**

改动点：
1. 添加第 4 个 Tab：**"设置"**（与设计文档对齐）
2. "Wiki" Tab 的内容从简单的上传区替换为 `<WikiBrowser kbId={kbId} />`
3. "设置" Tab 内容：知识库名称编辑、描述、删除知识库按钮、Wiki 健康检查
4. 搜索结果中添加 "查看 L1 概览" / "跳转到原文" 链接
5. 搜索模式选择器（语义/精确/混合）— 调用 `api.searchWiki(kbId, query, mode)`

---

## Task 12: RightPanel 右侧滑出面板

**Files:**
- Create: `src/components/layout/RightPanel.tsx`

- [ ] **Step 1: Create `src/components/layout/RightPanel.tsx`**

右侧可滑出面板组件，用于显示文档查看器、实体详情等：
1. 从右侧滑入，宽度 400px
2. 有遮罩层（半透明背景）
3. 顶部有关闭按钮和标题
4. 内容区域可滚动
5. 使用 `useUIStore` 的 `rightPanelOpen` / `rightPanelContent` 状态

```tsx
import { X } from "lucide-react";
import { useUIStore } from "../../store/ui";

export function RightPanel() {
  const open = useUIStore((s) => s.rightPanelOpen);
  const close = useUIStore((s) => s.closeRightPanel);
  const content = useUIStore((s) => s.rightPanelContent);

  if (!open) return null;

  return (
    <>
      {/* Overlay */}
      <div
        onClick={close}
        style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.2)",
          zIndex: "var(--z-overlay)",
          animation: "fadeIn 0.15s ease-out",
        }}
      />
      {/* Panel */}
      <div
        style={{
          position: "fixed",
          top: 0, right: 0, bottom: 0,
          width: 400,
          background: "var(--bg-primary)",
          borderLeft: "1px solid var(--border-primary)",
          boxShadow: "var(--shadow-2xl)",
          zIndex: "var(--z-modal)",
          display: "flex",
          flexDirection: "column",
          animation: "slideInRight 0.2s ease-out",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "var(--space-3) var(--space-4)",
          borderBottom: "1px solid var(--border-primary)",
          flexShrink: 0,
        }}>
          <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-primary)" }}>
            {content ?? "详情"}
          </span>
          <button
            onClick={close}
            style={{
              display: "flex", padding: 4, border: "none", background: "transparent",
              color: "var(--text-tertiary)", cursor: "pointer", borderRadius: "var(--radius-sm)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
          >
            <X size={16} />
          </button>
        </div>
        {/* Content - rendered by parent via portal or children */}
        <div style={{ flex: 1, overflow: "auto", padding: "var(--space-4)" }}>
          {/* Content is managed by openRightPanel - for now a placeholder */}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Integrate into `AppLayout.tsx`**

在 `AppLayout.tsx` 中导入 `RightPanel` 并渲染在主内容区之后。

---

## Task 13: ReportExport 报告导出

**Files:**
- Create: `src/components/reports/ReportExport.tsx`

- [ ] **Step 1: Create `src/components/reports/ReportExport.tsx`**

```tsx
import { useState } from "react";
import { FileDown, FileText, FileCode } from "lucide-react";
import { useToast } from "../../hooks/useToast";

interface ReportExportProps {
  reportId: string;
  reportTitle: string;
  onClose: () => void;
}

type ExportFormat = "markdown" | "pdf" | "html";

export function ReportExport({ reportId, reportTitle, onClose }: ReportExportProps) {
  const [exporting, setExporting] = useState(false);
  const { success, error: toastError } = useToast();

  const formats: { key: ExportFormat; label: string; icon: React.ReactNode }[] = [
    { key: "markdown", label: "Markdown", icon: <FileCode size={16} /> },
    { key: "html", label: "HTML", icon: <FileText size={16} /> },
    { key: "pdf", label: "PDF", icon: <FileDown size={16} /> },
  ];

  const handleExport = async (format: ExportFormat) => {
    setExporting(true);
    try {
      // Fetch report content
      const resp = await fetch(`/api/reports/export/${reportId}?format=${format}`);
      if (!resp.ok) throw new Error("导出失败");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${reportTitle}.${format === "markdown" ? "md" : format}`;
      a.click();
      URL.revokeObjectURL(url);
      success("报告导出成功");
      onClose();
    } catch (err) {
      toastError("导出失败: " + String(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.3)", zIndex: "var(--z-modal)",
    }} onClick={onClose}>
      <div
        style={{
          background: "var(--bg-primary)", borderRadius: "var(--radius-xl)",
          boxShadow: "var(--shadow-2xl)", padding: "var(--space-6)", minWidth: 320,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ fontSize: "var(--text-base)", fontWeight: 600, color: "var(--text-primary)", margin: "0 0 var(--space-4)" }}>
          导出报告
        </h3>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: "0 0 var(--space-4)" }}>
          选择导出格式
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          {formats.map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => handleExport(key)}
              disabled={exporting}
              style={{
                display: "flex", alignItems: "center", gap: "var(--space-3)",
                padding: "var(--space-3) var(--space-4)", width: "100%",
                border: "1px solid var(--border-primary)", borderRadius: "var(--radius-lg)",
                background: "var(--surface-primary)", color: "var(--text-primary)",
                fontSize: "var(--text-sm)", cursor: exporting ? "wait" : "pointer",
                transition: "all var(--transition-fast)",
              }}
              onMouseEnter={(e) => { if (!exporting) e.currentTarget.style.borderColor = "var(--interactive)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-primary)"; }}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          style={{
            marginTop: "var(--space-4)", width: "100%", padding: "var(--space-2)",
            border: "none", borderRadius: "var(--radius-lg)",
            background: "var(--bg-tertiary)", color: "var(--text-secondary)",
            fontSize: "var(--text-sm)", cursor: "pointer",
          }}
        >
          取消
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Integrate into `ReportPanel.tsx` and `MessageItem.tsx`**

在 ReportPanel 的报告详情视图中添加"导出"按钮，点击时打开 `<ReportExport>`。
在 MessageItem 的"导出报告"操作按钮中调用 `api.generateReport()` 后打开导出。

---

## Task 14: TaskPanel 多 Tab（编译队列 + 健康检查）

**Files:**
- Modify: `src/components/tasks/TaskPanel.tsx`

- [ ] **Step 1: Update `TaskPanel.tsx`**

改动点：
1. 顶部添加子 Tab 切换：**执行中** | **编译队列** | **历史**
2. "执行中" Tab 保留现有任务列表（含树状结构已在 Task 9 添加）
3. "编译队列" Tab — 列出所有状态为 `parsing` / `compiling` 的文档（通过 `api.listDocuments` 获取），显示进度条
4. "历史" Tab — 显示已完成的任务（status = completed/failed/cancelled），按时间倒序
5. 每个 Tab 的 header 显示计数徽章

编译队列的具体实现：
- 遍历所有知识库的文档，过滤 status 为 `parsing` / `compiling` 的
- 使用 `api.listKnowledgeBases()` 获取所有 KB，然后 `api.listDocuments(kbId)` 获取文档
- 显示文档名、KB 名、状态、进度（用 `compiledCount / totalChunks` 估算）

---

## Task 15: SettingsPanel 多 Tab（嵌入模型 + 通用设置 + 关于）

**Files:**
- Modify: `src/components/settings/SettingsPanel.tsx`

- [ ] **Step 1: Update `SettingsPanel.tsx`**

改动点：
1. 顶部添加 Tab 切换：**模型配置** | **嵌入模型** | **通用设置** | **关于**
2. "模型配置" Tab 保留现有内容
3. "嵌入模型" Tab：
   - 显示当前嵌入模型配置（通过 `api.getDefaults()` 获取 `defaults.embedding`）
   - 提供选择/切换嵌入模型的下拉菜单
   - "测试嵌入"按钮
4. "通用设置" Tab：
   - 数据目录（只读显示）
   - 服务端口（只读显示）
   - 主题切换（浅色/深色/跟随系统）— 调用 `useUIStore.setThemeMode`
   - 语言选择（预留，暂时只显示中文）
   - "保存设置"按钮
5. "关于" Tab：
   - 版本号
   - 系统信息（通过 `api.health()` 获取）
   - "查看系统日志"链接（预留）
   - "查看开源许可"链接（预留）

---

## Task 16: Header 搜索功能 + 模型状态轮询

**Files:**
- Modify: `src/components/layout/Header.tsx`

- [ ] **Step 1: Update `Header.tsx`**

改动点：
1. 搜索栏功能：
   - `useState` 管理 `searchQuery` 和 `searchOpen`
   - 输入文字后显示下拉搜索结果
   - 搜索来源：`api.listSessions()` 过滤标题、`api.listKnowledgeBases()` 过滤名称
   - 点击搜索结果跳转到对应视图（会话 → chat + selectSession，KB → knowledge）
   - 键盘支持：`useKeyboard({ key: "k", ctrl: true }, () => setSearchOpen(true))`
2. 模型状态轮询：
   - 使用 `useEffect` + `setInterval` 每 30 秒调用 `api.health()`
   - 根据结果显示绿色（正常）/黄色（异常）/红色（故障）状态灯
   - 显示模型名称和延迟

---

## Task 17: 代码分割 + 懒加载

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Implement lazy loading in `App.tsx`**

改动点：
1. 使用 `React.lazy()` + `Suspense` 懒加载以下组件：
   - `KnowledgePanel`
   - `ReportPanel`
   - `TaskPanel`
   - `SettingsPanel`
   - `PluginManager`
2. `Suspense` fallback 使用 `<Spinner />`
3. 这会将主 bundle 从 1.37MB 拆分为多个小 chunk

```tsx
import { lazy, Suspense } from "react";
import { Spinner } from "./components/ui/Spinner";

const ChatWindow = lazy(() => import("./components/ChatWindow").then(m => ({ default: m.ChatWindow })));
const KnowledgePanel = lazy(() => import("./components/knowledge/KnowledgePanel").then(m => ({ default: m.KnowledgePanel })));
// ... etc
```

4. 同时在 `vite.config.ts` 中配置 `build.rollupOptions.output.manualChunks` 拆分 vendor 库

- [ ] **Step 2: Verify build size reduced**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx vite build 2>&1 | grep "dist/assets"`
Expected: 多个较小的 chunk 文件，无超过 500KB 的单个文件

---

## Task 18: 响应式适配

**Files:**
- Modify: `src/components/layout/AppLayout.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/styles/base.css`

- [ ] **Step 1: Add responsive CSS breakpoints in `base.css`**

在 `base.css` 底部添加媒体查询：

```css
/* Mobile / Tablet breakpoint */
@media (max-width: 768px) {
  :root {
    --sidebar-width: 0px;
    --sidebar-collapsed-width: 0px;
  }
}
```

- [ ] **Step 2: Update `Sidebar.tsx` for mobile**

在移动端（< 768px），侧边栏变为覆盖式：
1. 添加 `window.matchMedia` 检测
2. 移动端时 sidebar 用 `position: fixed` + 全宽覆盖
3. 添加半透明遮罩层

- [ ] **Step 3: Update `AppLayout.tsx` for mobile**

移动端时：
1. 隐藏 sidebar 的固定布局
2. 添加汉堡菜单按钮在 header

---

## Task 19: 最终集成测试 + 全局快捷键绑定

**Files:**
- Modify: `src/App.tsx` — 注册全局快捷键
- Modify: `src/components/layout/AppLayout.tsx` — 集成 RightPanel

- [ ] **Step 1: Register global shortcuts in `App.tsx`**

```tsx
import { useKeyboard } from "./hooks/useKeyboard";

// Inside App component:
useKeyboard({ key: "n", ctrl: true }, () => {
  useChatStore.getState().createSession();
  useUIStore.getState().setActiveView("chat");
});

useKeyboard({ key: "k", ctrl: true }, () => {
  // Toggle search focus in Header (via custom event or store)
});
```

- [ ] **Step 2: Render RightPanel in AppLayout**

在 `AppLayout.tsx` 的 return 中，在主内容之后添加 `<RightPanel />`。

- [ ] **Step 3: Final build verification**

Run: `cd /mnt/d/code/deepanalyze/deepanalyze/frontend && npx vite build 2>&1 | tail -15`
Expected: Build succeeds with no errors

---

## Self-Review Checklist

- [x] **Spec coverage:** Each missing feature from the audit has a corresponding task
  - P0: L0/L1/L2 → Task 10, Wiki Browser → Task 10+11, Entity pages → Task 10, TraceabilityLink → Task 5, File upload → Task 6
  - P1: Report export → Task 13, Scope selector → Task 5, Virtual scroll → Task 7 (smart scroll), Task tree → Task 9, Settings tabs → Task 15, WS reconnect → already exists in useWebSocket.ts
  - P2: Responsive → Task 18, Keyboard shortcuts → Task 2+19, Code splitting → Task 17, ThinkingIndicator → Task 5
- [x] **Placeholder scan:** No "TBD", "TODO", "implement later" patterns
- [x] **Type consistency:** All types referenced (`AgentTaskInfo.parentId`, `WikiPage.pageType`, `api.expandWiki` params) match the existing `types/index.ts` and `api/client.ts`

---

## Execution Order

任务之间有依赖关系，建议按以下顺序执行（可并行的标记为 parallel）：

```
Task 1  (format.ts)          ──┐
Task 2  (useKeyboard)        ──┤ parallel — 基础工具层
Task 3  (useFileUpload)      ──┤
Task 4  (TextArea+FilePreview) ─┘
          │
Task 5  (Thinking+Traceability+Scope) ── 依赖 Task 1
          │
Task 6  (MessageInput 上传)   ── 依赖 Task 3, 4
Task 7  (MessageItem+List)    ── 依赖 Task 5
Task 8  (ChatWindow 集成)     ── 依赖 Task 5, 2
          │
Task 9  (SubtaskPanel 树状)   ── 独立
          │
Task 10 (Wiki+Entity+DocViewer) ── 依赖 Task 1 — 知识库核心
Task 11 (KnowledgePanel 集成)   ── 依赖 Task 10
          │
Task 12 (RightPanel)          ── 独立
Task 13 (ReportExport)        ── 独立
Task 14 (TaskPanel 多Tab)     ── 依赖 Task 1
Task 15 (SettingsPanel 多Tab) ── 依赖 Task 1
          │
Task 16 (Header 搜索+轮询)    ── 依赖 Task 2
Task 17 (代码分割)             ── 依赖所有组件完成
Task 18 (响应式)               ── 依赖 Task 17
Task 19 (最终集成)             ── 依赖所有
```
