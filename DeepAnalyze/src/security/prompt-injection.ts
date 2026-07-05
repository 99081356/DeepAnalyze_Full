// =============================================================================
// DeepAnalyze - Prompt Injection Detection & External Content Boundary
// =============================================================================
// Two-layer defense against prompt injection through external content:
//
// Layer 1: Suspicious pattern detection
//   12 regex patterns that match common injection attack vectors.
//   Detections are logged for monitoring but content is still processed.
//
// Layer 2: External content boundary markers
//   Wraps content from external sources (web, files, tools) with unique,
//   cryptographically random boundary markers. Anti-spoofing sanitization
//   removes any existing markers in the content before wrapping.
//
// References:
//   OpenClaw src/security/external-content.ts
//   HackerOne #3086545 (Claude Desktop MCP attack)

import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Layer 1: Suspicious pattern detection
// ---------------------------------------------------------------------------

const SUSPICIOUS_PATTERNS: { pattern: RegExp; label: string }[] = [
  {
    pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
    label: "ignore-previous-instructions",
  },
  {
    pattern: /disregard\s+(all\s+)?(previous|prior|above)/i,
    label: "disregard-previous",
  },
  {
    pattern: /forget\s+(everything|all|your)\s+(instructions?|rules?|guidelines?)/i,
    label: "forget-instructions",
  },
  {
    pattern: /you\s+are\s+now\s+(a|an)\s+/i,
    label: "role-switch",
  },
  {
    pattern: /new\s+instructions?:/i,
    label: "new-instructions",
  },
  {
    pattern: /system\s*:?\s*(prompt|override|command)/i,
    label: "system-prompt-access",
  },
  {
    pattern: /\bexec\b.*command\s*=/i,
    label: "exec-command",
  },
  {
    pattern: /elevated\s*=\s*true/i,
    label: "elevation-attempt",
  },
  {
    pattern: /rm\s+-rf/i,
    label: "destructive-rm",
  },
  {
    pattern: /delete\s+all\s+(emails?|files?|data)/i,
    label: "delete-all",
  },
  {
    pattern: /<\/?system>/i,
    label: "system-tag",
  },
  {
    pattern: /\]\s*\n\s*\[?(system|assistant|user)\]?:/i,
    label: "role-injection",
  },
];

export interface InjectionDetectionResult {
  /** Whether any suspicious patterns were detected */
  detected: boolean;
  /** Labels of matched patterns */
  matches: string[];
  /** The original content (unchanged) */
  content: string;
}

/**
 * Detect suspicious patterns in content that may indicate a prompt injection attempt.
 * Returns match information without modifying the content.
 */
export function detectSuspiciousPatterns(content: string): InjectionDetectionResult {
  const matches: string[] = [];
  for (const { pattern, label } of SUSPICIOUS_PATTERNS) {
    if (pattern.test(content)) {
      matches.push(label);
    }
  }
  if (matches.length > 0) {
    console.warn(
      `[Security] Prompt injection patterns detected: ${matches.join(", ")}`
    );
  }
  return { detected: matches.length > 0, matches, content };
}

// ---------------------------------------------------------------------------
// Layer 2: External content boundary markers
// ---------------------------------------------------------------------------

const BOUNDARY_START_NAME = "EXTERNAL_UNTRUSTED_CONTENT";
const BOUNDARY_END_NAME = "END_EXTERNAL_UNTRUSTED_CONTENT";

/**
 * Source of external content — used in boundary marker metadata.
 */
export type ExternalContentSource =
  | "web_fetch"
  | "web_search"
  | "read_file"
  | "bash"
  | "pdf_read"
  | "mcp_tool"
  | "skill_output"
  | "unknown";

/**
 * Generate a cryptographically random marker ID (16 hex chars).
 */
function createMarkerId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Unicode homoglyph mapping — maps lookalike angle bracket characters
 * back to ASCII equivalents to prevent boundary marker spoofing.
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  // Fullwidth angle brackets
  "\uFF1C": "<",  // ＜
  "\uFF1E": ">",  // ＞
  // CJK angle brackets
  "\u3008": "<",  // 〈
  "\u3009": ">",  // 〉
  "\u300A": "<<", // 《
  "\u300B": ">>", // 》
  // Mathematical angle brackets
  "\u27E8": "<",  // ⟨
  "\u27E9": ">",  // ⟩
  "\u27EA": "<<", // ⟪
  "\u27EB": ">>", // ⟫
  // Heavy angle brackets
  "\u276C": "<",  // ❬
  "\u276D": ">",  // ❭
  "\u276E": "<",  // ❮
  "\u276F": ">",  // ❯
  // Supplemental arrows
  "\u2BA8": ">>", // ⮨
  "\u2BA9": "<<", // ⮩
};

