import { describe, expect, it } from "vitest";

import { GitHubError } from "./errors.ts";
import { createFakeGitHub } from "./fake.ts";

// The fake's scenario API: what happens on GitHub without the App. (What
// the App itself does is the contract suite's business.)

const repository = "adrianeyre/web-shop";

function setUp() {
  const fake = createFakeGitHub();
  fake.installRepository(repository);
  return { fake, repo: fake.repository(repository) };
}

describe("the fake GitHub's scenario API", () => {
  it("installs repositories, one installation per owner", async () => {
    const fake = createFakeGitHub();
    const webShop = fake.installRepository("adrianeyre/web-shop");
    fake.installRepository("adrianeyre/blog", {
      defaultBranch: "trunk",
      private: false,
    });
    expect(webShop).toMatchObject({
      fullName: "adrianeyre/web-shop",
      owner: "adrianeyre",
      name: "web-shop",
      defaultBranch: "main",
      private: true,
      htmlUrl: "https://github.com/adrianeyre/web-shop",
    });
    expect(await fake.installations()).toEqual([
      expect.objectContaining({ account: "adrianeyre" }),
    ]);
    expect(
      fake.installationRepositories(
        fake.installationOf("adrianeyre/blog") ?? 0,
      ),
    ).toHaveLength(2);
    expect(() => fake.installRepository("adrianeyre/web-shop")).toThrow();

    fake.uninstallRepository("adrianeyre/blog");
    expect((await fake.repositories()).map(({ name }) => name)).toEqual([
      "web-shop",
    ]);
    await expect(fake.repository("adrianeyre/blog").get()).rejects.toThrow(
      GitHubError,
    );
  });

  it("opens issues as the Owner, or as someone else", async () => {
    const { fake, repo } = setUp();
    const mine = fake.createIssue(repository, {
      title: "Add a basket",
      labels: ["ai-office"],
    });
    const theirs = fake.createIssue(repository, {
      title: "Please add dark mode",
      author: "a-stranger",
    });
    expect(mine).toMatchObject({ number: 1, author: "adrianeyre" });
    expect(theirs).toMatchObject({ number: 2, author: "a-stranger" });
    expect(
      (await repo.listIssues({ labels: ["ai-office"] })).map(
        ({ number }) => number,
      ),
    ).toEqual([1]);
  });

  it("edits an issue's title or body", async () => {
    const { fake, repo } = setUp();
    const { number } = fake.createIssue(repository, {
      title: "Basket",
      body: "Make it better.",
    });
    fake.editIssue(repository, number, { body: "Add a basket page." });
    expect(await repo.getIssue(number)).toMatchObject({
      title: "Basket",
      body: "Add a basket page.",
    });
    expect(
      fake.editIssue(repository, number, { title: "Add a basket" }),
    ).toMatchObject({ title: "Add a basket", body: "Add a basket page." });
    expect(() => fake.editIssue(repository, 99, { body: "" })).toThrow(
      GitHubError,
    );
  });

  it("labels and unlabels issues, creating labels as GitHub does", async () => {
    const { fake, repo } = setUp();
    const { number } = fake.createIssue(repository, { title: "Add a basket" });
    fake.setLabel(repository, number, "ai-office");
    fake.setLabel(repository, number, "needs-work");
    expect((await repo.getIssue(number)).labels).toEqual([
      "ai-office",
      "needs-work",
    ]);
    expect(fake.labels(repository).map(({ name }) => name)).toEqual([
      "ai-office",
      "needs-work",
    ]);
    fake.removeLabel(repository, number, "needs-work");
    expect((await repo.getIssue(number)).labels).toEqual(["ai-office"]);
  });

  it("records who labelled an issue: its owner, or whoever is named", async () => {
    const { fake, repo } = setUp();
    const { number } = fake.createIssue(repository, {
      title: "Please add dark mode",
      author: "a-stranger",
      labels: ["bug"],
    });
    fake.setLabel(repository, number, "ai-office", { actor: "a-stranger" });
    fake.removeLabel(repository, number, "ai-office", { actor: "a-stranger" });
    fake.setLabel(repository, number, "ai-office");
    // Adding a label it already has, or removing one it has not, is no event.
    fake.setLabel(repository, number, "ai-office");
    fake.removeLabel(repository, number, "needs-work");
    await repo.addLabels(number, ["needs-work"]);
    expect(
      (await repo.labelEvents(number)).map(({ action, label, actor }) => [
        action,
        label,
        actor,
      ]),
    ).toEqual([
      ["labeled", "bug", "a-stranger"],
      ["labeled", "ai-office", "a-stranger"],
      ["unlabeled", "ai-office", "a-stranger"],
      ["labeled", "ai-office", "adrianeyre"],
      ["labeled", "needs-work", "ai-office[bot]"],
    ]);
  });

  it("pushes commits, creating the branch", async () => {
    const { fake, repo } = setUp();
    const first = fake.pushCommit(repository, "ai-office/1-add-a-basket");
    expect(await repo.getBranch("ai-office/1-add-a-basket")).toEqual({
      name: "ai-office/1-add-a-basket",
      sha: first,
    });
    const second = fake.pushCommit(repository, "ai-office/1-add-a-basket");
    expect(second).not.toBe(first);
    expect((await repo.getBranch("ai-office/1-add-a-basket"))?.sha).toBe(
      second,
    );
    // A commit pushed to a real Git remote keeps its own sha.
    const real = "0123456789abcdef0123456789abcdef01234567";
    expect(
      fake.pushCommit(repository, "ai-office/1-add-a-basket", { sha: real }),
    ).toBe(real);
    expect((await repo.getBranch("ai-office/1-add-a-basket"))?.sha).toBe(real);
  });

  it("starts and finishes CI on a branch's head", async () => {
    const { fake, repo } = setUp();
    const sha = fake.pushCommit(repository, "ai-office/1-add-a-basket");
    fake.startCI(repository, "ai-office/1-add-a-basket");
    fake.startCI(repository, sha, { name: "lint" });
    expect(await repo.listCheckRuns(sha)).toEqual([
      expect.objectContaining({
        name: "CI",
        status: "in_progress",
        conclusion: null,
      }),
      expect.objectContaining({ name: "lint", status: "in_progress" }),
    ]);

    fake.finishCI(repository, "ai-office/1-add-a-basket");
    fake.finishCI(repository, sha, { name: "lint", conclusion: "failure" });
    expect(
      (await repo.listCheckRuns("ai-office/1-add-a-basket")).map(
        ({ name, status, conclusion, headSha }) => [
          name,
          status,
          conclusion,
          headSha,
        ],
      ),
    ).toEqual([
      ["CI", "completed", "success", sha],
      ["lint", "completed", "failure", sha],
    ]);
    // A new commit has no check runs yet.
    fake.pushCommit(repository, "ai-office/1-add-a-basket");
    expect(await repo.listCheckRuns("ai-office/1-add-a-basket")).toEqual([]);
  });

  it("compares two commits by the smallest diff of each file's lines", async () => {
    const { fake, repo } = setUp();
    const before = fake.pushCommit(repository, "main", {
      files: {
        "src/basket.ts": "one\ntwo\nthree\nfour\n",
        "old.txt": "gone soon\n",
      },
    });
    const after = fake.pushCommit(repository, "main", {
      files: {
        "src/basket.ts": "one\n2\nthree\nfour\nfive\n",
        "old.txt": null,
      },
    });
    expect(await repo.compareCommits(before, after)).toEqual([
      {
        path: "old.txt",
        status: "removed",
        additions: 0,
        deletions: 1,
        patch: "@@ -1,1 +0,0 @@\n-gone soon",
      },
      {
        path: "src/basket.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: expect.stringContaining("+five") as string,
      },
    ]);
    await expect(repo.compareCommits(before, "f".repeat(40))).rejects.toThrow(
      /Not Found/,
    );
  });

  it("keeps each commit's files, and compares a pull request's branches", async () => {
    const { fake, repo } = setUp();
    fake.pushCommit(repository, "main", {
      files: { "README.md": "# Web shop\n", "old.txt": "gone soon\n" },
    });
    fake.pushCommit(repository, "ai-office/1-basket", {
      files: {
        "src/basket.ts": "export const basket = [];\n",
        "README.md": "# Web shop\n\nNow with a basket.\n",
        "old.txt": null,
      },
    });
    const pull = await repo.createPullRequest({
      title: "Add a basket",
      body: "Closes #1",
      head: "ai-office/1-basket",
      base: "main",
    });
    expect(await repo.listPullRequestFiles(pull.number)).toEqual([
      {
        path: "README.md",
        status: "modified",
        patch:
          "@@ -1,1 +1,3 @@\n-# Web shop\n+# Web shop\n+\n+Now with a basket.",
      },
      {
        path: "old.txt",
        status: "removed",
        patch: "@@ -1,1 +0,0 @@\n-gone soon",
      },
      {
        path: "src/basket.ts",
        status: "added",
        patch: "@@ -0,0 +1,1 @@\n+export const basket = [];",
      },
    ]);
    expect(await repo.getFileContent("old.txt", "main")).toBe("gone soon\n");
    expect(
      await repo.getFileContent("old.txt", "ai-office/1-basket"),
    ).toBeUndefined();

    const review = await repo.createReview(pull.number, {
      body: "Changes requested.",
      comments: [{ path: "README.md", line: 3, body: "Say what it does." }],
    });
    expect(fake.reviewComments(repository, pull.number)).toEqual([
      {
        reviewId: review.id,
        path: "README.md",
        line: 3,
        body: "Say what it does.",
      },
    ]);
    for (const [path, line] of [
      ["old.txt", 1],
      ["README.md", 4],
      ["elsewhere.md", 1],
    ] as const) {
      await expect(
        repo.createReview(pull.number, {
          body: "Off the diff.",
          comments: [{ path, line, body: "No." }],
        }),
      ).rejects.toMatchObject({ status: 422 });
    }
  });

  it("acts as the App's bot", async () => {
    const fake = createFakeGitHub({ appSlug: "ai-office-dev" });
    fake.installRepository(repository);
    const issue = await fake
      .repository(repository)
      .createIssue({ title: "Filed by the Manager" });
    expect(issue.author).toBe("ai-office-dev[bot]");
    expect(fake.botLogin).toBe("ai-office-dev[bot]");
  });

  it("keeps each commit's parents, message, author and time, as a branch's history", async () => {
    const { fake, repo } = setUp();
    const at = new Date("2026-10-01T09:00:00.000Z");
    const first = fake.pushCommit(repository, "ai-office/4-add-a-basket", {
      message: "Add a basket\n\nAgent: Ada (coder, Claude claude-opus-5-5)",
      author: "Adrian Eyre",
      authoredAt: at,
    });
    const main = fake.pushCommit(repository, "main");
    const comparison = await repo.compareBranches(
      "main",
      "ai-office/4-add-a-basket",
    );
    expect(comparison).toMatchObject({ aheadBy: 1, behindBy: 1 });
    expect(comparison.mergeBase.message).toBe("Initial commit");
    expect(comparison.mergeBase.author).toBe("adrianeyre");
    expect(comparison.commits).toEqual([
      {
        sha: first,
        message: "Add a basket\n\nAgent: Ada (coder, Claude claude-opus-5-5)",
        author: "Adrian Eyre",
        authoredAt: at.toISOString(),
        htmlUrl: `https://github.com/${repository}/commit/${first}`,
      },
    ]);
    // By commit as well as by branch.
    expect(await repo.compareBranches(main, first)).toEqual(comparison);
  });

  it("merges with two parents, and squashes or rebases with one, as GitHub does", async () => {
    for (const method of ["merge", "squash", "rebase"] as const) {
      const { fake, repo } = setUp();
      const branch = `ai-office/${method}`;
      fake.pushCommit(repository, branch);
      fake.pushCommit(repository, branch);
      const pull = await repo.createPullRequest({
        title: "Work",
        body: "",
        head: branch,
        base: "main",
      });
      await repo.mergePullRequest(pull.number, { method });
      // A merged branch is behind by the merge commit; squashed or
      // rebased, its own commits are still not the default branch's.
      expect(await repo.compareBranches("main", branch)).toMatchObject(
        method === "merge"
          ? { aheadBy: 0, behindBy: 1 }
          : { aheadBy: 2, behindBy: 1 },
      );
    }
  });

  it("mints tokens that expire after an hour", () => {
    const clock = { now: new Date("2026-10-08T12:00:00.000Z") };
    const fake = createFakeGitHub({ now: () => clock.now });
    fake.installRepository(repository);
    const installation = fake.installationOf(repository) ?? 0;
    const { token, expiresAt } = fake.mintToken(installation, ["web-shop"]);
    expect(expiresAt).toEqual(new Date("2026-10-08T13:00:00.000Z"));
    expect(fake.tokenScope(token)).toEqual({
      installationId: installation,
      repositories: ["adrianeyre/web-shop"],
      expiresAt,
    });
    clock.now = expiresAt;
    expect(fake.tokenScope(token)).toBeUndefined();
    expect(() => fake.mintToken(installation, ["elsewhere"])).toThrow(
      GitHubError,
    );
  });
});
