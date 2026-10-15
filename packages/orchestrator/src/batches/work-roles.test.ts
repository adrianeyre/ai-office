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
  type EventOfType,
  type OfficeEvent,
} from "@ai-office/events";
import type { GitHubApp } from "@ai-office/github";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import {
  defaultIntakeSettings,
  initialDefaultModels,
  type ReviewVerdict,
  type RoleDefinition,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { createAgents } from "../agents/agents.ts";
import type { AgentRecord } from "../agents/store.ts";
import { createCoderFlow } from "../coder/coder.ts";
import { createFloors } from "../floors/floors.ts";
import { createTriage } from "../manager/triage.ts";
import { createMergeFlow, type MergeFlow } from "../merge/merge.ts";
import { createFakeModel, type FakeModel } from "../models/fake-model.ts";
import { createNotices, type Notices } from "../notices/notices.ts";
import { createOfficeSettings } from "../office/settings.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { createReviewFlow } from "../review/reviewer.ts";
import { issueBranch } from "../sandbox/branch.ts";
import {
  createFakeSandbox,
  result,
  say,
  type FakeAgentContext,
} from "../sandbox/fake-sandbox.ts";
import { gitBackedGitHub, gitIn } from "../sandbox/git-backed-github.ts";
import { createSandboxRunner } from "../sandbox/runner.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  createWorkQueue,
  executeByStage,
  type WorkQueue,
} from "../work/queue.ts";
import {
  databaseWorkQueueStore,
  memoryWorkQueueStore,
  type WorkQueueStore,
} from "../work/store.ts";
import { createWorkTurns, type WorkTurns } from "../work/turns.ts";
import { createBatches, type Batches } from "./batches.ts";
import { planRetryMessage } from "./prompt.ts";

// Ordered work Roles for one issue (PRD FR-25 (1), §5 scenario 11; ADR
// 0003), end to end with a fake model, the fake GitHub over a local bare
// repository, and Agents as scripts in a fake sandbox, wired as the server
// wires them. On a store's Floor (a Manager, a merchandiser, a copywriter
// and a reviewer), the Owner files "add the autumn range" and hands it to
// the Manager, whose Plan gives it to the merchandiser and then the
// copywriter. Approved, the merchandiser works it on its branch and hands
// it to the copywriter (a Handoff, and its walk), who works on the same
// branch; then the pull request is opened and reviewed. Every commit
// carries its own Agent's `Agent:` trailer. The Review Loop sends a fix to
// the Role whose changes its blocking comments concern, or else to the
// last. Reordering the Roles on the whiteboard changes the order they run.
// Each case runs in memory and in Postgres 18.

const exec = promisify(execFile);
const shop = "adrianeyre/shop-theme";
const floorId = "shop-theme";
const gatewayKey = "aio_gk_thestoresagentskeyfortheirsandboxes0000000";

const role = (id: string, description: string): RoleDefinition => ({
  id,
  name: id,
  stage: "work",
  description,
  instructions: "- Commit your change.",
  skills: [],
  deskDressing: "books",
  aiProvider: "Claude",
  model: null,
});

const merchandiserRole = role(
  "merchandiser",
  "Changes product data: prices, variants, stock and collections.",
);
const copywriterRole = role(
  "copywriter",
  "Writes the words: product descriptions, page copy and emails.",
);

const autumnRange = {
  title: "Add the autumn range",
  body: [
    "Add the six autumn coats to the catalogue, with their prices and sizes, and write each one's description.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] Six products in the Autumn collection, each with a price and S, M and L",
    "- [ ] Each has a description in the brand's voice",
  ].join("\n"),
  labels: ["ai-office"],
};
const branch = issueBranch(1, autumnRange.title);
const productsFile = "products/autumn.json";
const copyFile = "copy/autumn.md";

/** What each Role's Agent writes, turn by turn: every line, each time. */
const products = (take: number) =>
  [1, 2, 3, 4, 5, 6]
    .map((coat) => `coat-${String(coat)}: S M L at ${String(100 + take)}`)
    .join("\n") + "\n";
const copy = (take: number) =>
  [1, 2, 3, 4, 5, 6]
    .map(
      (coat) =>
        `Coat ${String(coat)}, for cold mornings (take ${String(take)}).`,
    )
    .join("\n") + "\n";

