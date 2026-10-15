import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import type { GitHubApp } from "@ai-office/github";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import { memoryBranch, memoryPath } from "@ai-office/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentRecord } from "../agents/store.ts";
import type { PlanContent } from "../batches/store.ts";
import { createFloors } from "../floors/floors.ts";
import { createFakeModel, type FakeModel } from "../models/fake-model.ts";
import { createNotices, type Notices } from "../notices/notices.ts";
import { createOfficeSettings } from "../office/settings.ts";
import { gitBackedGitHub, gitIn } from "../sandbox/git-backed-github.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  approve,
  ofType,
  repository,
  scenario,
  type Scenario,
} from "../work/scenario.ts";
import {
  createMemoryCuration,
  memoryPullRequestTitle,
  tidyUpMs,
  type MemoryCuration,
} from "./curation.ts";
import { memoryFile } from "./file.ts";
import { createRepositoryMemory, memorySection } from "./memory.ts";

// Repository memory curated into one pull request (PRD FR-53, FR-56):
// Agents propose entries in their Handoffs as they work an issue, and when
// the Batch ends (and weekly) the Floor's Manager curates them, with the
// memory as it is, into one pull request on `ai-office/memory` that merges
// duplicates, drops stale entries and keeps the file short. AI Office, as
// the GitHub App, commits it as the Owner with the Manager's trailer. The
// first scenario runs the whole pipeline (fake sandbox, fake model, a
// local bare repository standing in for GitHub's remote); the cases after
// it run in memory and in Postgres 18.

const exec = promisify(execFile);
const anthropicKey = "sk-ant-api03-pastedintomemory-Qw3Er4Ty5Ui6Op7As8Df9";
const owner = "adrianeyre <21265837+adrianeyre@users.noreply.github.com>";
const start = new Date("2026-10-09T10:00:00.000Z");

/** The memory the repository starts with: two duplicates and a stale entry. */
const seeded = memoryFile([
  "Use pnpm, not npm.",
  "Always install dependencies with pnpm.",
  "Run the tests with `npm test`.",
]);
const buildFirst =
  "Run `pnpm build` before `pnpm test`: the tests import from dist/.";
const testsLive = "Tests live in test/, one file per module.";
const readme = "The README documents every public function.";
const usePnpm = "Use pnpm, never npm: install and run everything with it.";
const pence = "Prices are in pence, as integers.";

const curatedAnswer = (summary: string, entries: readonly string[]) =>
  JSON.stringify({ summary, entries });

/** The latest commit on `ref` in the remote: who, its parent, its message. */
const commitOn = async (remote: string, ref: string) => {
  const [who = "", committer = "", parent = "", ...message] = (
    await gitIn(
      remote,
      "log",
      "-1",
      "--format=%an <%ae>%n%cn <%ce>%n%P%n%B",
      ref,
    )
  ).split("\n");
  return { who, committer, parent, message: message.join("\n").trim() };
};

