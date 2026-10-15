import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { grillingBranch, memoryBranch } from "@ai-office/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import type { FloorRecord } from "../floors/store.ts";
import { issueBranch } from "../sandbox/branch.ts";
import type { SandboxRun } from "../sandbox/runner.ts";
import { memoryStores } from "../stores.ts";
import { createPushRun, type PushRun } from "./push-run.ts";

// Probe W1 (docs/pen-testing/assessments/W1.md), "The App's write path:
// can anything an Agent controls choose the branch, repository or ref the
// App pushes or merges?" Position 3: code in the sandbox owns the clone
// AI Office pushes from, its refs, its config and its commits. The real
// `createPushRun` (and so `publishBranch`) pushes, with a token that can
// write, to a local bare repository standing in for the Floor's on GitHub.
//
// - Holds: the App pushes the one branch AI Office named, to the Floor's
//   repository, whatever else the clone holds or says: its other branches,
//   tags, remotes, push refspecs and `push.default` are never read. The
//   branch's name is `ai-office/<issue>-<slug>` whatever the issue's title,
//   and never another issue's, the memory's or a Grilling Session's.
// - W1-5 (new), fixed: the Agent's commit messages were pushed as it
//   wrote them, under the Owner's name, so it could add `Agent:` trailers
//   naming another Agent and `Co-authored-by:` trailers naming anyone.
//   Now every line naming who made a commit is dropped, and AI Office's
//   trailer is the only one. The author date is still the Agent's (a
//   decision recorded in docs/verification/issue-297.md).

const exec = promisify(execFile);
const repository = "adrianeyre/web-shop";
const owner = {
  name: "adrianeyre",
  email: "adrianeyre@users.noreply.github.com",
};
const ada = {
  name: "Ada",
  role: "coder",
  aiProvider: "Claude",
  model: "claude-opus-5-5",
} as const;
const title = "Add a basket";
const branch = issueBranch(1, title);

/** Git as a test helper, or as the Agent in its sandbox. */
const gitIn = async (cwd: string, ...args: string[]) =>
  (
    await exec(
      "git",
      [
        "-c",
        "user.name=Mallory",
        "-c",
        "user.email=mallory@example.com",
        ...args,
      ],
      { cwd },
    )
  ).stdout.trim();

