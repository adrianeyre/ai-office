import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createEventBus,
  memoryEventStore,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { defaultIntakeSettings } from "@ai-office/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createAgents } from "../agents/agents.ts";
import { createCoderFlow } from "../coder/coder.ts";
import { createFloors } from "../floors/floors.ts";
import type { IntakeQueue } from "../intake/intake.ts";
import { createFakeModel } from "../models/fake-model.ts";
import { createNotices } from "../notices/notices.ts";
import { createOfficeSettings } from "../office/settings.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { issueBranch } from "../sandbox/branch.ts";
import {
  createFakeSandbox,
  result,
  say,
  type FakeAgentContext,
} from "../sandbox/fake-sandbox.ts";
import { gitBackedGitHub, gitIn } from "../sandbox/git-backed-github.ts";
import { createSandboxRunner } from "../sandbox/runner.ts";
import { memoryStores } from "../stores.ts";
import {
  createWorkQueue,
  executeByStage,
  type WorkQueue,
} from "../work/queue.ts";
import { memoryWorkQueueStore } from "../work/store.ts";
import { createBatches } from "./batches.ts";

// Overlapping issues run one after another, and later branches rebase on
// merged work (PRD FR-25.5), end to end: a Batch of #1 (the basket), #2
// (its total, in the same file) and #3 (the footer). The Manager's Plan
// (a fake model) names the files; plain code sees #1 and #2 overlap, so
// #2 waits for #1. The coders (scripts in a fake sandbox) work each issue
// on a local bare repository standing in for GitHub's remote, and AI
// Office pushes their branches and opens the pull requests. The Owner
// merges on "GitHub" (into the bare repository's main). A stand-in for
// review records each branch as it reaches review.

const exec = promisify(execFile);
const repository = "adrianeyre/web-shop";
const titles = {
  1: "Add a basket",
  2: "Show the basket's total",
  3: "Tidy the footer",
} as const;
const basket = "export const basket: number[] = [];\n";
const withTotal = `${basket}\nexport const total = (): number =>\n  basket.reduce((sum, price) => sum + price, 0);\n`;
const footer = "export const footer = 'Web shop, 1 High Street';\n";

/** A branch as review found it. */
interface Reviewed {
  readonly issue: number;
  readonly head: string;
  /** main on the remote when review started. */
  readonly main: string;
  /** Whether main was under the branch then. */
  readonly onMain: boolean;
  /** The branch's commits beyond main, oldest first: each with its parent. */
  readonly commits: readonly { sha: string; parent: string }[];
  readonly files: Readonly<Record<string, string>>;
}

