import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    // Frontend has its own vitest.config.ts (jsdom environment for React tests).
    // Exclude frontend dir from root discovery to avoid "window is not defined" failures.
    exclude: ["**/node_modules/**", "**/dist/**", "frontend/**"],
  },
});