interface Setup {
  readonly root: string;
  readonly remote: string;
  readonly fake: FakeGitHub;
  readonly github: GitHubApp;
  readonly stores: OfficeStores;
  readonly model: FakeModel;
  readonly notices: Notices;
  readonly queue: WorkQueue;
  readonly batches: Batches;
  readonly turns: WorkTurns;
  readonly manager: AgentRecord;
  readonly merchandiser: AgentRecord;
  readonly copywriter: AgentRecord;
  readonly reviewer: AgentRecord;
  /** Each sandbox run: the Agent's Role, and the prompt it was given. */
  readonly runs: { role: string; prompt: string }[];
  readonly events: () => Promise<OfficeEvent[]>;
  /** The Owner files "add the autumn range"; answers the issue. */
  file(): number;
  close(): Promise<void>;
}

/** A merchandiser or a copywriter at work: one commit, and its Handoff. */
async function working(
  { print, sh }: FakeAgentContext,
  path: string,
  text: string,
  subject: string,
): Promise<void> {
  await sh(`mkdir -p "$(dirname ${path})" && printf '%s' '${text}' > ${path}`);
  await sh(`git add -A && git commit --quiet -m "${subject}"`);
  print(
    say(
      [
        "Done.",
        "<handoff>",
        `Changed: ${subject}.`,
        `Check: ${path}.`,
        "Risks: none.",
        "</handoff>",
      ].join("\n"),
    ),
  );
  print(result({ input: 900, output: 150 }));
}

