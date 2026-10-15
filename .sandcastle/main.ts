/**
 * The Sandcastle entrypoint for this repository.
 *
 *   pnpm sandcastle 9                       # ./.sandcastle/prompt.md, against issue #9
 *   pnpm sandcastle prompt-issue-9.md 9     # a prompt you wrote beside it
 *   pnpm sandcastle                         # only for a prompt naming no issue
 *
 * `docs/processes/running-sandcastle.md` is the prose; this is the wiring. What
 * it adds to the blank template: a private CA is forwarded when the host reaches
 * Anthropic through one, dependencies are installed by a hook rather than baked
 * into the image, commits are merged back to the branch you launched from, and
 * the prompt is chosen at the command line.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import type { MountConfig } from "@ai-hero/sandcastle";

// A private CA on the host names a file the container cannot see, so the file
// is mounted and the variable re-pointed at where it landed.
const hostCaCert = process.env.NODE_EXTRA_CA_CERTS;
const caCertInSandbox = "/home/agent/ca-certificates.pem";
const forwardCaCert = Boolean(hostCaCert && existsSync(hostCaCert));

const mounts: MountConfig[] =
  forwardCaCert && hostCaCert
    ? [{ hostPath: hostCaCert, sandboxPath: caCertInSandbox, readonly: true }]
    : [];

// Dependencies are installed when the sandbox comes up, never baked into the
// image. `--frozen-lockfile` matches CI: a slice that adds a dependency must
// commit the lockfile change. `onSandboxReady` hooks run in parallel, so
// anything needing `node_modules` is chained with `&&` in this one entry.
const SETUP = [
  {
    command: "pnpm install --frozen-lockfile",
    timeoutMs: 600_000,
  },
] as const;

// `.sandcastle/.gitignore` ignores every `prompt*.md` except `prompt.md`, the
// committed template you copy.
const PROMPT_DIR = "./.sandcastle";
const DEFAULT_PROMPT = "prompt.md";

const usage = (): void => {
  console.error(
    "Usage:\n" +
      "  pnpm sandcastle <issue>                # ./.sandcastle/prompt.md, against that issue\n" +
      "  pnpm sandcastle <prompt.md> <issue>    # a prompt beside it\n" +
      "  pnpm sandcastle                        # only for a prompt naming no issue\n\n" +
      `Prompts live in ${PROMPT_DIR}/. Copy ${DEFAULT_PROMPT} rather than editing it:\n` +
      `  cp ${PROMPT_DIR}/${DEFAULT_PROMPT} ${PROMPT_DIR}/prompt-issue-9.md\n`,
  );
};

// A bare number is read as the issue, because that is the common case.
const args = process.argv.slice(2);
const firstIsIssue = args[0] !== undefined && /^\d+$/.test(args[0]);
const promptArg = firstIsIssue ? DEFAULT_PROMPT : (args[0] ?? DEFAULT_PROMPT);
const issueArg = firstIsIssue ? args[0] : args[1];

const promptFile = promptArg.includes("/")
  ? promptArg
  : `${PROMPT_DIR}/${promptArg}`;

if (!existsSync(promptFile)) {
  console.error(`No prompt at "${promptFile}".\n`);
  usage();
  process.exit(1);
}

// `{{ISSUE}}` with no issue would fail after the sandbox is built; refuse here
// where it costs nothing.
const promptBody = readFileSync(promptFile, "utf8");
const needsIssue = promptBody.includes("{{ISSUE}}");

if (needsIssue && issueArg === undefined) {
  console.error(
    `"${promptFile}" contains {{ISSUE}}, so it needs an issue number.\n`,
  );
  usage();
  process.exit(1);
}

// Built rather than ternary'd: `{}` in a conditional widens to `{ ISSUE?: undefined }`,
// which Sandcastle's `PromptArgs` index signature refuses.
const promptArgs: Record<string, string> = {};
if (needsIssue && issueArg !== undefined) promptArgs.ISSUE = issueArg;

// `merge-to-head` gives the agent its own worktree and merges the result back
// onto the branch you launched from. On `main` that would put unreviewed agent
// commits straight onto the trunk, so it is refused.
const targetBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
  encoding: "utf8",
}).trim();

if (targetBranch === "main") {
  console.error(
    "Refusing to run on `main`: `merge-to-head` would merge unreviewed agent\n" +
      "commits onto the trunk. Cut a branch first, e.g.\n\n" +
      `  git checkout -b issue-9-walking-skeleton origin/main\n`,
  );
  process.exit(1);
}

console.log("Sandcastle run");
console.log(`  prompt   ${promptFile}`);
console.log(`  issue    ${issueArg === undefined ? "none" : `#${issueArg}`}`);
console.log(`  branch   ${targetBranch} (via merge-to-head)`);
console.log(`  CA       ${forwardCaCert ? hostCaCert : "none forwarded"}`);

const result = await run({
  agent: claudeCode("claude-opus-5-5", { effort: "high" }),
  sandbox: docker({
    mounts,
    env: forwardCaCert ? { NODE_EXTRA_CA_CERTS: caCertInSandbox } : {},
  }),
  promptFile,
  promptArgs,
  branchStrategy: { type: "merge-to-head" },
  maxIterations: 6,
  idleTimeoutSeconds: 1_800,
  hooks: {
    sandbox: {
      onSandboxReady: [...SETUP],
    },
  },
});

console.log(`\nDone. ${result.commits.length} commit(s) on ${targetBranch}.`);
console.log(
  `  signal   ${result.completionSignal ?? "none — hit maxIterations or the idle timeout"}`,
);
if (result.logFilePath) console.log(`  log      ${result.logFilePath}`);
// A dirty worktree is kept so uncommitted work survives a crash.
if (result.preservedWorktreePath) {
  console.log(
    `  kept     ${result.preservedWorktreePath} — uncommitted changes; \`git worktree remove\` when done`,
  );
}
