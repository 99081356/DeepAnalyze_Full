// =============================================================================
// DeepAnalyze - Wiki Compiler (Three-Layer Architecture)
// Transforms parsed document content into a layered wiki structure:
//   Raw (DoclingDocument JSON) → Structure (DocTags sections) → Abstract (LLM summary)
// Plus entity extraction and cross-document linking.
// Uses PG Repository layer for all database operations.
// =============================================================================

import { ModelRouter } from "../models/router.js";
import { PageManager } from "./page-manager.js";
import {
  EntityExtractor,
  type ExtractedEntity,
} from "./entity-extractor.js";
import { AnchorGenerator, type AnchorDef } from "./anchor-generator.js";
import { getRepos } from "../store/repos/index.js";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { writeFileSyncAtomic } from "../utils/atomicWrite.js";
import type { ParsedContent } from "../services/document-processors/types.js";
import type { ImageRawData, AudioRawData, VideoRawData } from "../services/document-processors/modality-types.js";
import { compileImageStructure } from "./modality-compilers/image-structure.js";
import { compileAudioStructure } from "./modality-compilers/audio-structure.js";
import { compileVideoStructure } from "./modality-compilers/video-structure.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WikiCompiler
// ---------------------------------------------------------------------------

export class WikiCompiler {
  private router: ModelRouter;
  private pageManager: PageManager;
  private entityExtractor: EntityExtractor;
  private anchorGenerator: AnchorGenerator;

  constructor(router: ModelRouter, dataDir: string) {
    this.router = router;
    this.pageManager = new PageManager(dataDir);
    this.entityExtractor = new EntityExtractor(router);
    this.anchorGenerator = new AnchorGenerator();
  }

  // -----------------------------------------------------------------------
  // Main compile entry point
  // -----------------------------------------------------------------------

