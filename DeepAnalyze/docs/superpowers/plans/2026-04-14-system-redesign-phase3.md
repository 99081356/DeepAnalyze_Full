# Phase 3 (P2): 模块C — 报告 + 聊天集成

> 返回 [索引](./2026-04-14-system-redesign.md) | 上一步 [Phase 2](./2026-04-14-system-redesign-phase2.md) | 下一步 [Phase 4](./2026-04-14-system-redesign-phase4.md)

---

## Task 10: 报告数据持久化层

**文件：** 创建 `src/store/reports.ts`，创建数据库迁移

**步骤：**

- [ ] 10.1 创建 `src/store/reports.ts` — 报告SQLite持久化

```typescript
import { randomUUID } from "crypto";
import { DB } from "./database.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Report {
  id: string;
  sessionId: string;
  messageId: string;
  title: string;
  cleanContent: string;
  rawContent: string;
  entities: string[];
  createdAt: string;
}

export interface ReportReference {
  id: number;
  reportId: string;
  refIndex: number;
  docId: string;
  pageId: string;
  title: string;
  level: "L0" | "L1" | "L2";
  snippet: string;
  highlight: string;
}

// ---------------------------------------------------------------------------
// Schema Migration
// ---------------------------------------------------------------------------

let migrated = false;

export function migrateReports(db: ReturnType<typeof DB.getInstance>["raw"] extends infer T ? T : never): void {
  if (migrated) return;
  migrated = true;

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      title TEXT NOT NULL,
      clean_content TEXT NOT NULL,
      raw_content TEXT NOT NULL,
      entities TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS report_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id TEXT NOT NULL,
      ref_index INTEGER NOT NULL,
      doc_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      title TEXT NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('L0', 'L1', 'L2')),
      snippet TEXT NOT NULL,
      highlight TEXT NOT NULL,
      FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_reports_session ON reports(session_id);
    CREATE INDEX IF NOT EXISTS idx_reports_message ON reports(message_id);
    CREATE INDEX IF NOT EXISTS idx_report_refs_report ON report_references(report_id);
  `);
}

