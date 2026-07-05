import { describe, it, expect } from "bun:test";
import { AsyncSessionMemoryExtractor } from "../session-memory-async.js";

describe("AsyncSessionMemoryExtractor", () => {
  it("does not extract when token increment is insufficient", () => {
    const extractor = new AsyncSessionMemoryExtractor();
    let called = false;
    extractor.tryExtract(100, async () => { called = true; });
    expect(called).toBe(false);
  });

  it("triggers extraction when token increment is sufficient", async () => {
    const extractor = new AsyncSessionMemoryExtractor({ sessionMemoryUpdateInterval: 1 });
    let called = false;
    extractor.tryExtract(10000, async () => { called = true; });
    await extractor.waitForExtraction();
    expect(called).toBe(true);
  });

  it("skips when already extracting", async () => {
    const extractor = new AsyncSessionMemoryExtractor({ sessionMemoryUpdateInterval: 1 });
    let count = 0;
    extractor.tryExtract(10000, async () => {
      await new Promise(r => setTimeout(r, 50));
      count++;
    });
    // Second call should be skipped
    extractor.tryExtract(20000, async () => { count++; });
    await extractor.waitForExtraction();
    expect(count).toBe(1);
  });

  it("isExtracting reflects current state", async () => {
    const extractor = new AsyncSessionMemoryExtractor({ sessionMemoryUpdateInterval: 1 });
    expect(extractor.isExtracting).toBe(false);
    extractor.tryExtract(10000, async () => {
      await new Promise(r => setTimeout(r, 50));
    });
    expect(extractor.isExtracting).toBe(true);
    await extractor.waitForExtraction();
    expect(extractor.isExtracting).toBe(false);
  });

  it("reset clears last extracted tokens", async () => {
    const extractor = new AsyncSessionMemoryExtractor({ sessionMemoryUpdateInterval: 1000 });
    extractor.tryExtract(10000, async () => {});
    await extractor.waitForExtraction();
    // Now lastExtractedTokens = 10000. Increment of 100 (10100 - 10000 = 100) is
    // below threshold * 3 = 3000, so extraction is skipped.
    let called = false;
    extractor.tryExtract(10100, async () => { called = true; });
    expect(called).toBe(false);

    // Reset clears lastExtractedTokens to 0, so 10100 is now a big increment (> 3000).
    extractor.reset();
    let called2 = false;
    extractor.tryExtract(10100, async () => { called2 = true; });
    await extractor.waitForExtraction();
    expect(called2).toBe(true);
  });
});
