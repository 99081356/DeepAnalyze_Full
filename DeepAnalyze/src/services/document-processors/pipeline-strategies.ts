/**
 * Default pipeline strategies — determines which parser to use per file type.
 */

export interface PipelineEntry {
  pipeline: "docling" | "mineru" | "native" | "asr" | "text" | "doc_converter";
  /** MinerU backend (only when pipeline === "mineru") */
  mineruBackend?: string;
  priority: number;
}

export interface PipelineStrategy {
  /** File type category or specific extension */
  fileType: string;
  pipelines: PipelineEntry[];
}

// ---------------------------------------------------------------------------
// Default strategies
// ---------------------------------------------------------------------------

export const DEFAULT_STRATEGIES: PipelineStrategy[] = [
  // PDF — MinerU hybrid (VLM+OCR, best quality) first, pipeline (OCR) fallback, then Docling.
  {
    fileType: "pdf",
    pipelines: [
      { pipeline: "mineru", mineruBackend: "hybrid-auto-engine", priority: 1 },
      { pipeline: "mineru", mineruBackend: "pipeline", priority: 2 },
      { pipeline: "docling", priority: 3 },
    ],
  },
  // DOCX — MinerU Office + Docling fallback
  {
    fileType: "docx",
    pipelines: [
      { pipeline: "mineru", mineruBackend: "pipeline", priority: 1 },
      { pipeline: "docling", priority: 2 },
    ],
  },
  // PPTX — MinerU Office (better spatial ordering) + Docling fallback
  {
    fileType: "pptx",
    pipelines: [
      { pipeline: "mineru", mineruBackend: "pipeline", priority: 1 },
      { pipeline: "docling", priority: 2 },
    ],
  },
  // Images — Docling only (MinerU hybrid is too slow for images,
  // and MinerU pipeline produces no text for photos.
  // Docling with VLM provides best image descriptions.)
  {
    fileType: "image",
    pipelines: [
      { pipeline: "docling", priority: 1 },
    ],
  },
  // Audio — Local ASR first (uses Whisper with Simplified Chinese prompt),
  // Docling as fallback (uses its own internal Whisper tiny model).
  {
    fileType: "audio",
    pipelines: [
      { pipeline: "asr", priority: 1 },
      { pipeline: "docling", priority: 2 },
    ],
  },
  // Video — Docling only (MinerU doesn't support video)
  {
    fileType: "video",
    pipelines: [
      { pipeline: "docling", priority: 1 },
    ],
  },
  // Spreadsheet — Native only (best for structured data)
  {
    fileType: "spreadsheet",
    pipelines: [
      { pipeline: "native", priority: 1 },
    ],
  },
  // Plain text — TextProcessor first (trivial readFile + encoding detection),
  // Docling as fallback for edge cases.
  {
    fileType: "txt",
    pipelines: [
      { pipeline: "text", priority: 1 },
      { pipeline: "docling", priority: 2 },
    ],
  },
  // Markup formats — Docling (proper parsing for MD/HTML/LaTeX),
  // TextProcessor as fallback.
  {
    fileType: "text",
    pipelines: [
      { pipeline: "docling", priority: 1 },
      { pipeline: "text", priority: 2 },
    ],
  },
  // Legacy office formats (.doc, .ppt, .rtf, .odt) — LibreOffice conversion
  // to modern equivalent (.docx/.pptx), then Docling. Direct Docling attempt
  // as fallback (may fail on binary legacy formats).
  {
    fileType: "doc_legacy",
    pipelines: [
      { pipeline: "doc_converter", priority: 1 },
      { pipeline: "docling", priority: 2 },
    ],
  },
];

// Map file extensions to strategy file type categories
const FILE_TYPE_CATEGORIES: Record<string, string> = {
  // PDF
  pdf: "pdf",
  // Office
  docx: "docx", pptx: "pptx", xlsx: "spreadsheet", xls: "spreadsheet",
  xlsm: "spreadsheet", csv: "spreadsheet",
  // Images — svg is XML text, routed to txt (Docling can't parse SVG)
  jpg: "image", jpeg: "image", png: "image", gif: "image",
  bmp: "image", tiff: "image", tif: "image", webp: "image",
  // Audio
  mp3: "audio", wav: "audio", flac: "audio", m4a: "audio",
  aac: "audio", ogg: "audio",
  // Video
  mp4: "video", avi: "video", mov: "video", mkv: "video", webm: "video",
  // Plain text — txt gets its own category (simple readFile + encoding detection)
  txt: "txt",
  // YAML/TOML/INI — plain text config files, same as txt
  yaml: "txt", yml: "txt", toml: "txt", ini: "txt",
  // SVG — XML text, read via TextProcessor (Docling has no SVG backend)
  svg: "txt",
  // Markup formats — Docling for proper parsing, TextProcessor fallback
  md: "text", html: "text", htm: "text",
  latex: "text", tex: "text", json: "text", xml: "text",
  asciidoc: "text", adoc: "text", asc: "text",
  // Office legacy — need LibreOffice conversion before parsing
  doc: "doc_legacy", ppt: "doc_legacy", rtf: "doc_legacy", odt: "doc_legacy",
};

/**
 * Get the strategy category for a file extension.
 */
export function getFileTypeCategory(fileType: string): string {
  return FILE_TYPE_CATEGORIES[fileType] ?? "text";
}
