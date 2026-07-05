/**
 * PipelineOrchestrator — selects the best parsing pipeline per file type
 * and handles automatic degradation when the primary pipeline fails.
 */

import type { DocumentProcessor, ParsedContent } from "./types.js";
import { DoclingProcessor } from "./docling-processor.js";
import { MinerUProcessor } from "./mineru-processor.js";
import { NativeTableProcessor } from "./native-table-processor.js";
import { TextProcessor } from "./text-processor.js";
import { AudioProcessor } from "./audio-processor.js";
import { VideoProcessor } from "./video-processor.js";
import { DocConverterProcessor } from "./doc-converter.js";
import {
  DEFAULT_STRATEGIES,
  getFileTypeCategory,
  type PipelineStrategy,
} from "./pipeline-strategies.js";
import { DEFAULT_MINERU_CONFIG, MinerUClient } from "./mineru-client.js";
import type { MinerUConfig } from "./mineru-client.js";
import { getRepos } from "../../store/repos/index.js";

// ---------------------------------------------------------------------------
// Extended result with pipeline metadata
// ---------------------------------------------------------------------------

export interface PipelineResult extends ParsedContent {
  usedPipeline: string;
  degraded: boolean;
  originalPipeline?: string;
  degradationReason?: string;
}

// ---------------------------------------------------------------------------
// PipelineOrchestrator
// ---------------------------------------------------------------------------

export class PipelineOrchestrator {
  private strategies: PipelineStrategy[];
  private mineruEnabled: boolean = false;
  private mineruAvailable: boolean = false;
  private lastHealthCheck: number = 0;

  constructor() {
    this.strategies = [...DEFAULT_STRATEGIES];
  }

  /** Load strategies and MinerU config from DB */
  async initialize(): Promise<void> {
    try {
      const repos = await getRepos();

      // Load custom strategies if saved
      const rawStrategies = await repos.settings.get("pipeline_strategies");
      if (rawStrategies) {
        try {
          this.strategies = JSON.parse(rawStrategies);
        } catch { /* use defaults */ }
      }

      // Load MinerU config
      const rawConfig = await repos.settings.get("mineru_config");
      if (rawConfig) {
        const config: MinerUConfig = { ...DEFAULT_MINERU_CONFIG, ...JSON.parse(rawConfig) };
        this.mineruEnabled = config.enabled;
      }
    } catch { /* use defaults */ }
  }

  /** Check if MinerU API is available (with 30s cache) */
  async checkMinerUAvailable(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastHealthCheck < 30_000 && this.mineruAvailable) {
      return this.mineruAvailable;
    }
    try {
      const config = await this.loadMinerUConfig();
      if (!config.enabled) {
        this.mineruAvailable = false;
        return false;
      }
      const client = new MinerUClient(config);
      this.mineruAvailable = await client.healthCheck();
      this.lastHealthCheck = now;
      return this.mineruAvailable;
    } catch {
      this.mineruAvailable = false;
      return false;
    }
  }

  /**
   * Auto-select pipeline and parse with automatic degradation.
   */
  async parse(
    filePath: string,
    fileType: string,
    options?: Record<string, unknown>,
  ): Promise<PipelineResult> {
    const category = getFileTypeCategory(fileType);
    const strategy = this.strategies.find((s) => s.fileType === category);

    if (!strategy || strategy.pipelines.length === 0) {
      // No strategy — fall back to Docling
      return this.parseWithProcessor(
        new DoclingProcessor(),
        filePath,
        fileType,
        "docling",
        options,
      );
    }

    // Sort by priority
    const sorted = [...strategy.pipelines].sort(
      (a, b) => a.priority - b.priority,
    );

    // Check MinerU availability upfront
    const mineruAvailable = await this.checkMinerUAvailable();

    let lastError: string | undefined;
    const originalPipeline = sorted[0].pipeline;

    for (const entry of sorted) {
      // Skip MinerU if not available
      if (entry.pipeline === "mineru" && !mineruAvailable) {
        lastError = "MinerU API 不可用";
        continue;
      }

      const processor = this.getProcessor(entry.pipeline);
      if (!processor || !processor.canHandle(fileType)) {
        continue;
      }

      try {
        const parseOptions: Record<string, unknown> = {
          ...options,
          ...(entry.mineruBackend
            ? { mineruBackend: entry.mineruBackend }
            : {}),
        };

        const result = await processor.parse(filePath, parseOptions);

        if (result.success && result.text.trim().length > 0) {
          const degraded = entry.pipeline !== originalPipeline;
          return {
            ...result,
            usedPipeline: entry.pipeline,
            degraded,
            originalPipeline: degraded ? originalPipeline : undefined,
            degradationReason: degraded ? lastError : undefined,
          };
        }

        // Empty content treated as failure
        lastError = result.error ?? `${entry.pipeline} returned empty content`;
        console.warn(
          `[PipelineOrchestrator] ${entry.pipeline} returned empty/error for ${fileType}: ${lastError}`,
        );
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(
          `[PipelineOrchestrator] ${entry.pipeline} threw for ${fileType}: ${lastError}`,
        );
      }
    }

    // All pipelines failed
    return {
      text: "",
      metadata: {},
      success: false,
      error: lastError ?? `All pipelines failed for ${fileType}`,
      usedPipeline: "none",
      degraded: false,
    };
  }

  /**
   * Parse with a specific pipeline (for manual selection).
   */
  async parseWithPipeline(
    filePath: string,
    fileType: string,
    pipeline: string,
    options?: Record<string, unknown>,
  ): Promise<PipelineResult> {
    const processor = this.getProcessor(pipeline);
    if (!processor) {
      return {
        text: "",
        metadata: {},
        success: false,
        error: `Unknown pipeline: ${pipeline}`,
        usedPipeline: pipeline,
        degraded: false,
      };
    }

    const result = await processor.parse(filePath, options);
    return {
      ...result,
      usedPipeline: pipeline,
      degraded: false,
    };
  }

  getStrategies(): PipelineStrategy[] {
    return this.strategies;
  }

  updateStrategies(strategies: PipelineStrategy[]): void {
    this.strategies = strategies;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private getProcessor(
    pipeline: string,
  ): DocumentProcessor | null {
    switch (pipeline) {
      case "docling":
        return new DoclingProcessor();
      case "mineru":
        return new MinerUProcessor();
      case "native":
        return new NativeTableProcessor();
      case "asr":
        return new AudioProcessor();
      case "text":
        return new TextProcessor();
      case "doc_converter":
        return new DocConverterProcessor();
      default:
        return null;
    }
  }

  private async parseWithProcessor(
    processor: DocumentProcessor,
    filePath: string,
    _fileType: string,
    pipelineName: string,
    options?: Record<string, unknown>,
  ): Promise<PipelineResult> {
    const result = await processor.parse(filePath, options);
    return {
      ...result,
      usedPipeline: pipelineName,
      degraded: false,
    };
  }

  private async loadMinerUConfig(): Promise<MinerUConfig> {
    try {
      const repos = await getRepos();
      const raw = await repos.settings.get("mineru_config");
      if (raw) return { ...DEFAULT_MINERU_CONFIG, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULT_MINERU_CONFIG };
  }
}
