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
import { readOnlyPermissions } from "@ai-office/github";
import { createFakeGitHub } from "@ai-office/github/testing";
import { createRedactor } from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { createManagerChat, type ManagerChatUpdate } from "../manager/chat.ts";
import { floorChatSkills } from "../manager/chat-skills.ts";
import type {
  ModelClient,
  ModelReply,
  ModelRequest,
  ModelStreamOptions,
} from "../models/client.ts";
import { bash, createFakeSandbox, say } from "../sandbox/fake-sandbox.ts";
import { createFloorSkills } from "../skills/floor.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createSandboxFactFinder } from "./fact-finding.ts";

// Fact-finding in a Grilling Session, end to end (PRD §5 scenario 8.1,
// FR-79): the Owner runs `/grilling` in the Manager chat, and the
// Manager's Model, which the test scripts, needs to know facts about the
// Floor's repository before its first round. Rather than asking the
// Owner, it names them as facts to find: one itself, one delegated to the
// Floor's coder. AI Office finds each with real Sandcastle in a read-only
// sandbox (the host stands in for Docker, a script for the agent tool,
// which really reads the clone), keeps the answers with the session, and
// asks the Model for its turn again, which then asks the Owner only for
// decisions. Each case runs in memory and in Postgres 18.

const git = promisify(execFile);
const repository = "adrianeyre/web-shop";
const gatewayKey = "aio_gk_eachagentsownkeyforfindingfacts000000000";

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

/** Runs Git in `cwd` as a test helper, not as AI Office. */
const gitIn = async (cwd: string, ...args: string[]) =>
  (
    await git(
      "git",
      ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", ...args],
      { cwd },
    )
  ).stdout.trim();

/** The Floor's repository: its docs say where orders are kept. */
async function seedRepository(root: string): Promise<string> {
  const remote = join(root, "web-shop.git");
  const seed = join(root, "seed");
  await git("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await git("git", ["init", "--quiet", "-b", "main", seed]);
  await mkdir(join(seed, "docs"));
  await mkdir(join(seed, "src"));
  await writeFile(
    join(seed, "docs", "stack.md"),
    "# Stack\n\nOrders are kept in Postgres 18, in the `orders` table.\n",
  );
  await writeFile(
    join(seed, "src", "orders.ts"),
    "export const listOrders = () => db.select().from(orders);\n",
  );
  await gitIn(seed, "add", "-A");
  await gitIn(seed, "commit", "--quiet", "-m", "chore: start");
  await gitIn(seed, "push", "--quiet", remote, "main");
  return remote;
}

async function setUp(stores: OfficeStores, root: string) {
  const github = createFakeGitHub();
  github.installRepository(repository);
  const events = createEventBus({ store: memoryEventStore() });
  await createFloors({ store: stores.floors, github, events }).add(repository);
  const agents = await stores.agents.list("web-shop");
  const byRole = (role: string) => {
    const found = agents.find((agent) => agent.role === role);
    if (found === undefined) {
      throw new Error(`The Floor has no ${role}.`);
    }
    return found;
  };
  const manager = byRole("manager");
  const coder = byRole("coder");
  const reviewer = byRole("reviewer");
  const remote = await seedRepository(root);

  // The agent tool, standing in: it reads the clone with the shell, and
  // answers from what it read.
  // What each sandbox's GitHub token may do, while it runs.
  const scopes: unknown[] = [];
  const sandbox = await createFakeSandbox(async ({ prompt, print, sh }) => {
    const token = (await sh('printf %s "$GH_TOKEN"')).stdout;
    scopes.push(github.tokenScope(token)?.permissions);
    if (prompt.includes("Which database")) {
      print(bash("grep -rh Postgres docs"));
      const read = await sh("grep -rh Postgres docs");
      print(say(`<fact>${read.stdout.trim()} (docs/stack.md)</fact>`));
      return;
    }
    print(bash("grep -rli csv src"));
    const hits = (await sh("grep -rli csv src || true")).stdout.trim();
    print(
      say(
        `<fact>${hits === "" ? `No file under src/ mentions CSV: ${(await sh("ls src")).stdout.trim()} only lists orders. There is no export yet.` : `Yes, in ${hits}.`}</fact>`,
      ),
    );
  });
  const sentWith: string[] = [];
  const facts = createSandboxFactFinder({
    github,
    events,
    sandbox: (environment) => sandbox.provider(environment),
    gateway: (agent) => {
      sentWith.push(agent.id);
      return Promise.resolve({ url: "http://app:4000", key: gatewayKey });
    },
    workDir: join(root, "work"),
    cloneUrl: () => remote,
  });

  const model = scriptedModel();
  let tick = 0;
  const chat = createManagerChat({
    store: stores.managerChat,
    floors: stores.floors,
    agents: stores.agents,
    models: model.client,
    grilling: stores.grilling,
    facts,
    redactor: createRedactor(),
    now: () => new Date(Date.UTC(2026, 9, 10, 12, 0, tick++)),
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

  /**
   * Sends `text`, and the answer kept: at once, or once the Model wrote it
   * (after what the chat says of the facts being found, which answers the
   * message too).
   */
  const send = async (text: string) => {
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
            update.message.replyTo === sent.message.id &&
            update.message.kind !== "grilling",
        );
        expect(found).toBeDefined();
      },
      { timeout: 20_000 },
    );
    if (found?.type !== "message") {
      throw new Error("unreachable");
    }
    return { message: sent.message, reply: found.message };
  };
  return {
    github,
    chat,
    model,
    send,
    updates,
    sandbox,
    sentWith,
    scopes,
    remote,
    manager,
    coder,
    reviewer,
    events: async (): Promise<OfficeEvent[]> =>
      (await events.eventsAfter(0)).map(({ event }) => event),
  };
}

