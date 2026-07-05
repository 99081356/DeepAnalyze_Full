/**
 * Layered system prompt builder with section-level caching.
 * Separates static sections (cacheable across requests) from
 * dynamic sections (change per request).
 *
 * Static sections are cached in a module-level Map and reused across
 * consecutive run() calls within the same session. The cache is cleared
 * on compaction to force recomputation.
 *
 * Reference: refcode/claude-code/src/constants/systemPromptSections.ts
 */

export interface SystemPromptSection {
  name: string;
  content: string;
  isDynamic: boolean;
}

export interface BuiltSystemPrompt {
  full: string;
  staticPart: string;
  dynamicPart: string;
  boundary: string;
}

const DYNAMIC_BOUNDARY = "\n\n---DYNAMIC_BOUNDARY---\n\n";

// Module-level section cache. Survives across run() calls, cleared on compaction.
const sectionCache = new Map<string, string>();

export class SystemPromptBuilder {
  private sections: SystemPromptSection[] = [];

  addStaticSection(name: string, content: string): this {
    this.sections.push({ name, content, isDynamic: false });
    return this;
  }

  /**
   * Add a cached static section. If the cache already has content for this name,
   * uses the cached version instead of recomputing.
   * Use this for sections that don't change between run() calls (agent definition,
   * tool guidance, anti-hallucination rules, etc.).
   */
  addCachedStaticSection(name: string, computeContent: () => string): this {
    const cached = sectionCache.get(name);
    const content = cached ?? computeContent();
    if (!cached) {
      sectionCache.set(name, content);
    }
    this.sections.push({ name, content, isDynamic: false });
    return this;
  }

  addDynamicSection(name: string, content: string): this {
    this.sections.push({ name, content, isDynamic: true });
    return this;
  }

  build(): BuiltSystemPrompt {
    const staticParts: string[] = [];
    const dynamicParts: string[] = [];

    for (const section of this.sections) {
      if (section.isDynamic) {
        dynamicParts.push(section.content);
      } else {
        staticParts.push(section.content);
      }
    }

    const staticPart = staticParts.join("\n\n");
    const dynamicPart = dynamicParts.join("\n\n");

    let full = staticPart;
    if (dynamicPart) {
      full += DYNAMIC_BOUNDARY + dynamicPart;
    }

    return { full, staticPart, dynamicPart, boundary: DYNAMIC_BOUNDARY };
  }

  reset(): this {
    this.sections = [];
    return this;
  }

  get sectionCount(): number {
    return this.sections.length;
  }

  get dynamicSectionCount(): number {
    return this.sections.filter(s => s.isDynamic).length;
  }
}

/**
 * Clear the system prompt section cache.
 * Called after compaction to force recomputation of all sections.
 */
export function clearSystemPromptCache(): void {
  sectionCache.clear();
}
