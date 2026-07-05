// =============================================================================
// DeepAnalyze - Tool Setup
// =============================================================================
// Creates a fully configured ToolRegistry with all custom DeepAnalyze tools
// (kb_search, wiki_browse, expand, timeline_build, graph_build)
// registered and wired to their backends.
// =============================================================================

import { ToolRegistry, DEFERRED_TOOLS } from "./tool-registry.js";
import { Retriever } from "../../wiki/retriever.js";
import { Linker } from "../../wiki/linker.js";
import { Expander } from "../../wiki/expander.js";
import type { EmbeddingManager } from "../../models/embedding.js";
import type { Indexer } from "../../wiki/indexer.js";
import type { ModelRouter } from "../../models/router.js";
import { getRepos } from "../../store/repos/index.js";
import { createTimelineTool } from "../../tools/TimelineTool/index.js";
import { createGraphTool } from "../../tools/GraphTool/index.js";
import { structuredOutputTool } from "../../tools/StructuredOutputTool/index.js";
import { wrapExternalContent } from "../../security/prompt-injection.js";
import { AgentPluginManager } from "./plugin-manager.js";
import { ensureBuiltinSkills } from "./builtin-skills.js";
import { getEnhancedDescription } from "./tool-descriptions.js";
// PowerShell adapter: no-op stubs (PowerShell support dropped during CC cleanup;
// Linux/WSL2 environment does not have PowerShell, and the deep CC dependency chain
// required for this feature has been removed)
async function executePowerShellCommand(_command: string, _timeoutSec: number, _dataDir: string): Promise<any> {
  return { exitCode: 1, output: "", error: "PowerShell is not available on this platform" };
}
function checkPowerShellSafetySync(_cmd: string): { safe: boolean; isReadOnly: boolean; isDestructive: boolean; reason?: string } {
  return { safe: true, isReadOnly: false, isDestructive: false, reason: "PowerShell check skipped" };
}
import {
  createConnection,
  executeQuery,
  listConnections,
} from "./db-connections.js";
import { join, resolve, dirname, isAbsolute, relative, extname } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile, writeFile, copyFile as copyFileAsync } from "node:fs/promises";
import { exec, execSync } from "node:child_process";
import { getSessionOutputDir, getSessionSubagentsDir, getSessionGeneratedDir, isSharedDataPath, makeAgentFilename, resolveSessionOutputPath } from "../session/session-paths.js";

// ---------------------------------------------------------------------------
// Helper: scan _preprocessing directory for supplementary data
// ---------------------------------------------------------------------------

/**
 * Check if a knowledge base has preprocessing data and return a summary.
 * Returns an object that spreads into wiki_browse results — empty if no
 * preprocessing data exists, so Agent is unaffected.
 *
 * Enhanced: reads manifest.json for table lineage information so Agent
 * knows which source documents the preprocessed tables were extracted from.
 */