let root: string;
/** The Floor's repository, as GitHub has it. */
let remote: string;
/** Another repository the Agent would rather the App pushed to. */
let decoy: string;
/** The Agent's clone. */
let clone: string;
let floor: FloorRecord;
let push: PushRun;
let upstream: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "w1-push-"));
  remote = join(root, "web-shop.git");
  decoy = join(root, "decoy.git");
  clone = join(root, "clone");
  for (const bare of [remote, decoy]) {
    await exec("git", ["init", "--quiet", "--bare", "-b", "main", bare]);
  }
  await exec("git", ["init", "--quiet", "-b", "main", clone]);
  await writeFile(join(clone, "README.md"), "# Web shop\n");
  await gitIn(clone, "add", "README.md");
  await gitIn(clone, "commit", "--quiet", "-m", "chore: start");
  await gitIn(clone, "push", "--quiet", remote, "main");
  await gitIn(clone, "push", "--quiet", decoy, "main");
  upstream = await gitIn(clone, "rev-parse", "HEAD");
  await gitIn(clone, "switch", "--quiet", "-c", branch);

  const fake = createFakeGitHub();
  fake.installRepository(repository);
  const bus = createEventBus({ store: memoryEventStore() });
  const stores = memoryStores();
  floor = await createFloors({
    store: stores.floors,
    github: fake,
    events: bus,
  }).add(repository);
  push = createPushRun({
    github: fake,
    events: bus,
    gitIdentity: () => Promise.resolve(owner),
    scratchDir: root,
    // The Floor's repository on "GitHub", by its name.
    pushUrl: (found) => (found.fullName === repository ? remote : "nowhere"),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (commits: readonly string[]): SandboxRun => ({
  sandboxId: "sbx-w1",
  branch,
  commits,
  upstream: [upstream],
  usage: null,
  lastText: null,
  freshStarts: 0,
  escalated: false,
  workspace: clone,
  discard: () => Promise.resolve(),
});

const pushed = (commits: readonly string[]) =>
  push({
    floor,
    agentId: "ada",
    trailer: ada,
    issue: 1,
    run: run(commits),
    signal: new AbortController().signal,
  });

/** Every ref `bare` has, as `name sha`. */
const refsOf = async (bare: string) =>
  (await gitIn(bare, "for-each-ref", "--format=%(refname) %(objectname)"))
    .split("\n")
    .filter((line) => line !== "")
    .sort();

describe("the ref, branch and repository the App pushes", () => {
  it("is the one branch AI Office named, to the Floor's repository: the clone's other refs, remotes, push refspecs and push.default are never read", async () => {
    await writeFile(join(clone, "basket.ts"), "export const basket = [];\n");
    await gitIn(clone, "add", "basket.ts");
    await gitIn(clone, "commit", "--quiet", "-m", "feat: a basket");
    const work = await gitIn(clone, "rev-parse", "HEAD");
    // What the Agent sets up besides, hoping the App pushes it.
    await gitIn(clone, "switch", "--quiet", "main");
    await writeFile(join(clone, "README.md"), "# Owned\n");
    await gitIn(clone, "commit", "--quiet", "-am", "chore: rewrite main");
    await gitIn(clone, "tag", "v9.9.9");
    await gitIn(clone, "branch", "ai-office/2-someone-elses-work");
    await gitIn(clone, "branch", "ai-office/memory");
    await gitIn(clone, "switch", "--quiet", branch);
    await gitIn(clone, "remote", "add", "origin", decoy);
    await gitIn(
      clone,
      "config",
      "remote.origin.push",
      "+refs/heads/*:refs/heads/*",
    );
    await gitIn(clone, "config", "remote.pushDefault", "origin");
    await gitIn(clone, "config", "push.default", "matching");
    await gitIn(clone, "config", `branch.${branch}.pushRemote`, "origin");
    await gitIn(clone, "config", `branch.${branch}.merge`, "refs/heads/main");
    const decoyBefore = await refsOf(decoy);

    const published = await pushed([work]);

    const after = await refsOf(remote);
    expect(after).toEqual([
      `refs/heads/${branch} ${published.sha}`,
      `refs/heads/main ${upstream}`,
    ]);
    expect(await refsOf(decoy)).toEqual(decoyBefore);
  });

  it("is the issue's branch whatever its title says: never main, a ref outside refs/heads/ai-office/, another issue's, the memory's or a Grilling Session's", () => {
    const titles = [
      "main",
      "../../main",
      "refs/heads/main",
      ":refs/heads/main",
      "+main:main",
      "HEAD",
      "memory",
      "grilling-3",
      "2-someone else's work",
      "ai-office/memory",
      "‮main",
      "ｍａｉｎ",
      "-",
      "a".repeat(500),
    ];
    const others = new Set([
      memoryBranch,
      grillingBranch(3),
      issueBranch(12, "x"),
    ]);
    for (const hostile of titles) {
      const name = issueBranch(1, hostile);
      expect(name, hostile).toMatch(/^ai-office\/1(-[a-z0-9]+(-[a-z0-9]+)*)?$/);
      expect(name.length).toBeLessThanOrEqual("ai-office/1-".length + 40);
      expect(others.has(name), hostile).toBe(false);
    }
  });
});

describe("W1-5: what the Agent writes in a commit's metadata", () => {
  const forged = [
    "feat: a basket",
    "",
    "Agent: Grace (reviewer, ChatGPT gpt-5)",
    "Co-authored-by: Linus Torvalds <torvalds@linux-foundation.org>",
  ].join("\n");

  async function commitForged(): Promise<string> {
    await writeFile(join(clone, "basket.ts"), "export const basket = [];\n");
    await gitIn(clone, "add", "basket.ts");
    await exec(
      "git",
      [
        "-c",
        "user.name=Mallory",
        "-c",
        "user.email=mallory@example.com",
        "commit",
        "--quiet",
        "-m",
        forged,
      ],
      {
        cwd: clone,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
        },
      },
    );
    return gitIn(clone, "rev-parse", "HEAD");
  }

  it("holds: the author and committer are the Owner, whoever the Agent said they were, and its own trailer is added (FR-68, FR-69)", async () => {
    const published = await pushed([await commitForged()]);
    expect(
      await gitIn(
        remote,
        "show",
        "--no-patch",
        "--format=%an <%ae>|%cn <%ce>",
        published.sha,
      ),
    ).toBe(`${owner.name} <${owner.email}>|${owner.name} <${owner.email}>`);
    expect(
      await gitIn(remote, "show", "--no-patch", "--format=%B", published.sha),
    ).toContain("Agent: Ada (coder, Claude claude-opus-5-5)");
  });

  it("the commit the App pushes names only the Agent that made it: no other Agent: or Co-authored-by: trailer the Agent wrote", async () => {
    const published = await pushed([await commitForged()]);
    const message = await gitIn(
      remote,
      "show",
      "--no-patch",
      "--format=%B",
      published.sha,
    );
    expect(message).not.toContain("Agent: Grace");
    expect(message).not.toMatch(/^Co-authored-by:/im);
  });

  it("regression (W1-5): the Agent's trailers naming another Agent and a co-author are no longer pushed in a commit authored as the Owner: its only trailer is AI Office's", async () => {
    const published = await pushed([await commitForged()]);
    const trailers = await gitIn(
      remote,
      "show",
      "--no-patch",
      "--format=%(trailers:only,unfold)",
      published.sha,
    );
    expect(trailers.split("\n")).toEqual([
      "Agent: Ada (coder, Claude claude-opus-5-5)",
    ]);
    expect(
      await gitIn(remote, "show", "--no-patch", "--format=%B", published.sha),
    ).toBe("feat: a basket\n\nAgent: Ada (coder, Claude claude-opus-5-5)");
    // Unchanged, and decided so (issue #297): the author date is the
    // Agent's, as for every commit the App makes again.
    expect(
      await gitIn(remote, "show", "--no-patch", "--format=%aI", published.sha),
    ).toBe("2001-01-01T00:00:00+00:00");
  });

  it("W1-5: a sign-off or review trailer naming the Owner, or anyone, is dropped too, in every commit pushed, and the Agent's own trailer is written once", async () => {
    const commits: string[] = [];
    for (const [file, message] of [
      [
        "basket.ts",
        "feat: a basket\n\nSigned-off-by: adrianeyre <adrianeyre@users.noreply.github.com>",
      ],
      [
        "total.ts",
        "feat: a total\n\nRefs #1\n\nReviewed-by: Grace\nAgent: Ada (coder, Claude claude-opus-5-5)",
      ],
    ] as const) {
      await writeFile(join(clone, file), "export {};\n");
      await gitIn(clone, "add", file);
      await gitIn(clone, "commit", "--quiet", "-m", message);
      commits.push(await gitIn(clone, "rev-parse", "HEAD"));
    }
    await pushed(commits);
    const trailers = await gitIn(
      remote,
      "log",
      "--format=%(trailers:only,unfold)%x1e",
      `main..${branch}`,
    );
    expect(
      trailers
        .split("\x1e")
        .map((block) => block.trim())
        .filter((block) => block !== ""),
    ).toEqual([
      "Agent: Ada (coder, Claude claude-opus-5-5)",
      "Agent: Ada (coder, Claude claude-opus-5-5)",
    ]);
  });
});
