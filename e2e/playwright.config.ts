import { defineConfig, devices } from "@playwright/test";

// The end-to-end tests (PRD §9): the built web app, served by the real
// server, against Postgres 18. `pnpm e2e` at the root builds the web app
// first. Each test gets its own server and database (see
// `support/office.ts`), so tests can run in parallel and in any order.
const ci = process.env["CI"] !== undefined && process.env["CI"] !== "";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./support/global-setup.ts",
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  ...(ci ? { workers: 2 } : {}),
  timeout: 30_000,
  reporter: ci
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    // Kept for every failed test, and uploaded by CI.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
