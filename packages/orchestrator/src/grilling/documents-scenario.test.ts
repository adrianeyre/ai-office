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
import { createRedactor, endGrillingText } from "@ai-office/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { modelOf } from "../agents/agents.ts";
import { createFloors } from "../floors/floors.ts";
import { createManagerChat, type ManagerChatUpdate } from "../manager/chat.ts";
import { floorChatSkills } from "../manager/chat-skills.ts";
import type {
  ModelClient,
  ModelReply,
  ModelRequest,
  ModelStreamOptions,
} from "../models/client.ts";
import { createNotices } from "../notices/notices.ts";
import { createOfficeSettings } from "../office/settings.ts";
import { gitBackedGitHub, gitIn } from "../sandbox/git-backed-github.ts";
import { createFloorSkills } from "../skills/floor.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createGrillingDocuments } from "./documents.ts";

// A Grilling Session's live documents and its closing pull request (PRD
// §5 scenario 8, FR-80), end to end through the Manager chat. The
// Manager's Model, which the test scripts, settles decisions, glossary
// terms, the PRD's outline, an ADR and a process doc over three turns.
// After each turn AI Office, as the GitHub App, commits the documents on
// `ai-office/grilling-1` of a local bare repository standing in for
// GitHub's remote: each settled term is in GLOSSARY.md as soon as the turn
// that settled it is kept, while no pull request exists. When the Owner
// confirms, the App opens one pull request with all of them, and the
// session ends. The second case covers GitHub failing. Each case runs in
// memory and in Postgres 18.

const exec = promisify(execFile);
const repository = "adrianeyre/web-shop";
const branch = "ai-office/grilling-1";
const prd = "docs/product-requirements-document/csv-export-for-orders.md";
const adr =
  "docs/architectural-decision-record/0002-exports-are-built-while-the-owner-waits.md";
const process = "docs/processes/running-an-export.md";
const owner = "adrianeyre <21265837+adrianeyre@users.noreply.github.com>";
const anthropicKey = "sk-ant-api03-livedocumentkey-Qw3Er4Ty5Ui6Op7As8Df9";

/** The Floor's glossary before the session: one term, and the heading's. */
const glossary = [
  "# Web shop",
  "",
  "A shop that sells tea.",
  "",
  "**Order**:",
  "A customer's purchase.",
  "_Avoid_: sale",
  "",
  "**Basket**:",
  "What a customer means to buy.",
  "",
].join("\n");

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
  };
}

