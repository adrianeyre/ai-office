import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@ai-office/db",
    // The first Postgres test in a file pulls the image (on a cold machine)
    // and starts the container inside its own time budget.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
