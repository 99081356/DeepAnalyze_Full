/**
 * AnchorGenerator - Generates stable element-level anchor IDs from DoclingDocument JSON.
 * Anchors are position-based (not hash-based) to ensure they don't change on recompilation.
 */
export interface AnchorDef {
  id: string;
  doc_id: string;
  kb_id: string;
  element_type: string;
  element_index: number;
  section_path: string | null;
  section_title: string | null;
  page_number: number | null;
  raw_json_path: string;
  structure_page_id: string | null;
  content_preview: string | null;
  content_hash: string | null;
  /** Line number in the L1 Markdown content (0-based). */
  line_start: number | null;
  metadata: Record<string, unknown>;
}

const MAX_PREVIEW_LENGTH = 200;

const ELEMENT_TYPE_MAP: Record<string, string> = {
  heading: 'heading',
  paragraph: 'paragraph',
  text: 'paragraph',
  table: 'table',
  picture: 'image',
  figure: 'image',
  formula: 'formula',
  list: 'list',
  code: 'code',
};

export class AnchorGenerator {
  /**
   * Generate anchors from a DoclingDocument JSON structure.
   * Traverses body.children, tracks heading levels to build section_path.
   */
  generateAnchors(docId: string, kbId: string, raw: Record<string, unknown>): AnchorDef[] {
    const children = this.getBodyChildren(raw);
    if (!children || children.length === 0) return [];

    const anchors: AnchorDef[] = [];
    const counters: Record<string, number> = {};
    // Track heading levels: h1Count, lastH2Count
    let h1Count = 0;
    let h2Count = 0;

    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Record<string, unknown>;
      const rawType = String(child.type ?? 'unknown');
      const mappedType = ELEMENT_TYPE_MAP[rawType] ?? rawType;

      // Track heading hierarchy
      if (rawType === 'heading') {
        const level = Number(child.level ?? 1);
        if (level === 1) {
          h1Count++;
          h2Count = 0;
        } else if (level === 2) {
          h2Count++;
        }
      }

      // Build section_path
      let sectionPath: string | null = null;
      if (h1Count > 0) {
        sectionPath = h2Count > 0 ? `${h1Count}.${h2Count}` : `${h1Count}`;
      }

      // Per-type counter
      const typeCount = counters[mappedType] ?? 0;
      counters[mappedType] = typeCount + 1;

      const text = this.getText(child);
      const elementIndex = typeCount;

      anchors.push({
        id: `${docId}:${mappedType}:${elementIndex}`,
        doc_id: docId,
        kb_id: kbId,
        element_type: mappedType,
        element_index: elementIndex,
        section_path: sectionPath,
        section_title: rawType === 'heading' ? (text ?? null) : null,
        page_number: null,
        raw_json_path: `#/body/children/${i}`,
        structure_page_id: null,
        content_preview: text ? text.slice(0, MAX_PREVIEW_LENGTH) : null,
        content_hash: null,
        line_start: null,
        metadata: {},
      });
    }