function scanPreprocessingDir(dataDir: string, kbId: string): Record<string, unknown> {
  const preprocDir = join(dataDir, "wiki", kbId, "_preprocessing");
  if (!existsSync(preprocDir)) return {};

  try {
    const files: string[] = [];
    const tableFiles: string[] = [];

    function walk(dir: string, prefix: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const rel = prefix ? `${prefix}/${entry}` : entry;
        if (statSync(full).isDirectory()) {
          walk(full, rel);
        } else {
          files.push(rel);
          if (rel.startsWith("tables/") && (rel.endsWith(".csv") || rel.endsWith(".xlsx"))) {
            tableFiles.push(rel);
          }
        }
      }
    }
    walk(preprocDir, "");

    if (files.length === 0) return {};

    // Try to read lineage manifest for table provenance
    const manifestPath = join(preprocDir, "tables", "manifest.json");
    let tableDetails: Array<Record<string, unknown>> | undefined;
    if (existsSync(manifestPath)) {
      try {
        const manifestRaw = readFileSync(manifestPath, "utf-8");
        const manifest = JSON.parse(manifestRaw);
        if (Array.isArray(manifest.tables)) {
          tableDetails = manifest.tables;
        }
      } catch {
        // Malformed manifest — ignore, tables still listed by filename
      }
    }

    // Build table info array
    const tables = tableFiles.map((f) => {
      const detail = tableDetails?.find((t) => t.file === f || t.file === f.replace("tables/", ""));
      return {
        file: f,
        ...(detail ?? {}),
      };
    });

    // Return paths relative to wiki/{kbId}/ so Agent can use read_file/glob
    return {
      preprocessingData: {
        hint: "此知识库有预处理产物，可用 read_file 读取。tables 目录下的 CSV/XLSX 是从扫描件或 PDF 中还原的表格数据（二次加工数据，非原始数据），每条记录含来源文档信息和提取方式，建议与原文交叉验证。其他产物包含全局概览、图片质量审计等",
        path: `wiki/${kbId}/_preprocessing/`,
        files,
        tableCount: tableFiles.length,
        tables,
      },
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Dependencies for tool registration
// ---------------------------------------------------------------------------

/** All external dependencies needed to set up the tool registry. */
// ---------------------------------------------------------------------------
// Tools blocked for sub-agents to prevent recursive spawning
// ---------------------------------------------------------------------------

export const SUB_AGENT_BLOCKED_TOOLS = new Set([
  "workflow_run",
  "push_content",
  "push_file",
  "list_pushed_content",
]);

// ---------------------------------------------------------------------------
// Dependencies for tool registration
// ---------------------------------------------------------------------------

/** All external dependencies needed to set up the tool registry. */
export interface ToolSetupDeps {
  retriever: Retriever;
  linker: Linker;
  expander: Expander;
  embeddingManager: EmbeddingManager;
  indexer: Indexer;
  modelRouter: ModelRouter;
  /** Root data directory for wiki content files. */
  dataDir: string;
}

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------

/**
 * Create a ToolRegistry with all DeepAnalyze tools registered and wired to
 * their real backend implementations.
 *
 * The returned registry includes:
 * - think (built-in, always present)
 * - finish (built-in, always present)
 * - kb_search (Retriever-backed semantic + BM25 + link search)
 * - wiki_browse (page listing, content reading, link traversal)
 * - expand (layer-by-layer content expansion L0 -> L1 -> L2)
 * - timeline_build (chronological event extraction from wiki pages)
 * - graph_build (entity relationship graph from wiki pages and links)
 */
export async function createConfiguredToolRegistry(deps: ToolSetupDeps): Promise<ToolRegistry> {
  const registry = new ToolRegistry();

  // -----------------------------------------------------------------------
  // KB scope enforcement helper (L1 - Tool layer)
  // -----------------------------------------------------------------------
  // When a session has scopeKbIds, filesystem tools (read_file, grep, glob, bash)
  // must not access files outside the scoped KB directories. This prevents
  // cross-KB content contamination where sub-agents read files from unrelated KBs.

  /**
   * Check if a resolved filesystem path is within the session's KB scope.
   * Returns null if access is allowed, or an error message string if denied.
   * If no scopeKbIds is set (unscoped session), always returns null (allowed).
   */
  /**
   * Validate that a given kbId is within the session's KB scope.
   * Returns an error message if out of scope, or null if allowed.
   */
  function validateKbIdScope(kbId: string): string | null {
    const ctx = registry.getExecutionContext();
    const scopeKbIds = ctx.scopeKbIds as string[] | undefined;
    if (!scopeKbIds) return null; // unscoped session (no scope info in context)
    if (scopeKbIds.length === 0) return `Access denied: session has no knowledge base in scope. Requested KB: ${kbId}`;
    if (scopeKbIds.includes(kbId)) return null; // in scope
    return `Access denied: knowledge base ${kbId} is outside the session's scope. Allowed KBs: ${scopeKbIds.join(", ")}`;
  }

  /**
   * Filter an array of kbIds to only include those in the session's scope.
   * Returns the filtered array and a warning message if any were removed.
   */
  function filterKbIdsToScope(kbIds: string[]): { filtered: string[]; warning: string | null } {
    const ctx = registry.getExecutionContext();
    const scopeKbIds = ctx.scopeKbIds as string[] | undefined;
    if (!scopeKbIds || scopeKbIds.length === 0) return { filtered: kbIds, warning: null };
    const scopeSet = new Set(scopeKbIds);
    const filtered = kbIds.filter(id => scopeSet.has(id));
    if (filtered.length === kbIds.length) return { filtered, warning: null };
    const removed = kbIds.filter(id => !scopeSet.has(id));
    return {
      filtered,
      warning: `Scope filter: removed ${removed.length} out-of-scope KB(s): ${removed.join(", ")}. Allowed: ${scopeKbIds.join(", ")}`,
    };
  }

  function checkKbScope(resolvedPath: string): string | null {
    const ctx = registry.getExecutionContext();
    const scopeKbIds = ctx.scopeKbIds as string[] | undefined;
    // undefined = no scope info in context (legacy/unscoped) → allow all.
    // [] = explicitly empty scope → deny KB directories (fall through to checks below).
    // ["kb1"] = scoped → only allow listed KBs.
    if (!scopeKbIds) return null; // unscoped session

    const dataRoot = resolve(deps.dataDir);

    // Paths outside data directory entirely are handled by existing safety checks
    if (!resolvedPath.startsWith(dataRoot)) return null;

    // KB-scoped directories that contain per-KB data:
    // - wiki/{kbId}/ — processed/indexed content
    // - original/{kbId}/ — original uploaded files
    const scopedDirs = ["wiki", "original"];
    for (const dir of scopedDirs) {
      const prefix = resolve(dataRoot, dir) + "/";
      if (resolvedPath.startsWith(prefix)) {
        const relPath = resolvedPath.slice(prefix.length);
        const kbIdSegment = relPath.split("/")[0];
        // Only restrict if the segment looks like a UUID (KB ID)
        if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(kbIdSegment)) {
          if (!scopeKbIds.includes(kbIdSegment)) {
            return `Access denied: path "${resolvedPath.slice(dataRoot.length + 1)}" is outside the session's knowledge base scope. Allowed KBs: ${scopeKbIds.join(", ")}`;
          }
        }
        return null; // in scope or not a KB path
      }
    }

    // Path is not under any KB-scoped directory (e.g. tmp/, shared/) — allowed
    return null;
  }

  /**
   * Get the restricted search paths for scoped sessions.
   * Returns an array of wiki/{kbId} paths that the session is allowed to access.
   * For unscoped sessions, returns empty array (no restriction).
   */
  function getScopedSearchPaths(): string[] {
    const ctx = registry.getExecutionContext();
    const scopeKbIds = ctx.scopeKbIds as string[] | undefined;
    if (!scopeKbIds || scopeKbIds.length === 0) return [];
    return scopeKbIds.map(id => resolve(deps.dataDir, "wiki", id));
  }

  // -----------------------------------------------------------------------
  // kb_search tool
  // -----------------------------------------------------------------------

  registry.register({
    name: "kb_search",
    description:
      "语义搜索知识库文档。返回按相关性排序的匹配页面列表。" +
      "底层使用向量相似度 + BM25 全文搜索混合检索。默认排除报告类页面。\n" +
      "⚠️ **重要局限**：kb_search 是 top-K 近似检索，**只能返回最相似的 K 条结果，不代表知识库中只有这 K 条相关内容**。" +
      "知识库中可能有更多相关文档未被召回。如果需要完整覆盖某主题的所有文档，必须用 doc_grep 精确搜索或 wiki_browse 逐文档检查。" +
      "不要假设 kb_search 返回的就是全部相关文档。\n" +
      "**适用场景**：快速定位某主题可能涉及的文档、在已知大量文档中缩小范围、" +
      "补充性语义查询（如\u201C哪些文档提到了信任机制\u201D）。\n" +
      "**不适用场景**：需要完整覆盖所有相关文档时（应逐文档 expand）；需要精确匹配特定字符串时（应用 doc_grep）；需要获取完整文档列表时（应用 wiki_browse 或 run_sql）。\n" +
      "**返回字段**：每个结果包含 `pageId`、`docId`、`title`、`snippet`、`score`、`anchorId`（最佳匹配锚点 ID，格式 `{docId}:{elementType}:{index}`，例如 `1e9b6bb2-...:paragraph:3`）。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索查询文本",
        },
        kbIds: {
          type: "array",
          items: { type: "string" },
          description:
            "要搜索的知识库 ID 列表。省略则搜索所有知识库。",
        },
        topK: {
          type: "number",
          description: "返回结果的最大数量（默认：20）。知识库文档多时建议调大（如30-50），避免遗漏",
        },
        linkedFrom: {
          type: "string",
          description:
            "链接遍历的起始页面 ID（添加关联结果）。",
        },
        pageTypes: {
          type: "array",
          items: { type: "string" },
          description:
            "按页面类型过滤结果（abstract, overview, fulltext, structure_md, structure_dt, entity, concept, report）。",
        },
        minScore: {
          type: "number",
          description: "最低相关性分数阈值（0-1 范围）。",
        },
      },
      required: ["query"],
    },
    async execute(input: Record<string, unknown>) {
      const query = input.query as string;
      let kbIds = (input.kbIds as string[]) || [];
      // Default to excluding report pages — agent should analyze source documents, not prior reports
      const pageTypes = (input.pageTypes as string[]) || undefined;
      const excludeReports = input.excludeReports !== false; // default true
      const effectivePageTypes = pageTypes ?? (excludeReports
        ? ["abstract", "overview", "fulltext", "structure_md", "structure_dt", "entity", "concept"]
        : undefined);

      // Scope enforcement: filter explicit kbIds against session scope
      if (kbIds.length > 0) {
        const { filtered, warning } = filterKbIdsToScope(kbIds);
        if (filtered.length === 0) {
          return { results: [], total: 0, message: warning || "All specified KBs are outside session scope." };
        }
        kbIds = filtered;
      }

      if (kbIds.length === 0) {
        // When no KB IDs are specified, use session scope if available, otherwise all KBs
        const ctx = registry.getExecutionContext();
        const sessionScope = ctx.scopeKbIds as string[] | undefined;
        if (sessionScope && sessionScope.length > 0) {
          return deps.retriever.search(query, {
            kbIds: sessionScope,
            topK: (input.topK as number) || 20,
            linkedFrom: input.linkedFrom as string | undefined,
            pageTypes: effectivePageTypes,
            minScore: input.minScore as number | undefined,
          });
        }

        const repos = await getRepos();
        const allKbs = await repos.knowledgeBase.list();
        const allKbIds = allKbs.map((kb) => kb.id);

        if (allKbIds.length === 0) {
          return {
            results: [],
            total: 0,
            message: "No knowledge bases found.",
          };
        }

        return deps.retriever.search(query, {
          kbIds: allKbIds,
          topK: (input.topK as number) || 20,
          linkedFrom: input.linkedFrom as string | undefined,
          pageTypes: effectivePageTypes,
          minScore: input.minScore as number | undefined,
        });
      }

      return deps.retriever.search(query, {
        kbIds,
        topK: (input.topK as number) || 20,
        linkedFrom: input.linkedFrom as string | undefined,
        pageTypes: effectivePageTypes,
        minScore: input.minScore as number | undefined,
      });
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresKbScope: true,
  });

  // -----------------------------------------------------------------------
  // wiki_browse tool
  // -----------------------------------------------------------------------

  registry.register({
    name: "wiki_browse",
    description:
      "浏览知识库中的文档和 Wiki 页面。**这是了解知识库全貌的首选工具**，能返回完整的文档列表，不会遗漏。\n" +
      "提供 kbId + listDocuments=true：返回该知识库**所有文档**的分类列表，每篇附带 docId、文件名、文件类型、路径和 L0 摘要。" +
      "这是获取完整文档清单的唯一可靠方法，不会像 kb_search 那样因为语义检索而遗漏文档。\n" +
      "提供 pageId：返回特定页面的完整内容（id, docId, pageType, title, tokenCount, content）。\n" +
      "提供 kbId（可选 pageType）：列出该知识库的所有页面（id, docId, pageType, title, tokenCount）。\n" +
      "⚠️ kbId 是必需参数——无论是列出文档还是页面，都必须提供 kbId。" +
      "每个文档还包含 wikiPath 字段，指向 L1 全文文件的相对路径（可用 bash 工具直接访问）。",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description: "要查看的特定页面 ID。返回页面内容和元数据。",
        },
        kbId: {
          type: "string",
          description:
            "知识库 ID。返回该知识库中所有页面的列表。",
        },
        pageType: {
          type: "string",
          description:
            "列出知识库页面时按类型过滤（abstract, overview, fulltext, structure_md, structure_dt, entity, concept, report）。",
        },
        listDocuments: {
          type: "boolean",
          description:
            "设为 true 时，列出知识库中所有文档（去重），每个文档附带其 L0 摘要页的摘要内容和页面ID。⚠️ 必须同时提供 kbId。",
        },
      },
    },
    async execute(input: Record<string, unknown>) {
      const repos = await getRepos();

      // Scope enforcement for kbId parameter
      if (input.kbId) {
        const scopeError = validateKbIdScope(input.kbId as string);
        if (scopeError) return { error: scopeError };
      }

      // Mode: List distinct documents with L0 abstracts
      if (input.listDocuments && input.kbId) {
        const kbId = input.kbId as string;

        // Get all documents in the KB
        const docs = await repos.document.getByKbId(kbId);

        // Get all abstract (L0) pages for quick summary
        const abstractPages = await repos.wikiPage.getByKbAndType(kbId, "abstract");

        // Build a map: docId -> abstract page
        const abstractMap = new Map<string, { pageId: string; content: string }>();
        for (const p of abstractPages) {
          if (!abstractMap.has(p.doc_id)) {
            abstractMap.set(p.doc_id, {
              pageId: p.id,
              content: (p.content || "").slice(0, 300),
            });
          }
        }

        // Auto-categorize documents by directory and file type
        const categories = new Map<string, { type: string; count: number; docIds: string[]; sampleFiles: string[] }>();

        // Generic file type labels by extension
        const fileTypeLabel = (ext: string): string => {
          const e = ext.toLowerCase();
          if (["pdf"].includes(e)) return "PDF";
          if (["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg"].includes(e)) return "Image";
          if (["mp3", "wav", "ogg", "flac", "m4a", "aac"].includes(e)) return "Audio";
          if (["mp4", "avi", "mkv", "mov", "wmv", "webm"].includes(e)) return "Video";
          if (["xlsx", "xls", "csv", "tsv"].includes(e)) return "Spreadsheet";
          if (["doc", "docx"].includes(e)) return "Word";
          if (["ppt", "pptx"].includes(e)) return "Presentation";
          if (["txt", "md", "rtf"].includes(e)) return "Text";
          if (["json", "xml", "yaml", "yml"].includes(e)) return "Data";
          if (["zip", "tar", "gz", "rar", "7z"].includes(e)) return "Archive";
          return e.toUpperCase() || "Unknown";
        };

        // Classify by folder_path first (most useful grouping), then by file type
        // Use parent + leaf folder for better grouping (e.g., "ProjectA/Reports")
        const classifyDoc = (d: { id: string; filename: string; file_type: string; folder_path: string }) => {
          const fp = d.folder_path || "";
          if (fp) {
            const parts = fp.replace(/\\/g, "/").split("/").filter(Boolean);
            if (parts.length >= 2) {
              // Return last two segments for context: "parent/leaf"
              return parts.slice(-2).join("/");
            }
            return parts[parts.length - 1]; // single segment
          }
          // Otherwise group by file type
          return fileTypeLabel(d.file_type);
        };

        for (const d of docs) {
          const cat = classifyDoc(d);
          if (!categories.has(cat)) {
            categories.set(cat, { type: cat, count: 0, docIds: [], sampleFiles: [] });
          }
          const entry = categories.get(cat)!;
          entry.count++;
          entry.docIds.push(d.id);
          if (entry.sampleFiles.length < 3) {
            entry.sampleFiles.push(d.filename.split("/").pop() || d.filename);
          }
        }

        return {
          kbId,
          totalDocuments: docs.length,
          categories: Array.from(categories.values()).map((c) => ({
            type: c.type,
            count: c.count,
            sampleFiles: c.sampleFiles,
          })),
          documents: docs.map((d) => {
            const abstract = abstractMap.get(d.id);
            // Strip dataDir prefix from filePath so it's relative to the bash CWD.
            // DB stores "data/original/..." but bash runs with cwd="data/",
            // so agents need "original/..." to avoid double-prefixing.
            const rawPath = d.file_path || "";
            const dataDirPrefix = deps.dataDir + "/";
            const relativePath = rawPath.startsWith(dataDirPrefix)
              ? rawPath.slice(dataDirPrefix.length)
              : rawPath;
            return {
              docId: d.id,
              filename: d.filename,
              folderPath: d.folder_path || undefined,
              filePath: relativePath || undefined,
              fileType: d.file_type,
              status: d.status,
              abstractPageId: abstract?.pageId,
              abstract: abstract?.content,
              wikiPath: `wiki/${kbId}/documents/${d.id}/parsed.md`,
            };
          }),
          ...scanPreprocessingDir(deps.dataDir, kbId),
        };
      }

      // Mode 1: View a specific page by ID
      if (input.pageId) {
        const pageId = input.pageId as string;
        const page = await repos.wikiPage.getById(pageId);

        if (!page) {
          return { error: `Page not found: ${pageId}` };
        }

        // Scope enforcement: check page belongs to a scoped KB
        if (page.kb_id) {
          const scopeError = validateKbIdScope(page.kb_id);
          if (scopeError) return { error: scopeError };
        }

        const content = page.content || "[Content could not be read]";
        const doc = page.doc_id ? await repos.document.getById(page.doc_id) : undefined;

        return {
          id: page.id,
          kbId: page.kb_id,
          docId: page.doc_id,
          filename: doc?.filename,
          pageType: page.page_type,
          title: page.title,
          tokenCount: page.token_count,
          content,
        };
      }

      // Mode 2: List pages in a knowledge base
      if (input.kbId) {
        const kbId = input.kbId as string;
        const pageType = input.pageType as string | undefined;
        const pages = await repos.wikiPage.getByKbAndType(kbId, pageType);

        // Batch-fetch document metadata to include filename in page listings
        const docIds = [...new Set(pages.map(p => p.doc_id))];
        const docMap = new Map<string, { filename: string; file_type: string }>();
        if (docIds.length > 0) {
          for (const did of docIds) {
            const doc = await repos.document.getById(did);
            if (doc) docMap.set(did, { filename: doc.filename, file_type: doc.file_type });
          }
        }

        return {
          kbId,
          total: pages.length,
          pages: pages.map((p) => {
            const docMeta = docMap.get(p.doc_id);
            return {
              id: p.id,
              docId: p.doc_id,
              filename: docMeta?.filename,
              fileType: docMeta?.file_type,
              pageType: p.page_type,
              title: p.title,
              tokenCount: p.token_count,
            };
          }),
        };
      }

      return {
        error:
          'Provide "kbId" to list pages, "pageId" to view a page, or "kbId" + "listDocuments=true" to list all documents.',
      };
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresKbScope: true,
  });

  // -----------------------------------------------------------------------
  // expand tool
  // -----------------------------------------------------------------------

  registry.register({
    name: "expand",
    description:
      "逐层展开文档内容（L0/L1/L2）。L1 层级返回结果包含 `anchors` 数组，每个锚点提供 `id`（格式 `{docId}:{elementType}:{index}`，例如 `1e9b6bb2-b233-4f36-b196-8249082a4fde:paragraph:0`）、`type`（heading/paragraph/table/image/formula/list/code）、`lineStart`、`preview`、`sectionTitle`。锚点 ID 是文档结构元素的稳定标识符，完整字符串必须从返回结果中逐字复制——它不是纯 UUID，也不是可缩写或自构造的。",
    inputSchema: {
      type: "object",
      properties: {
        pageId: {
          type: "string",
          description: "要展开的页面 ID。返回当前层级的内容。",
        },
        docId: {
          type: "string",
          description: "要展开到特定层级的文档 ID。",
        },
        docIds: {
          type: "array",
          items: { type: "string" },
          maxItems: 20,
          description: "批量展开多个文档 ID（最多20个）。返回每个文档的 L1 结构概述。提供 kbId 时使用高效批量查询（推荐）。超过20个文档时分批调用。",
        },
        kbId: {
          type: "string",
          description: "知识库 ID。批量展开(docIds)时提供此参数可使用高效批量查询，显著减少 DB 访问次数。从 wiki_browse 的返回中获取。",
        },
        targetLevel: {
          type: "string",
          enum: ["L0", "L1", "L2"],
          description:
            "按文档 ID 展开时的目标层级，返回该层级完整内容（不截断）。L0=摘要，L1=结构化分析内容（推荐，最常用），L2=原始全文。需要完整阅读文档时优先用此参数而非 tokenBudget。",
        },
        format: {
          type: "string",
          enum: ["md", "dt"],
          description:
            "L1 格式选择：'md' 为 Markdown（人类可读），'dt' 为 DocTags（LLM 友好）。默认：'md'。",
        },
        heading: {
          type: "string",
          description:
            "要提取的页面内特定章节标题。",
        },
        tokenBudget: {
          type: "number",
          description:
            "按文档 ID 展开时返回的最大 token 数。⚠️ 此参数会覆盖 targetLevel——系统自动在预算内选择最深层级，可能返回比你要求的更低的层级。如果需要特定层级的完整内容，请只用 targetLevel 不要设置 tokenBudget。",
        },
      },
    },
    async execute(input: Record<string, unknown>) {
      try {
        // Scope enforcement for explicit kbId parameter
        if (input.kbId) {
          const scopeError = validateKbIdScope(input.kbId as string);
          if (scopeError) return { error: scopeError };
        }

        // Scope enforcement for pageId: look up the page to check its kb_id
        if (input.pageId && !input.kbId) {
          const repos = await getRepos();
          const page = await repos.wikiPage.getById(input.pageId as string);
          if (page?.kb_id) {
            const scopeError = validateKbIdScope(page.kb_id);
            if (scopeError) return { error: scopeError };
          }
        }

        // Scope enforcement for docId (without kbId): look up the document's kb_id
        if (input.docId && !input.kbId && !input.pageId) {
          const repos = await getRepos();
          const doc = await repos.document.getById(input.docId as string);
          if (doc?.kb_id) {
            const scopeError = validateKbIdScope(doc.kb_id);
            if (scopeError) return { error: scopeError };
          }
        }

        // Mode 0: Batch expand multiple documents
        if (Array.isArray(input.docIds) && input.docIds.length > 0) {
          const docIds = input.docIds as string[];
          const format = (input.format as "md" | "dt" | undefined) || "md";
          const kbId = input.kbId as string | undefined;
          const targetLevel = (input.targetLevel as "L0" | "L1" | undefined) || "L1";

          // Use optimized batch method when kbId is provided (2-4 DB queries vs N×4)
          if (kbId) {
            const batchResults = await deps.expander.batchExpand(kbId, docIds, format, targetLevel);
            const foundIds = new Set(batchResults.map(r => r.docId));

            // Detect multi-chunk documents (same docId appears multiple times)
            const docChunkCounts = new Map<string, number>();
            for (const r of batchResults) {
              docChunkCounts.set(r.docId, (docChunkCounts.get(r.docId) || 0) + 1);
            }
            const docChunkIndex = new Map<string, number>();
            const results: Array<Record<string, unknown>> = batchResults.map(r => {
              const totalChunks = docChunkCounts.get(r.docId) || 1;
              const isMultiChunk = totalChunks > 1;
              const chunkIndex = isMultiChunk ? (docChunkIndex.get(r.docId) || 0) : undefined;
              if (isMultiChunk) docChunkIndex.set(r.docId, chunkIndex! + 1);

              const base: Record<string, unknown> = {
                docId: r.docId,
                title: r.title,
                level: targetLevel,
                tokenCount: r.tokenCount,
                filename: r.title, // title typically contains filename for batch results
              };

              if (isMultiChunk) {
                base.chunkInfo = { multiChunk: true, chunkIndex, totalChunks };
              }

              if (!r.content) {
                base.content = "";
                base.warning = `Expand returned empty content. Fallback: use read_file to read the raw parsed content at wiki/${kbId}/documents/${r.docId}/parsed.md`;
              } else {
                base.content = r.content;
                // Warn if token_count is 0 but content exists (legacy modality data)
                if (r.tokenCount === 0) {
                  base.warning = `Expand returned content with token_count=0 (data may be from an older import). Content is valid.`;
                }
              }
              return base;
            });
            // Add error entries for docs not found
            for (const docId of docIds) {
              if (!foundIds.has(docId)) {
                results.push({ docId, error: `No ${targetLevel} page found in KB ${kbId}. This may mean: (1) the document belongs to a different KB, try expand without kbId; (2) the document hasn't been processed yet, check status via wiki_browse; (3) try doc_grep to search for content directly` });
              }
            }
            return { mode: "batch", totalDocs: docIds.length, results };
          }

          // Fallback: individual expand when no kbId (slower but works)
          const results = await Promise.all(
            docIds.map(async (docId) => {
              try {
                const result = await deps.expander.expandToLevel(docId, targetLevel === "L0" ? "L0" : "L1", format);
                if (!result.content) {
                  return {
                    docId: result.docId,
                    title: result.title,
                    level: result.level,
                    content: "",
                    tokenCount: result.tokenCount,
                    warning: `Expand returned empty content. Fallback: use read_file to read the raw parsed content. Use wiki_browse(listDocuments=true) or check manifest.json for the document's parsed.md path.`,
                  };
                }
                const base: Record<string, unknown> = {
                  docId: result.docId,
                  title: result.title,
                  level: result.level,
                  content: result.content,
                  tokenCount: result.tokenCount,
                };
                if (result.tokenCount === 0) {
                  base.warning = `Expand returned content with token_count=0 (data may be from an older import). Content is valid.`;
                }
                return base;
              } catch {
                return { docId, error: `Expand failed. Fallback: use read_file to read the raw parsed content. Use wiki_browse(listDocuments=true) or check manifest.json for the document's parsed.md path.` };
              }
            }),
          );
          return {
            mode: "batch",
            totalDocs: docIds.length,
            results,
          };
        }

        // Mode 1: Expand a specific section by heading
        if (input.heading && input.pageId) {
          const result = await deps.expander.expandSection(
            input.pageId as string,
            input.heading as string,
          );

          if (!result) {
            return {
              error: `Section "${input.heading}" not found in page ${input.pageId}`,
            };
          }

          return {
            pageId: result.pageId,
            docId: result.docId,
            level: result.level,
            title: result.title,
            content: result.content,
            tokenCount: result.tokenCount,
          };
        }

        // Mode 2: Expand with token budget (automatically picks level)
        if (input.docId && input.tokenBudget) {
          const result = await deps.expander.expandWithBudget(
            input.docId as string,
            input.tokenBudget as number,
          );

          // Warn if targetLevel was requested but budget was too small
          const budgetWarning = input.targetLevel && result.level !== input.targetLevel
            ? { warning: `tokenBudget was too small for requested level ${input.targetLevel}, returned ${result.level} instead. To get ${input.targetLevel}, increase tokenBudget or remove it and use targetLevel directly.` }
            : {};

          const doc = await repos.document.getById(result.docId).catch(() => undefined);
          return {
            pageId: result.pageId,
            docId: result.docId,
            filename: doc?.filename,
            level: result.level,
            title: result.title,
            content: result.content,
            tokenCount: result.tokenCount,
            ...budgetWarning,
            ...(result.tokenCount === 0 || !result.content
              ? { warning: `Expand returned empty content. Fallback: use read_file to read the raw parsed content. Use wiki_browse(listDocuments=true) or check manifest.json for the document's parsed.md path.` }
              : {}),
            childPages: result.childPages
              ? result.childPages.map((cp) => ({
                  pageId: cp.pageId,
                  level: cp.level,
                  title: cp.title,
                  tokenCount: cp.tokenCount,
                }))
              : undefined,
          };
        }

        // Mode 3: Expand to a specific target level by docId
        if (input.docId && input.targetLevel) {
          const result = await deps.expander.expandToLevel(
            input.docId as string,
            input.targetLevel as "L0" | "L1" | "L2",
            input.format as "md" | "dt" | undefined,
          );

          const doc = await repos.document.getById(result.docId).catch(() => undefined);
          return {
            pageId: result.pageId,
            docId: result.docId,
            filename: doc?.filename,
            level: result.level,
            title: result.title,
            content: result.content,
            tokenCount: result.tokenCount,
            ...(result.anchors && result.anchors.length > 0 ? { anchors: result.anchors } : {}),
            ...(result.tokenCount === 0 || !result.content
              ? { warning: `Expand returned empty content. Fallback: use read_file to read the raw parsed content. Use wiki_browse(listDocuments=true) or check manifest.json for the document's parsed.md path.` }
              : {}),
            childPages: result.childPages
              ? result.childPages.map((cp) => ({
                  pageId: cp.pageId,
                  level: cp.level,
                  title: cp.title,
                  tokenCount: cp.tokenCount,
                }))
              : undefined,
          };
        }

        // Mode 4: Expand a page by pageId (returns current level + child pages)
        if (input.pageId) {
          const result = await deps.expander.expand(
            input.pageId as string,
          );

          const doc = result.docId ? await repos.document.getById(result.docId).catch(() => undefined) : undefined;
          return {
            pageId: result.pageId,
            docId: result.docId,
            filename: doc?.filename,
            level: result.level,
            title: result.title,
            content: result.content,
            tokenCount: result.tokenCount,
            ...(result.anchors && result.anchors.length > 0 ? { anchors: result.anchors } : {}),
            ...(result.tokenCount === 0 || !result.content
              ? { warning: `Expand returned empty content. Fallback: use read_file to read the raw parsed content. Use wiki_browse(listDocuments=true) or check manifest.json for the document's parsed.md path.` }
              : {}),
            childPages: result.childPages
              ? result.childPages.map((cp) => ({
                  pageId: cp.pageId,
                  level: cp.level,
                  title: cp.title,
                  tokenCount: cp.tokenCount,
                }))
              : undefined,
          };
        }

        return {
          error:
            'Provide at least "pageId" or "docId". Use "targetLevel" or "tokenBudget" with docId, or "heading" with pageId.',
        };
      } catch (err) {
        return {
          error: `Expand failed: ${err instanceof Error ? err.message : String(err)}. Fallback: use read_file to read the raw parsed content. Use wiki_browse(listDocuments=true) or check manifest.json for the document's parsed.md path.`,
        };
      }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresKbScope: true,
  });

  // -----------------------------------------------------------------------
  // timeline_build tool
  // -----------------------------------------------------------------------

  const timelineTool = createTimelineTool({ retriever: deps.retriever, dataDir: deps.dataDir });
  registry.register({
    ...timelineTool,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    shouldDefer: true,
  });

  // -----------------------------------------------------------------------
  // graph_build tool — build entity relationship graph from wiki pages
  // -----------------------------------------------------------------------

  const graphTool = createGraphTool({ retriever: deps.retriever, linker: deps.linker, dataDir: deps.dataDir });
  registry.register({
    ...graphTool,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    shouldDefer: true,
  });

  // -----------------------------------------------------------------------
  // image_analysis tool — analyze images using VLM
  // -----------------------------------------------------------------------

  registry.register({
    name: "image_analysis",
    description:
      "使用视觉语言模型（VLM）分析图片。" +
      "⚠️ 知识库中的图片在入库时已经过 VLM 分析，其描述已记录在 L1 层级内容中。" +
      "日常分析应使用 expand 获取图片的 L1 内容（含预编译 VLM 描述和 OCR），而非调用本工具重新分析。" +
      "本工具仅用于以下场景：(1) expand 返回的 VLM 描述为空或明显不完整，需要二次确认；" +
      "(2) 对特定图片有新的、更细致的分析需求（如提取特定区域的文字、对比差异等）；" +
      "(3) 分析知识库之外的图片（外部URL或文件路径）。" +
      "支持五种图片引用方式：" +
      "1) session-media://{sessionId}/{mediaId} 聊天会话中的媒体文件；" +
      "2) kb://{kbId}/{docId} 引用知识库中的图片文档；" +
      "3) http(s)://... 外部图片URL；" +
      "4) data:image/... base64 data URI；" +
      "5) 服务器本地文件路径。",
    inputSchema: {
      type: "object",
      properties: {
        imageRef: {
          type: "string",
          description: "图片引用。支持格式：session-media://{sessionId}/{mediaId}（会话媒体）、kb://{kbId}/{docId}（知识库图片）、http(s)://（URL）、data:image/（base64）、本地文件路径。",
        },
        prompt: {
          type: "string",
          description: "分析指令，如：描述图片内容、提取文字、比较差异等。",
        },
      },
      required: ["imageRef", "prompt"],
    },
    async execute(input: Record<string, unknown>) {
      const imageRef = input.imageRef as string;
      const prompt = input.prompt as string;

      if (!imageRef || !prompt) {
        return { error: "imageRef and prompt are required." };
      }

      try {
        const { CapabilityDispatcher } = await import("../../models/capability-dispatcher.js");
        const dispatcher = new CapabilityDispatcher();

        let imageDataUrl: string;

        // session-media://{sessionId}/{mediaId} — chat session media
        if (imageRef.startsWith("session-media://")) {
          const path = imageRef.slice("session-media://".length);
          const [sessionId, mediaId] = path.split("/");
          if (!sessionId || !mediaId) {
            return { content: `无效的 session-media 引用格式: ${imageRef}` };
          }
          const { MediaStore } = await import("../../services/session/media-store.js");
          const dataUri = await MediaStore.toDataUri(deps.dataDir, sessionId, mediaId);
          if (!dataUri) {
            return { content: `找不到媒体文件: ${imageRef}` };
          }
          imageDataUrl = dataUri;
        } else if (imageRef.startsWith("kb://")) {
          // KB reference: kb://{kbId}/{docId} → resolve to actual file path and read directly
          const match = imageRef.match(/^kb:\/\/([^/]+)\/([^/]+)$/);
          if (!match) {
            return { error: "Invalid kb:// reference format. Use: kb://{kbId}/{docId}" };
          }
          const [, kbId, docId] = match;
          // Resolve file path from database instead of using HTTP URL
          // (HTTP localhost URLs are inaccessible to external VLM providers)
          try {
            const repos = await getRepos();
            const doc = await repos.document.getById(docId);
            if (!doc) {
              return { error: `Document ${docId} not found in knowledge base.` };
            }
            const filePath = doc.file_path;
            if (!filePath) {
              return { error: `Document ${docId} has no file_path recorded.` };
            }
            const buffer = await readFile(filePath);
            const ext = filePath.split(".").pop()?.toLowerCase() ?? "png";
            const mimeMap: Record<string, string> = {
              png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
              gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
              svg: "image/svg+xml",
            };
            const mime = mimeMap[ext] ?? "image/png";
            imageDataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
          } catch (resolveErr) {
            const msg = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
            return { error: `Failed to resolve kb:// image: ${msg}` };
          }
        } else if (imageRef.startsWith("http://") || imageRef.startsWith("https://")) {
          // Direct URL — pass as-is to VLM
          imageDataUrl = imageRef;
        } else if (imageRef.startsWith("data:image/")) {
          // Base64 data URI — pass as-is
          imageDataUrl = imageRef;
        } else {
          // Local file path — read and convert to base64 data URI
          const resolvedPath = isAbsolute(imageRef) ? imageRef : resolve(process.cwd(), imageRef);
          const buffer = await readFile(resolvedPath);
          const ext = resolvedPath.split(".").pop()?.toLowerCase() ?? "png";
          const mimeMap: Record<string, string> = {
            png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
            gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
            svg: "image/svg+xml",
          };
          const mime = mimeMap[ext] ?? "image/png";
          imageDataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
        }

        const result = await dispatcher.analyzeImage(imageDataUrl, prompt);
        return { analysis: result.content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Image analysis failed: ${msg}` };
      }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });

  // -----------------------------------------------------------------------
  // reprocess_document tool — trigger document rebuild/reprocess
  // -----------------------------------------------------------------------

  registry.register({
    name: "reprocess_document",
    description:
      "触发知识库中指定文档的重新处理（重建）。用于文档处理失败、内容不正确、或需要更换处理器重新解析的场景。" +
      "支持单个文档重建（指定 docId）和批量重建（不指定 docId 则重建整个知识库的所有文档）。" +
      "force=true 时会清除旧数据并重新走完整处理流程（解析→编译→索引→质量审核）。" +
      "可以通过 processor 参数指定处理器类型覆盖自动检测。",
    inputSchema: {
      type: "object",
      properties: {
        kbId: {
          type: "string",
          description: "知识库 ID",
        },
        docId: {
          type: "string",
          description: "要重建的文档 ID。不指定则重建知识库所有文档。",
        },
        processor: {
          type: "string",
          enum: ["docling", "native", "asr"],
          description: "指定处理器类型。不指定则自动检测。docling=Docling解析器（支持PDF/DOCX/图片OCR），native=原生处理器（纯文本/表格），asr=语音转写",
        },
        force: {
          type: "boolean",
          description: "是否强制重建（清除旧数据重新处理）。默认 true。",
        },
      },
      required: ["kbId"],
    },
    async execute(input: Record<string, unknown>) {
      const kbId = input.kbId as string;
      const docId = input.docId as string | undefined;
      const processor = input.processor as string | undefined;
      const force = input.force !== false; // default true

      try {
        // Build target URL — single doc or entire KB
        const baseUrl = process.env.DEEPANALYZE_URL || "http://localhost:21000";
        if (docId) {
          // Single document reprocess
          const url = `${baseUrl}/api/knowledge/kbs/${kbId}/process/${docId}${force ? "?force=true" : ""}`;
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(processor ? { processor } : {}),
          });
          const result = await resp.json();
          if (!resp.ok) {
            return { error: `Reprocess failed: ${JSON.stringify(result)}` };
          }
          return { reprocessed: true, docId, ...result };
        } else {
          // Batch reprocess all documents in the KB
          const url = `${baseUrl}/api/knowledge/kbs/${kbId}/process-all${force ? "?force=true" : ""}`;
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(processor ? { processor } : {}),
          });
          const result = await resp.json();
          if (!resp.ok) {
            return { error: `Batch reprocess failed: ${JSON.stringify(result)}` };
          }
          return { reprocessed: true, batch: true, kbId, ...result };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Reprocess request failed: ${msg}` };
      }
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  });

  // -----------------------------------------------------------------------
  // push_content tool — push structured data directly to user frontend
  // -----------------------------------------------------------------------

  registry.register({
    name: "push_content",
    description:
      "推送结构化内容卡片到前端。**推送文件用 filePath 参数**，推送短数据用 data 参数（<2000字）。" +
      "对于长内容（报告、分析文档等），必须使用 filePath 指定文件路径。" +
      "工作流：先用 write_file 写入文件，再用 push_content 的 filePath 推送。请确认 filePath 使用的是 write_file 返回的实际路径。" +
      "data 参数不适合长内容（受输出 token 限制）。" +
      "支持 type=table/markdown/text/code/file/chart/image/audio/video。",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["table", "text", "code", "file", "markdown", "chart", "image", "audio", "video"],
          description: "内容类型：table=表格数据, text=纯文本, code=代码块, file=文件引用, markdown=Markdown格式, chart=ECharts图表, image=图片URL, audio=音频URL, video=视频URL",
        },
        title: {
          type: "string",
          description: "内容标题（显示在卡片顶部）",
        },
        data: {
          type: "string",
          description: "内容数据。table类型传入CSV或JSON字符串；code类型传入代码；text/markdown类型传入文本内容。与 filePath 二选一。",
        },
        filePath: {
          type: "string",
          description: "要推送的文件路径（推荐用于长内容）。工具直接读取文件并推送完整内容，不经过你的上下文。支持 data 目录下的相对路径（如 tmp/report.md）或绝对路径。与 data 二选一，filePath 优先。",
        },
        format: {
          type: "string",
          description: "格式提示（如 csv, json, python, sql, markdown 等）",
        },
        force: {
          type: "boolean",
          description: "可选，设为 true 可强制重新推送（绕过去重检查）。仅当用户明确要求重新推送同一内容时使用。",
        },
      },
      required: ["type", "title"],
    },
    async execute(input: Record<string, unknown>) {
      const contentType = input.type as string;
      const title = input.title as string;
      const format = input.format as string | undefined;
      let data = input.data as string | undefined;
      const filePath = input.filePath as string | undefined;
      let resolvedFilePath: string | undefined;

      // If filePath is provided, read the file directly
      if (filePath) {
        try {
          if (isAbsolute(filePath)) {
            resolvedFilePath = filePath;
          } else {
            // Strip leading "data/" if present — we add it ourselves.
            // Models often pass "data/tmp/file.md" but we resolve relative to "data/" already.
            const normalized = filePath.startsWith("data/") || filePath.startsWith("data\\")
              ? filePath.slice(5)
              : filePath;
            resolvedFilePath = resolve(deps.dataDir, normalized);

            // If file not found at direct path, try session output directory
            // (write_file remaps filenames with makeAgentFilename, so the original
            // path may not exist — fuzzy match against the actual prefixed name)
            if (!existsSync(resolvedFilePath) && !isSharedDataPath(normalized)) {
              const ctx = registry.getExecutionContext();
              const sid = ctx?.sessionId as string | undefined;
              if (sid) {
                const sessionPath = resolveSessionOutputPath(normalized, deps.dataDir, sid);
                if (sessionPath !== resolvedFilePath && existsSync(sessionPath)) {
                  resolvedFilePath = sessionPath;
                }
              }
            }
          }
          // Reject binary files — push_content is for text content only.
          // Binary files produce null bytes that crash PostgreSQL JSONB columns.
          const ext = extname(resolvedFilePath).toLowerCase();
          const BINARY_EXTENSIONS = new Set([
            ".pptx", ".xlsx", ".xls", ".docx", ".doc", ".pdf", ".zip", ".gz",
            ".tar", ".rar", ".7z", ".png", ".jpg", ".jpeg", ".gif", ".bmp",
            ".ico", ".webp", ".svg", ".mp3", ".mp4", ".wav", ".avi", ".mov",
            ".wmv", ".flv", ".mkv", ".ogg", ".opus", ".sqlite", ".db",
          ]);
          if (BINARY_EXTENSIONS.has(ext)) {
            return {
              error: `Cannot push binary file "${ext}" as text content. Use push_file instead to deliver binary files to the user.`,
            };
          }

          const content = await readFile(resolvedFilePath, "utf-8");
          data = content;
          if (!data || data.length === 0) {
            return { pushed: false, error: `File "${filePath}" is empty. Ensure the sub-agent wrote its output before pushing.` };
          }
          if (data.length < 50) {
            console.warn(`[push_content] File "${resolvedFilePath}" has very short content (${data.length} chars): "${data.slice(0, 100)}"`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[push_content] Failed to read file: ${filePath} (resolved: ${resolvedFilePath}) — ${errMsg}`);
          return {
            error: `Failed to read file: ${filePath} — ${errMsg}`,
          };
        }
      }

      if (!data) {
        return { error: "No data provided. Either 'data' or 'filePath' must be supplied." };
      }

      // Size limits: filePath-based pushes can be larger (up to 10MB inline data for SSE),
      // data-parameter pushes capped at 2MB (model output token limit makes larger unlikely anyway)
      const maxDataSize = filePath ? 10_000_000 : 2_000_000;

      // Content quality diagnostic — not a gate, just feedback for the Agent to self-correct.
      // Heuristic: when the title implies a substantial deliverable but content is very short,
      // the Agent may have pushed placeholder text or an incomplete sub-agent output.
      const diagnostic: string[] = [];
      if (data.length < 100 && /报告|分析|总结|白皮书|研究|概览|综合|详细|完整/.test(title)) {
        diagnostic.push(
          `内容长度（${data.length}字符）与标题"${title}"暗示的深度不匹配。` +
          `如果分析尚未完成，请先补充内容再推送；如果是简短总结，建议直接文字输出而非使用 push_content。`
        );
      }
      if (filePath && data.length < 50) {
        diagnostic.push(
          `文件内容仅 ${data.length} 字符。如果是子 Agent 的输出，` +
          `可能子 Agent 尚未完成写入就结束了。建议用 read_file 检查文件是否完整。`
        );
      }

      return {
        pushed: true,
        type: contentType,
        title,
        data: data.slice(0, maxDataSize),
        dataLength: data.length,        // Original length for frontend info
        format,
        timestamp: new Date().toISOString(),
        filePath: resolvedFilePath,     // Pass resolved path so frontend can reference it
        ...(diagnostic.length > 0 ? { qualityWarning: diagnostic.join(" ") } : {}),
      };
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
  });

  // -----------------------------------------------------------------------
  // push_file tool — push any file (including binary) to frontend for download/preview
  // -----------------------------------------------------------------------

  registry.register({
    name: "push_file",
    description:
      "推送文件到前端供用户下载或预览。支持所有文件类型（PPT、PDF、压缩包、图片、音视频等）。" +
      "filePath 指定要推送的文件路径（支持 write_file 生成的路径或 bash 命令创建的文件的绝对路径）。" +
      "多媒体文件（图片/音频/视频）会在聊天窗口中直接显示或播放；其他文件类型显示为可下载的文件卡片。" +
      "与 push_content 的区别：push_file 专门用于推送二进制文件或需要以文件形式下载的内容，" +
      "push_content 用于推送文本内容（markdown、表格、代码等）到前端内联显示。",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "要推送的文件路径。支持绝对路径或相对于 data 目录的相对路径。如果是 write_file 返回的路径，直接使用即可。",
        },
        title: {
          type: "string",
          description: "文件标题或描述（显示在文件卡片上）",
        },
        mimeType: {
          type: "string",
          description: "可选，文件的 MIME 类型。不提供时根据文件扩展名自动推断。",
        },
        force: {
          type: "boolean",
          description: "可选，设为 true 可强制重新推送（绕过去重检查）。仅当用户明确要求重新推送同一文件时使用。",
        },
      },
      required: ["filePath", "title"],
    },
    async execute(input: Record<string, unknown>) {
      const rawPath = input.filePath as string;
      const title = input.title as string;
      const explicitMime = input.mimeType as string | undefined;

      // Resolve file path
      let resolvedPath: string;
      if (isAbsolute(rawPath)) {
        resolvedPath = rawPath;
      } else {
        const normalized = rawPath.startsWith("data/") || rawPath.startsWith("data\\")
          ? rawPath.slice(5)
          : rawPath;
        resolvedPath = resolve(deps.dataDir, normalized);

        // Try session output directory fuzzy match (same as push_content)
        if (!existsSync(resolvedPath) && !isSharedDataPath(normalized)) {
          const ctx = registry.getExecutionContext();
          const sid = ctx?.sessionId as string | undefined;
          if (sid) {
            const sessionPath = resolveSessionOutputPath(normalized, deps.dataDir, sid);
            if (sessionPath !== resolvedPath && existsSync(sessionPath)) {
              resolvedPath = sessionPath;
            }
          }
        }
      }

      // Security: must be under dataDir
      if (!resolvedPath.startsWith(resolve(deps.dataDir))) {
        return {
          error: "Access denied: path outside data directory. " +
            "File tools (read_file/write_file/edit_file/grep/glob/push_file) are sandboxed to the data directory. " +
            "For full filesystem access (e.g. /etc/hosts, /tmp, project source files), use the bash tool — it has no sandbox restrictions.",
        };
      }

      // Check file exists
      if (!existsSync(resolvedPath)) {
        return { error: `File not found: ${rawPath}` };
      }

      // Get file stats
      let fileStat;
      try {
        fileStat = statSync(resolvedPath);
      } catch {
        return { error: `Cannot stat file: ${rawPath}` };
      }
      if (!fileStat.isFile()) {
        return { error: `Path is not a file: ${rawPath}` };
      }

      const fileName = resolvedPath.split(/[/\\]/).pop() || "file";
      const fileSize = fileStat.size;

      // Infer MIME type from extension
      const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
      const mimeMap: Record<string, string> = {
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ppt: "application/vnd.ms-powerpoint",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        doc: "application/msword",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        xls: "application/vnd.ms-excel",
        pdf: "application/pdf",
        zip: "application/zip",
        "7z": "application/x-7z-compressed",
        rar: "application/vnd.rar",
        tar: "application/x-tar",
        gz: "application/gzip",
        bz2: "application/x-bzip2",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        ogg: "audio/ogg",
        flac: "audio/flac",
        mp4: "video/mp4",
        webm: "video/webm",
        avi: "video/x-msvideo",
        mov: "video/quicktime",
        mkv: "video/x-matroska",
        txt: "text/plain",
        csv: "text/csv",
        json: "application/json",
        xml: "application/xml",
        html: "text/html",
        md: "text/markdown",
      };
      const mimeType = explicitMime || mimeMap[ext] || "application/octet-stream";

      // Ensure file is in session output directory (copy if needed)
      const ctx = registry.getExecutionContext();
      const sid = ctx?.sessionId as string | undefined;
      if (!sid) {
        return { error: "No session context — push_file requires an active session" };
      }

      const outputDir = getSessionOutputDir(deps.dataDir, sid);
      mkdirSync(outputDir, { recursive: true });

      let finalFileName = fileName;
      // If file is not already in output dir, copy it there
      if (!resolvedPath.startsWith(outputDir)) {
        // Use makeAgentFilename for uniqueness
        const prefixed = makeAgentFilename("main", fileName);
        finalFileName = prefixed;
        const destPath = join(outputDir, finalFileName);
        await copyFileAsync(resolvedPath, destPath);
      } else {
        // File is already in output dir — use its basename
        finalFileName = resolvedPath.split(/[/\\]/).pop() || fileName;
      }

      // Build download URL
      const downloadUrl = `/api/sessions/${sid}/output/${encodeURIComponent(finalFileName)}`;

      return {
        pushed: true,
        type: "file",
        title,
        fileName: finalFileName,
        fileSize,
        mimeType,
        downloadUrl,
        timestamp: new Date().toISOString(),
      };
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
  });

  // -----------------------------------------------------------------------
  // list_pushed_content tool — query what has been pushed to the frontend
  // -----------------------------------------------------------------------

  registry.register({
    name: "list_pushed_content",
    description:
      "查询当前 session 中已经推送到前端的内容列表（push_file / push_content 的历史记录）。" +
      "用于在推送前检查是否已经推送过相同内容，避免重复推送。" +
      "返回每条记录的标题、类型、文件名、大小、时间戳和内容哈希。",
    inputSchema: {
      type: "object",
      properties: {},
    },
    async execute() {
      const ctx = registry.getExecutionContext();
      const getHistory = ctx?._getPushedHistory as (() => Array<{
        hash: string;
        toolName: string;
        title: string;
        timestamp: string;
        fileName?: string;
        fileSize?: number;
        mimeType?: string;
      }>) | undefined;
      if (!getHistory) {
        return { items: [], note: "No session context — pushed history is not available." };
      }
      const items = getHistory();
      return {
        totalPushed: items.length,
        items: items.map((e) => ({
          title: e.title,
          pushedVia: e.toolName,
          fileName: e.fileName,
          fileSize: e.fileSize,
          mimeType: e.mimeType,
          timestamp: e.timestamp,
          contentHash: e.hash.substring(0, 8),
        })),
      };
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
  });

  // -----------------------------------------------------------------------
  // agent_todo tool — task list management
  // -----------------------------------------------------------------------

  registry.register({
    name: "agent_todo",
    description:
      "任务清单管理工具。用于规划和跟踪复杂任务的执行进度。" +
      "当任务需要多个步骤或多轮搜索时，先用此工具制定清单，再逐一完成并更新状态。" +
      "这确保你不会遗漏任何步骤，用户也能实时看到你的工作进度。" +
      "建议：涉及 3 个以上子步骤的任务都应先创建清单。" +
      "action=create 批量创建（提供 todos 数组）或单条创建（提供 subject）。" +
      "action=update 更新任务状态（提供 id 和 status：pending/in_progress/completed）。" +
      "action=list 查看当前清单。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "list"],
          description: "操作类型：create 创建任务，update 更新状态，list 查看清单",
        },
        id: {
          type: "string",
          description: "任务 ID（update 操作必填）",
        },
        subject: {
          type: "string",
          description: "任务标题（create 操作必填）",
        },
        description: {
          type: "string",
          description: "任务详情（create 操作可选）",
        },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed"],
          description: "任务状态（update 操作必填）",
        },
        todos: {
          type: "array",
          description: "批量设置完整任务清单（可选，覆盖式更新）",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              subject: { type: "string" },
              description: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["id", "subject", "status"],
          },
        },
      },
      required: ["action"],
    },
    async execute(input: Record<string, unknown>) {
      const action = input.action as string;

      // Bulk set mode: Agent provides the full todo list
      if (action === "create" && Array.isArray(input.todos)) {
        const todos = input.todos as Array<Record<string, unknown>>;

        const lines = todos.map((t) => {
          // Coerce to string at runtime — LLM may pass objects instead of strings
          const id = String(t.id ?? `task-${Date.now()}`);
          const subject = typeof t.subject === "string" ? t.subject : String(t.subject ?? "");
          const description = t.description != null ? String(t.description) : "";
          const status = String(t.status ?? "pending");
          const icon = status === "completed" ? "✅" : status === "in_progress" ? "🔄" : "⬜";
          return `${icon} [${id}] ${subject}${description ? ` — ${description}` : ""} (${status})`;
        });

        return {
          action: "bulk_set",
          total: todos.length,
          completed: todos.filter((t) => t.status === "completed").length,
          inProgress: todos.filter((t) => t.status === "in_progress").length,
          pending: todos.filter((t) => t.status === "pending").length,
          todos: lines.join("\n"),
        };
      }

      // Single create
      if (action === "create") {
        const id = String(input.id ?? `task-${Date.now()}`);
        const subject = typeof input.subject === "string" ? input.subject : String(input.subject ?? "");
        const description = input.description != null ? String(input.description) : "";
        const status = "pending";

        if (!subject) {
          return { error: "subject is required for create action" };
        }

        const icon = "⬜";
        const line = `${icon} [${id}] ${subject}${description ? ` — ${description}` : ""} (${status})`;
        return {
          action: "created",
          todos: line,
        };
      }

      // Update
      if (action === "update") {
        const id = String(input.id ?? "");
        const status = String(input.status ?? "");

        if (!id || !status) {
          return { error: "id and status are required for update action" };
        }

        const icon = status === "completed" ? "✅" : status === "in_progress" ? "🔄" : "⬜";
        const line = `${icon} [${id}] status → ${status} (${status})`;
        return {
          action: "updated",
          todos: line,
        };
      }

      // List
      if (action === "list") {
        return {
          action: "list",
          message: "Use the todos in your context to review task progress. Create or update tasks as needed.",
        };
      }

      return { error: `Unknown action: ${action}` };
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  });

  // -----------------------------------------------------------------------
  // doc_grep tool — regex search across wiki page content
  // -----------------------------------------------------------------------

  registry.register({
    name: "doc_grep",
    description:
      "正则搜索知识库中 wiki 页面的实际内容文本。**覆盖度最高的搜索工具**——遍历所有页面查找匹配，不会遗漏任何包含目标文本的文档。\n" +
      "支持精确匹配人名、日期、编号、金额、特定短语等。返回匹配的页面列表及匹配行上下文（默认最多30条）。\n" +
      "**与 kb_search 的区别**：kb_search 是 top-K 近似检索（必然遗漏不在 top-K 中的内容），doc_grep 是全量精确匹配（不遗漏但只能匹配你指定的字符串）。\n" +
      "**推荐用法**：当需要确保某关键词/实体在知识库中的所有出现都被找到时，优先使用 doc_grep 而非 kb_search。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "正则表达式模式。如：'\\d{4}-\\d{2}-\\d{2}'、'error|warning|fail'、'[A-Z]{2,4}-\\d{3,6}'",
        },
        kbIds: {
          type: "array",
          items: { type: "string" },
          description: "搜索的知识库 ID 列表。省略则搜索所有知识库。",
        },
        pageTypes: {
          type: "array",
          items: { type: "string" },
          description: "页面类型过滤（abstract, overview, fulltext, structure_md 等）。默认搜索所有非 report 类型。",
        },
        maxResults: {
          type: "number",
          description: "最大返回结果数（默认 30）",
        },
      },
      required: ["pattern"],
    },
    async execute(input: Record<string, unknown>) {
      const pattern = input.pattern as string;
      const kbIds = (input.kbIds as string[]) || [];
      const pageTypes = (input.pageTypes as string[]) || undefined;
      const maxResults = (input.maxResults as number) || 30;

      if (!pattern) {
        return { error: "pattern is required" };
      }

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, "i");
      } catch {
        return { error: `Invalid regex pattern: ${pattern}` };
      }

      const repos = await getRepos();

      // Determine which KBs to search
      let searchKbIds = kbIds;
      if (searchKbIds.length === 0) {
        // Use session scope if available, otherwise all KBs
        const ctx = registry.getExecutionContext();
        const sessionScope = ctx.scopeKbIds as string[] | undefined;
        if (sessionScope && sessionScope.length > 0) {
          searchKbIds = sessionScope;
        } else {
          const allKbs = await repos.knowledgeBase.list();
          searchKbIds = allKbs.map((kb) => kb.id);
        }
      } else {
        // Scope enforcement: filter explicit kbIds against session scope
        const { filtered, warning } = filterKbIdsToScope(searchKbIds);
        if (filtered.length === 0) {
          return { matches: [], total: 0, message: warning || "All specified KBs are outside session scope." };
        }
        searchKbIds = filtered;
      }

      // Build page type filter — default exclude report pages
      const effectivePageTypes = pageTypes ?? [
        "abstract", "overview", "fulltext",
        "structure_md", "structure_dt", "entity", "concept",
      ];

      const allMatches: Array<{
        pageId: string;
        docId: string;
        kbId: string;
        pageType: string;
        title: string;
        matchedLines: string[];
      }> = [];

      // --- FTS-accelerated path ---
      // Use PG full-text search (fts_vector + GIN index) to pre-filter candidate pages,
      // then apply regex to extract matched lines with context. Falls back to full regex
      // scan when the pattern contains regex syntax that FTS can't handle.
      const isSimplePattern = /^[a-zA-Z0-9\u4e00-\u9fff\s]+$/.test(pattern);
      let totalFtsMatches = 0;

      if (isSimplePattern && searchKbIds.length > 0) {
        // FTS path: use PG chinese text search config for initial filtering
        try {
          const { getPool } = await import("../../store/pg.js");
          const pool = await getPool();

          // Count query params: [pattern, ...pageTypes, ...kbIds] — no limit
          const countPtPlaceholders = effectivePageTypes.map((_, i) => `$${i + 2}`).join(",");
          const countKbPlaceholders = searchKbIds.map((_, i) => `$${effectivePageTypes.length + 2 + i}`).join(",");

          // Get total count (separate params — count query does not reference limit)
          const limit = Math.min(maxResults * 3, 500);
          const countParams = [pattern, ...effectivePageTypes, ...searchKbIds];
          const countResult = await pool.query(
            `SELECT COUNT(*) as cnt FROM wiki_pages
             WHERE fts_vector @@ plainto_tsquery('chinese', $1)
             AND page_type IN (${countPtPlaceholders})
             AND kb_id IN (${countKbPlaceholders})`,
            countParams,
          );
          totalFtsMatches = parseInt(countResult.rows[0]?.cnt || "0", 10);

          // Candidate query params: [pattern, limit, ...pageTypes, ...kbIds]
          const candPtPlaceholders = effectivePageTypes.map((_, i) => `$${i + 3}`).join(",");
          const candKbPlaceholders = searchKbIds.map((_, i) => `$${effectivePageTypes.length + 3 + i}`).join(",");
          const candidateParams = [pattern, limit, ...effectivePageTypes, ...searchKbIds];
          const candidateResult = await pool.query(
            `SELECT id, doc_id, kb_id, page_type, title, content FROM wiki_pages
             WHERE fts_vector @@ plainto_tsquery('chinese', $1)
             AND page_type IN (${candPtPlaceholders})
             AND kb_id IN (${candKbPlaceholders})
             ORDER BY ts_rank(fts_vector, plainto_tsquery('chinese', $1)) DESC
             LIMIT $2`,
            candidateParams,
          );

          for (const row of candidateResult.rows) {
            if (allMatches.length >= maxResults) break;

            const content = row.content || "";
            const lines = content.split("\n");
            const matchedLines: string[] = [];

            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                const start = Math.max(0, i - 1);
                const end = Math.min(lines.length, i + 2);
                const contextBlock = lines.slice(start, end).join("\n");
                matchedLines.push(`L${i + 1}: ${contextBlock}`);
              }
            }

            if (matchedLines.length > 0) {
              allMatches.push({
                pageId: row.id,
                docId: row.doc_id,
                kbId: row.kb_id,
                pageType: row.page_type,
                title: row.title,
                matchedLines: matchedLines.slice(0, 5),
              });
            }
          }

          if (totalFtsMatches > 0 || allMatches.length > 0) {
            return {
              pattern,
              totalMatches: totalFtsMatches,
              hasMore: totalFtsMatches > maxResults,
              searchMode: "fts",
              matches: allMatches,
            };
          }
          // FTS returned 0 candidates — zhparser may not be configured for Chinese.
          // Fall through to full regex scan below.
        } catch (err) {
          // FTS query failed — fall through to full regex scan
          console.warn(`[doc_grep] FTS query failed, falling back to regex: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // --- Full regex scan fallback (original logic) ---
      for (const kbId of searchKbIds) {
        if (allMatches.length >= maxResults) break;

        for (const pt of effectivePageTypes) {
          if (allMatches.length >= maxResults) break;

          const pages = await repos.wikiPage.getByKbAndType(kbId, pt);

          for (const page of pages) {
            if (allMatches.length >= maxResults) break;

            const content = page.content || "";
            const lines = content.split("\n");
            const matchedLines: string[] = [];

            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                // Include 1 line of context before and after
                const start = Math.max(0, i - 1);
                const end = Math.min(lines.length, i + 2);
                const contextBlock = lines.slice(start, end).join("\n");
                matchedLines.push(`L${i + 1}: ${contextBlock}`);
              }
            }

            if (matchedLines.length > 0) {
              allMatches.push({
                pageId: page.id,
                docId: page.doc_id,
                kbId: page.kb_id,
                pageType: page.page_type,
                title: page.title,
                matchedLines: matchedLines.slice(0, 5), // Max 5 matched lines per page
              });
            }
          }
        }
      }

      return {
        pattern,
        totalMatches: allMatches.length,
        hasMore: allMatches.length >= maxResults,
        searchMode: "regex",
        matches: allMatches,
      };
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresKbScope: true,
  });

  // -----------------------------------------------------------------------
  // ask_user tool — agent asks user a question during analysis
  // -----------------------------------------------------------------------

  registry.register({
    name: "ask_user",
    description:
      "向用户提出问题并等待回答。用于任务范围确认、歧义消除、分析方向选择等场景。" +
      "例如：" +
      "1) '找到大量相关文档，需要分析全部还是只分析特定类别？' " +
      "2) '搜索到多个同名结果，你指的是哪一个？' " +
      "3) '初步分析已完成，是否需要继续深入某个方向？'" +
      "调用后会暂停当前任务，等待用户回复后继续。",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "要向用户提出的问题",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "可选的预设选项（最多 4 个），用户可以直接选择",
        },
      },
      required: ["question"],
    },
    async execute(input: Record<string, unknown>) {
      const question = input.question as string;
      const options = input.options as string[] | undefined;

      if (!question) {
        return { error: "question is required" };
      }

      // Access the ask_user callback from the execution context set by the route handler
      const ctx = registry.getExecutionContext();
      const askUserFn = ctx.askUserCallback as
        | ((question: string, options?: string[]) => Promise<string>)
        | undefined;

      if (!askUserFn) {
        return {
          answer: null,
          error: "ask_user not available in this context (no user connection)",
          fallback: "Proceed with best judgment",
        };
      }

      try {
        const answer = await askUserFn(question, options);
        return { answer };
      } catch (err) {
        return {
          answer: null,
          error: `ask_user failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });

  // -----------------------------------------------------------------------
  // write_file tool — create or overwrite files in the data directory
  // -----------------------------------------------------------------------

  registry.register({
    name: "write_file",
    description:
      "创建或覆盖文件。文件自动保存到当前 session 的输出目录（路径会加上 agent 前缀和时间戳）。" +
      "**返回值中的 path 字段是文件的实际保存路径**，后续 read_file、bash cat、push_content 引用此文件时必须使用返回的路径，而非你传入的原始路径。" +
      "可用于生成报告、代码、数据导出等。" +
      "对于大段输出内容，优先用 write_file 保存到文件再用 push_content 推送——这防止上下文窗口被填满。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径（相对于数据目录）",
        },
        content: {
          type: "string",
          description: "要写入的文件内容",
        },
      },
      required: ["path", "content"],
    },
    async execute(input: Record<string, unknown>) {
      const rawPath = input.path as string;
      const content = input.content as string;

      // Normalize path: strip "data/" prefix if present
      let normalizedPath = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
      if (normalizedPath.startsWith("data/") || normalizedPath.startsWith("data\\")) {
        normalizedPath = normalizedPath.slice(5);
      }

      let safePath: string;
      if (isSharedDataPath(normalizedPath)) {
        // Shared paths (wiki/, original/) → resolve to dataDir root
        safePath = resolve(deps.dataDir, normalizedPath);
      } else {
        // Relative paths → session output dir with agent prefix
        const ctx = registry.getExecutionContext();
        const sid = ctx?.sessionId as string | undefined;
        if (sid) {
          const outputDir = getSessionOutputDir(deps.dataDir, sid);
          mkdirSync(outputDir, { recursive: true });
          const prefixed = makeAgentFilename("main", normalizedPath.replace(/^\/+/, ""));
          safePath = resolve(outputDir, prefixed);
        } else {
          // No session context (e.g. test) → fall back to dataDir
          safePath = resolve(deps.dataDir, normalizedPath);
        }
      }
      if (!safePath.startsWith(resolve(deps.dataDir))) {
        return {
          error: "Access denied: path outside data directory. " +
            "File tools (read_file/write_file/edit_file/grep/glob/push_file) are sandboxed to the data directory. " +
            "For full filesystem access (e.g. /etc/hosts, /tmp, project source files), use the bash tool — it has no sandbox restrictions.",
        };
      }

      try {
        mkdirSync(dirname(safePath), { recursive: true });
        writeFileSync(safePath, content, "utf-8");
        // Return the actual path relative to dataDir so the Agent can use it with read_file
        const actualRelativePath = relative(deps.dataDir, safePath).replace(/\\/g, "/");
        return {
          success: true,
          path: actualRelativePath,
          bytesWritten: Buffer.byteLength(content, "utf-8"),
        };
      } catch (err) {
        return { error: `Failed to write file: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
  });

  // -----------------------------------------------------------------------
  // edit_file tool — edit files with old_string/new_string replacement
  // -----------------------------------------------------------------------

  registry.register({
    name: "edit_file",
    description:
      "编辑数据目录中的文件。通过精确匹配 old_string 并替换为 new_string 来修改文件内容。" +
      "old_string 必须与文件中的内容完全匹配（包括缩进）。" +
      "如果 old_string 在文件中出现多次，必须提供足够的上下文使其唯一。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径（相对于数据目录）",
        },
        old_string: {
          type: "string",
          description: "要替换的原始文本（必须精确匹配）",
        },
        new_string: {
          type: "string",
          description: "替换后的新文本",
        },
        replace_all: {
          type: "boolean",
          description: "是否替换所有匹配项（默认：false，仅替换第一个）",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
    async execute(input: Record<string, unknown>) {
      const { readFile, writeFile } = await import("fs/promises");
      const rawPath = input.path as string;
      const oldString = input.old_string as string;
      const newString = input.new_string as string;
      const replaceAll = (input.replace_all as boolean) || false;

      // Normalize path: strip "data/" prefix if present
      let normalizedPath = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
      if (normalizedPath.startsWith("data/") || normalizedPath.startsWith("data\\")) {
        normalizedPath = normalizedPath.slice(5);
      }

      const safePath = resolve(deps.dataDir, normalizedPath);
      if (!safePath.startsWith(resolve(deps.dataDir))) {
        return {
          error: "Access denied: path outside data directory. " +
            "File tools (read_file/write_file/edit_file/grep/glob/push_file) are sandboxed to the data directory. " +
            "For full filesystem access (e.g. /etc/hosts, /tmp, project source files), use the bash tool — it has no sandbox restrictions.",
        };
      }

      // Read-before-write enforcement: check if this file has been read in the current session
      const ctx = registry.getExecutionContext();
      const tracker = ctx._readFilesTracker as Set<string> | undefined;
      if (tracker && !tracker.has(safePath)) {
        return {
          error: `必须先用 read_file 读取 "${rawPath}" 后才能编辑。请先读取文件，确认内容后再修改。`,
          __needs_read_first__: true,
        };
      }

      try {
        const content = await readFile(safePath, "utf-8");

        // Count occurrences of old_string
        const occurrences = content.split(oldString).length - 1;

        if (occurrences === 0) {
          return {
            error: `old_string not found in file "${rawPath}". The string to replace was not found in the file content.`,
          };
        }

        if (occurrences > 1 && !replaceAll) {
          return {
            error: `old_string appears ${occurrences} times in file "${rawPath}". Provide more context to make the match unique, or set replace_all to true to replace all occurrences.`,
          };
        }

        const newContent = replaceAll
          ? content.replaceAll(oldString, newString)
          : content.replace(oldString, newString);

        await writeFile(safePath, newContent, "utf-8");
        return {
          success: true,
          path: rawPath,
          replacements: replaceAll ? occurrences : 1,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT")) {
          return { error: `File not found: ${rawPath}` };
        }
        return { error: `Failed to edit file: ${msg}` };
      }
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
  });

  // -----------------------------------------------------------------------
  // skill_invoke tool — invoke a user-defined skill
  // -----------------------------------------------------------------------

  registry.register({
    name: "skill_invoke",
    description:
      "调用已注册的自定义技能（Skill）。技能是针对特定场景优化的预定义工作流。" +
      "可用技能列表已在上下文中列出（<available-skills>）。当用户请求匹配某个技能时，直接调用。" +
      "技能会自动处理分块、并行、合成等复杂流程，比自己逐步处理更高效。",
    inputSchema: {
      type: "object",
      properties: {
        skill_name: {
          type: "string",
          description: "要调用的技能名称",
        },
        input: {
          type: "string",
          description: "传递给技能的任务描述",
        },
        mode: {
          type: "string",
          enum: ["inline", "fork", "sub_agent"],
          description:
            "调用模式。inline: 技能内容注入当前对话，模型在同一上下文中遵循技能指令。" +
            "fork: 独立子Agent执行，但继承父会话的对话历史（上下文分叉）。" +
            "sub_agent: 独立子Agent执行，全新上下文。默认 sub_agent。",
        },
      },
      required: ["skill_name", "input"],
    },
    async execute(inputParams: Record<string, unknown>) {
      // Accept both "skill_name" (schema name) and "name" (what LMs naturally use after seeing list_skills output)
      const skillName = (inputParams.skill_name ?? inputParams.name) as string;
      const taskInput = inputParams.input as string;
      const mode = (inputParams.mode as "inline" | "fork" | "sub_agent") ?? "sub_agent";

      try {
        const repos = await getRepos();

        // Source-aware resolution: get all skills with this name, pick by priority
        const sourcePriority = ["builtin", "hub", "plugin", "manual"];
        const allMatching = await repos.agentSkill.listByName(skillName);
        const activeSkills = allMatching.filter((s) => s.isActive);

        if (activeSkills.length === 0) {
          return { error: `Skill "${skillName}" not found or inactive. Use list_skills to see available skills.` };
        }

        // Pick highest priority source
        const skill = activeSkills.sort(
          (a, b) => sourcePriority.indexOf(a.source) - sourcePriority.indexOf(b.source),
        )[0]!;

        // High-cost skill gate: skills whose description starts with [高成本/按需触发]
        // require explicit user confirmation before execution. Return a confirmation
        // request instead of executing, forcing the LLM to ask the user.
        if (skill.description.startsWith("[高成本/按需触发]")) {
          const cleanDesc = skill.description.replace("[高成本/按需触发]", "").split("⚠️")[0].trim();
          return {
            __skill_confirmation_required__: true,
            skillName: skill.name,
            message:
              `⚠️ 技能 "${skill.name}" 是高成本操作。` +
              `功能：${cleanDesc}。` +
              `此技能运行时间长、消耗大量资源，仅在明确需要时才应执行。` +
              `请先向用户确认是否真的要执行此预处理操作。` +
              `如果用户只是在问问题、搜索信息、或做一般分析，不需要调用此技能。`,
          };
        }

        // Return the skill definition + input + mode for the agent runner to use
        // The runner will detect this special result and dispatch based on mode
        return {
          __skill_invoke__: true,
          skill: {
            name: skill.name,
            prompt: skill.prompt,
            tools: skill.tools,
            modelRole: skill.modelRole,
          },
          input: taskInput,
          mode,
        };
      } catch (err) {
        return { error: `Failed to load skill: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  });

  // -----------------------------------------------------------------------
  // list_skills tool — list available user-defined skills
  // -----------------------------------------------------------------------

  registry.register({
    name: "list_skills",
    description:
      "列出所有可用的自定义技能。返回技能名称、描述和状态。" +
      "使用 skill_invoke 工具调用特定技能。",
    inputSchema: {
      type: "object",
      properties: {},
    },
    async execute() {
      try {
        const repos = await getRepos();
        const allSkills = await repos.agentSkill.listActive();
        if (allSkills.length === 0) {
          return {
            skills: [],
            message: "No skills have been defined yet. Skills can be created via the /api/agent-skills endpoint or the settings UI.",
          };
        }
        // Deduplicate by name: keep highest-priority source per skill name
        const sourcePriority: Record<string, number> = { builtin: 0, hub: 1, plugin: 2, manual: 3 };
        const deduped = new Map<string, typeof allSkills[number]>();
        for (const s of allSkills) {
          const existing = deduped.get(s.name);
          if (!existing || (sourcePriority[s.source] ?? 99) < (sourcePriority[existing.source] ?? 99)) {
            deduped.set(s.name, s);
          }
        }
        return {
          skills: [...deduped.values()].map((s) => ({
            name: s.name,
            description: s.description,
            modelRole: s.modelRole,
            tools: s.tools,
            source: s.source,
          })),
        };
      } catch (err) {
        return { error: `Failed to list skills: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });

  // -----------------------------------------------------------------------
  // skill_create, skill_update, skill_delete tools
  // -----------------------------------------------------------------------

  try {
    const { createSkillCreateTool, createSkillUpdateTool, createSkillDeleteTool } = await import("./tools/skill-manage-tool.js");

    const skillCreateTool = createSkillCreateTool(deps.dataDir);
    registry.register({
      ...skillCreateTool,
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    });

    const skillUpdateTool = createSkillUpdateTool();
    registry.register({
      ...skillUpdateTool,
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    });

    const skillDeleteTool = createSkillDeleteTool();
    registry.register({
      ...skillDeleteTool,
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    });
  } catch {
    // Skill management tools not available
  }

  // -----------------------------------------------------------------------
  // agent_memory tool — manage agent's universal experience notes
  // Only active when self-evolution is enabled.
  // -----------------------------------------------------------------------

  try {
    const { getCachedEvolutionConfig } = await import("./evolution-config.js");
    const { getRepos } = await import("../../store/repos/index.js");

    registry.register({
      name: "agent_memory",
      description:
        "管理你的通用经验笔记。记录工具使用技巧、工作流改进、系统约定和经验教训。" +
        "不记录用户个人信息或偏好。" +
        "\n\n动作说明：" +
        "\n• add: 添加新的经验笔记（category: tool_technique/workflow/convention/lesson_learned）" +
        "\n• replace: 替换已有笔记内容" +
        "\n• remove: 删除笔记" +
        "\n• list: 查看所有经验笔记",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "replace", "remove", "list"],
            description: "要执行的操作",
          },
          category: {
            type: "string",
            enum: ["tool_technique", "workflow", "convention", "lesson_learned"],
            description: "经验类别（add 时必填）",
          },
          content: {
            type: "string",
            description: "经验内容（add/replace 时必填）",
          },
          target_id: {
            type: "string",
            description: "目标笔记 ID（replace/remove 时必填）",
          },
        },
        required: ["action"],
      },
      execute: async (input: Record<string, unknown>) => {
        const config = getCachedEvolutionConfig();
        if (!config?.enabled) {
          return JSON.stringify({ error: "自进化功能未启用。请在设置中开启。" });
        }
        const repos = await getRepos();
        const action = input.action as string;

        switch (action) {
          case "add": {
            if (!input.category || !input.content) {
              return JSON.stringify({ error: "add 操作需要 category 和 content 参数" });
            }
            const entry = await repos.agentMemory.add({
              category: input.category as "tool_technique" | "workflow" | "convention" | "lesson_learned",
              content: input.content as string,
              source: "foreground",
              relevance: 5,
            });
            if (!entry) {
              return JSON.stringify({ success: true, message: "该经验已存在，无需重复添加" });
            }
            const total = await repos.agentMemory.count();
            return JSON.stringify({ success: true, id: entry.id, message: `经验已保存（共 ${total} 条）` });
          }
          case "replace": {
            if (!input.target_id || !input.content) {
              return JSON.stringify({ error: "replace 操作需要 target_id 和 content 参数" });
            }
            const updated = await repos.agentMemory.replace(
              input.target_id as string,
              input.content as string,
              input.category as string | undefined,
            );
            if (!updated) {
              return JSON.stringify({ error: "未找到指定笔记" });
            }
            return JSON.stringify({ success: true, id: updated.id });
          }
          case "remove": {
            if (!input.target_id) {
              return JSON.stringify({ error: "remove 操作需要 target_id 参数" });
            }
            const ok = await repos.agentMemory.remove(input.target_id as string);
            return JSON.stringify({ success: ok });
          }
          case "list": {
            const memories = await repos.agentMemory.list();
            return JSON.stringify({ memories, count: memories.length });
          }
          default:
            return JSON.stringify({ error: `未知操作: ${action}` });
        }
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    });
  } catch {
    // agent_memory tool not available
  }

  // -----------------------------------------------------------------------
  // read_file tool — read files from the data directory
  // -----------------------------------------------------------------------

  registry.register({
    name: "read_file",
    description: "读取数据目录中的文件内容，支持 offset/limit 分段读取。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径（相对于数据目录，或数据目录内的绝对路径）",
        },
        offset: {
          type: "number",
          description: "起始行号（从0开始，默认：0）",
        },
        limit: {
          type: "number",
          description: "最大读取行数（默认：2000）",
        },
      },
      required: ["path"],
    },
    async execute(input: Record<string, unknown>) {
      const rawPath = input.path as string;
      const offset = (input.offset as number) || 0;
      const limit = (input.limit as number) || 2000;

      // Normalize path: strip "data/" prefix if present (models often include it)
      let normalizedPath = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
      if (normalizedPath.startsWith("data/") || normalizedPath.startsWith("data\\")) {
        normalizedPath = normalizedPath.slice(5);
      }

      // Resolve path relative to data directory for safety
      let safePath = resolve(deps.dataDir, normalizedPath);

      // If file not found at direct path, try session output directory
      // (write_file remaps filenames with makeAgentFilename, so the original
      // path may not exist — fuzzy match against the actual prefixed name)
      if (!existsSync(safePath) && !isSharedDataPath(normalizedPath)) {
        const ctx = registry.getExecutionContext();
        const sid = ctx?.sessionId as string | undefined;
        if (sid) {
          const sessionPath = resolveSessionOutputPath(normalizedPath, deps.dataDir, sid);
          if (sessionPath !== safePath && existsSync(sessionPath)) {
            safePath = sessionPath;
          }
        }
      }

      if (!safePath.startsWith(resolve(deps.dataDir))) {
        return {
          error: "Access denied: path outside data directory. " +
            "File tools (read_file/write_file/edit_file/grep/glob/push_file) are sandboxed to the data directory. " +
            "For full filesystem access (e.g. /etc/hosts, /tmp, project source files), use the bash tool — it has no sandbox restrictions.",
        };
      }

      // KB scope enforcement: block access to files outside scoped KBs
      const scopeError = checkKbScope(safePath);
      if (scopeError) return { error: scopeError };

      if (!existsSync(safePath)) {
        return { error: `File not found: ${rawPath}` };
      }

      // Reject binary files — read_file is for text content only.
      // Binary files (xlsx, pptx, docx, pdf, images, etc.) produce garbage when
      // read as UTF-8 and will crash PostgreSQL JSONB storage with null bytes.
      const fileExt = extname(safePath).toLowerCase();
      const BINARY_EXTENSIONS = new Set([
        ".pptx", ".xlsx", ".xls", ".docx", ".doc", ".pdf", ".zip", ".gz",
        ".tar", ".rar", ".7z", ".png", ".jpg", ".jpeg", ".gif", ".bmp",
        ".ico", ".webp", ".mp3", ".mp4", ".wav", ".avi", ".mov",
        ".wmv", ".flv", ".mkv", ".ogg", ".opus", ".sqlite", ".db",
      ]);
      if (BINARY_EXTENSIONS.has(fileExt)) {
        return {
          error: `Cannot read binary file "${fileExt}" as text. This is a binary format (e.g., spreadsheet, document, archive, or media). Use expand to view processed content, or use run_sql to query structured data.`,
        };
      }

      try {
        const content = readFileSync(safePath, "utf-8");
        const lines = content.split("\n");
        const sliced = lines.slice(offset, offset + limit);

        // Track read files for read-before-write enforcement
        const ctx = registry.getExecutionContext();
        if (ctx._readFilesTracker instanceof Set) {
          ctx._readFilesTracker.add(safePath);
        }

        return {
          path: rawPath,
          totalLines: lines.length,
          showingLines: `${offset}-${Math.min(offset + limit, lines.length)}`,
          content: sliced.join("\n"),
        };
      } catch (err) {
        return { error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });

  // -----------------------------------------------------------------------
  // grep tool — search file contents
  // -----------------------------------------------------------------------

  registry.register({
    name: "grep",
    description:
      "在数据目录的文件中搜索文本模式。返回匹配的行及文件路径和行号。" +
      "搜索磁盘上的原始文件（parsed.md、json、csv 等），覆盖范围与 doc_grep 不同：" +
      "doc_grep 搜索数据库中已编译的 wiki 页面，grep 搜索磁盘原始文件。两者互为补充。" +
      "适用场景：doc_grep 搜索不到时用 grep 补充、验证特定关键词在原文中的出现、跨文档搜索。" +
      "支持基本文本搜索和正则表达式。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "搜索模式（文本或正则表达式）",
        },
        path: {
          type: "string",
          description: "要搜索的目录或文件（相对于数据目录）。默认：整个数据目录。",
        },
        maxResults: {
          type: "number",
          description: "返回匹配行的最大数量（默认：50）",
        },
      },
      required: ["pattern"],
    },
    async execute(input: Record<string, unknown>) {
      const pattern = input.pattern as string;
      let searchPath = input.path ? resolve(deps.dataDir, input.path as string) : deps.dataDir;
      const maxResults = (input.maxResults as number) || 50;

      if (!searchPath.startsWith(resolve(deps.dataDir))) {
        return {
          error: "Access denied: path outside data directory. " +
            "File tools (read_file/write_file/edit_file/grep/glob/push_file) are sandboxed to the data directory. " +
            "For full filesystem access (e.g. /etc/hosts, /tmp, project source files), use the bash tool — it has no sandbox restrictions.",
        };
      }

      // KB scope enforcement: restrict search path to scoped KBs
      const scopedPaths = getScopedSearchPaths();
      if (scopedPaths.length > 0) {
        // If the user specified a path, check it's within scope
        if (input.path) {
          const scopeError = checkKbScope(searchPath);
          if (scopeError) return { error: scopeError };
        } else {
          // No path specified — restrict to scoped KB directories only
          // Search each scoped KB dir and merge results
          const allResults: Array<{ file: string; line: number; content: string }> = [];
          for (const scopedPath of scopedPaths) {
            try {
              const escapedPattern = pattern.replace(/'/g, "'\\''");
              const result = execSync(
                `grep -rn --include='*.md' --include='*.txt' --include='*.csv' --include='*.json' --include='*.yaml' --include='*.yml' -E '${escapedPattern}' '${scopedPath}' 2>/dev/null | head -${maxResults}`,
                { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, timeout: 10000 },
              );
              const lines = result.trim().split("\n").filter(Boolean);
              for (const line of lines) {
                const colonIdx = line.indexOf(":");
                const secondColon = line.indexOf(":", colonIdx + 1);
                if (colonIdx > 0 && secondColon > 0) {
                  allResults.push({
                    file: line.substring(0, colonIdx).replace(deps.dataDir + "/", ""),
                    line: parseInt(line.substring(colonIdx + 1, secondColon), 10),
                    content: line.substring(secondColon + 1),
                  });
                }
              }
            } catch { /* grep returns 1 when no matches */ }
          }
          return {
            pattern,
            matches: allResults.length,
            results: allResults.slice(0, maxResults),
          };
        }
      }

      try {
        const escapedPattern = pattern.replace(/'/g, "'\\''");
        const result = execSync(
          `grep -rn --include='*.md' --include='*.txt' --include='*.csv' --include='*.json' --include='*.yaml' --include='*.yml' -E '${escapedPattern}' '${searchPath}' 2>/dev/null | head -${maxResults}`,
          { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, timeout: 10000 },
        );

        const lines = result.trim().split("\n").filter(Boolean);
        return {
          pattern,
          matches: lines.length,
          results: lines.map((line) => {
            const colonIdx = line.indexOf(":");
            const secondColon = line.indexOf(":", colonIdx + 1);
            if (colonIdx > 0 && secondColon > 0) {
              return {
                file: line.substring(0, colonIdx).replace(deps.dataDir + "/", ""),
                line: parseInt(line.substring(colonIdx + 1, secondColon), 10),
                content: line.substring(secondColon + 1),
              };
            }
            return { raw: line };
          }),
        };
      } catch (err: unknown) {
        // grep returns exit code 1 when no matches found
        const execErr = err as { status?: number };
        if (execErr.status === 1) {
          return { pattern, matches: 0, results: [] };
        }
        return { error: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });

  // -----------------------------------------------------------------------
  // glob tool — find files by pattern
  // -----------------------------------------------------------------------

  registry.register({
    name: "glob",
    description:
      "在数据目录中按模式查找文件。" +
      "返回匹配的文件路径列表。支持 glob 模式，如 *.pdf、**/*.md 等。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob 匹配模式（如 '**/*.md'、'*.pdf'、'wiki/**/*.md'）",
        },
        path: {
          type: "string",
          description: "搜索的基础目录（相对于数据目录）。默认：数据根目录。",
        },
      },
      required: ["pattern"],
    },
    async execute(input: Record<string, unknown>) {
      const { glob } = await import("node:fs/promises");
      const pattern = input.pattern as string;
      const basePath = input.path ? resolve(deps.dataDir, input.path as string) : deps.dataDir;

      if (!basePath.startsWith(resolve(deps.dataDir))) {
        return {
          error: "Access denied: path outside data directory. " +
            "File tools (read_file/write_file/edit_file/grep/glob/push_file) are sandboxed to the data directory. " +
            "For full filesystem access (e.g. /etc/hosts, /tmp, project source files), use the bash tool — it has no sandbox restrictions.",
        };
      }

      // KB scope enforcement
      const scopedPaths = getScopedSearchPaths();
      if (scopedPaths.length > 0) {
        if (input.path) {
          const scopeError = checkKbScope(basePath);
          if (scopeError) return { error: scopeError };
        } else {
          // No path specified — search only within scoped KB directories
          const allMatches: string[] = [];
          for (const scopedPath of scopedPaths) {
            try {
              for await (const entry of glob(pattern, { cwd: scopedPath })) {
                allMatches.push(`wiki/${scopedPath.split("/").pop()}/${entry}`);
              }
            } catch { /* skip invalid paths */ }
          }
          return {
            pattern,
            base: input.path || "",
            totalFiles: allMatches.length,
            truncated: allMatches.length > 200,
            files: allMatches.slice(0, 200),
          };
        }
      }

      try {
        const matches: string[] = [];
        for await (const entry of glob(pattern, { cwd: basePath })) {
          matches.push(entry);
        }
        return {
          pattern,
          base: input.path || "",
          totalFiles: matches.length,
          truncated: matches.length > 200,
          files: matches.slice(0, 200),
        };
      } catch (err) {
        return { error: `Glob failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });

  // -----------------------------------------------------------------------
  // bash tool — execute shell commands
  // -----------------------------------------------------------------------

  registry.register({
    name: "bash",
    description:
      "执行 Shell 命令并返回输出。**当前工作目录已设为项目数据目录（data/）**，所有路径相对于此目录。命令超时时间为 30 秒。\n\n" +
      "路径规则（避免常见错误）：\n" +
      "- 已在 data/ 目录下，不要 `cd data`（会尝试进入不存在的 data/data/）\n" +
      "- 使用相对路径如 `wiki/{kbId}/manifest.json`，不要用绝对路径 `/data/...`\n" +
      "- 其他工具返回的路径如 `data/wiki/...`，需要去掉 `data/` 前缀（因为 CWD 已是 data/）\n\n" +
      "bash 拥有完整的文件系统访问能力：\n" +
      "- `grep -rl '关键词' wiki/` 一次搜索全部文档内容\n" +
      "- `cat wiki/{kbId}/documents/{docId}/parsed.md` 直接读取文档\n" +
      "- `python3` 可编程处理任意数据（pandas 处理 Excel、计算统计等）\n" +
      "- `find`/`ls`/`wc`/`sort`/`awk` 等全部 shell 工具可用\n" +
      "- 先用 `cat wiki/{kbId}/manifest.json` 查看文档名到路径的映射\n\n" +
      "注意事项：\n" +
      "- 执行代码前先在 think 工具中验证逻辑\n" +
      "- 对计算结果做常识性检查（数量级、单位、边界值）\n" +
      "- 代码出错时先分析错误信息，不要盲目修改重试",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 Shell 命令",
        },
        timeout: {
          type: "number",
          description: "超时时间（秒，默认：30，最大：120）",
        },
      },
      required: ["command"],
    },
    async execute(input: Record<string, unknown>) {
      const command = input.command as string;
      const timeoutSec = Math.min((input.timeout as number) || 30, 120);

      // KB scope enforcement for bash
      const scopedPaths = getScopedSearchPaths();
      const cwd = deps.dataDir;
      let scopeWarning: string | undefined;

      if (scopedPaths.length > 0) {
        // Check if command references an out-of-scope wiki/{kbId} path
        const scopeKbIds = (registry.getExecutionContext().scopeKbIds as string[]) || [];
        const wikiMatch = command.match(/wiki\/([0-9a-f-]{36})/g);
        if (wikiMatch) {
          for (const m of wikiMatch) {
            const kbId = m.replace("wiki/", "");
            if (!scopeKbIds.includes(kbId)) {
              return {
                exitCode: 1,
                output: "",
                error: `Access denied: command references wiki/${kbId} which is outside the session's knowledge base scope. Allowed KBs: ${scopeKbIds.join(", ")}`,
              };
            }
          }
        }
        // For broad commands (grep wiki/, find wiki/) without specific kbId, add a scope hint
        if (/grep\s+.*wiki\//.test(command) && !wikiMatch) {
          scopeWarning = `注意：搜索范围限定在知识库 ${scopeKbIds.join(", ")} 内，结果可能不完整`;
        }
      }

      // Decode command output with Windows GBK fallback.
      // Windows Chinese systems use GBK/936 codepage; child processes emit GBK
      // bytes that look like mojibake when decoded as UTF-8. gb18030 is the
      // Node 18+ built-in superset of GBK.
      const decodeCmdOutput = (buf: Buffer | string): string => {
        if (typeof buf === "string") return buf;
        if (buf.length === 0) return "";
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(buf);
        } catch {
          try {
            return new TextDecoder("gb18030").decode(buf);
          } catch {
            return new TextDecoder("latin1").decode(buf);
          }
        }
      };

      try {
        const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
          exec(command, {
            encoding: "buffer",
            cwd,
            timeout: timeoutSec * 1000,
            maxBuffer: 5 * 1024 * 1024,
          }, (error, stdout, stderr) => {
            const stdoutStr = decodeCmdOutput(stdout);
            const stderrStr = decodeCmdOutput(stderr);
            if (error) {
              const execErr = error as NodeJS.ErrnoException & { code?: number; killed?: boolean };
              resolve({
                exitCode: typeof execErr.code === "number" ? execErr.code : 1,
                stdout: stdoutStr,
                stderr: stderrStr || (execErr.killed ? `Command timed out after ${timeoutSec}s` : execErr.message),
              });
            } else {
              resolve({ exitCode: 0, stdout: stdoutStr, stderr: stderrStr });
            }
          });
        });

        if (result.exitCode === 0) {
          return { exitCode: 0, output: result.stdout.trim(), ...(scopeWarning ? { warning: scopeWarning } : {}) };
        }

        const errMsg = (result.stderr || "").trim();
        // Detect maxBuffer overflow and provide actionable guidance
        if (errMsg.includes("maxBuffer") || errMsg.includes("stdout maxBuffer exceeded")) {
          return {
            exitCode: 1,
            output: result.stdout.substring(0, 50000),
            error: "输出超过 5MB 缓冲区限制。建议：\n" +
              "1. 将输出重定向到文件后用 read_file 分段读取：`command > tmp/output.txt`\n" +
              "2. 用管道只获取前面部分：`command | head -n 1000`\n" +
              "3. 用 grep 过滤只获取需要的行：`command | grep '关键词'`",
          };
        }
        return {
          exitCode: result.exitCode,
          output: result.stdout.trim(),
          error: errMsg,
        };
      } catch (err: unknown) {
        return {
          exitCode: 1,
          output: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    isReadOnly: (input) => {
      const cmd = (input.command as string) ?? "";
      const readOnlyPrefixes = ["ls", "cat", "head", "tail", "wc", "du", "file", "stat", "pwd", "echo", "which", "type", "env", "printenv", "grep", "find", "git status", "git log", "git diff", "git branch", "python3", "python"];
      return readOnlyPrefixes.some(c => cmd.trimStart().startsWith(c));
    },
    isConcurrencySafe: (input) => {
      const cmd = (input.command as string) ?? "";
      const readOnlyPrefixes = ["ls", "cat", "head", "tail", "wc", "du", "file", "stat", "pwd", "echo", "which", "type", "env", "printenv", "grep", "find", "git status", "git log", "git diff", "git branch", "python3", "python"];
      return readOnlyPrefixes.some(c => cmd.trimStart().startsWith(c));
    },
  });

  // -----------------------------------------------------------------------
  // run_sql tool — execute SQL queries against the DA database
  // -----------------------------------------------------------------------

  registry.register({
    name: "run_sql",
    description:
      "执行 SQL 查询并返回结果。支持只读查询和写入操作。" +
      "直接查询 DA 的 PostgreSQL 数据库，可访问 documents、wiki_pages 等表的完整数据。" +
      "这是获取精确完整数据最可靠的方式——不受向量检索的召回率限制，不受分页限制。\n" +
      "完整 SQL 能力：SELECT、JOIN、GROUP BY、HAVING、ORDER BY、LIMIT、子查询、CTE(WITH)、窗口函数、聚合函数、UNION、DISTINCT、CASE WHEN、类型转换、正则匹配等\n" +
      "写入操作：INSERT、UPDATE、DELETE（需设置 mode=\"write\"）\n" +
      "DDL 操作：CREATE TABLE、ALTER TABLE、DROP TABLE（需设置 mode=\"write\"，标记为破坏性）\n" +
      "核心表：\n" +
      "documents: id, filename, file_path, file_type, file_size, kb_id, status, abstract, folder_path, created_at\n" +
      "wiki_pages: id, kb_id, doc_id, page_type, title, content, token_count, file_path, metadata\n" +
      "发现更多表：SELECT table_name FROM information_schema.tables WHERE table_schema='public'\n" +
      "查看列定义：SELECT column_name, data_type FROM information_schema.columns WHERE table_name='documents'\n" +
      "适合：文档统计聚合、按文件类型/目录/状态分类、精确的元数据查询、全量列表、数据维护。\n" +
      "不适合：语义搜索（用 kb_search）\n" +
      "示例：SELECT file_type, count(*) FROM documents WHERE kb_id='...' GROUP BY file_type\n" +
      "写入示例：INSERT INTO documents (id, filename, kb_id) VALUES ('...', 'test.pdf', '...') RETURNING *",
    inputSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "SQL 语句",
        },
        mode: {
          type: "string",
          enum: ["read", "write"],
          description: "read=只读查询（默认），write=写入操作（INSERT/UPDATE/DELETE/DDL）",
        },
        maxRows: {
          type: "number",
          description: "最大返回行数（默认：100，最大：500）",
        },
      },
      required: ["sql"],
    },
    async execute(input: Record<string, unknown>) {
      const sql = (input.sql as string).trim();
      const mode = (input.mode as string) || "read";
      const maxRows = Math.min((input.maxRows as number) || 100, 500);

      if (!sql) {
        return { error: "SQL statement is required" };
      }

      // Read mode: only allow SELECT and CTE (WITH ... SELECT)
      if (mode === "read") {
        if (!/^\s*(SELECT|WITH)\s/i.test(sql)) {
          return { error: "Read mode only supports SELECT queries (including CTE/WITH). Use mode=\"write\" for INSERT/UPDATE/DELETE/DDL." };
        }
      }

      // Write mode: allow all SQL except GRANT/REVOKE
      if (mode === "write") {
        if (/\b(GRANT|REVOKE)\b/i.test(sql)) {
          return { error: "GRANT/REVOKE operations are not allowed" };
        }
      }

      // KB scope enforcement: when session has a scope, filter results for KB-related tables
      const execScopeKbIds = (registry.getExecutionContext()?.scopeKbIds as string[]) || [];

      // When session has empty KB scope, block queries against KB-related tables.
      // This prevents sub-agents from bypassing the session's KB scope via direct
      // SQL access (e.g., discovering KB names/IDs from the documents table and
      // then reading their files via bash).
      if (execScopeKbIds.length === 0) {
        const kbTableRe = /\b(documents|wiki_pages|knowledge_bases|kb_chunks|kb_embeddings)\b/i;
        if (kbTableRe.test(sql)) {
          return {
            error: "当前会话没有关联知识库，不允许查询知识库相关表（documents、wiki_pages、knowledge_bases 等）。" +
              "如需分析知识库数据，请先关联知识库后再操作。",
          };
        }
      }

      try {
        const { getPool } = await import("../../store/pg.js");
        const pool = await getPool();

        // Write operations: use transaction
        if (mode === "write" && !/^\s*(SELECT|WITH)\s/i.test(sql)) {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const result = await client.query(sql);
            await client.query("COMMIT");
            const rows = result.rows.slice(0, maxRows);
            return {
              rowCount: result.rows.length,
              showingRows: Math.min(result.rows.length, maxRows),
              columns: result.fields?.map((f: { name: string }) => f.name) || [],
              rows,
              command: result.command,
              mode: "write",
            };
          } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
          } finally {
            client.release();
          }
        }

        // Read operations (or write-mode SELECT)
        const result = await pool.query(sql);
        let rows = result.rows.slice(0, maxRows);
        let scopeWarning: string | undefined;

        // KB scope post-filter: when session has scope, filter rows from KB-related tables
        if (execScopeKbIds.length > 0) {
          // Block information_schema queries that reveal database structure beyond the scoped KBs
          if (/\binformation_schema\b/i.test(sql)) {
            return {
              error: `当前会话限定了知识库范围，不允许查询数据库结构信息（information_schema）。请使用 wiki_browse 或 kb_search 工具来探索数据。允许的知识库 ID: ${execScopeKbIds.join(", ")}`,
            };
          }
          // Match KB tables even with aliases (e.g. "documents d", "wiki_pages AS wp")
          const kbTablesRe = /\b(documents|wiki_pages|knowledge_bases)\b/i;
          // Also check for kb_id column reference in the SQL (covers JOINs and CTEs)
          const kbIdColRe = /\bkb_id\b/i;
          const isKbQuery = kbTablesRe.test(sql) || kbIdColRe.test(sql);

          if (isKbQuery) {
            const scopeSet = new Set(execScopeKbIds.map(id => id.toLowerCase()));
            const columns = result.fields?.map((f: { name: string }) => f.name) || [];
            // Find the KB ID column: kb_id (most common) or id (knowledge_bases table)
            const kbIdCol = columns.find(c => /^kb_?id$/i.test(c)) || columns.find(c => c === "id");
            if (kbIdCol) {
              const filtered = rows.filter((row: Record<string, unknown>) => {
                const val = String(row[kbIdCol] || "").toLowerCase();
                return scopeSet.has(val);
              });
              if (filtered.length < rows.length) {
                rows = filtered;
                scopeWarning = `[范围过滤] 当前会话限定了搜索范围。已过滤掉 ${result.rows.length - filtered.length} 条超出范围的结果。` +
                  `允许的知识库 ID: ${execScopeKbIds.join(", ")}。` +
                  `请在 WHERE 条件中限定 kb_id IN (${execScopeKbIds.map(id => `'${id}'`).join(", ")}) 以避免过滤。`;
              }
            }
          }
        }

        const response: Record<string, unknown> = {
          rowCount: rows.length,
          showingRows: Math.min(rows.length, maxRows),
          columns: result.fields?.map((f: { name: string }) => f.name) || [],
          rows,
        };
        if (scopeWarning) {
          response.warning = scopeWarning;
        }
        return response;
      } catch (err) {
        return { error: `SQL error: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    isReadOnly: (input) => (input.mode as string) !== "write",
    isConcurrencySafe: (input) => (input.mode as string) !== "write",
    isDestructive: (input) => {
      const sql = (input.sql as string) || "";
      return /\b(DROP|TRUNCATE|ALTER)\b/i.test(sql);
    },
  });

  // -----------------------------------------------------------------------
  // powershell tool — execute PowerShell commands
  // -----------------------------------------------------------------------

  registry.register({
    name: "powershell",
    description:
      "执行 PowerShell 命令并返回输出。自动检测 PowerShell 版本（Core 7+ 或 Desktop 5.1）。" +
      "支持 Windows 和 Linux/macOS 上的 PowerShell Core。\n" +
      "适用场景：Windows 系统管理、Active Directory 操作、Azure/365 管理、" +
      "注册表操作、COM 对象访问、WMI 查询、.NET 互操作等 Windows 特有任务。\n" +
      "安全限制：内置 23 个 AST 级安全验证器检测危险模式（代码注入、提权、下载摇篮等）。\n" +
      "注意：Linux 环境需安装 PowerShell Core（pwsh）才可使用。\n" +
      "常用命令：Get-ChildItem (列出文件)、Get-Content (读取文件)、Get-Process (查看进程)、" +
      "Get-Service (查看服务)、Test-Connection (网络测试)、Get-WmiObject (WMI 查询)",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "要执行的 PowerShell 命令",
        },
        timeout: {
          type: "number",
          description: "超时时间（秒，默认：30，最大：120）",
        },
      },
      required: ["command"],
    },
    shouldDefer: true,
    async execute(input: Record<string, unknown>) {
      const command = (input.command as string).trim();
      const timeoutSec = Math.min((input.timeout as number) || 30, 120);

      if (!command) {
        return { exitCode: 1, output: "", error: "PowerShell command is required" };
      }

      return await executePowerShellCommand(command, timeoutSec, deps.dataDir);
    },
    isReadOnly: (input) => {
      try {
        const safety = checkPowerShellSafetySync((input.command as string) || "");
        return safety.isReadOnly;
      } catch {
        return false;
      }
    },
    isConcurrencySafe: (input) => {
      try {
        const safety = checkPowerShellSafetySync((input.command as string) || "");
        return safety.isReadOnly;
      } catch {
        return false;
      }
    },
    isDestructive: (input) => {
      try {
        const safety = checkPowerShellSafetySync((input.command as string) || "");
        return safety.isDestructive;
      } catch {
        return false;
      }
    },
  });

  // -----------------------------------------------------------------------
  // db_connect tool — connect to external databases
  // -----------------------------------------------------------------------

  registry.register({
    name: "db_connect",
    description:
      "连接外部数据库。支持 PostgreSQL、MySQL、SQLite 三种数据库类型。\n" +
      "连接成功后返回 connectionId，供 db_query 工具使用。\n" +
      "PostgreSQL：提供 host、port、database、user、password\n" +
      "MySQL：提供 host、port、database、user、password\n" +
      "SQLite：提供 filePath（数据库文件路径）\n" +
      "注意：密码以明文传输，请确保连接安全。每个连接在会话结束时自动关闭。",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["postgresql", "mysql", "sqlite"],
          description: "数据库类型",
        },
        host: {
          type: "string",
          description: "数据库主机地址（PostgreSQL/MySQL，默认：localhost）",
        },
        port: {
          type: "number",
          description: "数据库端口（PostgreSQL 默认 5432，MySQL 默认 3306）",
        },
        database: {
          type: "string",
          description: "数据库名称（PostgreSQL/MySQL）或文件路径（SQLite 的替代参数）",
        },
        user: {
          type: "string",
          description: "数据库用户名（PostgreSQL/MySQL）",
        },
        password: {
          type: "string",
          description: "数据库密码（PostgreSQL/MySQL）",
        },
        filePath: {
          type: "string",
          description: "SQLite 数据库文件路径",
        },
        name: {
          type: "string",
          description: "连接别名（可选，用于标识）",
        },
      },
      required: ["type"],
    },
    shouldDefer: true,
    async execute(input: Record<string, unknown>) {
      const type = input.type as "postgresql" | "mysql" | "sqlite";
      if (!type || !["postgresql", "mysql", "sqlite"].includes(type)) {
        return { error: "type 参数必须是 postgresql、mysql 或 sqlite" };
      }

      try {
        const result = await createConnection({
          type,
          host: input.host as string,
          port: input.port as number,
          database: input.database as string,
          user: input.user as string,
          password: input.password as string,
          filePath: input.filePath as string,
          name: input.name as string,
        });
        return result;
      } catch (err) {
        return {
          error: `连接失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
  });

  // -----------------------------------------------------------------------
  // db_query tool — execute SQL on external databases
  // -----------------------------------------------------------------------

  registry.register({
    name: "db_query",
    description:
      "在外部数据库上执行 SQL 查询。需先通过 db_connect 建立连接获取 connectionId。\n" +
      "支持所有标准 SQL 操作：SELECT、INSERT、UPDATE、DELETE、DDL。\n" +
      "写操作（mode=\"write\"）自动使用事务保护。\n" +
      "建议写操作使用 RETURNING 子句返回变更数据（PostgreSQL 支持）。\n" +
      "查看连接列表：设置 connectionId=\"list\" 列出当前活跃连接。",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "数据库连接 ID（由 db_connect 返回）",
        },
        sql: {
          type: "string",
          description: "SQL 语句",
        },
        mode: {
          type: "string",
          enum: ["read", "write"],
          description: "read=只读查询（默认），write=写入操作（INSERT/UPDATE/DELETE/DDL）",
        },
        maxRows: {
          type: "number",
          description: "最大返回行数（默认：100，最大：500）",
        },
      },
      required: ["connectionId", "sql"],
    },
    shouldDefer: true,
    async execute(input: Record<string, unknown>) {
      const connectionId = input.connectionId as string;
      const sql = (input.sql as string)?.trim();
      const mode = (input.mode as string) || "read";
      const maxRows = Math.min((input.maxRows as number) || 100, 500);

      if (!connectionId) {
        return { error: "connectionId 参数必填" };
      }
      if (!sql) {
        return { error: "sql 参数必填" };
      }

      // Handle special action: list connections
      if (connectionId === "list") {
        const conns = listConnections();
        return { connections: conns, count: conns.length };
      }

      try {
        const result = await executeQuery({ connectionId, sql, mode, maxRows });
        return result;
      } catch (err) {
        return {
          error: `查询失败: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    isReadOnly: (input) => (input.mode as string) !== "write",
    isConcurrencySafe: (input) => (input.mode as string) !== "write",
    isDestructive: (input) => {
      const sql = (input.sql as string) || "";
      return /\b(DROP|TRUNCATE|ALTER)\b/i.test(sql);
    },
    requiresKbScope: true,
  });

  // -----------------------------------------------------------------------
  // web_search tool — search the web
  // -----------------------------------------------------------------------

  registry.register({
    name: "web_search",
    description:
      "搜索网络获取信息。返回包含标题、URL 和摘要的搜索结果。" +
      "适用于查找知识库中没有的最新信息。\n\n" +
      "使用建议：\n" +
      "- 构造具体的搜索查询——包含关键实体名、日期、事件名等具体信息\n" +
      "- 如果连续 2-3 次搜索无有用结果，换用不同的关键词组合\n" +
      "- 对于学术文献，优先使用 scholar_search 工具搜索论文；如果找不到再用 web_search\n" +
      "- 如果返回了相关 URL 但摘要信息不足，使用 web_fetch 获取完整页面\n" +
      "- 对于 PDF 文件链接，使用 pdf_read 工具获取内容\n" +
      "- 对于 YouTube 视频，使用 youtube_transcript 获取转录文本",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索查询",
        },
        maxResults: {
          type: "number",
          description: "返回结果的最大数量（默认：10）",
        },
        timeRange: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "可选，时间范围过滤：day=过去一天，week=过去一周，month=过去一个月，year=过去一年。搜索最新信息或时效性内容时使用。",
        },
      },
      required: ["query"],
    },
    async execute(input: Record<string, unknown>) {
      const args = input as { query: string; maxResults?: number; timeRange?: "day" | "week" | "month" | "year" };
      const backend = process.env.SEARCH_BACKEND ?? "searxng";
      const maxResults = args.maxResults ?? 10;

      // Proxy support via lightweight web-proxy helper (reads HTTPS_PROXY / HTTP_PROXY env)
      // Note: per-target proxy options will be built inside each backend branch to respect NO_PROXY.
      const { getWebProxyFetchOptions } = await import("./web-proxy.js");

      try {
        if (backend === "serper") {
          const apiKey = process.env.SERPER_API_KEY;
          if (!apiKey) {
            return { error: true, message: "Web search (Serper) is not configured. Set SERPER_API_KEY environment variable.", suggestion: "Try using browser tool to visit a URL directly instead." };
          }

          const resp = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: {
              "X-API-KEY": apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              q: args.query,
              num: maxResults,
              ...(args.timeRange ? { tbs: `qdr:${args.timeRange.charAt(0)}` } : {}),
            }),
            signal: AbortSignal.timeout(15000),
            ...getWebProxyFetchOptions("https://google.serper.dev"),
          });

          if (!resp.ok) {
            return { error: true, message: `Search request failed: HTTP ${resp.status}`, suggestion: "Search service unavailable. Try browser tool to visit a URL directly, or proceed with available information." };
          }

          const data = await resp.json() as {
            organic?: Array<{ title: string; link: string; snippet: string }>;
          };

          const results = (data.organic ?? []).slice(0, maxResults);
          if (results.length === 0) return `No results found for "${args.query}".`;

          const searchContent = results
            .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.link}\n    ${r.snippet}`)
            .join("\n\n");
          return wrapExternalContent(searchContent, {
            source: "web_search",
            sourceDetails: `Query: ${args.query}\nBackend: serper`,
          }).wrapped;
        } else if (backend === "minimax") {
          // MiniMax web search — read API key from DB provider settings
          const repos = await getRepos();
          const providerSettings = await repos.settings.getProviderSettings();
          const minimaxProvider = providerSettings.providers.find(
            (p: { id: string; enabled: boolean }) =>
              p.id.startsWith("minimax") && p.enabled,
          );

          if (!minimaxProvider?.apiKey) {
            return { error: true, message: "Web search (MiniMax) is not configured. Add a MiniMax provider with an API key in settings.", suggestion: "Try browser tool to visit a URL directly instead." };
          }

          // Try MiniMax first, then fall back to Baidu HTML on ANY failure
          let minimaxOk = false;
          try {
            // MiniMax search API endpoint — coding_plan/search path
            // Uses api.minimaxi.com (China) by default; falls back to api.minimax.io (Global)
            const minimaxBaseUrl = minimaxProvider.id.includes("global")
              ? "https://api.minimax.io"
              : "https://api.minimaxi.com";
            const minimaxProxyOpts = getWebProxyFetchOptions(minimaxBaseUrl);
            const resp = await fetch(`${minimaxBaseUrl}/v1/coding_plan/search`, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${minimaxProvider.apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ q: args.query }),
              signal: AbortSignal.timeout(15000),
              ...minimaxProxyOpts,
            });

            if (resp.ok) {
              const data = await resp.json() as {
                organic?: Array<{
                  title: string;
                  link: string;
                  snippet: string;
                  date?: string;
                }>;
              };

              const results = (data.organic ?? []).slice(0, maxResults);
              if (results.length > 0) {
                minimaxOk = true;
                const MAX_SNIPPET_CHARS = 1500;
                const searchContent = results
                  .map((r, i) => {
                    const link = r.link ?? "";
                    const rawSnippet = r.snippet ?? "";
                    const snippet = rawSnippet.length > MAX_SNIPPET_CHARS
                      ? rawSnippet.slice(0, MAX_SNIPPET_CHARS)
                        + `\n    [... ${rawSnippet.length} chars total, showing first ${MAX_SNIPPET_CHARS}]`
                      : rawSnippet;
                    const datePart = r.date ? `\n    [发布时间: ${r.date}]` : "";
                    return `[${i + 1}] ${r.title}\n    ${link}${datePart}\n    ${snippet}`;
                  })
                  .join("\n\n");
                return wrapExternalContent(searchContent, {
                  source: "web_search",
                  sourceDetails: `Query: ${args.query}\nBackend: minimax`,
                }).wrapped;
              }
            }
            console.log(`[web_search] MiniMax failed (HTTP ${resp.status}), falling back to DuckDuckGo`);
          } catch (minimaxErr) {
            console.log(`[web_search] MiniMax fetch failed (${minimaxErr instanceof Error ? minimaxErr.message : String(minimaxErr)}), falling back to DuckDuckGo`);
          }

          // Baidu HTML fallback — reached on MiniMax network error, non-OK response, or empty results
          // Baidu is accessible from China networks where DuckDuckGo is often blocked.
          if (!minimaxOk) {
            try {
              const baiduUrl = `http://www.baidu.com/s?wd=${encodeURIComponent(args.query)}`;
              const baiduProxyOpts = getWebProxyFetchOptions(baiduUrl);
              const baiduResp = await fetch(baiduUrl, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
                signal: AbortSignal.timeout(15000),
                ...baiduProxyOpts,
              });
              if (baiduResp.ok) {
                const html = await baiduResp.text();
                // Extract search results from Baidu HTML
                // Strategy: split by result containers (<div class="result c-container ...">) and extract title + snippet + URL from each
                const baiduResults: string[] = [];
                let count = 0;

                // Method 1: Extract via result containers (mu attribute contains the URL)
                const containerRegex = /<div[^>]*class="[^"]*result[^"]*c-container[^"]*"[^>]*mu="([^"]*)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
                let containerMatch;
                while ((containerMatch = containerRegex.exec(html)) !== null && count < maxResults) {
                  const url = containerMatch[1];
                  const block = containerMatch[2];
                  const titleMatch2 = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
                  if (!titleMatch2) continue;
                  const title = titleMatch2[1].replace(/<[^>]*>/g, "").trim();
                  if (!title || title.length < 3 || title.includes("百度AI") || title.includes("百度图片")) continue;
                  // Extract snippet: look for spans with content classes
                  const snippetMatch = block.match(/class="[^"]*(?:content-right|c-span-last|c-abstract)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/i);
                  const snippet = snippetMatch
                    ? snippetMatch[1].replace(/<[^>]*>/g, "").trim().slice(0, 300)
                    : "";
                  const entry = `[${count + 1}] ${title}\n    ${url}${snippet ? "\n    " + snippet : ""}`;
                  baiduResults.push(entry);
                  count++;
                }

                // Method 2: Fallback to simple <h3> extraction if containers didn't work
                if (baiduResults.length === 0) {
                  const titleRegex = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
                  let titleMatch2;
                  count = 0;
                  while ((titleMatch2 = titleRegex.exec(html)) !== null && count < maxResults) {
                    const rawTitle = titleMatch2[1];
                    const title = rawTitle.replace(/<[^>]*>/g, "").trim();
                    if (!title || title.length < 5 || title.includes("百度AI") || title.includes("百度图片")) continue;
                    baiduResults.push(`[${count + 1}] ${title}`);
                    count++;
                  }
                }

                if (baiduResults.length > 0) {
                  return wrapExternalContent(baiduResults.join("\n\n"), {
                    source: "web_search",
                    sourceDetails: `Query: ${args.query}\nBackend: baidu`,
                  }).wrapped;
                }
              }
            } catch (fallbackErr) {
              console.log(`[web_search] Baidu fallback also failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
            }
            return { error: true, message: `Search failed for "${args.query}". Both MiniMax and Baidu backends unavailable.`, suggestion: "Search service unavailable. Try browser tool to visit a URL directly, or proceed with available information." };
          }
        } else {
          // SearXNG (self-hosted)
          const searxngUrl = process.env.SEARXNG_URL ?? "http://localhost:8888";
          const timeRangeParam = args.timeRange ? `&time_range=${args.timeRange}` : "";
          const url = `${searxngUrl}/search?q=${encodeURIComponent(args.query)}&format=json&categories=general${timeRangeParam}`;

          const resp = await fetch(url, {
            signal: AbortSignal.timeout(15000),
            ...getWebProxyFetchOptions(searxngUrl),
          });

          if (!resp.ok) {
            return `Search request failed: HTTP ${resp.status}. Check SearXNG at ${searxngUrl}`;
          }

          const data = await resp.json() as {
            results?: Array<{ title: string; url: string; content: string }>;
          };

          const results = (data.results ?? []).slice(0, maxResults);
          if (results.length === 0) return `No results found for "${args.query}".`;

          const searchContent = results
            .map((r, i) => {
              const raw = r.content ?? "";
              const snippet = raw.length > 1500
                ? raw.slice(0, 1500) + `\n    [... ${raw.length} chars total, showing first 1500]`
                : raw;
              return `[${i + 1}] ${r.title}\n    ${r.url}\n    ${snippet}`;
            })
            .join("\n\n");
          return wrapExternalContent(searchContent, {
            source: "web_search",
            sourceDetails: `Query: ${args.query}\nBackend: searxng`,
          }).wrapped;
        }
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          return { error: true, message: `Search request timed out for "${args.query}".`, suggestion: "Search service is slow. Try a simpler query or use browser tool instead." };
        }
        return { error: true, message: `Search failed: ${err instanceof Error ? err.message : String(err)}`, suggestion: "Web search unavailable. Try browser tool or proceed with available information." };
      }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });

  // -----------------------------------------------------------------------
  // Web Fetch tool (multi-strategy URL fetcher)
  // -----------------------------------------------------------------------

  try {
    const { createWebFetchTool, setMiniMaxCredentials } = await import("./tools/web-fetch-tool.js");

    // Load MiniMax credentials from MCP server config for search fallback
    try {
      const repos = await getRepos();
      const mcpServersRaw = await repos.settings.get("mcp_servers");
      if (mcpServersRaw) {
        const servers = JSON.parse(mcpServersRaw) as Record<string, unknown>[];
        const minimaxServer = servers.find(
          (s) =>
            String(s.name ?? "").toLowerCase().includes("minimax") ||
            String(s.id ?? "").toLowerCase().includes("minimax"),
        );
        const env = minimaxServer?.env as Record<string, string> | undefined;
        if (env?.MINIMAX_API_KEY && env?.MINIMAX_API_HOST) {
          setMiniMaxCredentials(env.MINIMAX_API_KEY, env.MINIMAX_API_HOST);
          console.log("[ToolSetup] WebFetch: MiniMax search fallback configured");
        }
      }
    } catch {
      // Credentials not available — search fallback will be skipped
    }

    const webFetchTool = createWebFetchTool();
    registry.register({
      ...webFetchTool,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });
  } catch (err) {
    console.error("[ToolSetup] Failed to load web_fetch tool:", err instanceof Error ? err.message : String(err));
  }

  // -----------------------------------------------------------------------
  // PDF Reader tool (Docling + pdf-parse)
  // -----------------------------------------------------------------------

  try {
    const { createPdfReadTool } = await import("./tools/pdf-reader.js");
    const pdfReadTool = createPdfReadTool();
    registry.register({
      ...pdfReadTool,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });
  } catch (err) {
    console.error("[ToolSetup] Failed to load pdf_read tool:", err instanceof Error ? err.message : String(err));
  }

  // -----------------------------------------------------------------------
  // Wikipedia API tool
  // -----------------------------------------------------------------------

  try {
    const { createWikipediaTool } = await import("./tools/wikipedia-tool.js");
    const wikipediaTool = createWikipediaTool();
    registry.register({
      ...wikipediaTool,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });
  } catch (err) {
    console.error("[ToolSetup] Failed to load wikipedia tool:", err instanceof Error ? err.message : String(err));
  }

  // -----------------------------------------------------------------------
  // Scholar Search tool (Semantic Scholar API)
  // -----------------------------------------------------------------------

  try {
    const { createScholarSearchTool } = await import("./tools/scholar-search-tool.js");
    const scholarTool = createScholarSearchTool();
    registry.register({
      ...scholarTool,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });
  } catch (err) {
    console.error("[ToolSetup] Failed to load scholar_search tool:", err instanceof Error ? err.message : String(err));
  }

  try {
    const { createYouTubeTool } = await import("./tools/youtube-tool.js");
    const youtubeTool = createYouTubeTool();
    registry.register({
      ...youtubeTool,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });
  } catch (err) {
    console.error("[ToolSetup] Failed to load youtube tool:", err instanceof Error ? err.message : String(err));
  }

  // -----------------------------------------------------------------------
  // Browser tool (Playwright-based, heavy — lazy loaded)
  // -----------------------------------------------------------------------

  try {
    const { createBrowserTool } = await import("./tools/browser-tool.js");
    const browserTool = createBrowserTool();
    registry.register({
      ...browserTool,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });
  } catch {
    // Playwright not available
  }

  // -----------------------------------------------------------------------
  // Sub-agent transcript tool
  // -----------------------------------------------------------------------

  try {
    const { createTranscriptTool } = await import("./tools/transcript-tool.js");
    const transcriptTool = createTranscriptTool(deps.dataDir);
    registry.register({
      ...transcriptTool,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });
  } catch {
    // Transcript tool not available
  }

  // -----------------------------------------------------------------------
  // Multimedia generation tools (TTS, image, video, music)
  // -----------------------------------------------------------------------

  const { CapabilityDispatcher } = await import("../../models/capability-dispatcher.js");
  const dispatcher = new CapabilityDispatcher();

  registry.register({
    name: "tts_generate",
    description:
      "从文本生成语音音频。将文本输入转换为自然语音。" +
      "返回音频文件路径和元数据。支持中文和英文。",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "要转换为语音的文本",
        },
        voice: {
          type: "string",
          description: "语音名称（默认：male-qn-qingse）",
        },
        speed: {
          type: "number",
          description: "语速（默认：1.0）",
        },
      },
      required: ["text"],
    },
    async execute(input: Record<string, unknown>) {
      try {
        const result = await dispatcher.textToSpeech(input.text as string, {
          voice: input.voice as string | undefined,
          speed: input.speed as number | undefined,
        });

        // Save audio to data directory
        const filename = `tts-${Date.now()}.mp3`;
        const ctx = registry.getExecutionContext();
        const sid = ctx?.sessionId as string | undefined;
        const generatedDir = sid
          ? getSessionGeneratedDir(deps.dataDir, sid)
          : join(deps.dataDir, "generated");
        mkdirSync(generatedDir, { recursive: true });
        const filePath = join(generatedDir, filename);
        writeFileSync(filePath, Buffer.from(result.audio));

        return {
          success: true,
          filePath: relative(deps.dataDir, filePath).replace(/\\/g, "/"),
          contentType: result.contentType,
          sizeBytes: result.audio.byteLength,
        };
      } catch (err) {
        return { error: `TTS generation failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    shouldDefer: true,
  });

  registry.register({
    name: "image_generate",
    description:
      "根据文本描述生成图片。根据提示词创建视觉内容。" +
      "返回图片文件路径。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "图片生成提示词，描述所需图片",
        },
        width: {
          type: "number",
          description: "图片宽度（像素）",
        },
        height: {
          type: "number",
          description: "图片高度（像素）",
        },
      },
      required: ["prompt"],
    },
    async execute(input: Record<string, unknown>) {
      try {
        const result = await dispatcher.generateImage(input.prompt as string, {
          width: input.width as number | undefined,
          height: input.height as number | undefined,
        });

        const dir = join(deps.dataDir, "generated");
        const imgCtx = registry.getExecutionContext();
        const imgSid = imgCtx?.sessionId as string | undefined;
        const generatedDir = imgSid
          ? getSessionGeneratedDir(deps.dataDir, imgSid)
          : dir;
        mkdirSync(generatedDir, { recursive: true });
        const filename = `image-${Date.now()}.png`;
        writeFileSync(join(generatedDir, filename), Buffer.from(result.image));

        return {
          success: true,
          filePath: relative(deps.dataDir, join(generatedDir, filename)).replace(/\\/g, "/"),
          contentType: result.contentType,
          sizeBytes: result.image.byteLength,
        };
      } catch (err) {
        return { error: `Image generation failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    shouldDefer: true,
  });

  registry.register({
    name: "video_generate",
    description:
      "根据文本提示生成视频。创建 AI 视频（可能需要几分钟）。" +
      "返回视频文件 URL 或路径。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "视频生成提示词，描述所需的视频内容",
        },
      },
      required: ["prompt"],
    },
    async execute(input: Record<string, unknown>) {
      try {
        const result = await dispatcher.generateVideo(input.prompt as string);

        return {
          success: true,
          fileUrl: result.fileUrl,
          contentType: result.contentType,
        };
      } catch (err) {
        return { error: `Video generation failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    shouldDefer: true,
  });

  registry.register({
    name: "music_generate",
    description:
      "根据文本提示生成音乐。根据描述创建音频文件。" +
      "返回音频文件路径。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "音乐生成提示词，描述所需的音乐风格/情绪",
        },
        duration: {
          type: "number",
          description: "所需时长（秒）",
        },
      },
      required: ["prompt"],
    },
    async execute(input: Record<string, unknown>) {
      try {
        const result = await dispatcher.generateMusic(input.prompt as string, {
          duration: input.duration as number | undefined,
        });

        const dir = join(deps.dataDir, "generated");
        const musCtx = registry.getExecutionContext();
        const musSid = musCtx?.sessionId as string | undefined;
        const generatedDir = musSid
          ? getSessionGeneratedDir(deps.dataDir, musSid)
          : dir;
        mkdirSync(generatedDir, { recursive: true });
        const filename = `music-${Date.now()}.mp3`;
        writeFileSync(join(generatedDir, filename), Buffer.from(result.audio));

        return {
          success: true,
          filePath: relative(deps.dataDir, join(generatedDir, filename)).replace(/\\/g, "/"),
          contentType: result.contentType,
          sizeBytes: result.audio.byteLength,
        };
      } catch (err) {
        return { error: `Music generation failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    shouldDefer: true,
  });

  // -----------------------------------------------------------------------
  // tool_discover tool — discover and activate deferred tools
  // -----------------------------------------------------------------------
  // Allows the agent to find tools that were not included in the initial
  // tool definitions to save input tokens. The agent can search by keyword
  // or directly select tools by name.

  registry.register({
    name: "tool_discover",
    description:
      "搜索和发现可用工具。当你需要某个能力但当前工具列表中没有时，使用此工具搜索。" +
      "返回匹配工具的名称和简短描述。支持关键词搜索或直接选择（格式：select:tool_name）。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词，或使用 'select:tool_name' 直接选择（支持逗号分隔多个）",
        },
      },
      required: ["query"],
    },
    async execute(input: Record<string, unknown>) {
      const query = (input.query as string).trim();

      // All tools with descriptions for discovery
      const allTools: Record<string, string> = {
        think: "逐步思考推理（核心工具）",
        finish: "完成任务并返回结果（核心工具）",
        kb_search: "语义+关键词搜索知识库文档",
        wiki_browse: "浏览 Wiki 页面和文档列表",
        expand: "逐层展开文档内容（L0→L1→L2）",
        doc_grep: "正则搜索 Wiki 页面内容",
        timeline_build: "从文档内容构建时间线",
        graph_build: "构建实体关系图",
        push_content: "推送结构化内容到前端界面",
        agent_todo: "任务清单管理和进度跟踪",
        ask_user: "向用户提问并等待回答",
        read_file: "读取数据目录中的文件",
        write_file: "创建或覆盖文件",
        edit_file: "编辑文件（精确字符串替换）",
        grep: "在文件中搜索文本模式",
        glob: "按模式查找文件",
        bash: "执行 Shell 命令",
        run_sql: "执行 SQL 查询（只读）",
        web_search: "搜索网络获取信息",
        web_fetch: "获取指定 URL 的网页内容（轻量级 HTTP 请求）",
        scholar_search: "搜索学术论文（Semantic Scholar API，查找论文/作者/引用）",
        pdf_read: "读取 PDF 文件并提取文本内容（Docling OCR + 表格提取）",
        wikipedia: "搜索和获取 Wikipedia 百科条目内容",
        youtube_transcript: "获取 YouTube 视频字幕/转写文本",
        browser: "无头浏览器：导航、截图、提取文本",
        tts_generate: "文本转语音",
        image_generate: "文本生成图片",
        video_generate: "文本生成视频",
        music_generate: "文本生成音乐",
        workflow_run: "启动多 Agent 并行工作流",
        skill_invoke: "调用用户自定义技能",
        list_skills: "列出可用的自定义技能",
        skill_create: "创建新的自定义技能",
        skill_update: "更新已有技能",
        skill_delete: "删除技能",
        tool_discover: "搜索和发现可用工具",
        image_analysis: "使用视觉语言模型（VLM）分析图片内容（外部URL、文件路径等）",
        tool_create: "动态创建新的可执行工具",
        skill_search: "搜索和列出可用的技能",
        skill_hub_search: "搜索 ClawHub 远程技能注册中心",
        skill_hub_install: "从 ClawHub 下载并安装技能",
        task_output: "获取后台任务的结果",
        send_message: "向其他 Agent 发送消息",
        list_files: "列出目录内容",
        notebook_read: "读取 Jupyter Notebook 文件",
        context_expand: "扩展上下文窗口（内部工具）",
      };

      // Direct select mode
      if (query.startsWith("select:")) {
        const names = query.slice(7).split(",").map(n => n.trim()).filter(Boolean);
        const found: Array<{ name: string; description: string }> = [];
        const activateTools: string[] = [];
        for (const name of names) {
          if (allTools[name]) {
            found.push({ name, description: allTools[name] });
            // If this is a deferred tool, signal the runner to activate it
            if (DEFERRED_TOOLS.has(name)) {
              activateTools.push(name);
            }
          }
        }
        return {
          mode: "select",
          requested: names,
          found,
          message: found.length > 0
            ? `Found ${found.length} tool(s). You can now call these tools directly by name.`
            : "No matching tools found. Check spelling and try again.",
          ...(activateTools.length > 0 ? { __activate_tools__: activateTools } : {}),
        };
      }

      // Keyword search mode
      const lowerQuery = query.toLowerCase();
      const results = Object.entries(allTools)
        .filter(([name, desc]) => {
          const nameMatch = name.toLowerCase().includes(lowerQuery);
          const descMatch = desc.toLowerCase().includes(lowerQuery);
          return nameMatch || descMatch;
        })
        .map(([name, description]) => ({ name, description }))
        .slice(0, 10);

      return {
        mode: "search",
        query,
        results,
        totalAvailable: Object.keys(allTools).length,
        hint: results.length === 0
          ? "No matches found. Try broader keywords or use 'select:tool_name' for exact match."
          : undefined,
      };
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  });

  // -----------------------------------------------------------------------
  // task_output tool — get result from a background task
  // -----------------------------------------------------------------------

  registry.register({
    name: "task_output",
    description:
      "获取后台任务的结果。当 workflow_run 使用后台模式启动的子Agent完成时，" +
      "用此工具获取其输出结果。也可用于查询任何已知任务 ID 的状态。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "后台任务的 ID",
        },
      },
      required: ["task_id"],
    },
    async execute(input: Record<string, unknown>) {
      const taskId = input.task_id as string;
      try {
        const repos = await getRepos();
        const task = await repos.agentTask.get(taskId);
        if (!task) {
          return { error: `Task ${taskId} not found.` };
        }
        return {
          taskId: task.id,
          agentType: task.agentType,
          status: task.status,
          output: task.output ?? null,
          error: task.error ?? null,
          createdAt: task.createdAt,
          completedAt: task.completedAt ?? null,
        };
      } catch (err) {
        return { error: `Failed to get task: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });

  // -----------------------------------------------------------------------
  // send_message tool — send messages between agents in a workflow
  // -----------------------------------------------------------------------

  registry.register({
    name: "send_message",
    description:
      "在工作流中向其他 Agent 发送消息。支持定向发送（指定目标 Agent ID）和广播（target='all'）。" +
      "接收方 Agent 可以在其消息队列中读取消息。" +
      "仅在使用 workflow_run 的 graph 或 parallel 模式时可用。",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "目标 Agent ID，或 'all' 广播给所有其他 Agent",
        },
        message: {
          type: "string",
          description: "要发送的消息内容",
        },
      },
      required: ["target", "message"],
    },
    async execute(input: Record<string, unknown>) {
      const target = input.target as string;
      const message = input.message as string;

      // Store message via execution context mailbox
      const ctx = registry.getExecutionContext();
      const mailbox = ctx.mailbox as Map<string, Array<{ from: string; message: string; timestamp: string }>> | undefined;

      if (!mailbox) {
        return { error: "Mailbox not available. send_message only works within workflow_run graph/parallel mode." };
      }

      const myId = ctx.agentId as string ?? "unknown";
      const envelope = {
        from: myId,
        message,
        timestamp: new Date().toISOString(),
      };

      if (target === "all") {
        // Broadcast to all agents except self
        let count = 0;
        for (const [agentId, queue] of mailbox.entries()) {
          if (agentId !== myId) {
            queue.push(envelope);
            count++;
          }
        }
        return { delivered: count, mode: "broadcast" };
      } else {
        // Direct message
        if (!mailbox.has(target)) {
          mailbox.set(target, []);
        }
        mailbox.get(target)!.push(envelope);
        return { delivered: 1, mode: "direct", target };
      }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });

  // Register universal tools
  const { UNIVERSAL_TOOLS } = await import("./tools/universal-tools.js");
  for (const tool of UNIVERSAL_TOOLS) {
    registry.register(tool);
  }

  // Auto-load plugins from plugins/ directory
  const repos = await getRepos();
  try {
    const pluginManager = new AgentPluginManager();
    const pluginsDir = join(process.cwd(), "plugins");
    const { readdir } = await import("fs/promises");
    const entries = await readdir(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pluginPath = join(pluginsDir, entry.name);
        try {
          const loadedPlugin = await pluginManager.loadPlugin(pluginPath);

          // Write plugin metadata to DB so the frontend Plugin panel can display it
          await repos.plugin.upsert({
            id: `plugin-${loadedPlugin.manifest.name}`,
            name: loadedPlugin.manifest.name,
            version: loadedPlugin.manifest.version ?? "0.0.0",
            enabled: true,
            config: {
              description: loadedPlugin.manifest.description ?? "",
              capabilities: loadedPlugin.manifest.capabilities ?? [],
              skillsCount: loadedPlugin.skills.length,
              agentsCount: loadedPlugin.agents.length,
              rootDir: pluginPath,
            },
          });
          console.log(`[ToolSetup] Plugin "${loadedPlugin.manifest.name}" registered in DB`);
        } catch (err) {
          console.warn(`[ToolSetup] Failed to load plugin ${entry.name}:`, err);
        }
      }
    }
    // Register plugin skills into the DB so they are discoverable via skill_invoke
    // Iterate plugins directly to track pluginId per skill
    let totalPluginSkills = 0;
    for (const loadedPlugin of pluginManager.list()) {
      for (const skillManifest of loadedPlugin.skills) {
        const existing = await repos.agentSkill.getByNameAndSource(skillManifest.name, "plugin");
        if (!existing) {
          await repos.agentSkill.create({
            name: skillManifest.name,
            description: skillManifest.description,
            prompt: skillManifest.systemPrompt,
            tools: skillManifest.tools,
            modelRole: skillManifest.modelRole ?? "main",
            source: "plugin",
            pluginId: loadedPlugin.manifest.name,
          });
          console.log(`[ToolSetup] Registered skill "${skillManifest.name}" from plugin "${loadedPlugin.manifest.name}"`);
          totalPluginSkills++;
        } else if (existing.description !== skillManifest.description || existing.prompt !== skillManifest.systemPrompt) {
          // Sync: update description and prompt if SKILL.md has changed
          await repos.agentSkill.update(existing.id, {
            description: skillManifest.description,
            prompt: skillManifest.systemPrompt,
            tools: skillManifest.tools,
          });
          console.log(`[ToolSetup] Updated skill "${skillManifest.name}" from plugin "${loadedPlugin.manifest.name}" (content changed)`);
          totalPluginSkills++;
        }
      }
    }
    if (totalPluginSkills > 0) {
      console.log(`[ToolSetup] Loaded ${totalPluginSkills} skills from plugins`);
    }
  } catch {
    // plugins/ directory doesn't exist - that's fine
  }

  // Register tool_create (dynamic tool creation at runtime)
  try {
    const { createToolCreateTool } = await import("./tools/tool-create-tool.js");
    registry.register(createToolCreateTool(registry));
  } catch (err) {
    console.warn("[ToolSetup] Failed to register tool_create:", err);
  }

  // Register skill_search (list and search available skills)
  registry.register({
    name: "skill_search",
    description:
      "搜索和列出所有可用的技能。返回技能名称、描述和适用场景。" +
      "不带参数时返回全部技能列表；提供 query 时按名称和描述过滤。" +
      "用于发现当前系统中有哪些可调用的技能。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词（可选），按技能名称和描述过滤",
        },
      },
    },
    async execute(input: Record<string, unknown>) {
      const repos2 = await getRepos();
      const skills = await repos2.agentSkill.list();
      const query = ((input.query as string) ?? "").toLowerCase().trim();

      const results = skills
        .filter((s) => {
          if (!query) return true;
          return (
            s.name.toLowerCase().includes(query) ||
            (s.description ?? "").toLowerCase().includes(query)
          );
        })
        .map((s) => ({
          name: s.name,
          description: s.description,
          isActive: s.isActive,
          source: s.source,
        }));

      return {
        total: results.length,
        skills: results,
        hint: results.length > 0
          ? `Use skill_invoke with the skill name to activate it.`
          : "No skills found. Use skill_create to create a new skill.",
      };
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });

  // Register built-in skills (deep-research, etc.)
  await ensureBuiltinSkills(repos);

  // -----------------------------------------------------------------------
  // ClawHub remote skill registry tools
  // -----------------------------------------------------------------------
  try {
    const { skillHubSearchTool, createSkillHubInstallTool } = await import("./tools/clawhub-tools.js");
    registry.register(skillHubSearchTool);
    registry.register(createSkillHubInstallTool(deps.dataDir));
    console.log("[ToolSetup] Registered ClawHub skill hub tools (skill_hub_search, skill_hub_install)");
  } catch (err) {
    console.warn("[ToolSetup] Failed to register ClawHub tools:", err);
  }

  // -----------------------------------------------------------------------
  // structured_output tool (JSON Schema validated output for SDK usage)
  // -----------------------------------------------------------------------
  registry.register(structuredOutputTool);

  // Apply enhanced tool descriptions (structured descriptions with usage guidelines)
  for (const tool of registry.getAll()) {
    const enhanced = getEnhancedDescription(tool.name, tool.description);
    if (enhanced !== tool.description) {
      registry.register({ ...tool, description: enhanced });
    }
  }

  return registry;
}

