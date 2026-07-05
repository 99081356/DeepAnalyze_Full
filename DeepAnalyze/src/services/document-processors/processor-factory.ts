import type { DocumentProcessor, ParsedContent } from "./types.js";
import { getRepos } from "../../store/repos/index.js";
import { TextProcessor } from "./text-processor.js";
import { DoclingProcessor } from "./docling-processor.js";
import { DocConverterProcessor } from "./doc-converter.js";
import { NativeTableProcessor } from "./native-table-processor.js";
import { ImageProcessor } from "./image-processor.js";
import { AudioProcessor } from "./audio-processor.js";
import { VideoProcessor } from "./video-processor.js";
import { MinerUProcessor } from "./mineru-processor.js";
import { PipelineOrchestrator } from "./pipeline-orchestrator.js";
import { getFileTypeCategory } from "./pipeline-strategies.js";

export class ProcessorFactory {
  private processors: DocumentProcessor[];
  private orchestrator: PipelineOrchestrator;
  private orchestratorInitialized = false;
  private static instance: ProcessorFactory | null = null;

  private constructor() {
    this.orchestrator = new PipelineOrchestrator();
    this.processors = [
      // Priority 1: Native Table — handles xlsx/xls/csv natively to avoid
      // Docling issues with large spreadsheets (timeouts, memory)
      new NativeTableProcessor(),
      // Priority 2: Video (not supported by Docling)
      new VideoProcessor(),
      // Priority 3: Image — VLM visual description + Docling OCR + EXIF + thumbnail
      // (ImageProcessor internally calls Docling for OCR, so it provides richer output)
      new ImageProcessor(),
      // Priority 4: Legacy .doc → .docx conversion via LibreOffice, then Docling
      new DocConverterProcessor(),
      // Priority 5: Docling handles remaining supported formats (PDF, DOCX, etc.)
      new DoclingProcessor(),
      // Priority 6: MinerU — alternative parsing pipeline via MinerU API
      new MinerUProcessor(),
      // Priority 7: Audio fallback (ASR with speaker diarization)
      new AudioProcessor(),
      // Priority 8: Text formats not handled by Docling (json, xml, rtf, epub, etc.)
      new TextProcessor(),
    ];
  }

  static getInstance(): ProcessorFactory {
    if (!ProcessorFactory.instance) {
      ProcessorFactory.instance = new ProcessorFactory();
    }
    return ProcessorFactory.instance;
  }

  getProcessor(fileType: string): DocumentProcessor {
    const processor = this.processors.find(p => p.canHandle(fileType));
    // Default to DoclingProcessor for unknown types
    return processor ?? this.processors.find(p => p instanceof DoclingProcessor) ?? this.processors[0];
  }

  async parse(filePath: string, fileType: string): Promise<ParsedContent> {
    const processor = this.getProcessor(fileType);
    return processor.parse(filePath);
  }

