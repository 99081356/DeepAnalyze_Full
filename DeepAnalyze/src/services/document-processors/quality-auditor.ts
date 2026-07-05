// =============================================================================
// DeepAnalyze - Quality Auditor
// Performs automated quality checks on processed documents, re-extracts when
// quality is below threshold, compares results, and saves the best version.
// =============================================================================

import { getRepos } from "../../store/repos/index.js";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { ModelRouter } from "../../models/router.js";
import { CapabilityDispatcher } from "../../models/capability-dispatcher.js";
import {
  scoreImage,
  scorePdf,
  scoreAudio,
  scoreVideo,
  THRESHOLDS,
  type QualityScore,
} from "./quality-scorer.js";
import { errorMessage } from "../../utils/errors.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditParams {
  kbId: string;
  docId: string;
  /** Document file type (e.g. "pdf", "png") */
  fileType: string;
  /** Original file path on disk */
  filePath: string;
  /** Document modality */
  modality: string;
  /** Force re-audit even if score is acceptable */
  force?: boolean;
  /** Force re-extraction even if score is acceptable */
  reExtract?: boolean;
}

export interface AuditResult {
  score: number;
  originalScore?: number;
  issues: string[];
  auditedAt: string;
  reExtracted: boolean;
  modelUsed?: string;
  failedPermanently?: boolean;
}

/** Retry delay base for exponential backoff (ms) */
const RETRY_BASE_DELAY = 3_000;
const MAX_AUDIT_RETRIES = 3;

// ---------------------------------------------------------------------------
// QualityAuditor
// ---------------------------------------------------------------------------

export class QualityAuditor {
  /**
   * Main entry point — audit a document's quality and re-extract if needed.
   */
  async audit(params: AuditParams): Promise<AuditResult> {
    const { modality } = params;
    console.log(
      `[QualityAuditor] Starting audit for ${params.docId} (modality=${modality}, fileType=${params.fileType})`,
    );

    switch (modality) {
      case "image":
        return this.auditImage(params);
      case "document":
        return this.auditPdf(params);
      case "audio":
        return this.auditAudio(params);
      case "video":
        return this.auditVideo(params);
      default:
        // Text/excel etc. — no quality audit needed
        return {
          score: 100,
          issues: [],
          auditedAt: new Date().toISOString(),
          reExtracted: false,
        };
    }
  }

  // -----------------------------------------------------------------------
  // Image audit
  // -----------------------------------------------------------------------

  private async auditImage(params: AuditParams): Promise<AuditResult> {
    const repos = await getRepos();
    const { kbId, docId, filePath } = params;

    // 1. Read L1 structure_md page
    const mdPage = await repos.wikiPage.getByDocAndType(docId, "structure_md");
    if (!mdPage) {
      return this.noDataResult("No structure_md page found");
    }

    // Also read raw metadata for OCR text
    const metadata = await this.readRawMetadata(kbId, docId);
    const description = mdPage.content ?? "";
    const ocrText = (metadata as Record<string, unknown>)?.ocrText as string ?? "";

    // 2. Score
    const scoreResult = scoreImage(description, ocrText);
    const now = new Date().toISOString();

    // If score is good and not forced, return
    if (scoreResult.score >= THRESHOLDS.image && !params.force && !params.reExtract) {
      await this.saveAuditMeta(docId, {
        score: scoreResult.score,
        issues: scoreResult.issues,
        auditedAt: now,
        reExtracted: false,
      });
      return {
        score: scoreResult.score,
        issues: scoreResult.issues,
        auditedAt: now,
        reExtracted: false,
      };
    }

    // 3. Re-extract via VLM
    console.log(
      `[QualityAuditor] Image ${docId} score=${scoreResult.score} < ${THRESHOLDS.image}, re-extracting...`,
    );

    try {
      const imageDataUrl = this.buildImageDataUrl(filePath);
      const prompt = this.buildImageReExtractionPrompt(scoreResult.issues);

      const { content: newDescription, modelUsed } = await this.invokeVlmWithFallback(
        imageDataUrl,
        prompt,
      );

      // 4. Score the new extraction
      const newScore = scoreImage(newDescription, ocrText);

      // 5. Compare and keep the better one
      const bestContent = newScore.score > scoreResult.score ? newDescription : description;
      const bestScore = Math.max(newScore.score, scoreResult.score);
      const reExtracted = newScore.score > scoreResult.score;

      if (reExtracted) {
        // Update wiki page content
        await this.updatePageContent(repos, mdPage.id, bestContent, mdPage.title);
        console.log(
          `[QualityAuditor] Image ${docId} re-extracted: ${scoreResult.score} -> ${bestScore}`,
        );
      }

      const result: AuditResult = {
        score: bestScore,
        originalScore: scoreResult.score,
        issues: newScore.issues,
        auditedAt: now,
        reExtracted,
        modelUsed,
      };

      await this.saveAuditMeta(docId, result);
      return result;
    } catch (err) {
      console.warn(
        `[QualityAuditor] Image re-extraction failed for ${docId}:`,
        errorMessage(err),
      );
      const result: AuditResult = {
        score: scoreResult.score,
        originalScore: scoreResult.score,
        issues: [...scoreResult.issues, `重提取失败: ${errorMessage(err)}`],
        auditedAt: now,
        reExtracted: false,
      };
      await this.saveAuditMeta(docId, result);
      return result;
    }
  }

