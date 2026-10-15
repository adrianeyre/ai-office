import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitHubApp, RepositoryClient } from "@ai-office/github";
import type { FakeGitHub } from "@ai-office/github/testing";

// For tests: the fake GitHub, knowing what is pushed to a local bare
// repository standing in for GitHub's Git remote, as GitHub knows what is
// pushed to it. Each call that reads a branch or a pull request first
// catches up with the remote: each branch's head, and its files, so a
// pull request's diff (or a file read at a branch) is what was pushed.

const git = promisify(execFile);

/** Runs Git in `cwd` as a test helper, not as AI Office. */
export const gitIn = async (cwd: string, ...args: string[]) =>
  (
    await git(
      "git",
      ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", ...args],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
    )
  ).stdout.trim();

/** A commit's files, by path; none for a commit the remote does not have. */
const filesAt = async (
  remote: string,
  sha: string,
): Promise<Map<string, string>> => {
  const known = await gitIn(remote, "cat-file", "-e", `${sha}^{commit}`).then(
    () => true,
    () => false,
  );
  const files = new Map<string, string>();
  if (!known) {
    return files;
  }
  const paths = (await gitIn(remote, "ls-tree", "-r", "--name-only", sha))
    .split("\n")
    .filter((path) => path !== "");
  for (const path of paths) {
    files.set(
      path,
      (
        await git("git", ["show", `${sha}:${path}`], {
          cwd: remote,
          maxBuffer: 16 * 1024 * 1024,
        })
      ).stdout,
    );
  }
  return files;
};

export function gitBackedGitHub(fake: FakeGitHub, remote: string): GitHubApp {
  const catchUp = async (client: RepositoryClient) => {
    const refs = await gitIn(
      remote,
      "for-each-ref",
      "--format=%(refname:short) %(objectname)",
      "refs/heads",
    );
    for (const line of refs.split("\n").filter((ref) => ref !== "")) {
      const [branch = "", sha = ""] = line.split(" ");
      const before = (await client.getBranch(branch))?.sha;
      if (before === sha) {
        continue;
      }
      const [old, next] = await Promise.all([
        before === undefined
          ? new Map<string, string>()
          : filesAt(remote, before),
        filesAt(remote, sha),
      ]);
      fake.pushCommit(client.fullName, branch, {
        sha,
        files: {
          ...Object.fromEntries([...old.keys()].map((path) => [path, null])),
          ...Object.fromEntries(next),
        },
      });
    }
  };
  return {
    installations: () => fake.installations(),
    repositories: () => fake.repositories(),
    repository(fullName) {
      const client = fake.repository(fullName);
      return {
        ...client,
        async getBranch(name) {
          await catchUp(client);
          return client.getBranch(name);
        },
        async createPullRequest(input) {
          await catchUp(client);
          return client.createPullRequest(input);
        },
        async listPullRequests(options) {
          await catchUp(client);
          return client.listPullRequests(options);
        },
        async getPullRequest(number) {
          await catchUp(client);
          return client.getPullRequest(number);
        },
        async compareCommits(base, head) {
          await catchUp(client);
          return client.compareCommits(base, head);
        },
        async listBranches(prefix) {
          await catchUp(client);
          return client.listBranches(prefix);
        },
        async compareBranches(base, head) {
          await catchUp(client);
          return client.compareBranches(base, head);
        },
        async getFileContent(path, ref) {
          await catchUp(client);
          return client.getFileContent(path, ref);
        },
        async listDirectory(path, ref) {
          await catchUp(client);
          return client.listDirectory(path, ref);
        },
      };
    },
  };
}
