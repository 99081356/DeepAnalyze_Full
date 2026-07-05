// =============================================================================
// DeepAnalyze - Quality Scorer
// Pure heuristic scoring for detecting severely low-quality extraction results.
// Philosophy: assume content is fine (100) unless we detect clear failure signals.
// Only flags content that is genuinely broken (empty, failure markers, garbled).
// No LLM calls.
// =============================================================================

// ---------------------------------------------------------------------------
// Common patterns indicating extraction failures
// ---------------------------------------------------------------------------

const VLM_FAILURE_PATTERNS = [
  /\[VLM不可用/i,
  /\[未配置VLM模型/i,
  /\[VLM失败/i,
  /VLM.*不可用/i,
  /未配置.*VLM/i,
];

const ASR_FAILURE_PATTERNS = [
  /\[ASR.*失败/i,
  /\[语音识别.*失败/i,
  /\[转写.*失败/i,
];

/** Matches line-by-line table descriptions like "第1行: ..." / "Row 1: ..." */
const LINE_BY_LINE_TABLE_RE = /(^|\n)((第\d+[行列]|Row\s*\d+|行\s*\d+).+(\n|$)){3,}/;

/**
 * Detect garbled Unicode: high proportion of replacement chars, control chars,
 * or repeated mojibake patterns. This catches Docling output that turned into
 * random Unicode soup.
 */
const GARBLED_PATTERNS = [
  /\ufffd.{0,3}\ufffd/,           // Unicode replacement chars
  /[\x00-\x08\x0b\x0c\x0e-\x1f]{3,}/, // Control characters
  /([\u0400-\u04ff]{2,})\1{3,}/,  // Repeated Cyrillic-like blocks
];

/** Matches markdown table syntax */
const MARKDOWN_TABLE_RE = /\|.+\|.+\|/;

// ---------------------------------------------------------------------------
// Score result
// ---------------------------------------------------------------------------

export interface QualityScore {
  /** 0-100 overall score. 100 = no issues detected, 0 = severe failure */
  score: number;
  /** List of detected quality issues */
  issues: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check for content-wide failure signals that apply to all modalities.
 * Returns { score: 0, issues } if a hard failure is detected, null otherwise.
 */
function detectHardFailure(content: string): QualityScore | null {
  // Empty / whitespace-only
  if (!content || content.trim().length === 0) {
    return { score: 0, issues: ["内容为空"] };
  }

  // VLM failure markers in content
  for (const pat of VLM_FAILURE_PATTERNS) {
    if (pat.test(content)) {
      return { score: 0, issues: [`VLM 调用失败`] };
    }
  }

  // Garbled / corrupted content
  for (const pat of GARBLED_PATTERNS) {
    if (pat.test(content)) {
      return { score: 0, issues: ["内容包含乱码"] };
    }
  }

  return null;
}

/**
 * Check if content is essentially only page numbers / headers with no real text.
 * Only relevant for PDF-like documents.
 */
function isOnlyPageNumbers(content: string): boolean {
  const stripped = content.replace(/[\s\d\-—_页page\n,.;:：；，。、]+/gi, "").trim();
  return stripped.length < 10 && content.length > 20;
}

// ---------------------------------------------------------------------------
// Image scoring
// ---------------------------------------------------------------------------

/**
 * Score image extraction quality.
 * Default 100 unless failures detected. Threshold: score 0 triggers re-extraction.
 */
export function scoreImage(description: string, ocrText: string): QualityScore {
  const combined = `${description ?? ""}\n${ocrText ?? ""}`;

  // Hard failure checks
  const hardFailure = detectHardFailure(combined);
  if (hardFailure) return hardFailure;

  const issues: string[] = [];
  let penalized = false;

  // Check for line-by-line table description pattern — this is a quality issue
  // but not a hard failure (the content exists, it's just badly formatted)
  if (LINE_BY_LINE_TABLE_RE.test(combined)) {
    issues.push("检测到逐行表格描述模式，建议用 Markdown 表格重新提取");
    penalized = true;
  }

  // If description is entirely composed of OCR text with no VLM description
  // (not a failure, just suboptimal — don't penalize)
  // The only case we penalize is when we have clear quality defects

  return {
    score: penalized ? 30 : 100,
    issues,
  };
}

// ---------------------------------------------------------------------------
// PDF scoring
// ---------------------------------------------------------------------------

/**
 * Score PDF extraction quality.
 * Default 100 unless failures detected. Threshold: score 0 triggers VLM supplementary.
 */
export function scorePdf(markdown: string, doctags: string): QualityScore {
  const combined = `${markdown ?? ""}\n${doctags ?? ""}`;

  // Hard failure checks
  const hardFailure = detectHardFailure(combined);
  if (hardFailure) return hardFailure;

  const issues: string[] = [];
  let penalized = false;

  // Content is only page numbers/headers — indicates scanned PDF with no OCR
  if (isOnlyPageNumbers(combined)) {
    issues.push("内容仅含页码/页眉，可能是扫描件未成功 OCR");
    penalized = true;
  }

  return {
    score: penalized ? 20 : 100,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Audio scoring
// ---------------------------------------------------------------------------

/**
 * Score audio transcription quality.
 * Default 100 unless failures detected. Threshold: score 0 triggers ASR retry.
 */
export function scoreAudio(transcription: string, turns: Array<{ text?: string }>): QualityScore {
  const combined = transcription ?? "";

  // Hard failure checks
  const hardFailure = detectHardFailure(combined);
  if (hardFailure) return hardFailure;

  // ASR failure markers
  for (const pat of ASR_FAILURE_PATTERNS) {
    if (pat.test(combined)) {
      return { score: 0, issues: ["ASR 调用失败"] };
    }
  }

  return { score: 100, issues: [] };
}

// ---------------------------------------------------------------------------
// Video scoring
// ---------------------------------------------------------------------------

/**
 * Score video extraction quality.
 * Default 100 unless failures detected. Threshold: score 0 triggers retry.
 */
export function scoreVideo(
  scenes: Array<{ description?: string }>,
  transcript: string,
): QualityScore {
  const combined = `${scenes?.map((s) => s.description ?? "").join("\n")}\n${transcript ?? ""}`;

  // Hard failure checks on combined content
  const hardFailure = detectHardFailure(combined);
  if (hardFailure) return hardFailure;

  // ASR failure markers
  for (const pat of ASR_FAILURE_PATTERNS) {
    if (pat.test(combined)) {
      return { score: 0, issues: ["ASR 调用失败"] };
    }
  }

  return { score: 100, issues: [] };
}

// ---------------------------------------------------------------------------
// Thresholds — only score 0 triggers re-extraction/retry
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  image: 50,   // Below this → re-extract (catches score 30 = line-by-line tables)
  pdf: 50,     // Below this → VLM supplementary (catches score 20 = page-numbers-only)
  audio: 50,   // Below this → ASR retry (catches score 0 = failure)
  video: 50,   // Below this → retry (catches score 0 = failure)
} as const;
