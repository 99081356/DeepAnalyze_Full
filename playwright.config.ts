import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for Hub Worker Skills Admin e2e tests.
 *
 * Conventions:
 * - workers: 1 (serial) — all tests share DB state
 * - webServer auto-starts Vite unless PW_NO_SERVER=1 (Vite already running)
 * - Backend Hub on :22000 must be running (global-setup enforces)
 * - Screenshots captured per test into tests/e2e/screenshots/
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "*.spec.ts",

  // Serial — all tests share the same DB and tab state
  workers: 1,
  fullyParallel: false,

  // Fail fast on first error in serial mode (helps debugging)
  retries: 0,

  // Reporter
  reporter: [["list"], ["html", { open: "never" }]],

  // Per-test artifacts
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failing",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  // Single Chromium project
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chromium" },
    },
  ],

  // Auto-start Vite dev server (skip with PW_NO_SERVER=1)
  ...(process.env.PW_NO_SERVER === "1"
    ? {}
    : {
        webServer: {
          command: "cd frontend && bun run dev",
          url: "http://localhost:5173",
          reuseExistingServer: true,
          timeout: 60_000,
          stdout: "pipe",
          stderr: "pipe",
        },
      }),

  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
});