  /**
   * Parse with automatic pipeline selection via PipelineOrchestrator.
   * Spreadsheet types (xlsx/xls/csv) bypass the orchestrator and use NativeTableProcessor directly.
   * Falls back to the legacy processor chain for types the orchestrator doesn't cover.
   */
  async parseWithFallback(filePath: string, fileType: string, options?: Record<string, unknown>): Promise<ParsedContent> {
    const category = getFileTypeCategory(fileType);

    // Spreadsheet types always use NativeTableProcessor directly
    if (category === "spreadsheet") {
      const native = this.processors.find(p => p instanceof NativeTableProcessor);
      if (native) return native.parse(filePath);
    }

    // Video types use VideoProcessor directly (MinerU doesn't support video)
    if (category === "video") {
      const video = this.processors.find(p => p instanceof VideoProcessor);
      if (video) return video.parse(filePath);
    }

    // Image types use ImageProcessor directly (VLM + OCR + EXIF + thumbnail)
    // This bypasses PipelineOrchestrator which only routes images to Docling (OCR-only).
    if (category === "image") {
      const image = this.processors.find(p => p instanceof ImageProcessor);
      if (image) return image.parse(filePath, options);
    }

    // Initialize orchestrator once (lazy)
    if (!this.orchestratorInitialized) {
      try {
        await this.orchestrator.initialize();
      } catch { /* use defaults */ }
      this.orchestratorInitialized = true;
    }

    // Use orchestrator for auto pipeline selection
    try {
      const result = await this.orchestrator.parse(filePath, fileType);
      if (result.success) return result;

      // If orchestrator failed, fall through to legacy chain
      console.warn(
        `[ProcessorFactory] PipelineOrchestrator failed for ${fileType}: ${result.error}, trying legacy fallback...`,
      );
    } catch (err) {
      console.warn(
        `[ProcessorFactory] PipelineOrchestrator threw for ${fileType}: ${err}, trying legacy fallback...`,
      );
    }

    // Legacy fallback: try each processor that can handle this file type
    const candidates = this.processors.filter(p => p.canHandle(fileType));
    let lastError: string | undefined;
    for (const processor of candidates) {
      try {
        const result = await processor.parse(filePath);
        if (result.success && result.text.trim().length > 0) {
          return result;
        }
        lastError = result.error ?? `${processor.getStepLabel()} returned empty content`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      text: "",
      metadata: {},
      success: false,
      error: lastError ?? `All processors failed for file type: ${fileType}`,
    };
  }

  /**
   * Parse with a specific processing channel (bypasses auto-detection).
   * channel: "auto" | "vlm" | "docling" | "docling-vlm" | "mineru" | "mineru-hybrid" |
   *          "mineru-pipeline" | "native" | "asr"
   */
  async parseWithChannel(filePath: string, fileType: string, channel: string, options?: Record<string, unknown>): Promise<ParsedContent> {
    if (channel === "auto") {
      return this.parseWithFallback(filePath, fileType, options);
    }

    // VLM / multimodal — route images through ImageProcessor (VLM + OCR + EXIF)
    if (channel === "vlm" || channel === "image-vlm") {
      const image = this.processors.find(p => p instanceof ImageProcessor);
      if (image && image.canHandle(fileType)) return image.parse(filePath);
      // For non-image types, fall through to other channels
    }

    // MinerU variants with specific backend — MinerUProcessor internally
    // falls back to "pipeline" when hybrid/VLM engines fail, so no extra fallback needed.
    if (channel === "mineru" || channel === "mineru-hybrid" || channel === "mineru-pipeline") {
      const mineru = this.processors.find(p => p instanceof MinerUProcessor);
      if (mineru) {
        const backendMap: Record<string, string> = {
          "mineru": "pipeline",
          "mineru-hybrid": "hybrid-auto-engine",
          "mineru-pipeline": "pipeline",
        };
        return mineru.parse(filePath, { mineruBackend: backendMap[channel] });
      }
      return this.parseWithFallback(filePath, fileType);
    }

    // Docling VLM mode — DoclingProcessor.parse() takes only filePath,
    // so we set VLM via global docling_config temporarily
    if (channel === "docling-vlm") {
      const docling = this.processors.find(p => p instanceof DoclingProcessor);
      if (docling) {
        // Enable VLM by updating docling_config setting, parse, then restore
        try {
          const repos = await getRepos();
          const raw = await repos.settings.get("docling_config");
          const origConfig = raw ? JSON.parse(raw) : {};
          const vlmConfig = { ...origConfig, use_vlm: true };
          await repos.settings.set("docling_config", JSON.stringify(vlmConfig));
          const result = await docling.parse(filePath);
          // Restore original config
          await repos.settings.set("docling_config", JSON.stringify(origConfig));
          return result;
        } catch {
          return docling.parse(filePath);
        }
      }
      return this.parseWithFallback(filePath, fileType);
    }

    // Map channel names to processor types
    const channelMap: Record<string, (p: DocumentProcessor) => boolean> = {
      docling: (p) => p instanceof DoclingProcessor,
      native: (p) => p instanceof TextProcessor || p instanceof NativeTableProcessor,
      asr: (p) => p instanceof AudioProcessor,
    };

    const matcher = channelMap[channel];
    if (!matcher) {
      return this.parseWithFallback(filePath, fileType);
    }

    // Find the requested processor
    const processor = this.processors.find(p => matcher(p) && p.canHandle(fileType));
    if (!processor) {
      // Fall back to any processor matching the channel regardless of file type
      const anyProcessor = this.processors.find(p => matcher(p));
      if (anyProcessor) return anyProcessor.parse(filePath);
      return this.parseWithFallback(filePath, fileType);
    }

    return processor.parse(filePath);
  }
}
