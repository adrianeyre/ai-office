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
  createRedactor,
  draftGrillingIssuesText,
  guidelinesSkillName,
  parseGuideline,
} from "@ai-office/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { createGuidelineApprovals } from "../guidelines/approval.ts";
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

// `/guidelines` (Guidelines, Specs and Hooks PRD, FR-109), end to end
// through the Manager chat. The Manager's Model, which the test scripts,
// asks the Owner to confirm the conventions it found, then settles
// `product`, `tech` and `structure` (always) and two `fileMatch`
// Guidelines over three turns. After each turn AI Office, as the GitHub
// App, commits them on `ai-office/grilling-1` of a local bare repository
// standing in for GitHub's remote, each in `.agents/guidelines/` with a
// header that AI Office reads back as written, and nothing else: no PRD,
// ADR, glossary or process doc, whatever the Model gave. When the Owner
// confirms, the App opens one pull request with them, and no issues are
// drafted. The Owner's merge of it approves every one (ADR 0014). Each
// case runs in memory and in Postgres 18.

const exec = promisify(execFile);
const repository = "adrianeyre/web-shop";
const owner = "adrianeyre";
const branch = "ai-office/grilling-1";
const folder = ".agents/guidelines";
const anthropicKey = "sk-ant-api03-guidelinekey000-Qw3Er4Ty5Ui6Op7As8Df9";

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