// ---------------------------------------------------------------------------
// workflow_run tool registration (for multi-agent workflows)
// ---------------------------------------------------------------------------

/** Dependencies needed to register the workflow_run tool. */
export interface WorkflowRunDeps {
  runner: any;
  toolRegistry: ToolRegistry;
  getTeamManager: () => Promise<any>;
  emitWs: (event: any) => void;
  /** Root data directory for file persistence (sub-agent output files). */
  dataDir: string;
}

/**
 * Register the workflow_run tool on an existing ToolRegistry.
 *
 * This is called during orchestrator initialization (after the AgentRunner
 * and ToolRegistry have been created) to enable multi-agent workflow execution.
 */
export async function registerWorkflowRunTool(registry: ToolRegistry, deps: WorkflowRunDeps): Promise<void> {
  const { createWorkflowRunTool } = await import("./tools/workflow-run.js");
  const workflowTool = createWorkflowRunTool({
    runner: deps.runner,
    toolRegistry: deps.toolRegistry,
    onEvent: deps.emitWs,
    dataDir: deps.dataDir,
  });
  registry.register({
    ...workflowTool,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  });
}

// ---------------------------------------------------------------------------
// delegate_task tool registration (lightweight single-task delegation)
// ---------------------------------------------------------------------------

/**
 * Register the delegate_task tool — a lightweight alternative to workflow_run
 * for delegating a single analysis/search/processing task to a sub-agent.
 * The sub-agent works in an independent context and returns only a brief summary,
 * keeping the parent agent's context small.
 */
