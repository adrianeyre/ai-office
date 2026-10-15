import { describe, expect, it } from "vitest";

import {
  conversation,
  managerSystemPrompt,
  maxSkillInstructionCharacters,
  readSkillChoice,
} from "./prompt.ts";
import type { ChatMessageRecord } from "./store.ts";

// The Manager's prompt in its chat (PRD FR-23, FR-24): who it is, its Floor
// and team, the commands AI Office reads itself, and the conversation so
// far as the model is given it.

const message = (
  id: number,
  kind: ChatMessageRecord["kind"],
  text: string,
): ChatMessageRecord => ({
  id,
  floorId: "web-shop",
  kind,
  text,
  command: kind === "command" ? { kind: "pause" } : null,
  replyTo: kind === "owner" ? null : id - 1,
  agentId: kind === "owner" ? null : "mira",
  model: null,
  skill: null,
  grilling: null,
  compaction: null,
  tools: [],
  attachments: [],
  createdAt: new Date("2026-10-09T12:00:00.000Z"),
});

describe("managerSystemPrompt", () => {
  const input = {
    floor: {
      name: "Web shop",
      repository: "adrianeyre/web-shop",
      defaultBranch: "main",
    },
    manager: { name: "Mira", extraInstructions: "" },
    team: [
      {
        name: "Ada",
        role: "coder",
        aiProvider: "Claude",
        model: "claude-opus-5-5",
        enabled: true,
      },
      {
        name: "Quinn",
        role: "qa",
        aiProvider: "Grok",
        model: undefined,
        enabled: false,
      },
    ],
  } as const;

  it("names the Manager, its Floor, its team and the commands AI Office reads", () => {
    const prompt = managerSystemPrompt(input);
    expect(prompt).toContain(
      'You are Mira, the Manager of the Floor "Web shop" in AI Office. The Floor works the GitHub repository adrianeyre/web-shop, whose default branch is main.',
    );
    expect(prompt).toContain("You never merge");
    // Each with its Role after its name, as the Manager is to name them.
    expect(prompt).toContain("- Ada (Coder): Claude claude-opus-5-5\n");
    expect(prompt).toContain("- Quinn (QA): Grok (paused)\n");
    expect(prompt).toContain(
      "such as Adrian (Coder), so the Owner knows who is who",
    );
    expect(prompt).toContain(
      '"complete issues 1 to 5", "complete issues 1 to 5 in one PR", "skip 4", "move 5 up", "pause", "resume" and "status"',
    );
    expect(prompt).not.toContain("The Owner's instructions for you");
  });

  it("ends with the Owner's extra instructions for the Manager", () => {
    expect(
      managerSystemPrompt({
        ...input,
        manager: { name: "Mira", extraInstructions: "  Be terse.  " },
      }),
    ).toMatch(/## The Owner's instructions for you\n\nBe terse\.\n$/);
  });
});

describe("Skills in the Manager's prompt", () => {
  const input = {
    floor: {
      name: "Web shop",
      repository: "adrianeyre/web-shop",
      defaultBranch: "main",
    },
    manager: { name: "Mira", extraInstructions: "Be brief." },
    team: [],
  } as const;

  it("gives the loaded Skills' instructions, then the others to choose from, before the Owner's instructions", () => {
    const prompt = managerSystemPrompt({
      ...input,
      loadedSkills: [
        {
          name: "pdf",
          source: "repository",
          instructions: "\n# PDFs\n\nRead every page.\n",
        },
      ],
      offeredSkills: [
        {
          name: "release-notes",
          description: "Write release notes\n  for a version.",
        },
      ],
    });
    expect(prompt).toContain(
      "## Skills loaded in this conversation\n\nA Skill is a named set of instructions.",
    );
    expect(prompt).toContain(
      "### /pdf (from the Floor's repository)\n\n# PDFs\n\nRead every page.\n",
    );
    expect(prompt).toContain(
      "make the very first line of your reply [use skill: name]",
    );
    expect(prompt).toContain(
      "- release-notes: Write release notes for a version.",
    );
    expect(prompt.indexOf("## Skills loaded")).toBeLessThan(
      prompt.indexOf("## Skills you can choose"),
    );
    expect(prompt.indexOf("## Skills you can choose")).toBeLessThan(
      prompt.indexOf("## The Owner's instructions for you"),
    );
  });

  it("says which Skill the Manager chose, and leaves out the end of a very long one", () => {
    const prompt = managerSystemPrompt({
      ...input,
      loadedSkills: [
        {
          name: "pdf",
          source: "office",
          instructions: "x".repeat(maxSkillInstructionCharacters + 10),
        },
      ],
      chosenSkill: "pdf",
    });
    expect(prompt).toContain(
      "You chose the Skill /pdf for the Owner's last message: follow it now.",
    );
    expect(prompt).toContain("### /pdf (from the office Skill library)");
    expect(prompt).toContain(
      `${"x".repeat(maxSkillInstructionCharacters)}\n\n(The rest of this Skill's instructions were left out.)`,
    );
    expect(prompt).not.toContain("x".repeat(maxSkillInstructionCharacters + 1));
    expect(prompt).not.toContain("## Skills you can choose");
  });

  it("has no Skills sections when there are none", () => {
    expect(managerSystemPrompt(input)).not.toContain("Skill");
  });
});

describe("readSkillChoice", () => {
  it("reads the Skill a reply's first line chooses, and what follows it", () => {
    expect(readSkillChoice("[use skill: pdf]")).toEqual({
      name: "pdf",
      rest: "",
    });
    expect(readSkillChoice("  [use skill:release-notes ]\nThe notes.")).toEqual(
      {
        name: "release-notes",
        rest: "The notes.",
      },
    );
  });

  it("waits while the start could still be a choice", () => {
    for (const start of [
      "",
      " ",
      "[",
      "[use",
      "[use skill:",
      "[use skill: rel",
      "[use skill: pdf ",
    ]) {
      expect(readSkillChoice(start), start).toBeUndefined();
    }
  });

  it("is no choice for any other start", () => {
    for (const start of [
      "Sure",
      "[usually]",
      "[use skill: PDF]",
      "[use skill: a b]",
      "[use skills: pdf]",
    ]) {
      expect(readSkillChoice(start), start).toBe(false);
    }
  });
});

describe("conversation", () => {
  it("gives the Owner's turns as the user's, and the Manager's as the assistant's", () => {
    expect(
      conversation([
        message(1, "owner", "pause"),
        message(2, "command", "Understood: pause this Floor's work."),
        message(3, "owner", "Why?"),
        message(4, "error", "Mira could not answer."),
        message(5, "owner", "Hello?"),
        message(6, "reply", "Hi."),
        message(7, "owner", "skp 4"),
        message(8, "hint", 'Did you mean "skip 4"?'),
        message(9, "owner", "Thanks"),
      ]),
    ).toEqual([
      { role: "user", content: "pause" },
      { role: "assistant", content: "Understood: pause this Floor's work." },
      { role: "user", content: "Why?\n\nHello?" },
      { role: "assistant", content: "Hi." },
      { role: "user", content: "skp 4" },
      { role: "assistant", content: 'Did you mean "skip 4"?' },
      { role: "user", content: "Thanks" },
    ]);
  });

  it("starts with the Owner, leaving the oldest turns out to fit", () => {
    const messages = [
      message(1, "reply", "An answer to something no longer here."),
      message(2, "owner", "a".repeat(60)),
      message(3, "reply", "b".repeat(60)),
      message(4, "owner", "c".repeat(60)),
    ];
    expect(conversation(messages).map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(conversation(messages, 130)).toEqual([
      { role: "user", content: "c".repeat(60) },
    ]);
  });
});
