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
import type { GitHubApp } from "@ai-office/github";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  createRedactor,
  defaultIntakeSettings,
  dropIssueDraft,
  fileGrillingIssuesText,
  mergeIssueDrafts,
  moveIssueDraft,
  type GrillingIssueDraftEdit,
} from "@ai-office/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { fromOwner } from "../intake/intake.ts";
import {
  createManagerChat,
  GrillingError,
  type ManagerChatUpdate,
} from "../manager/chat.ts";
import type {
  ModelClient,
  ModelReply,
  ModelRequest,
  ModelStreamOptions,
} from "../models/client.ts";
import { createNotices } from "../notices/notices.ts";
import { createOfficeSettings } from "../office/settings.ts";
import { gitBackedGitHub, gitIn } from "../sandbox/git-backed-github.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createGrillingDocuments } from "./documents.ts";
import { approvedIssues, createGrillingIssues } from "./issues.ts";

// A Grilling Session's issues (PRD §5 scenario 8, FR-81), end to end
// through the Manager chat. The session settles its PRD's outline and an
// ADR in one turn, and the Owner confirms: the GitHub App opens the
// documents' pull request, then the Manager's Model, which the test
// scripts, drafts five issues. The Owner edits them: a title and a
// criterion changed, one merged into another, one dropped, one moved to
// the top, and a blocker added. Approving them ("file the issues of
// session 1") has the App file them in dependency order, labelled
// `ai-office`, each one's "Blocked by" naming the issues filed for the
// drafts it waits on. Nothing starts on its own: intake leaves the App's
// issues alone, and a Batch takes them as the Owner's. The second case
// covers the Model's draft failing and GitHub failing partway through
// filing. Each case runs in memory and in Postgres 18.

const exec = promisify(execFile);
const repository = "adrianeyre/web-shop";
const prd = "docs/product-requirements-document/csv-export-for-orders.md";
const adr =
  "docs/architectural-decision-record/0002-exports-are-built-while-the-owner-waits.md";
