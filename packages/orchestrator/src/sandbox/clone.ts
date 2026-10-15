import { runGit } from "../git/command.ts";

// Clones a Floor's repository on the host, for Sandcastle to make the
// sandbox's worktree from. The token is given to Git through its
// environment (`runGit`), so it is in neither the command line nor the
// clone's `.git/config`, which is mounted into the sandbox.

export interface CloneOptions {
  /** `https://github.com/owner/name.git`, or a fake's. */
  readonly url: string;
  /** A token that can read the repository. A credential: never logged. */
  readonly token: string;
  /** The branch to check out: the Floor's default branch. */
  readonly branch: string;
  /** Also fetched as a local branch, if given: the issue's own branch. */
  readonly alsoFetch?: string;
  /** An empty or missing directory to clone into. */
  readonly into: string;
  readonly signal?: AbortSignal;
}

export async function cloneRepository(options: CloneOptions): Promise<void> {
  const run = async (step: string, args: string[], cwd?: string) => {
    await runGit(step, args, {
      token: options.token,
      ...(cwd === undefined ? {} : { cwd }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  };
  await run("clone the repository", [
    "clone",
    "--quiet",
    "--no-tags",
    "--single-branch",
    "--branch",
    options.branch,
    options.url,
    options.into,
  ]);
  if (options.alsoFetch !== undefined) {
    await run(
      `fetch ${options.alsoFetch}`,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "origin",
        `+refs/heads/${options.alsoFetch}:refs/heads/${options.alsoFetch}`,
      ],
      options.into,
    );
  }
}
