// The contract suite (PRD §9): one set of tests for everything AI Office
// asks of GitHub, run against
// - the in-memory fake GitHub;
// - the real App client (Octokit, JWTs, installation tokens) against the
//   fake served over HTTP;
// - the real App on a real repository, when GITHUB_CONTRACT_APP_ID is set
//   (skipped otherwise). It needs GITHUB_CONTRACT_APP_PRIVATE_KEY too, and
//   works on
//   GITHUB_CONTRACT_REPOSITORY (`adrianeyre/ai-office-sandbox` by default),
//   which it changes: it opens and closes issues, and merges a pull request
//   that adds a file under `ai-office-contract/`.
//
// So the fake behaves as GitHub does wherever AI Office can tell.
import { randomBytes } from "node:crypto";

import { Octokit } from "@octokit/rest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createGitHubApp, defaultGitHubApiUrl } from "./app.ts";
import { GitHubError } from "./errors.ts";
import { createFakeGitHub } from "./fake.ts";
import { createAppKeys, serveFakeGitHub } from "./fake-server.ts";
import {
  maxComparedCommits,
  type CheckRunConclusion,
  type GitHubApp,
  type RepositoryClient,
} from "./types.ts";

interface ContractFile {
  readonly path: string;
  readonly content: string;
}

interface Harness {
  readonly app: GitHubApp;
  /** `owner/name` of a repository the App is installed on. */
  readonly repository: string;
  /**
   * A commit adding `file` lands on `branch` (as `git push` would);
   * returns its sha.
   */
  pushCommit(branch: string, file: ContractFile): Promise<string>;
  /** CI reports `conclusion` for the commit `sha`, as a check run. */
  finishCI(sha: string, conclusion: CheckRunConclusion): Promise<void>;
  /**
   * Someone edits the issue's title or body: a collaborator on the fakes,
   * the App itself on GitHub.
   */
  editIssue(
    issue: number,
    changes: { readonly title?: string; readonly body?: string },
  ): Promise<void>;
  /**
   * The Owner protects `branch`, requiring the checks named; absent for
   * the real App, which cannot change a repository's settings.
   */
  readonly requireChecks?: (branch: string, names: readonly string[]) => void;
  /**
   * `count` commits land on `branch` at once, as a long-lived branch's
   * would; absent for the real App, which would push them one by one.
   */
  readonly pushCommits?: (branch: string, count: number) => void;
  /** GitHub's REST API, for calls with a token; absent in memory. */
  readonly apiUrl?: string;
  close(): Promise<void>;
}

interface Target {
  readonly name: string;
  /** Why it is skipped, if it is. */
  readonly skip?: string;
  setUp(): Promise<Harness>;
}

const fakeRepository = "adrianeyre/web-shop";

const inMemory: Target = {
  name: "the in-memory fake GitHub",
  setUp() {
    const fake = createFakeGitHub();
    fake.installRepository(fakeRepository);
    return Promise.resolve({
      app: fake,
      repository: fakeRepository,
      pushCommit: (branch, { path, content }) =>
        Promise.resolve(
          fake.pushCommit(fakeRepository, branch, {
            files: { [path]: content },
          }),
        ),
      finishCI: (sha, conclusion) => {
        fake.finishCI(fakeRepository, sha, { conclusion });
        return Promise.resolve();
      },
      editIssue: (issue, changes) => {
        fake.editIssue(fakeRepository, issue, changes, { actor: "mallory" });
        return Promise.resolve();
      },
      requireChecks: (branch, names) => {
        fake.requireChecks(fakeRepository, branch, names);
      },
      pushCommits: (branch, count) => {
        for (let commit = 0; commit < count; commit += 1) {
          fake.pushCommit(fakeRepository, branch);
        }
      },
      close: () => Promise.resolve(),
    });
  },
};

