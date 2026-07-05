/**
 * MinerU API client — communicates with mineru-api over HTTP.
 *
 * Usage:
 *   const client = new MinerUClient({ apiUrl: "http://127.0.0.1:8001", ... });
 *   const result = await client.parse("/path/to/file.pdf");
 */

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MinerUConfig {
  /** MinerU API 服务地址 */
  apiUrl: string;
  /** 默认后端类型 */
  defaultBackend: string;
  /** 默认语言 */
  defaultLang: string;
  /** 是否启用公式识别 */
  formulaEnable: boolean;
  /** 是否启用表格识别 */
  tableEnable: boolean;
  /** 是否启用图片分析 */
  imageAnalysis: boolean;
  /** 请求超时（秒） */
  timeout: number;
  /** 是否启用（总开关） */
  enabled: boolean;
}

export interface MinerUParseOptions {
  backend?: string;
  parseMethod?: string;
  lang?: string;
  formulaEnable?: boolean;
  tableEnable?: boolean;
  imageAnalysis?: boolean;
  startPageId?: number;
  endPageId?: number;
}

export interface MinerUParseResult {
  mdContent: string;
  middleJson: Record<string, unknown> | null;
  contentList: unknown[] | null;
  images: Record<string, string>;
  taskId: string;
  backend: string;
}

export const DEFAULT_MINERU_CONFIG: MinerUConfig = {
  apiUrl: "http://127.0.0.1:8001",
  defaultBackend: "hybrid-auto-engine",
  defaultLang: "ch",
  formulaEnable: true,
  tableEnable: true,
  imageAnalysis: true,
  timeout: 300,
  enabled: false,
};

// ---------------------------------------------------------------------------
// MinerUClient
// ---------------------------------------------------------------------------

export class MinerUClient {
  private apiUrl: string;
  private timeoutMs: number;

  constructor(config: MinerUConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.timeoutMs = config.timeout * 1000;
  }

