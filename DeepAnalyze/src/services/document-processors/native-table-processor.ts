/**
 * Native Table Processor – unified handling for XLSX, XLS, and CSV files.
 *
 * Strategy:
 * - ALL tabular files: generate metadata description only (sheet info, headers, sample rows, file path)
 * - Agent uses bash+pandas to analyze source files directly
 * - No cell content stored in wiki pages (avoids NULL byte encoding issues with PostgreSQL)
 */

import { basename, extname } from "node:path";
import { readFileSync, statSync, createReadStream } from "node:fs";
import type { DocumentProcessor, ParsedContent } from "./types.js";

interface SheetInfo {
  name: string;
  rowCount: number;
  colCount: number;
  headers: string[];
  sampleRows: string[][];
  dataTypes: string[];
}

/** Maximum lines to read into memory for CSV header/sample extraction */
const CSV_MAX_PREVIEW_LINES = 100;

export class NativeTableProcessor implements DocumentProcessor {
  private static readonly HANDLED_TYPES = new Set(["xlsx", "xls", "xlsm", "csv"]);

  canHandle(fileType: string): boolean {
    return NativeTableProcessor.HANDLED_TYPES.has(fileType);
  }

  getStepLabel(): string {
    return "table_native_parsing";
  }

  async parse(filePath: string): Promise<ParsedContent> {
    const ext = extname(filePath).toLowerCase().replace(".", "");
    try {
      if (ext === "csv") {
        return await this.parseCsv(filePath);
      }
      return this.parseExcel(filePath);
    } catch (err) {
      return {
        text: "",
        metadata: { sourceType: "table_native" },
        success: false,
        error: `表格解析失败: ${err instanceof Error ? err.message : String(err)}`,
        modality: "excel",
      };
    }
  }

  // -----------------------------------------------------------------------
  // CSV parsing – streaming: avoids reading entire file into memory
  // -----------------------------------------------------------------------

  private async parseCsv(filePath: string): Promise<ParsedContent> {
    const fileSize = statSync(filePath).size;

    // Single streaming pass: captures preview lines + counts total data rows
    const { previewLines, totalDataRows } = await this.streamCsvMeta(filePath);

    // Detect delimiter: count occurrences in first line
    const firstLine = previewLines[0] ?? "";
    const delimiter = detectDelimiter(firstLine);

    // Parse headers from first line
    const headers = parseCsvLine(firstLine, delimiter).map((h) => h.trim());
    const colCount = headers.length;

    // Parse sample rows (up to 5 data rows from preview)
    const sampleRows: string[][] = [];
    const sampleEnd = Math.min(6, previewLines.length);
    for (let i = 1; i < sampleEnd; i++) {
      const line = previewLines[i]?.trim();
      if (!line) continue;
      const cells = parseCsvLine(line, delimiter);
      sampleRows.push(
        headers.map((_, colIdx) => cells[colIdx]?.trim() ?? ""),
      );
    }

    // Infer data types from sample
    const dataTypes = headers.map((_: string, colIdx: number) => {
      const values = sampleRows.map((r) => r[colIdx]).filter(Boolean);
      if (values.length === 0) return "unknown";
      const allNum = values.every((v) => !isNaN(Number(v)));
      if (allNum) return "number";
      return "text";
    });

    const tableName = basename(filePath, extname(filePath));
    const sheets: SheetInfo[] = [
      {
        name: tableName,
        rowCount: totalDataRows,
        colCount,
        headers,
        sampleRows,
        dataTypes,
      },
    ];

    const metadataDescription = this.buildMetadataDescription(
      sheets,
      filePath,
      fileSize,
      totalDataRows,
      "csv",
    );

    return {
      text: metadataDescription,
      metadata: {
        sourceType: "table_native",
        sheetCount: 1,
        sheetNames: [tableName],
        totalRows: totalDataRows,
        isSmallTable: totalDataRows <= 1000,
        sheets: sheets.map((s) => ({
          name: s.name,
          rowCount: s.rowCount,
          colCount: s.colCount,
          headers: s.headers,
          sampleRows: s.sampleRows,
          dataTypes: s.dataTypes,
        })),
        filePath,
        fileSize,
      },
      success: true,
      modality: "excel",
    };
  }

