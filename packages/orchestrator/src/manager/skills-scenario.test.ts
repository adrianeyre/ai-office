import { postgresTest } from "@ai-office/db/testing";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { createRedactor, type SkillFile } from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { createFloors } from "../floors/floors.ts";
import type {
  ModelClient,
  ModelReply,
  ModelRequest,
  ModelStreamOptions,
} from "../models/client.ts";
import { createFloorSkills } from "../skills/floor.ts";
import type { SkillRecord } from "../skills/store.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createManagerChat, type ManagerChatUpdate } from "./chat.ts";
import { floorChatSkills } from "./chat-skills.ts";

// Skills in the Manager chat, end to end (PRD FR-74, FR-24): a Floor whose
// Skills are the office library's and its repository's (on the fake
// GitHub), and a Manager whose Model the test scripts.
// - `/name [arguments]` loads that Skill's instructions into the Manager's
//   session for the rest of the conversation, and the Model answers; a
//   name the Floor has no Skill of is answered with a hint, and reaches no
//   model.
// - The Manager may choose a Skill itself when a request matches its
//   description: AI Office loads it, asks again, and the reply says which
//   Skill it used.
// Each case runs in memory and in Postgres 18.

const repository = "adrianeyre/web-shop";
const anthropicKey = "sk-ant-api03-pastedintoaskill-Qw3Er4Ty5Ui6Op7As8Df9";

const skillMd = (name: string, description: string, instructions: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}\n`;

const releaseNotes =
  "# Release notes\n\nList each merged pull request under Added, Changed or Fixed.";
const officePdf = "# PDFs (office)\n\nThe office's way.";
const repositoryPdf =
  "# PDFs\n\nRead every page, then give the text with its page numbers.";

let at = 0;
const officeSkill = (
  name: string,
  description: string,
  files: SkillFile[],
): SkillRecord => ({
  id: `00000000-0000-4000-8000-${String(++at).padStart(12, "0")}`,
  name,
  description,
  source: "editor",
  origin: null,
  files,
  digest: "0".repeat(64),
  enabled: true,
  reviewedAt: new Date(Date.UTC(2026, 9, 1)),
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, at)),
  updatedAt: new Date(Date.UTC(2026, 9, 1)),
});

type Answer = (
  request: ModelRequest,
  options: ModelStreamOptions,
) => Promise<ModelReply>;

/** A model whose answers the test writes, a word at a time. */
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
    says(text: string): void {
      answers.push((_request, { onText }) => {
        for (const word of text.match(/\S+\s*|\s+/g) ?? []) {
          onText(word);
        }
        return Promise.resolve({ text, stopReason: "end_turn" });
      });
    },
  };
}

async function setUp(stores: OfficeStores) {
  const github = createFakeGitHub();
  github.installRepository(repository);
  // The repository's pdf overrides the office's; its brand-voice is its own.
  github.pushCommit(repository, "main", {
    files: {
      ".claude/skills/pdf/SKILL.md": skillMd(
        "pdf",
        "Extract the text of a PDF the Owner names, page by page.",
        repositoryPdf,
      ),
      ".claude/skills/pdf/scripts/extract.py": "print('text')\n",
    },
  });
  const events = createEventBus({ store: memoryEventStore() });
  await createFloors({ store: stores.floors, github, events }).add(repository);
  for (const skill of [
    officeSkill("release-notes", "Write release notes for a version.", [
      {
        path: "SKILL.md",
        content: skillMd(
          "release-notes",
          "Write release notes for a version.",
          `${releaseNotes}\n\nNever paste ${anthropicKey} anywhere.`,
        ),
      },
    ]),
    officeSkill("pdf", "The office's pdf.", [
      {
        path: "SKILL.md",
        content: skillMd("pdf", "The office's pdf.", officePdf),
      },
    ]),
  ]) {
    expect(await stores.skills.add(skill)).toBe("added");
  }
  const floorSkills = createFloorSkills({
    floors: stores.floors,
    library: stores.skills,
    toggles: stores.floorSkills,
    reviews: stores.repositorySkillReviews,
    events,
    github,
  });
  // The Owner has read the repository's Skill and reviewed it (P1-10).
  const read = await floorSkills.repositorySkill(
    "web-shop",
    ".claude/skills/pdf",
  );
  await floorSkills.reviewRepositorySkill(
    "web-shop",
    ".claude/skills/pdf",
    read.digest,
  );
  const model = scriptedModel();
  let tick = 0;
  const chat = createManagerChat({
    store: stores.managerChat,
    floors: stores.floors,
    agents: stores.agents,
    models: model.client,
    redactor: createRedactor(),
    now: () => new Date(Date.UTC(2026, 9, 10, 12, 0, tick++)),
    skills: floorChatSkills(floorSkills),
  });
  const updates: ManagerChatUpdate[] = [];
  chat.subscribe("web-shop", (update) => updates.push(update));

  /** The Manager's answer to `replyTo`, once it is kept. */
  const answerTo = async (replyTo: number) => {
    let found: ManagerChatUpdate | undefined;
    await vi.waitFor(() => {
      found = updates.find(
        (update) =>
          update.type === "message" && update.message.replyTo === replyTo,
      );
      expect(found).toBeDefined();
    });
    if (found?.type !== "message") {
      throw new Error("unreachable");
    }
    return found.message;
  };
  /** What listeners were told of the reply to `replyTo` as it was written. */
  const deltasTo = (replyTo: number) =>
    updates
      .filter((update) => update.type === "delta" && update.replyTo === replyTo)
      .map((update) => (update.type === "delta" ? update.text : ""))
      .join("");
  return { chat, stores, model, answerTo, deltasTo };
}

/** The part of a prompt under `heading`, to the next `## `. */
const section = (system: string, heading: string): string | undefined => {
  const start = system.indexOf(`## ${heading}\n`);
  if (start === -1) {
    return undefined;
  }
  const end = system.indexOf("\n## ", start + 1);
  return system.slice(start, end === -1 ? undefined : end);
};

