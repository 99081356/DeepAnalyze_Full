/**
 * MinerUProcessor — document processor that delegates to MinerU API.
 *
 * Implements the same DocumentProcessor interface as DoclingProcessor,
 * returning a ParsedContent so the downstream WikiCompiler works unchanged.
 */

import { resolve } from "node:path";
import type { DocumentProcessor, ParsedContent } from "./types.js";
import { MinerUClient, DEFAULT_MINERU_CONFIG } from "./mineru-client.js";
import type { MinerUConfig } from "./mineru-client.js";
import { getRepos } from "../../store/repos/index.js";

// ---------------------------------------------------------------------------
// MinerU Processor
// ---------------------------------------------------------------------------

export class MinerUProcessor implements DocumentProcessor {
  private static readonly HANDLED_TYPES = new Set([
    // PDF
    "pdf",
    // Office
    "docx", "pptx", "xlsx",
    // Images (MinerU converts images to PDF internally)
    "jpg", "jpeg", "png", "bmp", "tiff", "tif", "webp", "gif",
  ]);

  canHandle(fileType: string): boolean {
    return MinerUProcessor.HANDLED_TYPES.has(fileType);
  }

  getStepLabel(): string {
    return "mineru_parsing";
  }

  async parse(
    filePath: string,
    options?: Record<string, unknown>,
  ): Promise<ParsedContent> {
    // Load MinerU config from settings
    const config = await this.loadConfig();

    if (!config.enabled) {
      return {
        text: "",
        metadata: { sourceType: "mineru" },
        success: false,
        error: "MinerU 管线未启用。请在设置中启用 MinerU 服务。",
        modality: "document",
      };
    }

    const client = new MinerUClient(config);

    // Quick health check
    const healthy = await client.healthCheck();
    if (!healthy) {
      return {
        text: "",
        metadata: { sourceType: "mineru" },
        success: false,
        error: `MinerU API 不可达 (${config.apiUrl})。请确认服务已启动。`,
        modality: "document",
      };
    }

    const absFilePath = resolve(filePath);
    const mineruBackend = (options?.mineruBackend as string) ??
      config.defaultBackend;

    // Backends to try: the requested one first, then fallback to "pipeline"
    const backendsToTry = [mineruBackend];
    if (mineruBackend !== "pipeline") {
      backendsToTry.push("pipeline");
    }

    let lastError: string | undefined;
    for (const backend of backendsToTry) {
      try {
        const result = await client.parse(absFilePath, {
          backend,
          lang: config.defaultLang,
          formulaEnable: config.formulaEnable,
          tableEnable: config.tableEnable,
          imageAnalysis: config.imageAnalysis,
        });

        // Extract tables from content list
        const tables = this.extractTables(result.contentList);

        const degraded = backend !== mineruBackend;
        if (degraded) {
          console.log(
            `[MinerUProcessor] ${mineruBackend} failed, retried with ${backend} successfully`,
          );
        }

        return {
          text: result.mdContent,
          metadata: {
            sourceType: "mineru",
            mineruBackend: result.backend,
            mineruTaskId: result.taskId,
            ...(degraded ? { degradedFrom: mineruBackend } : {}),
          },
          success: true,
          raw: result.middleJson ?? undefined,
          doctags: "", // MinerU does not produce DocTags
          markdown: result.mdContent,
          modality: "document",
          tables,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // If this is a hybrid/VLM backend failure, try pipeline as fallback
        const isEngineFailure = lastError.includes("Engine core initialization failed") ||
          lastError.includes("409 Conflict");
        if (isEngineFailure && backend !== backendsToTry[backendsToTry.length - 1]) {
          console.warn(
            `[MinerUProcessor] ${backend} failed: ${lastError}, trying fallback...`,
          );
          continue;
        }
      }
    }

    return {
      text: "",
      metadata: { sourceType: "mineru" },
      success: false,
      error: `MinerU 解析失败 (${mineruBackend}): ${lastError}`,
      modality: "document",
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async loadConfig(): Promise<MinerUConfig> {
    try {
      const repos = await getRepos();
      const raw = await repos.settings.get("mineru_config");
      if (raw) {
        return { ...DEFAULT_MINERU_CONFIG, ...JSON.parse(raw) };
      }
    } catch { /* ignore */ }
    return { ...DEFAULT_MINERU_CONFIG };
  }

  private extractTables(
    contentList: unknown[] | null,
  ): Array<{ data: string; page: number | null }> {
    if (!contentList || !Array.isArray(contentList)) return [];

    const tables: Array<{ data: string; page: number | null }> = [];
    for (const item of contentList) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (obj.type === "table" && typeof obj.text === "string") {
        tables.push({
          data: obj.text,
          page: typeof obj.page_no === "number" ? obj.page_no : null,
        });
      }
      // Also check nested table_html
      if (obj.type === "table" && typeof obj.table_html === "string") {
        if (!tables.length || tables[tables.length - 1].data !== obj.text) {
          tables.push({
            data: obj.table_html,
            page: typeof obj.page_no === "number" ? obj.page_no : null,
          });
        }
      }
    }
    return tables;
  }
}
