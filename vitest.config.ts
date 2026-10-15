import { defineConfig } from "vitest/config";

// Every workspace package is its own Vitest project, so `pnpm test` at the
// root runs them all and `pnpm test` inside a package runs only its own.
// `deployment` checks the compose stack, the Dockerfile and .env.example;
// `repository` checks across the repository, such as every failing pen-test
// being referenced by an assessment.
export default defineConfig({
  test: {
    projects: [
      "apps/*",
      "packages/*",
      {
        test: {
          name: "deployment",
          include: ["docker/**/*.test.ts"],
          // Bringing the compose stack up builds the image.
          testTimeout: 1_200_000,
        },
      },
      {
        test: {
          name: "repository",
          include: ["test/**/*.test.ts"],
        },
      },
    ],
  },
});