export async function registerDelegateTaskTool(registry: ToolRegistry, deps: WorkflowRunDeps): Promise<void> {
  registry.register({
    name: "delegate_task",
    description:
      "将分析/搜索/处理任务委托给子Agent在独立上下文中执行，只返回简要结果摘要。" +
      "适用于：文档分析、搜索调查、数据处理等会产生大量中间结果的任务。" +
      "子Agent拥有独立的完整上下文窗口，不受你当前上下文限制。" +
      "比你直接使用 expand/kb_search/doc_grep 更节省你的上下文空间。" +
      "返回内容为简要摘要，如需详细结果查看子Agent写入的文件。",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "详细任务描述，包含目标、范围、输出要求。",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "子Agent可用的工具列表。默认所有工具。一般不需要指定。",
        },
        context: {
          type: "string",
          description: "附加上下文信息（如用户原始问题、相关文档清单等），注入到子Agent任务前。",
        },
      },
      required: ["task"],
    },
    async execute(input: Record<string, unknown>) {
      const task = String(input.task || "");
      const tools = input.tools as string[] | undefined;
      const context = input.context as string | undefined;

      if (!task.trim()) {
        return { error: "任务描述不能为空" };
      }

      // Build the full task with optional context prefix
      let fullTask = task;
      if (context) {
        fullTask = `[任务上下文]\n${context}\n\n---\n\n${task}`;
      }

      // Get the execution context for event forwarding
      const execCtx = deps.toolRegistry.getExecutionContext();
      const parentSignal = execCtx.signal as AbortSignal | undefined;

      // Check if background (non-blocking) mode is enabled
      const { resolveFeatureFlags } = await import("./feature-flags.js");
      const featureFlags = resolveFeatureFlags();
      if (featureFlags.backgroundWorkflows) {
        // Non-blocking mode: run sub-agent via WorkflowManager, return immediately
        const { getWorkflowManager } = await import("./workflow-manager.js");
        const wm = getWorkflowManager();
        const sessionId = (execCtx.sessionId as string) ?? "unknown";

        // Concurrency control: allow multiple concurrent delegate tasks up to
        // MAX_CONCURRENT_AGENTS. The previous binary hasActive() check was too
        // aggressive — it blocked delegate_task when called from within a running
        // workflow (e.g., audit agent dispatching gap-filling agents), because
        // the parent workflow itself was registered as active.
        const activeWorkflows = wm.listActive(sessionId)
          .filter(w => w.status === "running");
        if (activeWorkflows.length >= 10) {
          const activeDesc = activeWorkflows.map(w => `- "${w.goal.slice(0, 100)}" (${w.status}, ${Math.round((Date.now() - w.startTime) / 1000)}s)`).join("\n");
          return {
            status: "already_running",
            message: `当前有 ${activeWorkflows.length} 个子Agent在并发运行（上限10个），请等待部分完成后再派发新任务。运行中的任务:\n${activeDesc}\n\n系统会在子Agent完成时自动通知你。在等待期间，你可以继续其他工作或回应用户的消息。`,
          };
        }

        // Use WorkflowEngine's "single" mode for delegate_task
        const delegateWorkflowId = wm.startWorkflow({
          sessionId,
          goal: fullTask,
          mode: "single",
          teamName: "delegate",
          agents: [{
            id: "delegate-agent",
            role: "子Agent",
            task: fullTask,
            tools: tools ?? ["*"],
            contextText: context,
          }],
          runner: deps.runner,
          toolRegistry: deps.toolRegistry,
          onEvent: deps.emitWs ? (event: any) => {
            // Workflow lifecycle events (workflow_start/complete/agent_start/agent_complete)
            // must be forwarded as-is so the SSE filter can register the real workflowId
            // and emit the proper event type to the frontend. Downgrading them to
            // workflow_agent_tool_result (the old behavior) caused workflow_start to be
            // invisible to SSE, forcing the frontend to recover via REST and showing
            // "(recovered)" placeholder cards. See RR1 in plan floating-swimming-hopper.md.
            const LIFECYCLE_TYPES = new Set([
              "workflow_start",
              "workflow_complete",
              "workflow_agent_start",
              "workflow_agent_complete",
            ]);
            if (typeof event.type === "string" && LIFECYCLE_TYPES.has(event.type)) {
              deps.emitWs!(event);
              return;
            }
            // Tool/text events: wrap as workflow_agent_tool_result, but preserve the
            // real workflowId/agentId (instead of hardcoding "delegate") so SSE can
            // route them correctly. Forward sessionId/parentTaskId for traceability.
            deps.emitWs!({
              type: "workflow_agent_tool_result",
              workflowId: event.workflowId ?? "delegate",
              agentId: event.agentId ?? "delegate-agent",
              sessionId: event.sessionId,
              parentTaskId: event.parentTaskId,
              toolName: event.toolName ?? "",
              tool: event.toolName ?? "",
              result: event.result,
            });
          } : undefined,
          signal: parentSignal,
          dataDir: deps.dataDir,
        });

        return {
          status: "dispatched",
          workflowId: delegateWorkflowId,
          message: `子Agent已在后台启动，正在独立执行任务。子Agent完成时系统会自动将结果发送给你。在等待期间，请不要再次调用 delegate_task，你可以继续回应用户的消息。`,
          task: fullTask.slice(0, 200),
        };
      }

      // Blocking mode (default): original behavior — await sub-agent completion
      try {
        const runnerResult = await deps.runner.run({
          input: fullTask,
          agentType: "general",
          toolsOverride: tools ?? ["*"],
          signal: parentSignal,
          onEvent: (event: any) => {
            // Forward sub-agent events through the workflow event pipeline
            if (deps.emitWs) {
              deps.emitWs({
                type: "workflow_agent_tool_result",
                workflowId: "delegate",
                agentId: "delegate-agent",
                toolName: event.toolName || "",
                tool: event.toolName || "",
                result: event.result,
              });
            }
          },
        });

        // Adaptive output routing: use sub-agent's own finish summary when available
        const output = runnerResult.output || "";
        const finishSummary = runnerResult.finishSummary;
        const filesWritten = runnerResult.filesWritten || [];

        let summary: string;
        if (finishSummary && finishSummary.length > 20) {
          // Sub-agent wrote a meaningful summary — use it as the primary output
          summary = finishSummary;
          if (filesWritten.length > 0) {
            summary += `\n\n生成的文件:\n${filesWritten.map((f: string) => `- ${f}`).join("\n")}`;
          }
          // If full output is much larger than summary, persist to file for on-demand access
          if (output.length > finishSummary.length * 3 && output.length > 2000 && deps.dataDir) {
            try {
              const { mkdirSync, writeFileSync } = await import("node:fs");
              const timestamp = Date.now();
              const delCtx = deps.toolRegistry.getExecutionContext();
              const delSid = delCtx?.sessionId as string | undefined;
              if (delSid) {
                const dir = getSessionSubagentsDir(deps.dataDir, delSid);
                mkdirSync(dir, { recursive: true });
                const prefixedName = makeAgentFilename("sub", `delegate_${timestamp}.md`);
                const filePath = join(dir, prefixedName);
                writeFileSync(filePath, output, "utf-8");
                summary += `\n\n完整输出已保存: ${relative(deps.dataDir, filePath).replace(/\\/g, "/")}`;
              } else {
                // Fallback for no session context
                const dir = join(deps.dataDir, "tmp", "delegate-results", `delegate_${timestamp}`);
                mkdirSync(dir, { recursive: true });
                const filePath = join(dir, "output.md");
                writeFileSync(filePath, output, "utf-8");
                summary += `\n\n完整输出已保存: ${relative(deps.dataDir, filePath).replace(/\\/g, "/")}`;
              }
            } catch { /* best effort */ }
          }
        } else {
          // No summary — return full output directly
          summary = output;
        }

        return {
          completed: true,
          summary,
          turnsUsed: runnerResult.turnsUsed,
          toolCalls: runnerResult.toolCalls,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          completed: false,
          error: `子Agent执行失败: ${errMsg}`,
        };
      }
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  });
}