/** The part of a prompt under `heading`, to the next heading of its level. */
const section = (system: string, heading: string): string | undefined => {
  const level = /^#+/.exec(heading)?.[0] ?? "##";
  const start = system.indexOf(`${heading}\n`);
  if (start === -1) {
    return undefined;
  }
  const end = system.indexOf(`\n${level} `, start + 1);
  return system.slice(start, end === -1 ? undefined : end);
};

const databaseFact = "Which database are orders kept in?";
const exportFact = "Does the shop already export orders as CSV?";
const databaseAnswer =
  "Orders are kept in Postgres 18, in the `orders` table. (docs/stack.md)";
const exportAnswer =
  "No file under src/ mentions CSV: orders.ts only lists orders. There is no export yet.";

type Case = [
  name: string,
  run: (stores: OfficeStores, root: string) => Promise<void>,
];

const cases: Case[] = [
  [
    "a factual question is answered from the repository, by the Manager and an Agent it sends, without asking the Owner",
    async (stores, root) => {
      const s = await setUp(stores, root);
      const before = await gitIn(s.remote, "rev-parse", "main");

      // The Manager needs facts before round 1. Its answer also holds a
      // question the repository can answer, which is not kept: nothing
      // but the facts is, in an answer that names facts to find.
      s.model.turn({
        message: "",
        facts: [
          { question: databaseFact },
          { question: exportFact, agent: s.coder.name },
        ],
        questions: [{ text: databaseFact, recommended: "Postgres." }],
      });
      // Knowing them, it asks the Owner only for decisions.
      s.model.turn({
        message:
          "Orders are in Postgres and nothing exports them yet, so the export is new.",
        decisions: [],
        questions: [
          {
            text: "Which records does the export hold?",
            recommended: "Orders only.",
          },
          {
            text: "Who may run an export?",
            recommended: "Only the Owner.",
          },
        ],
      });
      const started = await s.send("/grilling CSV export for orders");

      // Round 1 asks the Owner decisions only; the factual question was
      // answered from the repository.
      expect(started.reply).toMatchObject({
        kind: "reply",
        grilling: { sessionId: 1, round: 1 },
      });
      expect(started.reply.text).toBe(
        [
          "Orders are in Postgres and nothing exports them yet, so the export is new.",
          "",
          "Round 1: 2 questions.",
          "",
          "1. Which records does the export hold?",
          "   Recommended: Orders only.",
          "",
          "2. Who may run an export?",
          "   Recommended: Only the Owner.",
          "",
          'Answer each by its number ("1: …"), reply "1: recommended" to accept one, or "recommended to all".',
        ].join("\n"),
      );
      const { session, messages } = await s.chat.grillingSession("web-shop", 1);
      expect(session.questions.map(({ text }) => text)).toEqual([
        "Which records does the export hold?",
        "Who may run an export?",
      ]);
      expect(
        messages.some(
          ({ kind, text }) =>
            kind !== "grilling" && text.includes("Which database"),
        ),
      ).toBe(false);

      // The facts, as found in the clone, kept with the session.
      expect(session.facts).toEqual([
        {
          number: 1,
          question: databaseFact,
          answer: databaseAnswer,
          status: "found",
          agentId: s.manager.id,
          round: 0,
          foundAt: expect.any(String) as string,
        },
        {
          number: 2,
          question: exportFact,
          answer: exportAnswer,
          status: "found",
          agentId: s.coder.id,
          round: 0,
          foundAt: expect.any(String) as string,
        },
      ]);

      // The chat says what is being found, then what was, before the round.
      expect(
        messages.map(({ kind, replyTo, text }) => ({
          kind,
          replyTo,
          text: text.split("\n")[0],
        })),
      ).toEqual([
        {
          kind: "owner",
          replyTo: null,
          text: "/grilling CSV export for orders",
        },
        {
          kind: "grilling",
          replyTo: started.message.id,
          text: "Before round 1, finding 2 facts in the repository rather than asking you:",
        },
        {
          kind: "grilling",
          replyTo: started.message.id,
          text: "Found in the repository:",
        },
        {
          kind: "reply",
          replyTo: started.message.id,
          text: "Orders are in Postgres and nothing exports them yet, so the export is new.",
        },
      ]);
      expect(messages[1]?.text).toBe(
        [
          "Before round 1, finding 2 facts in the repository rather than asking you:",
          "",
          `1. ${databaseFact} (${s.manager.name})`,
          `2. ${exportFact} (${s.coder.name}, sent by ${s.manager.name})`,
        ].join("\n"),
      );
      expect(messages[2]?.text).toBe(
        [
          "Found in the repository:",
          "",
          `F1. ${databaseFact}`,
          `   ${databaseAnswer} (${s.manager.name})`,
          "",
          `F2. ${exportFact}`,
          `   ${exportAnswer} (${s.coder.name})`,
        ].join("\n"),
      );

      // The Model was offered fact-finding, naming the Agents it may send
      // (the coder and QA, not the reviewer, who has no sandbox), then
      // given the facts word for word.
      expect(s.model.requests).toHaveLength(2);
      const [first, second] = s.model.requests.map(({ system }) => system);
      expect(first).toContain(
        "- `facts`: what you need to know about the Floor's code",
      );
      expect(first).toContain(
        `by you (${s.manager.name}), or by the Agent you name`,
      );
      expect(first).toContain(s.coder.name);
      expect(section(first ?? "", "### Facts found in the repository")).toBe(
        "### Facts found in the repository\n\nNone yet.\n",
      );
      expect(section(second ?? "", "### Facts found in the repository")).toBe(
        [
          "### Facts found in the repository",
          "",
          "Found in the Floor's code, docs and issues, so not to be asked of the Owner. One that could not be found may be asked, if it matters.",
          "",
          `- F1: ${databaseFact}`,
          `  Found: ${databaseAnswer}`,
          `- F2: ${exportFact}`,
          `  Found: ${exportAnswer}`,
          "",
        ].join("\n"),
      );
      expect(
        section(first ?? "", "## Your turn")?.includes(`, ${s.reviewer.name}`),
      ).toBe(false);
      // The skill tells it to find facts itself.
      expect(first).toContain("Find facts yourself:");

      // Each in its own read-only sandbox, with its own Agent's Gateway
      // Key; nothing reached GitHub, and no turn's JSON was streamed.
      expect(s.sentWith.sort()).toEqual([s.manager.id, s.coder.id].sort());
      expect(s.sandbox.sandboxes).toHaveLength(2);
      expect(s.scopes).toEqual([readOnlyPermissions, readOnlyPermissions]);
      for (const sandbox of s.sandbox.sandboxes) {
        expect(sandbox.closed).toBe(true);
        expect(sandbox.env["GIT_AUTHOR_NAME"]).toBeUndefined();
        // Each its own, revoked as its sandbox stopped (W1-3).
        expect(
          s.github.tokenScope(sandbox.env["GH_TOKEN"] ?? ""),
        ).toBeUndefined();
      }
      expect(s.sandbox.sandboxes[0]?.env["GH_TOKEN"]).not.toBe(
        s.sandbox.sandboxes[1]?.env["GH_TOKEN"],
      );
      expect(await gitIn(s.remote, "rev-parse", "main")).toBe(before);
      expect(s.updates.filter(({ type }) => type === "delta")).toEqual([]);
      const findings = (await s.events()).filter(({ type }) =>
        type.startsWith("grilling."),
      );
      expect(
        findings
          .filter((event) => event.type === "grilling.fact_finding_stopped")
          .map((event) => ({ agentId: event.agentId, outcome: event.outcome }))
          .sort((a, b) => a.agentId.localeCompare(b.agentId)),
      ).toEqual(
        [
          { agentId: s.manager.id, outcome: "found" },
          { agentId: s.coder.id, outcome: "found" },
        ].sort((a, b) => a.agentId.localeCompare(b.agentId)),
      );
      expect(findings).toHaveLength(4);
    },
  ],
  [
    "a fact for an Agent that cannot be sent is found by the Manager, and a turn has facts found at most twice",
    async (stores, root) => {
      const s = await setUp(stores, root);

      s.model.turn({
        facts: [
          { question: databaseFact, agent: s.reviewer.name },
          { question: exportFact, agent: "Zed" },
        ],
      });
      s.model.turn({ facts: [{ question: databaseFact }] });
      // A third time it may not: its facts are left out, the rest kept.
      s.model.turn({
        facts: [{ question: exportFact }],
        questions: [
          {
            text: "Which records does the export hold?",
            recommended: "Orders only.",
          },
        ],
      });
      const started = await s.send("/grilling CSV export");

      expect(started.reply.text).toContain(
        "Round 1: 1 question.\n\n1. Which records does the export hold?",
      );
      const { session, messages } = await s.chat.grillingSession("web-shop", 1);
      expect(
        session.facts.map(({ agentId, status }) => [agentId, status]),
      ).toEqual([
        [s.manager.id, "found"],
        [s.manager.id, "found"],
        [s.manager.id, "found"],
      ]);
      expect(messages[1]?.text).toBe(
        [
          "Before round 1, finding 2 facts in the repository rather than asking you:",
          "",
          `1. ${databaseFact} (${s.manager.name})`,
          `2. ${exportFact} (${s.manager.name})`,
          "",
          `${s.reviewer.name} is not one of the Floor's Agents that can be sent to find facts, so ${s.manager.name} finds "${databaseFact}" itself.`,
          `Zed is not one of the Floor's Agents that can be sent to find facts, so ${s.manager.name} finds "${exportFact}" itself.`,
        ].join("\n"),
      );
      expect(messages.filter(({ kind }) => kind === "grilling")).toHaveLength(
        4,
      );
      expect(s.model.requests).toHaveLength(3);
      const third = s.model.requests[2]?.system ?? "";
      expect(third).not.toContain("`facts`");
      expect(section(third, "### Facts found in the repository")).toContain(
        `- F3: ${databaseFact}`,
      );
      expect(s.sandbox.sandboxes).toHaveLength(3);
    },
  ],
];

/** Runs a case in a directory of its own, deleted after. */
const inRoot =
  (run: Case[1], stores: OfficeStores) => async (): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "ai-office-grilling-facts-"));
    try {
      await run(stores, root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

describe("fact-finding in a Grilling Session, in memory", () => {
  for (const [name, run] of cases) {
    it(name, () => inRoot(run, memoryStores())(), 30_000);
  }
});

describe("fact-finding in a Grilling Session, in Postgres", () => {
  for (const [name, run] of cases) {
    postgresTest(name, ({ database }) =>
      inRoot(run, databaseStores(database.db))(),
    );
  }
});