/** A local bare repository standing in for GitHub's remote, with the Floor's docs. */
async function seedRepository(root: string): Promise<string> {
  const remote = join(root, "web-shop.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await exec("git", ["init", "--quiet", "-b", "main", seed]);
  await writeFile(join(seed, "README.md"), "# Web shop\n");
  await writeFile(join(seed, "GLOSSARY.md"), glossary);
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

/** The ways GitHub fails in the second case. */
interface Failures {
  token: number;
  pullRequest: number;
}

async function setUp(stores: OfficeStores, root: string) {
  const remote = await seedRepository(root);
  const fake = createFakeGitHub();
  fake.installRepository(repository);
  const backed = gitBackedGitHub(fake, remote);
  const failures: Failures = { token: 0, pullRequest: 0 };
  const github: GitHubApp = {
    ...backed,
    repository(fullName) {
      const client = backed.repository(fullName);
      return {
        ...client,
        installationToken: () =>
          failures.token-- > 0
            ? Promise.reject(new Error("GitHub is unavailable."))
            : client.installationToken(),
        createPullRequest: (input) =>
          failures.pullRequest-- > 0
            ? Promise.reject(new Error("GitHub refused the pull request."))
            : client.createPullRequest(input),
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
  const team = await stores.agents.list("web-shop");
  const manager = team.find(({ role }) => role === "manager");
  if (manager === undefined) {
    throw new Error("A new Floor has a Manager.");
  }
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
    redactor: createRedactor(),
    now,
    skills: floorChatSkills(
      createFloorSkills({
        floors: stores.floors,
        library: stores.skills,
        toggles: stores.floorSkills,
        reviews: stores.repositorySkillReviews,
        events,
        github,
      }),
    ),
  });
  const updates: ManagerChatUpdate[] = [];
  chat.subscribe("web-shop", (update) => updates.push(update));

  /** Sends `text`, and the answer kept: at once, or once it was written. */
  const say = async (text: string) => {
    const sent = await chat.send("web-shop", text);
    if (sent.reply !== undefined) {
      return { message: sent.message, reply: sent.reply };
    }
    let found: ManagerChatUpdate | undefined;
    await vi.waitFor(
      () => {
        found = updates.find(
          (update) =>
            update.type === "message" &&
            update.message.replyTo === sent.message.id,
        );
        expect(found).toBeDefined();
      },
      { timeout: 10_000 },
    );
    if (found?.type !== "message") {
      throw new Error("unreachable");
    }
    return { message: sent.message, reply: found.message };
  };
  return {
    remote,
    fake,
    chat,
    model,
    manager,
    failures,
    published,
    notices,
    say,
    /** A file on a branch of the remote. */
    fileOn: (ref: string, path: string) =>
      gitIn(remote, "show", `${ref}:${path}`),
    /** Every pull request the App opened, open or not. */
    pullRequests: () =>
      fake.repository(repository).listPullRequests({ state: "all" }),
    session: async () => (await chat.grillingSession("web-shop", 1)).session,
  };
}

const firstTurn = {
  message: "Let's settle what the export is for.",
  outline: [
    {
      heading: "Problem",
      text: "Shop staff copy orders into spreadsheets by hand.",
    },
  ],
  questions: [
    {
      text: "Which records does the export hold?",
      recommended: "Orders only.",
    },
    { text: "Who may run an export?", recommended: "Only the Owner." },
  ],
};

const secondTurn = {
  message: "",
  decisions: [{ text: "An export holds orders only.", questions: [1] }],
  terms: [
    {
      term: "Export",
      definition: `A CSV file of the shop's orders. Never ${anthropicKey}.`,
      avoid: ["dump", "report"],
    },
  ],
  outline: [
    {
      heading: "Problem",
      text: "Shop staff copy orders into spreadsheets by hand, every week.",
    },
    {
      heading: "Requirements",
      text: "The Owner downloads a CSV export of the shop's orders.",
    },
  ],
  questions: [
    { text: "Is it built at once or overnight?", recommended: "At once." },
  ],
};

const thirdTurn = {
  message: "That settles it.",
  decisions: [
    { text: "Exports are built while the Owner waits.", questions: [3] },
  ],
  terms: [
    {
      term: "Order",
      definition: "A customer's purchase, paid or refunded.",
      avoid: ["sale", "transaction"],
    },
  ],
  adrs: [
    {
      title: "Exports are built while the Owner waits",
      decision:
        "An export is built in the request that asks for it, not by a background job.",
      options: ["A nightly job: always a day out of date."],
      consequences: ["A very large shop's export may take seconds."],
      hardToReverse: "Moving to a job needs a queue and storage for files.",
      surprising: "Most exports elsewhere run in the background.",
      tradeOff: "Freshness over the request's speed.",
    },
    {
      title: "Columns are in English",
      decision: "Column headings are in English.",
      hardToReverse: "",
      surprising: "",
      tradeOff: "",
    },
  ],
  processes: [
    {
      title: "Running an export",
      text: "1. Open Orders.\n2. Choose Export.",
    },
  ],
  questions: [],
};

/** The glossary on the session's branch, as the scenario expects it at each step. */
const glossaryWith = (order: string[], exportTerm: boolean) =>
  [
    "# Web shop",
    "",
    "A shop that sells tea.",
    "",
    ...order,
    "",
    "**Basket**:",
    "What a customer means to buy.",
    ...(exportTerm
      ? [
          "",
          "## CSV export for orders",
          "",
          "**Export**:",
          "A CSV file of the shop's orders. Never [REDACTED].",
          "_Avoid_: dump, report",
        ]
      : []),
    "",
  ].join("\n");

type Case = [
  name: string,
  run: (stores: OfficeStores, root: string) => Promise<void>,
];

const cases: Case[] = [
  [
    "settled terms reach the glossary as soon as their turn is kept, the documents grow on one branch, and one pull request opens when the session ends",
    async (stores, root) => {
      const s = await setUp(stores, root);
      const mainBefore = await gitIn(s.remote, "rev-parse", "main");

      // Round 1: the PRD's outline is written on the session's branch.
      s.model.turn(firstTurn);
      const first = await s.say("/grilling CSV export for orders");
      expect(first.reply.text).toMatch(
        new RegExp(
          `^Let's settle what the export is for\\.\\n\\nUpdated on ${branch}: ${prd}\\.\\n\\nRound 1: 2 questions\\.\\n`,
        ),
      );
      expect(await s.fileOn(branch, prd)).toBe(
        [
          "# CSV export for orders",
          "",
          "| | |",
          "|---|---|",
          "| **Status** | Draft, from Grilling Session 1 |",
          "| **Glossary** | [`GLOSSARY.md`](../../GLOSSARY.md) |",
          "",
          "## Problem",
          "",
          "Shop staff copy orders into spreadsheets by hand.",
          "",
          "## Decisions",
          "",
          "None settled yet.",
        ].join("\n"),
      );
      // No term is settled yet, so the glossary is as it was.
      expect(await s.fileOn(branch, "GLOSSARY.md")).toBe(glossary.trimEnd());
      expect(await s.pullRequests()).toEqual([]);

      // Round 2: the turn settles "Export"; it is in the glossary at once.
      s.model.turn(secondTurn);
      const second = await s.say("recommended to all");
      expect(second.reply.text).toContain(
        `Updated on ${branch}: GLOSSARY.md and ${prd}.\n\nRound 2: 1 question.`,
      );
      expect(`${await s.fileOn(branch, "GLOSSARY.md")}\n`).toBe(
        glossaryWith(
          ["**Order**:", "A customer's purchase.", "_Avoid_: sale"],
          true,
        ),
      );
      // …while the session runs, with no pull request yet.
      expect((await s.session()).status).toBe("active");
      expect(await s.pullRequests()).toEqual([]);
      expect(await s.fileOn(branch, prd)).toContain(
        [
          "## Problem",
          "",
          "Shop staff copy orders into spreadsheets by hand, every week.",
          "",
          "## Requirements",
          "",
          "The Owner downloads a CSV export of the shop's orders.",
          "",
          "## Decisions",
          "",
          "Settled in Grilling Session 1, word for word:",
          "",
          "1. An export holds orders only.",
          "2. Who may run an export? Only the Owner.",
        ].join("\n"),
      );
      // The commits are the Owner's, with the Manager's trailer (ADR 0002),
      // one per turn, on top of main.
      const trailer = `${s.manager.name} (manager, ${s.manager.aiProvider} ${modelOf(s.manager) ?? ""})`;
      const log = (
        await gitIn(
          s.remote,
          "log",
          "--format=%an <%ae>|%cn <%ce>|%s|%(trailers:key=Agent,valueonly)",
          `main..${branch}`,
        )
      )
        .split("\n")
        .filter((line) => line !== "");
      expect(log).toEqual([
        `${owner}|${owner}|docs: Grilling Session 1 on CSV export for orders, as settled in round 2|${trailer}`,
        `${owner}|${owner}|docs: Grilling Session 1 on CSV export for orders, as settled in round 1|${trailer}`,
      ]);
      // The Model's next prompt holds the outline, word for word.
      const prompt = s.model.requests[1]?.system ?? "";
      expect(prompt).toContain(
        `### The documents\n\nAI Office writes them on the branch ${branch} as the session settles them`,
      );
      expect(prompt).toContain(
        "#### Problem\n\nShop staff copy orders into spreadsheets by hand.",
      );

      // Round 3: "Order" is defined again, in place; an ADR and a process
      // doc are written, and an ADR that says not why is left out.
      s.model.turn(thirdTurn);
      const third = await s.say("3: recommended");
      expect(third.reply.text).toBe(
        [
          "That settles it.",
          "",
          `Updated on ${branch}: GLOSSARY.md, ${adr}, ${process} and ${prd}.`,
          'Left out the ADR "Columns are in English": an ADR is only for a decision that is hard to reverse, surprising and the result of a real trade-off, and it did not say why for each.',
          "",
          'No open questions remain: 3 decisions are settled. Reply "confirm" to end the Grilling Session, or say what is still unsettled.',
        ].join("\n"),
      );
      expect(`${await s.fileOn(branch, "GLOSSARY.md")}\n`).toBe(
        glossaryWith(
          [
            "**Order**:",
            "A customer's purchase, paid or refunded.",
            "_Avoid_: sale, transaction",
          ],
          true,
        ),
      );
      expect(`${await s.fileOn(branch, adr)}\n`).toBe(
        [
          "# Exports are built while the Owner waits",
          "",
          "An export is built in the request that asks for it, not by a background job.",
          "",
          "## Considered Options",
          "",
          "- A nightly job: always a day out of date.",
          "",
          "## Consequences",
          "",
          "- A very large shop's export may take seconds.",
          "",
        ].join("\n"),
      );
      expect(`${await s.fileOn(branch, process)}\n`).toBe(
        "# Running an export\n\n1. Open Orders.\n2. Choose Export.\n",
      );
      expect(await s.pullRequests()).toEqual([]);
      expect(
        s.published.filter(({ type }) => type === "grilling.documents_written"),
      ).toHaveLength(3);

      // "confirm": the App opens one pull request with all of them.
      const confirmed = await s.say("confirm");
      const pulls = await s.pullRequests();
      expect(pulls).toHaveLength(1);
      const [pull] = pulls;
      expect(pull).toMatchObject({
        title: "docs: Grilling Session 1 on CSV export for orders",
        head: { name: branch },
        base: "main",
        state: "open",
      });
      expect(confirmed.reply).toMatchObject({
        kind: "grilling",
        replyTo: confirmed.message.id,
        grilling: { sessionId: 1, round: null },
        text: `Ended the Grilling Session 1 on CSV export for orders: 3 decisions settled and 2 glossary terms. Opened pull request #${String(pull?.number)} with its documents (${prd}, GLOSSARY.md, ${adr}, ${process}): ${pull?.htmlUrl ?? ""} It is kept with its full history in the Grilling Sessions list.`,
      });
      const files = await s.fake
        .repository(repository)
        .listPullRequestFiles(pull?.number ?? 0);
      expect(files.map(({ path }) => path).sort()).toEqual(
        [prd, "GLOSSARY.md", adr, process].sort(),
      );
      expect(pull?.body).toContain(
        "- Exports are built while the Owner waits\n  - Hard to reverse: Moving to a job needs a queue and storage for files.",
      );
      expect(pull?.body).not.toContain(anthropicKey);
      const session = await s.session();
      expect(session).toMatchObject({
        status: "ended",
        documents: {
          branch,
          files: [prd, "GLOSSARY.md", adr, process],
          pullRequest: { number: pull?.number, url: pull?.htmlUrl },
          problem: null,
        },
      });
      expect(session.adrs.map(({ title }) => title)).toEqual([
        "Exports are built while the Owner waits",
      ]);
      expect(
        s.published.filter(
          ({ type }) => type === "grilling.pull_request_opened",
        ),
      ).toEqual([
        expect.objectContaining({
          floorId: "web-shop",
          agentId: s.manager.id,
          sessionId: 1,
          branch,
          pullRequest: pull?.number,
        }),
      ]);
      expect(await s.notices.open({ floorId: "web-shop" })).toEqual([
        expect.objectContaining({
          kind: "info",
          title: `PR #${String(pull?.number)} opened on web-shop: the documents of Grilling Session 1 on CSV export for orders`,
        }),
      ]);
      // Nothing reached the default branch: merging is the Owner's.
      expect(await gitIn(s.remote, "rev-parse", "main")).toBe(mainBefore);
      // No credential was written anywhere.
      for (const path of [prd, "GLOSSARY.md", adr, process]) {
        expect(await s.fileOn(branch, path)).not.toContain(anthropicKey);
      }
    },
  ],
  [
    "when GitHub fails, the round is still asked and the documents are written next time; the session ends only once its one pull request is open",
    async (stores, root) => {
      const s = await setUp(stores, root);

      // The first write fails: the round is asked anyway, saying why.
      s.failures.token = 1;
      s.model.turn(firstTurn);
      const first = await s.say("/grilling CSV export for orders");
      expect(first.reply.text).toContain(
        `The documents could not be written on ${branch}: GitHub is unavailable. They are written again as the next decisions settle.\n\nRound 1: 2 questions.`,
      );
      expect((await s.session()).documents).toEqual({
        branch,
        files: [],
        commit: null,
        writtenAt: null,
        pullRequest: null,
        problem: "GitHub is unavailable.",
      });
      await expect(gitIn(s.remote, "rev-parse", branch)).rejects.toThrow();

      // The next turn writes everything settled so far.
      s.model.turn(secondTurn);
      await s.say("recommended to all");
      expect(await s.fileOn(branch, "GLOSSARY.md")).toContain(
        "**Export**:\nA CSV file of the shop's orders.",
      );
      expect((await s.session()).documents?.problem).toBeNull();

      s.model.turn({ ...thirdTurn, adrs: [], processes: [] });
      await s.say("3: recommended");

      // The pull request cannot be opened: the session stays open.
      s.failures.pullRequest = 1;
      const refused = await s.say("confirm");
      expect(refused.reply).toMatchObject({
        kind: "error",
        replyTo: refused.message.id,
        text: 'The Grilling Session 1 on CSV export for orders did not end: the pull request with its documents could not be opened. GitHub refused the pull request. It stays open: reply "confirm" to try again.',
      });
      expect(await s.session()).toMatchObject({
        status: "active",
        awaitingConfirmation: true,
        documents: { problem: "GitHub refused the pull request." },
      });
      expect(await s.pullRequests()).toEqual([]);

      // "confirm" again opens it, once.
      const confirmed = await s.say("confirm");
      expect(confirmed.reply.kind).toBe("grilling");
      expect(await s.pullRequests()).toHaveLength(1);
      expect(await s.session()).toMatchObject({
        status: "ended",
        documents: { problem: null, pullRequest: { number: 1 } },
      });
    },
  ],
  [
    "End session, with questions still open, opens the pull request of what has settled (FR-83a)",
    async (stores, root) => {
      const s = await setUp(stores, root);
      s.model.turn(firstTurn);
      await s.say("/grilling CSV export for orders");

      // The pull request cannot be opened at first: the retry is to end it again.
      s.failures.pullRequest = 1;
      const refused = await s.say(endGrillingText);
      expect(refused.reply.text).toContain(
        `It stays open: reply "${endGrillingText}" to try again.`,
      );
      expect((await s.session()).status).toBe("active");

      const ended = await s.say(endGrillingText);
      const [pull] = await s.pullRequests();
      expect(ended.reply).toMatchObject({ kind: "grilling" });
      expect(ended.reply.text).toMatch(
        /^Ended the Grilling Session 1 on CSV export for orders: 0 decisions settled\. Questions 1 and 2 of round 1 were left open\. Opened pull request #\d+ with its documents/,
      );
      expect(await s.session()).toMatchObject({
        status: "ended",
        documents: { pullRequest: { number: pull?.number } },
      });
    },
  ],
];

describe("a Grilling Session's live documents, in memory", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  });
  for (const [name, run] of cases) {
    it(name, async () => {
      root = await mkdtemp(join(tmpdir(), "ai-office-grilling-documents-"));
      await run(memoryStores(), root);
    });
  }
});

describe("a Grilling Session's live documents, in Postgres", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const root = await mkdtemp(
        join(tmpdir(), "ai-office-grilling-documents-"),
      );
      try {
        await run(databaseStores(database.db), root);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
