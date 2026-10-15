import {
  randomAvatar,
  seededRandom,
  type Avatar,
  type Role,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import type { AgentRecord } from "./agents/store.ts";
import { coderPrompt } from "./coder/prompt.ts";
import { docsPrompt } from "./docs/prompt.ts";
import { managerSystemPrompt } from "./manager/prompt.ts";
import { triagePrompt } from "./manager/triage-prompt.ts";
import { qaPrompt } from "./qa/prompt.ts";
import { reviewerPrompt } from "./review/prompt.ts";
import { builtIn, builtInStage } from "./roles/testing.ts";

// The Avatar never reaches a model's prompt (PRD FR-13): how an Agent
// looks never changes how it works. Every prompt builder is given whole
// Agents, Avatars and all, as the flows have them (the reviewer and the
// Manager's chat spread the Agent into their input), and each prompt must
// be the same whatever the Avatars, and hold none of an Avatar's parts.

/** An Avatar whose every part is a word no prompt has any other reason to use. */
const telltale: Avatar = {
  version: 1,
  presentation: "androgynous",
  bodyShape: "curvy",
  face: "heart",
  hairstyle: "braids",
  hairColour: "#d64f8f",
  skinTone: "#3b2219",
  facialHair: "goatee",
  glasses: "cat-eye",
  accessories: ["headphones", "earrings", "scarf"],
  outfit: {
    style: "overalls",
    primaryColour: "#e07a5f",
    secondaryColour: "#81b29a",
  },
  deskMascot: "rubber-duck",
  deskItems: [],
};

/** What a prompt holding any of the telltale Avatar would show. */
const telltaleWords = [
  "avatar",
  "androgynous",
  "curvy",
  "braids",
  "d64f8f",
  "3b2219",
  "goatee",
  "cat-eye",
  "headphones",
  "earrings",
  "scarf",
  "overalls",
  "e07a5f",
  "81b29a",
  "rubber-duck",
  "rubber duck",
];

const agent = (
  name: string,
  role: Role,
  avatar: Avatar,
): AgentRecord & { readonly model: string } => ({
  id: `${name.toLowerCase()}-id`,
  floorId: "web-shop",
  name,
  role,
  stage: builtInStage(role),
  aiProvider: "Claude",
  model: "claude-opus-5-5",
  modelOverride: null,
  effort: "high",
  extraInstructions: "Keep diffs small.",
  freshStartThreshold: null,
  enabled: true,
  avatar,
  tokenCaps: { daily: null, monthly: null },
  createdAt: new Date("2026-10-09T12:00:00.000Z"),
  leavingAt: null,
  contractor: null,
});

const floor = {
  name: "web-shop",
  repository: "adrianeyre/web-shop",
  defaultBranch: "main",
  setupCommand: "pnpm install",
  testCommand: "pnpm test",
};
const issue = {
  number: 7,
  title: "Add a basket",
  body: "## Acceptance criteria\n\n- [ ] A basket page lists the products added",
};
const handoff = {
  changed: "Added the basket page.",
  check: "The totals.",
  risks: "None known.",
};
const branch = "ai-office/7-add-a-basket";

/** Every prompt AI Office builds for a model, from a Floor's Agents. */
function prompts(avatars: readonly [Avatar, Avatar, Avatar, Avatar]): string[] {
  const [manager, coder, reviewer, qa] = [
    agent("Ada", "manager", avatars[0]),
    agent("Grace", "coder", avatars[1]),
    agent("Linus", "reviewer", avatars[2]),
    agent("Margaret", "qa", avatars[3]),
  ];
  const docs = agent("Ken", "docs", avatars[0]);
  const review = reviewerPrompt({
    floor,
    agent: reviewer,
    role: builtIn("reviewer"),
    issue,
    pullRequest: { number: 12, title: "Add a basket", branch },
    round: { number: 2, cap: 3 },
    handoff,
    files: [
      {
        path: "src/basket.ts",
        status: "added",
        patch: "@@ -0,0 +1 @@\n+export const basket = [];",
      },
    ],
    contents: [{ path: "src/basket.ts", text: "export const basket = [];" }],
  });
  const triage = triagePrompt({ floor, manager, issue });
  return [
    coderPrompt({ floor, agent: coder, role: builtIn("coder"), issue, branch }),
    coderPrompt({
      floor,
      agent: coder,
      role: builtIn("coder"),
      issue,
      branch,
      feedback: {
        round: 1,
        roundCap: 3,
        comments: [
          {
            reviewer: reviewer.name,
            path: "src/basket.ts",
            line: 1,
            body: "Type the basket.",
          },
        ],
        handoff,
      },
      qaFeedback: {
        round: 1,
        roundCap: 3,
        summary: "The total is wrong.",
        steps: "Add two items.",
        handoff,
      },
    }),
    review.system,
    review.user,
    qaPrompt({
      floor,
      agent: qa,
      role: builtIn("qa"),
      issue,
      branch,
      pullRequest: 12,
      round: { number: 1, cap: 3 },
      handoff,
    }),
    docsPrompt({
      floor,
      agent: docs,
      role: builtIn("docs"),
      issue,
      branch,
      pullRequest: 12,
      handoff,
    }),
    managerSystemPrompt({ floor, manager, team: [coder, reviewer, qa, docs] }),
    triage.system,
    triage.user,
  ];
}

describe("the Avatar in prompts", () => {
  it("is in no prompt: none of its parts, nor the word", () => {
    const built = prompts([telltale, telltale, telltale, telltale]);
    // The Agents were read: their names are there.
    expect(built.join("\n")).toContain("Grace");
    expect(built.join("\n")).toContain("Linus");
    for (const prompt of built) {
      for (const word of telltaleWords) {
        expect(prompt.toLowerCase()).not.toContain(word);
      }
    }
  });

  it("changes no prompt, whatever the Agents look like", () => {
    const expected = prompts([telltale, telltale, telltale, telltale]);
    const random = seededRandom("avatars in prompts");
    for (let floor = 0; floor < 50; floor += 1) {
      const team: Avatar[] = [];
      for (let index = 0; index < 4; index += 1) {
        team.push(randomAvatar(random, team));
      }
      expect(prompts(team as [Avatar, Avatar, Avatar, Avatar])).toEqual(
        expected,
      );
    }
  });
});
