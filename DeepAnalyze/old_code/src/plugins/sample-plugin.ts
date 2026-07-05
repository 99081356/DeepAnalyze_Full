// =============================================================================
// DeepAnalyze - Sample Plugin
// =============================================================================
// A simple example plugin that adds a "word_count" tool for document analysis.
// Demonstrates how to create a plugin with a custom tool.
// =============================================================================

import type { PluginManifest } from "../services/plugins/types.js";

export const SAMPLE_PLUGIN: PluginManifest = {
  id: "sample-utilities",
  name: "Sample Utilities",
  version: "1.0.0",
  description: "Sample plugin with utility tools for document analysis.",
  author: "DeepAnalyze",
  tools: [
    {
      name: "word_count",
      description:
        "Count words in text. Returns word count, character count, and estimated reading time.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to analyze" },
        },
        required: ["text"],
      },
      execute: async (input) => {
        const text = input.text as string;
        const words = text.split(/\s+/).filter((w) => w.length > 0);
        const readingTime = Math.ceil(words.length / 200);
        return {
          wordCount: words.length,
          charCount: text.length,
          readingTimeMinutes: readingTime,
        };
      },
    },
  ],
};
