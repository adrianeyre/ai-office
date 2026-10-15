import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { publishBranch, type PublishOptions } from "./publish.ts";

// Pushing an issue's branch (PRD FR-19, FR-68, FR-69): only the Agent's
// new commits are made again, as the Owner with the Agent's trailer. Asked
// to, it is first rebased onto the default branch as GitHub has it
// (FR-25.5). A local bare repository stands in for GitHub's Git remote.

const git = promisify(execFile);
const identity = { name: "adrianeyre", email: "owner@example.com" };
const agent = {
  name: "Ada",
  role: "coder",
  aiProvider: "Claude",
  model: "claude-opus-5-5",
} as const;
const trailer = "Agent: Ada (coder, Claude claude-opus-5-5)";
const branch = "ai-office/4-add-a-basket";

let root: string;
let remote: string;
let clone: string;

/** Runs Git in `cwd` as a test helper, with `who` as author and committer. */
const gitAs = async (
  cwd: string,
  who: { name: string; email: string },
  ...args: string[]
) =>
  (
    await git(
      "git",
      ["-c", `user.name=${who.name}`, "-c", `user.email=${who.email}`, ...args],
      { cwd },
    )
  ).stdout.trim();
const seed = { name: "Seed", email: "seed@example.com" };
const gitIn = (cwd: string, ...args: string[]) => gitAs(cwd, seed, ...args);

const commit = async (
  who: { name: string; email: string },
  file: string,
  message: string,
  date?: string,
) => {
  await writeFile(join(clone, file), `${file}\n`);
  await gitIn(clone, "add", file);
  await gitAs(
    clone,
    who,
    "commit",
    "--quiet",
    ...(date === undefined ? [] : [`--date=${date}`]),
    "-m",
    message,
  );
  return gitIn(clone, "rev-parse", "HEAD");
};