function getDb() {
  const { DB } = require("./database.js") as { DB: { getInstance: () => { raw: any } } };
  const db = DB.getInstance().raw;
  migrateReports(db);
  return db;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createReport(data: {
  sessionId: string;
  messageId: string;
  title: string;
  cleanContent: string;
  rawContent: string;
  entities: string[];
  references: Array<Omit<ReportReference, "id" | "reportId">>;
}): Report {
  const db = getDb();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO reports (id, session_id, message_id, title, clean_content, raw_content, entities)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.sessionId, data.messageId, data.title, data.cleanContent, data.rawContent, JSON.stringify(data.entities));

  // 插入引用
  const stmt = db.prepare(`
    INSERT INTO report_references (report_id, ref_index, doc_id, page_id, title, level, snippet, highlight)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const ref of data.references) {
    stmt.run(id, ref.refIndex, ref.docId, ref.pageId, ref.title, ref.level, ref.snippet, ref.highlight);
  }

  return {
    id,
    sessionId: data.sessionId,
    messageId: data.messageId,
    title: data.title,
    cleanContent: data.cleanContent,
    rawContent: data.rawContent,
    entities: data.entities,
    createdAt: new Date().toISOString(),
  };
}

export function getReport(reportId: string): (Report & { references: ReportReference[] }) | null {
  const db = getDb();
  const report = db.prepare("SELECT * FROM reports WHERE id = ?").get(reportId) as any;
  if (!report) return null;

  const references = db.prepare("SELECT * FROM report_references WHERE report_id = ? ORDER BY ref_index").all(reportId) as ReportReference[];

  return {
    id: report.id,
    sessionId: report.session_id,
    messageId: report.message_id,
    title: report.title,
    cleanContent: report.clean_content,
    rawContent: report.raw_content,
    entities: JSON.parse(report.entities || "[]"),
    createdAt: report.created_at,
    references,
  };
}

export function listReports(limit = 20, offset = 0): Report[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM reports ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset) as any[];
  return rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    messageId: r.message_id,
    title: r.title,
    cleanContent: r.clean_content,
    rawContent: r.raw_content,
    entities: JSON.parse(r.entities || "[]"),
    createdAt: r.created_at,
  }));
}

export function getReportsBySession(sessionId: string): Report[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM reports WHERE session_id = ? ORDER BY created_at DESC").all(sessionId) as any[];
  return rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    messageId: r.message_id,
    title: r.title,
    cleanContent: r.clean_content,
    rawContent: r.raw_content,
    entities: JSON.parse(r.entities || "[]"),
    createdAt: r.created_at,
  }));
}

export function deleteReport(reportId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM reports WHERE id = ?").run(reportId);
  return result.changes > 0;
}
```

- [ ] 10.2 在应用启动时调用迁移

在 `src/server/app.ts` 的 `createApp()` 中，数据库初始化之后调用：

```typescript
// 在 app.ts 的 createApp() 中，数据库初始化后添加:
import { migrateReports } from "../store/reports.js";

// 在现有数据库初始化之后:
migrateReports(db);
```

- [ ] 10.3 验证编译

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] 10.4 提交

```bash
git add src/store/reports.ts src/server/app.ts && git commit -m "feat(reports): add report persistence layer with SQLite schema"
```

---

## Task 11: 报告去噪管道 + API

**文件：** 创建 `src/services/report/cleaner.ts`，修改 `src/server/routes/reports.ts`

**步骤：**

- [ ] 11.1 创建 `src/services/report/cleaner.ts`

```typescript
// =============================================================================
// 报告去噪管道
// 4阶段清洗：内容清理 → 引用标记 → 实体链接 → 最终整理
// =============================================================================

export interface Reference {
  refIndex: number;
  docId: string;
  pageId: string;
  title: string;
  level: "L0" | "L1" | "L2";
  snippet: string;
  highlight: string;
}

export interface CleanResult {
  cleanContent: string;
  references: Reference[];
  entities: string[];
  stats: {
    originalLength: number;
    cleanLength: number;
    referencesExtracted: number;
    entitiesLinked: number;
    blocksRemoved: number;
  };
}

// ---------------------------------------------------------------------------
// Stage 1: 内容清理 — 移除噪音块
// ---------------------------------------------------------------------------

function cleanContent(raw: string): { content: string; blocksRemoved: number } {
  let content = raw;
  let blocksRemoved = 0;

  // 移除 "From: Overview: xxx" 块
  const fromBlocks = content.match(/From:\s*(Overview|Summary|Full\s*Text|Abstract):[\s\S]*?(?=\n\n|\n#|$)/gi) || [];
  blocksRemoved += fromBlocks.length;
  content = content.replace(/From:\s*(Overview|Summary|Full\s*Text|Abstract):[\s\S]*?(?=\n\n|\n#|$)/gi, "");

  // 移除 "Based on the document..." 前缀
  const basedOnPrefixes = content.match(/Based on the document[^.]*\.\s*/gi) || [];
  blocksRemoved += basedOnPrefixes.length;
  content = content.replace(/Based on the document[^.]*\.\s*/gi, "");

  // 移除工具输出格式标记
  content = content.replace(/```[\s\S]*?```/g, (match) => {
    blocksRemoved++;
    return "";
  });

  // 清理多余空行
  content = content.replace(/\n{3,}/g, "\n\n").trim();

  return { content, blocksRemoved };
}

// ---------------------------------------------------------------------------
// Stage 2: 引用标记 — 将原始引文替换为 [n] 标记
// ---------------------------------------------------------------------------

function markReferences(
  content: string,
  sourceDocuments: Array<{ docId: string; pageId: string; title: string; content: string }>
): { content: string; references: Reference[] } {
  const references: Reference[] = [];
  let refIndex = 0;
  let result = content;

  for (const doc of sourceDocuments) {
    // 查找文中引用的文档标题或长段引用
    const titleEscaped = doc.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // 匹配 "根据《xxx》..." 或 "xxx中提到..." 等引用模式
    const patterns = [
      new RegExp(`根据[《<]${titleEscaped}[》>][，,]?([\\s\\S]{10,200}?)(?=[。，;；\\n]|$)`, "g"),
      new RegExp(`${titleEscaped}[中里]([提到显示记录指出][\\s\\S]{10,200}?)(?=[。，;；\\n]|$)`, "g"),
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(result)) !== null) {
        refIndex++;
        const snippet = match[1]?.trim() || match[0].trim();
        references.push({
          refIndex,
          docId: doc.docId,
          pageId: doc.pageId,
          title: doc.title,
          level: "L1" as const,
          snippet: snippet.slice(0, 200),
          highlight: snippet.slice(0, 100),
        });
        // 替换为引用标记
        result = result.slice(0, match.index) + match[0].replace(snippet, `[${refIndex}]`) + result.slice(match.index + match[0].length);
        break; // 每个文档标题只标记一次引用
      }
    }
  }

  return { content: result, references };
}

// ---------------------------------------------------------------------------
// Stage 3: 实体链接 — 识别实体并标记
// ---------------------------------------------------------------------------

function linkEntities(content: string): { content: string; entities: string[] } {
  const entities: string[] = [];

  // 识别人名模式（中文2-4字，前后有上下文指示）
  const personPattern = /[根据关于][^。，；\n]{0,5}([\\u4e00-\\u9fa5]{2,4})(某|先生|女士|同志)/g;
  let match;
  while ((match = personPattern.exec(content)) !== null) {
    const name = match[1] + match[2];
    if (!entities.includes(name)) entities.push(name);
  }

  // 识别金额模式
  const amountPattern = /(\d+(?:\.\d+)?)\s*(万元|元|亿美元|万元人民币)/g;
  while ((match = amountPattern.exec(content)) !== null) {
    const amount = match[0];
    if (!entities.includes(amount)) entities.push(amount);
  }

  return { content, entities };
}

// ---------------------------------------------------------------------------
// Stage 4: 最终整理
// ---------------------------------------------------------------------------

function finalCleanup(content: string): string {
  // 规范化Markdown标题层级
  content = content.replace(/^#{4,}/gm, (m) => m.slice(0, 3));

  // 移除重复空行
  content = content.replace(/\n{3,}/g, "\n\n");

  // 确保标题前后有空行
  content = content.replace(/([^\n])\n(#{1,3} )/g, "$1\n\n$2");
  content = content.replace(/(#{1,3} [^\n]+)\n([^\n#])/g, "$1\n\n$2");

  return content.trim();
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function cleanReport(
  rawContent: string,
  sourceDocuments: Array<{ docId: string; pageId: string; title: string; content: string }> = []
): CleanResult {
  const originalLength = rawContent.length;

  // Stage 1
  const { content: afterClean, blocksRemoved } = cleanContent(rawContent);

  // Stage 2
  const { content: afterRefs, references } = markReferences(afterClean, sourceDocuments);

  // Stage 3
  const { content: afterEntities, entities } = linkEntities(afterRefs);

  // Stage 4
  const cleanContent = finalCleanup(afterEntities);

  return {
    cleanContent,
    references,
    entities,
    stats: {
      originalLength,
      cleanLength: cleanContent.length,
      referencesExtracted: references.length,
      entitiesLinked: entities.length,
      blocksRemoved,
    },
  };
}
```

- [ ] 11.2 修改 `src/server/routes/reports.ts` — 添加报告 CRUD API

在现有的 `createReportRoutes` 中添加完整的 CRUD：

```typescript
// 在 reports.ts 的 createReportRoutes 函数中添加:

// GET /reports — 列出所有报告
app.get("/reports", async (c) => {
  const limit = parseInt(c.req.query("limit") || "20");
  const offset = parseInt(c.req.query("offset") || "0");
  const { listReports } = await import("../../store/reports.js");
  const reports = listReports(limit, offset);
  return c.json({ reports, limit, offset });
});

// GET /reports/:id — 获取单个报告（含引用）
app.get("/reports/:id", async (c) => {
  const id = c.req.param("id");
  const { getReport } = await import("../../store/reports.js");
  const report = getReport(id);
  if (!report) return c.json({ error: "Report not found" }, 404);
  return c.json(report);
});

// GET /sessions/:sessionId/reports — 获取会话的报告
app.get("/sessions/:sessionId/reports", async (c) => {
  const sessionId = c.req.param("sessionId");
  const { getReportsBySession } = await import("../../store/reports.js");
  const reports = getReportsBySession(sessionId);
  return c.json({ reports });
});

// DELETE /reports/:id — 删除报告
app.delete("/reports/:id", async (c) => {
  const id = c.req.param("id");
  const { deleteReport } = await import("../../store/reports.js");
  const deleted = deleteReport(id);
  if (!deleted) return c.json({ error: "Report not found" }, 404);
  return c.json({ success: true });
});

// GET /reports/:id/export — 导出报告为Markdown
app.get("/reports/:id/export", async (c) => {
  const id = c.req.param("id");
  const { getReport } = await import("../../store/reports.js");
  const report = getReport(id);
  if (!report) return c.json({ error: "Report not found" }, 404);

  const md = `# ${report.title}\n\n${report.cleanContent}\n\n---\n\n## 引用\n\n${
    report.references.map(r => `[${r.refIndex}] ${r.title} (${r.level}): ${r.snippet}`).join("\n\n")
  }`;

  return c.json({ markdown: md, title: report.title });
});
```