  // -----------------------------------------------------------------------
  // PDF / Document audit
  // -----------------------------------------------------------------------

  private async auditPdf(params: AuditParams): Promise<AuditResult> {
    const repos = await getRepos();
    const { kbId, docId, fileType } = params;

    // Only audit PDF files
    if (fileType !== "pdf") {
      return {
        score: 100,
        issues: [],
        auditedAt: new Date().toISOString(),
        reExtracted: false,
      };
    }

    // 1. Read L1 structure pages
    const mdPages = await repos.wikiPage.getManyByDocAndType(docId, "structure_md");
    const dtPages = await repos.wikiPage.getManyByDocAndType(docId, "structure_dt");

    if (mdPages.length === 0 && dtPages.length === 0) {
      return this.noDataResult("No structure pages found for PDF");
    }

    const markdown = mdPages.map((p) => p.content).join("\n");
    const doctags = dtPages.map((p) => p.content).join("\n");

    // 2. Score
    const scoreResult = scorePdf(markdown, doctags);
    const now = new Date().toISOString();

    if (scoreResult.score >= THRESHOLDS.pdf && !params.force && !params.reExtract) {
      await this.saveAuditMeta(docId, {
        score: scoreResult.score,
        issues: scoreResult.issues,
        auditedAt: now,
        reExtracted: false,
      });
      return {
        score: scoreResult.score,
        issues: scoreResult.issues,
        auditedAt: now,
        reExtracted: false,
      };
    }

    // 3. Try VLM supplementary parsing for scanned PDF pages
    console.log(
      `[QualityAuditor] PDF ${docId} score=${scoreResult.score} < ${THRESHOLDS.pdf}, attempting VLM supplementary...`,
    );

    try {
      const doclingData = this.readDoclingJson(kbId, docId);
      if (!doclingData) {
        return this.auditPdfFallback(repos, docId, scoreResult, now, "No docling.json available for VLM supplementary");
      }

      // Extract page images from docling.json
      const pageImages = this.extractPageImagesFromDocling(doclingData);
      if (pageImages.length === 0) {
        return this.auditPdfFallback(repos, docId, scoreResult, now, "No page images found in docling.json");
      }

      // Re-analyze each low-quality page with VLM
      let improved = false;
      const prompt = "请完整、详细地描述这一页PDF的内容。如果包含表格，请用 Markdown 表格格式还原。不要遗漏任何文字信息。";

      for (let i = 0; i < pageImages.length; i++) {
        const pageImage = pageImages[i];
        try {
          const { content: vlmOutput } = await this.invokeVlmWithFallback(
            pageImage,
            prompt,
          );

          // Check if VLM output is better than what we have
          const vlmScore = scorePdf(vlmOutput, "");
          if (vlmScore.score > 30 && vlmOutput.length > 100) {
            // Create or update a supplementary structure page
            const existingPage = mdPages.find((p) =>
              p.title?.includes(`第${i + 1}页`) || p.title?.includes(`Page ${i + 1}`),
            );

            if (existingPage) {
              const pageScore = scorePdf(existingPage.content, "");
              if (vlmScore.score > pageScore.score) {
                await this.updatePageContent(repos, existingPage.id, vlmOutput, existingPage.title);
                improved = true;
              }
            }
          }
        } catch (err) {
          console.warn(
            `[QualityAuditor] VLM page ${i + 1} failed for ${docId}:`,
            errorMessage(err),
          );
        }
      }

      // Re-score after improvements
      const updatedMdPages = await repos.wikiPage.getManyByDocAndType(docId, "structure_md");
      const updatedDtPages = await repos.wikiPage.getManyByDocAndType(docId, "structure_dt");
      const updatedMarkdown = updatedMdPages.map((p) => p.content).join("\n");
      const updatedDoctags = updatedDtPages.map((p) => p.content).join("\n");
      const newScore = scorePdf(updatedMarkdown, updatedDoctags);

      const result: AuditResult = {
        score: newScore.score,
        originalScore: scoreResult.score,
        issues: newScore.issues,
        auditedAt: now,
        reExtracted: improved,
      };
      await this.saveAuditMeta(docId, result);
      return result;
    } catch (err) {
      return this.auditPdfFallback(repos, docId, scoreResult, now,
        `VLM supplementary failed: ${errorMessage(err)}`);
    }
  }

