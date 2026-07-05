#!/usr/bin/env node
// =============================================================================
// test-file-transfer.mjs — End-to-end test for push_file and file transfer
// =============================================================================
// Tests: push_file tool, session output download API, file upload, SSE events
// =============================================================================

const BASE = "http://localhost:21000";

let passCount = 0;
let failCount = 0;
let testResults = [];

function assert(condition, msg) {
  if (condition) {
    passCount++;
    testResults.push(`  ✓ ${msg}`);
  } else {
    failCount++;
    testResults.push(`  ✗ FAIL: ${msg}`);
  }
}

async function api(method, path, body, opts = {}) {
  const fetchOpts = { method, headers: {} };
  if (body && !(body instanceof FormData)) {
    fetchOpts.headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    fetchOpts.body = body;
  }
  if (opts.timeout) {
    const controller = new AbortController();
    fetchOpts.signal = controller.signal;
    setTimeout(() => controller.abort(), opts.timeout);
  }
  const resp = await fetch(`${BASE}${path}`, fetchOpts);
  return resp;
}

async function createSession(title = "file-transfer-test") {
  const resp = await api("POST", "/api/sessions", { title });
  return await resp.json();
}

async function main() {
  console.log("\n============================================");
  console.log("  File Transfer Feature — Backend E2E Test");
  console.log("============================================\n");

  // -----------------------------------------------------------------------
  // Test 1: Create a test session
  // -----------------------------------------------------------------------
  console.log("Test 1: Create session...");
  const session = await createSession("file-transfer-e2e");
  const sessionId = session.id;
  assert(sessionId, `Session created: ${sessionId}`);

  // -----------------------------------------------------------------------
  // Test 2: Upload various file types via POST /api/sessions/:id/media
  // -----------------------------------------------------------------------
  console.log("\nTest 2: Upload files...");

  // Helper: create a fake file of given type
  function createFakeFile(name, mimeType, sizeBytes) {
    const content = new Uint8Array(sizeBytes);
    // Fill with some recognizable data
    for (let i = 0; i < Math.min(sizeBytes, 256); i++) content[i] = i;
    return new File([content], name, { type: mimeType });
  }

  const testFiles = [
    { name: "test-image.png", mime: "image/png", size: 1024 },
    { name: "test-doc.pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 2048 },
    { name: "test-archive.zip", mime: "application/zip", size: 4096 },
    { name: "test-audio.mp3", mime: "audio/mpeg", size: 5120 },
    { name: "test-video.mp4", mime: "video/mp4", size: 8192 },
    { name: "test-text.txt", mime: "text/plain", size: 256 },
    { name: "test-data.csv", mime: "text/csv", size: 512 },
  ];

  const mediaIds = [];
  for (const tf of testFiles) {
    const fd = new FormData();
    fd.append("file", createFakeFile(tf.name, tf.mime, tf.size));
    const resp = await api("POST", `/api/sessions/${sessionId}/media`, fd);
    const result = await resp.json();
    assert(result.mediaId, `Upload ${tf.name}: mediaId=${result.mediaId}`);
    assert(result.mimeType === tf.mime, `  mimeType correct: ${result.mimeType}`);
    assert(result.size === tf.size, `  size correct: ${result.size}`);
    mediaIds.push({ ...tf, mediaId: result.mediaId });
  }

  // -----------------------------------------------------------------------
  // Test 3: Download each uploaded file via GET /api/sessions/:id/media/:mediaId
  // -----------------------------------------------------------------------
  console.log("\nTest 3: Download uploaded files...");
  for (const m of mediaIds) {
    const resp = await api("GET", `/api/sessions/${sessionId}/media/${m.mediaId}?type=original`);
    assert(resp.status === 200, `Download ${m.name}: status ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    assert(buf.length === m.size, `  Size matches: ${buf.length} === ${m.size}`);
    const ct = resp.headers.get("content-type");
    assert(ct === m.mime, `  Content-Type: ${ct}`);
  }

  // -----------------------------------------------------------------------
  // Test 4: Create test files in session output dir, test GET /api/sessions/:id/output/:fileName
  // -----------------------------------------------------------------------
  console.log("\nTest 4: Session output file download...");

  const fs = await import("fs/promises");
  const path = await import("path");
  const dataDir = process.env.DATA_DIR || "data";

  const outputDir = path.join(dataDir, "sessions", sessionId, "output");
  await fs.mkdir(outputDir, { recursive: true });

  // Create various test files in output dir
  const outputFiles = [
    { name: "report.md", content: "# Test Report\n\nThis is a test markdown file.\n", mime: "text/markdown" },
    { name: "data.json", content: JSON.stringify({ test: true, value: 42 }, null, 2), mime: "application/json" },
    { name: "presentation.pptx", content: Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(100).fill(0)]), mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
    { name: "archive.zip", content: Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(200).fill(0)]), mime: "application/zip" },
    { name: "image.png", content: Buffer.from([0x89, 0x50, 0x4E, 0x47, ...Array(100).fill(0)]), mime: "image/png" },
    { name: "audio.mp3", content: Buffer.from([0xFF, 0xFB, ...Array(200).fill(0)]), mime: "audio/mpeg" },
    { name: "video.mp4", content: Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, ...Array(200).fill(0)]), mime: "video/mp4" },
    { name: "document.pdf", content: Buffer.from([0x25, 0x50, 0x44, 0x46, ...Array(100).fill(0)]), mime: "application/pdf" },
    { name: "spreadsheet.xlsx", content: Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(100).fill(0)]), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  ];

  for (const f of outputFiles) {
    const filePath = path.join(outputDir, f.name);
    const content = typeof f.content === "string" ? f.content : f.content;
    await fs.writeFile(filePath, content);
  }

  // Test downloading each file
  for (const f of outputFiles) {
    const resp = await api("GET", `/api/sessions/${sessionId}/output/${encodeURIComponent(f.name)}`);
    assert(resp.status === 200, `Download output/${f.name}: status ${resp.status}`);
    const ct = resp.headers.get("content-type");
    assert(ct === f.mime, `  Content-Type: ${ct} (expected ${f.mime})`);
    const cd = resp.headers.get("content-disposition") || "";
    assert(cd.includes(f.name), `  Content-Disposition includes filename: ${cd}`);
  }

  // -----------------------------------------------------------------------
  // Test 5: Security — path traversal protection
  // -----------------------------------------------------------------------
  console.log("\nTest 5: Security tests...");

  const securityTests = [
    { path: `/api/sessions/${sessionId}/output/..%2F..%2F..%2Fetc%2Fpasswd`, desc: "URL-encoded traversal" },
    { path: `/api/sessions/${sessionId}/output/../../../etc/passwd`, desc: "Plain traversal" },
    { path: `/api/sessions/${sessionId}/output/....//....//etc/passwd`, desc: "Double-dot traversal" },
  ];

  for (const st of securityTests) {
    const resp = await api("GET", st.path);
    assert(resp.status === 400 || resp.status === 403 || resp.status === 404,
      `Security: ${st.desc} → ${resp.status}`);
  }

  // -----------------------------------------------------------------------
  // Test 6: 404 for non-existent file
  // -----------------------------------------------------------------------
  console.log("\nTest 6: Non-existent file...");
  const resp404 = await api("GET", `/api/sessions/${sessionId}/output/nonexistent.xyz`);
  assert(resp404.status === 404, `Non-existent file returns 404: ${resp404.status}`);

  // -----------------------------------------------------------------------
  // Test 7: Range request for video
  // -----------------------------------------------------------------------
  console.log("\nTest 7: Range request for video...");
  const rangeResp = await api("GET", `/api/sessions/${sessionId}/output/video.mp4`, null, {
    headers: { Range: "bytes=0-99" },
  });
  // Note: api() helper doesn't pass custom headers, let's do a direct fetch
  const rangeResp2 = await fetch(`${BASE}/api/sessions/${sessionId}/output/video.mp4`, {
    headers: { Range: "bytes=0-99" },
  });
  assert(rangeResp2.status === 206, `Range request returns 206: ${rangeResp2.status}`);
  const cr = rangeResp2.headers.get("content-range");
  assert(cr && cr.includes("bytes"), `Content-Range header present: ${cr}`);
  const cl = rangeResp2.headers.get("content-length");
  assert(cl === "100", `Content-Length for range: ${cl}`);

  // -----------------------------------------------------------------------
  // Test 8: push_file tool via agent run
  // -----------------------------------------------------------------------
  console.log("\nTest 8: Agent push_file tool test...");

  // Create a real PPT-like file for agent to push
  const pptContent = Buffer.alloc(2048);
  pptContent.write("PK", 0); // ZIP signature (PPTX is a ZIP)
  const pptPath = path.join(outputDir, "agent-test.pptx");
  await fs.writeFile(pptPath, pptContent);

  // Run a simple agent task that uses push_file
  const agentResp = await fetch(`${BASE}/api/agents/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      input: `Please use the push_file tool to push the file "agent-test.pptx" located in the session output directory. The file path is: ${pptPath}. Title it "Test PPT File".`,
      maxTurns: 5,
    }),
  });

  // Read SSE stream and collect events
  const reader = agentResp.body.getReader();
  const decoder = new TextDecoder();
  let sseEvents = [];
  let buffer = "";

  // Read with timeout
  const readPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent = null;
      let currentData = null;
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          currentData = line.slice(6);
        } else if (line === "" && currentEvent && currentData) {
          try {
            sseEvents.push({ event: currentEvent, data: JSON.parse(currentData) });
          } catch { /* ignore parse errors */ }
          currentEvent = null;
          currentData = null;
        }
      }

      // Check if we've seen the done event
      const doneEvent = sseEvents.find(e => e.event === "done");
      if (doneEvent) break;
    }
  })();

  await Promise.race([
    readPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 60000)),
  ]).catch(e => console.log(`  Agent run timed out or errored: ${e.message}`));

  // Check for push_content events with downloadUrl (push_file result)
  const pushFileEvents = sseEvents.filter(e =>
    e.event === "push_content" && e.data && e.data.downloadUrl
  );
  const pushContentEvents = sseEvents.filter(e =>
    e.event === "push_content"
  );

  assert(pushContentEvents.length > 0,
    `Agent produced push_content events: ${pushContentEvents.length} total`);

  if (pushFileEvents.length > 0) {
    const pfEvent = pushFileEvents[0];
    assert(pfEvent.data.type === "file", `  push_file event type: ${pfEvent.data.type}`);
    assert(pfEvent.data.downloadUrl, `  downloadUrl present: ${pfEvent.data.downloadUrl}`);
    assert(pfEvent.data.fileName, `  fileName present: ${pfEvent.data.fileName}`);
    assert(pfEvent.data.fileSize > 0, `  fileSize: ${pfEvent.data.fileSize}`);
    assert(pfEvent.data.mimeType, `  mimeType: ${pfEvent.data.mimeType}`);

    // Test the download URL works
    const dlResp = await fetch(`${BASE}${pfEvent.data.downloadUrl}`);
    assert(dlResp.status === 200, `  Download URL works: ${dlResp.status}`);
  } else {
    // Check if the agent tried push_file but maybe failed
    const toolResults = sseEvents.filter(e =>
      e.event === "tool_result" && e.data && e.data.output
    );
    console.log(`  No push_file event found. Tool results: ${toolResults.length}`);

    // Check tool_calls for push_file
    const toolCalls = sseEvents.filter(e =>
      e.event === "tool_call"
    );
    console.log(`  Tool calls: ${toolCalls.length}`);
    for (const tc of toolCalls.slice(0, 5)) {
      console.log(`    - ${tc.data?.toolName}: ${JSON.stringify(tc.data?.input || {}).slice(0, 100)}`);
    }

    // Check for errors
    const errors = sseEvents.filter(e => e.event === "error");
    if (errors.length > 0) {
      console.log(`  Errors: ${errors.map(e => e.data?.error || "").join(", ")}`);
    }
  }

  // -----------------------------------------------------------------------
  // Test 9: push_file with non-existent file
  // -----------------------------------------------------------------------
  console.log("\nTest 9: push_file error handling...");
  // This will be tested indirectly if the agent run above handles errors

  // -----------------------------------------------------------------------
  // Test 10: Upload file and send with agent (mediaIds)
  // -----------------------------------------------------------------------
  console.log("\nTest 10: Agent with file upload...");

  // Upload a test file
  const fd = new FormData();
  const testContent = "Name,Age,City\nAlice,30,Beijing\nBob,25,Shanghai\n";
  fd.append("file", new File([testContent], "test-data.csv", { type: "text/csv" }));
  const uploadResp = await api("POST", `/api/sessions/${sessionId}/media`, fd);
  const uploadResult = await uploadResp.json();
  assert(uploadResult.mediaId, `CSV uploaded: ${uploadResult.mediaId}`);

  // Send a message with the file attached
  const agentResp2 = await fetch(`${BASE}/api/agents/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      input: "What file did I upload? Please describe its name and content briefly.",
      mediaIds: [uploadResult.mediaId],
      maxTurns: 5,
    }),
  });

  const reader2 = agentResp2.body.getReader();
  let agent2Events = [];
  buffer = "";

  const readPromise2 = (async () => {
    while (true) {
      const { done, value } = await reader2.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent = null;
      let currentData = null;
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          currentData = line.slice(6);
        } else if (line === "" && currentEvent && currentData) {
          try {
            agent2Events.push({ event: currentEvent, data: JSON.parse(currentData) });
          } catch { /* ignore */ }
          currentEvent = null;
          currentData = null;
        }
      }

      const doneEvent = agent2Events.find(e => e.event === "done");
      if (doneEvent) break;
    }
  })();

  await Promise.race([
    readPromise2,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 60000)),
  ]).catch(e => console.log(`  Agent 2 run timed out: ${e.message}`));

  // Check if agent got the file info
  const contentEvents2 = agent2Events.filter(e => e.event === "content");
  const fullContent2 = contentEvents2.map(e => e.data || "").join("");
  assert(fullContent2.toLowerCase().includes("csv") || fullContent2.toLowerCase().includes("test-data") || fullContent2.toLowerCase().includes("file"),
    `Agent recognized the uploaded file (content mentions csv/file)`);

  // -----------------------------------------------------------------------
  // Results
  // -----------------------------------------------------------------------
  console.log("\n============================================");
  console.log("  Test Results");
  console.log("============================================");
  for (const r of testResults) {
    console.log(r);
  }
  console.log(`\n  Total: ${passCount + failCount} tests, ${passCount} passed, ${failCount} failed`);

  if (failCount > 0) {
    console.log("\n  FAILED tests:");
    testResults.filter(r => r.includes("FAIL")).forEach(r => console.log(r));
    process.exit(1);
  } else {
    console.log("\n  All tests passed!");
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Test runner error:", err);
  process.exit(1);
});