  /**
   * Full compilation pipeline for a single document.
   * Accepts both legacy string content and new ParsedContent objects.
   *
   * New flow (with ParsedContent):
   *   Raw → Structure → Abstract → Entity extraction → Linking
   *
   * Legacy flow (string only):
   *   Fulltext → Overview → Abstract → Entity extraction → Linking
   */
  async compile(
    kbId: string,
    docId: string,
    parsedContent: string | ParsedContent,
    metadata: Record<string, unknown>,
    options?: {
      skipStatusUpdates?: boolean;
      /** Called whenever the compiler enters a distinct sub-phase
       *  (e.g. "raw_save", "structure", "abstract", "fulltext").
       *  Consumers can forward this to UI progress indicators so users
       *  see what's happening inside the long-running "compiling" step.
       *  The optional `message` overrides the subStep's default label with
       *  richer context (e.g. "生成摘要中（尝试 1/3）"). */
      onSubStep?: (subStep: string, message?: string) => void;
    },
  ): Promise<void> {
    const repos = await getRepos();
    const emitSubStep = options?.onSubStep ?? (() => {});

    try {
      if (!options?.skipStatusUpdates) {
        await repos.document.updateStatus(docId, "compiling");
      }

      // Ensure the KB wiki directory structure exists
      await this.pageManager.initKb(kbId);

      // Detect mode: rich ParsedContent or legacy string
      const isRichContent = typeof parsedContent !== "string";
      const richContent = isRichContent
        ? (parsedContent as ParsedContent)
        : undefined;
      const textContent = isRichContent
        ? (parsedContent as ParsedContent).text
        : (parsedContent as string);

      // Validate content
      if (!textContent || textContent.trim().length === 0) {
        console.warn(
          `[WikiCompiler] Empty parsed content for doc ${docId}, writing placeholder`,
        );
      }

      // Determine if we have rich DoclingDocument data (with raw field) for the
      // three-layer flow, or just text from a simple processor (TextProcessor,
      // ImageProcessor, etc.) which should use the legacy overview→abstract flow.
      const hasRawData = isRichContent && richContent?.raw;

      if (hasRawData && richContent) {
        // === NEW three-layer flow ===
        // Step 1: Save Raw (DoclingDocument JSON)
        emitSubStep("raw_save");
        await this.compileRaw(kbId, docId, richContent, metadata);

        // Step 2: Generate Structure pages from DocTags/anchors
        emitSubStep("structure");
        await this.compileStructure(kbId, docId, richContent);
        await this.emitLevelReady(kbId, docId, "L1");

        // Step 3: Generate Abstract from Structure sections
        emitSubStep("abstract");
        await this.compileAbstract(kbId, docId, richContent.modality);
        await this.emitLevelReady(kbId, docId, "L0");

        // Also save fulltext for backward compatibility
        emitSubStep("fulltext");
        await this.compileFulltext(
          kbId,
          docId,
          textContent || "(No extractable text content)",
          metadata,
        );
        await this.emitLevelReady(kbId, docId, "L2");
      } else {
        // === LEGACY flow (plain text or ParsedContent without raw) ===
        const content = textContent || "(No extractable text content)";
        emitSubStep("fulltext");
        await this.compileFulltext(kbId, docId, content, metadata);
        await this.emitLevelReady(kbId, docId, "L2");
        emitSubStep("overview");
        await this.compileOverview(kbId, docId, content, (msg) => emitSubStep("overview", msg));
        await this.emitLevelReady(kbId, docId, "L1");
        emitSubStep("abstract");
        await this.compileLegacyAbstract(kbId, docId);
        await this.emitLevelReady(kbId, docId, "L0");
      }

      // Entity extraction and link creation — DISABLED per design decision
      // Code preserved for potential future re-enablement
      // await this.extractAndUpdateLinks(kbId, docId);

      // Cross-document linking — DISABLED per design decision
      // try {
      //   const { Linker } = await import("../wiki/linker.js");
      //   const linker = new Linker();
      //   await linker.buildForwardLinks(kbId);
      //   console.log(`[WikiCompiler] Built cross-document links for KB ${kbId}`);
      // } catch (err) {
      //   console.warn(
      //     `[WikiCompiler] Cross-document linking failed for KB ${kbId}:`,
      //     err instanceof Error ? err.message : String(err),
      //   );
      // }

      if (!options?.skipStatusUpdates) {
        await repos.document.updateStatus(docId, "ready");
      }
    } catch (err) {
      console.error(
        `[WikiCompiler] Compilation failed for doc ${docId}:`,
        err instanceof Error ? err.message : String(err),
      );
      if (!options?.skipStatusUpdates) {
        try {
          await repos.document.updateStatus(docId, "error");
        } catch {
          // Ignore status update error during failure handling
        }
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Raw layer: Save DoclingDocument JSON + metadata to disk
  // -----------------------------------------------------------------------

  private async compileRaw(
    kbId: string,
    docId: string,
    content: ParsedContent,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!content.raw) {
      console.log(
        `[WikiCompiler] No raw DoclingDocument JSON for doc ${docId}, skipping Raw layer`,
      );
      return;
    }

    const wikiDir = this.pageManager.getWikiDir();
    const rawDir = join(wikiDir, kbId, "documents", docId, "raw");

    try {
      mkdirSync(rawDir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    // Save docling.json
    const doclingPath = join(rawDir, "docling.json");
    writeFileSyncAtomic(
      doclingPath,
      JSON.stringify(content.raw, null, 2),
      { encoding: "utf-8" },
    );

    // Save metadata.json with modality info
    const metaPath = join(rawDir, "metadata.json");
    writeFileSyncAtomic(
      metaPath,
      JSON.stringify(
        {
          ...metadata,
          modality: content.modality ?? "document",
          doctagsAvailable: !!content.doctags,
        },
        null,
        2,
      ),
      { encoding: "utf-8" },
    );

    console.log(
      `[WikiCompiler] Raw layer saved for doc ${docId}: ${doclingPath}`,
    );
  }

  // -----------------------------------------------------------------------
  // Structure layer: Modality-aware dispatch
  // -----------------------------------------------------------------------

  private async compileStructure(
    kbId: string,
    docId: string,
    content: ParsedContent,
  ): Promise<void> {
    const modality = content.modality ?? "document";
    const raw = content.raw;

    if (!raw) {
      console.log(
        `[WikiCompiler] No raw data for Structure compilation of doc ${docId}, skipping`,
      );
      return;
    }

    // Dispatch to modality-specific Structure compilers when PG repos are available
    if (content.doctags) {
      try {
        const repos = await getRepos();

        switch (modality) {
          case "image":
            await compileImageStructure({
              kbId, docId,
              raw: raw as unknown as ImageRawData,
              doctags: content.doctags,
              wikiPageRepo: repos.wikiPage,
              anchorRepo: repos.anchor,
              ftsRepo: repos.ftsSearch,
              anchorGenerator: this.anchorGenerator,
            });
            console.log(`[WikiCompiler] Image Structure compiled for doc ${docId}`);
            return;

          case "audio":
            await compileAudioStructure({
              kbId, docId,
              raw: raw as unknown as AudioRawData,
              doctags: content.doctags,
              wikiPageRepo: repos.wikiPage,
              anchorRepo: repos.anchor,
              ftsRepo: repos.ftsSearch,
              anchorGenerator: this.anchorGenerator,
            });
            console.log(`[WikiCompiler] Audio Structure compiled for doc ${docId}`);
            return;

          case "video":
            await compileVideoStructure({
              kbId, docId,
              raw: raw as unknown as VideoRawData,
              doctags: content.doctags,
              wikiPageRepo: repos.wikiPage,
              anchorRepo: repos.anchor,
              ftsRepo: repos.ftsSearch,
              anchorGenerator: this.anchorGenerator,
            });
            console.log(`[WikiCompiler] Video Structure compiled for doc ${docId}`);
            return;
        }
      } catch (err) {
        console.warn(
          `[WikiCompiler] PG modality compiler failed, falling back to document mode:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Default: document / excel — create single L1 page with all content
    await this.compileStructureDocument(kbId, docId, content);
  }

  // -----------------------------------------------------------------------
  // Structure layer: Document/Excel fallback
  // -----------------------------------------------------------------------

  private async compileStructureDocument(
    kbId: string,
    docId: string,
    content: ParsedContent,
  ): Promise<void> {
    const raw = content.raw!;
    const modality = content.modality ?? "document";
    const isMinerU = content.metadata?.sourceType === "mineru" ||
      (raw as Record<string, unknown>)?.pdf_info !== undefined;

    // Step 1: Resolve L1 Markdown content FIRST
    let markdownContent = content.markdown?.trim() || "";
    if (!markdownContent && content.doctags) {
      markdownContent = this.doctagsToMarkdown(content.doctags);
    }

    if (!markdownContent) {
      console.log(
        `[WikiCompiler] No structure content for doc ${docId}, skipping Structure layer`,
      );
      return;
    }

    // Step 2: Generate anchors — from Markdown for Docling docs, from JSON for MinerU/Excel
    let anchors: AnchorDef[];
    if (modality === "excel") {
      anchors = this.anchorGenerator.generateExcelAnchors(docId, kbId, raw as Record<string, unknown>);
    } else if (isMinerU) {
      anchors = this.anchorGenerator.generateMinerUAnchors(docId, kbId, raw as Record<string, unknown>);
    } else {
      // Docling documents: generate anchors directly from Markdown
      anchors = this.anchorGenerator.generateMarkdownAnchors(docId, kbId, markdownContent);
    }

    // Step 3: Backfill line_start for MinerU/Excel anchors
    if (anchors.length > 0 && anchors[0].line_start == null) {
      this.anchorGenerator.backfillLineStart(anchors, markdownContent);
    }

    // Step 4: Write anchors to PG
    await this.writeAnchorsToRepo(anchors);

    const wikiDir = this.pageManager.getWikiDir();
    const repos = await getRepos();
    const docTitle = anchors.length > 0
      ? (anchors.find((a) => a.element_type === "heading")?.section_title || `Document ${docId}`)
      : `Document ${docId}`;

    // L1_dt: DocTags format page — store the complete DocTags if available
    if (content.doctags?.trim()) {
      await this.createWikiPageViaRepo(
        kbId,
        docId,
        "structure_dt",
        docTitle,
        content.doctags,
        wikiDir,
      );
    }

    // L1_md: Single Markdown page containing ALL extracted content
    const mdPage = await this.createWikiPageViaRepo(
      kbId,
      docId,
      "structure_md",
      docTitle,
      markdownContent,
      wikiDir,
    );

    // Link ALL anchors to this single structure page
    const allAnchorIds = anchors.map((a) => a.id);
    if (allAnchorIds.length > 0) {
      await repos.anchor.updateStructurePageId(allAnchorIds, mdPage.id);
    }

    console.log(
      `[WikiCompiler] Structure layer: 1 page (${markdownContent.length} chars), ${anchors.length} anchors for doc ${docId}`,
    );
  }

  // -----------------------------------------------------------------------
  // Abstract layer: LLM-generated summary from Structure sections
  // -----------------------------------------------------------------------

  async compileAbstract(
    kbId: string,
    docId: string,
    modality?: string,
  ): Promise<void> {
    // Collect all structure section titles + previews for the prompt
    const structureSections = await this.getStructureSectionSummaries(docId);

    // If no structure sections, fall back to overview or fulltext content
    let abstractInput: string;
    if (structureSections.length > 0) {
      abstractInput = structureSections
        .map((s) => `## ${s.title}\n${s.preview}`)
        .join("\n\n");
    } else {
      abstractInput = await this.getOverviewFallback(docId);
    }

    if (!abstractInput || abstractInput.trim().length === 0) {
      console.warn(
        `[WikiCompiler] No input for abstract generation, doc ${docId}`,
      );
      return;
    }

    // Allow up to 8000 chars for abstract input to capture richer content
    const truncated =
      abstractInput.length > 8000
        ? abstractInput.slice(0, 8000) + "\n...(truncated)"
        : abstractInput;

    // Modality-aware prompt hints
    const modalityHints: Record<string, string> = {
      image: '这是一个图片文件。请根据视觉描述和 OCR 文本生成摘要。',
      audio: '这是一个音频转写文件。请根据对话内容生成主题摘要和关键观点。',
      video: '这是一个视频文件。请根据场景描述和对话内容生成摘要。',
      document: '',
      excel: '这是一个 Excel 表格文件。请根据表格内容生成摘要。',
    };
    const hint = modalityHints[modality ?? 'document'] ?? '';

    const prompt = `${hint ? hint + '\n\n' : ''}请为以下文档的结构化章节概要生成一份综合摘要（约200字），包含：
1. 文档主题和类型判断
2. 核心要点总结（3-5个关键发现）
3. 标签：标签1,标签2,...（5-10个关键标签）
4. 类型：[文档类型]
5. 日期：[文档中提到的关键日期]

文档章节概要：
${truncated}`;

    // Retry LLM call up to 3 times with exponential backoff
    let response = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await this.streamCompletion(prompt);
        // Strip thinking tags if present (some models wrap output in <think/> blocks)
        response = response.replace(/<think[\s\S]*?<\/think>/g, "").trim();
        if (response.trim().length > 0) {
          break;
        }
        console.warn(`[WikiCompiler] Abstract generation returned empty for doc ${docId}, attempt ${attempt}/3`);
      } catch (err) {
        console.warn(
          `[WikiCompiler] Abstract generation failed for doc ${docId} (attempt ${attempt}/3):`,
          err instanceof Error ? err.message : String(err),
        );
      }
      // Exponential backoff: 2s, 4s
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      }
    }

    // Fallback: extract meaningful content from structure sections (not just the first heading line)
    if (!response || response.trim().length === 0) {
      // Build a concise fallback from section content, skipping pure headings
      const sectionTexts = structureSections.length > 0
        ? structureSections.map((s) => s.preview).filter((p) => p.trim().length > 0)
        : [abstractInput];
      const combined = sectionTexts.join("\n").slice(0, 300);
      // Take first meaningful paragraph (skip lines that are just headings)
      const meaningfulLine = combined
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"))
        .slice(0, 3)
        .join(" ");
      response = meaningfulLine || "No abstract available.";
      console.warn(
        `[WikiCompiler] Using fallback abstract for doc ${docId}: ${response.slice(0, 80)}...`,
      );
    }

    await this.createWikiPageViaRepo(
      kbId,
      docId,
      "abstract",
      `Abstract: ${docId}`,
      response,
      this.pageManager.getWikiDir(),
    );
  }

  // -----------------------------------------------------------------------
  // Legacy: Fulltext (L2 equivalent - backward compatibility)
  // -----------------------------------------------------------------------

  private async compileFulltext(
    kbId: string,
    docId: string,
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const wikiDir = this.pageManager.getWikiDir();

    await this.createWikiPageViaRepo(
      kbId,
      docId,
      "fulltext",
      `Document: ${docId}`,
      content,
      wikiDir,
    );

    // Save metadata.json
    const metadataPath = join(
      wikiDir,
      kbId,
      "documents",
      docId,
      "metadata.json",
    );
    try {
      writeFileSyncAtomic(metadataPath, JSON.stringify(metadata, null, 2), { encoding: "utf-8" });
    } catch (err) {
      console.warn(
        `[WikiCompiler] Failed to write metadata for doc ${docId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Legacy: Overview (L1 equivalent)
  // -----------------------------------------------------------------------

  private async compileOverview(
    kbId: string,
    docId: string,
    fullContent: string,
    onProgress?: (message: string) => void,
  ): Promise<void> {
    const truncated =
      fullContent.length > 6000
        ? fullContent.slice(0, 6000) + "\n...(truncated)"
        : fullContent;

    const prompt = `请为以下文档内容生成一份结构化概览（约2000字），包含：
1. 文档类型判断（报告、会议纪要、合同、数据分析、学术论文等）
2. 文档结构导航（各章节标题和核心摘要）
3. 关键实体列表（人物、机构、地点、时间、金额、产品等）
4. 核心要点总结（3-5个关键发现或结论）
5. 数据亮点（如果有数字数据，列出关键数值及其含义）

请用 Markdown 格式输出，使用清晰的标题层级。

文档内容：
${truncated}`;

    // Retry up to 3 times with timeout and exponential backoff.
    // 120s per attempt — reasoning models (o1-class, R1, GLM-5.x thinking)
    // can take 60-90s for a single L0 summary, especially for long documents.
    let response = "";
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Surface retry counter so users can see the LLM is being retried on
      // transient failures, instead of an opaque static "编译中".
      onProgress?.(`生成摘要中（尝试 ${attempt + 1}/${maxAttempts}）`);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120_000);

        response = await this.streamCompletion(prompt, { signal: controller.signal });
        clearTimeout(timeout);

        if (response && response.trim().length > 0) break;
      } catch (err) {
        console.warn(
          `[WikiCompiler] Overview attempt ${attempt + 1}/${maxAttempts} failed for doc ${docId}:`,
          err instanceof Error ? err.message : String(err),
        );
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
    }

    if (!response || response.trim().length === 0) {
      // L0 摘要生成失败 — 不要写看似合法的 "# Document Overview" 占位
      // （那会让用户以为摘要成功、文档却标 ready，是假成功）。明确标注摘要
      // 失败，并附文档原文开头供查阅。
      response = `> ⚠️ L0 摘要自动生成失败（LLM 调用重试 ${maxAttempts} 次未成功，可能为超时或服务不可用）。以下为文档原文开头：\n\n${truncated}`;
    }

    await this.createWikiPageViaRepo(
      kbId,
      docId,
      "overview",
      `Overview: ${docId}`,
      response,
      this.pageManager.getWikiDir(),
    );
  }

  // -----------------------------------------------------------------------
  // Legacy: Abstract from Overview
  // -----------------------------------------------------------------------

  private async compileLegacyAbstract(kbId: string, docId: string): Promise<void> {
    const repos = await getRepos();
    const l1Page = await repos.wikiPage.getByDocAndType(docId, "overview");
    if (!l1Page) {
      console.warn(
        `[WikiCompiler] Overview not found for doc ${docId}, skipping Abstract`,
      );
      return;
    }

    const l1Content = l1Page.content || "";
    if (!l1Content || l1Content.trim().length === 0) {
      console.warn(
        `[WikiCompiler] Empty overview content for doc ${docId}, skipping Abstract`,
      );
      return;
    }

    const truncated =
      l1Content.length > 4000
        ? l1Content.slice(0, 4000) + "\n...(truncated)"
        : l1Content;

    const prompt = `请将以下文档概览压缩为：
第一行：一句话摘要（不超过80字）
第二行：标签：标签1,标签2,...（5-10个关键标签）
第三行：类型：[文档类型]
第四行：日期：[文档中提到的关键日期，如无则留空]

文档概览：
${truncated}`;

    let response = "";
    for (let attempt = 0; attempt < 3 && !response.trim(); attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt));
        response = await this.streamCompletion(prompt);
      } catch (err) {
        console.warn(
          `[WikiCompiler] Abstract generation attempt ${attempt + 1} failed for doc ${docId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (!response || response.trim().length === 0) {
      response = l1Content.slice(0, 200).split("\n")[0] || "No abstract available.";
    }

    await this.createWikiPageViaRepo(
      kbId,
      docId,
      "abstract",
      `Abstract: ${docId}`,
      response,
      this.pageManager.getWikiDir(),
    );
  }

  // -----------------------------------------------------------------------
  // Entity extraction and link creation
  // -----------------------------------------------------------------------

  private async extractAndUpdateLinks(
    kbId: string,
    docId: string,
  ): Promise<void> {
    const repos = await getRepos();

    // Read L1 content for entity extraction: try overview first (legacy), then structure pages (new), then abstract
    let l1Page = await repos.wikiPage.getByDocAndType(docId, "overview");
    if (!l1Page) {
      // New three-layer flow: use first structure page or abstract
      const structurePages = await repos.wikiPage.getManyByDocAndTypePrefix(docId, "structure");
      if (structurePages.length > 0) {
        // Use the first structure page as the link source
        l1Page = structurePages[0];
      } else {
        l1Page = await repos.wikiPage.getByDocAndType(docId, "abstract");
      }
    }
    if (!l1Page) {
      console.warn(
        `[WikiCompiler] No L1 page found for doc ${docId}, skipping entity extraction`,
      );
      return;
    }

    const l1Content = l1Page.content || "";
    if (!l1Content || l1Content.trim().length === 0) {
      console.warn(
        `[WikiCompiler] Empty L1 content for entity extraction, doc ${docId}`,
      );
      return;
    }

    // Extract entities using the model
    const entities = await this.entityExtractor.extract(l1Content);

    if (entities.length === 0) {
      return;
    }

    const wikiDir = this.pageManager.getWikiDir();

    for (const entity of entities) {
      try {
        // Check if entity page already exists for this KB
        let existingPage = await repos.wikiPage.findByTitle(kbId, entity.name, "entity");

        if (!existingPage) {
          // Create new entity page
          existingPage = await this.createWikiPageViaRepo(
            kbId,
            null,
            "entity",
            entity.name,
            `# ${entity.name}\n\n类型: ${entity.type}\n\n出现上下文:\n- ${entity.mentions.join("\n- ")}`,
            wikiDir,
          );
        }

        // Create a wiki_link from the document's overview page to the entity page
        if (existingPage && l1Page) {
          // Check if link already exists to avoid duplicates
          const existingLink = await repos.wikiLink.findExisting(
            l1Page.id,
            existingPage.id,
            "entity_ref",
            entity.name,
          );

          if (!existingLink) {
            await repos.wikiLink.create(
              l1Page.id,
              existingPage.id,
              "entity_ref",
              entity.name,
              entity.mentions[0] ?? null,
            );
          }
        }
      } catch (err) {
        console.warn(
          `[WikiCompiler] Failed to process entity "${entity.name}":`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers: Structure layer
  // -----------------------------------------------------------------------


  /**
   * Convert DocTags format to clean Markdown.
   * Strips structural tags like [paragraph], [table], [list] etc.
   * and converts heading tags to Markdown headings.
   * Preserves meaningful content while removing noisy formatting markers.
   */
  private doctagsToMarkdown(doctags: string): string {
    const lines = doctags.split("\n");
    const result: string[] = [];

    for (let line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        result.push("");
        continue;
      }

      // Convert heading tags to Markdown headings
      const h1Match = trimmed.match(/^\[h1\]\s*(.+)/);
      if (h1Match) {
        result.push(`# ${h1Match[1].trim()}`);
        continue;
      }
      const h2Match = trimmed.match(/^\[h2\]\s*(.+)/);
      if (h2Match) {
        result.push(`## ${h2Match[1].trim()}`);
        continue;
      }
      const h3Match = trimmed.match(/^\[h3\]\s*(.+)/);
      if (h3Match) {
        result.push(`### ${h3Match[1].trim()}`);
        continue;
      }
      const h4Match = trimmed.match(/^\[h4\]\s*(.+)/);
      if (h4Match) {
        result.push(`#### ${h4Match[1].trim()}`);
        continue;
      }

      // Strip common structural tags, keep content
      const strippedTag = trimmed.match(/^\[(paragraph|text|caption|title|header|footer|page_header|page_footer|footnote|endnote|code|formula|equation|figure|picture|image|chart)\]\s*(.*)/s);
      if (strippedTag) {
        const content = strippedTag[2].trim();
        if (content) result.push(content);
        continue;
      }

      // Convert list items: [unordered_list] or [ordered_list] content → bullet/numbered
      const ulMatch = trimmed.match(/^\[unordered_list\]\s*(.*)/s);
      if (ulMatch) {
        const content = ulMatch[1].trim();
        if (content) result.push(`- ${content}`);
        continue;
      }
      const olMatch = trimmed.match(/^\[ordered_list\]\s*(.*)/s);
      if (olMatch) {
        const content = olMatch[1].trim();
        if (content) result.push(`1. ${content}`);
        continue;
      }

      // Convert table tags to Markdown tables
      if (trimmed.startsWith("[table]")) {
        const tableContent = trimmed.replace(/^\[table\]\s*/, "").trim();
        if (tableContent) {
          result.push(this.convertDocTagsTable(tableContent));
        }
        continue;
      }
      if (trimmed.startsWith("[/table]")) continue;

      // Table row markers
      const rowMatch = trimmed.match(/^\[row\]\s*(.*)/s);
      if (rowMatch) {
        const cells = rowMatch[1].split("[cell]").map((c: string) => c.replace(/\[\/cell\]/g, "").trim()).filter(Boolean);
        if (cells.length > 0) {
          result.push(`| ${cells.join(" | ")} |`);
        }
        continue;
      }

      // Strip [list] container tags
      if (trimmed === "[list]" || trimmed === "[/list]" ||
          trimmed === "[unordered_list]" || trimmed === "[/unordered_list]" ||
          trimmed === "[ordered_list]" || trimmed === "[/ordered_list]") {
        continue;
      }

      // Strip any remaining standalone tag markers like [/paragraph], [/code], etc.
      if (/^\[\/[a-z_]+\]$/.test(trimmed)) continue;

      // Keep everything else (plain text content)
      result.push(trimmed);
    }

    // Clean up excessive blank lines
    return result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  /**
   * Convert DocTags table content to a Markdown table.
   * Input is raw cell content with [cell] delimiters.
   */
  private convertDocTagsTable(raw: string): string {
    // Try to parse as structured rows
    const rows: string[][] = [];
    const rowParts = raw.split(/\[row\]/).filter((s: string) => s.trim());

    for (const rowPart of rowParts) {
      const cells = rowPart.split(/\[cell\]/)
        .map((c: string) => c.replace(/\[\/cell\]/g, "").replace(/\[\/row\]/g, "").trim())
        .filter(Boolean);
      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    // If no structured rows found, treat as a single row
    if (rows.length === 0) {
      const cells = raw.split(/\[cell\]/)
        .map((c: string) => c.replace(/\[\/cell\]/g, "").trim())
        .filter(Boolean);
      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    if (rows.length === 0) return raw;

    // Build Markdown table
    const maxCols = Math.max(...rows.map((r) => r.length));
    const lines: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const padded = [...rows[i]];
      while (padded.length < maxCols) padded.push("");
      lines.push(`| ${padded.join(" | ")} |`);
      if (i === 0) {
        lines.push(`| ${Array(maxCols).fill("---").join(" | ")} |`);
      }
    }

    return lines.join("\n");
  }


  /**
   * Write anchors to the PG Repository layer.
   */
  private async writeAnchorsToRepo(anchors: AnchorDef[]): Promise<void> {
    try {
      const repos = await getRepos();

      // Delete existing anchors for this doc (to handle recompilation)
      if (anchors.length > 0) {
        await repos.anchor.deleteByDocId(anchors[0].doc_id);
      }

      await repos.anchor.batchInsert(anchors);
      console.log(
        `[WikiCompiler] Wrote ${anchors.length} anchors to PG`,
      );
    } catch (err) {
      console.warn(
        `[WikiCompiler] Failed to write anchors to PG:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Get structure section summaries for abstract generation.
   * First tries to read structure pages from PG (full content), then falls
   * back to anchor previews if no structure pages exist.
   */
  private async getStructureSectionSummaries(
    docId: string,
  ): Promise<Array<{ title: string; preview: string }>> {
    try {
      const repos = await getRepos();

      // Primary: read structure_md pages from PG (new dual-format L1)
      let structurePages = await repos.wikiPage.getManyByDocAndType(docId, "structure_md");
      // Fallback: read legacy structure pages (backward compat)
      if (structurePages.length === 0) {
        structurePages = await repos.wikiPage.getManyByDocAndType(docId, "structure");
      }
      if (structurePages.length > 0) {
        return structurePages.map((page) => ({
          title: page.title,
          preview: page.content?.slice(0, 2000) ?? "",
        }));
      }

      // Fallback: use anchor previews (limited but better than nothing)
      const anchors = await repos.anchor.getByDocId(docId);

      // Group by section_path, build summaries
      const sectionMap = new Map<
        string,
        { title: string; previews: string[] }
      >();

      for (const anchor of anchors) {
        const path = anchor.section_path || "0";
        if (!sectionMap.has(path)) {
          sectionMap.set(path, {
            title: anchor.section_title || `Section ${path}`,
            previews: [],
          });
        }
        if (anchor.content_preview) {
          sectionMap.get(path)!.previews.push(anchor.content_preview);
        }
      }

      if (sectionMap.size > 0) {
        return Array.from(sectionMap.entries()).map(([, v]) => ({
          title: v.title,
          preview: v.previews.slice(0, 10).join("\n"),
        }));
      }
    } catch {
      // Fall through
    }

    // Fallback: no anchors available
    return [];
  }

  /**
   * Get overview content as fallback for abstract generation.
   */
  private async getOverviewFallback(docId: string): Promise<string> {
    const repos = await getRepos();

    const overviewPage = await repos.wikiPage.getByDocAndType(docId, "overview");
    if (overviewPage && overviewPage.content) {
      return overviewPage.content;
    }

    const fulltextPage = await repos.wikiPage.getByDocAndType(docId, "fulltext");
    if (fulltextPage && fulltextPage.content) {
      return fulltextPage.content.slice(0, 2000);
    }

    return "";
  }

  // -----------------------------------------------------------------------
  // Helper: create wiki page via repos (DB + filesystem)
  // -----------------------------------------------------------------------

  /**
   * Create a wiki page: write content to filesystem and insert into PG.
   * This replaces the old createWikiPage() from wiki-pages.ts.
   */
  /**
   * Call chatStream and collect text content into a single string.
   *
   * Why streaming instead of router.chat(): reasoning models (o1-class,
   * GLM-5.x thinking, R1) can spend 60-90s in reasoning before emitting
   * the final answer. The non-streaming chat() call holds the HTTP
   * connection open without any traffic, and intermediate proxies /
   * load balancers / the upstream API itself may abort the connection
   * as idle — long before our 120s timeout fires. Streaming keeps the
   * connection alive with incremental chunks throughout the reasoning
   * phase, avoiding the spurious abort. See issue #76.
   *
   * thinking chunks (reasoning_content) are intentionally ignored — we
   * only collect the final answer text. tool_call chunks should not
   * appear here because L0/abstract prompts do not request tools.
   */
  private async streamCompletion(
    prompt: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    let response = "";
    for await (const chunk of this.router.chatStream(
      [{ role: "user", content: prompt }],
      { model: this.router.getDefaultModel("summarizer"), signal: options.signal },
    )) {
      if (chunk.type === "text" && chunk.content) {
        response += chunk.content;
      }
      // Ignore thinking/tool_call/done/error chunks. Errors will surface as
      // a thrown exception from the async iterator itself.
    }
    return response;
  }

  /** Broadcast a doc_level_ready event via WebSocket so the frontend can show progressive green. */
  private async emitLevelReady(kbId: string, docId: string, level: "L0" | "L1" | "L2"): Promise<void> {
    try {
      const { broadcastToKb } = await import("../server/ws.js");
      broadcastToKb(kbId, { type: "doc_level_ready", kbId, docId, level });
    } catch {
      // WebSocket module may not be loaded yet — non-critical
    }
  }

  private async createWikiPageViaRepo(
    kbId: string,
    docId: string | null,
    pageType: string,
    title: string,
    content: string,
    wikiDir: string,
  ): Promise<import("../store/repos/interfaces.js").WikiPage> {
    // Resolve filesystem path
    const id = randomUUID();
    const filePath = this.resolvePageFilePath(wikiDir, kbId, docId, pageType, title, id);

    // Ensure parent directory exists
    const parentDir = dirname(filePath);
    mkdirSync(parentDir, { recursive: true });

    // Check if file already exists (e.g., entity pages with same title)
    if (existsSync(filePath) && (pageType === "entity" || pageType === "concept")) {
      const existing = readFileSync(filePath, "utf-8");
      const updated = existing + "\n\n---\n\n" + content;
      writeFileSyncAtomic(filePath, updated, { encoding: "utf-8" });
    } else {
      writeFileSyncAtomic(filePath, content, { encoding: "utf-8" });
    }

    // Compute content hash and token count
    const contentHash = createHash("md5").update(content).digest("hex");
    const tokenCount = Math.ceil(content.length / 4);

    // Insert into PG
    const repos = await getRepos();
    const page = await repos.wikiPage.create({
      kb_id: kbId,
      doc_id: docId ?? undefined,
      page_type: pageType,
      title,
      content,
      file_path: filePath,
      content_hash: contentHash,
      token_count: tokenCount,
    });

    return page;
  }

  /**
   * Resolve filesystem path for a wiki page based on its type.
   */
  private resolvePageFilePath(
    wikiDir: string,
    kbId: string,
    docId: string | null,
    pageType: string,
    title: string,
    id: string,
  ): string {
    switch (pageType) {
      case "abstract":
        return join(wikiDir, kbId, "documents", docId!, ".abstract.md");
      case "overview":
        return join(wikiDir, kbId, "documents", docId!, ".overview.md");
      case "fulltext":
        return join(wikiDir, kbId, "documents", docId!, "parsed.md");
      case "entity": {
        const safeName = title.replace(/[/\\?%*:|"<>]/g, "_");
        return join(wikiDir, kbId, "entities", `${safeName}.md`);
      }
      case "concept": {
        const safeName = title.replace(/[/\\?%*:|"<>]/g, "_");
        return join(wikiDir, kbId, "concepts", `${safeName}.md`);
      }
      case "report":
        return join(wikiDir, kbId, "reports", `${id}.md`);
      case "structure": {
        const safeName = title.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 100);
        return join(wikiDir, kbId, "documents", docId!, "structure", `${safeName}.md`);
      }
      case "structure_md": {
        const safeName = title.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 100);
        return join(wikiDir, kbId, "documents", docId!, "structure", `${safeName}.md`);
      }
      case "structure_dt": {
        const safeName = title.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 100);
        return join(wikiDir, kbId, "documents", docId!, "structure_dt", `${safeName}.dt.md`);
      }
      default:
        return join(wikiDir, kbId, "documents", `${id}.md`);
    }
  }
}
