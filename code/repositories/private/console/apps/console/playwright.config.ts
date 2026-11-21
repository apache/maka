import { defineConfig } from "@playwright/test";

// e2e 用系统 Edge（channel），避免下载 Playwright 浏览器。
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: { baseURL: "http://localhost:65501", channel: "msedge" },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:65501/api/health",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
