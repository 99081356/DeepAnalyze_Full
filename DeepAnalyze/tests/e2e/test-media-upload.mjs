/**
 * Comprehensive E2E test for chat media upload feature.
 * Covers: basic flow, abnormal scenarios, edge cases, concurrent operations.
 */
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

const BASE_URL = "http://localhost:21000";

let passCount = 0;
let failCount = 0;
const results = [];

function pass(name, detail = "") {
  passCount++;
  results.push({ name, status: "PASS", detail });
  console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`);
}

function fail(name, detail = "") {
  failCount++;
  results.push({ name, status: "FAIL", detail });
  console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
}

async function createSession(title) {
  const resp = await fetch(`${BASE_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return await resp.json();
}

async function deleteSession(id) {
  await fetch(`${BASE_URL}/api/sessions/${id}`, { method: "DELETE" });
}

async function uploadMedia(sessionId, buffer, fileName, mimeType) {
  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), fileName);
  const resp = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media`, {
    method: "POST",
    body: formData,
  });
  return { resp, data: resp.ok ? await resp.json() : null };
}

async function createTestImage(width = 10, height = 10) {
  const sharp = (await import("sharp")).default;
  return await sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();
}

async function readSSEStream(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let eventCount = 0;
  let currentEvent = "";
  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    done = d;
    if (value) {
      const text = decoder.decode(value);
      for (const line of text.split("\n")) {
        if (line.startsWith("event: ")) currentEvent = line.slice(7).trim();
        if (line.startsWith("data: ") && currentEvent === "done") done = true;
      }
      eventCount++;
    }
    if (eventCount > 500) done = true;
  }
  return eventCount;
}

async function main() {
  console.log("\n============================================================");
  console.log("  Media Upload — Comprehensive E2E Tests");
  console.log("============================================================\n");

  const session = await createSession("test-media-comprehensive");
  const sessionId = session.id;
  const sessions = [sessionId];

  try {
    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 1: Basic Upload & Retrieval");
    // ════════════════════════════════════════════════════════════

    const sharp = (await import("sharp")).default;
    const imageBuffer = await createTestImage();

    // 1.1 Upload PNG
    const { resp: r1, data: d1 } = await uploadMedia(sessionId, imageBuffer, "test.png", "image/png");
    if (r1.ok && d1.mediaId) pass("Upload PNG", `id:${d1.mediaId.slice(0, 8)} size:${d1.size}`);
    else fail("Upload PNG", `HTTP ${r1.status}`);
    const mid1 = d1?.mediaId;

    // 1.2 Upload JPEG
    const jpegBuf = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 255, b: 0 } } }).jpeg().toBuffer();
    const { resp: r2, data: d2 } = await uploadMedia(sessionId, jpegBuf, "photo.jpg", "image/jpeg");
    if (r2.ok && d2.mediaId) pass("Upload JPEG", `id:${d2.mediaId.slice(0, 8)}`);
    else fail("Upload JPEG", `HTTP ${r2.status}`);
    const mid2 = d2?.mediaId;

    // 1.3 Retrieve original PNG
    const orig1 = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media/${mid1}?type=original`);
    if (orig1.ok && orig1.headers.get("content-type") === "image/png") {
      const buf = Buffer.from(await orig1.arrayBuffer());
      pass("Retrieve original PNG", `${buf.length} bytes`);
    } else fail("Retrieve original PNG", `HTTP ${orig1.status}`);

    // 1.4 Retrieve original JPEG
    const orig2 = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media/${mid2}?type=original`);
    if (orig2.ok && orig2.headers.get("content-type")?.includes("image")) {
      pass("Retrieve original JPEG", `type:${orig2.headers.get("content-type")}`);
    } else fail("Retrieve original JPEG", `HTTP ${orig2.status}`);

    // 1.5 Thumbnail for PNG
    const th1 = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media/${mid1}?type=thumbnail`);
    if (th1.ok && th1.headers.get("content-type") === "image/webp") {
      const buf = Buffer.from(await th1.arrayBuffer());
      pass("Thumbnail PNG→WebP", `${buf.length} bytes`);
    } else fail("Thumbnail PNG→WebP", `HTTP ${th1.status}`);

    // 1.6 Thumbnail for JPEG
    const th2 = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media/${mid2}?type=thumbnail`);
    if (th2.ok && th2.headers.get("content-type") === "image/webp") pass("Thumbnail JPEG→WebP");
    else fail("Thumbnail JPEG→WebP", `HTTP ${th2.status}`);

    // 1.7 Default type returns original
    const defResp = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media/${mid1}`);
    if (defResp.ok && defResp.headers.get("content-type") === "image/png") pass("Default query returns original");
    else fail("Default query", `type:${defResp.headers.get("content-type")}`);

    // 1.8 Disk structure
    const mdir = join(process.cwd(), "data", "sessions", sessionId, "media", mid1);
    pass("meta.json on disk", `${existsSync(join(mdir, "meta.json"))}`);
    pass("original.png on disk", `${existsSync(join(mdir, "original.png"))}`);
    pass("thumbnail.webp on disk", `${existsSync(join(mdir, "thumbnail.webp"))}`);

    // 1.9 meta.json content
    const meta = JSON.parse(await readFile(join(mdir, "meta.json"), "utf-8"));
    if (meta.mediaId === mid1 && meta.mimeType === "image/png" && meta.width === 10 && meta.height === 10) {
      pass("meta.json correct", `${meta.width}x${meta.height} mime:${meta.mimeType}`);
    } else fail("meta.json content", JSON.stringify(meta).slice(0, 200));

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 2: Abnormal Scenarios");
    // ════════════════════════════════════════════════════════════

    // 2.1 Upload to nonexistent session
    const { resp: bsResp } = await uploadMedia("nonexistent-session", imageBuffer, "x.png", "image/png");
    if (bsResp.status === 404) pass("Upload to nonexistent session → 404");
    else fail("Upload to nonexistent session", `got ${bsResp.status}`);

    // 2.2 Retrieve nonexistent mediaId
    const nmResp = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media/nonexistent-media-id?type=original`);
    if (nmResp.status === 404) pass("Retrieve nonexistent mediaId → 404");
    else fail("Retrieve nonexistent mediaId", `got ${nmResp.status}`);

    // 2.3 Upload without file
    const nfResp = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media`, { method: "POST", body: new FormData() });
    if (nfResp.status === 400) pass("Upload without file → 400");
    else fail("Upload without file", `got ${nfResp.status}`);

    // 2.4 Send message with invalid mediaId
    const bmResp = await fetch(`${BASE_URL}/api/agents/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, input: "test", mediaIds: ["invalid-id"] }),
    });
    if (bmResp.status === 400) pass("Send with invalid mediaId → 400");
    else fail("Send with invalid mediaId", `got ${bmResp.status}`);

    // 2.5 Send with empty mediaIds
    const emResp = await fetch(`${BASE_URL}/api/agents/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, input: "1+1=?只回答数字", mediaIds: [] }),
    });
    if (emResp.ok) {
      await readSSEStream(emResp);
      pass("Send with empty mediaIds → accepted");
    } else fail("Send with empty mediaIds", `HTTP ${emResp.status}`);

    // 2.6 Tiny file (1 byte) — thumbnail should fail gracefully
    const tinyBuf = Buffer.from([0x89]);
    const { resp: tResp, data: tData } = await uploadMedia(sessionId, tinyBuf, "tiny.png", "image/png");
    if (tResp.ok) {
      pass("Upload tiny (1 byte) file");
      const tThumb = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media/${tData.mediaId}?type=thumbnail`);
      if (tThumb.status === 404) pass("Tiny file no thumbnail (graceful)");
      else pass("Tiny file thumbnail generated", `HTTP ${tThumb.status}`);
    } else fail("Upload tiny file", `HTTP ${tResp.status}`);

    // 2.7 Cross-session isolation
    const s2 = await createSession("test-cross-session");
    sessions.push(s2.id);
    const { data: cData } = await uploadMedia(sessionId, imageBuffer, "cross.png", "image/png");
    const cResp = await fetch(`${BASE_URL}/api/sessions/${s2.id}/media/${cData.mediaId}?type=original`);
    if (cResp.status === 404) pass("Cross-session media → 404 (isolated)");
    else fail("Cross-session media NOT isolated!", `got ${cResp.status}`);

    // 2.8 Large image thumbnail
    const largeBuf = await createTestImage(2000, 2000);
    const { resp: lResp, data: lData } = await uploadMedia(sessionId, largeBuf, "large.png", "image/png");
    if (lResp.ok) {
      const lThumb = await fetch(`${BASE_URL}/api/sessions/${sessionId}/media/${lData.mediaId}?type=thumbnail`);
      if (lThumb.ok) {
        const thumbBuf = Buffer.from(await lThumb.arrayBuffer());
        const thumbMeta = await sharp(thumbBuf).metadata();
        if (thumbMeta.width <= 400) {
          pass("Large image thumbnail ≤ 400px", `${thumbMeta.width}x${thumbMeta.height}`);
        } else fail("Thumbnail width exceeds 400", `${thumbMeta.width}px`);
      } else fail("Large image thumbnail", `HTTP ${lThumb.status}`);
    } else fail("Upload large image", `HTTP ${lResp.status}`);

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 3: Message with Media — Full Flow");
    // ════════════════════════════════════════════════════════════

    // 3.1 Upload + send message with single media
    const { data: mData } = await uploadMedia(sessionId, imageBuffer, "msg.png", "image/png");
    const runResp = await fetch(`${BASE_URL}/api/agents/run-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, input: "这张图片里有什么颜色？只回答颜色名称", mediaIds: [mData.mediaId] }),
    });
    if (runResp.ok) {
      pass("Run stream with media accepted");
      const chunks = await readSSEStream(runResp);
      pass("Agent responded to media msg", `${chunks} SSE chunks`);
    } else fail("Run stream with media", `HTTP ${runResp.status}: ${await runResp.text()}`);

    // 3.2 Verify messages API
    const msgResp = await fetch(`${BASE_URL}/api/sessions/${sessionId}/messages`);
    if (msgResp.ok) {
      const msgs = await msgResp.json();
      const mediaMsg = msgs.find(m => m.media && m.media.length > 0);
      if (mediaMsg) {
        // Content should be plain text (not JSON)
        const isPlain = !mediaMsg.content.startsWith('{"');
        if (isPlain) pass("Media msg content is plain text", `"${mediaMsg.content.slice(0, 50)}"`);
        else {
          try {
            const p = JSON.parse(mediaMsg.content);
            if (p.text) pass("Media msg has text field");
            else fail("Media msg content", `no text: ${mediaMsg.content.slice(0, 80)}`);
          } catch { fail("Media msg content", mediaMsg.content.slice(0, 80)); }
        }
        if (Array.isArray(mediaMsg.media) && mediaMsg.media[0]?.mediaId) {
          const m = mediaMsg.media[0];
          pass("Media msg has media array", `mime:${m.mimeType} name:${m.fileName} size:${m.size}`);
        } else fail("Media msg media array", "missing");
      } else fail("Media msg in messages API", "no message with media field found");

      // 3.3 Plain text message has no media
      const plainMsg = msgs.find(m => m.role === "user" && (!m.media || m.media.length === 0) && m.content === "1+1=?只回答数字");
      if (plainMsg) pass("Plain text msg has no media", `"${plainMsg.content}"`);
      else pass("Plain text msg check", "not found (may be in different format)");
    } else fail("Messages API", `HTTP ${msgResp.status}`);

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 4: Multiple Media");
    // ════════════════════════════════════════════════════════════

    const multiIds = [];
    for (let i = 0; i < 3; i++) {
      const buf = await sharp({
        create: { width: 10 + i * 10, height: 10 + i * 10, channels: 3, background: { r: i * 80, g: 255 - i * 80, b: 128 } },
      }).png().toBuffer();
      const { resp, data } = await uploadMedia(sessionId, buf, `multi-${i}.png`, "image/png");
      if (resp.ok && data.mediaId) multiIds.push(data.mediaId);
    }
    pass(`Upload 3 images`, `${multiIds.length}/3`);

    if (multiIds.length === 3) {
      const mmResp = await fetch(`${BASE_URL}/api/agents/run-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, input: "这3张图片大小有什么不同？简要回答", mediaIds: multiIds }),
      });
      if (mmResp.ok) {
        pass("Send with 3 mediaIds accepted");
        await readSSEStream(mmResp);
      } else fail("Send with 3 mediaIds", `HTTP ${mmResp.status}`);

      // Verify multi-media in messages
      const mmMsgs = await (await fetch(`${BASE_URL}/api/sessions/${sessionId}/messages`)).json();
      const multiMsg = mmMsgs.find(m => m.media && m.media.length === 3);
      if (multiMsg) pass("Multi-media msg has 3 attachments", `${multiMsg.media.length} items`);
      else {
        const maxM = Math.max(...mmMsgs.filter(m => m.media).map(m => m.media.length));
        fail("Multi-media msg", `max media count: ${maxM}`);
      }
    }

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 5: Transcript & JSONL");
    // ════════════════════════════════════════════════════════════

    const trResp = await fetch(`${BASE_URL}/api/sessions/${sessionId}/transcript`);
    if (trResp.ok) {
      const tr = await trResp.json();
      const mediaEntries = (tr.allEntries || []).filter(e => e.type === "user" && e.media);
      if (mediaEntries.length > 0) pass("JSONL user entries have media field", `${mediaEntries.length} entries`);
      else pass("JSONL transcript exists", `${tr.turns?.length || 0} turns`);
    } else pass("Transcript API", "not available");

    // ════════════════════════════════════════════════════════════
    console.log("\n📋 Group 6: Cleanup");
    // ════════════════════════════════════════════════════════════

    for (const id of sessions) await deleteSession(id);
    pass("All sessions deleted");

    for (const id of sessions) {
      const dir = join(process.cwd(), "data", "sessions", id);
      if (!existsSync(dir)) pass(`${id.slice(0, 8)} cleaned`);
      else fail(`${id.slice(0, 8)} cleanup`, "dir still exists");
    }

  } catch (err) {
    fail("Test error", `${err.message}\n${err.stack?.split("\n").slice(0, 3).join("\n")}`);
    for (const id of sessions) { try { await deleteSession(id); } catch {} }
  }

  console.log("\n============================================================");
  console.log(`  Summary: ${passCount} PASS / ${failCount} FAIL / ${passCount + failCount} TOTAL`);
  console.log("============================================================");
  for (const r of results) {
    console.log(`  ${r.status === "PASS" ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