// ---------------------------------------------------------------------------
// workflow_status tool registration (query background workflow status)
// ---------------------------------------------------------------------------

/**
 * Register the workflow_status tool for querying background workflow progress.
 * Only useful when backgroundWorkflows feature flag is enabled.
 */
export function registerWorkflowStatusTool(registry: ToolRegistry): void {
  registry.register({
    name: "workflow_status",
    description:
      "查询后台工作流的状态和结果。action=list 列出当前会话所有工作流；action=status 查看指定工作流详情。" +
      "仅在后台工作流模式下有效（workflow_run 返回 dispatched 时使用）。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "list"],
          description: "status: 查看指定工作流详情（需提供 workflowId）；list: 列出当前会话所有工作流。",
        },
        workflowId: {
          type: "string",
          description: "要查询的工作流ID（action=status 时必填）。",
        },
      },
      required: ["action"],
    },
    async execute(input: Record<string, unknown>) {
      // Dynamic import to avoid circular deps at module load
      const { getWorkflowManager } = await import("./workflow-manager.js");
      const wm = getWorkflowManager();
      const execCtx = registry.getExecutionContext();
      const sessionId = execCtx.sessionId as string | undefined;

      if (input.action === "list") {
        if (!sessionId) return { workflows: [] };
        return { workflows: wm.listActive(sessionId) };
      }

      // action === "status"
      const workflowId = input.workflowId as string | undefined;
      if (!workflowId) {
        return { error: "workflowId is required for action=status" };
      }
      const status = wm.getStatus(workflowId);
      if (!status) {
        return { error: `Workflow not found: ${workflowId}` };
      }
      return status;
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
  });
}

