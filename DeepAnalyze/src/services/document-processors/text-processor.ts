import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import type { DocumentProcessor, ParsedContent } from "./types.js";

/**
 * Detect the encoding of a Buffer and decode it to a string.
 *
 * Strategy:
 * 1. BOM check (UTF-8, UTF-16 LE/BE)
 * 2. Pure ASCII → return as-is
 * 3. Try strict UTF-8 — if valid, use it
 * 4. Try GBK/GB2312 (common for Chinese .txt files)
 * 5. Try Big5 (Traditional Chinese)
 * 6. Fallback to UTF-8 with replacement chars
 */
function decodeWithEncodingDetection(buf: Buffer): { text: string; encoding: string } {
  // 1. BOM detection
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString("utf-8"), encoding: "UTF-8-BOM" };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf.subarray(2), "utf-16le"), encoding: "UTF-16LE-BOM" };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: iconv.decode(buf.subarray(2), "utf-16be"), encoding: "UTF-16BE-BOM" };
  }

  // 2. Pure ASCII check
  let isAscii = true;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) { isAscii = false; break; }
  }
  if (isAscii) {
    return { text: buf.toString("ascii"), encoding: "ASCII" };
  }

  // 3. Try strict UTF-8 — validate by checking for replacement chars after decode
  const utf8Text = buf.toString("utf-8");
  // Check if the UTF-8 decode produced replacement characters (indicates invalid UTF-8)
  const hasReplacement = utf8Text.includes("\uFFFD");

  if (!hasReplacement) {
    return { text: utf8Text, encoding: "UTF-8" };
  }

  // 4. Try GBK (covers GB2312, common for Simplified Chinese)
  try {
    const gbkText = iconv.decode(buf, "gbk");
    // Verify: GBK decode should not produce replacement chars for valid GBK input
    if (!gbkText.includes("\uFFFD")) {
      return { text: gbkText, encoding: "GBK" };
    }
  } catch { /* continue to next */ }

  // 5. Try Big5 (Traditional Chinese)
  try {
    const big5Text = iconv.decode(buf, "big5");
    if (!big5Text.includes("\uFFFD")) {
      return { text: big5Text, encoding: "Big5" };
    }
  } catch { /* continue to next */ }

  // 6. Try Latin-1 (ISO-8859-1) — always succeeds, may have wrong chars but no data loss
  try {
    const latin1Text = iconv.decode(buf, "latin1");
    if (!latin1Text.includes("\uFFFD")) {
      return { text: latin1Text, encoding: "ISO-8859-1" };
    }
  } catch { /* continue to next */ }

  // 7. Last resort: UTF-8 with replacement chars
  return { text: utf8Text, encoding: "UTF-8 (lossy)" };
}

export class TextProcessor implements DocumentProcessor {
  private static readonly HANDLED_TYPES = new Set([
    // Plain text
    "txt",
    // Config / data serialization (plain text)
    "yaml", "yml", "json", "xml", "toml", "ini",
    // Markup (fallback for when Docling is unavailable)
    "md", "html", "htm",
    // SVG is XML text — readable as text (no Docling backend)
    "svg",
  ]);

  canHandle(fileType: string): boolean {
    return TextProcessor.HANDLED_TYPES.has(fileType);
  }

  getStepLabel(): string {
    return "reading";
  }

  async parse(filePath: string): Promise<ParsedContent> {
    // Read as Buffer for encoding detection
    const buf = readFileSync(filePath);
    const { text, encoding } = decodeWithEncodingDetection(buf);
    return {
      text,
      metadata: {
        sourceType: "text",
        charCount: text.length,
        detectedEncoding: encoding,
      },
      success: true,
    };
  }
}