describe("proposed memory entries become one curated pull request", () => {
  let current: Scenario | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  it("Agents propose entries in their Handoffs; when the Batch ends the Manager curates them, with the memory, into one pull request, which later curations update", async () => {
    const s = await scenario({
      withDocs: true,
      memory: seeded,
      proposals: {
        coder: [buildFirst, `Deploy with ${anthropicKey}.`],
        qa: [
          "run pnpm build before pnpm test: the tests import from dist/",
          testsLive,
        ],
        docs: [readme],
      },
    });
    current = s;
    const qa = s.qa;
    const docs = s.docs;
    if (qa === undefined || docs === undefined) {
      throw new Error("The Floor has a QA and a docs Agent.");
    }
    s.model.answer(s.grace.id, approve());
    s.model.answer(s.quinta.id, approve());
    await s.run();
    expect(await s.fake.repository(repository).getIssue(1)).toMatchObject({
      state: "open",
      labels: expect.arrayContaining(["ready-to-merge"]) as unknown,
    });

    // 1. Every Agent read the memory at the start of its task, quoted.
    const section = memorySection(seeded.trim()).join("\n");
    for (const prompt of [s.prompts[0], s.qaPrompts[0], s.docsPrompts[0]]) {
      expect(prompt).toContain(section);
    }
    for (const reviewer of [s.grace, s.quinta]) {
      expect(
        s.model.requestsOf(reviewer.id)[0]?.messages[0]?.content,
      ).toContain(section);
    }

    // 2. Their proposals wait for the Manager: a duplicate (QA's take on
    // the coder's entry) once, an entry with a credential never.
    expect(
      (await s.stores.memory.pending("web-shop")).map(
        ({ text, issue, agentId }) => ({ text, issue, agentId }),
      ),
    ).toEqual([
      { text: buildFirst, issue: 1, agentId: s.coder.id },
      { text: testsLive, issue: 1, agentId: qa.id },
      { text: readme, issue: 1, agentId: docs.id },
    ]);
    const proposed = ofType(await s.events(), "memory.proposed");
    expect(
      proposed.map(({ agentId, entries }) => ({ agentId, entries })),
    ).toEqual([
      { agentId: s.coder.id, entries: [buildFirst] },
      { agentId: qa.id, entries: [testsLive] },
      { agentId: docs.id, entries: [readme] },
    ]);
    // The Handoffs themselves carry no memory.
    const handoffs = ofType(await s.events(), "handoff");
    expect(JSON.stringify(handoffs)).not.toContain("<memory>");

    // 3. The Batch that held #1, in progress.
    const plan: PlanContent = {
      draftedBy: "rules",
      summary: "One issue.",
      items: [
        {
          issue: 1,
          title: "Add a basket!",
          dependsOn: [],
          files: [],
          agentId: s.coder.id,
          note: "",
        },
      ],
      overlaps: [],
      parallel: [[1]],
      leftOut: [],
    };
    const { batch } = await s.stores.batches.create(
      {
        floorId: "web-shop",
        issues: [1],
        status: "in_progress",
        agentId: s.manager.id,
        createdAt: start,
      },
      plan,
    );
    let clock = start.getTime() + 60 * 60 * 1000;
    const curation = createMemoryCuration({
      floors: s.stores.floors,
      agents: s.stores.agents,
      github: s.github,
      models: s.model,
      store: s.stores.memory,
      batches: s.stores.batches,
      events: s.bus,
      notices: s.notices,
      gitIdentity: () => s.gitIdentity(),
      scratchDir: s.root,
      pushUrl: () => s.remote,
      now: () => new Date(clock),
    });

    // 4. Until #1 is closed the Batch has not ended: nothing is curated.
    expect(await curation.check()).toEqual([]);
    expect(s.model.requestsOf(s.manager.id)).toEqual([]);

    // 5. The Owner merges #1's pull request, which closes #1: the Batch
    // has ended, and the Manager curates.
    await s.fake.repository(repository).closeIssue(1);
    s.model.answer(
      s.manager.id,
      curatedAnswer(
        "Merged the two pnpm entries into one, dropped `npm test` (the repository uses pnpm), and took the three proposals.",
        [usePnpm, buildFirst, testsLive, readme],
      ),
    );
    const mainBefore = await gitIn(s.remote, "rev-parse", "main");
    const [outcome, ...more] = await curation.check();
    expect(more).toEqual([]);
    const number = outcome?.pullRequest?.number;
    if (outcome === undefined || number === undefined) {
      throw new Error("The Batch's end opens a memory pull request.");
    }

    // The Manager's Model was asked with the memory and the proposals.
    const [asked, ...again] = s.model.requestsOf(s.manager.id);
    expect(again).toEqual([]);
    expect(asked).toMatchObject({
      agentId: s.manager.id,
      model: "claude-opus-5-5",
      maxTokens: 8192,
    });
    expect(asked?.system).toContain("A Batch of issues has just ended");
    expect(asked?.messages[0]?.content).toBe(
      [
        "## The memory now",
        "",
        "<memory>",
        "1. Use pnpm, not npm.",
        "2. Always install dependencies with pnpm.",
        "3. Run the tests with `npm test`.",
        "</memory>",
        "",
        "## Proposed entries",
        "",
        "<proposals>",
        `- ${buildFirst} (${s.coder.name}, on #1)`,
        `- ${testsLive} (${qa.name}, on #1)`,
        `- ${readme} (Dora, on #1)`,
        "</proposals>",
        "",
        "Now give the curated memory, as the JSON object only.",
        "",
      ].join("\n"),
    );
    expect(JSON.stringify(s.model.requests)).not.toContain("sk-ant-");

    // One pull request, opened by the App, from `ai-office/memory`.
    const pulls = await s.fake
      .repository(repository)
      .listPullRequests({ head: memoryBranch });
    expect(pulls).toHaveLength(1);
    const [pull] = pulls;
    expect(pull).toMatchObject({
      number,
      title: memoryPullRequestTitle,
      base: "main",
      author: "ai-office[bot]",
      state: "open",
    });
    expect(pull?.body).toContain(
      `${s.manager.name}, the Floor's Manager, curated the repository's memory (\`${memoryPath}\`) as Batch ${String(batch.id)} ended.`,
    );
    expect(pull?.body).toContain(
      `**Added**\n\n- ${usePnpm}\n- ${buildFirst}\n- ${testsLive}\n- ${readme}`,
    );
    expect(pull?.body).toContain(
      "**Removed**\n\n- Use pnpm, not npm.\n- Always install dependencies with pnpm.\n- Run the tests with `npm test`.",
    );
    expect(pull?.body).toContain(
      `**Proposals taken** (3)\n\n- ${buildFirst} (${s.coder.name}, on #1)`,
    );

    // Its one commit, on the default branch: the curated file, as the Owner,
    // with the Manager's trailer.
    expect(await gitIn(s.remote, "show", `${memoryBranch}:${memoryPath}`)).toBe(
      memoryFile([usePnpm, buildFirst, testsLive, readme]).trim(),
    );
    expect(
      await gitIn(s.remote, "diff", "--name-only", "main", memoryBranch),
    ).toBe(memoryPath);
    const first = await commitOn(s.remote, memoryBranch);
    expect(first).toMatchObject({
      who: owner,
      committer: owner,
      parent: mainBefore,
    });
    expect(first.message).toMatch(
      /^docs\(memory\): curate the repository's memory\n\nMerged the two pnpm entries/,
    );
    expect(first.message.split("\n").at(-1)).toBe(
      `Agent: ${s.manager.name} (manager, Claude claude-opus-5-5)`,
    );

    // The proposals are taken; the Activity Feed and the Notice Board say so.
    expect(await s.stores.memory.pending("web-shop")).toEqual([]);
    expect(
      (await s.stores.memory.taken(outcome.curation.id)).map(
        ({ text }) => text,
      ),
    ).toEqual([buildFirst, testsLive, readme]);
    expect(ofType(await s.events(), "memory.curated")).toEqual([
      {
        type: "memory.curated",
        version: 1,
        floorId: "web-shop",
        agentId: s.manager.id,
        reason: "batch",
        batchId: batch.id,
        curatedBy: "model",
        entries: 4,
        added: 4,
        removed: 3,
        proposals: 3,
        pullRequest: number,
        url: pull?.htmlUrl,
      },
    ]);
    expect(
      [...s.stores.notices.notices.values()].filter(({ title }) =>
        title.startsWith("Memory"),
      ),
    ).toMatchObject([
      {
        kind: "info",
        title: `Memory PR #${String(number)} opened on web-shop: 4 entries added, 3 removed`,
        floorId: "web-shop",
        agentId: s.manager.id,
        pullRequest: { number, url: pull?.htmlUrl },
      },
    ]);

    // 6. A Batch is curated once.
    expect(await curation.check()).toEqual([]);
    expect(s.model.requestsOf(s.manager.id)).toHaveLength(1);

    // 7. Another proposal arrives while the pull request is still open; a
    // week on, the weekly tidy-up builds on its branch and updates the same
    // pull request, rather than opening another.
    await s.memory.propose({
      floorId: "web-shop",
      issue: 2,
      agentId: s.coder.id,
      entries: [pence],
    });
    clock += tidyUpMs - 1000;
    expect(await curation.check()).toEqual([]);
    clock += 1000;
    s.model.answer(
      s.manager.id,
      curatedAnswer("Took the pence proposal.", [
        usePnpm,
        buildFirst,
        testsLive,
        readme,
        pence,
      ]),
    );
    const [weekly, ...others] = await curation.check();
    expect(others).toEqual([]);
    expect(weekly).toMatchObject({
      curation: { reason: "weekly", batchId: null, pullRequest: number },
      added: [pence],
      removed: [],
      pullRequest: { number, opened: false },
    });
    expect(s.model.requestsOf(s.manager.id)[1]?.messages[0]?.content).toContain(
      `<memory>\n1. ${usePnpm}\n2. ${buildFirst}`,
    );
    expect(
      await s.fake
        .repository(repository)
        .listPullRequests({ head: memoryBranch, state: "all" }),
    ).toHaveLength(1);
    const second = await commitOn(s.remote, memoryBranch);
    expect(second.parent).toBe(
      await gitIn(s.remote, "rev-parse", `${memoryBranch}~1`),
    );
    expect(
      await gitIn(s.remote, "rev-list", "--count", `main..${memoryBranch}`),
    ).toBe("2");
    expect(await gitIn(s.remote, "show", `${memoryBranch}:${memoryPath}`)).toBe(
      memoryFile([usePnpm, buildFirst, testsLive, readme, pence]).trim(),
    );
    const comments = await s.fake.repository(repository).listComments(number);
    expect(comments.at(-1)?.body).toContain("in its weekly tidy-up");
    expect(comments.at(-1)?.body).toContain(`**Added**\n\n- ${pence}`);
    expect([...s.stores.notices.notices.values()].at(-1)?.title).toBe(
      `Memory PR #${String(number)} updated on web-shop: 1 entry added, 0 removed`,
    );
  });
});

