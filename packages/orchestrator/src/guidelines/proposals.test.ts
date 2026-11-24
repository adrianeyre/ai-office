import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentRecord } from "../agents/store.ts";
import { createFloors } from "../floors/floors.ts";
import type { FloorRecord } from "../floors/store.ts";
import { createNotices } from "../notices/notices.ts";
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
  createGuidelineApprovals,
  guidelineContentHash,
  type GuidelineApprovals,
} from "./approval.ts";
import {
  createGuidelineProposals,
  GuidelineProposalError,
  type GuidelineProposals,
} from "./proposals.ts";
import { techGuideline } from "./testing.ts";

// The Guidelines Agents propose (Guidelines, Specs and Hooks PRD, FR-110,
// FR-111; ADR 0014). The coder, the docs Agent and QA may end a Handoff, or
// QA's report, with one `<guideline name="…">` block: it is kept per Floor
// for the Owner, a credential drops it, and it is a `guideline.proposed`
// event; no model accepts one. The Owner opens one as a pull request, which
// commits only its file under `.agents/guidelines/` on a branch of its own,
// or rejects it. No Agent gets what was proposed until the Owner merges it.
// The first scenario runs the whole pipeline (fake sandbox, fake model, a
// local bare repository standing in for GitHub's remote); the cases after
// it run in memory and in Postgres 18.

const exec = promisify(execFile);
const owner = "adrianeyre";
const ownerIdentity =
  "adrianeyre <21265837+adrianeyre@users.noreply.github.com>";
const anthropicKey = "sk-ant-api03-pastedintoguideline-Qw3Er4Ty5Ui6Op7As8Df9";

/** `tech`, as the coder would have it. */
const techProposed =
  "Use pnpm, never npm.\nWrite strict TypeScript.\nNo default exports.\n";
/** A new Guideline QA proposes. */
const testingProposed = [
  "---",
  "description: How bugs are fixed.",
  "---",
  "",
  "Every bug fix comes with a test that failed before it.",
  "",
].join("\n");

const block = (name: string, content: string): string[] => [
  `<guideline name="${name}">`,
  ...content.trimEnd().split("\n"),
  "</guideline>",
];

/** The latest commit on `ref` in the remote: who, its parent, its message. */
const commitOn = async (remote: string, ref: string) => {
  const [who = "", parent = "", ...message] = (
    await gitIn(remote, "log", "-1", "--format=%an <%ae>%n%P%n%B", ref)
  ).split("\n");
  return { who, parent, message: message.join("\n").trim() };
};

/** The files a commit changed against its parent. */
const changedBy = async (remote: string, ref: string): Promise<string[]> =>
  (await gitIn(remote, "diff-tree", "-r", "--name-only", "--no-commit-id", ref))
    .split("\n")
    .filter((path) => path !== "");