const options = (upstream: string[]): PublishOptions => ({
  workspace: clone,
  branch,
  upstream,
  identity,
  agent,
  url: remote,
  token: "ghs_notused",
  scratchDir: root,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ai-office-publish-"));
  remote = join(root, "remote.git");
  clone = join(root, "clone");
  await git("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await git("git", ["init", "--quiet", "-b", "main", clone]);
  await commit(seed, "README.md", "chore: start");
  await gitIn(clone, "push", "--quiet", remote, "main");
  await gitIn(clone, "switch", "--quiet", "-c", branch);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("publishBranch", () => {
  it("makes the new commits as the Owner with the trailer, keeping their content and dates", async () => {
    const main = await gitIn(clone, "rev-parse", "main");
    const date = "2026-10-01T12:00:00+01:00";
    const first = await commit(
      { name: "Mallory", email: "mallory@example.com" },
      "basket.txt",
      "feat: a basket\n\nRefs #4",
      date,
    );
    await commit(identity, "total.txt", `feat: a total\n\n${trailer}`);

    const published = await publishBranch(options([main]));
    expect(published.commits).toHaveLength(2);
    expect(await gitIn(remote, "rev-parse", branch)).toBe(published.sha);
    expect(
      await gitIn(
        remote,
        "log",
        "--reverse",
        "--format=%an <%ae>|%cn <%ce>|%aI|%B%x1e",
        `main..${branch}`,
      ),
    ).toBe(
      [
        `adrianeyre <owner@example.com>|adrianeyre <owner@example.com>|${date}|feat: a basket\n\nRefs #4\n\n${trailer}\n\x1e`,
        `adrianeyre <owner@example.com>|adrianeyre <owner@example.com>|${(await gitIn(clone, "log", "-1", "--format=%aI")).trim()}|feat: a total\n\n${trailer}\n\x1e`,
      ].join("\n"),
    );
    // The same files, on the same base.
    expect(await gitIn(remote, "rev-parse", `${branch}^{tree}`)).toBe(
      await gitIn(clone, "rev-parse", "HEAD^{tree}"),
    );
    expect(
      await gitIn(remote, "rev-parse", `${published.commits[0] ?? ""}^`),
    ).toBe(main);
    expect(published.commits[0]).not.toBe(first);
    // The fresh repository is gone.
    expect(await readdir(root)).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/^publish-/)]),
    );
  });

  it("leaves commits that already follow the rules as they are", async () => {
    const main = await gitIn(clone, "rev-parse", "main");
    const proper = await commit(
      identity,
      "basket.txt",
      `feat: a basket\n\n${trailer}`,
    );
    const published = await publishBranch(options([main]));
    expect(published).toEqual({
      sha: proper,
      commits: [proper],
      subjects: ["feat: a basket"],
    });
  });

  it("carries on from a branch pushed before, touching none of its commits", async () => {
    const main = await gitIn(clone, "rev-parse", "main");
    const earlier = await commit(
      { name: "Someone", email: "someone@example.com" },
      "earlier.txt",
      "feat: earlier work",
    );
    await gitIn(clone, "push", "--quiet", remote, branch);
    await commit(identity, "basket.txt", "feat: a basket");

    const published = await publishBranch(options([main, earlier]));
    expect(published.commits).toHaveLength(1);
    expect(await gitIn(remote, "rev-parse", `${branch}^`)).toBe(earlier);
    expect(await gitIn(remote, "log", "-1", "--format=%an|%B", branch)).toBe(
      `adrianeyre|feat: a basket\n\n${trailer}`,
    );
  });

  it("fails, saying where, when the remote refuses the push", async () => {
    const main = await gitIn(clone, "rev-parse", "main");
    await commit(identity, "basket.txt", "feat: a basket");
    // Someone else's work is already on the branch: not a fast-forward.
    const other = join(root, "other");
    await git("git", ["clone", "--quiet", remote, other]);
    await gitIn(other, "switch", "--quiet", "-c", branch);
    await writeFile(join(other, "other.txt"), "other\n");
    await gitIn(other, "add", "other.txt");
    await gitIn(other, "commit", "--quiet", "-m", "other");
    await gitIn(other, "push", "--quiet", "origin", branch);

    const error = await publishBranch(options([main])).then(
      () => undefined,
      (failure: unknown) => failure as Error,
    );
    expect(error?.message).toMatch(
      /^Git could not push ai-office\/4-add-a-basket: /,
    );
    expect(error?.message).not.toContain("ghs_notused");
  });

  describe("rebasing onto the default branch first", () => {
    /** Someone merges `file` into main on GitHub, as a merged pull request would. */
    const mergeIntoMain = async (file: string, text: string) => {
      const other = join(root, `merge-${file}`);
      await git("git", ["clone", "--quiet", "--branch", "main", remote, other]);
      await writeFile(join(other, file), text);
      await gitIn(other, "add", file);
      await gitIn(other, "commit", "--quiet", "-m", `feat: ${file}`);
      await gitIn(other, "push", "--quiet", "origin", "main");
      return gitIn(other, "rev-parse", "HEAD");
    };

    it("replays the branch onto work merged since it began, as the Owner, over what GitHub had", async () => {
      const main = await gitIn(clone, "rev-parse", "main");
      const earlier = await commit(identity, "basket.txt", "feat: a basket");
      await gitIn(clone, "push", "--quiet", remote, branch);
      const date = "2026-10-01T12:00:00+01:00";
      await commit(
        { name: "Mallory", email: "mallory@example.com" },
        "total.txt",
        "feat: a total",
        date,
      );
      const merged = await mergeIntoMain("footer.txt", "footer\n");

      const published = await publishBranch({
        ...options([main, earlier]),
        rebaseOnto: "main",
      });

      expect(published.rebase).toEqual({
        outcome: "rebased",
        onto: "main",
        base: merged,
      });
      expect(await gitIn(remote, "rev-parse", branch)).toBe(published.sha);
      // Both of the branch's commits, now on the merged work.
      expect(
        await gitIn(
          remote,
          "log",
          "--reverse",
          "--format=%H %P",
          `main..${branch}`,
        ),
      ).toBe(
        `${published.commits[0] ?? ""} ${merged}\n${published.commits[1] ?? ""} ${published.commits[0] ?? ""}`,
      );
      expect(published.commits).toHaveLength(2);
      expect(published.subjects).toEqual(["feat: a total"]);
      expect(
        await gitIn(
          remote,
          "log",
          "--reverse",
          "--format=%an <%ae>|%cn <%ce>|%aI|%B%x1e",
          `main..${branch}`,
        ),
      ).toBe(
        [
          `adrianeyre <owner@example.com>|adrianeyre <owner@example.com>|${(await gitIn(clone, "log", "-1", "--format=%aI", earlier)).trim()}|feat: a basket\n\x1e`,
          `adrianeyre <owner@example.com>|adrianeyre <owner@example.com>|${date}|feat: a total\n\n${trailer}\n\x1e`,
        ].join("\n"),
      );
      expect(
        (await gitIn(remote, "ls-tree", "--name-only", branch)).split("\n"),
      ).toEqual(["README.md", "basket.txt", "footer.txt", "total.txt"]);
      expect(await readdir(root)).toEqual(
        expect.not.arrayContaining([
          expect.stringMatching(/^(publish|rebase)-/),
        ]),
      );
    });

    it("pushes as before when the branch already has the default branch under it", async () => {
      const main = await gitIn(clone, "rev-parse", "main");
      const proper = await commit(
        identity,
        "basket.txt",
        `feat: a basket\n\n${trailer}`,
      );
      const published = await publishBranch({
        ...options([main]),
        rebaseOnto: "main",
      });
      expect(published).toEqual({
        sha: proper,
        commits: [proper],
        subjects: ["feat: a basket"],
        rebase: { outcome: "up_to_date", onto: "main", base: main },
      });
    });

    it("pushes the branch as it was, naming the files, when the rebase conflicts", async () => {
      const main = await gitIn(clone, "rev-parse", "main");
      await commit(identity, "basket.txt", "feat: a basket");
      const merged = await mergeIntoMain(
        "basket.txt",
        "someone else's basket\n",
      );

      const published = await publishBranch({
        ...options([main]),
        rebaseOnto: "main",
      });

      expect(published.rebase).toEqual({
        outcome: "conflict",
        onto: "main",
        base: merged,
        files: ["basket.txt"],
      });
      expect(published.commits).toHaveLength(1);
      expect(await gitIn(remote, "rev-parse", `${branch}^`)).toBe(main);
      expect(await readdir(root)).toEqual(
        expect.not.arrayContaining([
          expect.stringMatching(/^(publish|rebase)-/),
        ]),
      );
    });

    it("does not replace a branch that changed on GitHub meanwhile", async () => {
      const main = await gitIn(clone, "rev-parse", "main");
      await commit(identity, "basket.txt", "feat: a basket");
      await mergeIntoMain("footer.txt", "footer\n");
      // Someone else's work is on the branch, which the Agent never saw.
      const other = join(root, "other");
      await git("git", ["clone", "--quiet", remote, other]);
      await gitIn(other, "switch", "--quiet", "-c", branch);
      await writeFile(join(other, "other.txt"), "other\n");
      await gitIn(other, "add", "other.txt");
      await gitIn(other, "commit", "--quiet", "-m", "other");
      await gitIn(other, "push", "--quiet", "origin", branch);
      const theirs = await gitIn(other, "rev-parse", "HEAD");

      const error = await publishBranch({
        ...options([main]),
        rebaseOnto: "main",
      }).then(
        () => undefined,
        (failure: unknown) => failure as Error,
      );
      expect(error?.message).toMatch(
        /^Git could not push ai-office\/4-add-a-basket: /,
      );
      expect(error?.message).not.toContain("ghs_notused");
      expect(await gitIn(remote, "rev-parse", branch)).toBe(theirs);
    });
  });
});
