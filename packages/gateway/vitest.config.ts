import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@ai-office/gateway",
    // The Postgres tests start a container inside their own time budget.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Fake AI Providers are on loopback, which the tests allow.
    setupFiles: ["./src/test-setup.ts"],
  },
});