- [ ] 11.3 验证编译

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] 11.4 提交

```bash
git add src/services/report/cleaner.ts src/server/routes/reports.ts && git commit -m "feat(reports): add 4-stage cleaning pipeline and CRUD API endpoints"
```

---

## Task 12: 聊天内嵌报告 + 引用标记前端

**文件：** 创建 `frontend/src/components/chat/ReportCard.tsx`、`ReferenceMarker.tsx`、`EntityLink.tsx`，修改 `frontend/src/components/ChatWindow.tsx`，修改 `src/server/routes/chat.ts`

**步骤：**

- [ ] 12.1 创建 `frontend/src/components/chat/ReportCard.tsx`

```typescript
import React from "react";

interface Report {
  id: string;
  title: string;
  cleanContent: string;
  references: Array<{
    refIndex: number;
    title: string;
    level: string;
    snippet: string;
  }>;
  createdAt: string;
}

interface ReportCardProps {
  report: Report;
  agentSummary?: string;
}

export const ReportCard: React.FC<ReportCardProps> = ({ report, agentSummary }) => {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="my-3 rounded-lg border dark:border-gray-600 overflow-hidden">
      {/* 头部 */}
      <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-4 py-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-sm truncate">{report.title}</h3>
          <div className="flex items-center gap-2 text-xs opacity-80">
            <span>{new Date(report.createdAt).toLocaleString()}</span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(report.cleanContent);
              }}
              className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30"
            >
              复制
            </button>
          </div>
        </div>
        <div className="text-xs opacity-80 mt-1">
          {report.references.length} 引用
        </div>
      </div>

      {/* 主体 */}
      <div className="bg-white dark:bg-gray-800 px-4 py-3">
        <div
          className={`text-sm text-gray-700 dark:text-gray-300 prose dark:prose-invert max-w-none ${
            !expanded ? "max-h-48 overflow-hidden relative" : ""
          }`}
        >
          <div dangerouslySetInnerHTML={{ __html: report.cleanContent }} />
          {!expanded && (
            <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-white dark:from-gray-800 to-transparent" />
          )}
        </div>
        {!expanded && report.cleanContent.length > 500 && (
          <button
            onClick={() => setExpanded(true)}
            className="text-xs text-blue-500 hover:underline mt-1"
          >
            展开完整报告 ↓
          </button>
        )}
      </div>

      {/* 底部 */}
      <div className="bg-gray-50 dark:bg-gray-750 px-4 py-2 flex items-center justify-between border-t dark:border-gray-700">
        <span className="text-xs text-gray-500">
          {report.references.length} references
        </span>
        <a href={`#/reports/${report.id}`} className="text-xs text-blue-500 hover:underline">
          查看完整报告 →
        </a>
      </div>

      {/* Agent摘要 */}
      {agentSummary && (
        <div className="bg-blue-50 dark:bg-blue-900/20 px-4 py-2 border-t dark:border-gray-700">
          <p className="text-xs text-blue-700 dark:text-blue-300">
            <span className="font-medium">Agent: </span>{agentSummary}
          </p>
        </div>
      )}
    </div>
  );
};
```

- [ ] 12.2 创建 `frontend/src/components/chat/ReferenceMarker.tsx`

```typescript
import React, { useState } from "react";