const overHttp: Target = {
  name: "the App client against the fake GitHub over HTTP",
  async setUp() {
    const fake = createFakeGitHub();
    fake.installRepository(fakeRepository);
    const { privateKey, publicKey } = createAppKeys();
    const server = await serveFakeGitHub(fake, { appId: "4242", publicKey });
    return {
      app: createGitHubApp({ appId: "4242", privateKey, baseUrl: server.url }),
      repository: fakeRepository,
      apiUrl: server.url,
      pushCommit: (branch, { path, content }) =>
        Promise.resolve(
          fake.pushCommit(fakeRepository, branch, {
            files: { [path]: content },
          }),
        ),
      finishCI: (sha, conclusion) => {
        fake.finishCI(fakeRepository, sha, { conclusion });
        return Promise.resolve();
      },
      editIssue: (issue, changes) => {
        fake.editIssue(fakeRepository, issue, changes, { actor: "mallory" });
        return Promise.resolve();
      },
      requireChecks: (branch, names) => {
        fake.requireChecks(fakeRepository, branch, names);
      },
      pushCommits: (branch, count) => {
        for (let commit = 0; commit < count; commit += 1) {
          fake.pushCommit(fakeRepository, branch);
        }
      },
      close: () => server.close(),
    };
  },
};

// Not GITHUB_APP_ID: AI Office keeps its Apps in the database, and refuses
// to start with that left in `.env` (ADR 0011).
const realAppId = process.env["GITHUB_CONTRACT_APP_ID"];
const realApp: Target = {
  name: "the real App",
  ...(realAppId === undefined || realAppId === ""
    ? {
        skip: "GITHUB_CONTRACT_APP_ID is not set, so the contract suite does not run against the real App.",
      }
    : {}),
  setUp() {
    const privateKey = (
      process.env["GITHUB_CONTRACT_APP_PRIVATE_KEY"] ?? ""
    ).replaceAll("\\n", "\n");
    const baseUrl = process.env["GITHUB_API_URL"] ?? defaultGitHubApiUrl;
    const repository =
      process.env["GITHUB_CONTRACT_REPOSITORY"] ??
      "adrianeyre/ai-office-sandbox";
    const app = createGitHubApp({
      appId: realAppId ?? "",
      privateKey,
      baseUrl,
    });
    const [owner = "", repo = ""] = repository.split("/");
    // What happens on GitHub without the App, done here with its token.
    const direct = async (): Promise<Octokit> =>
      new Octokit({
        baseUrl,
        auth: (await app.repository(repository).installationToken()).token,
      });
    return Promise.resolve({
      app,
      repository,
      apiUrl: baseUrl,
      async pushCommit(branch, { path, content }) {
        const octokit = await direct();
        const { data } = await octokit.rest.repos.createOrUpdateFileContents({
          owner,
          repo,
          branch,
          path,
          message: "test: a commit from the AI Office contract suite",
          content: Buffer.from(content).toString("base64"),
        });
        return data.commit.sha ?? "";
      },
      async finishCI(sha, conclusion) {
        await (
          await direct()
        ).rest.checks.create({
          owner,
          repo,
          name: "CI",
          head_sha: sha,
          status: "completed",
          conclusion,
        });
      },
      async editIssue(issue, changes) {
        await (
          await direct()
        ).rest.issues.update({ owner, repo, issue_number: issue, ...changes });
      },
      close: () => Promise.resolve(),
    });
  },
};

const rejectsWith = async (
  promise: Promise<unknown>,
  status: number,
): Promise<void> => {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(GitHubError);
  expect((error as GitHubError).status).toBe(status);
};

