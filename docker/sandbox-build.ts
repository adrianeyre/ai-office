// Builds the sandbox images, one per agent tool (PRD FR-16): `pnpm
// sandbox:build` builds them all, and `pnpm sandbox:build codex` (or
// `claude`, `opencode`) only those named. With `--missing` (`pnpm
// sandbox:ensure`, which `pnpm dev` runs first), only those whose tag is
// not built yet, so a new image version is built once and nothing else.
//
// Each is tagged as the orchestrator runs it (`sandboxImages`), and its
// `agent` user gets the UID and GID of the user running this, so files an
// Agent writes in the bind-mounted worktree belong to the user that runs
// AI Office. Build them as that user, or set AGENT_UID and AGENT_GID (in
// compose, the app runs as `node`, UID and GID 1000). Each tool's version
// is the one its image's package.json and package-lock.json pin, never one
// picked at build time.
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";

import { sandboxImages } from "../packages/orchestrator/src/sandbox/images.ts";

/** Each sandbox image: its agent tool, directory and npm package. */
export const sandboxImageSpecs = {
  claude: {
    tool: "Claude Code",
    directory: join(import.meta.dirname, "sandbox-claude"),
    npmPackage: "@anthropic-ai/claude-code",
  },
  codex: {
    tool: "Codex",
    directory: join(import.meta.dirname, "sandbox-codex"),
    npmPackage: "@openai/codex",
  },
  opencode: {
    tool: "opencode",
    directory: join(import.meta.dirname, "sandbox-opencode"),
    npmPackage: "opencode-ai",
  },
} as const;

export type SandboxImageName = keyof typeof sandboxImageSpecs;

export const sandboxImageNames = Object.keys(
  sandboxImageSpecs,
) as SandboxImageName[];

/** The tag the orchestrator runs an image as. */
export const sandboxImageTag = (name: SandboxImageName): string =>
  sandboxImages[sandboxImageSpecs[name].tool];

/** `docker build`'s arguments for the image `name`, given the environment. */
export function buildArguments(
  name: SandboxImageName,
  env: Readonly<Record<string, string | undefined>>,
  user: { readonly uid: number; readonly gid: number } = userInfo(),
): string[] {
  const id = (variable: string, fallback: number): string => {
    const value = env[variable] ?? String(fallback);
    if (!/^\d+$/.test(value)) {
      throw new Error(`${variable} must be a numeric ID, not "${value}".`);
    }
    return value;
  };
  // Root has no business owning an Agent's files: use the image's default.
  const uid = user.uid > 0 ? user.uid : 1000;
  const gid = user.gid > 0 ? user.gid : 1000;
  return [
    "build",
    "--tag",
    sandboxImageTag(name),
    "--build-arg",
    `AGENT_UID=${id("AGENT_UID", uid)}`,
    "--build-arg",
    `AGENT_GID=${id("AGENT_GID", gid)}`,
    sandboxImageSpecs[name].directory,
  ];
}

/** Whether the image `tag` is built, asking Docker. */
export function isBuilt(tag: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", tag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The images named on the command line; every one when none is. */
export function imagesToBuild(args: readonly string[]): SandboxImageName[] {
  for (const arg of args) {
    if (!(sandboxImageNames as readonly string[]).includes(arg)) {
      throw new Error(
        `There is no sandbox image "${arg}": choose from ${sandboxImageNames.join(", ")}.`,
      );
    }
  }
  return args.length === 0 ? sandboxImageNames : (args as SandboxImageName[]);
}

/**
 * The images to build for `args`: those named (or every one), and with
 * `--missing` only those `built` says are not built yet.
 */
export function imagesFor(
  args: readonly string[],
  built: (tag: string) => boolean = isBuilt,
): SandboxImageName[] {
  const missing = args.includes("--missing");
  const named = imagesToBuild(args.filter((arg) => arg !== "--missing"));
  return missing
    ? named.filter((name) => !built(sandboxImageTag(name)))
    : named;
}

if (import.meta.main) {
  const names = imagesFor(process.argv.slice(2));
  if (process.argv.includes("--missing")) {
    console.log(
      names.length === 0
        ? "The sandbox images are built."
        : `Building the sandbox images not built yet (${names.map(sandboxImageTag).join(", ")}): the first time takes a few minutes.`,
    );
  }
  for (const name of names) {
    const args = buildArguments(name, process.env);
    console.log(`docker ${args.join(" ")}`);
    execFileSync("docker", args, { stdio: "inherit" });
    console.log(`Built ${sandboxImageTag(name)}.`);
  }
}
