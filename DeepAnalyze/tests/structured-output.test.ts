// =============================================================================
// DeepAnalyze - StructuredOutput Tool Tests
// =============================================================================

import { describe, it, expect } from "vitest";
import { structuredOutputTool } from "../src/tools/StructuredOutputTool/index.js";

describe("structured_output tool", () => {
  const execute = (input: Record<string, unknown>) =>
    structuredOutputTool.execute(input);

  it("validates data that matches a simple schema", async () => {
    const result = await execute({
      schema: {
        type: "object",
        properties: { name: { type: "string" }, age: { type: "number" } },
        required: ["name"],
      },
      data: { name: "Alice", age: 30 },
    });

    expect(result).toEqual({ structured: true, data: { name: "Alice", age: 30 } });
  });

  it("returns validation errors when data does not match schema", async () => {
    const result = await execute({
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      data: { age: 30 }, // missing required "name"
    });

    expect(result).toHaveProperty("error", "Schema validation failed");
    expect(result).toHaveProperty("details");
    expect(result.details).toBeInstanceOf(Array);
    expect(result.details.length).toBeGreaterThan(0);
  });

  it("returns error when schema is missing", async () => {
    const result = await execute({ data: { foo: "bar" } });
    expect(result).toHaveProperty("error");
  });

  it("returns error when data is missing", async () => {
    const result = await execute({
      schema: { type: "object", properties: {} },
    });
    expect(result).toHaveProperty("error");
  });

  it("handles nested object schemas", async () => {
    const result = await execute({
      schema: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              email: { type: "string", format: "email" },
            },
            required: ["email"],
          },
        },
        required: ["user"],
      },
      data: { user: { email: "test@example.com" } },
    });

    expect(result).toEqual({
      structured: true,
      data: { user: { email: "test@example.com" } },
    });
  });

  it("handles array schemas", async () => {
    const result = await execute({
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "number" },
          },
        },
      },
      data: { items: [1, 2, 3] },
    });

    expect(result).toEqual({ structured: true, data: { items: [1, 2, 3] } });
  });

  it("handles type mismatch errors", async () => {
    const result = await execute({
      schema: {
        type: "object",
        properties: {
          count: { type: "number" },
        },
      },
      data: { count: "not a number" },
    });

    expect(result).toHaveProperty("error", "Schema validation failed");
    expect(result.details[0].path).toBe("/count");
  });

  it("tool metadata is correct", () => {
    expect(structuredOutputTool.name).toBe("structured_output");
    expect(structuredOutputTool.shouldDefer).toBe(true);
    expect(structuredOutputTool.isReadOnly?.({})).toBe(true);
    expect(structuredOutputTool.isConcurrencySafe?.({})).toBe(true);
  });
});
