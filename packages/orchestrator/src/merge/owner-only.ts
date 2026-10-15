import type { PullRequestFile } from "@ai-office/github";
import { memoryPath, repositorySkillFolders } from "@ai-office/shared";

import { notShownInFull } from "../review/prompt.ts";

// What the Merge Policy never merges without the Owner, on any Floor:
//
// - a pull request that changes what the repository's CI runs (pen-test
//   finding P1-2). Its reviewers and CI passing are no check on it, since
//   CI runs what the pull request itself says. These are the files that
//   say which commands CI runs, what it installs and how its tools are
//   set up. The code under test and the tests themselves are not among
//   them: those are what the reviewers review.
// - a pull request that changes what later Agents read as memory, Skills
//   or their agent tool's instructions and settings (P1-3): the
//   repository's memory changes only through the Manager's curation and
//   the Owner's merge (FR-53), and a Skill reaches Agents only once the
//   Owner has reviewed it (FR-76), so an Agent's own pull request does not
//   change either by policy.
//
// These are plain rules on the paths the pull request changes, a renamed
// file's old path too, matched whatever their case and at any depth, so a
// workspace package's own count too.

/** How many files GitHub lists for a pull request, at most. */
export const maxListedFiles = 3000;

/** Folders whose files define or drive CI, wherever they are. */
const ciFolders = new Set([
  // CI definitions.
  ".github",
  ".circleci",
  ".buildkite",
  ".gitlab",
  // Git hooks, and the package managers' own code and plugins.
  ".husky",
  ".yarn",
  ".mvn",
  // Scripts that CI and package scripts call.
  "scripts",
  "script",
  "ci",
  ".ci",
  "bin",
]);

/** Files, by name, that say what CI runs or installs, wherever they are. */
const ciFiles = new Set([
  // CI definitions.
  ".gitlab-ci.yml",
  ".travis.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "jenkinsfile",
  ".pre-commit-config.yaml",
  ".gitmodules",
  // JavaScript and TypeScript: scripts, dependencies, the toolchain.
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".pnpmfile.cjs",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  "turbo.json",
  "nx.json",
  "lerna.json",
  // Other ecosystems.
  "makefile",
  "gnumakefile",
  "justfile",
  "taskfile.yml",
  "taskfile.yaml",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "tox.ini",
  "noxfile.py",
  "pytest.ini",
  "conftest.py",
  "pipfile",
  "pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "gemfile",
  "gemfile.lock",
  "rakefile",
  "cargo.toml",
  "cargo.lock",
  "build.rs",
  "rust-toolchain",
  "rust-toolchain.toml",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "gradle-wrapper.properties",
  "gradlew",
  "gradlew.bat",
  "mvnw",
  "mvnw.cmd",
  "composer.json",
  "composer.lock",
  "dbt_project.yml",
  "profiles.yml",
  "packages.yml",
]);

/** Names of files that configure a tool CI runs, or are run as scripts. */
const ciNames: readonly RegExp[] = [
  // `.npmrc`, `.yarnrc.yml`, `.eslintrc.cjs`, `.prettierrc`, `.mocharc.yml`…
  /^\.[\w-]*rc(\.\w+)?$/,
  // `vitest.config.ts`, `eslint.config.js`, `playwright.config.ts`…
  /\.config\.\w+$/,
  /\.workspace\.\w+$/,
  /^[tj]sconfig(\.[\w-]+)*\.json$/,
  /^dockerfile/,
  /\.dockerfile$/,
  /^(docker-)?compose(\.[\w-]+)*\.ya?ml$/,
  /^requirements[\w.-]*\.txt$/,
  /\.mk$/,
  /\.(sh|bash|zsh|fish|ps1|bat|cmd)$/,
];

/** Whether a change to `path` changes what the repository's CI runs. */
export function runByCi(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts.at(-1) ?? "";
  return (
    parts.slice(0, -1).some((folder) => ciFolders.has(folder)) ||
    ciFolders.has(name) ||
    ciFiles.has(name) ||
    ciNames.some((pattern) => pattern.test(name))
  );
}

/**
 * Folders whose files later Agents read, wherever they are: AI Office's
 * own (the repository's memory and Skills), and Claude Code's, Codex's and
 * opencode's settings, hooks, commands and Skills.
 */
const agentFolders = new Set([
  ".agents",
  ".claude",
  ".codex",
  ".opencode",
  ...[memoryPath, ...repositorySkillFolders].map(
    (path) => path.toLowerCase().split("/")[0] ?? "",
  ),
]);

/** Files, by name, an agent tool reads as instructions or settings. */
const agentFiles = new Set([
  "claude.md",
  "claude.local.md",
  "agents.md",
  "agents.override.md",
  ".mcp.json",
  "opencode.json",
  "opencode.jsonc",
]);

/**
 * Whether a change to `path` changes what later Agents read as memory,
 * Skills or their agent tool's instructions and settings.
 */
export function readByAgents(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts.at(-1) ?? "";
  return parts.some((part) => agentFolders.has(part)) || agentFiles.has(name);
}

/** Every path a pull request's files change: a renamed one's old path too. */
const pathsOf = (files: readonly PullRequestFile[]): string[] =>
  files.flatMap(({ path, previousPath }) =>
    previousPath === undefined ? [path] : [path, previousPath],
  );

/**
 * Why the pull request must go to the Owner whatever its reviewers and CI
 * say, from the files it changes: each, as a phrase for the Notice. Empty
 * when nothing it changes asks for the Owner.
 */
export function ownerOnly(files: readonly PullRequestFile[]): string[] {
  const reasons: string[] = [];
  if (files.length >= maxListedFiles) {
    // GitHub lists no more: what it leaves out could be anything.
    reasons.push(
      `it changes more files than GitHub lists (${maxListedFiles.toLocaleString("en-GB")})`,
    );
  }
  const paths = pathsOf(files);
  if (paths.some(runByCi)) {
    reasons.push("it changes what CI runs");
  }
  if (paths.some(readByAgents)) {
    reasons.push(
      "it changes what later Agents read as memory, Skills or instructions",
    );
  }
  // An approval counts only for a pull request its reviewer was shown in
  // full (P1-11), whenever the approval was given.
  const unshown = notShownInFull(files);
  if (unshown !== undefined) {
    reasons.push(`no reviewer can be shown it in full (${unshown})`);
  }
  return reasons;
}
