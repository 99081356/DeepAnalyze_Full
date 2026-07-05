import { execFile } from "node:child_process";
import { readFile, stat, unlink } from "node:fs/promises";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { DocumentProcessor, ParsedContent } from "./types.js";
import { DoclingProcessor } from "./docling-processor.js";

const execFileAsync = promisify(execFile);

const CONVERSION_TIMEOUT_MS = 120_000;

/**
 * Converts legacy office formats to modern equivalents using LibreOffice headless,
 * then delegates parsing to DoclingProcessor.
 *
 * Supported conversions:
 *   .doc → .docx   (Word 97-2003)
 *   .rtf → .docx   (Rich Text Format)
 *   .odt → .docx   (OpenDocument Text)
 *   .ppt → .pptx   (PowerPoint 97-2003)
 */
export class DocConverterProcessor implements DocumentProcessor {
  private static readonly HANDLED_TYPES = new Set(["doc", "rtf", "odt", "ppt"]);
  private doclingProcessor = new DoclingProcessor();

  /** Mapping from input extension to LibreOffice conversion target format. */
  private static readonly CONVERT_TARGET: Record<string, string> = {
    doc: "docx",
    rtf: "docx",
    odt: "docx",
    ppt: "pptx",
  };

  canHandle(fileType: string): boolean {
    return DocConverterProcessor.HANDLED_TYPES.has(fileType);
  }

  getStepLabel(): string {
    return "doc_converter";
  }

  async parse(filePath: string): Promise<ParsedContent> {
    // Determine conversion target from extension
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const targetFormat = DocConverterProcessor.CONVERT_TARGET[ext];
    if (!targetFormat) {
      return {
        text: "",
        metadata: { sourceType: "doc_converter" },
        success: false,
        error: `Unsupported input format: .${ext}`,
      };
    }

    // Check if LibreOffice is available
    const libreOfficeBin = await this.findLibreOffice();
    if (!libreOfficeBin) {
      return {
        text: "",
        metadata: { sourceType: "doc_converter" },
        success: false,
        error: "LibreOffice is not installed. Install with: apt-get install -y libreoffice-writer libreoffice-impress",
      };
    }

    // Verify input file exists
    let inputStat;
    try {
      inputStat = await stat(filePath);
    } catch {
      return {
        text: "",
        metadata: { sourceType: "doc_converter" },
        success: false,
        error: `Input file not found: ${filePath}`,
      };
    }

    // Use a unique temp directory to avoid filename collisions
    const tmpDir = `/tmp/doc-convert-${randomUUID()}`;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(tmpDir, { recursive: true });

    try {
      // Convert using LibreOffice headless
      const { stdout, stderr } = await execFileAsync(
        libreOfficeBin,
        ["--headless", "--convert-to", targetFormat, "--outdir", tmpDir, filePath],
        { timeout: CONVERSION_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      );

      if (stderr && !stderr.includes("Warning")) {
        console.warn(`[DocConverter] LibreOffice stderr: ${stderr}`);
      }

      // Locate the converted file
      const inputBasename = filePath.replace(new RegExp(`\\.${ext}$`, "i"), "");
      const inputFilename = inputBasename.split("/").pop()!;
      const convertedPath = join(tmpDir, `${inputFilename}.${targetFormat}`);

      let convertedStat;
      try {
        convertedStat = await stat(convertedPath);
      } catch {
        // Try listing the tmpDir to find the output file
        const { readdir } = await import("node:fs/promises");
        const files = await readdir(tmpDir);
        const targetFile = files.find(f => f.endsWith(`.${targetFormat}`));
        if (!targetFile) {
          return {
            text: "",
            metadata: { sourceType: "doc_converter" },
            success: false,
            error: `LibreOffice conversion produced no .${targetFormat} output. Files in tmpDir: ${files.join(", ")}`,
          };
        }
        // Use the found file
        const result = await this.doclingProcessor.parse(join(tmpDir, targetFile));
        result.metadata = {
          ...result.metadata,
          sourceType: "doc_converter",
          originalFormat: ext,
          convertedVia: "libreoffice",
          originalSizeBytes: inputStat.size,
        };
        return result;
      }

      // Delegate to DoclingProcessor for parsing the converted file
      const result = await this.doclingProcessor.parse(convertedPath);

      // Add conversion metadata
      result.metadata = {
        ...result.metadata,
        sourceType: "doc_converter",
        originalFormat: ext,
        convertedVia: "libreoffice",
        originalSizeBytes: inputStat.size,
        convertedSizeBytes: convertedStat.size,
      };

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        text: "",
        metadata: { sourceType: "doc_converter" },
        success: false,
        error: `LibreOffice conversion failed: ${msg}`,
      };
    } finally {
      // Clean up temp directory
      try {
        const { rm } = await import("node:fs/promises");
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Non-critical
      }
    }
  }

  /**
   * Find the LibreOffice binary path.
   * Checks common locations for both Linux and macOS.
   */
  private async findLibreOffice(): Promise<string | null> {
    const candidates = [
      "libreoffice",
      "/usr/bin/libreoffice",
      "/usr/local/bin/libreoffice",
      "/snap/bin/libreoffice",
      // macOS
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ];

    for (const candidate of candidates) {
      try {
        const { stat } = await import("node:fs/promises");
        if (candidate.includes("/")) {
          await stat(candidate);
          return candidate;
        } else {
          // Check if the command exists via which
          try {
            await execFileAsync("which", [candidate], { timeout: 5000 });
            return candidate;
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
    return null;
  }
}
