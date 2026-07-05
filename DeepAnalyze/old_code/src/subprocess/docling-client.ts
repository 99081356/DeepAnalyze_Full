/**
 * Docling client – thin convenience wrapper around SubprocessManager
 * for communicating with the Python Docling service.
 *
 * Usage:
 *   const mgr = new SubprocessManager();
 *   await startDocling(baseDir, mgr);
 *   const result = await parseWithDocling(mgr, "/path/to/file.pdf");
 *   await mgr.stopAll();
 */

import { SubprocessManager } from "./manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParseResult {
  content: string;
  tables: Array<{ data: string; page: number | null }>;
  images: Array<{ caption: string | null; page: number | null }>;
  metadata: Record<string, unknown>;
  raw?: Record<string, unknown>;
  doctags?: string;
  doctagsAvailable?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the Docling Python subprocess.
 *
 * @param baseDir  Project root directory (docling-service/ is expected
 *                 to live directly under this directory).
 * @param mgr      SubprocessManager instance.
 */
export async function startDocling(baseDir: string, mgr: SubprocessManager): Promise<void> {
  const separator = baseDir.endsWith("/") ? "" : "/";
  const servicePath = `${baseDir}${separator}docling-service`;

  // Set HF_ENDPOINT for HuggingFace model downloads if not already set.
  // When HF_ENDPOINT is explicitly set to empty string (air-gapped mode),
  // skip setting a default to prevent download attempts.
  if (process.env.HF_ENDPOINT === undefined) {
    process.env.HF_ENDPOINT = "https://hf-mirror.com";
  }

  await mgr.start("docling", ["python3", "main.py"], servicePath);
}

/**
 * Send a document to the Docling subprocess for parsing.
 *
 * @param mgr      SubprocessManager with a running "docling" process.
 * @param filePath Absolute path to the document to parse.
 * @param options  Optional parsing options (e.g. { ocr: true, extract_tables: true }).
 * @returns        Parsed document data.
 * @throws         Error if the Python service returns a non-ok status.
 */
export async function parseWithDocling(
  mgr: SubprocessManager,
  filePath: string,
  options?: Record<string, unknown>,
): Promise<ParseResult> {
  const result = await mgr.send("docling", {
    file_path: filePath,
    options: options ?? {},
  });

  if (result.status === "error") {
    throw new Error(result.error ?? "Unknown Docling error");
  }

  return result.data as ParseResult;
}