const anthropicKey = "sk-ant-api03-draftedissuekey-Qw3Er4Ty5Ui6Op7As8Df9";

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
  const say = (text: string) => {
    answers.push((_request, { onText }) => {
      onText(text);
      return Promise.resolve({ text, stopReason: "end_turn" });
    });
  };
  return {
    client,
    requests,
    say,
    json(value: unknown): void {
      say(`\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``);
    },
  };
}

/** A local bare repository standing in for GitHub's remote, with an ADR. */
async function seedRepository(root: string): Promise<string> {
  const remote = join(root, "web-shop.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await exec("git", ["init", "--quiet", "-b", "main", seed]);
  await writeFile(join(seed, "README.md"), "# Web shop\n");
  await mkdir(join(seed, "docs/architectural-decision-record"), {
    recursive: true,
  });
  await writeFile(
    join(
      seed,
      "docs/architectural-decision-record/0001-orders-live-in-postgres.md",
    ),
    "# Orders live in Postgres\n\nThey always have.\n",
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
  const backed = gitBackedGitHub(fake, remote);
  /** How many more issues GitHub files before it fails, if it is to. */
  const failures = { afterIssues: Number.POSITIVE_INFINITY };
  const github: GitHubApp = {
    ...backed,
    repository(fullName) {
      const client = backed.repository(fullName);
      return {
        ...client,
        createIssue: (input) =>
          failures.afterIssues-- <= 0
            ? Promise.reject(new Error("GitHub is unavailable."))
            : client.createIssue(input),
      };
    },
  };
  const events = createEventBus({ store: memoryEventStore() });
  const published: OfficeEvent[] = [];
  events.subscribe(({ event }) => {
    published.push(event);
  });
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 10, 12, 0, tick++));
  await createFloors({ store: stores.floors, github, events }).add(repository);
  const floor = await stores.floors.get("web-shop");
  const manager = (await stores.agents.list("web-shop")).find(
    ({ role }) => role === "manager",
  );
  if (floor === undefined || manager === undefined) {
    throw new Error("A new Floor has a Manager.");
  }
  const office = createOfficeSettings({
    store: stores.office,
    floors: stores.floors,
    events,
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
      notices: createNotices({ store: stores.notices, events, now }),
      gitIdentity: (floorId) => office.floorGitIdentity(floorId),
      scratchDir: root,
      pushUrl: () => remote,
      now,
    }),
    issues: createGrillingIssues({ github, events, now }),
    redactor: createRedactor(),
    now,
  });
  const updates: ManagerChatUpdate[] = [];
  chat.subscribe("web-shop", (update) => updates.push(update));

  /** Sends `text`, and the `count` answers kept: at once, or once written. */
  const say = async (text: string, count = 1) => {
    const sent = await chat.send("web-shop", text);
    if (sent.reply !== undefined) {
      return { message: sent.message, replies: [sent.reply] };
    }
    const answers = () =>
      updates.flatMap((update) =>
        update.type === "message" && update.message.replyTo === sent.message.id
          ? [update.message]
          : [],
      );
    await vi.waitFor(
      async () => {
        expect(answers()).toHaveLength(count);
        // …and the Floor is free for the next message.
        expect((await chat.history("web-shop")).pending).toEqual([]);
      },
      { timeout: 10_000 },
    );
    return { message: sent.message, replies: answers() };
  };
  return {
    fake,
    chat,
    model,
    manager,
    floor,
    failures,
    published,
    say,
    session: async () => (await chat.grillingSession("web-shop", 1)).session,
    /** The issues on GitHub, not the pull requests, oldest first. */
    issues: async () =>
      (await fake.repository(repository).listIssues({ state: "all" })).sort(
        (a, b) => a.number - b.number,
      ),
  };
}

/** One turn: the PRD's outline and an ADR, and nothing left to ask. */
const onlyTurn = {
  message: "That settles it.",
  decisions: [{ text: "An export holds orders only.", questions: [] }],
  outline: [
    { heading: "Problem", text: "Staff copy orders by hand." },
    { heading: "Requirements", text: "The Owner downloads a CSV of orders." },
  ],
  adrs: [
    {
      title: "Exports are built while the Owner waits",
      decision: "An export is built in the request that asks for it.",
      hardToReverse: "Moving to a job needs a queue.",
      surprising: "Most exports run in the background.",
      tradeOff: "Freshness over speed.",
    },
  ],
  questions: [],
};

/** The Manager's draft: five issues, some citing what the session has not. */
const drafted = {
  message: "Five slices, the button first.",
  issues: [
    {
      title: "Export button",
      whatToBuild: "A button on Orders that downloads an empty CSV.",
      acceptanceCriteria: ["The button downloads a file"],
      prdSections: ["requirements"],
    },
    {
      title: "Build the CSV",
      whatToBuild: `Fill the CSV with the shop's orders. Never ${anthropicKey}.`,
      acceptanceCriteria: ["Every order is a row"],
      blockedBy: [1],
      prdSections: ["Requirements", "Pricing"],
      adrs: ["Exports are built while the Owner waits", "Use Kafka"],
    },
    {
      title: "Name the columns",
      whatToBuild: "Give each column an English heading.",
      acceptanceCriteria: [
        "Every column has a heading",
        "Every order is a row",
      ],
      blockedBy: [2],
    },
    {
      title: "Email the export",
      whatToBuild: "Email the CSV to the Owner.",
      acceptanceCriteria: ["The Owner gets an email with the CSV"],
      // Itself and a later issue are no blockers.
      blockedBy: [2, 4, 5],
    },
    {
      title: "Schedule exports",
      whatToBuild: "Run an export every night.",
      acceptanceCriteria: ["A nightly export is emailed"],
      blockedBy: [1],
    },
  ],
};

/** The session's drafts as the Owner edits them, without the issues filed. */
const editsOf = async (
  s: Awaited<ReturnType<typeof setUp>>,
): Promise<GrillingIssueDraftEdit[]> =>
  ((await s.session()).issues?.drafts ?? []).map((draft) => ({
    id: draft.id,
    title: draft.title,
    whatToBuild: draft.whatToBuild,
    acceptanceCriteria: draft.acceptanceCriteria,
    blockedBy: draft.blockedBy,
    prdSections: draft.prdSections,
    adrs: draft.adrs,
  }));

/** Starts a session, settles it in one turn, and confirms it. */
async function settleAndConfirm(s: Awaited<ReturnType<typeof setUp>>) {
  s.model.json(onlyTurn);
  const started = await s.say("/grilling CSV export for orders");
  expect(started.replies[0]?.text).toContain("No open questions remain");
}

type Case = [
  name: string,
  run: (stores: OfficeStores, root: string) => Promise<void>,
];