async function setUp(
  stores: OfficeStores,
  workStore: WorkQueueStore,
  bus: EventBus,
): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "ai-office-work-roles-"));
  const remote = join(root, "shop-theme.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await exec("git", ["init", "--quiet", "-b", "main", seed]);
  await writeFile(join(seed, "README.md"), "# Shop theme\n");
  await gitIn(seed, "add", "-A");
  await gitIn(seed, "commit", "--quiet", "-m", "chore: start");
  await gitIn(seed, "push", "--quiet", remote, "main");

  const fake = createFakeGitHub();
  fake.installRepository(shop);
  const github = gitBackedGitHub(fake, remote);
  await createFloors({
    store: stores.floors,
    github,
    events: bus,
    roles: stores.roles,
  }).add(shop);
  const defaultModels = () => Promise.resolve(initialDefaultModels);
  const agents = createAgents({
    store: stores.agents,
    floors: stores.floors,
    events: bus,
    defaultModels,
    roles: stores.roles,
  });
  const at = new Date("2026-10-10T09:00:00.000Z");
  for (const workRole of [merchandiserRole, copywriterRole]) {
    await stores.roles.create(workRole, at);
    await agents.addToTeam(floorId, workRole.id);
  }
  // The store's team: no coder and no QA, so review leads to the Merge
  // Policy.
  for (const { id, role: of } of await stores.agents.list(floorId)) {
    if (of === "coder" || of === "qa") {
      await agents.remove(floorId, id);
    }
  }
  const team = await stores.agents.list(floorId);
  const agent = (id: string): AgentRecord => {
    const found = team.find(({ role: of }) => of === id);
    if (found === undefined) {
      throw new Error(`The Floor has no ${id}.`);
    }
    return found;
  };
  const reviewer = agent("reviewer");
  await stores.floors.update(floorId, {
    requiredReviewerAgentIds: [reviewer.id],
  });

  const office = createOfficeSettings({
    store: stores.office,
    floors: stores.floors,
    events: bus,
  });
  const pipeline = createPipeline({ github, events: bus });
  const notices = createNotices({ store: stores.notices, events: bus });
  const model = createFakeModel();
  const turns = createWorkTurns({ store: stores.workTurns });
  const triage = createTriage({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models: model,
    defaultModels,
    notices,
    events: bus,
    store: stores.triage,
    roles: stores.roles,
  });

  const runs: { role: string; prompt: string }[] = [];
  const sandbox = await createFakeSandbox(async (context) => {
    const take = (of: string) =>
      runs.filter(({ role: ran }) => ran === of).length;
    if (context.prompt.includes("a merchandiser Agent in AI Office")) {
      runs.push({ role: "merchandiser", prompt: context.prompt });
      const n = take("merchandiser");
      await working(
        context,
        productsFile,
        products(n),
        `feat: the autumn coats' product data, take ${String(n)}`,
      );
      return;
    }
    runs.push({ role: "copywriter", prompt: context.prompt });
    const n = take("copywriter");
    await working(
      context,
      copyFile,
      copy(n),
      `feat: the autumn coats' copy, take ${String(n)}`,
    );
  });
  const runner = createSandboxRunner({
    github,
    events: bus,
    sandbox: (environment) => sandbox.provider(environment),
    gateway: () =>
      Promise.resolve({ url: "http://gateway:4000", key: gatewayKey }),
    workDir: join(root, "work"),
    cloneUrl: () => remote,
  });
  const holder: { queue?: WorkQueue } = {};
  const next = {
    enqueue: (work: Parameters<WorkQueue["enqueue"]>[0]) =>
      holder.queue?.enqueue(work) ?? Promise.resolve(),
  };
  // The Merge Policy waits for CI on its own clock, which passes at once.
  let clock = Date.now();
  const mergeFlow: MergeFlow = createMergeFlow({
    floors: stores.floors,
    agents: stores.agents,
    github,
    notices,
    events: bus,
    reviews: stores.reviews,
    batches: stores.batches,
    ownerLogin: async () => (await office.intakeSettings()).ownerLogin,
    now: () => new Date(clock),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  });
  const queue = createWorkQueue({
    store: workStore,
    agents: stores.agents,
    events: bus,
    limit: () => Promise.resolve(3),
    issuePriority: (floor, issue) => triage.priority(floor, issue),
    // As the server wires it: the Role whose turn it is, else triage's.
    issueRole: async (floor, issue) =>
      (await turns.role(floor, issue)) ?? triage.role(floor, issue),
    execute: executeByStage({
      "needs-work": createCoderFlow({
        floors: stores.floors,
        agents: stores.agents,
        github,
        pipeline,
        notices,
        events: bus,
        runner,
        gitIdentity: (floor) => office.floorGitIdentity(floor),
        defaultModels,
        scratchDir: root,
        pushUrl: () => remote,
        queue: next,
        reviews: stores.reviews,
        roles: stores.roles,
        turns,
      }),
      "needs-review": createReviewFlow({
        floors: stores.floors,
        agents: stores.agents,
        github,
        pipeline,
        notices,
        events: bus,
        models: model,
        defaultModels,
        reviews: stores.reviews,
        queue: next,
        roles: stores.roles,
        turns,
      }),
      "ready-to-merge": mergeFlow.execute,
    }),
  });
  holder.queue = queue;
  const batches = createBatches({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models: model,
    defaultModels,
    store: stores.batches,
    work: workStore,
    pipeline,
    queue,
    events: bus,
    notices,
    triage,
    turns,
    settings: () => Promise.resolve(defaultIntakeSettings),
  });
  await queue.start();
  return {
    root,
    remote,
    fake,
    github,
    stores,
    model,
    notices,
    queue,
    batches,
    turns,
    manager: agent("manager"),
    merchandiser: agent("merchandiser"),
    copywriter: agent("copywriter"),
    reviewer,
    runs,
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
    file: () => fake.createIssue(shop, autumnRange).number,
    async close() {
      await queue.stop();
      await batches.stop();
      mergeFlow.stop();
      triage.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The Manager's Plan for the autumn range: these work Roles, in turn. */
const planAnswer = (roles: readonly string[]): string =>
  JSON.stringify({
    summary: "The autumn range: its product data, then its copy.",
    issues: [
      {
        issue: 1,
        dependsOn: [],
        files: [productsFile, copyFile],
        agent: null,
        roles,
        note: "The coats first, then their words, on one branch.",
      },
    ],
  });

/** The Manager's triage: clear, at normal priority. */
const clear = JSON.stringify({
  clear: true,
  priority: "normal",
  reason: "It lists acceptance criteria.",
  questions: [],
});

const verdict = (answer: ReviewVerdict): string => JSON.stringify(answer);
const approve = verdict({
  verdict: "approve",
  summary: "The range and its copy are in.",
  comments: [],
});
/** A round's blocking comments, each on one of `paths`, saying `what`. */
const blockOn = (what: string, ...paths: string[]): string =>
  verdict({
    verdict: "changes_requested",
    summary: "Not yet.",
    comments: paths.map((path) => ({
      severity: "blocking",
      path,
      line: 1,
      body: `${what} in ${path}.`,
    })),
  });

const ofType = <Type extends OfficeEvent["type"]>(
  events: readonly OfficeEvent[],
  type: Type,
): EventOfType<Type>[] =>
  events.filter((event): event is EventOfType<Type> => event.type === type);

/** The branch's commits on the remote, oldest first. */
async function commits(
  setup: Setup,
): Promise<{ author: string; email: string; message: string }[]> {
  const { stdout } = await exec("git", [
    "--git-dir",
    setup.remote,
    "log",
    "--reverse",
    "--format=%an%x1f%ae%x1f%B%x1e",
    `main..${branch}`,
  ]);
  return stdout
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [author = "", email = "", message = ""] = entry.split("\x1f");
      return { author, email, message: message.trim() };
    });
}

/** The trailer an Agent's commits carry (FR-69). */
const trailerOf = (agent: AgentRecord, role: string): string =>
  `Agent: ${agent.name} (${role}, Claude ${initialDefaultModels.Claude ?? ""})`;

/**
 * The Owner hands the Manager "add the autumn range" in the Manager chat,
 * then approves its Plan; answers the Batch and the chat's answer.
 */
async function approved(
  setup: Setup,
  plan: readonly string[],
): Promise<{ batchId: number; answer: string }> {
  const issue = setup.file();
  setup.model.answer(setup.manager.id, planAnswer(plan), clear);
  const answer = await setup.batches.command(floorId, [issue]);
  const [batch] = await setup.stores.batches.open(floorId);
  if (batch === undefined) {
    throw new Error("The Batch is made.");
  }
  await setup.batches.approve(floorId, batch.id, 1);
  return { batchId: batch.id, answer };
}

const cases: [string, (setup: Setup) => Promise<void>][] = [
  [
    '"add the autumn range" runs the merchandiser then the copywriter on one branch, then review; each commit carries its Agent\'s trailer',
    async (setup) => {
      const { manager, merchandiser, copywriter, reviewer, model } = setup;
      model.answer(reviewer.id, approve);
      const { batchId, answer } = await approved(setup, [
        "merchandiser",
        "copywriter",
      ]);
      await setup.queue.idle();
      expect(answer).toContain(
        `1. #1 Add the autumn range: ${merchandiser.name} (merchandiser, then copywriter). Likely files: ${productsFile}, ${copyFile}.`,
      );

      // The Plan gave it both Roles, in turn.
      const plan = await setup.stores.batches.latestPlan(batchId);
      expect(plan?.items).toEqual([
        expect.objectContaining({
          issue: 1,
          roles: ["merchandiser", "copywriter"],
          agentId: merchandiser.id,
        }),
      ]);
      const [planned] = model.requestsOf(manager.id);
      expect(planned?.system).toContain("## The Floor's work Roles");
      expect(planned?.system).toContain(
        "- merchandiser: Changes product data: prices, variants, stock and collections.",
      );

      // The merchandiser, then the copywriter: one turn each.
      expect(setup.runs.map(({ role: ran }) => ran)).toEqual([
        "merchandiser",
        "copywriter",
      ]);
      const [first, second] = setup.runs;
      expect(first?.prompt).toContain(
        `You are ${merchandiser.name}, a merchandiser Agent in AI Office`,
      );
      expect(first?.prompt).toContain("## Work Roles taking turns");
      expect(first?.prompt).toContain(
        "This is turn 1 of 2: yours, as the merchandiser.",
      );
      expect(first?.prompt).toContain(
        "End your last message with a short Handoff for the copywriter, who works on it next,",
      );
      expect(second?.prompt).toContain(
        "This is turn 2 of 2: yours, as the copywriter.",
      );
      expect(second?.prompt).toContain(
        `${merchandiser.name}, the merchandiser, handed it to you.`,
      );
      expect(second?.prompt).toContain(
        "What changed: feat: the autumn coats' product data, take 1.",
      );
      expect(second?.prompt).toContain(
        "End your last message with a short Handoff for the reviewers,",
      );
      expect(second?.prompt).not.toContain("## Review feedback to fix");

      // One branch, holding both Roles' commits, each with its own
      // Agent's trailer, authored as the Owner.
      const identity = await createOfficeSettings({
        store: setup.stores.office,
        floors: setup.stores.floors,
        events: createEventBus({ store: memoryEventStore() }),
      }).floorGitIdentity(floorId);
      const onBranch = await commits(setup);
      expect(onBranch).toHaveLength(2);
      expect(onBranch.map(({ message }) => message.split("\n")[0])).toEqual([
        "feat: the autumn coats' product data, take 1",
        "feat: the autumn coats' copy, take 1",
      ]);
      expect(onBranch[0]?.message).toContain(
        trailerOf(merchandiser, "merchandiser"),
      );
      expect(onBranch[0]?.message).not.toContain(copywriter.name);
      expect(onBranch[1]?.message).toContain(
        trailerOf(copywriter, "copywriter"),
      );
      expect(onBranch[1]?.message).not.toContain(merchandiser.name);
      for (const commit of onBranch) {
        expect(commit.author).toBe(identity.name);
        expect(commit.email).toBe(identity.email);
      }
      expect(
        await setup.github
          .repository(shop)
          .getFileContent(productsFile, branch),
      ).toBe(products(1));
      expect(
        await setup.github.repository(shop).getFileContent(copyFile, branch),
      ).toBe(copy(1));

      // The Handoff between them, then one pull request, then review.
      const events = await setup.events();
      const sequence = events.flatMap((event) => {
        if (event.type === "branch.pushed") {
          return [`pushed by ${event.agentId}`];
        }
        if (event.type === "handoff") {
          return [
            `handoff ${event.fromAgentId} → ${event.toAgentId} (${event.stage})`,
          ];
        }
        if (event.type === "pull_request.opened") {
          return [`pull request by ${event.agentId}`];
        }
        if (
          event.type === "issue.label_changed" &&
          event.from !== "in-progress" &&
          event.to !== "in-progress"
        ) {
          return [`${String(event.from)} → ${String(event.to)}`];
        }
        if (event.type === "review.posted") {
          return [`review by ${event.agentId}`];
        }
        return [];
      });
      expect(sequence.slice(0, 8)).toEqual([
        "null → needs-work",
        `pushed by ${merchandiser.id}`,
        `handoff ${merchandiser.id} → ${copywriter.id} (needs-work)`,
        `pushed by ${copywriter.id}`,
        `pull request by ${copywriter.id}`,
        "needs-work → needs-review",
        `handoff ${copywriter.id} → ${reviewer.id} (needs-review)`,
        `review by ${reviewer.id}`,
      ]);
      expect(ofType(events, "pull_request.opened")).toHaveLength(1);
      expect(ofType(events, "issue.routed")).toEqual([
        expect.objectContaining({
          issue: 1,
          role: "merchandiser",
          routedBy: "plan",
        }),
      ]);
      // The reviewer reviewed both Roles' changes at once.
      const [review] = model.requestsOf(reviewer.id);
      const reviewed = JSON.stringify(review?.messages);
      expect(reviewed).toContain(productsFile);
      expect(reviewed).toContain(copyFile);
      // On to the Merge Policy: it awaits the Owner's approval.
      const pullRequest = (
        await setup.github.repository(shop).listPullRequests({ head: branch })
      )[0];
      expect(pullRequest?.title).toBe(autumnRange.title);
      expect(
        (await setup.notices.open({ floorId })).map(({ title }) => title),
      ).toContain(`PR #${String(pullRequest?.number)} awaiting your approval`);
      // Triage said so, with no Notice asking the Owner which Role.
      const comments = (
        await setup.github.repository(shop).listComments(1)
      ).map(({ body }) => body);
      expect(comments.join("\n")).toContain(
        "### Role: merchandiser, then copywriter",
      );
      expect(model.requestsOf(manager.id)).toHaveLength(2);
      expect(model.requestsOf(manager.id)[1]?.system).not.toContain(
        "## Which Role works it",
      );
      expect(await setup.turns.get(floorId, 1)).toEqual(
        expect.objectContaining({
          roles: ["merchandiser", "copywriter"],
          turn: 1,
          reviewing: true,
          files: { merchandiser: [productsFile], copywriter: [copyFile] },
        }),
      );
    },
  ],
  [
    "Review Loop fixes go back to the work Role whose changes the blocking comments concern, or to the last one when that is unclear",
    async (setup) => {
      const { merchandiser, copywriter, reviewer, model } = setup;
      model.answer(
        reviewer.id,
        // Round 1: only the merchandiser's product data.
        blockOn("Give each coat an XL", productsFile),
        // Round 2: both Roles' files, so whose is unclear.
        blockOn("Call them jackets", productsFile, copyFile),
        approve,
      );
      await approved(setup, ["merchandiser", "copywriter"]);
      await setup.queue.idle();

      expect(setup.runs.map(({ role: ran }) => ran)).toEqual([
        "merchandiser",
        "copywriter",
        // Round 1's fix: the product data is the merchandiser's.
        "merchandiser",
        // Round 2's fix: unclear, so the last Role's.
        "copywriter",
      ]);
      const fixes = setup.runs.slice(2);
      expect(fixes[0]?.prompt).toContain(
        "## Review feedback to fix (after round 1 of 3)",
      );
      expect(fixes[0]?.prompt).toContain(
        `Give each coat an XL in ${productsFile}.`,
      );
      expect(fixes[0]?.prompt).not.toContain("## Work Roles taking turns");
      expect(fixes[1]?.prompt).toContain(
        "## Review feedback to fix (after round 2 of 3)",
      );
      // A fix goes straight back to review: no turn for the other Role.
      const events = await setup.events();
      expect(
        ofType(events, "handoff")
          .filter(({ stage }) => stage === "needs-work")
          .map(({ fromAgentId, toAgentId }) => [fromAgentId, toAgentId]),
      ).toEqual([
        [merchandiser.id, copywriter.id],
        [reviewer.id, merchandiser.id],
        [reviewer.id, copywriter.id],
      ]);
      expect(
        ofType(events, "review.posted").map(({ verdict: given }) => given),
      ).toEqual(["changes_requested", "changes_requested", "approve"]);
      // Each fix is its own Agent's commit, on the same branch.
      const onBranch = await commits(setup);
      expect(
        onBranch.map(({ message }) =>
          message.includes(trailerOf(merchandiser, "merchandiser"))
            ? "merchandiser"
            : message.includes(trailerOf(copywriter, "copywriter"))
              ? "copywriter"
              : "neither",
        ),
      ).toEqual(["merchandiser", "copywriter", "merchandiser", "copywriter"]);
    },
  ],
  [
    "reordering the work Roles on the whiteboard changes the order they run; removing one leaves it out",
    async (setup) => {
      const { manager, merchandiser, copywriter, reviewer, model } = setup;
      const issue = setup.file();
      model.answer(manager.id, planAnswer(["merchandiser", "copywriter"]));
      const outcome = await setup.batches.create(floorId, [issue]);
      if (outcome.batch === undefined) {
        throw new Error("The Batch is made.");
      }
      const batchId = outcome.batch.id;
      // An edit may only reorder or remove the Plan's Roles.
      await expect(
        setup.batches.edit(floorId, batchId, {
          version: 1,
          items: [{ issue, annotation: "", roles: ["merchandiser", "coder"] }],
        }),
      ).rejects.toThrow(
        "#1's work Roles can only be reordered or removed, each kept once: it has merchandiser, copywriter.",
      );
      // The Owner puts the copywriter first. The Manager's first replan
      // keeps the old order, and is sent back.
      model.answer(
        manager.id,
        planAnswer(["merchandiser", "copywriter"]),
        planAnswer(["copywriter", "merchandiser"]),
      );
      const edited = await setup.batches.edit(floorId, batchId, {
        version: 1,
        items: [
          { issue, annotation: "", roles: ["copywriter", "merchandiser"] },
        ],
      });
      const replans = model.requestsOf(manager.id).slice(1);
      expect(replans[0]?.system).toContain(
        "work Roles in turn copywriter, then merchandiser: **the Owner's, keep them exactly, in this order**",
      );
      expect(replans[0]?.messages.at(-1)?.content).not.toContain(
        planRetryMessage("x").slice(0, 20),
      );
      expect(replans[1]?.messages.at(-1)?.content).toBe(
        planRetryMessage(
          "Keep the Owner's work Roles for #1 exactly, in turn: the copywriter, then the merchandiser.",
        ),
      );
      expect(edited.plan).toEqual(
        expect.objectContaining({
          version: 2,
          draftedBy: "model",
          editedFrom: 1,
        }),
      );
      expect(edited.plan.items).toEqual([
        expect.objectContaining({
          roles: ["copywriter", "merchandiser"],
          agentId: copywriter.id,
        }),
      ]);

      model.answer(manager.id, clear);
      model.answer(reviewer.id, approve);
      await setup.batches.approve(floorId, batchId, 2);
      await setup.queue.idle();
      expect(setup.runs.map(({ role: ran }) => ran)).toEqual([
        "copywriter",
        "merchandiser",
      ]);
      expect(setup.runs[0]?.prompt).toContain(
        "End your last message with a short Handoff for the merchandiser, who works on it next,",
      );
      const onBranch = await commits(setup);
      expect(onBranch[0]?.message).toContain(
        trailerOf(copywriter, "copywriter"),
      );
      expect(onBranch[1]?.message).toContain(
        trailerOf(merchandiser, "merchandiser"),
      );
      const events = await setup.events();
      expect(
        ofType(events, "handoff").map(({ fromAgentId, toAgentId }) => [
          fromAgentId,
          toAgentId,
        ])[0],
      ).toEqual([copywriter.id, merchandiser.id]);
      expect(ofType(events, "pull_request.opened")).toEqual([
        expect.objectContaining({ agentId: merchandiser.id }),
      ]);
    },
  ],
  [
    "a Plan whose work Roles the Owner cut down to one runs only that Role, then review",
    async (setup) => {
      const { manager, merchandiser, reviewer, model } = setup;
      const issue = setup.file();
      model.answer(manager.id, planAnswer(["merchandiser", "copywriter"]));
      const outcome = await setup.batches.create(floorId, [issue]);
      if (outcome.batch === undefined) {
        throw new Error("The Batch is made.");
      }
      // The Manager is paused: AI Office's rules replan, keeping the Role.
      await setup.stores.agents.update({ ...manager, enabled: false });
      const edited = await setup.batches.edit(floorId, outcome.batch.id, {
        version: 1,
        items: [{ issue, annotation: "", roles: ["merchandiser"] }],
      });
      expect(edited.plan.draftedBy).toBe("rules");
      expect(edited.plan.items).toEqual([
        expect.objectContaining({
          roles: ["merchandiser"],
          agentId: merchandiser.id,
        }),
      ]);
      await setup.stores.agents.update({ ...manager, enabled: true });
      model.answer(manager.id, clear);
      model.answer(reviewer.id, approve);
      await setup.batches.approve(floorId, outcome.batch.id, 2);
      await setup.queue.idle();
      expect(setup.runs.map(({ role: ran }) => ran)).toEqual(["merchandiser"]);
      expect(setup.runs[0]?.prompt).toContain(
        "End your last message with a short Handoff for the reviewers,",
      );
      const events = await setup.events();
      expect(
        ofType(events, "handoff").filter(({ stage }) => stage === "needs-work"),
      ).toEqual([]);
      expect(ofType(events, "pull_request.opened")).toEqual([
        expect.objectContaining({ agentId: merchandiser.id }),
      ]);
    },
  ],
];

describe("ordered work Roles for one issue, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const stores = memoryStores();
      const setup = await setUp(
        stores,
        memoryWorkQueueStore(stores.floors),
        createEventBus({ store: memoryEventStore() }),
      );
      try {
        await run(setup);
      } finally {
        await setup.close();
      }
    });
  }
});

describe("ordered work Roles for one issue, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const setup = await setUp(
        databaseStores(database.db),
        databaseWorkQueueStore(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
      try {
        await run(setup);
      } finally {
        await setup.close();
      }
    });
  }
});
