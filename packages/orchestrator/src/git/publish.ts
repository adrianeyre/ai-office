import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { GitIdentity } from "@ai-office/shared";

import { runGit } from "./command.ts";
import {
  gitEnvironment,
  withAgentTrailer,
  type TrailerAgent,
} from "./identity.ts";

// Pushing an issue's branch, as the GitHub App (PRD FR-19, FR-68 to
// FR-70; ADR 0002). The Agent's clone was in its sandbox, so its config
// and hooks are the Agent's: nothing runs there with a token that can
// write. Instead its branch is fetched into a fresh repository of AI
// Office's own. There each new commit is made again, authored and
// committed as the Floor's identity with the Agent's trailer, whatever
// the Agent set, and pushed from there.
//
// Before review the branch is also rebased onto the default branch as it
// is on GitHub (PRD FR-25.5), so work merged since the Agent began (an
// earlier issue it overlaps, or any other) is under it. Its commits are
// replayed there, committed as the Floor's identity, in a checkout of AI
// Office's own with hooks turned off, and the branch is pushed with a
// lease on what GitHub had. A rebase that conflicts is given up, and the
// branch is pushed as it was, saying which files conflicted.

export interface PublishOptions {
  /** The Agent's clone, holding `branch`. */
  readonly workspace: string;
  readonly branch: string;
  /**
   * Commits that were on GitHub before the Agent started (read from the
   * clone before it ran): they and their history are not the Agent's new
   * work, so they are left as they are.
   */
  readonly upstream: readonly string[];
  /** Who the commits are by (FR-68). */
  readonly identity: GitIdentity;
  /** Who did the work, for the trailer (FR-69). */
  readonly agent: TrailerAgent;
  /** Where to push: the repository's Git URL. */
  readonly url: string;
  /** An installation token that can write. A credential: never logged. */
  readonly token: string;
  /** Where to make the fresh repository; it is deleted afterwards. */
  readonly scratchDir: string;
  /**
   * The default branch to rebase the branch onto first, as it is at `url`,
   * if it has moved on since the branch began; no rebase without it.
   */
  readonly rebaseOnto?: string;
  readonly signal?: AbortSignal;
}

/** What rebasing the branch onto the default branch did. */
export type Rebase =
  /** The branch already had the default branch's head under it. */
  | {
      readonly outcome: "up_to_date";
      readonly onto: string;
      readonly base: string;
    }
  /** Its commits were replayed onto the default branch's head, `base`. */
  | {
      readonly outcome: "rebased";
      readonly onto: string;
      readonly base: string;
    }
  /** Replaying them conflicted in `files`: it was pushed as it was. */
  | {
      readonly outcome: "conflict";
      readonly onto: string;
      readonly base: string;
      readonly files: readonly string[];
    };

export interface Published {
  /** The commit the branch now points at on GitHub. */
  readonly sha: string;
  /**
   * The commits pushed that GitHub did not have, oldest first: the
   * Agent's new commits, and after a rebase every commit replayed.
   */
  readonly commits: readonly string[];
  /** The subject (its message's first line) of each of the Agent's new commits, oldest first. */
  readonly subjects: readonly string[];
  /** What rebasing it did, when asked to (`rebaseOnto`). */
  readonly rebase?: Rebase;
}

type Git = (
  step: string,
  args: readonly string[],
  options?: { readonly input?: string; readonly env?: Record<string, string> },
) => Promise<string>;

const separator = "\u001f";

/** What a commit says about itself. */
async function commitInfo(git: Git, sha: string) {
  const fields = await git("read a commit", [
    "show",
    "--no-patch",
    `--format=%T${separator}%an <%ae>${separator}%cn <%ce>${separator}%aI`,
    sha,
  ]);
  const [tree = "", author = "", committer = "", authorDate = ""] =
    fields.split(separator);
  // The message as it was written: `%B` would tidy it.
  const raw = await git("read a commit", ["cat-file", "commit", sha]);
  const message = raw.slice(raw.indexOf("\n\n") + 2);
  return { tree, author, committer, authorDate, message };
}