  private async auditPdfFallback(
    repos: Awaited<ReturnType<typeof getRepos>>,
    docId: string,
    scoreResult: QualityScore,
    now: string,
    reason: string,
  ): Promise<AuditResult> {
    const result: AuditResult = {
      score: scoreResult.score,
      originalScore: scoreResult.score,
      issues: [...scoreResult.issues, reason],
      auditedAt: now,
      reExtracted: false,
    };
    await this.saveAuditMeta(docId, result);
    return result;
  }

  // -----------------------------------------------------------------------
  // Audio audit
  // -----------------------------------------------------------------------

  private async auditAudio(params: AuditParams): Promise<AuditResult> {
    const repos = await getRepos();
    const { kbId, docId, filePath } = params;

    // 1. Read raw metadata for transcription
    const rawMeta = await this.readRawMetadata(kbId, docId);
    const mdPage = await repos.wikiPage.getByDocAndType(docId, "structure_md");

    // Extract turns from raw data
    const turns = ((rawMeta as Record<string, unknown>)?.turns ?? []) as Array<{ text?: string }>;
    const transcription = mdPage?.content ?? (rawMeta as Record<string, unknown>)?.text as string ?? "";

    // 2. Score
    const scoreResult = scoreAudio(transcription, turns);
    const now = new Date().toISOString();

    if (scoreResult.score >= THRESHOLDS.audio && !params.force && !params.reExtract) {
      await this.saveAuditMeta(docId, {
        score: scoreResult.score,
        issues: scoreResult.issues,
        auditedAt: now,
        reExtracted: false,
      });
      return {
        score: scoreResult.score,
        issues: scoreResult.issues,
        auditedAt: now,
        reExtracted: false,
      };
    }

    // 3. Retry ASR with exponential backoff
    console.log(
      `[QualityAuditor] Audio ${docId} score=${scoreResult.score} < ${THRESHOLDS.audio}, retrying ASR...`,
    );

    let bestTranscription = transcription;
    let bestScore = scoreResult.score;
    let reExtracted = false;

    for (let attempt = 0; attempt < MAX_AUDIT_RETRIES; attempt++) {
      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));

