// =============================================================================
// DeepAnalyze - StructuredOutput Tool
// =============================================================================
// Validates Agent output against a JSON Schema using Ajv.
// Designed for SDK/programmatic usage where callers need guaranteed structure.
// =============================================================================

import Ajv from "ajv";
import type { AgentTool } from "../../services/agent/types.js";

// ---------------------------------------------------------------------------
// Schema validator cache (WeakMap avoids memory leaks for one-off schemas)
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const validatorCache = new WeakMap<object, any>();

/**
 * Get or create a compiled validator for the given JSON Schema.
 * Uses WeakMap to cache compiled validators — the same schema object
 * will always return the same validator without recompilation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getValidator(schema: Record<string, unknown>): any {
  let validate = validatorCache.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    validatorCache.set(schema, validate);
  }
  return validate;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const structuredOutputTool: AgentTool = {
  name: "structured_output",
  description:
    "Generate structured output conforming to a JSON Schema. " +
    "Use this when the caller requires validated, machine-readable output with a guaranteed structure. " +
    "Provide both the JSON Schema and the data — the tool validates data against schema and returns it on success, " +
    "or returns detailed validation errors on failure so you can fix and retry.",
  inputSchema: {
    type: "object",
    properties: {
      schema: {
        type: "object",
        description:
          "JSON Schema that the output must conform to (draft-07 or 2020-12). " +
          "Example: {\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"}},\"required\":[\"name\"]}",
      },
      data: {
        type: "object",
        description: "The structured data to validate and output",
      },
    },
    required: ["schema", "data"],
  },
  async execute(input: Record<string, unknown>) {
    const { schema, data } = input;

    if (!schema || typeof schema !== "object") {
      return { error: "schema must be a valid JSON Schema object" };
    }
    if (data === undefined || data === null) {
      return { error: "data is required" };
    }

    try {
      const validate = getValidator(schema as Record<string, unknown>);
      const valid = validate(data);

      if (!valid) {
        const errors = validate.errors?.map(
          (e: { instancePath: string; message?: string; keyword: string }) => ({
            path: e.instancePath || "/",
            message: e.message ?? `failed keyword: ${e.keyword}`,
          })
        );
        return {
          error: "Schema validation failed",
          details: errors,
        };
      }

      return { structured: true, data };
    } catch (err) {
      return {
        error: `Schema compilation error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  shouldDefer: true,
};
