import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  confirmSpecPhaseText,
  createRedactor,
  reopenSpecPhaseText,
  skipSpecDesignText,
  specDesignDocument,
  specRequirementsDocument,
  specSkillName,
  specTasksDocument,
} from "@ai-office/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { floorChatSkills } from "../manager/chat-skills.ts";
import { createManagerChat, type ManagerChatUpdate } from "../manager/chat.ts";
import type {
  ModelClient,
  ModelReply,
  ModelRequest,
  ModelStreamOptions,
} from "../models/client.ts";
import { createNotices } from "../notices/notices.ts";
import { createOfficeSettings } from "../office/settings.ts";
import { gitBackedGitHub, gitIn } from "../sandbox/git-backed-github.ts";
import { withBuiltInSkills } from "../skills/floor.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createGrillingDocuments } from "./documents.ts";
import { createGrillingIssues } from "./issues.ts";

// `/spec` (Guidelines, Specs and Hooks PRD, FR-113; ADR 0015), end to end
// through the Manager chat. The Manager's Model, which the test scripts,
// drafts each phase's document; the Owner moves the Spec on in their own
// words: "confirm requirements", "confirm design" (or "skip design") and
// "confirm tasks", and may "reopen" an earlier phase. Each confirmation
// commits its document, as plain code writes it from the approved copy, in
// `.agents/specs/<slug>/` on `ai-office/grilling-1` of a local bare
// repository standing in for GitHub's remote; the tasks become the
// session's issue drafts with no model asked, and one pull request holds
// the Spec. Each case runs in memory and in Postgres 18.

const exec = promisify(execFile);
const repository = "adrianeyre/web-shop";
const branch = "ai-office/grilling-1";
const topic = "checkout with saved cards";
const folder = ".agents/specs/checkout-with-saved-cards";
const anthropicKey = "sk-ant-api03-speckey000000000-Qw3Er4Ty5Ui6Op7As8Df9";

type Answer = (
  request: ModelRequest,
  options: ModelStreamOptions,
) => Promise<ModelReply>;

