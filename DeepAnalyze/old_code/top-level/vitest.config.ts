import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    alias: {
      "bun:test": path.resolve(__dirname, "src/test-utils/bun-test-shim.js"),
    },
  },
});
