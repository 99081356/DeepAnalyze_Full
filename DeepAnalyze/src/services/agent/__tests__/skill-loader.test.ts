import { describe, it, expect } from "bun:test";
import { parseSkillMd } from "../skill-loader.js";

describe("parseSkillMd", () => {
  it("parses valid SKILL.md with frontmatter", () => {
    const content = `---
description: Evidence chain analysis
tools: [kb_search, expand, wiki_browse]
model-role: main
---

# Evidence Chain Analysis

You are a strict evidence analyst.`;

    const manifest = parseSkillMd(content, "evidence-chain");
    expect(manifest.name).toBe("evidence-chain");
    expect(manifest.description).toBe("Evidence chain analysis");
    expect(manifest.tools).toEqual(["kb_search", "expand", "wiki_browse"]);
    expect(manifest.modelRole).toBe("main");
    expect(manifest.systemPrompt).toContain("Evidence Chain Analysis");
  });

  it("throws on missing frontmatter", () => {
    expect(() => parseSkillMd("No frontmatter here", "test")).toThrow("Invalid SKILL.md");
  });

  it("defaults tools to wildcard when not specified", () => {
    const content = `---
description: Simple skill
---

Simple prompt`;
    const manifest = parseSkillMd(content, "simple");
    expect(manifest.tools).toEqual(["*"]);
  });

  it("handles single tool as array", () => {
    const content = `---
description: Single tool
tools: bash
---

Prompt`;
    const manifest = parseSkillMd(content, "single");
    expect(manifest.tools).toEqual(["bash"]);
  });

  it("defaults modelRole to main", () => {
    const content = `---
description: No model role
---

Prompt`;
    const manifest = parseSkillMd(content, "no-role");
    expect(manifest.modelRole).toBe("main");
  });
});
