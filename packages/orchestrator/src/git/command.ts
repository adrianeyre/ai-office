import { execFile } from "node:child_process";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

// Git on the host, as AI Office runs it: no prompts, no system or global
// config, and a token (when one is needed) given to Git through its
// environment (`GIT_CONFIG_*`), so it is in neither the command line nor
// any repository's config. Failures carry Git's own message, never
// anything that could hold the token.
//
// The repositories it runs in are often an Agent's: its sandbox could
// write their `.git` (config, hooks, `info/attributes`) and their
// `.gitattributes`. So nothing those name runs here, in the app (S1-1):
// every setting by which a repository can name a program for Git to run
// is set again on Git's command line, which wins over the repository's
// config and anything it includes; hooks are turned off; and only the
// transports AI Office uses are allowed, so no remote helper or SSH
// command runs either. Filter, diff and merge drivers have names of the
// repository's choosing, so the repository's are read first and each is
// emptied. A remote's own programs (`remote.<name>.uploadpack`,
// `receivepack`, `vcs`) cannot be set again, as Git keeps the first it
// reads, so Git is not run at all in a repository that names one.
// Reading the repository first is only sound while nothing writes it, so
// Git is never run in an Agent's repository while its sandbox runs.
//
// Sandcastle runs Git on the host too, as `git` on the PATH. AI Office
// puts its own `git` first there (`bin/git`, `guard.ts`), which runs each
// of those commands as this runs its own (S1-2); this never runs that one.

export interface GitOptions {
  /** The repository to run in; the current directory if absent. */
  readonly cwd?: string;
  /** A GitHub token for HTTPS. A credential: never logged. */
  readonly token?: string;
  /** More environment, such as `GIT_AUTHOR_NAME`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Written to Git's standard input. */
  readonly input?: string;
  readonly signal?: AbortSignal;
}

/** The directory of the `git` that guards Sandcastle's (`bin/git`). */
export const gitGuardDirectory = fileURLToPath(new URL("bin", import.meta.url));

/** `path` (a PATH) without the guard's `git`, so Git itself is found. */
export const withoutGitGuard = (path: string): string =>
  path
    .split(delimiter)
    .filter(
      (directory) =>
        directory.replace(/\/+$/, "") !== gitGuardDirectory.replace(/\/+$/, ""),
    )
    .join(delimiter);

/** Settings that could name a program, as AI Office has them. */
const neutral: readonly (readonly [string, string])[] = [
  // Every hook, `--no-verify` or not.
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["diff.external", ""],
  ["core.askPass", ""],
  ["credential.helper", ""],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["log.showSignature", "false"],
  ["merge.verifySignatures", "false"],
  // Run on a fetch into a repository with alternates, such as Sandcastle's
  // from origin (S1-2): `true` lists no refs, so Git reads none of theirs.
  ["core.alternateRefsCommand", "true"],
];

/** The repository's settings that name a driver's or a remote's program. */
const named =
  "^(filter\\..+\\.(clean|smudge|process|required)|diff\\..+\\.(command|textconv)|merge\\..+\\.driver|credential\\..+\\.helper|remote\\..+\\.(uploadpack|receivepack|vcs))$";

/** Those that cannot be set again: Git keeps the first it reads. */
const remoteProgram = /^remote\..+\.(uploadpack|receivepack|vcs)$/;

/** What each of those is set to instead: nothing to run. */
function neutralValue(key: string): string {
  return key.endsWith(".required") ? "false" : "";
}

/** Git's environment: no prompts, no system or global config, nothing the repository names, and the token. */
function environment(
  options: GitOptions,
  drivers: readonly string[],
): NodeJS.ProcessEnv {
  const config: (readonly [string, string])[] = [
    ...neutral,
    ...drivers.map((key) => [key, neutralValue(key)] as const),
    ...(options.token === undefined
      ? []
      : [
          [
            "http.extraHeader",
            `Authorization: Basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`,
          ] as const,
        ]),
  ];
  return {
    PATH: withoutGitGuard(process.env["PATH"] ?? ""),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file:https",
    GIT_EDITOR: ":",
    GIT_SEQUENCE_EDITOR: ":",
    GIT_PAGER: "cat",
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${String(index)}`, key],
        [`GIT_CONFIG_VALUE_${String(index)}`, value],
      ]),
    ),
    ...options.env,
  };
}

/** Git's own message, without anything that could carry the token. */
function failure(step: string, error: unknown): Error {
  const stderr = (error as { stderr?: unknown }).stderr;
  const detail =
    typeof stderr === "string" && stderr.trim() !== ""
      ? stderr.trim().split("\n").at(-1)
      : (error as Error).message.split("\n", 1)[0];
  return new Error(`Git could not ${step}: ${detail ?? "unknown error"}`, {
    cause: error,
  });
}

/** Spawns `git args` with `env`, resolving with its output; `step` names it in errors. */
function spawnGit(
  step: string,
  args: readonly string[],
  options: GitOptions,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        env,
        maxBuffer: 64 * 1024 * 1024,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout) => {
        if (error === null) {
          resolve(stdout);
        } else {
          reject(failure(step, error));
        }
      },
    );
    // Git may exit before reading it all: its exit status says what happened.
    child.stdin?.on("error", () => undefined);
    if (options.input === undefined) {
      child.stdin?.end();
    } else {
      child.stdin?.end(options.input);
    }
  });
}

/**
 * The drivers' and remotes' programs the repository at `cwd` names, in
 * its config or anything it includes. Reading config runs nothing. Git
 * exits 1 when it names none; anything else that stops it reading is a
 * failure of `step`, so Git is not run unread.
 */
async function namedPrograms(
  step: string,
  options: GitOptions,
): Promise<string[]> {
  const reading = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const listed = await spawnGit(
    step,
    ["config", "--null", "--get-regexp", named],
    reading,
    environment(reading, []),
  ).catch((error: unknown) => {
    if ((error as { cause?: { code?: unknown } }).cause?.code === 1) {
      return "";
    }
    throw error;
  });
  // Each `key\nvalue`, ended by NUL; a key never holds a newline.
  return [
    ...new Set(
      listed
        .split("\0")
        .filter((entry) => entry !== "")
        .map((entry) => entry.split("\n", 1)[0] ?? ""),
    ),
  ];
}

/**
 * Git's environment for a command in the repository at `options.cwd`,
 * which is read first: nothing it names runs. Rejects, as a failure of
 * `step`, when it cannot be read or names a remote's program.
 */
export async function gitEnvironment(
  step: string,
  options: GitOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const drivers = await namedPrograms(step, options);
  const remote = drivers.find((key) => remoteProgram.test(key));
  if (remote !== undefined) {
    throw failure(
      step,
      new Error(`the repository names a program for a remote (${remote})`),
    );
  }
  return environment(options, drivers);
}

/** Runs `git args`, resolving with its trimmed output; `step` names it in errors. */
export async function runGit(
  step: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  const env = await gitEnvironment(step, options);
  return (await spawnGit(step, args, options, env)).trim();
}
