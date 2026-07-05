import { defineConfig } from "@playwright/test";

/**
 * Playwright config dedicated to Hub Server E2E tests (T61-T80).
 *
 * The Hub control plane runs independently on http://localhost:22000
 * (bun run src/main.ts in deepanalyze-hub). No webServer bootstrap is
 * needed — these tests target the already-running Hub.
 */
export default defineConfig({
  testDir: "./tests/e2e/hub",
  timeout: 120000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://localhost:22000",
    headless: true,
    screenshot: "on",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