interface ReferenceMarkerProps {
  index: number;
  title: string;
  level: string;
  snippet: string;
}

export const ReferenceMarker: React.FC<ReferenceMarkerProps> = ({ index, title, level, snippet }) => {
  const [showPopup, setShowPopup] = useState(false);

  return (
    <span
      className="relative inline"
      onMouseEnter={() => setShowPopup(true)}
      onMouseLeave={() => setShowPopup(false)}
    >
      <sup className="cursor-pointer text-blue-500 hover:text-blue-700 font-medium text-xs">
        [{index}]
      </sup>
      {showPopup && (
        <div className="absolute bottom-full left-0 mb-2 w-72 bg-white dark:bg-gray-800 border dark:border-gray-600 rounded-lg shadow-xl z-50">
          <div className="p-2 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-750 rounded-t-lg">
            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
              来源: {title}
            </span>
            <span className="text-xs text-gray-400 ml-2">Level: {level}</span>
          </div>
          <div className="p-2 text-xs text-gray-600 dark:text-gray-400 max-h-32 overflow-y-auto">
            {snippet}
          </div>
          <div className="p-2 border-t dark:border-gray-700">
            <a href="#" className="text-xs text-blue-500 hover:underline">打开来源文档 →</a>
          </div>
        </div>
      )}
    </span>
  );
};
```

- [ ] 12.3 创建 `frontend/src/components/chat/EntityLink.tsx`

```typescript
import React, { useState } from "react";