export async function publishBranch(
  options: PublishOptions,
): Promise<Published> {
  const repository = await mkdtemp(join(options.scratchDir, "publish-"));
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  const git: Git = (step, args, { input, env } = {}) =>
    runGit(step, args, {
      cwd: repository,
      ...(input === undefined ? {} : { input }),
      ...(env === undefined ? {} : { env }),
      ...signal,
    });
  try {
    await git("make a repository to push from", ["init", "--quiet", "--bare"]);
    // Nothing the Agent left in its clone runs here.
    await git("turn off hooks", ["config", "core.hooksPath", "/dev/null"]);
    await git(`fetch ${options.branch} from the Agent's clone`, [
      "fetch",
      "--quiet",
      "--no-tags",
      options.workspace,
      `+refs/heads/${options.branch}:refs/heads/${options.branch}`,
    ]);
    const head = await git("read the branch", [
      "rev-parse",
      "--verify",
      `refs/heads/${options.branch}^{commit}`,
    ]);
    // Upstream commits the branch is built on; the others do not matter.
    const upstream: string[] = [];
    for (const sha of options.upstream) {
      const found = await git("look for an upstream commit", [
        "cat-file",
        "-e",
        `${sha}^{commit}`,
      ]).then(
        () => true,
        () => false,
      );
      if (found) {
        upstream.push(sha);
      }
    }
    const list = await git("list the new commits", [
      "rev-list",
      "--reverse",
      "--topo-order",
      "--parents",
      head,
      ...(upstream.length === 0 ? [] : ["--not", ...upstream]),
    ]);

    const identity = gitEnvironment(options.identity);
    const owner = `${options.identity.name} <${options.identity.email}>`;
    const made = new Map<string, string>();
    const commits: string[] = [];
    const subjects: string[] = [];
    for (const line of list === "" ? [] : list.split("\n")) {
      const [sha = "", ...parents] = line.split(" ");
      const info = await commitInfo(git, sha);
      subjects.push(info.message.split("\n", 1)[0]?.trim() ?? "");
      const newParents = parents.map((parent) => made.get(parent) ?? parent);
      const message = withAgentTrailer(info.message, options.agent);
      const unchanged =
        info.author === owner &&
        info.committer === owner &&
        message.trimEnd() === info.message.trimEnd() &&
        newParents.every((parent, index) => parent === parents[index]);
      const stamped = unchanged
        ? sha
        : await git(
            "make a commit as the Owner",
            [
              "commit-tree",
              "--no-gpg-sign",
              info.tree,
              ...newParents.flatMap((parent) => ["-p", parent]),
              "-F",
              "-",
            ],
            {
              input: message,
              env: { ...identity, GIT_AUTHOR_DATE: info.authorDate },
            },
          );
      made.set(sha, stamped);
      commits.push(stamped);
    }
    const stamped = made.get(head) ?? head;

    const rebased =
      options.rebaseOnto === undefined
        ? undefined
        : await rebase(
            git,
            repository,
            options,
            options.rebaseOnto,
            stamped,
            identity,
          );
    const sha = rebased?.sha ?? stamped;
    await runGit(
      `push ${options.branch}`,
      [
        "push",
        "--quiet",
        "--no-verify",
        // Replayed commits replace what GitHub had, unless it changed meanwhile.
        ...(rebased?.rebase.outcome === "rebased"
          ? [
              `--force-with-lease=refs/heads/${options.branch}:${rebased.remote}`,
            ]
          : []),
        options.url,
        `${sha}:refs/heads/${options.branch}`,
      ],
      { cwd: repository, token: options.token, ...signal },
    );
    return {
      sha,
      commits: rebased?.commits ?? commits,
      subjects,
      ...(rebased === undefined ? {} : { rebase: rebased.rebase }),
    };
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

/**
 * Rebases `head` onto `onto` as it is at the remote: nothing to do when it
 * is already under `head`; otherwise `head`'s commits since the two parted
 * are replayed onto it, committed as the Floor's identity, in a checkout
 * beside `repository`. Answers the branch's head to push, the commits
 * GitHub does not have, and what the remote's branch was (empty for none),
 * for the push's lease. Undefined when that branch holds commits `head`
 * does not: they are not the Agent's to replace.
 */
async function rebase(
  git: Git,
  repository: string,
  options: PublishOptions,
  onto: string,
  head: string,
  identity: Readonly<Record<string, string>>,
): Promise<
  | {
      readonly sha: string;
      readonly commits?: string[];
      readonly remote: string;
      readonly rebase: Rebase;
    }
  | undefined
> {
  const signal = options.signal === undefined ? {} : { signal: options.signal };
  const withToken = { cwd: repository, token: options.token, ...signal };
  await runGit(
    `fetch ${onto}`,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      options.url,
      `+refs/heads/${onto}:refs/remotes/origin/${onto}`,
    ],
    withToken,
  );
  const base = await git(`read ${onto}`, [
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${onto}^{commit}`,
  ]);
  const upToDate = await git(`compare the branch with ${onto}`, [
    "merge-base",
    "--is-ancestor",
    base,
    head,
  ]).then(
    () => true,
    () => false,
  );
  if (upToDate) {
    return {
      sha: head,
      remote: "",
      rebase: { outcome: "up_to_date", onto, base },
    };
  }
  // What GitHub has on the branch now, which the push may replace only
  // when the Agent's work was built on it.
  const [remote = ""] = (
    await runGit(
      `read ${options.branch} on GitHub`,
      ["ls-remote", options.url, `refs/heads/${options.branch}`],
      withToken,
    )
  ).split(/\s/);
  const builtOn =
    remote === "" ||
    (await git(`compare the branch with ${options.branch} on GitHub`, [
      "merge-base",
      "--is-ancestor",
      remote,
      head,
    ]).then(
      () => true,
      () => false,
    ));
  if (!builtOn) {
    // Someone else's work is there: pushed as it is, GitHub refuses it.
    return undefined;
  }
  const parted = await git(`find where the branch left ${onto}`, [
    "merge-base",
    base,
    head,
  ]);
  const checkout = await mkdtemp(join(options.scratchDir, "rebase-"));
  const inCheckout = (
    step: string,
    args: readonly string[],
    env?: Readonly<Record<string, string>>,
  ) =>
    runGit(step, args, {
      cwd: checkout,
      ...(env === undefined ? {} : { env }),
      ...signal,
    });
  try {
    // Hooks are off in `repository`, and so in its checkouts.
    await git("check out the branch to rebase", [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      checkout,
      head,
    ]);
    const failed = await inCheckout(
      `rebase onto ${onto}`,
      ["rebase", "--quiet", "--onto", base, parted],
      identity,
    ).then(
      () => undefined,
      (error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
    );
    if (failed !== undefined) {
      const files = (
        await inCheckout("list the conflicting files", [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ])
      )
        .split("\n")
        .filter((file) => file !== "");
      if (files.length === 0) {
        throw failed;
      }
      await inCheckout("give up the rebase", ["rebase", "--abort"]);
      return {
        sha: head,
        remote,
        rebase: { outcome: "conflict", onto, base, files },
      };
    }
    const sha = await inCheckout("read the rebased branch", [
      "rev-parse",
      "HEAD",
    ]);
    const list = await git("list the rebased commits", [
      "rev-list",
      "--reverse",
      sha,
      "--not",
      base,
    ]);
    return {
      sha,
      commits: list === "" ? [] : list.split("\n"),
      remote,
      rebase: { outcome: "rebased", onto, base },
    };
  } finally {
    await git("remove the rebase's checkout", [
      "worktree",
      "remove",
      "--force",
      checkout,
    ]).catch(() => undefined);
    await rm(checkout, { recursive: true, force: true });
  }
}
