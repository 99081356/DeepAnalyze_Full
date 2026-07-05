// =============================================================================
// DeepAnalyze - Entity Extractor
// Uses the model router to extract named entities from text via LLM prompts.
// =============================================================================

import { ModelRouter } from "../models/router.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedEntity {
  name: string;
  type: "person" | "organization" | "location" | "date" | "amount" | "event" | "other";
  mentions: string[]; // Context snippets where the entity appears
}

// ---------------------------------------------------------------------------
// EntityExtractor
// ---------------------------------------------------------------------------

export class EntityExtractor {
  private router: ModelRouter;

  constructor(router: ModelRouter) {
    this.router = router;
  }

  /**
   * Extract named entities from the given text using the summarizer model.
   *
   * Sends a structured prompt asking the model to return a JSON array of
   * entities. Falls back to an empty list if the model is unavailable or
   * returns invalid JSON.
   */
  async extract(text: string): Promise<ExtractedEntity[]> {
    // Truncate very long text to avoid exceeding model context
    const truncated =
      text.length > 8000
        ? text.slice(0, 8000) + "\n...(truncated)"
        : text;

    const prompt = `从以下文本中提取所有关键实体。返回JSON数组，每个元素包含name(实体名), type(类型: person/organization/location/date/amount/event/other), mentions(出现上下文，最多3个)。

只返回JSON数组，不要其他文字。

文本内容：
${truncated}`;

    let response: string;
    try {
      const result = await this.router.chat(
        [{ role: "user", content: prompt }],
        { model: this.router.getDefaultModel("summarizer") },
      );
      response = result.content;
    } catch (err) {
      console.warn(
        "[EntityExtractor] Model call failed, returning empty entity list:",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }

    // Parse JSON from the response - the model may wrap it in markdown
    return this.parseEntityResponse(response);
  }

  /**
   * Parse the model response into an array of ExtractedEntity objects.
   * Handles various response formats: raw JSON array, markdown-wrapped JSON,
   * or partially malformed responses.
   */
  private parseEntityResponse(response: string): ExtractedEntity[] {
    // Try to extract JSON from the response
    let jsonStr = response.trim();

    // Strip markdown code fences if present
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    // Find the JSON array in the response
    const arrayStart = jsonStr.indexOf("[");
    const arrayEnd = jsonStr.lastIndexOf("]");
    if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) {
      console.warn("[EntityExtractor] No JSON array found in response");
      return [];
    }

    jsonStr = jsonStr.slice(arrayStart, arrayEnd + 1);

    try {
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) {
        console.warn("[EntityExtractor] Response is not a JSON array");
        return [];
      }

      // Validate and normalize each entity
      return parsed
        .filter((item: unknown) => typeof item === "object" && item !== null)
        .map((item: Record<string, unknown>) => this.normalizeEntity(item))
        .filter(
          (entity: ExtractedEntity | null): entity is ExtractedEntity =>
            entity !== null,
        );
    } catch (err) {
      console.warn(
        "[EntityExtractor] Failed to parse JSON response:",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  /**
   * Normalize a raw parsed object into an ExtractedEntity.
   * Returns null if the object is not a valid entity.
   */
  private normalizeEntity(obj: Record<string, unknown>): ExtractedEntity | null {
    const name = obj.name ?? obj.entity;
    if (typeof name !== "string" || name.trim().length === 0) {
      return null;
    }

    // Normalize type
    const rawType = String(obj.type ?? "other").toLowerCase();
    const validTypes = new Set([
      "person",
      "organization",
      "location",
      "date",
      "amount",
      "event",
      "other",
    ]);
    const type = validTypes.has(rawType)
      ? (rawType as ExtractedEntity["type"])
      : "other";

    // Normalize mentions
    let mentions: string[] = [];
    if (Array.isArray(obj.mentions)) {
      mentions = obj.mentions
        .filter((m: unknown) => typeof m === "string")
        .slice(0, 3) as string[];
    } else if (typeof obj.mentions === "string") {
      mentions = [obj.mentions].slice(0, 3);
    }

    return {
      name: name.trim(),
      type,
      mentions,
    };
  }
}