// ---------------------------------------------------------------------------
// Cron Agent Tools (cron_create / cron_list / cron_delete)
// ---------------------------------------------------------------------------

/**
 * Register cron management tools that allow Agents to self-manage scheduled tasks.
 * These are deferred tools — only discovered via tool_discover when the Agent needs them.
 */
export function registerCronTools(registry: ToolRegistry): void {
  // --- cron_create ---
  registry.register({
    name: "cron_create",
    description:
      "创建一个定时任务。到时后系统会自动创建新的 Agent session 执行指定的消息。" +
      "使用场景：需要定期监控数据变化、周期性生成报告、定时检查知识库状态等。" +
      "schedule 为标准 5 段 cron 表达式：分 时 日 月 周（如 '0 9 * * *' = 每天9点，'*/30 * * * *' = 每30分钟）。",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "任务名称（简短描述用途）",
        },
        schedule: {
          type: "string",
          description: "Cron 表达式（分 时 日 月 周），如 '0 9 * * *'",
        },
        message: {
          type: "string",
          description: "到时后 Agent 执行的消息内容（具体的任务指令）",
        },
        enabled: {
          type: "boolean",
          description: "是否立即启用（默认 true）",
        },
      },
      required: ["name", "schedule", "message"],
    },
    async execute(input: Record<string, unknown>) {
      const { CronService } = await import("../cron/service.js");
      const service = new CronService();
      try {
        const job = await service.createJob({
          name: input.name as string,
          schedule: input.schedule as string,
          message: input.message as string,
          enabled: input.enabled as boolean | undefined,
        });
        return {
          success: true,
          job: {
            id: job.id,
            name: job.name,
            schedule: job.schedule,
            nextRun: job.nextRun,
            enabled: job.enabled,
          },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    shouldDefer: true,
  });

  // --- cron_list ---
  registry.register({
    name: "cron_list",
    description:
      "列出所有定时任务及其状态。显示任务名称、计划、上次/下次运行时间、运行次数等。",
    inputSchema: {
      type: "object",
      properties: {
        enabledOnly: {
          type: "boolean",
          description: "是否只显示启用的任务（默认 false，显示全部）",
        },
      },
    },
    async execute(input: Record<string, unknown>) {
      const { CronService } = await import("../cron/service.js");
      const service = new CronService();
      const jobs = await service.listJobs();
      const enabledOnly = input.enabledOnly as boolean | undefined;
      const filtered = enabledOnly ? jobs.filter(j => j.enabled) : jobs;
      return {
        total: filtered.length,
        jobs: filtered.map(j => ({
          id: j.id,
          name: j.name,
          schedule: j.schedule,
          enabled: j.enabled,
          lastRun: j.lastRun,
          nextRun: j.nextRun,
          lastStatus: j.lastStatus,
          runCount: j.runCount,
          errorCount: j.errorCount,
        })),
      };
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    shouldDefer: true,
  });

  // --- cron_delete ---
  registry.register({
    name: "cron_delete",
    description:
      "删除一个定时任务。通过任务 ID 指定要删除的任务（先用 cron_list 查看所有任务获取 ID）。",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "要删除的定时任务 ID",
        },
      },
      required: ["id"],
    },
    async execute(input: Record<string, unknown>) {
      const { CronService } = await import("../cron/service.js");
      const service = new CronService();
      const id = input.id as string;
      const deleted = await service.deleteJob(id);
      return {
        success: deleted,
        message: deleted ? `定时任务 ${id} 已删除` : `未找到任务 ${id}`,
      };
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    shouldDefer: true,
  });
}