interface EntityLinkProps {
  name: string;
  type: string;
  count: number;
}

export const EntityLink: React.FC<EntityLinkProps> = ({ name, type, count }) => {
  const [showPopup, setShowPopup] = useState(false);

  return (
    <span
      className="relative inline border-b border-dashed border-blue-400 cursor-pointer"
      onMouseEnter={() => setShowPopup(true)}
      onMouseLeave={() => setShowPopup(false)}
    >
      {name}
      {showPopup && (
        <div className="absolute bottom-full left-0 mb-2 w-56 bg-white dark:bg-gray-800 border dark:border-gray-600 rounded-lg shadow-xl z-50">
          <div className="p-2 text-xs">
            <div className="font-medium text-gray-900 dark:text-gray-100">Entity: {type}</div>
            <div className="text-gray-500">出现 {count} 次</div>
          </div>
          <div className="p-2 border-t dark:border-gray-700">
            <a href="#" className="text-xs text-blue-500 hover:underline">查看所有提及 →</a>
          </div>
        </div>
      )}
    </span>
  );
};
```

- [ ] 12.4 修改 `frontend/src/components/ChatWindow.tsx` — 检测报告消息并渲染 ReportCard

在消息渲染逻辑中添加报告检测：

```typescript
// 在 ChatWindow.tsx 的消息渲染部分:
import { ReportCard } from "./chat/ReportCard";

// 在渲染 assistant 消息时:
// 如果消息包含 report 字段，渲染 ReportCard
{message.report ? (
  <ReportCard
    report={message.report}
    agentSummary={message.report.summary}
  />
) : (
  // 原有的 Markdown 渲染
  <div className="prose dark:prose-invert ...">
    <ReactMarkdown>{message.content}</ReactMarkdown>
  </div>
)}
```

- [ ] 12.5 修改 `src/server/routes/chat.ts` — 在聊天消息中内联报告数据

```typescript
// 在 chat.ts 的消息返回逻辑中，检查该消息是否有关联的报告
// 在返回消息列表时，为每条消息附加 report 数据:

import { getReport } from "../../store/reports.js";

// 在消息序列化时：
// for each message:
//   if message.role === "assistant":
//     const report = getReportByMessageId(message.id)
//     if report: message.report = { id, title, summary, cleanContent, references, createdAt }
```

具体需要在获取消息列表的API中添加报告关联查询。在返回聊天历史时：

```typescript
// 在获取session messages的路由中:
const messages = getSessionMessages(sessionId);
const enrichedMessages = messages.map(msg => {
  if (msg.role === "assistant") {
    const report = getReportByMessageId(msg.id);
    if (report) {
      return {
        ...msg,
        report: {
          id: report.id,
          title: report.title,
          summary: report.cleanContent.slice(0, 100) + "...",
          cleanContent: report.cleanContent,
          references: report.references,
          createdAt: report.createdAt,
        },
      };
    }
  }
  return msg;
});
```

需要在 `src/store/reports.ts` 中添加 `getReportByMessageId`：

```typescript
export function getReportByMessageId(messageId: string): (Report & { references: ReportReference[] }) | null {
  const db = getDb();
  const report = db.prepare("SELECT * FROM reports WHERE message_id = ?").get(messageId) as any;
  if (!report) return null;
  const references = db.prepare("SELECT * FROM report_references WHERE report_id = ? ORDER BY ref_index").all(report.id) as ReportReference[];
  return {
    id: report.id, sessionId: report.session_id, messageId: report.message_id,
    title: report.title, cleanContent: report.clean_content, rawContent: report.raw_content,
    entities: JSON.parse(report.entities || "[]"), createdAt: report.created_at, references,
  };
}
```

- [ ] 12.6 验证编译

```bash
cd /mnt/d/code/deepanalyze/deepanalyze && npx tsc --noEmit 2>&1 | head -20
```

- [ ] 12.7 提交

```bash
git add frontend/src/components/chat/ReportCard.tsx frontend/src/components/chat/ReferenceMarker.tsx frontend/src/components/chat/EntityLink.tsx frontend/src/components/ChatWindow.tsx src/server/routes/chat.ts src/store/reports.ts && git commit -m "feat(reports): embed reports in chat with reference markers and entity links"
```

---

**Phase 3 完成。** 继续到 [Phase 4](./2026-04-14-system-redesign-phase4.md)