/** A model whose answers the test writes. */
function scriptedModel() {
  const requests: ModelRequest[] = [];
  const answers: Answer[] = [];
  const client: ModelClient = {
    complete: () => Promise.reject(new Error("The chat streams its calls.")),
    stream(request, options) {
      requests.push(request);
      const answer = answers.shift();
      return answer === undefined
        ? Promise.reject(new Error("No answer was scripted."))
        : answer(request, options);
    },
  };
  return {
    client,
    requests,
    turn(value: unknown): void {
      const text = `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
      answers.push((_request, { onText }) => {
        onText(text);
        return Promise.resolve({ text, stopReason: "end_turn" });
      });
    },
    /** The system prompt of the latest call. */
    system: () => requests.at(-1)?.system ?? "",
  };
}

/** A local bare repository standing in for GitHub's remote, with one Spec already. */
async function seedRepository(root: string): Promise<string> {
  const remote = join(root, "web-shop.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await exec("git", ["init", "--quiet", "-b", "main", seed]);
  await writeFile(join(seed, "README.md"), "# Web shop\n\nWe sell tea.\n");
  await writeFile(join(seed, "GLOSSARY.md"), "# Web shop\n");
  await mkdir(join(seed, ".agents/specs/saved-cards"), { recursive: true });
  await writeFile(
    join(seed, ".agents/specs/saved-cards/requirements.md"),
    "# Requirements: saved cards\n",
  );
  await gitIn(seed, "add", "-A");
  await gitIn(seed, "commit", "--quiet", "-m", "chore: start");
  await gitIn(seed, "push", "--quiet", remote, "main");
  return remote;
}

async function setUp(stores: OfficeStores, root: string) {
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
  const floors = createFloors({ store: stores.floors, github, events });
  await floors.add(repository);
  const office = createOfficeSettings({
    store: stores.office,
    floors: stores.floors,
    events,
  });
  const notices = createNotices({ store: stores.notices, events, now });
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
    redactor: createRedactor(),
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

  /**
   * Sends `text`, and every answer kept for it once the Manager is done:
   * one, or, as a Spec moves on, what was committed and the next turn.
   */
  const say = async (text: string) => {
    const sent = await chat.send("web-shop", text);
    if (sent.reply !== undefined) {
      return { message: sent.message, replies: [sent.reply] };
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
    const replies = (await chat.history("web-shop")).messages.filter(
      ({ replyTo }) => replyTo === sent.message.id,
    );
    return { message: sent.message, replies };
  };
  /** The text of every answer to `text`, one after the other. */
  const answered = async (text: string) =>
    (await say(text)).replies.map(({ text: reply }) => reply).join("\n---\n");
  return {
    remote,
    fake,
    chat,
    model,
    published,
    say,
    answered,
    /** The files on a branch of the remote. */
    filesOn: async (ref: string) =>
      (await gitIn(remote, "ls-tree", "-r", "--name-only", ref)).split("\n"),
    /** A file on a branch of the remote, with the newline `git show` drops. */
    fileOn: async (ref: string, path: string) =>
      `${await gitIn(remote, "show", `${ref}:${path}`)}\n`,
    pullRequests: () =>
      fake.repository(repository).listPullRequests({ state: "all" }),
    session: async () => (await chat.grillingSession("web-shop", 1)).session,
  };
}

const seedFiles = [
  ".agents/specs/saved-cards/requirements.md",
  "GLOSSARY.md",
  "README.md",
];

/** The requirements the Owner confirms. */
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

/** The design the Owner confirms; its data names a credential, redacted. */
const design = {
  overview: "A card vault behind the checkout.",
  architecture: "The checkout asks the vault for a shopper's saved cards.",
  data: `A saved_cards table: token, last four digits. Never ${anthropicKey}.`,
  errorHandling: "A declined card is never saved.",
  testing: "One test per Acceptance Criterion.",
};

/** The tasks the Owner confirms. */
const tasks = [
  {
    title: "Save a card at checkout",
    description: "The vault, the table and the Save card tick box.",
    meets: ["R1.1", "R1.2"],
  },
  {
    title: "Offer saved cards first",
    description: "The checkout lists saved cards before the card form.",
    meets: ["R2.1", "R2.2", "R9.9"],
    dependsOn: [1, 2],
  },
];

/** Round 1 of the requirements: a draft and a question, with parts it drops. */
const requirementsFirst = {
  message: "A first draft of the requirements.",
  questions: [
    {
      text: "May a shopper save more than one card?",
      recommended: "Yes, up to five.",
    },
  ],
  // A /spec session writes none of these, nor a later phase's document.
  terms: [{ term: "Vault", definition: "Where cards are kept." }],
  outline: [{ heading: "Problem", text: "No saved cards." }],
  spec: {
    requirements: {
      requirements: [requirements.requirements[0]],
    },
    design,
  },
};

/** Round 2: the whole requirements, and nothing left to ask. */
const requirementsDone = {
  message: "The requirements are complete.",
  decisions: [{ text: "A shopper saves up to five cards.", questions: [1] }],
  spec: { requirements },
};

const designDone = {
  message: "The design.",
  // The approved requirements cannot be changed from the design.
  spec: {
    design,
    requirements: { requirements: [requirements.requirements[1]] },
  },
};

const tasksDone = { message: "The tasks.", spec: { tasks } };

/** The tasks as AI Office keeps them: each depending only on earlier ones. */
const keptTasks = [
  { ...tasks[0], dependsOn: [] },
  { ...tasks[1], dependsOn: [1] },
] as const;

type Case = [
  name: string,
  run: (stores: OfficeStores, root: string) => Promise<void>,
];

const cases: Case[] = [
  [
    "each phase is drafted, confirmed by the Owner and committed in .agents/specs/<slug>/, and the tasks become the issue drafts in one pull request",
    async (stores, root) => {
      const s = await setUp(stores, root);
      const mainBefore = await gitIn(s.remote, "rev-parse", "main");

      // The requirements: drafted, asked about, and nothing written yet.
      s.model.turn(requirementsFirst);
      const first = await s.say(`/${specSkillName} ${topic}`);
      expect(first.message.skill).toMatchObject({
        name: specSkillName,
        source: "built-in",
      });
      expect(first.replies.map(({ text }) => text)).toEqual([
        expect.stringMatching(
          /^A first draft of the requirements\.\n\nRound 1: 1 question\.\n/,
        ),
      ]);
      expect(await s.session()).toMatchObject({
        skill: specSkillName,
        terms: [],
        outline: [],
        spec: {
          slug: "checkout-with-saved-cards",
          phase: "requirements",
          drafts: {
            requirements: {
              introduction: "",
              requirements: [requirements.requirements[0]],
            },
            design: null,
            tasks: null,
          },
          approved: { requirements: null, design: null, tasks: null },
        },
      });
      const system = s.model.system();
      expect(system).toContain("### /spec (");
      expect(system).toContain("### The Spec");
      expect(system).toContain(
        "This session writes a Spec in `.agents/specs/checkout-with-saved-cards/`",
      );
      expect(system).toContain("The Spec is on the requirements.");
      expect(system).not.toContain("### The documents");
      await expect(gitIn(s.remote, "rev-parse", branch)).rejects.toThrow();

      // Not yet: a question is open.
      const calls = s.model.requests.length;
      expect(await s.answered(confirmSpecPhaseText("requirements"))).toBe(
        "The requirements still have questions to settle: answer the open ones first.",
      );
      expect(s.model.requests).toHaveLength(calls);

      // Round 2 completes the draft; the Owner is asked to confirm it.
      s.model.turn(requirementsDone);
      const done = await s.answered("1: recommended");
      expect(done).toContain(
        'The requirements are drafted, and no open questions remain. Reply "confirm requirements" to move on to the design, or say what to change.',
      );
      expect(s.model.system()).toContain(
        "#### Your draft of the requirements\n\n# Requirements: checkout with saved cards\n\n## Requirement 1: Save a card",
      );

      // "confirm requirements": committed at once, then the design drafted.
      s.model.turn(designDone);
      const confirmed = await s.say(confirmSpecPhaseText("requirements"));
      expect(confirmed.replies.map(({ text }) => text)).toEqual([
        `Confirmed the requirements. Now the design: reply "${skipSpecDesignText}" to go straight to the tasks.\n\nUpdated on ${branch}: ${folder}/requirements.md.`,
        expect.stringContaining(
          'The design is drafted, and no open questions remain. Reply "confirm design", or "skip design" to move on to the tasks, or say what to change.',
        ),
      ]);
      const requirementsMd = specRequirementsDocument(
        topic,
        "checkout-with-saved-cards",
        requirements,
      );
      expect(await s.fileOn(branch, `${folder}/requirements.md`)).toBe(
        requirementsMd,
      );
      expect(await s.filesOn(branch)).toEqual([
        `${folder}/requirements.md`,
        ...seedFiles,
      ]);
      // The design was drafted from the approved requirements, word for word.
      const designPrompt = s.model.system();
      expect(designPrompt).toContain(
        `#### ${folder}/requirements.md, as the Owner approved it\n\n${requirementsMd.trimEnd()}`,
      );
      expect(designPrompt).toContain(
        "The Owner confirmed the requirements. Now draft the design from the approved documents above",
      );
      // The design's turn could not change the approved requirements.
      expect((await s.session()).spec).toMatchObject({
        phase: "design",
        approved: { requirements, design: null, tasks: null },
        drafts: { requirements },
        confirmedAt: {
          requirements: expect.any(String) as string,
          design: null,
        },
      });

      // "confirm design": design.md committed, without the credential.
      s.model.turn(tasksDone);
      const designed = await s.say(confirmSpecPhaseText("design"));
      expect(designed.replies[0]?.text).toBe(
        `Confirmed the design. Now the tasks.\n\nUpdated on ${branch}: ${folder}/design.md.`,
      );
      expect(designed.replies[1]?.text).toContain(
        'The tasks are drafted, and no open questions remain. Reply "confirm tasks": they become the session\'s issue drafts, and the pull request with the Spec is opened, or say what to change.',
      );
      const designMd = await s.fileOn(branch, `${folder}/design.md`);
      expect(designMd).not.toContain(anthropicKey);
      expect(designMd).toBe(
        specDesignDocument(topic, "checkout-with-saved-cards", {
          ...design,
          data: (await s.session()).spec?.approved.design?.data ?? "",
        }),
      );
      expect(designMd).toContain("## Error handling\n\nA declined card");

      // "confirm tasks": tasks.md committed, one pull request with the
      // Spec, and the tasks kept as the issue drafts, with no model asked.
      const asked = s.model.requests.length;
      const ended = await s.say(confirmSpecPhaseText("tasks"));
      expect(s.model.requests).toHaveLength(asked);
      expect(ended.replies[0]?.text).toContain("Opened pull request #");
      expect(ended.replies[1]?.text).toContain(
        "Each confirmed task of the Spec is one issue draft, in the tasks' order",
      );
      expect(ended.replies[1]?.text).toContain(
        "1. Save a card at checkout\n2. Offer saved cards first (blocked by 1)",
      );
      const tasksMd = specTasksDocument(topic, "checkout-with-saved-cards", [
        {
          title: "Save a card at checkout",
          description: "The vault, the table and the Save card tick box.",
          meets: ["R1.1", "R1.2"],
          dependsOn: [],
        },
        {
          title: "Offer saved cards first",
          description: "The checkout lists saved cards before the card form.",
          meets: ["R2.1", "R2.2", "R9.9"],
          dependsOn: [1],
        },
      ]);
      expect(await s.fileOn(branch, `${folder}/tasks.md`)).toBe(tasksMd);
      expect(await s.filesOn(branch)).toEqual([
        ".agents/specs/checkout-with-saved-cards/design.md",
        ".agents/specs/checkout-with-saved-cards/requirements.md",
        ".agents/specs/checkout-with-saved-cards/tasks.md",
        ...seedFiles,
      ]);
      expect(await gitIn(s.remote, "rev-parse", "main")).toBe(mainBefore);
      const [pull, ...others] = await s.pullRequests();
      expect(others).toEqual([]);
      expect(pull).toMatchObject({
        title: `docs: the Spec of Grilling Session 1 on ${topic}`,
        state: "open",
        head: { name: branch },
        base: "main",
      });
      expect(pull?.body).toContain(
        `- \`${folder}/design.md\`: confirmed by the Owner in the session.`,
      );
      expect(pull?.body).toContain(`- \`${folder}/tasks.md\``);
      const session = await s.session();
      expect(session.status).toBe("ended");
      expect(session.spec?.approved.tasks).toEqual(keptTasks);
      expect(session.issues?.drafts).toEqual([
        {
          id: 1,
          title: "Save a card at checkout",
          whatToBuild: `The vault, the table and the Save card tick box.\n\nTask 1 of the Spec in \`${folder}/\`, built as its design.md says.`,
          acceptanceCriteria: requirements.requirements[0]?.criteria,
          blockedBy: [],
          prdSections: [],
          adrs: [],
          filed: null,
        },
        expect.objectContaining({
          id: 2,
          title: "Offer saved cards first",
          // A criterion the requirements lack is named by its id.
          acceptanceCriteria: [
            ...(requirements.requirements[1]?.criteria ?? []),
            "R9.9",
          ],
          blockedBy: [1],
        }),
      ]);
      expect(s.published.map(({ type }) => type)).toContain(
        "grilling.pull_request_opened",
      );
      expect(JSON.stringify(s.published)).not.toContain(anthropicKey);
    },
  ],
  [
    '"skip design" goes from the requirements to the tasks, and the Spec has no design.md',
    async (stores, root) => {
      const s = await setUp(stores, root);
      s.model.turn({ ...requirementsDone, decisions: [] });
      await s.say(`/${specSkillName} ${topic}`);
      s.model.turn(designDone);
      await s.say(confirmSpecPhaseText("requirements"));

      s.model.turn(tasksDone);
      const skipped = await s.say(skipSpecDesignText);
      expect(skipped.replies[0]?.text).toBe(
        "Skipped the design: this Spec has no design.md. Now the tasks.",
      );
      expect(s.model.system()).toContain(
        'The Owner confirmed the requirements and said "skip design": there is no design.',
      );
      expect(s.model.system()).toContain(
        "The Owner skipped the design: there is no design.md.",
      );
      expect((await s.session()).spec).toMatchObject({
        phase: "tasks",
        designSkipped: true,
        approved: { design: null },
        confirmedAt: { design: expect.any(String) as string },
      });
      expect(await s.answered(skipSpecDesignText)).toBe(
        "The design is skipped already.",
      );

      await s.say("confirm");
      expect(await s.filesOn(branch)).toEqual([
        ".agents/specs/checkout-with-saved-cards/requirements.md",
        ".agents/specs/checkout-with-saved-cards/tasks.md",
        ...seedFiles,
      ]);
      const [pull] = await s.pullRequests();
      expect(pull?.body).toContain(
        `- \`${folder}/design.md\`: skipped by the Owner.`,
      );
      const session = await s.session();
      expect(session.status).toBe("ended");
      expect(session.issues?.drafts[0]?.whatToBuild).toBe(
        `The vault, the table and the Save card tick box.\n\nTask 1 of the Spec in \`${folder}/\`.`,
      );
    },
  ],
  [
    "reopening an earlier phase takes it and the later documents off the branch, and drafts the later phases again",
    async (stores, root) => {
      const s = await setUp(stores, root);
      s.model.turn({ ...requirementsDone, decisions: [] });
      await s.say(`/${specSkillName} ${topic}`);
      s.model.turn(designDone);
      await s.say(confirmSpecPhaseText("requirements"));
      s.model.turn(tasksDone);
      await s.say(confirmSpecPhaseText("design"));
      expect((await s.session()).spec?.phase).toBe("tasks");

      // Back to the requirements: both documents leave the branch, the
      // design and the tasks are dropped, and the requirements redrafted.
      const revised = {
        ...requirements,
        requirements: requirements.requirements.slice(0, 1),
      };
      s.model.turn({
        message: "Only saving, then.",
        spec: { requirements: { requirements: revised.requirements } },
      });
      const reopened = await s.say(reopenSpecPhaseText("requirements"));
      expect(reopened.replies[0]?.text).toBe(
        `Reopened the requirements. The design and the tasks are drafted again once they are confirmed, and what was approved from the requirements on leaves the session's branch until then.\n\nUpdated on ${branch}: ${folder}/design.md and ${folder}/requirements.md.`,
      );
      expect(reopened.replies[1]?.text).toContain(
        'Reply "confirm requirements"',
      );
      expect(await s.filesOn(branch)).toEqual(seedFiles);
      expect((await s.session()).spec).toEqual({
        slug: "checkout-with-saved-cards",
        phase: "requirements",
        drafts: {
          requirements: {
            introduction: "",
            requirements: revised.requirements,
          },
          design: null,
          tasks: null,
        },
        approved: { requirements: null, design: null, tasks: null },
        designSkipped: false,
        confirmedAt: { requirements: null, design: null, tasks: null },
      });

      // Confirmed again: the new requirements are committed, and the
      // design is drafted afresh from them.
      s.model.turn(designDone);
      await s.say(confirmSpecPhaseText("requirements"));
      expect(await s.fileOn(branch, `${folder}/requirements.md`)).toBe(
        specRequirementsDocument(topic, "checkout-with-saved-cards", {
          introduction: "",
          requirements: revised.requirements,
        }),
      );
      expect(s.model.system()).toContain("Now draft the design");
      expect(s.model.system()).not.toContain("Pay with a saved card");
      s.model.turn(tasksDone);
      await s.say(confirmSpecPhaseText("design"));

      // Back to the design: only design.md leaves, and the tasks are dropped.
      s.model.turn({ message: "The design again.", spec: { design } });
      const back = await s.say("go back to the design");
      expect(back.replies[0]?.text).toContain(
        `Reopened the design. The tasks are drafted again once it is confirmed`,
      );
      expect(await s.filesOn(branch)).toEqual([
        ".agents/specs/checkout-with-saved-cards/requirements.md",
        ...seedFiles,
      ]);
      expect((await s.session()).spec).toMatchObject({
        phase: "design",
        drafts: { tasks: null },
        approved: { design: null, tasks: null },
      });
    },
  ],
  [
    "a phase cannot be confirmed, skipped or reopened out of turn, and a Spec named like the Floor's own gets the session's number",
    async (stores, root) => {
      const s = await setUp(stores, root);
      s.model.turn(requirementsFirst);
      await s.say(`/${specSkillName} Saved cards`);
      expect((await s.session()).spec?.slug).toBe("saved-cards-1");
      const calls = s.model.requests.length;
      expect(await s.answered(confirmSpecPhaseText("design"))).toBe(
        "The Spec is on the requirements: the design come after the requirements are confirmed.",
      );
      expect(await s.answered(skipSpecDesignText)).toBe(
        'The Spec is on the requirements: say "confirm requirements" first, then "skip design".',
      );
      expect(await s.answered("confirm")).toBe(
        'The Spec is on the requirements: reply "confirm requirements" once they are drafted and no open questions remain.',
      );
      expect(await s.answered(reopenSpecPhaseText("tasks"))).toBe(
        "The Spec is on the requirements: the tasks have not been drafted yet.",
      );
      expect(await s.answered(reopenSpecPhaseText("requirements"))).toBe(
        "The Spec is on the requirements already.",
      );
      expect(s.model.requests).toHaveLength(calls);
      // Ended with nothing confirmed: no pull request, and no drafts.
      const ended = await s.answered("end the session");
      expect(ended).toContain("Ended the Grilling Session 1 on Saved cards");
      expect(await s.pullRequests()).toEqual([]);
      expect((await s.session()).issues).toBeNull();
    },
  ],
];

const roots: string[] = [];
const scratch = async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-office-spec-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("/spec, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(memoryStores(), await scratch());
    });
  }
});

describe("/spec, in Postgres", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(databaseStores(database.db), await scratch());
    });
  }
});
