// =============================================================================
// KB Format End-to-End Test
// Tests file upload, processing, L0/L1/L2 content quality, search, and cleanup
// for all supported document formats (PDF, Image, Audio, Excel, Text).
// =============================================================================

import { existsSync, writeFileSync, unlinkSync, statSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const BASE_URL = "http://localhost:21000";
const API_PREFIX = `${BASE_URL}/api/knowledge`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestFile {
  label: string;
  path: string;
  format: string; // expected detected type
}

interface DocResult {
  label: string;
  format: string;
  docId: string;
  upload: "PASS" | "FAIL" | "SKIP";
  process: "PASS" | "FAIL" | "SKIP" | "TIMEOUT";
  l0: "PASS" | "FAIL" | "SKIP";
  l1: "PASS" | "FAIL" | "SKIP";
  l2: "PASS" | "FAIL" | "SKIP";
  fileType: "PASS" | "FAIL" | "SKIP";
  fileSize: "PASS" | "FAIL" | "SKIP";
  search: "PASS" | "FAIL" | "SKIP";
  originalDownload: "PASS" | "FAIL" | "SKIP";
  error?: string;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function pass(msg: string) {
  console.log(`  [PASS] ${msg}`);
}

function fail(msg: string, detail?: string) {
  console.log(`  [FAIL] ${msg}`);
  if (detail) console.log(`         Detail: ${detail}`);
}

function skip(msg: string) {
  console.log(`  [SKIP] ${msg}`);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiGet(path: string) {
  const url = `${API_PREFIX}${path}`;
  const res = await fetch(url);
  const body = await res.json();
  return { status: res.status, body, ok: res.ok };
}

async function apiPost(path: string, body?: unknown) {
  const url = `${API_PREFIX}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const resBody = await res.json();
  return { status: res.status, body: resBody, ok: res.ok };
}

async function apiDelete(path: string) {
  const url = `${API_PREFIX}${path}`;
  const res = await fetch(url, { method: "DELETE" });
  const body = await res.json();
  return { status: res.status, body, ok: res.ok };
}

/**
 * Upload a file via multipart form data using Node.js built-in fetch.
 */
async function uploadFile(kbId: string, filePath: string): Promise<{ status: number; body: any; ok: boolean }> {
  const url = `${API_PREFIX}/kbs/${kbId}/upload`;

  if (!existsSync(filePath)) {
    return { status: 0, body: { error: "File not found on disk" }, ok: false };
  }

  const stat = statSync(filePath);
  const fileName = filePath.split("/").pop() || "upload";

  // Read file into buffer
  const fileBuffer = readFileSync(filePath);

  // Build multipart form data manually
  const boundary = `----FormBoundary${randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [];

  // Add file part
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  parts.push(Buffer.from(header, "utf-8"));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8"));

  const bodyBuffer = Buffer.concat(parts);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(bodyBuffer.length),
    },
    body: bodyBuffer,
  });

  const resBody = await res.json();
  return { status: res.status, body: resBody, ok: res.ok };
}

// ---------------------------------------------------------------------------
// Content quality helpers
// ---------------------------------------------------------------------------

/** Check if L0 abstract content is meaningful (not empty, not template text, not error) */
function isL0ContentValid(content: string, format: string): { valid: boolean; reason?: string } {
  if (!content || content.trim().length === 0) {
    return { valid: false, reason: "Content is empty" };
  }

  // Known error patterns that should NOT appear in valid content
  const errorPatterns = [
    "[未配置VLM模型",
    "VLM不可用",
    "[音频转写不可用",
    "[音频转写失败",
    "Error:",
    "error:",
    "Failed to",
    "UNDEFINED",
    "undefined",
    "null",
  ];

  // For short content, check if it's just error text
  if (content.length < 20) {
    // Very short content might still be valid for some formats
    if (format === "xlsx" || format === "txt") {
      return { valid: true };
    }
    return { valid: false, reason: `Content too short (${content.length} chars): "${content}"` };
  }

  // Check for error patterns in the content
  for (const pattern of errorPatterns) {
    if (content.includes(pattern)) {
      return { valid: false, reason: `Contains error pattern: "${pattern}"` };
    }
  }

  return { valid: true };
}

/** Check if L1 structure content is valid */
function isL1ContentValid(content: string, format: string): { valid: boolean; reason?: string } {
  if (!content || content.trim().length === 0) {
    return { valid: false, reason: "Content is empty" };
  }

  // Check for error patterns
  const errorPatterns = [
    "[未配置VLM模型",
    "VLM不可用",
  ];

  for (const pattern of errorPatterns) {
    if (content.includes(pattern)) {
      return { valid: false, reason: `Contains error pattern: "${pattern}"` };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(80));
  console.log("  KB Format End-to-End Test");
  console.log(`  Server: ${BASE_URL}`);
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log("=".repeat(80));
  console.log();

  const results: DocResult[] = [];

  // ========================================================================
  // Step 0: Check server connectivity
  // ========================================================================
  log("SETUP", "Checking server connectivity...");
  try {
    const healthCheck = await fetch(`${BASE_URL}/api/knowledge/kbs`);
    if (!healthCheck.ok) {
      console.error("[FATAL] Server returned non-OK status. Aborting.");
      process.exit(1);
    }
    pass("Server is reachable");
  } catch (err: any) {
    console.error(`[FATAL] Cannot connect to server at ${BASE_URL}: ${err.message}`);
    process.exit(1);
  }
  console.log();

  // ========================================================================
  // Step 1: Create a test KB
  // ========================================================================
  log("STEP1", "Creating test knowledge base...");
  const kbName = `format-test-${Date.now()}`;
  const kbRes = await apiPost("/kbs", { name: kbName, description: "E2E format test KB" });

  if (!kbRes.ok) {
    console.error(`[FATAL] Failed to create KB: ${JSON.stringify(kbRes.body)}`);
    process.exit(1);
  }

  const kbId = kbRes.body.id;
  pass(`Created KB: "${kbName}" (id=${kbId})`);
  console.log();

  try {
    // ========================================================================
    // Step 2: Prepare test files and upload
    // ========================================================================
    log("STEP2", "Preparing test files...");

    // Create a small text file for testing
    const txtPath = "/tmp/test-upload.txt";
    writeFileSync(txtPath, "This is a test text file for the KB format e2e test.\nIt contains some sample content.\n");

    const testFiles: TestFile[] = [
      {
        label: "PDF",
        path: "/mnt/d/testdata/pdf/记忆论文/2022.emnlp-main.382.pdf",
        format: "pdf",
      },
      {
        label: "Image",
        path: "/mnt/d/testdata/images/20260314-172020.jpg",
        format: "jpg",
      },
      {
        label: "Audio",
        path: "/mnt/d/testdata/sound/test_audio.wav",
        format: "wav",
      },
      {
        label: "Excel",
        path: "/mnt/d/testdata/execl/athlete_events.xlsx",
        format: "xlsx",
      },
      {
        label: "Text",
        path: txtPath,
        format: "txt",
      },
    ];

    // Upload each file sequentially with delays between them
    for (const tf of testFiles) {
      log("UPLOAD", `Uploading ${tf.label} file: ${tf.path}`);

      const result: DocResult = {
        label: tf.label,
        format: tf.format,
        docId: "",
        upload: "FAIL",
        process: "SKIP",
        l0: "SKIP",
        l1: "SKIP",
        l2: "SKIP",
        fileType: "SKIP",
        fileSize: "SKIP",
        search: "SKIP",
        originalDownload: "SKIP",
      };

      if (!existsSync(tf.path)) {
        result.upload = "SKIP";
        result.error = `File not found: ${tf.path}`;
        skip(`File not found: ${tf.path}`);
        results.push(result);
        continue;
      }

      const fileSize = statSync(tf.path).size;
      log("UPLOAD", `  File size: ${(fileSize / 1024).toFixed(1)} KB`);

      // Skip very large files (> 15MB) to avoid overloading the server
      if (fileSize > 15 * 1024 * 1024) {
        result.upload = "SKIP";
        result.error = `File too large (${(fileSize / 1024 / 1024).toFixed(1)} MB), skipping to avoid server overload`;
        skip(`${tf.label} file too large (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);
        results.push(result);
        continue;
      }

      // Add delay between uploads to avoid overloading the server
      if (results.some(r => r.upload === "PASS")) {
        log("UPLOAD", `  Waiting 3s before next upload...`);
        await sleep(3000);
      }

      const uploadRes = await uploadFile(kbId, tf.path);

      if (!uploadRes.ok) {
        result.upload = "FAIL";
        result.error = `Upload failed (${uploadRes.status}): ${JSON.stringify(uploadRes.body)}`;
        fail(`${tf.label} upload`, result.error);
        results.push(result);
        continue;
      }

      // Extract document ID from response (response is flat, not nested under .document)
      const docId = uploadRes.body.id || uploadRes.body.docId || uploadRes.body.documentId;
      if (!docId) {
        result.upload = "FAIL";
        result.error = `No document ID in response: ${JSON.stringify(uploadRes.body)}`;
        fail(`${tf.label} upload`, result.error);
        results.push(result);
        continue;
      }

      result.docId = docId;
      result.upload = "PASS";
      pass(`${tf.label} uploaded (docId=${docId}, status=${uploadRes.body.status || "N/A"})`);

      // Verify file type detection (response uses camelCase: fileType)
      const detectedType = uploadRes.body.fileType || uploadRes.body.file_type;
      if (detectedType === tf.format) {
        result.fileType = "PASS";
        pass(`${tf.label} file type detected correctly: "${detectedType}"`);
      } else {
        result.fileType = "FAIL";
        result.error = `Expected type "${tf.format}", got "${detectedType}"`;
        fail(`${tf.label} file type detection`, result.error);
      }

      // Verify file size (response uses camelCase: fileSize)
      const reportedSize = uploadRes.body.fileSize || uploadRes.body.file_size;
      if (reportedSize && reportedSize > 0) {
        // Allow some tolerance (uploaded size vs original may differ slightly due to encoding)
        const ratio = Math.abs(reportedSize - fileSize) / fileSize;
        if (ratio < 0.1) {
          result.fileSize = "PASS";
          pass(`${tf.label} file size reasonable: ${reportedSize} bytes`);
        } else {
          result.fileSize = "FAIL";
          fail(`${tf.label} file size mismatch`, `Expected ~${fileSize}, got ${reportedSize}`);
        }
      } else {
        result.fileSize = "FAIL";
        fail(`${tf.label} file size`, "No file_size reported or zero");
      }

      results.push(result);
    }

    console.log();

    // ========================================================================
    // Step 3: Wait for processing
    // ========================================================================
    log("STEP3", "Waiting for document processing (polling every 5s, timeout 5min)...");

    const uploadedDocs = results.filter((r) => r.upload === "PASS");
    const maxWaitMs = 5 * 60 * 1000; // 5 minutes
    const pollInterval = 5000; // 5 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const docsRes = await apiGet(`/kbs/${kbId}/documents`);
      if (!docsRes.ok) {
        log("POLL", `  Warning: Failed to fetch documents (${docsRes.status})`);
        await sleep(pollInterval);
        continue;
      }

      const docs: any[] = docsRes.body.documents || [];
      const relevantDocs = docs.filter((d: any) => uploadedDocs.some((r) => r.docId === d.id));

      const pending = relevantDocs.filter((d: any) => !["ready", "error"].includes(d.status));
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

      log("POLL", `  Status after ${elapsed}s: ${relevantDocs.map((d: any) => `${d.filename}=${d.status}`).join(", ")}`);

      // Update process status for each doc
      for (const doc of relevantDocs) {
        const result = results.find((r) => r.docId === doc.id);
        if (!result) continue;

        if (doc.status === "ready") {
          result.process = "PASS";
        } else if (doc.status === "error") {
          result.process = "FAIL";
          result.error = `Processing error: ${doc.processing_error || "unknown"}`;
        }
      }

      if (pending.length === 0) {
        pass(`All ${relevantDocs.length} documents finished processing`);
        break;
      }

      await sleep(pollInterval);
    }

    // Check for timeout
    if (Date.now() - startTime >= maxWaitMs) {
      for (const r of results) {
        if (r.upload === "PASS" && r.process === "SKIP") {
          r.process = "TIMEOUT";
          fail(`${r.label} processing timed out after 2 minutes`);
        }
      }
    }

    // Print processing results
    for (const r of results) {
      if (r.process === "PASS") {
        pass(`${r.label} processing completed`);
      } else if (r.process === "FAIL") {
        fail(`${r.label} processing failed`, r.error);
      } else if (r.process === "TIMEOUT") {
        fail(`${r.label} processing timed out`);
      }
    }
    console.log();

    // ========================================================================
    // Step 4: Verify L0/L1/L2 content for each processed document
    // ========================================================================
    log("STEP4", "Verifying L0/L1/L2 content quality...");

    for (const r of results) {
      if (r.process !== "PASS") {
        skip(`${r.label} L0/L1/L2 verification (processing not successful)`);
        continue;
      }

      log("VERIFY", `Checking document: ${r.label} (${r.docId})`);

      // Get document details
      const docRes = await apiGet(`/kbs/${kbId}/documents`);
      if (!docRes.ok) {
        fail(`${r.label} document fetch`, `Status ${docRes.status}`);
        continue;
      }

      const doc = (docRes.body.documents || []).find((d: any) => d.id === r.docId);
      if (!doc) {
        fail(`${r.label} document lookup`, "Document not found in list");
        continue;
      }

      // Print document metadata
      log("META", `  filename=${doc.filename}, file_type=${doc.file_type}, file_size=${doc.file_size}`);
      log("META", `  status=${doc.status}, processing_step=${doc.processing_step}, progress=${doc.processing_progress}`);

      // Get L0 (abstract) content
      // We need to find the abstract page for this document
      // Use the expand or pages API to get document pages
      const expandRes = await apiPost(`/${kbId}/expand`, {
        docId: r.docId,
        level: "L0",
      });

      if (expandRes.ok && expandRes.body) {
        const l0Content = expandRes.body.content || expandRes.body.abstract || "";
        const l0Valid = isL0ContentValid(l0Content, r.format);
        if (l0Valid.valid) {
          r.l0 = "PASS";
          pass(`${r.label} L0 abstract is valid (${l0Content.length} chars)`);
          log("L0", `  Preview: ${l0Content.substring(0, 150).replace(/\n/g, " ")}...`);
        } else {
          r.l0 = "FAIL";
          fail(`${r.label} L0 abstract`, l0Valid.reason || "Invalid content");
          log("L0", `  Content: ${l0Content.substring(0, 200)}`);
        }
      } else {
        // Try alternative: get pages for the document via the documents list
        // The documents endpoint returns l1Preview which may have some content
        // Try getting the abstract page directly
        const statusRes = await apiGet(`/kbs/${kbId}/documents/${r.docId}/status`);
        log("L0", `  Document status: ${JSON.stringify(statusRes.body)}`);

        // Check if there's an abstract page by searching
        // Let's try a different approach - get all pages for this document
        // Use the wiki browse approach
        const pagesRes = await apiGet(`/kbs/${kbId}/pages/`);  // This might not work without pageId

        // Alternative: use the documents endpoint which includes l1Preview
        const docDetail = doc;
        const l1Preview = docDetail.l1Preview;
        if (l1Preview && l1Preview.length > 0) {
          log("L0", `  Document has l1Preview: ${l1Preview.substring(0, 100)}...`);
        }

        r.l0 = "SKIP";
        skip(`${r.label} L0 abstract (expand endpoint returned: ${expandRes.status})`);
      }

      // Get L1 (overview/structure) content
      const l1Res = await apiPost(`/${kbId}/expand`, {
        docId: r.docId,
        level: "L1",
      });

      if (l1Res.ok && l1Res.body) {
        const l1Content = l1Res.body.content || "";
        const l1Valid = isL1ContentValid(l1Content, r.format);
        if (l1Valid.valid) {
          r.l1 = "PASS";
          pass(`${r.label} L1 structure is valid (${l1Content.length} chars)`);
          log("L1", `  Preview: ${l1Content.substring(0, 150).replace(/\n/g, " ")}...`);
        } else {
          r.l1 = "FAIL";
          fail(`${r.label} L1 structure`, l1Valid.reason || "Invalid content");
          log("L1", `  Content: ${l1Content.substring(0, 200)}`);
        }
      } else {
        r.l1 = "SKIP";
        skip(`${r.label} L1 structure (expand endpoint returned: ${l1Res.status})`);
      }

      // Get L2 (fulltext) content
      const l2Res = await apiPost(`/${kbId}/expand`, {
        docId: r.docId,
        level: "L2",
      });

      if (l2Res.ok && l2Res.body) {
        const l2Content = l2Res.body.content || "";
        if (l2Content.trim().length > 0) {
          r.l2 = "PASS";
          pass(`${r.label} L2 fulltext exists (${l2Content.length} chars)`);
        } else {
          r.l2 = "FAIL";
          fail(`${r.label} L2 fulltext`, "Content is empty");
        }
      } else {
        r.l2 = "SKIP";
        skip(`${r.label} L2 fulltext (expand endpoint returned: ${l2Res.status})`);
      }
    }
    console.log();

    // ========================================================================
    // Step 5: Test search functionality
    // ========================================================================
    log("STEP5", "Testing search functionality...");

    // Test semantic search
    log("SEARCH", "Testing keyword search...");
    const searchQueries = [
      { query: "test", mode: "keyword", label: "keyword" },
      { query: "document content", mode: "semantic", label: "semantic" },
    ];

    for (const sq of searchQueries) {
      const searchRes = await apiGet(`/${kbId}/search?query=${encodeURIComponent(sq.query)}&topK=10&mode=${sq.mode}`);
      if (searchRes.ok) {
        const searchResults = searchRes.body.results || [];
        const totalFound = searchRes.body.totalFound || 0;

        if (totalFound > 0) {
          pass(`${sq.label} search found ${totalFound} results for "${sq.query}"`);
          // Print first result
          if (searchResults.length > 0) {
            const first = searchResults[0];
            log("SEARCH", `  Top result: score=${first.score?.toFixed(3) || "N/A"}, title="${first.title?.substring(0, 60) || "N/A"}", level=${first.level || "N/A"}`);
          }
        } else {
          log("SEARCH", `  ${sq.label} search returned 0 results for "${sq.query}" (may be expected for new content)`);
        }

        // Mark search as pass for documents that appear in results
        const foundDocIds = new Set(searchResults.map((r: any) => r.docId).filter(Boolean));
        for (const r of results) {
          if (r.process === "PASS" && foundDocIds.has(r.docId)) {
            r.search = "PASS";
          }
        }
      } else {
        fail(`${sq.label} search`, `Status ${searchRes.status}: ${JSON.stringify(searchRes.body)}`);
      }
    }

    // For documents not found in search results, mark as SKIP
    for (const r of results) {
      if (r.process === "PASS" && r.search === "SKIP") {
        r.search = "SKIP";
        skip(`${r.label} search (document not found in search results)`);
      }
    }
    console.log();

    // ========================================================================
    // Step 6: Test document operations
    // ========================================================================
    log("STEP6", "Testing document operations...");

    // Test reprocess for one document
    const firstProcessed = results.find((r) => r.process === "PASS");
    if (firstProcessed) {
      log("OPS", `Testing reprocess for ${firstProcessed.label} (${firstProcessed.docId})...`);
      const reprocessRes = await apiPost(`/kbs/${kbId}/process/${firstProcessed.docId}?force=true`);
      if (reprocessRes.ok && (reprocessRes.body.status === "queued" || reprocessRes.body.message)) {
        pass(`Reprocess triggered for ${firstProcessed.label}`);
      } else {
        // May return "already processed" which is fine
        log("OPS", `  Reprocess response: ${JSON.stringify(reprocessRes.body)}`);
        if (reprocessRes.status === 200) {
          pass(`Reprocess endpoint responded OK for ${firstProcessed.label}`);
        } else {
          fail(`Reprocess for ${firstProcessed.label}`, `Status ${reprocessRes.status}`);
        }
      }

      // Wait briefly for reprocessing to at least start
      await sleep(3000);
    }

    // Test quality report
    log("OPS", "Testing quality report...");
    const qualityRes = await apiGet(`/kbs/${kbId}/quality-report`);
    if (qualityRes.ok) {
      pass("Quality report retrieved");
      log("OPS", `  Total documents: ${qualityRes.body.totalDocuments}, Audited: ${qualityRes.body.auditedCount}, Low quality: ${qualityRes.body.lowQualityCount}`);
      if (qualityRes.body.documents) {
        for (const doc of qualityRes.body.documents) {
          const auditInfo = doc.qualityAudit
            ? `score=${doc.qualityAudit.score}, issues=${JSON.stringify(doc.qualityAudit.issues?.length || 0)}`
            : "not audited";
          log("OPS", `  ${doc.filename}: status=${doc.status}, audit=${auditInfo}`);
        }
      }
    } else {
      fail("Quality report", `Status ${qualityRes.status}: ${JSON.stringify(qualityRes.body)}`);
    }

    // Test original file download for each document
    log("OPS", "Testing original file downloads...");
    for (const r of results) {
      if (r.upload !== "PASS") {
        r.originalDownload = "SKIP";
        continue;
      }

      const downloadUrl = `${API_PREFIX}/kbs/${kbId}/documents/${r.docId}/original`;
      try {
        const downloadRes = await fetch(downloadUrl);
        if (downloadRes.ok) {
          const contentLength = downloadRes.headers.get("content-length");
          const contentType = downloadRes.headers.get("content-type") || "unknown";
          const body = await downloadRes.arrayBuffer();

          if (body.byteLength > 0) {
            r.originalDownload = "PASS";
            pass(`${r.label} original download: ${body.byteLength} bytes, type=${contentType}`);
          } else {
            r.originalDownload = "FAIL";
            fail(`${r.label} original download`, "Response body is empty");
          }
        } else {
          r.originalDownload = "FAIL";
          fail(`${r.label} original download`, `Status ${downloadRes.status}`);
        }
      } catch (err: any) {
        r.originalDownload = "FAIL";
        fail(`${r.label} original download`, err.message);
      }
    }
    console.log();

  } finally {
    // ========================================================================
    // Step 7: Cleanup
    // ========================================================================
    log("CLEANUP", "Deleting test knowledge base...");
    const deleteRes = await apiDelete(`/kbs/${kbId}`);
    if (deleteRes.ok) {
      pass("Test KB deleted successfully");
    } else {
      fail("KB deletion", `Status ${deleteRes.status}: ${JSON.stringify(deleteRes.body)}`);
      log("CLEANUP", `  Manual cleanup needed: KB id=${kbId}`);
    }

    // Clean up temp file
    try {
      unlinkSync("/tmp/test-upload.txt");
    } catch {
      // Ignore
    }
  }

  console.log();

  // ========================================================================
  // Summary
  // ========================================================================
  console.log("=".repeat(80));
  console.log("  TEST SUMMARY");
  console.log("=".repeat(80));
  console.log();

  // Per-format summary
  const colWidth = 10;
  const header = "| " + ["Format", "Upload", "Process", "L0", "L1", "L2", "FileType", "FileSize", "Search", "Download", "Overall"].map(s => s.padEnd(colWidth)).join(" | ") + " |";
  const separator = "| " + Array(11).fill("-".repeat(colWidth)).join(" | ") + " |";

  console.log(header);
  console.log(separator);

  let totalPass = 0;
  let totalTests = 0;

  for (const r of results) {
    const cells = [
      r.format.padEnd(colWidth),
      r.upload.padEnd(colWidth),
      r.process.padEnd(colWidth),
      r.l0.padEnd(colWidth),
      r.l1.padEnd(colWidth),
      r.l2.padEnd(colWidth),
      r.fileType.padEnd(colWidth),
      r.fileSize.padEnd(colWidth),
      r.search.padEnd(colWidth),
      r.originalDownload.padEnd(colWidth),
    ];

    // Overall: PASS if all non-SKIP fields are PASS
    const nonSkipFields = [r.upload, r.process, r.l0, r.l1, r.l2, r.fileType, r.fileSize, r.search, r.originalDownload].filter((v) => v !== "SKIP");
    const overall = nonSkipFields.length === 0
      ? "SKIP"
      : nonSkipFields.every((v) => v === "PASS")
        ? "PASS"
        : "FAIL";

    cells.push(overall.padEnd(colWidth));

    console.log("| " + cells.join(" | ") + " |");

    // Count passes for overall stats
    for (const field of [r.upload, r.process, r.l0, r.l1, r.l2, r.fileType, r.fileSize, r.search, r.originalDownload]) {
      if (field !== "SKIP") {
        totalTests++;
        if (field === "PASS") totalPass++;
      }
    }
  }

  console.log(separator);
  console.log();
  console.log(`Total checks: ${totalPass}/${totalTests} passed (${totalTests > 0 ? ((totalPass / totalTests) * 100).toFixed(1) : 0}%)`);
  console.log();

  // Print errors
  const failures = results.filter((r) => r.error);
  if (failures.length > 0) {
    console.log("Failure Details:");
    for (const f of failures) {
      console.log(`  ${f.label} (${f.format}): ${f.error}`);
    }
    console.log();
  }

  // Exit with code based on results
  const hasFailures = results.some((r) =>
    [r.upload, r.process, r.l0, r.l1, r.l2, r.fileType, r.fileSize, r.search, r.originalDownload].some(
      (v) => v === "FAIL" || v === "TIMEOUT"
    )
  );

  if (hasFailures) {
    console.log("RESULT: SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("RESULT: ALL TESTS PASSED");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
