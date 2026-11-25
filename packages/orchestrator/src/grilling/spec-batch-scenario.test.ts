import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  memoryEventStore,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  amendSpecText,
  confirmSpecPhaseText,
  createRedactor,
  defaultIntakeSettings,
  fileGrillingIssuesText,
  reopenSpecPhaseText,
  skipSpecDesignText,
  specSkillName,
  specTasksDocument,
} from "@ai-office/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBatches } from "../batches/batches.ts";
import { createFloors } from "../floors/floors.ts";
import { floorChatSkills } from "../manager/chat-skills.ts";
import { createManagerChat, type ManagerChatUpdate } from "../manager/chat.ts";
import { createTriage } from "../manager/triage.ts";
import type {
  ModelClient,
  ModelReply,
  ModelRequest,
  ModelStreamOptions,
} from "../models/client.ts";
import { createFakeModel } from "../models/fake-model.ts";
import { createNotices } from "../notices/notices.ts";
import { createOfficeSettings } from "../office/settings.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { gitBackedGitHub, gitIn } from "../sandbox/git-backed-github.ts";
import { withBuiltInSkills } from "../skills/floor.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createWorkQueue } from "../work/queue.ts";
import {
  databaseWorkQueueStore,
  memoryWorkQueueStore,
  type WorkQueueStore,
} from "../work/store.ts";
import { createGrillingDocuments } from "./documents.ts";
import { createGrillingIssues } from "./issues.ts";
import { specIssues } from "./spec.ts";

// A Spec's tasks become issues, and filing them starts their Batch
// (Guidelines, Specs and Hooks PRD, FR-115, FR-117; §5 scenario 3), end to
// end through the Manager chat, with the fake GitHub, the Floor's triage,
// Batches and work queue as the server wires them. The Owner agrees a
// Spec with `/spec` (its requirements confirmed, the design skipped, its
// tasks confirmed), then says "file the issues of session 1": one issue
// per task, each linking the Spec, listing `Meets:` and quoting those
// criteria as its task list, blocked by the tasks it depends on; tasks.md
// on the session's branch links each, with no status; and a Batch starts
// whose Plan is the tasks' order and dependencies, approved by the tasks
// the Owner confirmed, its triage asking no model. Drafts the Owner edited
// after confirming the tasks follow the Floor's plan approval instead;
// "… in one PR" makes it a One-pull-request Batch. Code moves on after a
// Spec is approved (FR-117): "/spec amend <slug>" reopens it at its
// requirements with the documents approved last loaded, and its pull
// request updates the Spec's files, tasks kept as they were keeping their
// issues. Each case runs in memory and in Postgres 18.

const exec = promisify(execFile);
const repository = "adrianeyre/web-shop";
const branch = "ai-office/grilling-1";
const topic = "checkout with saved cards";
const slug = "checkout-with-saved-cards";
const folder = `.agents/specs/${slug}`;

type Answer = (
  request: ModelRequest,
  options: ModelStreamOptions,
) => Promise<ModelReply>;