/** A promise and the function that keeps it. */
const deferred = () => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function setUp() {
  const root = await mkdtemp(join(tmpdir(), "ai-office-overlap-"));
  const remote = join(root, "web-shop.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await exec("git", ["init", "--quiet", "-b", "main", seed]);
  await writeFile(join(seed, "README.md"), "# Web shop\n");
  await gitIn(seed, "add", "-A");
  await gitIn(seed, "commit", "--quiet", "-m", "chore: start");
  await gitIn(seed, "push", "--quiet", remote, "main");

  const fake = createFakeGitHub();
  fake.installRepository(repository);
  const github = gitBackedGitHub(fake, remote);
  const bus = createEventBus({ store: memoryEventStore() });
  const events: OfficeEvent[] = [];
  bus.subscribe(({ event }) => {
    events.push(event);
  });
  const stores = memoryStores();
  await createFloors({ store: stores.floors, github, events: bus }).add(
    repository,
  );
  await stores.floors.update("web-shop", { planApproval: false });
  await createAgents({
    store: stores.agents,
    floors: stores.floors,
    events: bus,
  }).add("web-shop", { role: "coder" });
  const team = await stores.agents.list("web-shop");
  const [ada, alan] = team.filter(({ role }) => role === "coder");
  const manager = team.find(({ role }) => role === "manager");
  if (ada === undefined || alan === undefined || manager === undefined) {
    throw new Error("The Floor has a Manager and two coders.");
  }
  const office = createOfficeSettings({
    store: stores.office,
    floors: stores.floors,
    events: bus,
  });
  const pipeline = createPipeline({ github, events: bus });
  const notices = createNotices({ store: stores.notices, events: bus });

  /** What each issue's coder found in its clone when it began. */
  const found = new Map<number, string | null>();
  /** Held open, #2's coder waits for it before it commits. */
  const holdTotal = { started: deferred(), release: deferred() };
  const coding = async ({ prompt, print, sh }: FakeAgentContext) => {
    const issue = prompt.includes(titles[2])
      ? 2
      : prompt.includes(titles[3])
        ? 3
        : 1;
    const read = await sh("cat src/basket.ts");
    found.set(issue, read.exitCode === 0 ? read.stdout : null);
    if (issue === 2) {
      holdTotal.started.resolve();
      await holdTotal.release.promise;
    }
    const [path, text, subject] =
      issue === 1
        ? ["src/basket.ts", basket, "feat: a basket"]
        : issue === 2
          ? ["src/basket.ts", withTotal, "feat: the basket's total"]
          : ["src/footer.ts", footer, "feat: the footer's address"];
    await sh(
      `mkdir -p src && printf '%s' '${text.replaceAll("'", "'\\''")}' > ${path}`,
    );
    await sh(`git add -A && git commit --quiet -m "${subject}"`);
    print(
      say(
        [
          "Done.",
          "<handoff>",
          `Changed: ${subject}.`,
          `Check: ${path}.`,
          "Risks: None.",
          "</handoff>",
        ].join("\n"),
      ),
    );
    print(result({ input: 1000, output: 200 }));
  };
  const sandbox = await createFakeSandbox(coding);
  const runner = createSandboxRunner({
    github,
    events: bus,
    sandbox: (environment) => sandbox.provider(environment),
    gateway: () =>
      Promise.resolve({
        url: "http://gateway:4000",
        key: "aio_gk_thecoderskeyforitssandboxes00000000000000",
      }),
    workDir: join(root, "work"),
    cloneUrl: () => remote,
  });

  const reviewed: Reviewed[] = [];
  const holder: { queue?: WorkQueue } = {};
  const next: IntakeQueue = {
    enqueue: (work) => holder.queue?.enqueue(work) ?? Promise.resolve(),
  };
  const workStore = memoryWorkQueueStore(stores.floors);
  const queue = createWorkQueue({
    store: workStore,
    agents: stores.agents,
    events: bus,
    limit: () => Promise.resolve(3),
    execute: executeByStage({
      "needs-work": createCoderFlow({
        floors: stores.floors,
        agents: stores.agents,
        github,
        pipeline,
        notices,
        events: bus,
        runner,
        gitIdentity: (floorId) => office.floorGitIdentity(floorId),
        scratchDir: root,
        pushUrl: () => remote,
        queue: next,
        reviews: stores.reviews,
      }),
      // A stand-in for review: the branch as the reviewers would get it.
      "needs-review": async (work) => {
        const branch = issueBranch(
          work.issue,
          titles[work.issue as keyof typeof titles],
        );
        const head = await gitIn(remote, "rev-parse", branch);
        const main = await gitIn(remote, "rev-parse", "main");
        const onMain = await gitIn(
          remote,
          "merge-base",
          "--is-ancestor",
          main,
          head,
        ).then(
          () => true,
          () => false,
        );
        const log = await gitIn(
          remote,
          "log",
          "--reverse",
          "--format=%H %P",
          head,
          "--not",
          main,
        );
        const paths = (
          await gitIn(remote, "ls-tree", "-r", "--name-only", head)
        ).split("\n");
        const files: Record<string, string> = {};
        for (const path of paths) {
          files[path] = (
            await exec("git", ["show", `${head}:${path}`], { cwd: remote })
          ).stdout;
        }
        reviewed.push({
          issue: work.issue,
          head,
          main,
          onMain,
          commits: log
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => {
              const [sha = "", parent = ""] = line.split(" ");
              return { sha, parent };
            }),
          files,
        });
        return "finished";
      },
    }),
  });
  holder.queue = queue;
  await queue.start();

  const model = createFakeModel();
  const batches = createBatches({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models: model,
    store: stores.batches,
    work: workStore,
    pipeline,
    queue,
    events: bus,
    notices,
    settings: () => Promise.resolve(defaultIntakeSettings),
  });

  for (const title of Object.values(titles)) {
    fake.createIssue(repository, { title, body: `- [ ] ${title}` });
  }
  // The Manager's Plan: #1 and #2 both change the basket; #3 the footer.
  model.answer(
    manager.id,
    JSON.stringify({
      summary: "The basket, then its total; the footer alongside.",
      issues: [
        {
          issue: 1,
          dependsOn: [],
          files: ["src/basket.ts"],
          agent: ada.name,
          note: "",
        },
        {
          issue: 3,
          dependsOn: [],
          files: ["src/footer.ts"],
          agent: alan.name,
          note: "",
        },
        {
          issue: 2,
          dependsOn: [],
          files: ["src/basket.ts"],
          agent: alan.name,
          note: "",
        },
      ],
    }),
  );

  /** The Owner merges an issue's pull request on GitHub, closing the issue. */
  const merge = async (issue: keyof typeof titles): Promise<string> => {
    const branch = issueBranch(issue, titles[issue]);
    const clone = join(root, `merge-${String(issue)}`);
    await exec("git", ["clone", "--quiet", "--branch", "main", remote, clone]);
    await gitIn(clone, "fetch", "--quiet", "origin", branch);
    await gitIn(
      clone,
      "merge",
      "--quiet",
      "--no-ff",
      "-m",
      `Merge pull request for #${String(issue)}`,
      "FETCH_HEAD",
    );
    await gitIn(clone, "push", "--quiet", "origin", "main");
    const [pullRequest] = await github
      .repository(repository)
      .listPullRequests({ head: branch });
    await fake
      .repository(repository)
      .mergePullRequest(pullRequest?.number ?? 0, { method: "merge" });
    return gitIn(clone, "rev-parse", "HEAD");
  };

  /** Someone else commits straight to main on GitHub. */
  const commitToMain = async (path: string, text: string): Promise<string> => {
    const clone = join(root, `direct-${String(Date.now())}`);
    await exec("git", ["clone", "--quiet", "--branch", "main", remote, clone]);
    await writeFile(join(clone, path), text);
    await gitIn(clone, "add", "-A");
    await gitIn(clone, "commit", "--quiet", "-m", `chore: ${path}`);
    await gitIn(clone, "push", "--quiet", "origin", "main");
    return gitIn(clone, "rev-parse", "HEAD");
  };

  const labels = async (issue: number) =>
    [...(await fake.repository(repository).getIssue(issue)).labels].sort();

  return {
    root,
    remote,
    stores,
    batches,
    queue,
    events,
    reviewed,
    found,
    holdTotal,
    alan,
    merge,
    commitToMain,
    labels,
    pushed: (issue: number) =>
      events.filter(
        (event): event is Extract<OfficeEvent, { type: "branch.pushed" }> =>
          event.type === "branch.pushed" && event.issue === issue,
      ),
    async close() {
      await queue.stop();
      await batches.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

let setup: Awaited<ReturnType<typeof setUp>> | undefined;

afterEach(async () => {
  await setup?.close();
  setup = undefined;
});

describe("overlapping issues in a Batch", () => {
  it("run one after another, and the later branch is rebased onto the work merged meanwhile before review", async () => {
    setup = await setUp();
    const current = setup;

    // 1. The Plan sees #2 overlap #1 in src/basket.ts: #2 runs after it.
    //    #1 and #3 start at once; #2 waits.
    const created = await current.batches.create("web-shop", [1, 2, 3]);
    if (created.batch === undefined) {
      throw new Error("No Batch was made.");
    }
    const batchId = created.batch.id;
    expect(created.plan.overlaps).toEqual([
      { issues: [1, 2], files: ["src/basket.ts"] },
    ]);
    expect(
      created.plan.items.map(({ issue, dependsOn }) => [issue, dependsOn]),
    ).toEqual([
      [1, []],
      [3, []],
      [2, [1]],
    ]);
    expect(created.plan.parallel).toEqual([[1, 3], [2]]);
    expect(created.started).toEqual([1, 3]);

    // 2. #1 and #3 reach review, each on main as it was: nothing to rebase.
    await current.queue.idle();
    expect(current.reviewed.map(({ issue }) => issue).sort()).toEqual([1, 3]);
    expect(current.reviewed.every(({ onMain }) => onMain)).toBe(true);
    for (const issue of [1, 3]) {
      expect(
        current.pushed(issue).map(({ rebase }) => rebase?.outcome),
      ).toEqual(["up_to_date"]);
    }
    // #2 has not started, and does not while #1 is open.
    expect(await current.labels(2)).toEqual([]);
    expect(await current.batches.check()).toEqual(new Map());
    expect(current.found.has(2)).toBe(false);

    // 3. The Owner merges #1. Only then does #2 start, from a main that
    //    has #1's basket.
    await current.merge(1);
    expect(await current.batches.check()).toEqual(new Map([[batchId, [2]]]));
    await current.holdTotal.started.promise;
    expect(current.found.get(2)).toBe(basket);

    // 4. While #2's coder works, the Owner merges #3: main moves on.
    const merged = await current.merge(3);
    current.holdTotal.release.resolve();
    await current.queue.idle();

    // 5. Before review, #2's branch was rebased onto that main: its commit
    //    now follows #3's merge, and the branch has the footer too.
    const total = current.reviewed.find(({ issue }) => issue === 2);
    expect(total).toMatchObject({ main: merged, onMain: true });
    expect(total?.commits).toEqual([{ sha: total?.head, parent: merged }]);
    expect(total?.files).toEqual({
      "README.md": "# Web shop\n",
      "src/basket.ts": withTotal,
      "src/footer.ts": footer,
    });
    const [pushed] = current.pushed(2);
    expect(pushed).toMatchObject({
      agentId: current.alan.id,
      branch: "ai-office/2-show-the-basket-s-total",
      sha: total?.head,
      commits: 1,
      rebase: { outcome: "rebased", onto: "main", base: merged },
    });
    // Its commit is still the Owner's, with Alan's trailer.
    expect(
      await gitIn(
        current.remote,
        "log",
        "-1",
        "--format=%an|%cn|%B",
        total?.head ?? "",
      ),
    ).toBe(
      `adrianeyre|adrianeyre|feat: the basket's total\n\nAgent: ${current.alan.name} (coder, Claude claude-opus-5-5)`,
    );
    // The reviewers' Handoff carries no warning.
    const handoff = await current.stores.reviews.latestHandoff(
      "web-shop",
      2,
      "needs-review",
    );
    expect(handoff?.summary.risks).toBe("None.");
    expect(
      (await current.stores.batches.started(batchId)).map(({ issue }) => issue),
    ).toEqual([1, 3, 2]);
    // Nothing is left of the rebases' checkouts.
    expect(await readdir(current.root)).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/^(publish|rebase)-/)]),
    );
  });

  it("hands the later branch to review as it was, saying so, when the work merged meanwhile conflicts with it", async () => {
    setup = await setUp();
    const current = setup;
    await current.batches.create("web-shop", [1, 2, 3]);
    await current.queue.idle();
    await current.merge(1);
    await current.batches.check();
    await current.holdTotal.started.promise;
    const before = await gitIn(current.remote, "rev-parse", "main");

    // Someone changes the basket on main while #2's coder works.
    const theirs = await current.commitToMain(
      "src/basket.ts",
      "export const basket: string[] = [];\n",
    );
    current.holdTotal.release.resolve();
    await current.queue.idle();

    const total = current.reviewed.find(({ issue }) => issue === 2);
    // Not rebased: still on the main it began from.
    expect(total).toMatchObject({ main: theirs, onMain: false });
    expect(
      await gitIn(current.remote, "rev-parse", `${total?.head ?? ""}^`),
    ).toBe(before);
    expect(current.pushed(2).map(({ rebase }) => rebase)).toEqual([
      {
        outcome: "conflict",
        onto: "main",
        base: theirs,
        files: ["src/basket.ts"],
      },
    ]);
    const handoff = await current.stores.reviews.latestHandoff(
      "web-shop",
      2,
      "needs-review",
    );
    expect(handoff?.summary.risks).toBe(
      "It could not be rebased onto main, which has changed since the work began: src/basket.ts conflict. It is reviewed as it is, and needs main merged in before it can merge. None.",
    );
  });
});
