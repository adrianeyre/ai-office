import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "@ai-office/github",
    // The contract suite against the real App makes many calls to GitHub.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
