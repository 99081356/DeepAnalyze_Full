/**
 * Shared test fixtures and constants for E2E tests.
 */

// Test KB: "bigtest"
export const TEST_KB_ID = "60346710-913d-4b54-b742-499da76cd85b";

// Document IDs within the test KB
export const DOC = {
  pdf: "1778ec5f-947e-4307-a57a-e2194bd0e927",   // antigravity-rag-2026.pdf
  xlsx: "e6e5ee3e-d677-4eff-b9ee-7211e5db6cd5",  // athlete_events.xlsx
  jpg: "9eaf730d-3dc0-4d0d-b008-b0e3535ef312",    // 20260314-172020.jpg
  mp3: "d0db6841-e012-4ca0-b299-25950fb88655",    // 何老师遗言.mp3
  mp4: "8db1649b-e17d-4b3c-9aeb-01e6de4050b2",    // 小球放烟花.mp4
} as const;

// Expected file metadata
export const FILE_META = {
  [DOC.pdf]:  { name: "antigravity-rag-2026.pdf", size: 361300,   type: "pdf",  mime: "application/pdf" },
  [DOC.xlsx]: { name: "athlete_events.xlsx",       size: 22052672, type: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  [DOC.jpg]:  { name: "20260314-172020.jpg",       size: 286687,   type: "jpg",  mime: "image/jpeg" },
  [DOC.mp3]:  { name: "何老师遗言.mp3",            size: 6850507,  type: "mp3",  mime: "audio/mpeg" },
  [DOC.mp4]:  { name: "小球放烟花.mp4",             size: 2353287,  type: "mp4",  mime: "video/mp4" },
} as const;
