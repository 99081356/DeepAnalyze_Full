import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: "http://localhost:21000",
    headless: true,
    screenshot: "on",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: "echo 'Using existing servers'",
    port: 21000,
    reuseExistingServer: true,
    timeout: 5000,
  },
});