/** The Manager chat's model, whose turns the test writes. */
function scriptedModel() {
  const answers: Answer[] = [];
  const asked: ModelRequest[] = [];
  const client: ModelClient = {
    complete: () => Promise.reject(new Error("The chat streams its calls.")),
    stream(_request, options) {
      asked.push(_request);
      const answer = answers.shift();
      return answer === undefined
        ? Promise.reject(new Error("No answer was scripted."))
        : answer(_request, options);
    },
  };
  return {
    client,
    asked,
    turn(value: unknown): void {
      const text = `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
      answers.push((_request, { onText }) => {
        onText(text);
        return Promise.resolve({ text, stopReason: "end_turn" });
      });
    },
  };
}

const requirements = {
  introduction: "Shoppers keep their cards to pay faster.",
  requirements: [
    {
      title: "Save a card",
      story: "As a shopper, I want to save my card, so that I pay faster.",
      criteria: [
        "R1.1 WHEN a shopper ticks Save card at checkout THE SYSTEM SHALL keep the card's token.",
        "R1.2 WHEN a card is saved THE SYSTEM SHALL show its last four digits.",
      ],
    },
    {
      title: "Pay with a saved card",
      story:
        "As a shopper, I want to pay with a saved card, so that I need not type it.",
      criteria: [
        "R2.1 WHEN a shopper with saved cards checks out THE SYSTEM SHALL offer them first.",
        "R2.2 IF a saved card is declined THEN THE SYSTEM SHALL ask for another card.",
      ],
    },
  ],
};

/** Three tasks: the second depends on the first; the third on none. */
const tasks = [
  {
    title: "Save a card at checkout",
    description: "The vault, the table and the Save card tick box.",
    meets: ["R1.1", "R1.2"],
    dependsOn: [],
  },
  {
    title: "Offer saved cards first",
    description: "The checkout lists saved cards before the card form.",
    meets: ["R2.1"],
    dependsOn: [1],
  },
  {
    title: "Ask for another card when one is declined",
    description: "A declined saved card asks for another.",
    meets: ["R2.2"],
    dependsOn: [],
  },
];

const design = {
  overview: "A card vault behind the checkout.",
  architecture: "The checkout asks the vault for a shopper's saved cards.",
  data: "A saved_cards table: token, last four digits.",
  errorHandling: "A declined card is never saved.",
  testing: "One test per Acceptance Criterion.",
};

async function seedRepository(root: string): Promise<string> {
  const remote = join(root, "web-shop.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await exec("git", ["init", "--quiet", "-b", "main", seed]);
  await writeFile(join(seed, "README.md"), "# Web shop\n");
  await gitIn(seed, "add", "-A");
  await gitIn(seed, "commit", "--quiet", "-m", "chore: start");
  await gitIn(seed, "push", "--quiet", remote, "main");
  return remote;
}

async function setUp(
  stores: OfficeStores,
  workStore: WorkQueueStore,
  root: string,
) {
  const remote = await seedRepository(root);
  const fake = createFakeGitHub();
  fake.installRepository(repository);
  const github = gitBackedGitHub(fake, remote);
  const events = createEventBus({ store: memoryEventStore() });
  const published: OfficeEvent[] = [];
  events.subscribe(({ event }) => {
    published.push(event);
  });
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 24, 12, 0, tick++));
  await createFloors({ store: stores.floors, github, events }).add(repository);
  const office = createOfficeSettings({
    store: stores.office,
    floors: stores.floors,
    events,
  });
  const redactor = createRedactor();
  const notices = createNotices({ store: stores.notices, events, now });
  // Triage, Plans and Kickoffs reach models through this one: it answers
  // nothing, and keeps every request it was asked.
  const models = createFakeModel();
  const triage = createTriage({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models,
    notices,
    events,
    store: stores.triage,
    roles: stores.roles,
    // As the server wires it (FR-115).
    specIssues: (floorId) => specIssues(stores.grilling, floorId),
    redactor,
    now,
  });
  const queue = createWorkQueue({
    store: workStore,
    agents: stores.agents,
    events,
    limit: () => Promise.resolve(3),
    // Work starts, and runs until the test ends.
    execute: (_work, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          resolve("failed");
        });
      }),
    issuePriority: (floorId, number) => triage.priority(floorId, number),
    issueRole: (floorId, number) => triage.role(floorId, number),
    now,
  });
  await queue.start();
  const batches = createBatches({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models,
    store: stores.batches,
    work: workStore,
    pipeline: createPipeline({ github, events }),
    queue,
    events,
    notices,
    triage,
    settings: () => Promise.resolve(defaultIntakeSettings),
    redactor,
    now,
  });
  const model = scriptedModel();
  const chat = createManagerChat({
    store: stores.managerChat,
    floors: stores.floors,
    agents: stores.agents,
    models: model.client,
    grilling: stores.grilling,
    documents: createGrillingDocuments({
      github,
      events,
      notices,
      gitIdentity: (floorId) => office.floorGitIdentity(floorId),
      scratchDir: root,
      pushUrl: () => remote,
      now,
    }),
    issues: createGrillingIssues({ github, events, now }),
    // As the server wires it.
    specBatch: async (floorId, spec, { onePullRequest }) =>
      batches.describe(
        floorId,
        await batches.create(floorId, [], undefined, { onePullRequest, spec }),
      ),
    redactor,
    now,
    skills: floorChatSkills({
      available: () =>
        Promise.resolve({
          skills: withBuiltInSkills([]),
          ignored: [],
          repositoryError: null,
        }),
    }),
  });
  const updates: ManagerChatUpdate[] = [];
  chat.subscribe("web-shop", (update) => updates.push(update));

  /** Sends `text`, and the text of every answer kept for it once the Manager is done. */
  const say = async (text: string): Promise<string> => {
    const sent = await chat.send("web-shop", text);
    if (sent.reply !== undefined) {
      return sent.reply.text;
    }
    await vi.waitFor(
      async () => {
        expect(
          updates.some(
            (update) =>
              update.type === "message" &&
              update.message.replyTo === sent.message.id,
          ),
        ).toBe(true);
        expect((await chat.history("web-shop")).pending).toEqual([]);
      },
      { timeout: 10_000 },
    );
    return (await chat.history("web-shop")).messages
      .filter(({ replyTo }) => replyTo === sent.message.id)
      .map(({ text: reply }) => reply)
      .join("\n---\n");
  };

  /**
   * The Owner agrees the Spec: requirements confirmed, the design skipped
   * and the tasks confirmed, which opens its pull request and keeps the
   * tasks as the session's issue drafts.
   */
  const agreeSpec = async () => {
    model.turn({ message: "The requirements.", spec: { requirements } });
    await say(`/${specSkillName} ${topic}`);
    model.turn({ message: "The design.", spec: { design } });
    await say(confirmSpecPhaseText("requirements"));
    model.turn({ message: "The tasks.", spec: { tasks } });
    await say(skipSpecDesignText);
    await say(confirmSpecPhaseText("tasks"));
    const session = (await chat.grillingSession("web-shop", 1)).session;
    expect(session.status).toBe("ended");
    expect(session.issues?.drafts).toHaveLength(3);
    return session;
  };

  const client = fake.repository(repository);
  return {
    model,
    remote,
    fake,
    chat,
    stores,
    workStore,
    models,
    published,
    say,
    agreeSpec,
    session: async () => (await chat.grillingSession("web-shop", 1)).session,
    /** The issues filed for the drafts, in the tasks' order. */
    filed: async () =>
      ((await chat.grillingSession("web-shop", 1)).session.issues?.drafts ?? [])
        .map(({ filed }) => filed)
        .filter((filed) => filed !== null),
    fileOn: async (ref: string, path: string) =>
      `${await gitIn(remote, "show", `${ref}:${path}`)}\n`,
    issue: (number: number) => client.getIssue(number),
    openBatch: async () => {
      const [batch, ...others] = await stores.batches.open("web-shop");
      expect(others).toEqual([]);
      if (batch === undefined) {
        throw new Error("No Batch was started.");
      }
      const plan = await stores.batches.latestPlan(batch.id);
      return { batch, plan };
    },
    stop: () => queue.stop(),
  };
}

type Setup = Awaited<ReturnType<typeof setUp>>;
type Case = [name: string, run: (s: Setup) => Promise<void>];

/** What the Model was asked of an issue: triage asks with it. */
const askedOfIssues = (s: Setup) =>
  s.models.requests.filter(({ issue }) => issue !== undefined);

const cases: Case[] = [
  [
    "filing a Spec's issues files one per task and starts a Batch in the tasks' order, approved by the confirmed tasks, its triage asking no model",
    async (s) => {
      await s.agreeSpec();
      const filedText = await s.say(fileGrillingIssuesText(1));
      const [first, second, third] = await s.filed();
      if (first == null || second == null || third == null) {
        throw new Error("Not every task was filed.");
      }

      // One issue per task: it links the Spec, lists what it meets,
      // quotes those criteria as its task list and says what blocks it.
      const [pull] = await s.fake
        .repository(repository)
        .listPullRequests({ state: "all" });
      const tree = `https://github.com/${repository}/tree/${branch}/${folder}`;
      const body = (await s.issue(second.number)).body;
      expect(body).toContain(
        `## Spec\n\nFiled from the Spec in [\`${folder}/\`](${tree}) (pull request #${String(pull?.number)}): task 2 of its \`tasks.md\`, which the Owner confirmed in the Grilling Session 1 on ${topic}`,
      );
      expect(body).toContain(
        `## Acceptance criteria\n\nMeets: R2.1\n\n- [ ] ${requirements.requirements[1]?.criteria[0] ?? ""}\n\n## Blocked by\n\n- #${String(first.number)}\n`,
      );
      const firstBody = (await s.issue(first.number)).body;
      expect(firstBody).toContain(
        `Meets: R1.1, R1.2\n\n- [ ] ${requirements.requirements[0]?.criteria[0] ?? ""}\n- [ ] ${requirements.requirements[0]?.criteria[1] ?? ""}\n`,
      );
      expect(firstBody).toContain(
        "## Blocked by\n\nNone: it can start at once.",
      );

      // tasks.md links each task's issue, and holds no status.
      const tasksMd = await s.fileOn(branch, `${folder}/tasks.md`);
      expect(tasksMd).toBe(
        specTasksDocument(
          topic,
          slug,
          tasks.map((task, index) => ({
            ...task,
            dependsOn: index === 1 ? [1] : [],
          })),
          [first, second, third],
        ),
      );
      expect(tasksMd).toContain(
        `- **Issue:** [#${String(second.number)}](${second.url})`,
      );
      expect(tasksMd).not.toMatch(/status|\[x\]|closed|merged/i);

      // The Batch: the tasks' order and dependencies, approved already.
      const { batch, plan } = await s.openBatch();
      expect(batch).toMatchObject({
        status: "in_progress",
        onePullRequest: false,
        chatMessageId: null,
        issues: [first.number, second.number, third.number],
      });
      expect(plan).toMatchObject({
        version: 1,
        draftedBy: "rules",
        items: [
          { issue: first.number, dependsOn: [] },
          { issue: second.number, dependsOn: [first.number] },
          { issue: third.number, dependsOn: [] },
        ],
      });
      expect(
        s.published.filter(({ type }) => type === "batch.approved"),
      ).toEqual([
        expect.objectContaining({
          batchId: batch.id,
          planVersion: 1,
          specSessionId: 1,
        }),
      ]);
      // The filing shows on the bus as the Spec's, for a Hook to watch.
      expect(
        s.published.filter(({ type }) => type === "batch.planned"),
      ).toEqual([
        expect.objectContaining({
          batchId: batch.id,
          planVersion: 1,
          specSessionId: 1,
        }),
      ]);
      // Work started on the first and the third; the second waits.
      expect(
        s.published
          .filter(({ type }) => type === "batch.started")
          .map((event) => event.type === "batch.started" && event.issues),
      ).toEqual([[first.number, third.number]]);
      expect(filedText).toContain(
        `Filed the 3 issues of the Grilling Session 1 on ${topic} on GitHub`,
      );
      expect(filedText).toContain(`Updated on ${branch}: ${folder}/tasks.md.`);
      expect(filedText).toContain(
        `The Spec's tasks you confirmed stand as the Plan's approval, so work has started on #${String(first.number)} and #${String(third.number)}.`,
      );
      expect(filedText).not.toContain("ready to become a Batch");

      // Triage took each started issue as clear, asking no model.
      expect(askedOfIssues(s)).toEqual([]);
      expect(
        s.published.filter(({ type }) => type === "issue.triaged"),
      ).toEqual([
        expect.objectContaining({
          issue: first.number,
          outcome: "clear",
          judgedBy: "rules",
        }),
        expect.objectContaining({
          issue: third.number,
          outcome: "clear",
          judgedBy: "rules",
        }),
      ]);
      expect((await s.workStore.active()).map(({ issue }) => issue)).toEqual([
        first.number,
        third.number,
      ]);
      expect(await s.say(fileGrillingIssuesText(1))).toContain(
        "are filed already",
      );
    },
  ],
  [
    "drafts the Owner edited after confirming the tasks follow the Floor's plan approval: on, the Plan awaits it",
    async (s) => {
      const session = await s.agreeSpec();
      const drafts = session.issues?.drafts ?? [];
      // The Owner retitles the third draft.
      await s.chat.saveGrillingIssues(
        "web-shop",
        1,
        drafts.map((draft) =>
          draft.id === 3 ? { ...draft, title: "Ask for another card" } : draft,
        ),
      );
      const filedText = await s.say(fileGrillingIssuesText(1));
      const { batch, plan } = await s.openBatch();
      expect(batch.status).toBe("awaiting_approval");
      expect(plan?.items.map(({ dependsOn }) => dependsOn.length)).toEqual([
        0, 1, 0,
      ]);
      expect(s.published.map(({ type }) => type)).not.toContain(
        "batch.approved",
      );
      // Still a Spec's issues filed, approved or not.
      expect(
        s.published.filter(({ type }) => type === "batch.planned"),
      ).toEqual([expect.objectContaining({ specSessionId: 1 })]);
      expect(s.published.map(({ type }) => type)).not.toContain(
        "batch.started",
      );
      expect(filedText).toContain(
        "You edited the issue drafts after confirming the Spec's tasks, so the Plan follows the Floor's plan approval. Plan approval is on for this Floor",
      );
      expect(await s.workStore.active()).toEqual([]);
    },
  ],
  [
    "drafts the Owner edited after confirming the tasks follow the Floor's plan approval: off, the work starts with no approval recorded",
    async (s) => {
      await s.stores.floors.update("web-shop", { planApproval: false });
      const session = await s.agreeSpec();
      const drafts = session.issues?.drafts ?? [];
      // The Owner moves the third draft first.
      const third = drafts.find(({ id }) => id === 3);
      if (third === undefined) {
        throw new Error("No third draft.");
      }
      await s.chat.saveGrillingIssues("web-shop", 1, [
        third,
        ...drafts.filter(({ id }) => id !== 3),
      ]);
      const filedText = await s.say(fileGrillingIssuesText(1));
      const filed = await s.session();
      const numberOf = (id: number) =>
        filed.issues?.drafts.find((draft) => draft.id === id)?.filed?.number;
      const { batch, plan } = await s.openBatch();
      expect(batch.status).toBe("in_progress");
      // The Owner's order, each still after what it depends on.
      expect(plan?.items.map(({ issue }) => issue)).toEqual([
        numberOf(3),
        numberOf(1),
        numberOf(2),
      ]);
      expect(s.published.map(({ type }) => type)).not.toContain(
        "batch.approved",
      );
      expect(filedText).toContain(
        "You edited the issue drafts after confirming the Spec's tasks, so the Plan follows the Floor's plan approval, and plan approval is off for this Floor, so work has started",
      );
      expect(askedOfIssues(s)).toEqual([]);
    },
  ],
  [
    '"… in one PR" starts a One-pull-request Batch, its issues one at a time in the tasks\' order',
    async (s) => {
      await s.agreeSpec();
      const filedText = await s.say(fileGrillingIssuesText(1, true));
      const [first, second, third] = await s.filed();
      const { batch, plan } = await s.openBatch();
      expect(batch).toMatchObject({
        status: "in_progress",
        onePullRequest: true,
      });
      expect(plan?.items.map(({ issue }) => issue)).toEqual([
        first?.number,
        second?.number,
        third?.number,
      ]);
      expect((await s.workStore.active()).map(({ issue }) => issue)).toEqual([
        first?.number,
      ]);
      expect(filedText).toContain(
        `#${String(second?.number)} starts once #${String(first?.number)} is ready to merge.`,
      );
      expect(
        s.published.filter(({ type }) => type === "batch.approved"),
      ).toEqual([expect.objectContaining({ specSessionId: 1 })]);
    },
  ],
  [
    "/spec amend reopens an approved Spec at its requirements with the documents approved last loaded, and its pull request updates the Spec's files",
    async (s) => {
      // Session 1 agrees the Spec, design and all, and files its issues;
      // its pull request merges.
      s.model.turn({ message: "The requirements.", spec: { requirements } });
      await s.say(`/${specSkillName} ${topic}`);
      s.model.turn({ message: "The design.", spec: { design } });
      await s.say(confirmSpecPhaseText("requirements"));
      s.model.turn({ message: "The tasks.", spec: { tasks } });
      await s.say(confirmSpecPhaseText("design"));
      await s.say(confirmSpecPhaseText("tasks"));
      await s.say(fileGrillingIssuesText(1));
      const [first, second, third] = await s.filed();
      if (first == null || second == null || third == null) {
        throw new Error("Not every task was filed.");
      }
      await gitIn(
        s.remote,
        "update-ref",
        "refs/heads/main",
        `refs/heads/${branch}`,
      );
      const approved = (await s.session()).spec?.approved;
      const mainDesign = await s.fileOn("main", `${folder}/design.md`);

      // 1. "/spec amend <slug>" starts session 2 on the same folder, back
      //    at the requirements, each document approved in session 1
      //    loaded as its draft, nothing approved yet.
      s.model.turn({
        message: "The Spec as you approved it is loaded. What has changed?",
      });
      await s.say(amendSpecText(slug));
      const amending = (await s.chat.grillingSession("web-shop", 2)).session;
      expect(amending).toMatchObject({
        skill: specSkillName,
        topic,
        status: "active",
      });
      expect(amending.spec).toEqual({
        slug,
        phase: "requirements",
        drafts: {
          requirements: approved?.requirements,
          design: approved?.design,
          tasks: approved?.tasks,
        },
        approved: { requirements: null, design: null, tasks: null },
        designSkipped: false,
        confirmedAt: { requirements: null, design: null, tasks: null },
        amends: {
          sessionId: 1,
          tasks: [first, second, third].map((issue, index) => ({
            title: tasks[index]?.title,
            description: tasks[index]?.description,
            meets: tasks[index]?.meets,
            issue: { number: issue.number, url: issue.url },
          })),
        },
      });
      // The Manager is told it amends session 1's Spec, its draft the
      // requirements approved then.
      const prompt = JSON.stringify(s.model.asked.at(-1));
      expect(prompt).toContain(
        "This session amends the Spec the Owner approved in Grilling Session 1",
      );
      expect(prompt).toContain("#### Your draft of the requirements");
      expect(prompt).toContain(requirements.requirements[0]?.criteria[0] ?? "");

      // 2. The Owner changes the requirements; the design holds; the
      //    tasks keep #1 and #2 as they were, change the third and add a
      //    fourth.
      const amended = {
        ...requirements,
        requirements: [
          {
            ...requirements.requirements[0],
            criteria: [
              ...(requirements.requirements[0]?.criteria ?? []),
              "R1.3 WHEN a shopper names a saved card THE SYSTEM SHALL show its name.",
            ],
          },
          requirements.requirements[1],
        ],
      };
      s.model.turn({ message: "Updated.", spec: { requirements: amended } });
      await s.say("Shoppers can name their saved cards too.");
      s.model.turn({ message: "The design still holds." });
      await s.say(confirmSpecPhaseText("requirements"));
      const amendedTasks = [
        tasks[0],
        tasks[1],
        {
          ...tasks[2],
          description: "A declined saved card asks for another, naming it.",
        },
        {
          title: "Name a saved card",
          description: "A name field beside each saved card.",
          meets: ["R1.3"],
          dependsOn: [1],
        },
      ];
      s.model.turn({ message: "The tasks.", spec: { tasks: amendedTasks } });
      await s.say(confirmSpecPhaseText("design"));
      const ended = await s.say(confirmSpecPhaseText("tasks"));
      expect(ended).not.toMatch(/could not/i);

      // 3. Its pull request updates the Spec's files on main.
      const pulls = await s.fake
        .repository(repository)
        .listPullRequests({ state: "all" });
      const pull = pulls.find(
        ({ head }) => head.name === "ai-office/grilling-2",
      );
      expect(pull?.title).toBe(
        `docs: amend the Spec in ${folder}/, in Grilling Session 2 on ${topic}`,
      );
      expect(pull?.body).toContain(
        `It amends the Spec in \`${folder}/\` that the Owner approved in Grilling Session 1`,
      );
      const amendedBranch = "ai-office/grilling-2";
      expect(
        await s.fileOn(amendedBranch, `${folder}/requirements.md`),
      ).toContain("R1.3 WHEN a shopper names a saved card");
      expect(await s.fileOn(amendedBranch, `${folder}/design.md`)).toBe(
        mainDesign,
      );
      // tasks.md keeps the issues of the tasks left as they were.
      const tasksMd = await s.fileOn(amendedBranch, `${folder}/tasks.md`);
      expect(tasksMd).toContain(
        `## 1. ${tasks[0]?.title ?? ""}\n\n${tasks[0]?.description ?? ""}\n\n- **Meets:** R1.1, R1.2\n- **Depends on:** none\n- **Issue:** [#${String(first.number)}](${first.url})`,
      );
      expect(tasksMd).toContain(
        `- **Issue:** [#${String(second.number)}](${second.url})`,
      );
      expect(tasksMd).not.toContain(`[#${String(third.number)}]`);

      // 4. Only the changed and the new task become issue drafts.
      const drafts = (await s.chat.grillingSession("web-shop", 2)).session
        .issues?.drafts;
      expect(
        drafts?.map(({ id, title, blockedBy }) => ({ id, title, blockedBy })),
      ).toEqual([
        { id: 3, title: tasks[2]?.title, blockedBy: [] },
        { id: 4, title: "Name a saved card", blockedBy: [] },
      ]);
      expect(drafts?.[1]?.whatToBuild).toContain(
        `It builds on task 1 (#${String(first.number)}), filed before the Spec was amended.`,
      );
      expect(drafts?.[1]?.acceptanceCriteria).toEqual([
        "R1.3 WHEN a shopper names a saved card THE SYSTEM SHALL show its name.",
      ]);
    },
  ],
  [
    "a reopened phase of an amendment goes back to the Spec's file on the default branch, never deleted",
    async (s) => {
      await s.agreeSpec();
      await gitIn(
        s.remote,
        "update-ref",
        "refs/heads/main",
        `refs/heads/${branch}`,
      );
      const before = await s.fileOn("main", `${folder}/requirements.md`);
      s.model.turn({ message: "What has changed?" });
      await s.say(amendSpecText(slug));
      const amended = {
        ...requirements,
        introduction: "Shoppers keep and name their cards to pay faster.",
      };
      s.model.turn({ message: "Updated.", spec: { requirements: amended } });
      await s.say("Shoppers name their cards too.");
      s.model.turn({ message: "The design.", spec: { design } });
      await s.say(confirmSpecPhaseText("requirements"));
      const amendedBranch = "ai-office/grilling-2";
      expect(
        await s.fileOn(amendedBranch, `${folder}/requirements.md`),
      ).toContain("keep and name their cards");
      s.model.turn({ message: "The requirements again." });
      await s.say(reopenSpecPhaseText("requirements"));
      expect(await s.fileOn(amendedBranch, `${folder}/requirements.md`)).toBe(
        before,
      );
    },
  ],
  [
    "/spec amend of a Spec the Floor does not have is refused, naming those it can amend, and starts nothing",
    async (s) => {
      expect(await s.say(amendSpecText("saved-cards"))).toBe(
        `There is no Spec in \`.agents/specs/saved-cards/\` with documents you approved on this Floor, so there is nothing to amend. Start a Spec with "/${specSkillName} <what it is for>".`,
      );
      await s.agreeSpec();
      expect(await s.say(amendSpecText("saved-cards"))).toBe(
        `There is no Spec in \`.agents/specs/saved-cards/\` with documents you approved on this Floor, so there is nothing to amend. Specs you can amend: "${amendSpecText(slug)}".`,
      );
      expect(await s.chat.grillingSessions("web-shop")).toHaveLength(1);
    },
  ],
];

const roots: string[] = [];
const scratch = async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-office-spec-batch-"));
  roots.push(root);
  return root;
};
const running: Setup[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.stop()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("a Spec's issues and their Batch, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const stores = memoryStores();
      const s = await setUp(
        stores,
        memoryWorkQueueStore(stores.floors),
        await scratch(),
      );
      running.push(s);
      await run(s);
    });
  }
});

describe("a Spec's issues and their Batch, in Postgres", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const s = await setUp(
        databaseStores(database.db),
        databaseWorkQueueStore(database.db),
        await scratch(),
      );
      running.push(s);
      await run(s);
    });
  }
});