describe("the Guidelines Agents propose, through the pipeline", () => {
  let current: Scenario | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  it("are kept for the Owner from the coder's and QA's, never one with a credential, reach no later Agent, and open as a pull request of their one file", async () => {
    const s = await scenario({
      withDocs: true,
      guidelines: [techGuideline],
      guidelineProposals: {
        coder: block("tech", techProposed),
        qa: block("testing", testingProposed),
        docs: block(
          "deploying",
          `Deploy with the key ${anthropicKey}, from main only.\n`,
        ),
      },
    });
    current = s;
    const { qa, docs } = s;
    if (qa === undefined || docs === undefined) {
      throw new Error("The Floor has a QA and a docs Agent.");
    }
    // The Owner approved `tech` as it is: a name the Floor has.
    await s.stores.guidelines.approve(
      "web-shop",
      {
        name: "tech",
        contentHash: techGuideline.contentHash,
        content: techGuideline.content,
        approval: "owner_merge",
      },
      new Date(),
    );
    s.model.answer(s.grace.id, approve());
    s.model.answer(s.quinta.id, approve());
    await s.run();

    // 1. Each Agent given Guidelines is told how to propose one.
    for (const [prompt, where] of [
      [s.prompts[0], "Handoff"],
      [s.qaPrompts[0], "report"],
      [s.docsPrompts[0], "Handoff"],
    ] as const) {
      expect(prompt).toContain(
        `you may propose one new or changed Guideline inside your ${where}`,
      );
    }

    // 2. The coder's and QA's wait for the Owner; the docs Agent's, with a
    // credential, is dropped whole: never kept, never an event.
    const { proposals } = await s.guidelineProposals.list("web-shop");
    expect(
      proposals.map(({ name, content, agentId, agentName, issue, path }) => ({
        name,
        content,
        agentId,
        agentName,
        issue,
        path,
      })),
    ).toEqual([
      {
        name: "tech",
        content: techProposed,
        agentId: s.coder.id,
        agentName: s.coder.name,
        issue: 1,
        path: ".agents/guidelines/tech.md",
      },
      {
        name: "testing",
        content: testingProposed,
        agentId: qa.id,
        agentName: qa.name,
        issue: 1,
        path: ".agents/guidelines/testing.md",
      },
    ]);
    expect(ofType(await s.events(), "guideline.proposed")).toEqual([
      {
        type: "guideline.proposed",
        version: 1,
        floorId: "web-shop",
        agentId: s.coder.id,
        issue: 1,
        name: "tech",
        contentHash: guidelineContentHash(techProposed),
        new: false,
      },
      {
        type: "guideline.proposed",
        version: 1,
        floorId: "web-shop",
        agentId: qa.id,
        issue: 1,
        name: "testing",
        contentHash: guidelineContentHash(testingProposed),
        new: true,
      },
    ]);
    const everything = JSON.stringify([
      await s.events(),
      [...s.stores.notices.notices.values()],
      await s.guidelineProposals.list("web-shop"),
    ]);
    expect(everything).not.toContain(anthropicKey);
    expect(everything).not.toContain("pastedintoguideline");

    // 3. Nothing proposed reaches a later Agent: not the reviewers given
    // the coder's Handoff, nor QA, the docs Agent, or the pull request's
    // QA comment.
    const later = JSON.stringify([
      s.model.requestsOf(s.grace.id),
      s.model.requestsOf(s.quinta.id),
      s.qaPrompts,
      s.docsPrompts,
      ofType(await s.events(), "handoff"),
      await Promise.all(
        ofType(await s.events(), "pull_request.opened").map(({ pullRequest }) =>
          s.github.repository(repository).listComments(pullRequest),
        ),
      ),
    ]);
    expect(later).not.toContain("No default exports");
    expect(later).not.toContain("Every bug fix comes with a test");
    expect(later).not.toContain('<guideline name="');

    // 4. The Owner opens the coder's as a pull request: the GitHub App
    // commits only its file, as the Owner with the coder's trailer, on a
    // branch of its own from the default branch.
    const tech = proposals.find(({ name }) => name === "tech");
    if (tech === undefined) {
      throw new Error("The coder proposed tech.");
    }
    const opened = await s.guidelineProposals.open("web-shop", tech.id);
    const head = `ai-office/guideline-tech-${String(tech.id)}`;
    expect(await changedBy(s.remote, head)).toEqual([
      ".agents/guidelines/tech.md",
    ]);
    expect(
      await gitIn(s.remote, "show", `${head}:.agents/guidelines/tech.md`),
    ).toBe(techProposed.trimEnd());
    const commit = await commitOn(s.remote, head);
    expect(commit.who).toBe(ownerIdentity);
    expect(commit.parent).toBe(await gitIn(s.remote, "rev-parse", "main"));
    expect(commit.message).toContain(
      "docs(guidelines): change the tech Guideline",
    );
    expect(commit.message).toContain(`Agent: ${s.coder.name} (coder,`);
    const pull = await s.github
      .repository(repository)
      .getPullRequest(opened.pullRequest.number);
    expect(pull).toMatchObject({
      title: "docs(guidelines): change the tech Guideline",
      head: { name: head },
      base: "main",
      state: "open",
    });
    expect(pull.body).toContain("No Agent gets this version until you merge");
    expect(pull.body).not.toMatch(/\b(?:closes|fixes|resolves) #/i);
    expect(opened.proposals.map(({ name }) => name)).toEqual(["testing"]);

    // 5. Each is settled once; the Owner rejects QA's.
    await expect(
      s.guidelineProposals.open("web-shop", tech.id),
    ).rejects.toMatchObject({ code: "settled" });
    const testing = proposals.find(({ name }) => name === "testing");
    expect(
      await s.guidelineProposals.reject("web-shop", testing?.id ?? 0),
    ).toEqual({ proposals: [] });
    await expect(
      s.guidelineProposals.open("web-shop", testing?.id ?? 0),
    ).rejects.toBeInstanceOf(GuidelineProposalError);
    await expect(
      s.guidelineProposals.reject("web-shop", 999),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

// The cases below run in memory and in Postgres 18, on a Floor with the
// default team and a local bare repository standing in for GitHub's remote.

interface Setup {
  readonly root: string;
  readonly remote: string;
  readonly fake: FakeGitHub;
  readonly stores: OfficeStores;
  readonly floor: FloorRecord;
  readonly coder: AgentRecord;
  readonly proposals: GuidelineProposals;
  /** What Agents get: read from GitHub's own record of who merged what. */
  readonly approvals: GuidelineApprovals;
  readonly events: OfficeEvent[];
  /** The coder ends its Handoff on `issue` with `inside`. */
  handoff(issue: number, ...inside: string[]): Promise<unknown>;
  close(): Promise<void>;
}

async function setUp(stores: OfficeStores, bus: EventBus): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "ai-office-guidelines-"));
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
  const floor = await createFloors({
    store: stores.floors,
    github,
    events: bus,
  }).add(repository);
  const coder = (await stores.agents.list(floor.id)).find(
    ({ role }) => role === "coder",
  );
  if (coder === undefined) {
    throw new Error("A new Floor has a coder.");
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
  const proposals = createGuidelineProposals({
    floors: stores.floors,
    agents: stores.agents,
    store: stores.guidelineProposals,
    guidelines: stores.guidelines,
    events: bus,
    github,
    gitIdentity: (floorId) => office.floorGitIdentity(floorId),
    scratchDir: root,
    pushUrl: () => remote,
  });
  // Read from the fake as GitHub has it, merges and all.
  const approvals = createGuidelineApprovals({
    github: fake,
    store: stores.guidelines,
    floors: stores.floors,
    notices: createNotices({ store: stores.notices, events: bus }),
    events: bus,
    ownerLogin: () => Promise.resolve(owner),
  });
  return {
    root,
    remote,
    fake,
    stores,
    floor,
    coder,
    proposals,
    approvals,
    events,
    handoff: (issue, ...inside) =>
      proposals.propose({
        floorId: floor.id,
        issue,
        agentId: coder.id,
        text: [
          "<handoff>",
          "Changed: The basket.",
          "Check: Its total.",
          "Risks: None.",
          ...inside,
          "</handoff>",
        ].join("\n"),
        tag: "handoff",
      }),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

const accessibility = (rule: string) => `Every image has ${rule}.\n`;

const cases: [string, (setup: Setup) => Promise<void>][] = [
  [
    "keeps a proposal once per version, drops one without a name or with a credential, and never a model's say",
    async (setup) => {
      expect(
        await setup.handoff(
          4,
          ...block("accessibility", accessibility("alt text")),
        ),
      ).toMatchObject({ name: "accessibility", status: "proposed", issue: 4 });
      // The same version again, from another issue, waits once.
      expect(
        await setup.handoff(
          5,
          ...block("accessibility", accessibility("alt text")),
        ),
      ).toBeUndefined();
      expect(
        await setup.handoff(5, "<guideline>", "Use pnpm.", "</guideline>"),
      ).toBeUndefined();
      expect(
        await setup.handoff(
          5,
          '<guideline name="tech">',
          `ANTHROPIC_API_KEY=${anthropicKey}`,
          "</guideline>",
        ),
      ).toBeUndefined();
      const { proposals } = await setup.proposals.list(setup.floor.id);
      expect(proposals).toEqual([
        {
          id: expect.any(Number) as unknown,
          name: "accessibility",
          path: ".agents/guidelines/accessibility.md",
          content: accessibility("alt text"),
          contentHash: guidelineContentHash(accessibility("alt text")),
          agentId: setup.coder.id,
          agentName: setup.coder.name,
          issue: 4,
          proposedAt: expect.any(String) as unknown,
        },
      ]);
      expect(
        ofType(setup.events, "guideline.proposed").map(
          ({ name, new: isNew }) => [name, isNew],
        ),
      ).toEqual([["accessibility", true]]);
      expect(JSON.stringify(setup.events)).not.toContain(anthropicKey);
      // Kept per Floor.
      setup.fake.installRepository("adrianeyre/blog");
      await createFloors({
        store: setup.stores.floors,
        github: setup.fake,
        events: createEventBus({ store: memoryEventStore() }),
      }).add("adrianeyre/blog");
      expect(await setup.proposals.list("blog")).toEqual({ proposals: [] });
    },
  ],
  [
    "gives Agents nothing proposed until the Owner merges its pull request: not when it is proposed, opened, or merged by anyone else",
    async (setup) => {
      const { floor, fake, proposals, approvals } = setup;
      const given = async () =>
        (await approvals.sync(floor)).approved.map(({ name, content }) => ({
          name,
          content,
        }));
      await setup.handoff(
        4,
        ...block("accessibility", accessibility("alt text")),
      );
      await setup.handoff(
        5,
        ...block("accessibility", accessibility("a caption")),
      );
      const [first, second] = (await proposals.list(floor.id)).proposals;
      if (first === undefined || second === undefined) {
        throw new Error("Both proposals wait.");
      }
      expect(await given()).toEqual([]);

      const openedFirst = await proposals.open(floor.id, first.id);
      const openedSecond = await proposals.open(floor.id, second.id);
      // Opened, not merged: still nothing.
      expect(await given()).toEqual([]);

      // Merged by someone other than the Owner: it waits for the Owner.
      fake.mergePullRequest(repository, openedFirst.pullRequest.number, {
        actor: "mallory",
      });
      const merged = await approvals.sync(floor);
      expect(merged.approved).toEqual([]);
      expect(merged.unapproved).toMatchObject([
        { name: "accessibility", status: "awaiting" },
      ]);

      // Merged by the Owner: that version is approved, and Agents get it.
      fake.mergePullRequest(repository, openedSecond.pullRequest.number, {
        actor: owner,
      });
      expect(await given()).toEqual([
        { name: "accessibility", content: accessibility("a caption") },
      ]);
      expect(
        ofType(setup.events, "guideline.approved").map(
          ({ name, approval, pullRequest }) => [name, approval, pullRequest],
        ),
      ).toEqual([
        ["accessibility", "owner_merge", openedSecond.pullRequest.number],
      ]);
    },
  ],
  [
    "opens nothing when the default branch has the file as proposed, and nothing on an archived Floor",
    async (setup) => {
      const { floor, proposals } = setup;
      await setup.handoff(
        4,
        ...block("accessibility", accessibility("alt text")),
      );
      const [first] = (await proposals.list(floor.id)).proposals;
      const opened = await proposals.open(floor.id, first?.id ?? 0);
      // The Owner merges it on the remote, as it stands.
      await gitIn(
        setup.remote,
        "update-ref",
        "refs/heads/main",
        `refs/heads/ai-office/guideline-accessibility-${String(first?.id ?? 0)}`,
      );
      expect(opened.pullRequest.number).toBeGreaterThan(0);
      await setup.handoff(
        6,
        ...block("accessibility", accessibility("alt text")),
      );
      const [again] = (await proposals.list(floor.id)).proposals;
      await expect(
        proposals.open(floor.id, again?.id ?? 0),
      ).rejects.toMatchObject({ code: "unchanged" });
      // Still waiting, for the Owner to reject.
      expect((await proposals.list(floor.id)).proposals).toHaveLength(1);

      await setup.stores.floors.archive(floor.id, new Date());
      await expect(
        proposals.reject(floor.id, again?.id ?? 0),
      ).rejects.toMatchObject({ code: "floor_archived" });
    },
  ],
];

describe("the Guidelines Agents propose, kept and opened", () => {
  for (const [name, check] of cases) {
    it(`in memory ${name}`, async () => {
      const setup = await setUp(
        memoryStores(),
        createEventBus({ store: memoryEventStore() }),
      );
      try {
        await check(setup);
      } finally {
        await setup.close();
      }
    });

    postgresTest(`in Postgres 18 ${name}`, async ({ database }) => {
      const setup = await setUp(
        databaseStores(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
      try {
        await check(setup);
      } finally {
        await setup.close();
      }
    });
  }
});