  /**
   * Stream through a CSV file in a single pass:
   * - Capture the first CSV_MAX_PREVIEW_LINES lines for header/sample extraction
   * - Count total non-empty data rows (excluding header)
   * Memory usage is bounded regardless of file size.
   */
  private streamCsvMeta(filePath: string): Promise<{
    previewLines: string[];
    totalDataRows: number;
  }> {
    return new Promise((resolve, reject) => {
      const previewLines: string[] = [];
      let totalDataRows = 0;
      let isFirst = true;
      let remaining = "";

      const stream = createReadStream(filePath, { encoding: "utf-8" });

      stream.on("data", (chunk: string) => {
        remaining += chunk;
        let idx: number;
        while ((idx = remaining.indexOf("\n")) !== -1) {
          let line = remaining.substring(0, idx);
          // Handle \r\n line endings
          if (line.endsWith("\r")) line = line.slice(0, -1);
          remaining = remaining.substring(idx + 1);

          if (isFirst) {
            // First line is the header
            previewLines.push(line);
            isFirst = false;
          } else {
            if (line.trim()) totalDataRows++;
            if (previewLines.length < CSV_MAX_PREVIEW_LINES) {
              previewLines.push(line);
            }
          }
        }
      });

      stream.on("end", () => {
        // Handle last line without trailing newline
        const last = remaining.trimEnd();
        if (last) {
          if (isFirst) {
            previewLines.push(last);
          } else {
            totalDataRows++;
            if (previewLines.length < CSV_MAX_PREVIEW_LINES) {
              previewLines.push(last);
            }
          }
        }
        resolve({ previewLines, totalDataRows });
      });

      stream.on("error", reject);
    });
  }

  // -----------------------------------------------------------------------
  // Excel parsing – uses xlsx package (unchanged logic)
  // -----------------------------------------------------------------------

  private async parseExcel(filePath: string): Promise<ParsedContent> {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(readFileSync(filePath), { type: "buffer" });
    const fileSize = statSync(filePath).size;

    const sheets: SheetInfo[] = [];
    let totalRows = 0;

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;

      // Use sheet_to_json with header:1 to get row arrays
      // This avoids NULL bytes that sheet_to_csv/sheet_to_txt may produce
      const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
      const rowCount = jsonData.length;
      totalRows += rowCount;

      const headers = (jsonData[0] ?? []).map((h: any) => String(h ?? "").trim());
      const colCount = headers.length;

      // Extract sample rows (up to 5 rows after header)
      const sampleRows: string[][] = [];
      for (let i = 1; i <= Math.min(5, jsonData.length - 1); i++) {
        sampleRows.push(
          headers.map((_, colIdx) => {
            const val = jsonData[i]?.[colIdx];
            return val != null ? String(val).trim() : "";
          }),
        );
      }

      // Infer data types from sample
      const dataTypes = headers.map((_: string, colIdx: number) => {
        const values = sampleRows.map((r) => r[colIdx]).filter(Boolean);
        if (values.length === 0) return "unknown";
        const allNum = values.every((v) => !isNaN(Number(v)));
        if (allNum) return "number";
        return "text";
      });

      sheets.push({
        name: sheetName,
        rowCount,
        colCount,
        headers,
        sampleRows,
        dataTypes,
      });
    }

    // Always use metadata-only approach — no cell content stored in wiki pages
    const metadataDescription = this.buildMetadataDescription(
      sheets,
      filePath,
      fileSize,
      totalRows,
      "excel",
    );

