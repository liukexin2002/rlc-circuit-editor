/**
 * Playwright config for verifying the DELIVERED link (the live GitHub Pages site).
 *
 * No webServer block on purpose: this suite must hit the real deployed URL, so a local
 * server starting up would be a false signal.
 */

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-rlc",
  testMatch: /live-(deployment|screenshot)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: "list",
  outputDir: "./e2e-rlc/live-test-results",
  timeout: 90_000,
  use: {
    screenshot: "only-on-failure",
    trace: "off",
  },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
});