    return anchors;
  }

  /**
   * Generate anchors for Excel documents.
   * ID format: docId:table:sheetName_tableIdx
   */
  generateExcelAnchors(docId: string, kbId: string, raw: Record<string, unknown>): AnchorDef[] {
    const children = this.getBodyChildren(raw);
    if (!children || children.length === 0) return [];

    const anchors: AnchorDef[] = [];
    let tableIdx = 0;

    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Record<string, unknown>;
      if (String(child.type) !== 'table') continue;

      const meta = (child.metadata ?? {}) as Record<string, unknown>;
      const sheetName = String(meta.sheetName ?? `sheet${tableIdx}`);
      const tIdx = Number(meta.tableIndex ?? 0);
      const text = this.getText(child);

      anchors.push({
        id: `${docId}:table:${sheetName}_${tIdx}`,
        doc_id: docId,
        kb_id: kbId,
        element_type: 'table',
        element_index: tableIdx,
        section_path: sheetName,
        section_title: `${sheetName} - 表格${tIdx + 1}`,
        page_number: null,
        raw_json_path: `#/body/children/${i}`,
        structure_page_id: null,
        content_preview: text ? text.slice(0, MAX_PREVIEW_LENGTH) : null,
        content_hash: null,
        line_start: null,
        metadata: { sheetName, tableIndex: tIdx },
      });
      tableIdx++;
    }

    return anchors;
  }

  private getBodyChildren(raw: Record<string, unknown>): unknown[] {
    const body = raw.body as Record<string, unknown> | undefined;
    return (body?.children as unknown[]) ?? [];
  }

  /**
   * Generate anchors from MinerU's pdf_info format.
   * MinerU raw JSON has: { pdf_info: [{ para_blocks: [...] }], _backend, _version_name }
   * Each para_block has: { type, level, lines: [{ spans: [{ content }] }] }
   */
  generateMinerUAnchors(docId: string, kbId: string, raw: Record<string, unknown>): AnchorDef[] {
    const pdfInfo = raw.pdf_info;
    if (!Array.isArray(pdfInfo)) return [];

    const anchors: AnchorDef[] = [];
    const counters: Record<string, number> = {};
    let h1Count = 0;
    let h2Count = 0;

    // MinerU type mapping
    const typeMap: Record<string, string> = {
      title: "heading",
      text: "paragraph",
      table: "table",
      image: "image",
      index: "list",
      equation: "formula",
    };

    for (let pageIdx = 0; pageIdx < pdfInfo.length; pageIdx++) {
      const page = pdfInfo[pageIdx] as Record<string, unknown>;
      const paraBlocks = page.para_blocks;
      if (!Array.isArray(paraBlocks)) continue;

      for (let blockIdx = 0; blockIdx < paraBlocks.length; blockIdx++) {
        const block = paraBlocks[blockIdx] as Record<string, unknown>;
        const rawType = String(block.type ?? "unknown");
        const mappedType = typeMap[rawType] ?? rawType;

        // Track heading hierarchy
        const level = Number(block.level ?? 0);
        if (rawType === "title" && level > 0) {
          if (level === 1) {
            h1Count++;
            h2Count = 0;
          } else if (level === 2) {
            h2Count++;
          }
        }

        // Build section_path
        let sectionPath: string | null = null;
        if (h1Count > 0) {
          sectionPath = h2Count > 0 ? `${h1Count}.${h2Count}` : `${h1Count}`;
        }

        // Per-type counter
        const typeCount = counters[mappedType] ?? 0;
        counters[mappedType] = typeCount + 1;

        // Extract text from lines[].spans[].content
        const text = this.extractMinerUText(block);

        anchors.push({
          id: `${docId}:${mappedType}:${typeCount}`,
          doc_id: docId,
          kb_id: kbId,
          element_type: mappedType,
          element_index: typeCount,
          section_path: sectionPath,
          section_title: rawType === "title" ? text : null,
          page_number: pageIdx,
          raw_json_path: `#/pdf_info/${pageIdx}/para_blocks/${blockIdx}`,
          structure_page_id: null,
          content_preview: text ? text.slice(0, MAX_PREVIEW_LENGTH) : null,
          content_hash: null,
          line_start: null,
          metadata: { source: "mineru" },
        });
      }
    }

    return anchors;
  }

  /** Extract text from a MinerU para_block's lines/spans structure */
  private extractMinerUText(block: Record<string, unknown>): string | null {
    const lines = block.lines;
    if (!Array.isArray(lines)) return null;
    const parts: string[] = [];
    for (const line of lines) {
      const spans = (line as Record<string, unknown>).spans;
      if (!Array.isArray(spans)) continue;
      for (const span of spans) {
        const content = (span as Record<string, unknown>).content;
        if (typeof content === "string") parts.push(content);
      }
    }
    return parts.length > 0 ? parts.join(" ") : null;
  }

  private getText(child: Record<string, unknown>): string | null {
    const text = child.text ?? child.content ?? null;
    return text ? String(text) : null;
  }

  // -----------------------------------------------------------------------
  // Multimodal anchor generators
  // -----------------------------------------------------------------------

  /**
   * Generate anchors for an image — single anchor per image.
   */
  generateImageAnchors(
    docId: string, kbId: string, raw: { description?: string; ocrText?: string; width?: number; height?: number; format?: string },
  ): AnchorDef[] {
    return [{
      id: `${docId}:image:0`,
      doc_id: docId,
      kb_id: kbId,
      element_type: 'image',
      element_index: 0,
      section_path: 'image',
      section_title: undefined,
      page_number: undefined,
      raw_json_path: '#/image',
      structure_page_id: undefined,
      content_preview: raw.description?.slice(0, MAX_PREVIEW_LENGTH) ?? null,
      content_hash: null,
      line_start: 0,
      metadata: {
        format: raw.format,
        width: raw.width,
        height: raw.height,
      },
    }];
  }

  /**
   * Generate anchors for audio — one anchor per speaker turn.
   */
  generateAudioAnchors(
    docId: string, kbId: string, raw: {
      duration: number;
      speakers: Array<{ id: string; label: string }>;
      turns: Array<{ speaker: string; startTime: number; endTime: number; text: string }>;
    },
  ): AnchorDef[] {
    return raw.turns.map((turn, index) => ({
      id: `${docId}:turn:${index}`,
      doc_id: docId,
      kb_id: kbId,
      element_type: 'turn',
      element_index: index,
      section_path: turn.speaker,
      section_title: raw.speakers.find(s => s.id === turn.speaker)?.label ?? turn.speaker,
      page_number: Math.floor(turn.startTime),
      raw_json_path: `#/turns/${index}`,
      structure_page_id: undefined,
      content_preview: turn.text.slice(0, MAX_PREVIEW_LENGTH),
      content_hash: null,
      line_start: null,
      metadata: {
        startTime: turn.startTime,
        endTime: turn.endTime,
        speaker: turn.speaker,
      },
    }));
  }

  /**
   * Generate anchors for video — scene anchors + dialog turn anchors.
   */
  generateVideoAnchors(
    docId: string, kbId: string, raw: {
      duration: number;
      keyframes: Array<{ time: number; description: string }>;
      transcript: {
        duration: number;
        speakers: Array<{ id: string; label: string }>;
        turns: Array<{ speaker: string; startTime: number; endTime: number; text: string }>;
      };
    },
  ): AnchorDef[] {
    const sceneAnchors = raw.keyframes.map((kf, index) => ({
      id: `${docId}:scene:${index}`,
      doc_id: docId,
      kb_id: kbId,
      element_type: 'scene',
      element_index: index,
      section_path: `scene_${index}`,
      section_title: `场景${index + 1}`,
      page_number: Math.floor(kf.time),
      raw_json_path: `#/keyframes/${index}`,
      structure_page_id: undefined,
      content_preview: kf.description.slice(0, MAX_PREVIEW_LENGTH),
      content_hash: null,
      line_start: null,
      metadata: { time: kf.time },
    }));

    const turnAnchors = raw.transcript.turns.map((turn, index) => ({
      id: `${docId}:turn:${index}`,
      doc_id: docId,
      kb_id: kbId,
      element_type: 'turn',
      element_index: index,
      section_path: turn.speaker,
      section_title: raw.transcript.speakers.find(s => s.id === turn.speaker)?.label ?? turn.speaker,
      page_number: Math.floor(turn.startTime),
      raw_json_path: `#/transcript/turns/${index}`,
      structure_page_id: undefined,
      content_preview: turn.text.slice(0, MAX_PREVIEW_LENGTH),
      content_hash: null,
      line_start: null,
      metadata: {
        startTime: turn.startTime,
        endTime: turn.endTime,
        speaker: turn.speaker,
      },
    }));

    return [...sceneAnchors, ...turnAnchors];
  }

  // -----------------------------------------------------------------------
  // Markdown-based anchor generation (for document types: PDF, DOCX, etc.)
  // -----------------------------------------------------------------------

  /**
   * Generate anchors from L1 Markdown content by scanning line by line.
   * Produces anchors with accurate `line_start` fields since the Markdown
   * IS the L1 content.
   */
  generateMarkdownAnchors(docId: string, kbId: string, markdown: string): AnchorDef[] {
    const lines = markdown.split("\n");
    const anchors: AnchorDef[] = [];
    const counters: Record<string, number> = {};
    let h1Count = 0;
    let h2Count = 0;
    let h3Count = 0;

    // Track the current paragraph buffer (lines accumulated since last structural element)
    let paraStartLine = -1;
    let paraLines: string[] = [];

    const flushParagraph = () => {
      if (paraLines.length === 0) return;
      const text = paraLines.join("\n").trim();
      if (text.length === 0) { paraLines = []; return; }

      const typeCount = counters["paragraph"] ?? 0;
      counters["paragraph"] = typeCount + 1;

      // Build section_path from current heading context
      let sectionPath: string | null = null;
      if (h1Count > 0) {
        sectionPath = h3Count > 0
          ? `${h1Count}.${h2Count}.${h3Count}`
          : h2Count > 0
            ? `${h1Count}.${h2Count}`
            : `${h1Count}`;
      }

      anchors.push({
        id: `${docId}:paragraph:${typeCount}`,
        doc_id: docId,
        kb_id: kbId,
        element_type: "paragraph",
        element_index: typeCount,
        section_path: sectionPath,
        section_title: null,
        page_number: null,
        raw_json_path: "",
        structure_page_id: null,
        content_preview: text.slice(0, MAX_PREVIEW_LENGTH),
        content_hash: null,
        line_start: paraStartLine,
        metadata: {},
      });
      paraLines = [];
    };

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const trimmed = line.trim();

      // Heading detection: # ## ### etc.
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        flushParagraph();
        const level = headingMatch[1].length;
        const title = headingMatch[2].trim();

        if (level === 1) { h1Count++; h2Count = 0; h3Count = 0; }
        else if (level === 2) { h2Count++; h3Count = 0; }
        else if (level === 3) { h3Count++; }

        let sectionPath: string | null = null;
        if (h1Count > 0) {
          sectionPath = h3Count > 0
            ? `${h1Count}.${h2Count}.${h3Count}`
            : h2Count > 0
              ? `${h1Count}.${h2Count}`
              : `${h1Count}`;
        }

        const typeCount = counters["heading"] ?? 0;
        counters["heading"] = typeCount + 1;

        anchors.push({
          id: `${docId}:heading:${typeCount}`,
          doc_id: docId,
          kb_id: kbId,
          element_type: "heading",
          element_index: typeCount,
          section_path: sectionPath,
          section_title: title,
          page_number: null,
          raw_json_path: "",
          structure_page_id: null,
          content_preview: title.slice(0, MAX_PREVIEW_LENGTH),
          content_hash: null,
          line_start: lineIdx,
          metadata: { level },
        });
        continue;
      }

      // Table detection: line starting with |
      if (trimmed.startsWith("|") && !trimmed.startsWith("|---")) {
        // Check if this is the start of a new table (not a separator or continuation)
        if (paraStartLine !== lineIdx && !lines[Math.max(0, lineIdx - 1)]?.trim().startsWith("|")) {
          flushParagraph();

          const typeCount = counters["table"] ?? 0;
          counters["table"] = typeCount + 1;

          // Collect table content for preview
          let tableContent = trimmed;
          let scanIdx = lineIdx + 1;
          while (scanIdx < lines.length && lines[scanIdx].trim().startsWith("|")) {
            tableContent += "\n" + lines[scanIdx].trim();
            scanIdx++;
          }

          let sectionPath: string | null = null;
          if (h1Count > 0) {
            sectionPath = h3Count > 0
              ? `${h1Count}.${h2Count}.${h3Count}`
              : h2Count > 0
                ? `${h1Count}.${h2Count}`
                : `${h1Count}`;
          }

          anchors.push({
            id: `${docId}:table:${typeCount}`,
            doc_id: docId,
            kb_id: kbId,
            element_type: "table",
            element_index: typeCount,
            section_path: sectionPath,
            section_title: null,
            page_number: null,
            raw_json_path: "",
            structure_page_id: null,
            content_preview: tableContent.slice(0, MAX_PREVIEW_LENGTH),
            content_hash: null,
            line_start: lineIdx,
            metadata: {},
          });
        }
        continue;
      }

      // Image detection: ![alt](url)
      if (trimmed.match(/^!\[.*?\]\(.*?\)/)) {
        flushParagraph();
        const typeCount = counters["image"] ?? 0;
        counters["image"] = typeCount + 1;

        let sectionPath: string | null = null;
        if (h1Count > 0) {
          sectionPath = h3Count > 0
            ? `${h1Count}.${h2Count}.${h3Count}`
            : h2Count > 0
              ? `${h1Count}.${h2Count}`
              : `${h1Count}`;
        }

        anchors.push({
          id: `${docId}:image:${typeCount}`,
          doc_id: docId,
          kb_id: kbId,
          element_type: "image",
          element_index: typeCount,
          section_path: sectionPath,
          section_title: null,
          page_number: null,
          raw_json_path: "",
          structure_page_id: null,
          content_preview: trimmed.slice(0, MAX_PREVIEW_LENGTH),
          content_hash: null,
          line_start: lineIdx,
          metadata: {},
        });
        continue;
      }

      // Code block detection: ```
      if (trimmed.startsWith("```")) {
        flushParagraph();
        const typeCount = counters["code"] ?? 0;
        counters["code"] = typeCount + 1;

        let sectionPath: string | null = null;
        if (h1Count > 0) {
          sectionPath = h3Count > 0
            ? `${h1Count}.${h2Count}.${h3Count}`
            : h2Count > 0
              ? `${h1Count}.${h2Count}`
              : `${h1Count}`;
        }

        // Collect code block content for preview
        let codeContent = trimmed;
        let scanIdx = lineIdx + 1;
        while (scanIdx < lines.length && !lines[scanIdx].trim().startsWith("```")) {
          codeContent += "\n" + lines[scanIdx];
          scanIdx++;
        }
        if (scanIdx < lines.length) codeContent += "\n" + lines[scanIdx];

        anchors.push({
          id: `${docId}:code:${typeCount}`,
          doc_id: docId,
          kb_id: kbId,
          element_type: "code",
          element_index: typeCount,
          section_path: sectionPath,
          section_title: null,
          page_number: null,
          raw_json_path: "",
          structure_page_id: null,
          content_preview: codeContent.slice(0, MAX_PREVIEW_LENGTH),
          content_hash: null,
          line_start: lineIdx,
          metadata: {},
        });
        continue;
      }

      // Empty line → paragraph boundary
      if (trimmed.length === 0) {
        flushParagraph();
        continue;
      }

      // Regular text → accumulate into paragraph
      if (paraStartLine < 0) paraStartLine = lineIdx;
      paraLines.push(trimmed);
    }

    // Flush any remaining paragraph
    flushParagraph();

    return anchors;
  }

  /**
   * Backfill `line_start` for anchors generated from non-Markdown sources
   * (e.g. MinerU, Excel) by matching their `content_preview` in the Markdown.
   */
  backfillLineStart(anchors: AnchorDef[], markdown: string): void {
    const lines = markdown.split("\n");
    for (const anchor of anchors) {
      if (anchor.line_start != null) continue;
      if (!anchor.content_preview) continue;

      // Use the first 50 chars of content_preview for matching
      const searchStr = anchor.content_preview.slice(0, 50).trim();
      if (!searchStr) continue;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(searchStr)) {
          anchor.line_start = i;
          break;
        }
      }
    }
  }
}
