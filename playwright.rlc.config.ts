/**
 * Playwright config for the standalone RLC editor smoke suite.
 *
 * Serves the BUILT artifact (`npm run build:rlc` output) rather than the dev server, so
 * the suite tests exactly the files that get deployed.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-rlc",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "./e2e-rlc/test-results",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:4178",
    screenshot: "only-on-failure",
    trace: "off",
  },
  projects: [
    {
      name: "chrome",
      // Use the machine's installed Chrome instead of downloading Playwright's Chromium
      // build: the CDN is unreachable from some networks, and a locally installed browser
      // is a perfectly faithful target for these smoke assertions.
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: "npx vite preview --config vite.config.rlc.ts --port 4178 --strictPort",
    url: "http://localhost:4178",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