  /** Check if the MinerU API is reachable */
  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(`${this.apiUrl}/health`, {
        signal: controller.signal,
        // Bypass proxy for localhost connections
        ...this.localFetchOpts(),
      });
      clearTimeout(tid);
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Build fetch options that bypass proxy for localhost connections.
   */
  private localFetchOpts(): Record<string, unknown> {
    try {
      const url = new URL(this.apiUrl);
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
        // Bun: proxy: "" bypasses proxy. Node: no_proxy env should handle it.
        return { proxy: "" } as Record<string, unknown>;
      }
    } catch { /* ignore */ }
    return {};
  }

  /** Parse a document file via MinerU API */
  async parse(
    filePath: string,
    options?: MinerUParseOptions,
  ): Promise<MinerUParseResult> {
    const fileSize = (await stat(filePath)).size;
    // Use async mode for files > 20MB
    if (fileSize > 20 * 1024 * 1024) {
      return this.parseAsync(filePath, options);
    }
    return this.parseSync(filePath, options);
  }

  /** Synchronous parse — POST /file_parse */
  private async parseSync(
    filePath: string,
    options?: MinerUParseOptions,
  ): Promise<MinerUParseResult> {
    const fileName = basename(filePath);
    const fileBuffer = await readFile(filePath);
    const opts = this.mergeOptions(options);

    const formData = new FormData();
    formData.append(
      "files",
      new Blob([fileBuffer]),
      fileName,
    );
    this.appendOptions(formData, opts);

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(`${this.apiUrl}/file_parse`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
        ...this.localFetchOpts(),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `MinerU API error: ${resp.status} ${resp.statusText} ${text}`,
        );
      }

      const data = await resp.json() as Record<string, unknown>;
      return this.extractResult(data, opts);
    } finally {
      clearTimeout(tid);
    }
  }

  /** Asynchronous parse — submit → poll → result */
  private async parseAsync(
    filePath: string,
    options?: MinerUParseOptions,
  ): Promise<MinerUParseResult> {
    const taskId = await this.submitTask(filePath, options);
    return this.pollTaskResult(taskId, options);
  }

  /** Submit an async task — POST /tasks */
  private async submitTask(
    filePath: string,
    options?: MinerUParseOptions,
  ): Promise<string> {
    const fileName = basename(filePath);
    const fileBuffer = await readFile(filePath);
    const opts = this.mergeOptions(options);

    const formData = new FormData();
    formData.append(
      "files",
      new Blob([fileBuffer]),
      fileName,
    );
    this.appendOptions(formData, opts);

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 30_000);

    try {
      const resp = await fetch(`${this.apiUrl}/tasks`, {
        method: "POST",
        body: formData,
        signal: controller.signal,
        ...this.localFetchOpts(),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `MinerU submit error: ${resp.status} ${resp.statusText} ${text}`,
        );
      }

      const data = (await resp.json()) as { task_id: string };
      return data.task_id;
    } finally {
      clearTimeout(tid);
    }
  }

  /** Poll task status until complete, then fetch result */
  private async pollTaskResult(
    taskId: string,
    options?: MinerUParseOptions,
  ): Promise<MinerUParseResult> {
    const opts = this.mergeOptions(options);
    const startTime = Date.now();

    while (Date.now() - startTime < this.timeoutMs) {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 10_000);

      try {
        const resp = await fetch(`${this.apiUrl}/tasks/${taskId}`, {
          signal: controller.signal,
          ...this.localFetchOpts(),
        });

        if (!resp.ok) {
          throw new Error(`MinerU status error: ${resp.status}`);
        }

        const status = (await resp.json()) as {
          status: string;
          error?: string;
        };

        if (status.status === "completed") {
          // Fetch the result
          const resultResp = await fetch(
            `${this.apiUrl}/tasks/${taskId}/result`,
            this.localFetchOpts(),
          );
          if (!resultResp.ok) {
            throw new Error(
              `MinerU result error: ${resultResp.status}`,
            );
          }
          const data = await resultResp.json() as Record<string, unknown>;
          return this.extractResult(data, opts);
        }

        if (status.status === "failed") {
          throw new Error(
            `MinerU task failed: ${status.error ?? "unknown error"}`,
          );
        }

        // Still processing — wait before next poll
        await new Promise((r) => setTimeout(r, 3000));
      } finally {
        clearTimeout(tid);
      }
    }

    throw new Error(
      `MinerU task timed out after ${this.timeoutMs / 1000}s`,
    );
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private mergeOptions(options?: MinerUParseOptions): Required<MinerUParseOptions> {
    return {
      backend: options?.backend ?? "hybrid-auto-engine",
      parseMethod: options?.parseMethod ?? "auto",
      lang: options?.lang ?? "ch",
      formulaEnable: options?.formulaEnable ?? true,
      tableEnable: options?.tableEnable ?? true,
      imageAnalysis: options?.imageAnalysis ?? true,
      startPageId: options?.startPageId ?? 0,
      endPageId: options?.endPageId ?? 99999,
    };
  }

  private appendOptions(
    formData: FormData,
    opts: Required<MinerUParseOptions>,
  ): void {
    formData.append("backend", opts.backend);
    formData.append("parse_method", opts.parseMethod);
    formData.append("lang_list", opts.lang);
    formData.append("formula_enable", String(opts.formulaEnable));
    formData.append("table_enable", String(opts.tableEnable));
    formData.append("image_analysis", String(opts.imageAnalysis));
    formData.append("return_md", "true");
    formData.append("return_middle_json", "true");
    formData.append("return_content_list", "true");
    formData.append("return_images", "false");
  }

  private extractResult(
    data: Record<string, unknown>,
    opts: Required<MinerUParseOptions>,
  ): MinerUParseResult {
    // The API returns results keyed by file name
    const results = data.results as
      | Record<string, Record<string, unknown>>
      | undefined;

    if (results) {
      const keys = Object.keys(results);
      if (keys.length > 0) {
        const fileResult = results[keys[0]];
        const mdContent = String(fileResult.md_content ?? "");
        let middleJson: Record<string, unknown> | null = null;
        try {
          const mj = fileResult.middle_json;
          if (mj && typeof mj === "string") {
            middleJson = JSON.parse(mj);
          } else if (mj && typeof mj === "object") {
            middleJson = mj as Record<string, unknown>;
          }
        } catch { /* ignore parse error */ }

        let contentList: unknown[] | null = null;
        try {
          const cl = fileResult.content_list;
          if (cl && typeof cl === "string") {
            contentList = JSON.parse(cl);
          } else if (Array.isArray(cl)) {
            contentList = cl;
          }
        } catch { /* ignore */ }

        return {
          mdContent,
          middleJson,
          contentList,
          images: (fileResult.images as Record<string, string>) ?? {},
          taskId: String(data.task_id ?? ""),
          backend: opts.backend,
        };
      }
    }

    // Fallback: try top-level fields
    return {
      mdContent: String(data.md_content ?? data.content ?? ""),
      middleJson: null,
      contentList: null,
      images: {},
      taskId: String(data.task_id ?? ""),
      backend: opts.backend,
    };
  }
}
