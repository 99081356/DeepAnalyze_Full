import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  retries: 1,
  use: {
    baseURL: "http://localhost:21000",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: "echo 'Using existing server'",
    port: 21000,
    reuseExistingServer: true,
    timeout: 5000,
  },
});