    return {
      text: metadataDescription,
      metadata: {
        sourceType: "table_native",
        sheetCount: workbook.SheetNames.length,
        sheetNames: workbook.SheetNames,
        totalRows,
        isSmallTable: totalRows <= 1000,
        sheets: sheets.map((s) => ({
          name: s.name,
          rowCount: s.rowCount,
          colCount: s.colCount,
          headers: s.headers,
          sampleRows: s.sampleRows,
          dataTypes: s.dataTypes,
        })),
        filePath,
        fileSize,
      },
      success: true,
      modality: "excel",
    };
  }

  // -----------------------------------------------------------------------
  // Shared metadata description builder
  // -----------------------------------------------------------------------

  /**
   * Build a structured metadata description for the tabular file.
   * This serves as the knowledge base content and provides enough info for Agent to:
   * 1. Determine if the table is relevant to their query
   * 2. Use bash+pandas to analyze the actual data
   */
  private buildMetadataDescription(
    sheets: SheetInfo[],
    filePath: string,
    fileSize: number,
    totalRows: number,
    format: "csv" | "excel",
  ): string {
    // Strip "data/" prefix so the path is relative to the bash tool's CWD
    const relativePath = filePath.startsWith("data/") ? filePath.slice(5) : filePath;
    const parts: string[] = [];

    parts.push("# 表格文件信息");
    parts.push("");
    parts.push(`| 属性 | 值 |`);
    parts.push(`|------|-----|`);
    parts.push(`| 文件路径 | \`${relativePath}\` |`);
    parts.push(`| 文件格式 | ${format === "csv" ? "CSV" : "Excel"} |`);
    parts.push(`| 文件大小 | ${(fileSize / 1024 / 1024).toFixed(2)} MB |`);
    parts.push(`| 工作表数量 | ${sheets.length} |`);
    parts.push(`| 总行数 | ${totalRows.toLocaleString()} |`);
    parts.push(`| 数据规模 | ${totalRows <= 1000 ? "小型（<=1000行）" : "大型（>1000行，请使用 pandas 分析源文件）"} |`);
    parts.push("");

    for (const sheet of sheets) {
      const sectionTitle = format === "csv"
        ? `## 数据表: ${sheet.name}`
        : `## 工作表: ${sheet.name}`;
      parts.push(sectionTitle);
      parts.push("");
      parts.push(`- 行数: ${sheet.rowCount.toLocaleString()}`);
      parts.push(`- 列数: ${sheet.colCount}`);
      parts.push("");

      if (sheet.headers.length > 0) {
        parts.push("### 列定义");
        parts.push("");
        parts.push("| 列名 | 数据类型 |");
        parts.push("|------|---------|");
        for (let i = 0; i < sheet.headers.length; i++) {
          parts.push(`| ${sheet.headers[i]} | ${sheet.dataTypes[i] || "unknown"} |`);
        }
        parts.push("");
      }

      if (sheet.sampleRows.length > 0) {
        parts.push("### 样本数据（前5行）");
        parts.push("");
        // Header row
        parts.push("| " + sheet.headers.join(" | ") + " |");
        parts.push("| " + sheet.headers.map(() => "---").join(" | ") + " |");
        // Sample rows
        for (const row of sheet.sampleRows) {
          const cells = sheet.headers.map((_, i) => row[i] ?? "");
          parts.push("| " + cells.join(" | ") + " |");
        }
        parts.push("");
      }

      // Pandas code snippet – use read_csv or read_excel depending on format
      const pandasRead = format === "csv"
        ? `pd.read_csv('${relativePath}')`
        : `pd.read_excel('${relativePath}', sheet_name='${sheet.name}')`;
      parts.push(`> Agent 可通过 \`bash\` 工具使用 Python + pandas 读取源文件进行分析：`);
      parts.push(`> \`\`\`python`);
      parts.push(`> import pandas as pd`);
      parts.push(`> df = ${pandasRead}`);
      parts.push(`> print(df.head())`);
      parts.push(`> \`\`\``);
      parts.push("");
    }

    return parts.join("\n");
  }
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/**
 * Detect the most likely delimiter for a CSV line by counting occurrences
 * of common delimiters.
 */
function detectDelimiter(line: string): string {
  const candidates = [",", "\t", ";", "|"];
  let best = ",";
  let bestCount = 0;
  for (const d of candidates) {
    const count = (line.match(new RegExp(d === "|" ? "\\|" : escapeRegex(d), "g")) || []).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/**
 * Parse a single CSV line handling basic double-quote escaping.
 * This is intentionally simple — we only need headers and sample rows.
 */
function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        result.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
