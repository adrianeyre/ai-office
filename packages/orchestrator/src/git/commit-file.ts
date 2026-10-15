import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { GitIdentity } from "@ai-office/shared";

import { runGit } from "./command.ts";
import {
  gitEnvironment,
  withAgentTrailer,
  type TrailerAgent,
} from "./identity.ts";

// Committing files AI Office wrote itself, such as the Manager's curated
// memory (PRD FR-53) or a Grilling Session's documents (FR-80), and
// pushing them as the GitHub App (ADR 0002). No sandbox and no checkout:
// in a fresh bare repository, the branch it builds on is fetched, each
// file's new text is put in place of the old in that branch's tree, and
// one commit is made on top, authored and committed as the Floor's
// identity with the Agent's trailer. It is pushed to `to`, replacing what
// was there.

/** One file to commit: its path in the repository and its new text. */
export interface FileToCommit {
  readonly path: string;
  readonly content: string;
}

export interface CommitFilesOptions {
  /** Where to fetch from and push to: the repository's Git URL. */
  readonly url: string;
  /** An installation token that can write. A credential: never logged. */
  readonly token: string;
  /** The branch the commit builds on. */
  readonly from: string;
  /** The branch it is pushed to. */
  readonly to: string;
  readonly files: readonly FileToCommit[];
  readonly message: string;
  /** Who the commit is by (FR-68). */
  readonly identity: GitIdentity;
  /** Who did the work, for the trailer (FR-69). */
  readonly agent: TrailerAgent;
  /** Where to make the fresh repository; it is deleted afterwards. */
  readonly scratchDir: string;
  readonly signal?: AbortSignal;
  /**
   * Commit even when the files are already as given; otherwise nothing is
   * committed or pushed then.
   */
  readonly allowEmpty?: boolean;
}

export interface CommittedFiles {
  /** The new commit, now the head of `to`. */
  readonly sha: string;
  /** The commit it was made on: the head of `from`. */
  readonly base: string;
  /** The paths whose text it changed. */
  readonly changed: readonly string[];
}

export type CommitFileOptions = Omit<
  CommitFilesOptions,
  "files" | "allowEmpty"
> & {
  /** The file's path in the repository. */
  readonly path: string;
  readonly content: string;
};

export type CommittedFile = Omit<CommittedFiles, "changed">;

/** Commits one file on top of `from` and pushes it to `to`. */
export async function commitFile(
  options: CommitFileOptions,
): Promise<CommittedFile> {
  const { path, content, ...rest } = options;
  const committed = await commitFiles({
    ...rest,
    files: [{ path, content }],
    allowEmpty: true,
  });
  if (committed === undefined) {
    throw new Error(`Git could not commit ${path}.`);
  }
  return { sha: committed.sha, base: committed.base };
}

/**
 * Commits the files on top of `from` and pushes the commit to `to`;
 * undefined, with nothing pushed, when they are already as given (unless
 * `allowEmpty`).
 */
export async function commitFiles(
  options: CommitFilesOptions,
): Promise<CommittedFiles | undefined> {
  const repository = await mkdtemp(join(options.scratchDir, "commit-"));
  const index = { GIT_INDEX_FILE: join(repository, "ai-office-index") };
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  const git = (
    step: string,
    args: readonly string[],
    more: {
      readonly input?: string;
      readonly env?: Record<string, string>;
      readonly token?: string;
    } = {},
  ) =>
    runGit(step, args, {
      cwd: repository,
      ...(more.input === undefined ? {} : { input: more.input }),
      ...(more.env === undefined ? {} : { env: more.env }),
      ...(more.token === undefined ? {} : { token: more.token }),
      ...signal,
    });
  try {
    await git("make a repository to commit in", ["init", "--quiet", "--bare"]);
    await git("turn off hooks", ["config", "core.hooksPath", "/dev/null"]);
    await git(
      `fetch ${options.from}`,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth",
        "1",
        options.url,
        `+refs/heads/${options.from}:refs/heads/base`,
      ],
      { token: options.token },
    );
    const base = await git("read the branch", [
      "rev-parse",
      "--verify",
      "refs/heads/base^{commit}",
    ]);
    await git("read the branch's files", ["read-tree", base], { env: index });
    for (const file of options.files) {
      const blob = await git(
        "store the file",
        ["hash-object", "-w", "--stdin"],
        { input: file.content },
      );
      await git(
        "put the file in place",
        ["update-index", "--add", "--cacheinfo", `100644,${blob},${file.path}`],
        { env: index },
      );
    }
    const tree = await git("write the files", ["write-tree"], { env: index });
    const changed = (
      await git("compare the files", [
        "diff-tree",
        "-r",
        "--name-only",
        `${base}^{tree}`,
        tree,
      ])
    )
      .split("\n")
      .filter((path) => path !== "");
    if (changed.length === 0 && options.allowEmpty !== true) {
      return undefined;
    }
    const sha = await git(
      "make a commit as the Owner",
      ["commit-tree", "--no-gpg-sign", tree, "-p", base, "-F", "-"],
      {
        input: withAgentTrailer(options.message, options.agent),
        env: gitEnvironment(options.identity),
      },
    );
    await git(
      `push ${options.to}`,
      [
        "push",
        "--quiet",
        "--no-verify",
        options.url,
        `+${sha}:refs/heads/${options.to}`,
      ],
      { token: options.token },
    );
    return { sha, base, changed };
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}
