/**
 * DocTags sanitizer — detects garbled Unicode text in DocTags output.
 *
 * When OCR or PDF extraction produces corrupted text the DocTags markup is
 * useless (and may even confuse downstream consumers).  This module measures
 * the ratio of "non-standard" characters and, if the ratio exceeds the
 * threshold, clears the doctags payload so callers can fall back to plain
 * markdown.
 */

// ---------------------------------------------------------------------------
// Character-range helpers
// ---------------------------------------------------------------------------

/** Printable ASCII (space through tilde). */
function isASCII_PRINTABLE(cp: number): boolean {
  return cp >= 0x20 && cp <= 0x7e;
}

/** Newline, carriage-return, tab. */
function isWhitespaceControl(cp: number): boolean {
  return cp === 0x0a || cp === 0x0d || cp === 0x09;
}

/** CJK Unified Ideographs. */
function isCJK_UNIFIED(cp: number): boolean {
  return cp >= 0x4e00 && cp <= 0x9fff;
}

/** CJK Symbols and Punctuation. */
function isCJK_SYMBOLS(cp: number): boolean {
  return cp >= 0x3000 && cp <= 0x303f;
}

/** Fullwidth Forms (fullwidth Latin, halfwidth Katakana, etc.). */
function isFULLWIDTH_FORMS(cp: number): boolean {
  return cp >= 0xff00 && cp <= 0xffef;
}

/** General Punctuation (em-dash, quotes, ellipsis, etc.). */
function isGENERAL_PUNCTUATION(cp: number): boolean {
  return cp >= 0x2000 && cp <= 0x206f;
}

/** Latin Extended (Latin-1 Supplement + Latin Extended-A/B). */
function isLATIN_EXTENDED(cp: number): boolean {
  return cp >= 0x00c0 && cp <= 0x024f;
}

/** Cyrillic. */
function isCYRILLIC(cp: number): boolean {
  return cp >= 0x0400 && cp <= 0x04ff;
}

/** CJK Extension A. */
function isCJK_EXTENSION_A(cp: number): boolean {
  return cp >= 0x3400 && cp <= 0x4dbf;
}

/** Hangul Syllables. */
function isHANGUL(cp: number): boolean {
  return cp >= 0xac00 && cp <= 0xd7af;
}

/** Hiragana. */
function isHIRAGANA(cp: number): boolean {
  return cp >= 0x3040 && cp <= 0x309f;
}

/** Katakana. */
function isKATAKANA(cp: number): boolean {
  return cp >= 0x30a0 && cp <= 0x30ff;
}

/** Arabic. */
function isARABIC(cp: number): boolean {
  return cp >= 0x0600 && cp <= 0x06ff;
}

/** Thai. */
function isTHAI(cp: number): boolean {
  return cp >= 0x0e00 && cp <= 0x0e7f;
}

/** Devanagari. */
function isDEVANAGARI(cp: number): boolean {
  return cp >= 0x0900 && cp <= 0x097f;
}

/** Mathematical Operators. */
function isMATH_OPERATORS(cp: number): boolean {
  return cp >= 0x2200 && cp <= 0x22ff;
}

/** Arrows. */
function isARROWS(cp: number): boolean {
  return cp >= 0x2190 && cp <= 0x21ff;
}

/** Latin-1 Supplement / Common symbols (NBSP, copyright, degree, etc.). */
function isCOMMON_SYMBOLS(cp: number): boolean {
  return cp >= 0x00a0 && cp <= 0x00ff;
}

/** DocTags markup characters. */
const DOCTAGS_MARKUP = new Set([
  0x5b, // [
  0x5d, // ]
  0x3c, // <
  0x3e, // >
  0x2f, // /
  0x3d, // =
  0x22, // "
  0x27, // '
]);

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the given code-point falls within any of the "standard"
 * Unicode ranges recognised by the sanitizer.
 */
function isStandardCodePoint(cp: number): boolean {
  return (
    isASCII_PRINTABLE(cp) ||
    isWhitespaceControl(cp) ||
    isCJK_UNIFIED(cp) ||
    isCJK_SYMBOLS(cp) ||
    isFULLWIDTH_FORMS(cp) ||
    isGENERAL_PUNCTUATION(cp) ||
    isLATIN_EXTENDED(cp) ||
    isCYRILLIC(cp) ||
    isCJK_EXTENSION_A(cp) ||
    isHANGUL(cp) ||
    isHIRAGANA(cp) ||
    isKATAKANA(cp) ||
    isARABIC(cp) ||
    isTHAI(cp) ||
    isDEVANAGARI(cp) ||
    isMATH_OPERATORS(cp) ||
    isARROWS(cp) ||
    isCOMMON_SYMBOLS(cp) ||
    DOCTAGS_MARKUP.has(cp)
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SanitizeResult {
  /** The (possibly cleared) doctags string. */
  doctags: string;
  /** `true` when the garbled-character ratio exceeded the threshold. */
  wasGarbled: boolean;
  /** `true` when the doctags was cleared and `markdownFallback` was used
   *  as the returned `doctags` value. */
  fallbackUsed: boolean;
}

/** Ratio threshold above which text is considered garbled (15 %). */
const GARBLE_THRESHOLD = 0.15;

/**
 * Sanitize DocTags text by measuring the proportion of non-standard Unicode
 * characters.
 *
 * @param doctags        The raw DocTags string produced by Docling.
 * @param markdownFallback  Optional fallback text (usually the Markdown
 *                          output from the same parse).  When the doctags is
 *                          garbled this value will **not** replace doctags —
 *                          the function simply clears doctags to an empty
 *                          string.  The fallback is returned verbatim so the
 *                          caller can decide how to use it.
 * @returns A {@link SanitizeResult} with the sanitised payload.
 */
export function sanitizeDoctags(
  doctags: string,
  markdownFallback?: string,
): SanitizeResult {
  // Empty / whitespace-only input is never garbled.
  if (!doctags || doctags.trim().length === 0) {
    return { doctags, wasGarbled: false, fallbackUsed: false };
  }

  let total = 0;
  let nonStandard = 0;

  for (const ch of doctags) {
    const cp = ch.codePointAt(0)!;
    total += 1;
    if (!isStandardCodePoint(cp)) {
      nonStandard += 1;
    }
  }

  if (total === 0) {
    return { doctags, wasGarbled: false, fallbackUsed: false };
  }

  const ratio = nonStandard / total;

  if (ratio > GARBLE_THRESHOLD) {
    console.warn(
      `[DocTagsSanitizer] Garbled text detected — non-standard ratio ${(ratio * 100).toFixed(1)}% ` +
        `(${nonStandard}/${total} chars) exceeds ${(GARBLE_THRESHOLD * 100).toFixed(0)}% threshold. ` +
        `Clearing doctags output.`,
    );

    const usedFallback = typeof markdownFallback === "string" && markdownFallback.length > 0;

    if (usedFallback) {
      console.warn(
        `[DocTagsSanitizer] Markdown fallback available (${markdownFallback.length} chars).`,
      );
    }

    return {
      doctags: "",
      wasGarbled: true,
      fallbackUsed: usedFallback,
    };
  }

  return { doctags, wasGarbled: false, fallbackUsed: false };
}
