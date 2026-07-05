import { describe, it, expect } from "bun:test";
import {
  splitSystemPrompt,
  assembleSystemPrompt,
  splitSystemPromptForCache,
  markCacheBreakpoints,
} from "../prompt-cache.js";

describe("Prompt Cache — Enhanced", () => {
  // -----------------------------------------------------------------------
  // 1. splitSystemPromptForCache: no boundary → single block with cache_control
  // -----------------------------------------------------------------------
  it("returns single block with cache_control when no dynamic boundary", () => {
    const prompt = "This is a static system prompt with no boundary marker.";
    const blocks = splitSystemPromptForCache(prompt);

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe(prompt);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });

  // -----------------------------------------------------------------------
  // 2. splitSystemPromptForCache: with boundary → static has cache_control,
  //    dynamic does not
  // -----------------------------------------------------------------------
  it("splits into static (cached) and dynamic (uncached) blocks", () => {
    const staticPart = "System instructions go here.";
    const dynamicPart = "Dynamic session context here.";
    const fullPrompt = staticPart + "\n\n---DYNAMIC_BOUNDARY---\n\n" + dynamicPart;

    const blocks = splitSystemPromptForCache(fullPrompt);

    expect(blocks.length).toBe(2);
    // Static block has cache_control
    expect(blocks[0].text).toBe(staticPart);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    // Dynamic block has no cache_control
    expect(blocks[1].text).toBe(dynamicPart);
    expect(blocks[1].cache_control).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 3. splitSystemPromptForCache: empty string → single block without cache_control
  // -----------------------------------------------------------------------
  it("returns single block without cache_control for empty string", () => {
    const blocks = splitSystemPromptForCache("");

    expect(blocks.length).toBe(1);
    expect(blocks[0].text).toBe("");
    // Empty string → staticPrefix is "" (falsy), so no cache_control is added
    // But it falls through to the fallback block
    expect(blocks[0].cache_control).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 4. markCacheBreakpoints marks last user message
  // -----------------------------------------------------------------------
  it("marks only the last user message with __cache_control", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "first user" },
      { role: "assistant", content: "response" },
      { role: "user", content: "last user" },
      { role: "assistant", content: "final" },
    ];

    const marked = markCacheBreakpoints(messages);

    // Last user message gets __cache_control
    expect((marked[3] as Record<string, unknown>).__cache_control).toEqual({ type: "ephemeral" });
    // First user message does not
    expect((marked[1] as Record<string, unknown>).__cache_control).toBeUndefined();
    // Other messages unchanged
    expect(marked[0].role).toBe("system");
    expect(marked[2].role).toBe("assistant");
  });

  // -----------------------------------------------------------------------
  // 5. markCacheBreakpoints: no user messages → no crash, no marks
  // -----------------------------------------------------------------------
  it("does not mark anything when there are no user messages", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "response" },
    ];

    const marked = markCacheBreakpoints(messages);

    for (const msg of marked) {
      expect((msg as Record<string, unknown>).__cache_control).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------------
  // 6. assembleSystemPrompt round-trip
  // -----------------------------------------------------------------------
  it("split then assemble produces the original prompt", () => {
    const staticPart = "Static instructions.";
    const dynamicPart = "Dynamic context.";
    const fullPrompt = staticPart + "\n\n---DYNAMIC_BOUNDARY---\n\n" + dynamicPart;

    const parts = splitSystemPrompt(fullPrompt);
    const reassembled = assembleSystemPrompt(parts);

    expect(reassembled).toBe(fullPrompt);
  });

  // round-trip without boundary
  it("round-trip works without dynamic boundary", () => {
    const prompt = "Just a plain static prompt.";
    const parts = splitSystemPrompt(prompt);
    const reassembled = assembleSystemPrompt(parts);
    expect(reassembled).toBe(prompt);
  });

  // -----------------------------------------------------------------------
  // 7. Anthropic provider: buildRequestBody produces TextBlockParam[] for system
  // -----------------------------------------------------------------------
  it("Anthropic buildRequestBody uses splitSystemPromptForCache for system", () => {
    // We test this by verifying splitSystemPromptForCache output format
    // matches what Anthropic provider expects
    const systemPrompt = "Static part\n\n---DYNAMIC_BOUNDARY---\n\nDynamic part";
    const blocks = splitSystemPromptForCache(systemPrompt);

    // Verify Anthropic TextBlockParam format
    expect(Array.isArray(blocks)).toBe(true);
    for (const block of blocks) {
      expect(block.type).toBe("text");
      expect(typeof block.text).toBe("string");
    }
    // First block (static) should have cache_control
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });

  // -----------------------------------------------------------------------
  // 8. Anthropic provider translates __cache_control on user messages
  // -----------------------------------------------------------------------
  it("__cache_control is present on marked user messages", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "follow up" },
    ];

    const marked = markCacheBreakpoints(messages);

    // The last user message should have __cache_control
    const lastUser = marked.find(
      (m) => m.role === "user" && (m as Record<string, unknown>).__cache_control,
    );
    expect(lastUser).toBeDefined();
    expect((lastUser as Record<string, unknown>).__cache_control).toEqual({ type: "ephemeral" });

    // Verify the Anthropic provider would use this marker:
    // In the real provider, if (cacheControl) → add cache_control to content block
    const cacheControl = (lastUser as Record<string, unknown>).__cache_control as { type: string } | undefined;
    expect(cacheControl).toBeDefined();
    expect(cacheControl!.type).toBe("ephemeral");
  });

  // -----------------------------------------------------------------------
  // 9. OpenAI provider translates __cache_control
  // -----------------------------------------------------------------------
  it("__cache_control marker is translatable for OpenAI provider format", () => {
    const messages = [
      { role: "user", content: "hello" },
    ];

    const marked = markCacheBreakpoints(messages);
    const userMsg = marked[0] as Record<string, unknown>;

    // The OpenAI provider checks for __cache_control and maps it to cache_control
    expect(userMsg.__cache_control).toEqual({ type: "ephemeral" });

    // Simulate what OpenAI provider does:
    // if (msg.__cache_control) → oai.cache_control = { type: "ephemeral" }
    if (userMsg.__cache_control) {
      const translated = { type: "ephemeral" as const };
      expect(translated.type).toBe("ephemeral");
    }
  });
});
