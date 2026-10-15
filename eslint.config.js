// @ts-check
import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  // `.sandcastle/` is the harness that runs agents on this repository, not
  // part of AI Office, and `docs/` is prose.
  globalIgnores([
    "**/dist/",
    "**/coverage/",
    "**/test-results/",
    "**/playwright-report/",
    ".sandcastle/",
    "docs/",
  ]),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
  },
  // Formatting is Prettier's job; this turns off every rule that disagrees.
  prettier,
);
