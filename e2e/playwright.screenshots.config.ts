import { defineConfig, devices } from "@playwright/test";

// The README's screenshots (`pnpm screenshots`): the built web app, served
// by the real server against Postgres 18, as the end-to-end tests run it,
// given something on every page first. They are written to
// `docs/images/`.
export default defineConfig({
  testDir: "./screenshots",
  globalSetup: "./support/global-setup.ts",
  timeout: 120_000,
  reporter: [["list"]],
  outputDir: "test-results/screenshots",
  use: { trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        colorScheme: "light",
      },
    },
  ],
});