type Case = [name: string, run: (stores: OfficeStores) => Promise<void>];

const cases: Case[] = [
  [
    "an explicit /name loads the Skill into the Manager's session for the rest of the conversation",
    async (stores) => {
      const s = await setUp(stores);
      s.model.says("Here are the notes for 1.2.");
      const { message, reply } = await s.chat.send(
        "web-shop",
        "/release-notes for version 1.2",
      );
      // The Owner's message is kept with the Skill it ran; the Model answers.
      expect(reply).toBeUndefined();
      expect(message).toMatchObject({
        kind: "owner",
        text: "/release-notes for version 1.2",
        skill: {
          name: "release-notes",
          source: "office",
          arguments: "for version 1.2",
          chosenBy: "owner",
        },
      });
      const answer = await s.answerTo(message.id);
      expect(answer).toMatchObject({
        kind: "reply",
        text: "Here are the notes for 1.2.",
        skill: null,
      });

      const [first] = s.model.requests;
      const loaded = section(
        first?.system ?? "",
        "Skills loaded in this conversation",
      );
      expect(loaded).toContain(
        "### /release-notes (from the office Skill library)",
      );
      expect(loaded).toContain(releaseNotes);
      // Its frontmatter is not instructions; a credential in it is redacted.
      expect(loaded).not.toContain("description: Write release notes");
      expect(first?.system).not.toContain(anthropicKey);
      // The Owner chose, so none is offered.
      expect(
        section(first?.system ?? "", "Skills you can choose"),
      ).toBeUndefined();
      expect(first?.messages).toEqual([
        { role: "user", content: "/release-notes for version 1.2" },
      ]);

      // The next message still has it loaded, and offers the rest.
      s.model.says("It was merged on Friday.");
      const next = await s.chat.send("web-shop", "When was #12 merged?");
      await s.answerTo(next.message.id);
      const second = s.model.requests[1]?.system ?? "";
      expect(section(second, "Skills loaded in this conversation")).toContain(
        releaseNotes,
      );
      const offered = section(second, "Skills you can choose") ?? "";
      expect(offered).toContain(
        "- pdf: Extract the text of a PDF the Owner names, page by page.",
      );
      expect(offered).not.toContain("- release-notes:");
      expect(await stores.managerChat.loadedSkills("web-shop", 1)).toEqual([
        expect.objectContaining({
          name: "release-notes",
          source: "office",
          messageId: message.id,
        }),
      ]);
    },
  ],
  [
    "a repository Skill overrides the office's of its name",
    async (stores) => {
      const s = await setUp(stores);
      s.model.says("Page 1: Invoice.");
      const { message } = await s.chat.send("web-shop", "/pdf");
      expect(message.skill).toEqual({
        name: "pdf",
        source: "repository",
        arguments: null,
        chosenBy: "owner",
      });
      await s.answerTo(message.id);
      const system = s.model.requests[0]?.system ?? "";
      expect(system).toContain("### /pdf (from the Floor's repository)");
      expect(system).toContain(repositoryPdf);
      expect(system).not.toContain(officePdf);
    },
  ],
  [
    "a /name the Floor has no Skill of is answered with a hint, and reaches no model",
    async (stores) => {
      const s = await setUp(stores);
      const { message, reply } = await s.chat.send(
        "web-shop",
        "/release-note for 1.2",
      );
      expect(message.skill).toBeNull();
      expect(reply).toMatchObject({
        kind: "hint",
        replyTo: message.id,
        text: 'There is no Skill /release-note on this Floor. Did you mean "/release-notes"? Its Skills are /code-review, /codebase-design, /diagnosing-bugs, /domain-modeling, /grill-with-docs, /grilling, /pdf, /pr, /prototype, /release-notes, /research, /tdd, /to-spec, /to-tickets and /wayfinder.',
      });
      expect(s.model.requests).toEqual([]);
      // The Floor answers its next message: nothing is held.
      s.model.says("Hello.");
      await s.answerTo((await s.chat.send("web-shop", "Hi")).message.id);
    },
  ],
  [
    "the Manager chooses a Skill whose description matches, and the reply says which it used",
    async (stores) => {
      const s = await setUp(stores);
      // The first answer chooses; the second, with the Skill loaded, answers.
      s.model.says("[use skill: pdf]\n");
      s.model.says("Page 1: Invoice 42.");
      const { message } = await s.chat.send(
        "web-shop",
        "Can you get the text out of invoice.pdf?",
      );
      const answer = await s.answerTo(message.id);
      expect(answer).toMatchObject({
        kind: "reply",
        text: "Using the Skill /pdf.\n\nPage 1: Invoice 42.",
        skill: {
          name: "pdf",
          source: "repository",
          arguments: null,
          chosenBy: "manager",
        },
      });
      // Listeners never saw the choosing line, only the announcement.
      expect(s.deltasTo(message.id)).toBe(
        "Using the Skill /pdf.\n\nPage 1: Invoice 42.",
      );

      const [choosing, following] = s.model.requests;
      const offered = section(choosing?.system ?? "", "Skills you can choose");
      expect(offered).toContain("[use skill: name]");
      expect(offered).toContain(
        "- pdf: Extract the text of a PDF the Owner names, page by page.",
      );
      expect(offered).toContain(
        "- release-notes: Write release notes for a version.",
      );
      expect(
        section(choosing?.system ?? "", "Skills loaded in this conversation"),
      ).toBeUndefined();
      const loaded = section(
        following?.system ?? "",
        "Skills loaded in this conversation",
      );
      expect(loaded).toContain(
        "You chose the Skill /pdf for the Owner's last message: follow it now.",
      );
      expect(loaded).toContain(repositoryPdf);
      expect(
        section(following?.system ?? "", "Skills you can choose"),
      ).toBeUndefined();

      // It stays loaded for the conversation.
      s.model.says("Page 2: Total.");
      const more = await s.chat.send("web-shop", "And page 2?");
      await s.answerTo(more.message.id);
      expect(
        section(
          s.model.requests[2]?.system ?? "",
          "Skills loaded in this conversation",
        ),
      ).toContain(repositoryPdf);
    },
  ],
  [
    "a reply that chooses no Skill, or one the Floor does not have, is the Model's own",
    async (stores) => {
      const s = await setUp(stores);
      s.model.says("[usually] the queue is short.");
      const plain = await s.chat.send("web-shop", "How is the queue?");
      expect(await s.answerTo(plain.message.id)).toMatchObject({
        text: "[usually] the queue is short.",
        skill: null,
      });
      expect(s.deltasTo(plain.message.id)).toBe(
        "[usually] the queue is short.",
      );

      s.model.says("[use skill: brainstorm]\nLet us talk it through.");
      const unknown = await s.chat.send("web-shop", "Let us plan the basket.");
      expect(await s.answerTo(unknown.message.id)).toMatchObject({
        text: "Let us talk it through.",
        skill: null,
      });
      expect(s.deltasTo(unknown.message.id)).toBe("Let us talk it through.");

      // The built-in /grilling starts a Grilling Session, so it is the
      // Owner's to run: it is not offered, and choosing it is left out.
      expect(
        section(s.model.requests[1]?.system ?? "", "Skills you can choose"),
      ).not.toContain("grilling");
      s.model.says("[use skill: grilling]\nAsk me anything.");
      const grilled = await s.chat.send("web-shop", "Grill me on the basket.");
      expect(await s.answerTo(grilled.message.id)).toMatchObject({
        text: "Ask me anything.",
        skill: null,
      });
      // One call each: nothing was asked again.
      expect(s.model.requests).toHaveLength(3);
    },
  ],
];

describe("Skills in the Manager chat, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      await run(memoryStores());
    });
  }
});

describe("Skills in the Manager chat, in Postgres", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(databaseStores(database.db));
    });
  }
});