// The cases below run in memory and in Postgres 18, on a Floor with the
// default team and a local bare repository standing in for GitHub's remote.

interface Setup {
  readonly root: string;
  readonly remote: string;
  readonly fake: FakeGitHub;
  readonly github: GitHubApp;
  readonly stores: OfficeStores;
  readonly model: FakeModel;
  readonly notices: Notices;
  readonly curation: MemoryCuration;
  readonly manager: AgentRecord;
  readonly coder: AgentRecord;
  readonly events: OfficeEvent[];
  propose(issue: number, ...entries: string[]): Promise<void>;
  advance(ms: number): void;
  /** The memory file on a branch of the remote. */
  fileOn(branch: string): Promise<string>;
  close(): Promise<void>;
}

async function setUp(
  stores: OfficeStores,
  bus: EventBus,
  memory?: string,
): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "ai-office-memory-"));
  const remote = join(root, "web-shop.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await exec("git", ["init", "--quiet", "-b", "main", seed]);
  await writeFile(join(seed, "README.md"), "# Web shop\n");
  if (memory !== undefined) {
    await mkdir(join(seed, ".agents"));
    await writeFile(join(seed, memoryPath), memory);
  }
  await gitIn(seed, "add", "-A");
  await gitIn(seed, "commit", "--quiet", "-m", "chore: start");
  await gitIn(seed, "push", "--quiet", remote, "main");

  const fake = createFakeGitHub();
  fake.installRepository(repository);
  const github = gitBackedGitHub(fake, remote);
  let clock = start.getTime();
  const now = () => new Date(clock);
  await createFloors({ store: stores.floors, github, events: bus, now }).add(
    repository,
  );
  const team = await stores.agents.list("web-shop");
  const manager = team.find(({ role }) => role === "manager");
  const coder = team.find(({ role }) => role === "coder");
  if (manager === undefined || coder === undefined) {
    throw new Error("A new Floor has a Manager and a coder.");
  }
  const events: OfficeEvent[] = [];
  bus.subscribe(({ event }) => {
    events.push(event);
  });
  const office = createOfficeSettings({
    store: stores.office,
    floors: stores.floors,
    events: bus,
  });
  const model = createFakeModel();
  const notices = createNotices({ store: stores.notices, events: bus, now });
  const repositoryMemory = createRepositoryMemory({
    github,
    store: stores.memory,
    events: bus,
    now,
  });
  const curation = createMemoryCuration({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models: model,
    store: stores.memory,
    batches: stores.batches,
    events: bus,
    notices,
    gitIdentity: (floorId) => office.floorGitIdentity(floorId),
    scratchDir: root,
    pushUrl: () => remote,
    now,
  });
  return {
    root,
    remote,
    fake,
    github,
    stores,
    model,
    notices,
    curation,
    manager,
    coder,
    events,
    async propose(issue, ...entries) {
      await repositoryMemory.propose({
        floorId: "web-shop",
        issue,
        agentId: coder.id,
        entries,
      });
    },
    advance(ms) {
      clock += ms;
    },
    fileOn: (branch) => gitIn(remote, "show", `${branch}:${memoryPath}`),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

const cases: [string, (setup: Setup) => Promise<void>][] = [
  [
    "when the Manager's Model gives no curated memory twice, or cannot be asked, AI Office's rules curate",
    async (setup) => {
      await setup.propose(4, buildFirst, testsLive);
      setup.model.answer(
        setup.manager.id,
        "Here is the memory.",
        '{"summary":"x","entries":["A.","a"]}',
      );
      const outcome = await setup.curation.curate("web-shop", {
        reason: "weekly",
      });
      const [, retry] = setup.model.requestsOf(setup.manager.id);
      expect(retry?.messages.at(-1)?.content).toBe(
        "That answer is not a valid curated memory: It has no JSON object. Answer again with only the JSON object, in the form asked for.",
      );
      expect(outcome).toMatchObject({
        curation: { curatedBy: "rules", entries: 3 },
        added: [buildFirst, testsLive],
        removed: [],
        fallback: `${setup.manager.name} gave no valid curated memory: entries 1 and 2 are the same: merge them into one.`,
        pullRequest: { opened: true },
      });
      expect(await setup.fileOn(memoryBranch)).toBe(
        memoryFile(["Use pnpm, never npm.", buildFirst, testsLive]).trim(),
      );

      // A paused Manager is not asked at all.
      await setup.stores.agents.update({ ...setup.manager, enabled: false });
      await setup.propose(5, pence);
      const paused = await setup.curation.curate("web-shop", {
        reason: "weekly",
      });
      expect(setup.model.requestsOf(setup.manager.id)).toHaveLength(2);
      expect(paused).toMatchObject({
        curation: { curatedBy: "rules" },
        added: [pence],
        fallback: `${setup.manager.name} is paused`,
        pullRequest: { number: outcome?.pullRequest?.number, opened: false },
      });
    },
  ],
  [
    "a curation that changes nothing opens no pull request, but takes the proposals; with nothing at all to curate, nothing is asked",
    async (setup) => {
      await setup.propose(4, "use pnpm, never npm");
      setup.model.answer(
        setup.manager.id,
        curatedAnswer("The proposal is already in the memory.", [
          "Use pnpm, never npm.",
        ]),
      );
      const outcome = await setup.curation.curate("web-shop", {
        reason: "weekly",
      });
      expect(outcome).toMatchObject({
        curation: { pullRequest: null, entries: 1 },
        added: [],
        removed: [],
      });
      expect(outcome?.pullRequest).toBeUndefined();
      expect(await setup.stores.memory.pending("web-shop")).toEqual([]);
      expect(
        await setup.fake
          .repository(repository)
          .listPullRequests({ state: "all" }),
      ).toEqual([]);
      expect(await gitIn(setup.remote, "branch", "--list", memoryBranch)).toBe(
        "",
      );
      expect(
        setup.events.filter(({ type }) => type === "memory.curated"),
      ).toEqual([
        {
          type: "memory.curated",
          version: 1,
          floorId: "web-shop",
          agentId: setup.manager.id,
          reason: "weekly",
          curatedBy: "model",
          entries: 1,
          added: 0,
          removed: 0,
          proposals: 1,
        },
      ]);
      expect(await setup.notices.open()).toEqual([]);
    },
  ],
  [
    "a Batch's end is curated once, even with nothing to curate, and only once every issue in its Plan is closed",
    async (setup) => {
      const client = setup.fake.repository(repository);
      await client.createIssue({ title: "One" });
      await client.createIssue({ title: "Two" });
      const { batch } = await setup.stores.batches.create(
        {
          floorId: "web-shop",
          issues: [1, 2],
          status: "in_progress",
          agentId: setup.manager.id,
          createdAt: start,
        },
        {
          draftedBy: "rules",
          summary: "Two issues.",
          items: [1, 2].map((issue) => ({
            issue,
            title: "x",
            dependsOn: [],
            files: [],
            agentId: null,
            note: "",
          })),
          overlaps: [],
          parallel: [[1, 2]],
          leftOut: [],
        },
      );
      await client.closeIssue(1);
      expect(await setup.curation.check()).toEqual([]);
      expect(await setup.stores.memory.curatedBatches([batch.id])).toEqual(
        new Set(),
      );
      await client.closeIssue(2);
      // No proposals and no memory: nothing to ask, and nothing to open.
      expect(await setup.curation.check()).toEqual([]);
      expect(await setup.stores.memory.curatedBatches([batch.id])).toEqual(
        new Set([batch.id]),
      );
      await setup.propose(2, pence);
      expect(await setup.curation.check()).toEqual([]);
      expect(setup.model.requests).toEqual([]);
      // The Batch's record cannot be made twice, in the store either.
      expect(
        await setup.stores.memory.recordCuration(
          {
            floorId: "web-shop",
            reason: "batch",
            batchId: batch.id,
            curatedBy: "rules",
            agentId: setup.manager.id,
            summary: "Again.",
            entries: 0,
            pullRequest: null,
            createdAt: start,
          },
          [],
        ),
      ).toBeUndefined();
      expect(await setup.stores.memory.pending("web-shop")).toHaveLength(1);
    },
  ],
  [
    "a finished Batch has ended, though one of its issues is still open, blocked: it is curated once",
    async (setup) => {
      const client = setup.fake.repository(repository);
      await client.createIssue({ title: "One" });
      await client.createIssue({ title: "Two" });
      const { batch } = await setup.stores.batches.create(
        {
          floorId: "web-shop",
          issues: [1, 2],
          status: "in_progress",
          agentId: setup.manager.id,
          createdAt: start,
        },
        {
          draftedBy: "rules",
          summary: "Two issues.",
          items: [1, 2].map((issue) => ({
            issue,
            title: "x",
            dependsOn: [],
            files: [],
            agentId: null,
            note: "",
          })),
          overlaps: [],
          parallel: [[1, 2]],
          leftOut: [],
        },
      );
      await client.closeIssue(1);
      expect(await setup.curation.check()).toEqual([]);
      expect(await setup.stores.memory.curatedBatches([batch.id])).toEqual(
        new Set(),
      );
      // #2 is blocked at needs-human, so the Batch finishes with it open.
      expect(
        await setup.stores.batches.markFinished(batch.id, start, {
          planVersion: 1,
          issues: [],
          leftOut: [],
          totals: {
            merged: 1,
            closed: 0,
            blocked: 1,
            notStarted: 0,
            tokens: 0,
            estimatedCostUsd: 0,
          },
        }),
      ).toBe(true);
      expect(await setup.stores.batches.open()).toEqual([]);
      const outcomes = await setup.curation.check();
      expect(outcomes.map(({ curation }) => curation)).toMatchObject([
        { reason: "batch", batchId: batch.id },
      ]);
      expect(await setup.stores.memory.curatedBatches([batch.id])).toEqual(
        new Set([batch.id]),
      );
      expect(await setup.curation.check()).toEqual([]);
    },
  ],
  [
    "the weekly tidy-up is due a week after the oldest proposal, then a week after each curation",
    async (setup) => {
      expect(await setup.curation.check()).toEqual([]);
      await setup.propose(4, pence);
      setup.advance(tidyUpMs - 1);
      expect(await setup.curation.check()).toEqual([]);
      setup.advance(1);
      setup.model.answer(
        setup.manager.id,
        curatedAnswer("Took one.", ["Use pnpm, never npm.", pence]),
      );
      expect(await setup.curation.check()).toMatchObject([
        { curation: { reason: "weekly" }, added: [pence] },
      ]);
      setup.advance(tidyUpMs - 1);
      expect(await setup.curation.check()).toEqual([]);
      // A week on, the memory is tidied up with no proposals waiting.
      setup.advance(1);
      setup.model.answer(
        setup.manager.id,
        curatedAnswer("Nothing to change.", ["Use pnpm, never npm.", pence]),
      );
      expect(await setup.curation.check()).toMatchObject([
        { curation: { reason: "weekly" }, added: [], removed: [] },
      ]);
      expect(setup.model.requestsOf(setup.manager.id)[1]?.system).toContain(
        "This is the memory's weekly tidy-up",
      );
    },
  ],
  [
    "an entry holding a credential never reaches the memory, and the summary is redacted",
    async (setup) => {
      await setup.propose(4, pence);
      setup.model.answer(
        setup.manager.id,
        curatedAnswer(`Took one. The deploy key is ${anthropicKey}.`, [
          "Use pnpm, never npm.",
          pence,
          `Deploy with ${anthropicKey}.`,
        ]),
      );
      const outcome = await setup.curation.curate("web-shop", {
        reason: "weekly",
      });
      expect(outcome?.entries).toEqual(["Use pnpm, never npm.", pence]);
      const number = outcome?.pullRequest?.number ?? 0;
      const pull = await setup.fake
        .repository(repository)
        .getPullRequest(number);
      const file = await setup.fileOn(memoryBranch);
      const commit = await commitOn(setup.remote, memoryBranch);
      for (const text of [pull.body, file, commit.message]) {
        expect(text).not.toContain("sk-ant-");
      }
      expect(pull.body).toContain("The deploy key is [REDACTED].");
      expect(JSON.stringify(setup.events)).not.toContain("sk-ant-");
    },
  ],
  [
    "once the memory's pull request is merged, the next curation starts from the default branch, in a new pull request",
    async (setup) => {
      await setup.propose(4, buildFirst);
      setup.model.answer(
        setup.manager.id,
        curatedAnswer("Took one.", ["Use pnpm, never npm.", buildFirst]),
      );
      const first = await setup.curation.curate("web-shop", {
        reason: "weekly",
      });
      const number = first?.pullRequest?.number ?? 0;
      // The Owner merges it.
      const merged = await gitIn(setup.remote, "rev-parse", memoryBranch);
      await gitIn(setup.remote, "update-ref", "refs/heads/main", merged);
      await setup.fake
        .repository(repository)
        .mergePullRequest(number, { method: "merge" });

      await setup.propose(5, pence);
      setup.model.answer(
        setup.manager.id,
        curatedAnswer("Took one.", ["Use pnpm, never npm.", buildFirst, pence]),
      );
      const second = await setup.curation.curate("web-shop", {
        reason: "weekly",
      });
      expect(second?.pullRequest).toMatchObject({ opened: true });
      expect(second?.pullRequest?.number).not.toBe(number);
      expect(second?.added).toEqual([pence]);
      expect((await commitOn(setup.remote, memoryBranch)).parent).toBe(merged);
    },
  ],
];

const handWritten = "# Notes\n\nUse pnpm, never npm.\n";

describe("curating the repository's memory, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const setup = await setUp(
        memoryStores(),
        createEventBus({ store: memoryEventStore() }),
        name.startsWith("a Batch's end") ? undefined : handWritten,
      );
      try {
        await run(setup);
      } finally {
        await setup.close();
      }
    });
  }
});

describe("curating the repository's memory, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const setup = await setUp(
        databaseStores(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
        name.startsWith("a Batch's end") ? undefined : handWritten,
      );
      try {
        await run(setup);
      } finally {
        await setup.close();
      }
    });
  }
});