const cases: Case[] = [
  [
    "the Manager drafts the issues once the documents are proposed, and the Owner's edited drafts are filed in dependency order with the right Blocked by links",
    async (stores, root) => {
      const s = await setUp(stores, root);
      await settleAndConfirm(s);

      // "confirm": the documents' pull request, then the Manager's draft.
      s.model.json(drafted);
      const confirmed = await s.say("confirm", 2);
      const [ended, draftedReply] = confirmed.replies;
      expect(ended?.text).toMatch(
        /^Ended the Grilling Session 1 on CSV export for orders: 1 decision settled\. Opened pull request #1 with its documents/,
      );
      expect(draftedReply).toMatchObject({
        kind: "reply",
        grilling: { sessionId: 1, round: null },
        text: [
          "Five slices, the button first.",
          "",
          "Drafted 5 issues from the Grilling Session 1 on CSV export for orders:",
          "",
          "1. Export button",
          "2. Build the CSV (blocked by 1)",
          "3. Name the columns (blocked by 2)",
          "4. Email the export (blocked by 2)",
          "5. Schedule exports (blocked by 1)",
          "",
          'Edit, reorder, merge or drop them under Issues when you read the session in the Grilling Sessions list. When they are right, approve them there, or reply "file the issues of session 1": the GitHub App files them in order, labelled ai-office, ready to become a Batch.',
        ].join("\n"),
      });
      // The Model was asked for them with the session and what it may cite.
      const prompt = s.model.requests.at(-1)?.system ?? "";
      expect(prompt).toContain(
        "## Draft the issues\n\nThe Grilling Session has ended, and pull request #1 proposes its documents.",
      );
      expect(prompt).toContain(
        '- `prdSections`: the headings of the PRD\'s sections it builds, from: "Problem", "Requirements".',
      );
      // Kept as drafts: only earlier blockers, only the session's own
      // sections and ADRs, spelled as the session has them, redacted.
      const session = await s.session();
      expect(session.status).toBe("ended");
      expect(session.issues).toMatchObject({ approvedAt: null, problem: null });
      expect(
        session.issues?.drafts.map(
          ({ id, blockedBy, prdSections, adrs, filed }) => ({
            id,
            blockedBy,
            prdSections,
            adrs,
            filed,
          }),
        ),
      ).toEqual([
        {
          id: 1,
          blockedBy: [],
          prdSections: ["Requirements"],
          adrs: [],
          filed: null,
        },
        {
          id: 2,
          blockedBy: [1],
          prdSections: ["Requirements"],
          adrs: ["Exports are built while the Owner waits"],
          filed: null,
        },
        { id: 3, blockedBy: [2], prdSections: [], adrs: [], filed: null },
        { id: 4, blockedBy: [2], prdSections: [], adrs: [], filed: null },
        { id: 5, blockedBy: [1], prdSections: [], adrs: [], filed: null },
      ]);
      expect(session.issues?.drafts[1]?.whatToBuild).toBe(
        "Fill the CSV with the shop's orders. Never [REDACTED].",
      );
      // Nothing is filed before the Owner approves.
      expect(await s.issues()).toEqual([]);

      // The Owner edits them: drafts blocked by each other are refused.
      let drafts = await editsOf(s);
      await expect(
        s.chat.saveGrillingIssues(
          "web-shop",
          1,
          drafts.map((draft) =>
            draft.id === 1 ? { ...draft, blockedBy: [3] } : draft,
          ),
        ),
      ).rejects.toThrow(
        new GrillingError(
          "grilling_issues_invalid",
          "Some issues are blocked by each other in a cycle, so none could be filed first.",
        ),
      );
      // A title and a criterion changed; "Name the columns" merged into
      // "Build the CSV"; "Schedule exports" dropped; "Email the export"
      // moved to the top, and blocked by the button too.
      drafts = drafts.map((draft) =>
        draft.id === 1
          ? {
              ...draft,
              title: "Add the Export button",
              acceptanceCriteria: [
                ...draft.acceptanceCriteria,
                "It is reachable from the keyboard",
              ],
            }
          : draft,
      );
      drafts = mergeIssueDrafts(drafts, 2, 3);
      drafts = dropIssueDraft(drafts, 5);
      drafts = moveIssueDraft(drafts, 4, -2);
      drafts = drafts.map((draft) =>
        draft.id === 4
          ? { ...draft, blockedBy: [...draft.blockedBy, 1] }
          : draft,
      );
      const saved = await s.chat.saveGrillingIssues("web-shop", 1, drafts);
      expect(
        saved.issues?.drafts.map(({ id, title, blockedBy }) => [
          id,
          title,
          blockedBy,
        ]),
      ).toEqual([
        [4, "Email the export", [2, 1]],
        [1, "Add the Export button", []],
        [2, "Build the CSV", [1]],
      ]);

      // Approved: filed in dependency order, not the list's.
      const filed = await s.say(fileGrillingIssuesText(1));
      const issues = await s.issues();
      expect(
        issues.map(({ number, title, labels, author, state }) => ({
          number,
          title,
          labels,
          author,
          state,
        })),
      ).toEqual([
        {
          number: 2,
          title: "Add the Export button",
          labels: ["ai-office"],
          author: s.fake.botLogin,
          state: "open",
        },
        {
          number: 3,
          title: "Build the CSV",
          labels: ["ai-office"],
          author: s.fake.botLogin,
          state: "open",
        },
        {
          number: 4,
          title: "Email the export",
          labels: ["ai-office"],
          author: s.fake.botLogin,
          state: "open",
        },
      ]);
      const [button, csv, email] = issues;
      expect(button?.body).toBe(
        [
          "## Context",
          "",
          `Drafted by ${s.manager.name}, the Floor's Manager, from the Grilling Session 1 on CSV export for orders, and approved by the Owner. Its documents are in pull request #1.`,
          "",
          "## What to build",
          "",
          "A button on Orders that downloads an empty CSV.",
          "",
          "## Acceptance criteria",
          "",
          "- [ ] The button downloads a file",
          "- [ ] It is reachable from the keyboard",
          "",
          "## Blocked by",
          "",
          "None: it can start at once.",
          "",
          "## Cites",
          "",
          `- PRD \`${prd}\`: § Requirements`,
          "",
        ].join("\n"),
      );
      // The merged issue: both "What to build"s, every criterion once.
      expect(csv?.body).toBe(
        [
          "## Context",
          "",
          `Drafted by ${s.manager.name}, the Floor's Manager, from the Grilling Session 1 on CSV export for orders, and approved by the Owner. Its documents are in pull request #1.`,
          "",
          "## What to build",
          "",
          "Fill the CSV with the shop's orders. Never [REDACTED].",
          "",
          "Give each column an English heading.",
          "",
          "## Acceptance criteria",
          "",
          "- [ ] Every order is a row",
          "- [ ] Every column has a heading",
          "",
          "## Blocked by",
          "",
          "- #2",
          "",
          "## Cites",
          "",
          `- PRD \`${prd}\`: § Requirements`,
          `- ADR \`${adr}\`: Exports are built while the Owner waits`,
          "",
        ].join("\n"),
      );
      // First in the Owner's list, filed last: it waits on both.
      expect(email?.body).toContain("## Blocked by\n\n- #2\n- #3\n");
      expect(email?.body).not.toContain("## Cites");
      for (const issue of issues) {
        expect(issue.body).not.toContain(anthropicKey);
      }

      expect(filed.replies[0]).toMatchObject({
        kind: "grilling",
        replyTo: filed.message.id,
        grilling: { sessionId: 1, round: null },
        text: [
          "Filed the 3 issues of the Grilling Session 1 on CSV export for orders on GitHub, labelled ai-office, each after those it is blocked by:",
          "",
          `- #2 Add the Export button: ${button?.htmlUrl ?? ""}`,
          `- #3 Build the CSV (blocked by #2): ${csv?.htmlUrl ?? ""}`,
          `- #4 Email the export (blocked by #2, #3): ${email?.htmlUrl ?? ""}`,
          "",
          'They are ready to become a Batch: say "complete issues 2 to 4".',
        ].join("\n"),
      });
      expect(
        s.published.flatMap((event) =>
          event.type === "grilling.issue_filed"
            ? [[event.issue, event.title, event.blockedBy]]
            : [],
        ),
      ).toEqual([
        [2, "Add the Export button", []],
        [3, "Build the CSV", [2]],
        [4, "Email the export", [2, 3]],
      ]);
      const after = await s.session();
      expect(after.issues?.approvedAt).not.toBeNull();
      expect(
        after.issues?.drafts.map(({ id, filed: issue }) => [id, issue?.number]),
      ).toEqual([
        [4, 4],
        [1, 2],
        [2, 3],
      ]);

      // Ready to become a Batch, without starting one: intake leaves the
      // App's issues alone, and a Batch takes them as the Owner's.
      const github = s.fake;
      for (const issue of issues) {
        expect(
          await fromOwner(
            github,
            s.floor,
            issue,
            defaultIntakeSettings.ownerLogin,
          ),
        ).toBe(false);
      }
      expect([...(await approvedIssues(stores.grilling, "web-shop"))]).toEqual([
        4, 2, 3,
      ]);

      // Filed once: not again, and no longer editable.
      const again = await s.say(fileGrillingIssuesText(1));
      expect(again.replies[0]).toMatchObject({
        kind: "hint",
        text: "The issues of the Grilling Session 1 on CSV export for orders are filed already: #4, #2, #3.",
      });
      await expect(
        s.chat.saveGrillingIssues("web-shop", 1, await editsOf(s)),
      ).rejects.toThrow(
        "The issues of the Grilling Session 1 on CSV export for orders are being filed, so they can no longer be edited.",
      );
      expect(await s.issues()).toHaveLength(3);
    },
  ],
  [
    "a draft the Model cannot write is asked for again, and filing that stops partway files only the rest the next time",
    async (stores, root) => {
      const s = await setUp(stores, root);
      await settleAndConfirm(s);

      // The Model answers twice with no issues.
      s.model.say("Here are some thoughts on the issues.");
      s.model.json({ issues: [] });
      const confirmed = await s.say("confirm", 2);
      expect(confirmed.replies[1]).toMatchObject({
        kind: "error",
        text: `${s.manager.name} could not draft the issues: issues: Draft at least one issue. Reply "draft the issues of session 1" to ask again.`,
      });
      expect((await s.session()).issues).toBeNull();
      const notYet = await s.say(fileGrillingIssuesText(1));
      expect(notYet.replies[0]?.text).toBe(
        'The Grilling Session 1 on CSV export for orders has no draft issues yet: reply "draft the issues of session 1".',
      );

      // Asked again, it drafts them.
      s.model.json({
        issues: drafted.issues.slice(0, 3),
      });
      const redrafted = await s.say("draft the issues");
      expect(redrafted.replies[0]?.text).toContain("Drafted 3 issues");

      // GitHub files one, then fails.
      s.failures.afterIssues = 1;
      const stopped = await s.say("approve the issues");
      expect(stopped.replies[0]).toMatchObject({
        kind: "error",
        text: [
          "Filed 1 of the 3 issues of the Grilling Session 1 on CSV export for orders, then filing stopped: GitHub is unavailable.",
          "",
          `- #2 Export button: ${(await s.issues())[0]?.htmlUrl ?? ""}`,
          "",
          'Reply "file the issues of session 1" to file the rest; those filed are not filed again.',
        ].join("\n"),
      });
      expect((await s.session()).issues).toMatchObject({
        problem: "GitHub is unavailable.",
        drafts: [
          { id: 1, filed: { number: 2 } },
          { id: 2, filed: null },
          { id: 3, filed: null },
        ],
      });
      // Once filing has begun, the drafts are no longer drafted again.
      const noRedraft = await s.say("draft the issues of session 1");
      expect(noRedraft.replies[0]?.text).toBe(
        "The issues of the Grilling Session 1 on CSV export for orders are not drafted again: 1 of 3 are filed already (#2).",
      );

      // Filing again files the rest, each blocked by the issue filed before.
      s.failures.afterIssues = Number.POSITIVE_INFINITY;
      const rest = await s.say(fileGrillingIssuesText(1));
      expect(rest.replies[0]?.kind).toBe("grilling");
      const issues = await s.issues();
      expect(issues.map(({ number, title }) => [number, title])).toEqual([
        [2, "Export button"],
        [3, "Build the CSV"],
        [4, "Name the columns"],
      ]);
      expect(issues[1]?.body).toContain("## Blocked by\n\n- #2\n");
      expect(issues[2]?.body).toContain("## Blocked by\n\n- #3\n");
      expect((await s.session()).issues?.problem).toBeNull();
    },
  ],
];

describe("a Grilling Session's issues, in memory", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  });
  for (const [name, run] of cases) {
    it(name, async () => {
      root = await mkdtemp(join(tmpdir(), "ai-office-grilling-issues-"));
      await run(memoryStores(), root);
    });
  }
});

describe("a Grilling Session's issues, in Postgres", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const root = await mkdtemp(join(tmpdir(), "ai-office-grilling-issues-"));
      try {
        await run(databaseStores(database.db), root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
