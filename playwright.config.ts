import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/ui",
  outputDir: "apps/web/test-results",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4318", headless: true },
  webServer: {
    command: "pnpm exec tsx tests/ui/server.ts",
    url: "http://127.0.0.1:4318",
    reuseExistingServer: false,
  },
  reporter: "list",
});
