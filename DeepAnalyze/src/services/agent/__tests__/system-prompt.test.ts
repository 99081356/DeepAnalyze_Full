import { describe, it, expect } from "bun:test";
import { SystemPromptBuilder } from "../system-prompt.js";

describe("SystemPromptBuilder", () => {
  it("builds with only static sections", () => {
    const prompt = new SystemPromptBuilder()
      .addStaticSection("identity", "You are an AI assistant.")
      .addStaticSection("tools", "Use tools wisely.")
      .build();

    expect(prompt.full).toContain("AI assistant");
    expect(prompt.full).toContain("Use tools wisely");
    expect(prompt.dynamicPart).toBe("");
    expect(prompt.staticPart).toContain("AI assistant");
  });

  it("separates static and dynamic sections", () => {
    const prompt = new SystemPromptBuilder()
      .addStaticSection("identity", "Static content")
      .addDynamicSection("scope", "Dynamic content")
      .build();

    expect(prompt.staticPart).toBe("Static content");
    expect(prompt.dynamicPart).toBe("Dynamic content");
    expect(prompt.full).toContain("---DYNAMIC_BOUNDARY---");
  });

  it("reset clears all sections", () => {
    const builder = new SystemPromptBuilder()
      .addStaticSection("a", "A")
      .addDynamicSection("b", "B");

    expect(builder.sectionCount).toBe(2);
    builder.reset();
    expect(builder.sectionCount).toBe(0);
  });

  it("counts dynamic sections correctly", () => {
    const builder = new SystemPromptBuilder()
      .addStaticSection("a", "A")
      .addDynamicSection("b", "B")
      .addDynamicSection("c", "C");

    expect(builder.dynamicSectionCount).toBe(2);
  });

  it("builds without dynamic boundary when no dynamic sections", () => {
    const prompt = new SystemPromptBuilder()
      .addStaticSection("only", "Just static")
      .build();

    expect(prompt.full).not.toContain("DYNAMIC_BOUNDARY");
  });
});