      try {
        const audioData = readFileSync(filePath);
        const filename = filePath.split("/").pop() ?? "audio.wav";
        const dispatcher = new CapabilityDispatcher();
        const result = await dispatcher.transcribeAudio(
          audioData.buffer as ArrayBuffer,
          filename,
        );

        if (result.text && result.text.length > 0) {
          const newScore = scoreAudio(result.text, turns);
          if (newScore.score > bestScore) {
            bestTranscription = result.text;
            bestScore = newScore.score;
            reExtracted = true;

            // Update wiki page
            if (mdPage) {
              await this.updatePageContent(repos, mdPage.id, bestTranscription, mdPage.title);
            }
            break; // Good enough, stop retrying
          }
        }
      } catch (err) {
        console.warn(
          `[QualityAuditor] ASR retry ${attempt + 1} failed for ${docId}:`,
          errorMessage(err),
        );
      }
    }

    const failedPermanently = bestScore < THRESHOLDS.audio;
    const result: AuditResult = {
      score: bestScore,
      originalScore: scoreResult.score,
      issues: scoreAudio(bestTranscription, turns).issues,
      auditedAt: now,
      reExtracted,
      failedPermanently,
    };
    await this.saveAuditMeta(docId, result);
    return result;
  }

  // -----------------------------------------------------------------------
  // Video audit
  // -----------------------------------------------------------------------

  private async auditVideo(params: AuditParams): Promise<AuditResult> {
    const repos = await getRepos();
    const { kbId, docId } = params;

    // 1. Read raw metadata (video data is in docling.json for video docs)
    const rawMeta = await this.readRawMetadata(kbId, docId);
    let raw = rawMeta as Record<string, unknown>;

    // Video scenes/transcript are stored in docling.json, not metadata.json
    if (!raw.scenes) {
      const doclingData = this.readDoclingJson(kbId, docId);
      if (doclingData && (doclingData.scenes || doclingData.transcript)) {
        raw = doclingData;
      }
    }

    const scenes = (raw.scenes ?? []) as Array<{ description?: string }>;
    const transcriptData = (raw.transcript ?? {}) as Record<string, unknown>;
    const turns = (transcriptData.turns ?? []) as Array<Record<string, unknown>>;
    const transcriptText = turns.map((t) => t.text as string ?? "").join(" ");

    // 2. Score
    const scoreResult = scoreVideo(scenes, transcriptText);
    const now = new Date().toISOString();

    if (scoreResult.score >= THRESHOLDS.video && !params.force && !params.reExtract) {
      await this.saveAuditMeta(docId, {
        score: scoreResult.score,
        issues: scoreResult.issues,
        auditedAt: now,
        reExtracted: false,
      });
      return {
        score: scoreResult.score,
        issues: scoreResult.issues,
        auditedAt: now,
        reExtracted: false,
      };
    }

    // 3. Retry visual and/or audio parts
    console.log(
      `[QualityAuditor] Video ${docId} score=${scoreResult.score} < ${THRESHOLDS.video}, retrying...`,
    );

    let reExtracted = false;

    // Retry VLM for scenes if visual quality is low
    const hasValidScenes = scenes.some(
      (s) => s.description && s.description.trim().length > 10,
    );
    if (!hasValidScenes) {
      // Try reading frames from disk
      try {
        const framesDir = join(
          process.env.DATA_DIR ?? "data",
          "wiki", kbId, "documents", docId, "frames",
        );
        if (existsSync(framesDir)) {
          const { readdirSync } = await import("node:fs");
          const frameFiles = readdirSync(framesDir)
            .filter((f) => f.includes("_thumb.jpg"))
            .sort();

          if (frameFiles.length > 0) {
            // Use up to 5 representative frames for VLM re-analysis
            const step = Math.max(1, Math.floor(frameFiles.length / 5));
            const selectedFrames = frameFiles.filter((_, i) => i % step === 0).slice(0, 5);

            for (const frameFile of selectedFrames) {
              const framePath = join(framesDir, frameFile);
              const frameData = readFileSync(framePath);
              const frameDataUrl = `data:image/jpeg;base64,${frameData.toString("base64")}`;

              try {
                await this.invokeVlmWithFallback(
                  frameDataUrl,
                  "请描述这个视频帧中的场景内容、人物、动作和文字信息。",
                );
                // Even if VLM works on individual frames, mark as attempted
                reExtracted = true;
              } catch {
                // VLM failed for this frame, continue
              }
            }
          }
        }
      } catch (err) {
        console.warn(
          `[QualityAuditor] Video frame re-analysis failed for ${docId}:`,
          errorMessage(err),
        );
      }
    }

    // Retry ASR for transcript if audio quality is low
    if (!transcriptText || transcriptText.length < 20) {
      for (let attempt = 0; attempt < MAX_AUDIT_RETRIES; attempt++) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));

        try {
          const dispatcher = new CapabilityDispatcher();
          // Extract audio track from video for ASR
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);

          const tmpAudioPath = join(
            process.env.DATA_DIR ?? "data",
            "wiki", kbId, "documents", docId, "raw", "audio_extract.aac",
          );

          await execFileAsync("ffmpeg", [
            "-i", params.filePath,
            "-vn", "-acodec", "copy",
            "-y", tmpAudioPath,
          ]);

          const audioData = readFileSync(tmpAudioPath);
          const asrResult = await dispatcher.transcribeAudio(
            audioData.buffer as ArrayBuffer,
            "audio.aac",
          );

          if (asrResult.text && asrResult.text.length > 20) {
            reExtracted = true;
            break;
          }
        } catch (err) {
          console.warn(
            `[QualityAuditor] Video ASR retry ${attempt + 1} failed for ${docId}:`,
            errorMessage(err),
          );
        }
      }
    }

    const failedPermanently = scoreResult.score < THRESHOLDS.video;
    const result: AuditResult = {
      score: scoreResult.score,
      originalScore: scoreResult.score,
      issues: scoreResult.issues,
      auditedAt: now,
      reExtracted,
      failedPermanently,
    };
    await this.saveAuditMeta(docId, result);
    return result;
  }

  // -----------------------------------------------------------------------
  // VLM with fallback
  // -----------------------------------------------------------------------

  /**
   * Invoke VLM with a two-tier fallback:
   * 1. Try the dedicated VLM role model
   * 2. Fall back to main model with multi-modal messages
   */
  private async invokeVlmWithFallback(
    imageDataUrl: string,
    prompt: string,
  ): Promise<{ content: string; modelUsed: string }> {
    const router = new ModelRouter();
    await router.initialize();

    // Tier 1: Dedicated VLM model
    const vlmModel = router.getDefaultModelStrict("vlm");
    if (vlmModel) {
      try {
        const dispatcher = new CapabilityDispatcher();
        const result = await dispatcher.analyzeImage(imageDataUrl, prompt, {
          signal: AbortSignal.timeout(120_000),
        });
        if (result.content && result.content.length > 20) {
          return { content: result.content, modelUsed: `vlm:${vlmModel}` };
        }
      } catch (err) {
        console.warn(
          `[QualityAuditor] VLM tier-1 failed:`,
          errorMessage(err),
        );
      }
    }

    // Tier 2: Main model with multi-modal messages
    const mainModel = router.getDefaultModel("main");
    if (mainModel) {
      try {
        const messages = [
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text: prompt },
              { type: "image_url" as const, image_url: { url: imageDataUrl } },
            ],
          },
        ];
        const response = await router.chat(messages, { model: mainModel });
        const content =
          typeof response === "string"
            ? response
            : response.content ?? "";
        if (content.length > 20) {
          return { content, modelUsed: `main:${mainModel}` };
        }
      } catch (err) {
        console.warn(
          `[QualityAuditor] VLM tier-2 (main model) failed:`,
          errorMessage(err),
        );
      }
    }

    throw new Error("VLM invocation failed at all tiers");
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private noDataResult(reason: string): AuditResult {
    return {
      score: 0,
      issues: [reason],
      auditedAt: new Date().toISOString(),
      reExtracted: false,
    };
  }

  private async readRawMetadata(kbId: string, docId: string): Promise<Record<string, unknown>> {
    const dataDir = process.env.DATA_DIR ?? "data";
    const metadataPath = join(dataDir, "wiki", kbId, "documents", docId, "raw", "metadata.json");
    try {
      if (existsSync(metadataPath)) {
        const content = readFileSync(metadataPath, "utf-8");
        return JSON.parse(content);
      }
    } catch {
      // ignore
    }
    return {};
  }

  private readDoclingJson(kbId: string, docId: string): Record<string, unknown> | null {
    const dataDir = process.env.DATA_DIR ?? "data";
    const doclingPath = join(dataDir, "wiki", kbId, "documents", docId, "raw", "docling.json");
    try {
      if (existsSync(doclingPath)) {
        const content = readFileSync(doclingPath, "utf-8");
        return JSON.parse(content);
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Extract base64 page images from docling.json structure.
   * Docling stores rendered page images in pages.{n}.image.uri as data URIs.
   */
  private extractPageImagesFromDocling(doclingData: Record<string, unknown>): string[] {
    const images: string[] = [];
    const pages = doclingData.pages as Record<string, Record<string, unknown>> | undefined;
    if (!pages) return images;

    for (const [, pageData] of Object.entries(pages)) {
      const image = pageData?.image as Record<string, unknown> | undefined;
      if (image?.uri && typeof image.uri === "string") {
        const uri = image.uri as string;
        if (uri.startsWith("data:image")) {
          images.push(uri);
        }
      }
    }

    return images;
  }

  private buildImageDataUrl(filePath: string): string {
    const ext = extname(filePath).slice(1).toLowerCase();
    const mimeTypeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      bmp: "image/bmp",
      tiff: "image/tiff",
      tif: "image/tiff",
      webp: "image/webp",
      svg: "image/svg+xml",
    };
    const mimeType = mimeTypeMap[ext] ?? "image/png";
    const buffer = readFileSync(filePath);
    const base64 = buffer.toString("base64");
    return `data:${mimeType};base64,${base64}`;
  }

  private buildImageReExtractionPrompt(issues: string[]): string {
    const hasTableIssue = issues.some((i) => i.includes("逐行表格") || i.includes("表格"));
    let prompt = "请完整、详细、客观地描述这张图片的全部可见内容。如实记录你所看到的一切。";

    if (hasTableIssue) {
      prompt += "\n\n**重要**：如果图片中包含表格，必须使用 Markdown 表格格式（| 列1 | 列2 |）原样还原，保留所有行列和数字。不要逐行描述表格内容。";
    }

    return prompt;
  }

  /**
   * Update a wiki page's content and refresh FTS index.
   */
  private async updatePageContent(
    repos: Awaited<ReturnType<typeof getRepos>>,
    pageId: string,
    content: string,
    title: string,
  ): Promise<void> {
    const contentHash = createHash("md5").update(content).digest("hex");
    const tokenCount = Math.ceil(content.length / 4);
    await repos.wikiPage.updateContent(pageId, content, contentHash, tokenCount);

    // Refresh FTS index
    try {
      await repos.ftsSearch.upsertFTSEntry(pageId, title, content);
    } catch (err) {
      console.warn(
        `[QualityAuditor] FTS refresh failed for page ${pageId}:`,
        errorMessage(err),
      );
    }
  }

  /**
   * Save audit results to document.metadata JSONB field.
   */
  private async saveAuditMeta(docId: string, result: AuditResult): Promise<void> {
    try {
      const repos = await getRepos();
      await repos.document.updateMetadata(docId, { qualityAudit: result });
    } catch (err) {
      console.warn(
        `[QualityAuditor] Failed to save audit metadata for ${docId}:`,
        errorMessage(err),
      );
    }
  }
}