for (const target of [inMemory, overHttp, realApp]) {
  describe.skipIf(target.skip !== undefined)(
    `the GitHub contract, against ${target.name}`,
    () => {
      const run = randomBytes(4).toString("hex");
      const label = `ai-office-contract-${run}`;
      let harness: Harness;
      let repo: RepositoryClient;
      const issues: number[] = [];
      const branches: string[] = [];

      beforeAll(async () => {
        harness = await target.setUp();
        repo = harness.app.repository(harness.repository);
      });

      afterAll(async () => {
        // Leave the repository as it was found, as far as can be.
        for (const issue of issues) {
          await repo.closeIssue(issue).catch(() => undefined);
        }
        for (const branch of branches) {
          await repo.deleteBranch(branch).catch(() => undefined);
        }
        await harness.close();
      });

      const openIssue = async (title: string, labels: string[] = []) => {
        const issue = await repo.createIssue({
          title: `${title} (${run})`,
          body: "Opened by the AI Office contract suite.",
          labels,
        });
        issues.push(issue.number);
        return issue;
      };

      it("finds the repository among the App's installations", async () => {
        const installations = await harness.app.installations();
        expect(installations.length).toBeGreaterThan(0);
        const repositories = await harness.app.repositories();
        const found = repositories.find(
          ({ fullName }) =>
            fullName.toLowerCase() === harness.repository.toLowerCase(),
        );
        expect(found).toBeDefined();

        const repository = await repo.get();
        expect(repository).toEqual(found);
        expect(repository.fullName.toLowerCase()).toBe(
          harness.repository.toLowerCase(),
        );
        expect(repository.defaultBranch).not.toBe("");
        expect(repository.htmlUrl).toMatch(/^https:\/\//);
      });

      it("mints an installation token for the repository", async () => {
        const { token, expiresAt } = await repo.installationToken();
        expect(token).toMatch(/^ghs_/);
        expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(50 * 60_000);
      });

      it("mints a read-only token that can read but not write", async () => {
        const { token, expiresAt } = await repo.readOnlyToken();
        expect(token).toMatch(/^ghs_/);
        expect(token).not.toBe((await repo.installationToken()).token);
        expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(50 * 60_000);
        if (harness.apiUrl === undefined) {
          return;
        }
        const issue = await openIssue("An issue a sandbox reads");
        const [owner = "", name = ""] = harness.repository.split("/");
        const readOnly = new Octokit({ baseUrl: harness.apiUrl, auth: token });
        const read = await readOnly.rest.issues.get({
          owner,
          repo: name,
          issue_number: issue.number,
        });
        expect(read.data.title).toBe(issue.title);
        const write = await readOnly.rest.issues
          .createComment({
            owner,
            repo: name,
            issue_number: issue.number,
            body: "A sandbox must not be able to write this.",
          })
          .then(
            () => undefined,
            (failure: unknown) => failure as { status?: number },
          );
        expect(write?.status).toBe(403);
        expect(await repo.listComments(issue.number)).toEqual([]);
      });

      it("opens, finds, lists and closes an issue", async () => {
        const opened = await openIssue("An issue", [label]);
        expect(opened).toMatchObject({
          state: "open",
          labels: [label],
          body: "Opened by the AI Office contract suite.",
        });
        expect(opened.author).toMatch(/\[bot\]$/);
        expect(await repo.getIssue(opened.number)).toEqual(opened);

        const listed = await repo.listIssues({ labels: [label] });
        expect(listed.map(({ number }) => number)).toEqual([opened.number]);

        const closed = await repo.closeIssue(opened.number);
        expect(closed.state).toBe("closed");
        expect(await repo.listIssues({ labels: [label] })).toEqual([]);
        expect(
          (await repo.listIssues({ labels: [label], state: "closed" })).map(
            ({ number }) => number,
          ),
        ).toEqual([opened.number]);
      });

      it("creates labels, and adds and removes them", async () => {
        const name = `${label}-stage`;
        await repo.ensureLabel({
          name,
          color: "1d76db",
          description: "A stage",
        });
        // A second time is no change and no failure.
        await repo.ensureLabel({ name, color: "1d76db" });

        const issue = await openIssue("A labelled issue");
        expect(await repo.addLabels(issue.number, [name, label])).toEqual(
          expect.arrayContaining([name, label]),
        );
        await repo.removeLabel(issue.number, name);
        expect((await repo.getIssue(issue.number)).labels).toEqual([label]);
        // Removing a label the issue does not have changes nothing.
        await repo.removeLabel(issue.number, name);
        expect((await repo.getIssue(issue.number)).labels).toEqual([label]);
      });

      it("renames a label, which its issues keep under the new name", async () => {
        const before = `${label}-before`;
        const after = `${label}-after`;
        await repo.ensureLabel({ name: before, color: "1d76db" });
        const issue = await openIssue("An issue whose label is renamed", [
          label,
          before,
        ]);
        expect(
          await repo.renameLabel(before, {
            name: after,
            color: "0e8a16",
            description: "Renamed",
          }),
        ).toBe(true);
        expect((await repo.getIssue(issue.number)).labels).toEqual(
          expect.arrayContaining([label, after]),
        );
        expect((await repo.getIssue(issue.number)).labels).not.toContain(
          before,
        );
        // A label the repository does not have is not renamed.
        expect(await repo.renameLabel(before, { name: after })).toBe(false);
        // Nor is one renamed to a name another label has.
        await repo.ensureLabel({ name: before, color: "1d76db" });
        await rejectsWith(repo.renameLabel(before, { name: after }), 422);
      });

      it("records who added and removed an issue's labels", async () => {
        const name = `${label}-actor`;
        const issue = await openIssue("An issue labelled by the App", [label]);
        await repo.addLabels(issue.number, [name]);
        await repo.removeLabel(issue.number, name);
        // GitHub may take a moment to list an issue's events.
        await expect
          .poll(
            async () =>
              (await repo.labelEvents(issue.number)).map(
                ({ action, label: labelName }) => [action, labelName],
              ),
            { timeout: 15_000 },
          )
          .toEqual([
            ["labeled", label],
            ["labeled", name],
            ["unlabeled", name],
          ]);
        for (const event of await repo.labelEvents(issue.number)) {
          expect(event.actor).toMatch(/\[bot\]$/);
          expect(Number.isNaN(Date.parse(event.createdAt))).toBe(false);
        }
      });

      it("keeps every version of an issue's title and body, oldest first, the first written by the App that opened it", async () => {
        const issue = await openIssue("A versioned issue");
        const unedited = await repo.issueVersions(issue.number);
        expect(
          unedited.map(({ title, body, byApp }) => ({ title, body, byApp })),
        ).toEqual([
          {
            title: issue.title,
            body: "Opened by the AI Office contract suite.",
            byApp: true,
          },
        ]);
        await harness.editIssue(issue.number, { body: "Edited once." });
        await harness.editIssue(issue.number, {
          title: `${issue.title}, renamed`,
        });
        await harness.editIssue(issue.number, { body: "Edited twice." });
        // GitHub may take a moment to list an issue's history.
        await expect
          .poll(
            async () =>
              (await repo.issueVersions(issue.number)).map(
                ({ title, body, byApp }) => ({ title, body, byApp }),
              ),
            { timeout: 15_000 },
          )
          .toEqual([
            {
              title: issue.title,
              body: "Opened by the AI Office contract suite.",
              byApp: true,
            },
            { title: issue.title, body: "Edited once.", byApp: false },
            {
              title: `${issue.title}, renamed`,
              body: "Edited once.",
              byApp: false,
            },
            {
              title: `${issue.title}, renamed`,
              body: "Edited twice.",
              byApp: false,
            },
          ]);
        const versions = await repo.issueVersions(issue.number);
        for (const [index, version] of versions.entries()) {
          expect(Number.isNaN(Date.parse(version.at))).toBe(false);
          expect(Date.parse(version.at)).toBeGreaterThanOrEqual(
            Date.parse(versions[index - 1]?.at ?? version.at),
          );
        }
        await rejectsWith(repo.issueVersions(999_999), 404);
      });

      it("comments on an issue, and lists the comments oldest first", async () => {
        const issue = await openIssue("A discussed issue");
        const first = await repo.createComment(issue.number, "Picked up.");
        const second = await repo.createComment(issue.number, "Plan ready.");
        expect(first.author).toMatch(/\[bot\]$/);
        expect(first.htmlUrl).toBe(
          `${issue.htmlUrl}#issuecomment-${String(first.id)}`,
        );
        expect(
          (await repo.listComments(issue.number)).map(({ id, body }) => [
            id,
            body,
          ]),
        ).toEqual([
          [first.id, "Picked up."],
          [second.id, "Plan ready."],
        ]);
      });

      it("edits a comment in place, by its id", async () => {
        const issue = await openIssue("An issue with progress");
        const comment = await repo.createComment(issue.number, "Starting.");
        const edited = await repo.updateComment(comment.id, "Halfway there.");
        expect(edited).toMatchObject({
          id: comment.id,
          body: "Halfway there.",
          author: comment.author,
        });
        expect(
          (await repo.listComments(issue.number)).map(({ id, body }) => [
            id,
            body,
          ]),
        ).toEqual([[comment.id, "Halfway there."]]);
        await expect(
          repo.updateComment(comment.id + 1_000_000, "Nobody's."),
        ).rejects.toMatchObject({ status: 404 });
      });

      it("creates, finds and deletes a branch", async () => {
        const { defaultBranch } = await repo.get();
        const base = await repo.getBranch(defaultBranch);
        expect(base?.sha).toMatch(/^[0-9a-f]{40}$/);

        const name = `ai-office/contract-${run}-branch`;
        branches.push(name);
        expect(await repo.createBranch(name, base?.sha ?? "")).toEqual({
          name,
          sha: base?.sha,
        });
        expect(await repo.getBranch(name)).toEqual({ name, sha: base?.sha });
        await rejectsWith(repo.createBranch(name, base?.sha ?? ""), 422);

        await repo.deleteBranch(name);
        expect(await repo.getBranch(name)).toBeUndefined();
        expect(await repo.getBranch(`no-such-branch-${run}`)).toBeUndefined();
      });

      it("lists the checks a branch requires before a merge", async () => {
        const { defaultBranch } = await repo.get();
        await rejectsWith(repo.requiredChecks(`no-such-branch-${run}`), 404);
        if (harness.requireChecks === undefined) {
          // Whatever the repository's protection requires, by name.
          const names = await repo.requiredChecks(defaultBranch);
          expect(names.every((name) => name !== "")).toBe(true);
          expect(new Set(names).size).toBe(names.length);
          return;
        }
        expect(await repo.requiredChecks(defaultBranch)).toEqual([]);
        harness.requireChecks(defaultBranch, ["CI", "lint"]);
        expect(await repo.requiredChecks(defaultBranch)).toEqual([
          "CI",
          "lint",
        ]);
        harness.requireChecks(defaultBranch, []);
        expect(await repo.requiredChecks(defaultBranch)).toEqual([]);
      });

      it("compares two commits, counting each file's lines", async () => {
        const { defaultBranch } = await repo.get();
        const base = await repo.getBranch(defaultBranch);
        const branch = `ai-office-contract-compare-${run}`;
        branches.push(branch);
        await repo.createBranch(branch, base?.sha ?? "");
        const directory = `ai-office-contract/${randomBytes(6).toString("hex")}`;
        const first = await harness.pushCommit(branch, {
          path: `${directory}/one.md`,
          content: "One.\nTwo.\n",
        });
        const second = await harness.pushCommit(branch, {
          path: `${directory}/two.md`,
          content: "Three.\n",
        });

        expect(await repo.compareCommits(first, second)).toEqual([
          {
            path: `${directory}/two.md`,
            status: "added",
            additions: 1,
            deletions: 0,
            patch: expect.stringContaining("+Three.") as string,
          },
        ]);
        expect(await repo.compareCommits(base?.sha ?? "", second)).toEqual([
          {
            path: `${directory}/one.md`,
            status: "added",
            additions: 2,
            deletions: 0,
            patch: expect.stringContaining("+Two.") as string,
          },
          {
            path: `${directory}/two.md`,
            status: "added",
            additions: 1,
            deletions: 0,
            patch: expect.stringContaining("+Three.") as string,
          },
        ]);
        expect(await repo.compareCommits(second, second)).toEqual([]);
      });

      it("lists branches by prefix, and compares a branch with another: ahead, behind, merge base and commits", async () => {
        const { defaultBranch } = await repo.get();
        const base = (await repo.getBranch(defaultBranch))?.sha ?? "";
        const prefix = `ai-office/contract-${run}-lane-`;
        const [lane, fork] = [`${prefix}a`, `${prefix}b`];
        branches.push(lane, fork);
        await repo.createBranch(lane, base);
        const directory = `ai-office-contract/${randomBytes(6).toString("hex")}`;
        const first = await harness.pushCommit(lane, {
          path: `${directory}/one.md`,
          content: "One.\n",
        });
        const second = await harness.pushCommit(lane, {
          path: `${directory}/two.md`,
          content: "Two.\n",
        });
        // A branch that split off the first at its first commit.
        await repo.createBranch(fork, first);
        const third = await harness.pushCommit(fork, {
          path: `${directory}/three.md`,
          content: "Three.\n",
        });

        expect(await repo.listBranches(prefix)).toEqual([
          { name: lane, sha: second },
          { name: fork, sha: third },
        ]);
        expect(await repo.listBranches(`${prefix}none`)).toEqual([]);
        expect(await repo.listBranches()).toContainEqual({
          name: defaultBranch,
          sha: base,
        });

        const ahead = await repo.compareBranches(defaultBranch, lane);
        expect(ahead).toMatchObject({ aheadBy: 2, behindBy: 0 });
        expect(ahead.mergeBase.sha).toBe(base);
        expect(ahead.commits.map(({ sha }) => sha)).toEqual([first, second]);
        for (const commit of [ahead.mergeBase, ...ahead.commits]) {
          expect(commit.message).not.toBe("");
          expect(commit.author).not.toBe("");
          expect(Number.isNaN(Date.parse(commit.authoredAt))).toBe(false);
          expect(commit.htmlUrl).toMatch(
            new RegExp(`^https://.+/commit/${commit.sha}$`),
          );
        }

        const behind = await repo.compareBranches(lane, defaultBranch);
        expect(behind).toMatchObject({ aheadBy: 0, behindBy: 2, commits: [] });
        expect(behind.mergeBase.sha).toBe(base);

        // Diverged: each has one commit the other has not.
        const diverged = await repo.compareBranches(lane, fork);
        expect(diverged).toMatchObject({ aheadBy: 1, behindBy: 1 });
        expect(diverged.mergeBase.sha).toBe(first);
        expect(diverged.commits.map(({ sha }) => sha)).toEqual([third]);
        // By commit as well as by branch.
        expect(
          (await repo.compareBranches(base, third)).commits.map(
            ({ sha }) => sha,
          ),
        ).toEqual([first, third]);

        await rejectsWith(
          repo.compareBranches(defaultBranch, `no-such-branch-${run}`),
          404,
        );
      });

      it("gives the newest of a long branch's commits, oldest first, counting them all", async ({
        skip,
      }) => {
        if (harness.pushCommits === undefined) {
          skip("The real App's repository is not given a long branch.");
          return;
        }
        const { defaultBranch } = await repo.get();
        const branch = `ai-office/contract-${run}-long`;
        branches.push(branch);
        harness.pushCommits(branch, maxComparedCommits * 2 + 30);
        const long = await repo.compareBranches(defaultBranch, branch);
        expect(long.aheadBy).toBe(maxComparedCommits * 2 + 30);
        expect(long.commits).toHaveLength(maxComparedCommits);
        expect(long.commits.at(-1)?.sha).toBe(
          (await repo.getBranch(branch))?.sha,
        );
        const shas = long.commits.map(({ sha }) => sha);
        expect(new Set(shas).size).toBe(shas.length);
      });

      it("opens a pull request, reviews it, sees CI finish and merges it", async () => {
        const workLabel = `${label}-work`;
        const issue = await openIssue("Work for a pull request", [workLabel]);
        const { defaultBranch } = await repo.get();
        const base = await repo.getBranch(defaultBranch);
        const branch = `ai-office/${String(issue.number)}-contract-${run}`;
        branches.push(branch);
        await repo.createBranch(branch, base?.sha ?? "");
        const file = {
          path: `ai-office-contract/${randomBytes(6).toString("hex")}.md`,
          content: "Written by the contract suite.\nA second line.\n",
        };
        const head = await harness.pushCommit(branch, file);

        const opened = await repo.createPullRequest({
          title: `Contract work (${run})`,
          body: `Closes #${String(issue.number)}`,
          head: branch,
          base: defaultBranch,
        });
        expect(opened).toMatchObject({
          state: "open",
          merged: false,
          draft: false,
          head: { name: branch, sha: head },
          base: defaultBranch,
        });
        expect(opened.author).toMatch(/\[bot\]$/);
        expect(await repo.getPullRequest(opened.number)).toEqual(opened);
        // A Batch's one pull request is written again as its issues join.
        const rewritten = `Closes #${String(issue.number)}\n\nRewritten.`;
        expect(
          await repo.updatePullRequest(opened.number, { body: rewritten }),
        ).toMatchObject({ title: opened.title, body: rewritten });
        expect(await repo.getPullRequest(opened.number)).toMatchObject({
          body: rewritten,
        });
        expect(
          (await repo.listPullRequests({ head: branch })).map(
            ({ number }) => number,
          ),
        ).toEqual([opened.number]);
        // Labels go on pull requests too, which are not issues in the list.
        expect(await repo.addLabels(opened.number, [workLabel])).toEqual([
          workLabel,
        ]);
        expect(
          (await repo.listIssues({ labels: [workLabel] })).map(
            ({ number }) => number,
          ),
        ).toEqual([issue.number]);

        // What a reviewer reads: the files changed, and their text.
        const [changed, ...others] = await repo.listPullRequestFiles(
          opened.number,
        );
        expect(others).toEqual([]);
        expect(changed).toMatchObject({ path: file.path, status: "added" });
        expect(changed?.patch).toMatch(/^@@ -0,0 \+1,2 @@/);
        expect(changed?.patch).toContain("+A second line.");
        expect(await repo.getFileContent(file.path, head)).toBe(file.content);
        expect(await repo.getFileContent(file.path, branch)).toBe(file.content);
        expect(
          await repo.getFileContent(file.path, defaultBranch),
        ).toBeUndefined();
        // A directory is not a file.
        expect(
          await repo.getFileContent("ai-office-contract", head),
        ).toBeUndefined();
        // What a directory holds (such as a repository's Skills), and
        // that a file or nothing is not one.
        expect(
          await repo.listDirectory("ai-office-contract", head),
        ).toContainEqual({
          name: file.path.split("/")[1],
          path: file.path,
          type: "file",
        });
        expect(await repo.listDirectory(file.path, head)).toBeUndefined();
        expect(
          await repo.listDirectory("ai-office-contract/nothing-here", head),
        ).toBeUndefined();
        // Every file's path, for the Manager chat's `@` mentions (FR-24).
        const files = await repo.listFiles(head);
        expect(files).toContain(file.path);
        expect(files).not.toContain("ai-office-contract");
        expect([...files].sort()).toEqual(files);

        // The App reviews as a comment: it cannot approve its own work.
        const review = await repo.createReview(opened.number, {
          body: "Verdict: approve. No blocking comments.",
          comments: [
            { path: file.path, line: 2, body: "Nit: end with a full stop." },
          ],
        });
        expect(review).toMatchObject({
          state: "COMMENTED",
          body: "Verdict: approve. No blocking comments.",
          commitSha: head,
        });
        expect(review.htmlUrl).toBe(
          `${opened.htmlUrl}#pullrequestreview-${String(review.id)}`,
        );
        expect(
          (await repo.listReviews(opened.number)).map(({ id }) => id),
        ).toEqual([review.id]);
        // Never on a line outside the diff.
        await rejectsWith(
          repo.createReview(opened.number, {
            body: "Verdict: changes requested.",
            comments: [{ path: file.path, line: 40, body: "Not in the diff." }],
          }),
          422,
        );

        await harness.finishCI(head, "success");
        for (const ref of [head, branch]) {
          expect(
            (await repo.listCheckRuns(ref)).filter(({ name }) => name === "CI"),
          ).toEqual([
            expect.objectContaining({
              status: "completed",
              conclusion: "success",
              headSha: head,
              htmlUrl: expect.stringMatching(/^https:\/\//) as unknown,
            }),
          ]);
        }

        // Only if the head is still what was reviewed.
        await rejectsWith(
          repo.mergePullRequest(opened.number, {
            method: "squash",
            sha: base?.sha ?? "",
          }),
          409,
        );
        const merge = await repo.mergePullRequest(opened.number, {
          method: "squash",
          sha: head,
        });
        expect(merge.sha).toMatch(/^[0-9a-f]{40}$/);
        expect(await repo.getPullRequest(opened.number)).toMatchObject({
          state: "closed",
          merged: true,
        });
        expect((await repo.getBranch(defaultBranch))?.sha).toBe(merge.sha);
        // `Closes #N` closed the issue.
        await expect
          .poll(async () => (await repo.getIssue(issue.number)).state, {
            timeout: 15_000,
          })
          .toBe("closed");
        await rejectsWith(
          repo.mergePullRequest(opened.number, { method: "squash" }),
          405,
        );
      });

      it("fails with GitHub's status for what does not exist", async () => {
        await rejectsWith(repo.getIssue(999_999_999), 404);
        await rejectsWith(repo.getPullRequest(999_999_999), 404);
        await rejectsWith(
          harness.app.repository(`${harness.repository}-missing-${run}`).get(),
          404,
        );
      });
    },
  );
}

if (realApp.skip !== undefined) {
  // Every reporter shows this; only the verbose one shows skip notes.
  console.warn(realApp.skip);
}
