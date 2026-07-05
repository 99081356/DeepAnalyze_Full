// =============================================================================
// DeepAnalyze - KB Filesystem Manifest
// =============================================================================
// Generates per-KB manifest.json files that map docId (UUID directory names)
// to human-readable filenames. This lets Agents use bash grep/cat/find directly
// on L1 markdown files stored at wiki/{kbId}/documents/{docId}/parsed.md.
// =============================================================================

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getRepos } from "../store/repos/index.js";
import { writeFileSyncAtomic } from "../utils/atomicWrite.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  docId: string;
  fileName: string;
  folderPath: string;
  fileType: string;
  status: string;
  wikiPath: string;
  originalPath: string;
}

export interface Manifest {
  kbId: string;
  generatedAt: string;
  documents: ManifestEntry[];
}

// ---------------------------------------------------------------------------
// updateManifest — regenerate manifest.json for a single KB
// ---------------------------------------------------------------------------

/**
 * Regenerate the manifest.json file for a knowledge base.
 * Reads all documents from the DB and writes a complete manifest.
 *
 * This function never throws — errors are logged and swallowed so that
 * manifest failures never block document processing or deletion.
 */
export async function updateManifest(kbId: string): Promise<void> {
  const dataDir = process.env.DATA_DIR ?? "data";

  try {
    const repos = await getRepos();
    const docs = await repos.document.getByKbId(kbId);

    const documents: ManifestEntry[] = docs.map((d) => ({
      docId: d.id,
      fileName: d.filename,
      folderPath: d.folder_path || "",
      fileType: d.file_type,
      status: d.status,
      wikiPath: `wiki/${kbId}/documents/${d.id}/parsed.md`,
      originalPath: `original/${kbId}/${d.folder_path ? d.folder_path + "/" : ""}${d.filename}`,
    }));

    const manifest: Manifest = {
      kbId,
      generatedAt: new Date().toISOString(),
      documents,
    };

    const kbDir = join(dataDir, "wiki", kbId);
    mkdirSync(kbDir, { recursive: true });

    const manifestPath = join(kbDir, "manifest.json");
    writeFileSyncAtomic(manifestPath, JSON.stringify(manifest, null, 2), { encoding: "utf-8" });

    console.log(
      `[Manifest] Updated manifest for KB ${kbId}: ${documents.length} documents`,
    );
  } catch (err) {
    console.warn(
      `[Manifest] Failed to update manifest for KB ${kbId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// buildKbFilesystemSection — generate system prompt injection text
// ---------------------------------------------------------------------------

/**
 * Build a concise system prompt section describing the KB filesystem layout.
 * Only includes KBs whose manifest.json exists on disk.
 *
 * @param scopeKbIds - KB IDs from the current session scope
 * @param dataDir - The data directory path
 * @returns Prompt text, or empty string if no manifests found
 */
export async function buildKbFilesystemSection(
  scopeKbIds: string[],
  dataDir: string,
): Promise<string> {
  try {
    const repos = await getRepos();
    const allKbs = await repos.knowledgeBase.list();
    const kbEntries: string[] = [];

    for (const kbId of scopeKbIds) {
      const manifestPath = join(dataDir, "wiki", kbId, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      const kb = allKbs.find((k) => k.id === kbId);
      const kbName = kb ? kb.name : kbId;
      kbEntries.push(`- "${kbName}" → wiki/${kbId}/manifest.json`);
    }

    if (kbEntries.length === 0) return "";

    return (
      "## 知识库文件系统\n\n" +
      "文档的 L1 全文存储为 Markdown 文件，可直接用 bash grep/cat 访问。" +
      "先用 `cat wiki/{kbId}/manifest.json` 查看文档名到路径的映射。\n\n" +
      "文档原始文件保留上传时的目录结构，可用 bash 工具直接访问。" +
      "原始文件路径格式：`original/{kbId}/{folderPath}/{filename}`。\n\n" +
      "当前可用知识库：\n" +
      kbEntries.join("\n") +
      "\n\n" +
      "使用方法：\n" +
      "- 查看文档列表：`cat wiki/{kbId}/manifest.json`\n" +
      "- 搜索关键词：`grep -rl 'pattern' wiki/{kbId}/documents/*/parsed.md`\n" +
      "- 读取指定文档：`cat wiki/{kbId}/documents/{docId}/parsed.md`\n" +
      "- 查看原始文件目录结构：`ls original/{kbId}/` 或 `find original/{kbId}/ -type f`\n" +
      "- 跨 KB 搜索：`grep -rl 'pattern' wiki/{kbId1}/documents/*/parsed.md wiki/{kbId2}/documents/*/parsed.md`\n\n" +
      "注意：仅 status=ready 的文档有可用的 parsed.md。" +
      "manifest 是缓存，权威数据用 wiki_browse 获取。\n" +
      "对于精确文本匹配和批量搜索，bash grep 比语义搜索（kb_search）更可靠且不遗漏。"
    );
  } catch (err) {
    console.warn(
      "[Manifest] Failed to build filesystem section:",
      err instanceof Error ? err.message : String(err),
    );
    return "";
  }
}
