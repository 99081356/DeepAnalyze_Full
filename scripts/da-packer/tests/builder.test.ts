// =============================================================================
// tests/builder.test.ts
// =============================================================================
// Unit test for parseBuildOptions (via parseModelList). The full build pipeline
// requires a real Docker daemon and live model files (sha placeholders in the
// manifest would fail sha verification), so it's tested via manual integration
// only — see plan Phase H Step 3.
// =============================================================================

import { describe, test, expect } from "vitest";
import { parseModelList } from "../src/lib/manifest-fetcher.js";

describe("build command", () => {
  test("parseModelList splits comma list (used by parseBuildOptions)", () => {
    expect(parseModelList("a,b,c")).toEqual(["a", "b", "c"]);
    expect(parseModelList("bge-m3,whisper-tiny")).toEqual(["bge-m3", "whisper-tiny"]);
  });

  test("parseModelList handles edge cases", () => {
    expect(parseModelList("")).toEqual([]);
    expect(parseModelList(undefined)).toEqual([]);
    expect(parseModelList("single")).toEqual(["single"]);
  });
});
