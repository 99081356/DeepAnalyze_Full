import { resolve } from "node:path";
import type { DocumentProcessor, ParsedContent } from "./types.js";
import { getRepos } from "../../store/repos/index.js";
import { sanitizeDoctags } from "./doctags-sanitizer.js";

// ---------------------------------------------------------------------------
// Shared singleton Docling subprocess manager
// ---------------------------------------------------------------------------

/** Module-level shared manager — persists across parse() calls */
let _sharedMgr: import("../../subprocess/manager.js").SubprocessManager | null = null;
let _sharedMgrStarting = false;
let _doclingAvailable: boolean | null = null;

async function getSharedManager(): Promise<import("../../subprocess/manager.js").SubprocessManager | null> {
  // If we already have a running manager, check it's still alive
  if (_sharedMgr) {
    if (_sharedMgr.isRunning("docling")) {
      return _sharedMgr;
    }
    // Process died — discard and recreate
    console.warn("[DoclingProcessor] Shared process died, will restart");
    try { await _sharedMgr.stop("docling"); } catch { /* ignore */ }
    _sharedMgr = null;
    _doclingAvailable = null;
  }

  // Prevent concurrent initialization
  if (_sharedMgrStarting) {
    // Wait for the other initialization to complete
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (_sharedMgr && _sharedMgr.isRunning("docling")) return _sharedMgr;
      if (!_sharedMgrStarting) break;
    }
    return null;
  }

  _sharedMgrStarting = true;
  try {
    const { SubprocessManager } = await import("../../subprocess/manager.js");
    const { startDocling } = await import("../../subprocess/docling-client.js");

    const dataDir = process.env.DATA_DIR ?? "data";
    const projectRoot = resolve(dataDir, "..");

    const mgr = new SubprocessManager();
    await startDocling(projectRoot, mgr);

    // Wait for the process to stabilize
    await new Promise((r) => setTimeout(r, 3000));

    if (mgr.isRunning("docling")) {
      _sharedMgr = mgr;
      _doclingAvailable = true;
      console.log("[DoclingProcessor] Shared Docling process started");
      return _sharedMgr;
    }

    // Process exited during startup
    console.warn("[DoclingProcessor] Docling process exited during startup");
    _doclingAvailable = false;
    return null;
  } catch (err) {
    console.warn(
      `[DoclingProcessor] Failed to start shared process: ${err instanceof Error ? err.message : String(err)}`,
    );
    _doclingAvailable = false;
    return null;
  } finally {
    _sharedMgrStarting = false;
  }
}

// ---------------------------------------------------------------------------
// DoclingProcessor
// ---------------------------------------------------------------------------

export class DoclingProcessor implements DocumentProcessor {
  private static readonly HANDLED_TYPES = new Set([
    // Documents (xlsx/xls/csv handled by NativeTableProcessor)
    "pdf", "docx", "doc", "pptx", "ppt", "xlsm",
    // Web
    "html", "htm",
    // Text (MarkdownDocumentBackend)
    "md", "txt", "asciidoc", "adoc", "asc", "latex", "tex",
    // Images (ImageDocumentBackend)
    "jpg", "jpeg", "png", "tif", "tiff", "bmp", "webp",
    // Audio (AsrPipeline)
    "wav", "mp3", "m4a", "aac", "ogg", "flac",
  ]);

  canHandle(fileType: string): boolean {
    return DoclingProcessor.HANDLED_TYPES.has(fileType);
  }

  getStepLabel(): string {
    return "docling_parsing";
  }

  async parse(filePath: string): Promise<ParsedContent> {
    const mgr = await getSharedManager();
    if (!mgr) {
      return {
        text: "",
        metadata: { sourceType: "docling" },
        success: false,
        error: "Docling 服务不可用。请确认已安装 docling Python 包 (pip install docling) 且 Python 环境正常。",
        modality: "document",
      };
    }

    const { parseWithDocling } = await import("../../subprocess/docling-client.js");

    const dataDir = process.env.DATA_DIR ?? "data";

    // Read docling config from settings
    const repos = await getRepos();
    const rawDoclingConfig = await repos.settings.get("docling_config");
    const defaultDoclingConfig = {
      layout_model: "docling-project/docling-layout-egret-xlarge",
      ocr_engine: "rapidocr" as const,
      ocr_backend: "torch" as const,
      table_mode: "accurate" as const,
      use_vlm: false,
      vlm_model: "",
    };
    const doclingConfig = rawDoclingConfig
      ? { ...defaultDoclingConfig, ...JSON.parse(rawDoclingConfig) }
      : defaultDoclingConfig;
    const artifactsPath = resolve(dataDir, "models", "docling");

    const modelConfig: Record<string, unknown> = {
      layout_model: doclingConfig.layout_model,
      ocr_engine: doclingConfig.ocr_engine,
      ocr_backend: doclingConfig.ocr_backend,
      table_mode: doclingConfig.table_mode,
      use_vlm: doclingConfig.use_vlm,
      vlm_model: doclingConfig.vlm_model,
      artifacts_path: artifactsPath,
    };

    // Resolve to absolute path
    const absFilePath = resolve(filePath);

    try {
      const result = await parseWithDocling(mgr, absFilePath, {
        ocr: true,
        extract_tables: true,
        use_vlm: doclingConfig.use_vlm,
        model_config: modelConfig,
      });

      // Sanitize doctags — detect and clear garbled Unicode output
      const { doctags: sanitizedDoctags, wasGarbled, fallbackUsed } =
        sanitizeDoctags(result.doctags ?? "", result.content || "");

      return {
        text: result.content,
        metadata: {
          sourceType: "docling",
          doctagsGarbled: wasGarbled,
          doctagsFallbackUsed: fallbackUsed,
        },
        success: true,
        raw: result.raw,
        doctags: sanitizedDoctags,
        markdown: result.content || "",
        modality: "document",
        tables: result.tables,
      };
    } catch (err) {
      // If the shared process died, mark it for restart on next call
      if (!mgr.isRunning("docling")) {
        _doclingAvailable = null;
      }
      return {
        text: "",
        metadata: { sourceType: "docling" },
        success: false,
        error: `Docling 解析失败: ${err instanceof Error ? err.message : String(err)}`,
        modality: "document",
      };
    }
  }
}