// Zero-width and invisible characters to strip from boundary regions
const ZERO_WIDTH_CHARS = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g;

/**
 * Homoglyph replacement pattern — matches any known Unicode bracket variant.
 */
const HOMOGLYPH_PATTERN = new RegExp(
  Object.keys(HOMOGLYPH_MAP).join("|"),
  "g"
);

/**
 * Sanitize existing boundary markers in content to prevent spoofing.
 * Replaces Unicode homoglyphs with ASCII equivalents and strips zero-width chars.
 */
function sanitizeExistingMarkers(content: string): string {
  // Replace Unicode homoglyphs with ASCII
  let sanitized = content.replace(HOMOGLYPH_PATTERN, (ch) => HOMOGLYPH_MAP[ch] ?? ch);
  // Strip zero-width characters
  sanitized = sanitized.replace(ZERO_WIDTH_CHARS, "");
  return sanitized;
}

/**
 * Regex to match any existing boundary markers (including partial matches)
 * so they can be neutralized before we add our own.
 */
const EXISTING_MARKER_PATTERN = new RegExp(
  `<<<\\s*(${BOUNDARY_START_NAME}|${BOUNDARY_END_NAME})[^>]*>>>`,
  "gi"
);

/**
 * Neutralize any existing boundary markers in the content by replacing
 * the angle brackets with similar-looking but harmless characters.
 */
function neutralizeExistingMarkers(content: string): string {
  return content.replace(EXISTING_MARKER_PATTERN, (match) => {
    // Replace the <<< >>> with ⁁⁁⁁ ⁂⁂⁂ (caret/bullet combos)
    return match.replace(/</g, "\u2041").replace(/>/g, "\u2042");
  });
}

export interface WrapOptions {
  /** Source of the content */
  source: ExternalContentSource;
  /** Additional metadata about the source */
  sourceDetails?: string;
  /** Whether to run injection detection before wrapping (default: true) */
  detectInjection?: boolean;
}

export interface WrapResult {
  /** The wrapped content with boundary markers */
  wrapped: string;
  /** Injection detection results (if detection was enabled) */
  detection?: InjectionDetectionResult;
  /** The unique marker ID used */
  markerId: string;
}

/**
 * Wrap external content with unique boundary markers.
 *
 * This produces output like:
 * ```
 * <<<EXTERNAL_UNTRUSTED_CONTENT id="a3f2c1d8e4b5f6a7">>>
 * Source: web_fetch
 * URL: https://example.com
 * ---
 * [content here]
 * <<<END_EXTERNAL_UNTRUSTED_CONTENT id="a3f2c1d8e4b5f6a7">>>
 * ```
 *
 * The random ID prevents attackers from spoofing boundary markers,
 * since they cannot predict the ID at content generation time.
 */
export function wrapExternalContent(
  content: string,
  options: WrapOptions
): WrapResult {
  const markerId = createMarkerId();
  const detectInjection = options.detectInjection ?? true;

  // Step 1: Sanitize homoglyphs and zero-width chars
  let sanitized = sanitizeExistingMarkers(content);

  // Step 2: Neutralize any existing boundary markers
  sanitized = neutralizeExistingMarkers(sanitized);

  // Step 3: Run injection detection if enabled
  let detection: InjectionDetectionResult | undefined;
  if (detectInjection) {
    detection = detectSuspiciousPatterns(sanitized);
  }

  // Step 4: Build wrapped content
  const sourceLine = `Source: ${options.source}`;
  const detailsLine = options.sourceDetails
    ? `\n${options.sourceDetails}`
    : "";
  const separator = "---";

  const wrapped =
    `<<<${BOUNDARY_START_NAME} id="${markerId}">>>\n` +
    `${sourceLine}${detailsLine}\n` +
    `${separator}\n` +
    `${sanitized}\n` +
    `<<<${BOUNDARY_END_NAME} id="${markerId}">>>`;

  return { wrapped, detection, markerId };
}

/**
 * Check if content appears to contain boundary markers.
 * Useful for testing and validation.
 */
export function hasBoundaryMarkers(content: string): boolean {
  return content.includes(BOUNDARY_START_NAME) || content.includes(BOUNDARY_END_NAME);
}

/**
 * Extract content from between boundary markers.
 * Returns the inner content without markers, or null if no valid markers found.
 */
export function unwrapExternalContent(wrapped: string): string | null {
  const match = wrapped.match(
    new RegExp(
      `<<<${BOUNDARY_START_NAME} id="([0-9a-f]+)">>>\\n` +
      `[\\s\\S]*?\\n---\\n` +
      `([\\s\\S]*?)\\n` +
      `<<<${BOUNDARY_END_NAME} id="\\1">>>`
    )
  );
  return match ? match[2] : null;
}