/** A local bare repository standing in for GitHub's remote, with no Guidelines. */
async function seedRepository(root: string): Promise<string> {
  const remote = join(root, "web-shop.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await exec("git", ["init", "--quiet", "-b", "main", seed]);
  await writeFile(join(seed, "README.md"), "# Web shop\n\nWe sell tea.\n");
  await writeFile(join(seed, "GLOSSARY.md"), "# Web shop\n");
  await writeFile(
    join(seed, "package.json"),
    '{ "packageManager": "pnpm@12.10.0" }\n',
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
  const floor = await floors.add(repository);
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
    // Issues could be drafted: a `/guidelines` session drafts none.
    issues: createGrillingIssues({ github, events, now }),
    redactor: createRedactor(),
    now,
    // The Floor has only AI Office's own Skills.
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

  /** Sends `text`, and the answer kept: at once, or once it was written. */
  const say = async (text: string) => {
    const sent = await chat.send("web-shop", text);
    if (sent.reply !== undefined) {
      return { message: sent.message, reply: sent.reply };
    }
    let found: ManagerChatUpdate | undefined;
    await vi.waitFor(
      async () => {
        found = updates.find(
          (update) =>
            update.type === "message" &&
            update.message.replyTo === sent.message.id,
        );
        expect(found).toBeDefined();
        expect((await chat.history("web-shop")).pending).toEqual([]);
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
    floor,
    chat,
    model,
    events,
    published,
    notices,
    say,
    /** The files on a branch of the remote. */
    filesOn: async (ref: string) =>
      (await gitIn(remote, "ls-tree", "-r", "--name-only", ref)).split("\n"),
    /** A file on a branch of the remote. */
    fileOn: (ref: string, path: string) =>
      gitIn(remote, "show", `${ref}:${path}`),
    pullRequests: () =>
      fake.repository(repository).listPullRequests({ state: "all" }),
    session: async () => (await chat.grillingSession("web-shop", 1)).session,
  };
}

/** Round 1: the conventions found, for the Owner to confirm; nothing settled. */
const firstTurn = {
  message: "Here is what the repository does; confirm what is a rule.",
  questions: [
    {
      text: "The repository uses pnpm (package.json's packageManager): is that a rule?",
      recommended: "Yes: pnpm, never npm.",
    },
    {
      text: "Should migrations in packages/db have a Guideline of their own?",
      recommended: "Yes: plain SQL, one per change.",
    },
  ],
};

/** Round 2: the three always Guidelines and one fileMatch, and parts it drops. */
const secondTurn = {
  message: "The first Guidelines.",
  decisions: [
    { text: "pnpm is the package manager.", questions: [1] },
    { text: "Migrations get a fileMatch Guideline.", questions: [2] },
  ],
  // A /guidelines session writes none of these.
  terms: [{ term: "Tea", definition: "What the shop sells." }],
  outline: [{ heading: "Problem", text: "No Guidelines." }],
  processes: [{ title: "Releasing", text: "Tag it." }],
  guidelines: [
    {
      name: "product",
      description: "What the web shop is, and for whom.",
      text: "A web shop that sells tea to shoppers in the UK.\n\n- Say **shopper**, never customer.",
    },
    {
      name: "tech",
      inclusion: "always",
      description: "The stack, its tools and how to run them.",
      text: `Use pnpm, never npm.\n\nNever paste a key such as ${anthropicKey}.`,
    },
    {
      name: "structure",
      description: 'Where things go: "apps/" and "packages/".',
      text: "Apps live in `apps/`, shared code in `packages/`.",
    },
    {
      name: "migrations",
      inclusion: "fileMatch",
      fileMatchPatterns: ["packages/db/**"],
      description: "How migrations are written.",
      text: "Write each migration as plain SQL, never edited once merged.",
    },
  ],
  questions: [
    {
      text: "Should the web app's components have a Guideline too?",
      recommended: "Yes: every component has a test beside it.",
    },
  ],
};

/** Round 3: `tech` rewritten, one more fileMatch, and nothing left to ask. */
const thirdTurn = {
  message: "That is all of them.",
  decisions: [
    { text: "Components get a fileMatch Guideline.", questions: [3] },
  ],
  guidelines: [
    {
      name: "tech",
      description: "The stack, its tools and how to run them.",
      text: "Use pnpm, never npm.\n\nRun `pnpm test` before pushing.",
    },
    {
      name: "web",
      inclusion: "fileMatch",
      fileMatchPatterns: ["apps/web/**/*.tsx", "apps/web/**/*.css"],
      description: "How the web app's components are written.",
      text: "Every component has a test beside it.",
    },
  ],
  questions: [],
};

/** Each Guideline as AI Office reads it back, by name. */
const readBack = async (
  fileOn: (ref: string, path: string) => Promise<string>,
  names: readonly string[],
) =>
  new Map(
    await Promise.all(
      names.map(async (name) => {
        // `git show` drops the file's last newline; AI Office wrote one.
        const content = `${await fileOn(branch, `${folder}/${name}.md`)}\n`;
        const parsed = parseGuideline(`${name}.md`, content);
        if (!parsed.ok) {
          throw new Error(`${name}: ${parsed.refused.reason}`);
        }
        const { inclusion, fileMatchPatterns, description, body } =
          parsed.guideline;
        return [
          name,
          { content, inclusion, fileMatchPatterns, description, body },
        ] as const;
      }),
    ),
  );

type Case = [
  name: string,
  run: (stores: OfficeStores, root: string) => Promise<void>,
];

const cases: Case[] = [
  [
    "the session's Guidelines land in .agents/guidelines/ with valid headers, alone, in one pull request whose merge by the Owner approves them",
    async (stores, root) => {
      const s = await setUp(stores, root);
      const mainBefore = await gitIn(s.remote, "rev-parse", "main");

      // Round 1: the conventions found are put to the Owner; none is
      // settled, so nothing is written and no branch exists yet.
      s.model.turn(firstTurn);
      const first = await s.say(`/${guidelinesSkillName}`);
      expect(first.message.skill).toMatchObject({
        name: guidelinesSkillName,
        source: "built-in",
      });
      expect(first.reply.text).toMatch(
        /^Here is what the repository does; confirm what is a rule\.\n\nRound 1: 2 questions\.\n/,
      );
      expect((await s.session()).skill).toBe(guidelinesSkillName);
      const system = s.model.system();
      expect(system).toContain("### /grilling (");
      expect(system).toContain("### /guidelines (");
      expect(system).toContain(
        "AI Office's own Skill. It runs as a Grilling Session",
      );
      expect(system).toContain("### The Guidelines");
      expect(system).toContain("Still to write: product, tech, structure.");
      expect(system).not.toContain("### The documents");
      await expect(gitIn(s.remote, "rev-parse", branch)).rejects.toThrow();

      // Round 2: three Guidelines are written on the session's branch,
      // and nothing else. `tech` held a credential: redacted, it is still a
      // line no Guideline may have, so it is left out, saying why.
      s.model.turn(secondTurn);
      const second = await s.say("recommended to all");
      expect(second.reply.text).toContain(
        `Updated on ${branch}: ${folder}/migrations.md, ${folder}/product.md and ${folder}/structure.md.\nLeft out the tech Guideline: Line 8 looks like it holds a credential, which a Guideline never does: take it out. The Owner could never approve it as it is.`,
      );
      expect(second.reply.text).toContain("Round 2: 1 question.");
      expect(second.reply.text).not.toContain(anthropicKey);
      expect(await s.filesOn(branch)).toEqual([
        `${folder}/migrations.md`,
        `${folder}/product.md`,
        `${folder}/structure.md`,
        "GLOSSARY.md",
        "README.md",
        "package.json",
      ]);
      // The glossary is as it was: the session keeps no terms.
      expect(await s.fileOn(branch, "GLOSSARY.md")).toBe("# Web shop");
      expect(await s.session()).toMatchObject({
        terms: [],
        outline: [],
        adrs: [],
        processes: [],
      });
      const written = await readBack(s.fileOn, [
        "product",
        "structure",
        "migrations",
      ]);
      expect(written.get("product")).toEqual({
        content: [
          "---",
          "inclusion: always",
          'description: "What the web shop is, and for whom."',
          "---",
          "",
          "A web shop that sells tea to shoppers in the UK.",
          "",
          "- Say **shopper**, never customer.",
          "",
        ].join("\n"),
        inclusion: "always",
        fileMatchPatterns: [],
        description: "What the web shop is, and for whom.",
        body: "A web shop that sells tea to shoppers in the UK.\n\n- Say **shopper**, never customer.",
      });
      expect(written.get("structure")).toMatchObject({
        inclusion: "always",
        description: 'Where things go: "apps/" and "packages/".',
      });
      expect(written.get("migrations")).toMatchObject({
        inclusion: "fileMatch",
        fileMatchPatterns: ["packages/db/**"],
        description: "How migrations are written.",
      });
      expect((await s.session()).guidelines.map(({ name }) => name)).toEqual([
        "product",
        "structure",
        "migrations",
      ]);
      expect(await s.pullRequests()).toEqual([]);
      // Round 3: `tech` is written without the credential, and `web` added.
      s.model.turn(thirdTurn);
      const third = await s.say("3: recommended");
      expect(third.reply.text).toContain(
        `Updated on ${branch}: ${folder}/tech.md and ${folder}/web.md.`,
      );
      expect(third.reply.text).toContain('Reply "confirm"');
      // Round 3 was asked with every Guideline kept so far, word for word.
      expect(s.model.system()).toContain(
        "#### migrations (fileMatch: packages/db/**)\n\nHow migrations are written.\n\nWrite each migration as plain SQL, never edited once merged.",
      );
      expect(s.model.system()).toContain("Still to write: tech.");
      const settled = await readBack(s.fileOn, ["tech", "web"]);
      expect(settled.get("tech")?.body).toBe(
        "Use pnpm, never npm.\n\nRun `pnpm test` before pushing.",
      );
      expect(settled.get("web")).toMatchObject({
        inclusion: "fileMatch",
        fileMatchPatterns: ["apps/web/**/*.tsx", "apps/web/**/*.css"],
      });
      expect(await gitIn(s.remote, "rev-parse", "main")).toBe(mainBefore);

      // The Owner confirms: one pull request with the Guidelines, and no
      // issues drafted.
      const calls = s.model.requests.length;
      const confirmed = await s.say("confirm");
      expect(confirmed.reply.text).toContain("Opened pull request #");
      const [pull, ...others] = await s.pullRequests();
      expect(others).toEqual([]);
      expect(pull).toMatchObject({
        title: "docs: the Guidelines of Grilling Session 1",
        state: "open",
        head: { name: branch },
        base: "main",
      });
      expect(pull?.body).toContain(
        "Merging this pull request yourself is your approval of these Guidelines",
      );
      expect(pull?.body).toContain(
        "- `migrations` (fileMatch: `packages/db/**`): How migrations are written.",
      );
      expect(pull?.body).toContain(
        "- `product` (always): What the web shop is, and for whom.",
      );
      expect((await s.session()).status).toBe("ended");
      expect((await s.session()).issues).toBeNull();
      expect(s.model.requests).toHaveLength(calls);
      const asked = await s.say(draftGrillingIssuesText(1));
      expect(asked.reply).toMatchObject({ kind: "hint" });
      expect(asked.reply.text).toContain("drafts no issues");
      expect(s.published.map(({ type }) => type)).toContain(
        "grilling.pull_request_opened",
      );

      // The Owner merges it on GitHub: every Guideline it wrote is
      // approved, and reaches Agents as written.
      s.fake.mergePullRequest(repository, pull?.number ?? 0, {
        actor: owner,
        method: "squash",
      });
      const approvals = createGuidelineApprovals({
        github: s.fake,
        store: stores.guidelines,
        floors: stores.floors,
        notices: s.notices,
        events: s.events,
        ownerLogin: () => Promise.resolve(owner),
      });
      const state = await approvals.sync(s.floor);
      expect(state.unapproved).toEqual([]);
      expect(state.refused).toEqual([]);
      expect(
        state.approved.map(({ name, inclusion, approval }) => [
          name,
          inclusion,
          approval,
        ]),
      ).toEqual([
        ["migrations", "fileMatch", "owner_merge"],
        ["product", "always", "owner_merge"],
        ["structure", "always", "owner_merge"],
        ["tech", "always", "owner_merge"],
        ["web", "fileMatch", "owner_merge"],
      ]);
      approvals.stop();
    },
  ],
];

const roots: string[] = [];
const scratch = async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-office-guidelines-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("/guidelines, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(memoryStores(), await scratch());
    });
  }
});

describe("/guidelines, in Postgres", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(databaseStores(database.db), await scratch());
    });
  }
});
