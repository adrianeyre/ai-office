import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@ai-office/events",
    // The Postgres tests start a container inside their own time budget.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
