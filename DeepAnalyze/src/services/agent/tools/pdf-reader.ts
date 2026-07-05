// =============================================================================
// DeepAnalyze - PDF Text Extraction Tool
// =============================================================================
// Extracts text content from PDF files (URL or buffer).
// Primary: Uses Docling (DeepAnalyze's built-in document processor with OCR)
// Fallback: Uses pdf-parse library for quick text extraction
// =============================================================================

import path from "path";
import fs from "fs";
import os from "os";
import axios from "axios";

// ---------------------------------------------------------------------------
// Proxy configuration
// ---------------------------------------------------------------------------
function getProxyConfig(): { host: string; port: number; protocol: string } | false {
  const envKeys = ['DEEPANALYZE_WEB_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];
  let proxyUrl: string | undefined;
  for (const key of envKeys) {
    const val = process.env[key];
    if (val && val.length > 0) {
      proxyUrl = val;
      break;
    }
  }
  if (!proxyUrl) return false;
  try {
    const parsed = new URL(proxyUrl);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port) || (parsed.protocol === "https:" ? 443 : 80),
      protocol: parsed.protocol.replace(":", ""),
    };
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Strategy 1: Docling (full-featured parsing with OCR, tables, layout)
// ---------------------------------------------------------------------------
async function extractWithDocling(filePath: string): Promise<string | null> {
  try {
    const { DoclingProcessor } = await import("../../document-processors/docling-processor.js");
    const processor = new DoclingProcessor();
    const result = await processor.parse(filePath);

    // Build content from available text representations
    let content = result?.text || result?.doctags || result?.markdown || "";

    // Append extracted tables as structured data for Agent processing (pandas etc.)
    if (result?.tables && result.tables.length > 0) {
      content += "\n\n## Tables\n\n";
      for (const table of result.tables) {
        content += table.data + "\n\n";
      }
    }

    if (content.trim().length > 0) {
      return content;
    }
  } catch (err) {
    console.log(`[PdfReader] Docling extraction failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strategy 2: pdf-parse (quick text extraction)
// ---------------------------------------------------------------------------
async function extractWithPdfParse(buffer: Buffer): Promise<string | null> {
  try {
    const pdfParse = await import("pdf-parse");
    // pdf-parse v2 exports a PDFParse class (not a default function)
    const PDFParse = (pdfParse as any).PDFParse;
    if (PDFParse) {
      const uint8 = new Uint8Array(buffer);
      const parser = new PDFParse(uint8);
      const data = await parser.getText();
      if (data?.text && data.text.trim().length > 0) {
        let result = data.text;
        const meta: string[] = [];
        if (data.info?.Title) meta.push(`Title: ${data.info.Title}`);
        if (data.info?.Author) meta.push(`Author: ${data.info.Author}`);
        if (data.numpages) meta.push(`Pages: ${data.numpages}`);
        if (meta.length > 0) {
          result = `## PDF Metadata\n${meta.join("\n")}\n\n## Content\n${result}`;
        }
        return result;
      }
    }
    // Fallback: v1 API (default export)
    const fn = (pdfParse as any).default;
    if (fn && typeof fn === "function") {
      const data = await fn(buffer);
      if (data?.text && data.text.trim().length > 0) {
        let result = data.text;
        const meta: string[] = [];
        if (data.info?.Title) meta.push(`Title: ${data.info.Title}`);
        if (data.info?.Author) meta.push(`Author: ${data.info.Author}`);
        if (data.numpages) meta.push(`Pages: ${data.numpages}`);
        if (meta.length > 0) {
          result = `## PDF Metadata\n${meta.join("\n")}\n\n## Content\n${result}`;
        }
        return result;
      }
    }
  } catch (err) {
    console.log(`[PdfReader] pdf-parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Export: Extract text from a PDF buffer (used by web_fetch for inline PDFs)
// ---------------------------------------------------------------------------
export async function extractPdfText(buffer: Buffer): Promise<string | null> {
  // Try pdf-parse first for buffers (fast, no file I/O needed)
  const pdfParseResult = await extractWithPdfParse(buffer);
  if (pdfParseResult) return pdfParseResult;

  // Basic text extraction fallback
  return extractBasicText(buffer);
}

function extractBasicText(buffer: Buffer): string | null {
  const text = buffer.toString("latin1");
  const textParts: string[] = [];

  const tjPattern = /\(([^\\)]*(?:\\.[^\\)]*)*)\)\s*Tj/g;
  let match;
  while ((match = tjPattern.exec(text)) !== null) {
    const decoded = decodePdfString(match[1]);
    if (decoded.trim().length > 0) textParts.push(decoded);
  }

  const tjArrayPattern = /\[(.*?)\]\s*TJ/g;
  while ((match = tjArrayPattern.exec(text)) !== null) {
    const parts = match[1].match(/\(([^\\)]*(?:\\.[^\\)]*)*)\)/g);
    if (parts) {
      const combined = parts.map(p => decodePdfString(p.slice(1, -1))).join("");
      if (combined.trim().length > 0) textParts.push(combined);
    }
  }

  if (textParts.length === 0) return null;
  const filtered = textParts
    .filter(p => p.length > 1 || /[\w\u4e00-\u9fff]/.test(p))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return filtered.length > 20 ? filtered : null;
}

function decodePdfString(s: string): string {
  return s
    .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\")
    .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

// ---------------------------------------------------------------------------
// URL normalization (arXiv, DOI, SciSpace mirrors, etc.)
// ---------------------------------------------------------------------------
function normalizePdfUrl(url: string): string {
  // arXiv abstract page → PDF link
  const arxivAbsMatch = url.match(/^https?:\/\/arxiv\.org\/abs\/([\d.]+)$/i);
  if (arxivAbsMatch) {
    return `https://arxiv.org/pdf/${arxivAbsMatch[1]}.pdf`;
  }
  // arXiv already with /pdf/ but no .pdf extension
  const arxivPdfMatch = url.match(/^https?:\/\/arxiv\.org\/pdf\/([\d.]+)$/i);
  if (arxivPdfMatch) {
    return `https://arxiv.org/pdf/${arxivPdfMatch[1]}.pdf`;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Download helper
// ---------------------------------------------------------------------------
async function downloadPdf(url: string): Promise<{ buffer: Buffer; tmpPath: string }> {
  const proxy = getProxyConfig();
  const response = await axios.get(url, {
    timeout: 30_000,
    maxContentLength: 20 * 1024 * 1024,
    responseType: "arraybuffer",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/pdf,*/*",
    },
    maxRedirects: 5,
    validateStatus: (status: number) => status >= 200 && status < 400,
    ...(proxy ? { proxy } : {}),
  });

  const buffer = Buffer.from(response.data);

  // Save to temp file for Docling processing
  const tmpDir = path.join(os.tmpdir(), "deepanalyze-pdf");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `pdf-${Date.now()}.pdf`);
  fs.writeFileSync(tmpPath, buffer);

  return { buffer, tmpPath };
}

// ---------------------------------------------------------------------------
// Tool export
// ---------------------------------------------------------------------------
export function createPdfReadTool(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    name: "pdf_read",
    description:
      "读取 PDF 文件并提取文本内容。使用 Docling 引擎进行高质量解析，" +
      "支持 OCR、表格提取和版面分析。\n\n" +
      "使用场景：\n" +
      "- 需要阅读学术论文、报告、合同等 PDF 文档\n" +
      "- 从 PDF 中提取文字、表格内容进行分析\n" +
      "- web_search 或 web_fetch 发现 PDF 链接时，用此工具读取内容\n" +
      "- 需要处理扫描版 PDF（图片型），Docling 的 OCR 能力可以提取文字\n\n" +
      "注意：解析大型 PDF 可能需要较长时间，请耐心等待。",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "PDF 文件的 URL 地址",
        },
      },
      required: ["url"],
    },
    async execute(input: Record<string, unknown>) {
      let url = input.url as string;
      if (!url || typeof url !== "string") {
        return { error: true, message: "必须提供 url 参数" };
      }

      // Normalize URL (arXiv abstract → PDF, etc.)
      url = normalizePdfUrl(url);

      // Build list of URLs to try: original first, then fallback mirrors
      const urlsToTry: string[] = [url];

      // Semantic Scholar PDF → try SciSpace mirror
      if (url.includes("semanticscholar.org")) {
        const ssMatch = url.match(/semanticscholar\.com\/paper\/([a-f0-9]+)/i);
        if (ssMatch) {
          urlsToTry.push(`https://scispace.com/pdf/${ssMatch[1]}.pdf`);
        }
      }

      // Generic academic PDF → try Wayback Machine
      urlsToTry.push(`https://web.archive.org/web/${url}`);

      let tmpPath: string | undefined;
      let buffer: Buffer | undefined;
      let lastError: string | undefined;

      try {
        // Try each URL in order until one succeeds
        for (const tryUrl of urlsToTry) {
          try {
            console.log(`[PdfReader] Downloading PDF from ${tryUrl}...`);
            const downloadResult = await downloadPdf(tryUrl);
            tmpPath = downloadResult.tmpPath;
            buffer = downloadResult.buffer;
            if (tryUrl !== url) {
              console.log(`[PdfReader] Successfully downloaded from fallback: ${tryUrl}`);
            }
            break;
          } catch (dlErr) {
            lastError = dlErr instanceof Error ? dlErr.message : String(dlErr);
            console.log(`[PdfReader] Download failed for ${tryUrl}: ${lastError}`);
            continue;
          }
        }

        if (!buffer || !tmpPath) {
          return {
            error: true,
            message: `无法下载 PDF: ${lastError}`,
            suggestion: "PDF 下载失败。建议：1) 使用 web_search 搜索该文档的 HTML 版本或转载；2) 搜索文档标题查找其他来源。",
          };
        }

        // Strategy 1: Docling (full-featured, with OCR and tables)
        console.log(`[PdfReader] Trying Docling extraction...`);
        const doclingResult = await extractWithDocling(tmpPath);
        if (doclingResult) {
          const maxLength = 50_000;
          let content = doclingResult;
          if (content.length > maxLength) {
            content = content.substring(0, maxLength) + "\n\n... [PDF 内容已截断]";
          }
          return {
            success: true,
            url,
            content,
            bytes: buffer.length,
            method: "docling",
            truncated: doclingResult.length > maxLength,
          };
        }

        // Strategy 2: pdf-parse (quick text extraction)
        console.log(`[PdfReader] Docling returned no content, trying pdf-parse...`);
        const pdfParseResult = await extractWithPdfParse(buffer);
        if (pdfParseResult) {
          const maxLength = 50_000;
          let content = pdfParseResult;
          if (content.length > maxLength) {
            content = content.substring(0, maxLength) + "\n\n... [PDF 内容已截断]";
          }
          return {
            success: true,
            url,
            content,
            bytes: buffer.length,
            method: "pdf-parse",
            truncated: pdfParseResult.length > maxLength,
          };
        }

        return {
          error: true,
          message: `无法从 PDF 提取文本内容: ${url}`,
          suggestion: "该 PDF 可能是扫描版（图片型）且 OCR 不可用。请尝试搜索该文档的其他格式版本。",
        };
      } catch (err) {
        return {
          error: true,
          message: `获取或解析 PDF 失败: ${err instanceof Error ? err.message : String(err)}`,
          suggestion: "检查 URL 是否正确指向 PDF 文件，或尝试使用 web_search 搜索该文档的 HTML 版本。",
        };
      } finally {
        // Clean up temp file
        if (tmpPath) {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        }
      }
    },
  };
}
