import {
  managerCommandExamples,
  agentWithRole,
  type FloorSkillSource,
  type Role,
} from "@ai-office/shared";

import { memorySection } from "../memory/memory.ts";
import type { ModelMessage } from "../models/client.ts";
import type { ChatMessageRecord } from "./store.ts";

// The Manager's prompt in its chat with the Owner (PRD FR-23, FR-24): who
// it is, its Floor and its team, what a Manager may and may not do, and
// that commands are read by AI Office, not by it, the Skills loaded in the
// conversation and those it may choose (FR-74), and the repository's
// memory (FR-53), quoted as untrusted background. Then the conversation so
// far. With the Owner's requests on (ADR 0004), how it decides what each
// message is and answers a decision. The Owner is trusted; the prompt never holds a credential, and the
// Owner's own words are redacted before they are kept or sent.

export interface ManagerPromptInput {
  readonly floor: {
    readonly name: string;
    /** `owner/name` on GitHub. */
    readonly repository: string;
    readonly defaultBranch: string;
  };
  readonly manager: {
    readonly name: string;
    readonly extraInstructions: string;
  };
  /** The Floor's other Agents. */
  readonly team: readonly {
    readonly name: string;
    readonly role: Role;
    readonly aiProvider: string;
    readonly model: string | undefined;
    readonly enabled: boolean;
  }[];
  /** The repository's memory, redacted, if it has any. */
  readonly memory?: string;
  /**
   * The Skills loaded in this conversation (FR-74), oldest first: their
   * instructions, which the Manager follows for the rest of it.
   */
  readonly loadedSkills?: readonly PromptSkill[];
  /**
   * The Floor's other Skills, which the Manager may choose itself when a
   * request matches one's description, by starting its reply with
   * `skillChoice(name)`.
   */
  readonly offeredSkills?: readonly {
    readonly name: string;
    readonly description: string;
  }[];
  /** The Skill the Manager chose for the Owner's last message, now loaded. */
  readonly chosenSkill?: string;
  /**
   * The running Grilling Session (FR-77), from its stored data, and what
   * the Manager is asked for in it: its lines, after the Skills.
   */
  readonly grilling?: readonly string[];
  /**
   * The summary of the conversation before the messages given, when it was
   * compacted (FR-87).
   */
  readonly summary?: string;
  /**
   * How the Manager answers a request to spin work off (FR-24, ADR 0004):
   * its lines, after the Skills; none while it only talks.
   */
  readonly requests?: readonly string[];
  /**
   * Whether the Manager answers in its read-only agent session (FR-24, ADR
   * 0004), reading a clone of the repository and the web; else it cannot
   * read the repository here.
   */
  readonly readsRepository?: boolean;
}

/** A loaded Skill, as the prompt gives it. */
export interface PromptSkill {
  readonly name: string;
  readonly source: FloorSkillSource;
  readonly instructions: string;
}

const skillSourceWords: Record<FloorSkillSource, string> = {
  office: "from the office Skill library",
  repository: "from the Floor's repository",
  "built-in": "built into AI Office",
};

/** The most of one Skill's instructions the prompt carries. */
export const maxSkillInstructionCharacters = 40_000;

/** The line a reply starts with to choose a Skill: `[use skill: name]`. */
export const skillChoice = (name: string): string => `[use skill: ${name}]`;

/**
 * The Skill a reply's start chose, once it can tell: `{ name, rest }` for
 * `[use skill: name]` and what follows it; `false` for a start that is
 * not a choice; undefined while it could still be one.
 */
export function readSkillChoice(
  start: string,
): { readonly name: string; readonly rest: string } | false | undefined {
  const text = start.trimStart();
  const chosen = /^\[use skill:\s*([a-z0-9-]{1,64})\s*\]/.exec(text);
  if (chosen?.[1] !== undefined) {
    return {
      name: chosen[1],
      rest: text.slice(chosen[0].length).replace(/^\s*\n/, ""),
    };
  }
  const opening = "[use skill:";
  const partial =
    text.length <= opening.length
      ? opening.startsWith(text)
      : text.startsWith(opening) &&
        /^\[use skill:\s*[a-z0-9-]{0,64}\s*$/.test(text);
  return partial ? undefined : false;
}

function skillsSection(input: ManagerPromptInput): string[] {
  const loaded = input.loadedSkills ?? [];
  const offered = input.offeredSkills ?? [];
  const lines: string[] = [];
  if (loaded.length > 0) {
    lines.push(
      "",
      "## Skills loaded in this conversation",
      "",
      "A Skill is a named set of instructions. These were loaded in this conversation, by the Owner typing /name or by you choosing one: follow their instructions for the rest of it, wherever they apply. Their supporting files cannot be read from this chat, except a built-in Skill's, which are given after its instructions.",
    );
    if (input.chosenSkill !== undefined) {
      lines.push(
        "",
        `You chose the Skill /${input.chosenSkill} for the Owner's last message: follow it now. AI Office has already told the Owner you are using it.`,
      );
    }
    for (const skill of loaded) {
      const instructions =
        skill.instructions.length > maxSkillInstructionCharacters
          ? `${skill.instructions.slice(0, maxSkillInstructionCharacters)}\n\n(The rest of this Skill's instructions were left out.)`
          : skill.instructions;
      lines.push(
        "",
        `### /${skill.name} (${skillSourceWords[skill.source]})`,
        "",
        instructions.trim(),
      );
    }
  }
  if (offered.length > 0) {
    lines.push(
      "",
      "## Skills you can choose",
      "",
      `When the Owner's latest request clearly matches one of these Skills' descriptions, use that Skill: make the very first line of your reply ${skillChoice("name")}, with the Skill's name and nothing else on the line, then stop. AI Office then loads the Skill's instructions, tells the Owner you are using it, and asks you again. Choose at most one, and only when it fits; otherwise answer as usual. The Owner can also run one by typing /name.`,
      "",
      ...offered.map(
        ({ name, description }) =>
          `- ${name}: ${description.replaceAll(/\s+/g, " ").trim()}`,
      ),
    );
  }
  return lines;
}

/** The most of the conversation a call carries, oldest left out first. */
export const maxConversationCharacters = 100_000;

export function managerSystemPrompt(input: ManagerPromptInput): string {
  const { floor, manager } = input;
  const extra = manager.extraInstructions.trim();
  const commands = managerCommandExamples.map((example) => `"${example}"`);
  return [
    `You are ${manager.name}, the Manager of the Floor "${floor.name}" in AI Office. The Floor works the GitHub repository ${floor.repository}, whose default branch is ${floor.defaultBranch}. You are talking with the Owner: the one person who runs AI Office and has the last word on everything.`,
    "",
    "As the Manager you triage the Floor's issues, plan and dispatch its work to its Agents, watch for work that stalls or loops, and escalate to the Owner. You never merge, change the repository's settings or raise a Token Cap.",
    "",
    "## The Floor's Agents",
    "",
    ...(input.team.length === 0
      ? ["None besides you."]
      : input.team.map(
          (agent) =>
            `- ${agentWithRole(agent)}: ${agent.aiProvider}${agent.model === undefined ? "" : ` ${agent.model}`}${agent.enabled ? "" : " (paused)"}`,
        )),
    ...(input.team.length === 0
      ? []
      : [
          "",
          "When you name one of them, write its Role in brackets after its name, as listed here, such as Adrian (Coder), so the Owner knows who is who.",
        ]),
    "",
    "## Commands",
    "",
    `AI Office reads these commands itself, in plain code, and they never reach you: ${commands.slice(0, -1).join(", ")} and ${commands.at(-1) ?? ""}. Issue lists take ranges and lists, such as "complete issues 1 to 3 and 7". When the Owner seems to want one of them, tell them the exact words to type. The conversation shows the commands they typed, and what AI Office answered.`,
    "",
    "## This chat",
    "",
    input.readsRepository === true
      ? `Here you can read and search a read-only clone of ${floor.repository} at ${floor.defaultBranch}, in your working directory: its files, and its history (\`git log\`, \`git show\` and \`git diff\`) through your repository tools. You have no shell. You can also search and read the web. Look things up rather than guess at them. You cannot change anything here: no file, no commit, no command that writes. Every change goes through an issue, an Agent or a Contractor. You cannot read the repository's issues or pull requests here. Answer briefly, in plain text. Never put a credential, a token or a secret in your answer.`
      : "Here you cannot read the repository, its issues or its pull requests: say so rather than guess at them. Answer briefly, in plain text. Never put a credential, a token or a secret in your answer.",
    ...(input.summary === undefined
      ? []
      : [
          "",
          "## Earlier in this conversation",
          "",
          "The conversation before the messages you are given was compacted into this summary, which you wrote:",
          "",
          input.summary.trim(),
        ]),
    ...skillsSection(input),
    ...(input.requests === undefined ? [] : ["", ...input.requests]),
    ...(input.grilling === undefined ? [] : ["", ...input.grilling]),
    ...(input.memory === undefined ? [] : ["", ...memorySection(input.memory)]),
    ...(extra === ""
      ? []
      : ["", "## The Owner's instructions for you", "", extra]),
    "",
  ].join("\n");
}

/**
 * The conversation as the model is given it: the Owner's messages as the
 * user's turns, the Manager's (its replies, what AI Office answered to
 * commands, and its status reports) as the assistant's, with turns in a
 * row joined. Errors are
 * left out. It starts with the Owner, and the oldest turns are left out
 * to keep it within `maxCharacters`.
 */
export function conversation(
  messages: readonly ChatMessageRecord[],
  maxCharacters = maxConversationCharacters,
): ModelMessage[] {
  const turns: { role: ModelMessage["role"]; content: string }[] = [];
  for (const message of messages) {
    // Errors, and where the conversation was cleared or compacted.
    if (
      message.kind === "error" ||
      message.kind === "clear" ||
      message.kind === "summary"
    ) {
      continue;
    }
    const role = message.kind === "owner" ? "user" : "assistant";
    const last = turns.at(-1);
    if (last?.role === role) {
      last.content = `${last.content}\n\n${message.text}`;
    } else {
      turns.push({ role, content: message.text });
    }
  }
  let length = turns.reduce((sum, turn) => sum + turn.content.length, 0);
  while (
    turns.length > 1 &&
    (turns[0]?.role === "assistant" || length > maxCharacters)
  ) {
    length -= turns.shift()?.content.length ?? 0;
  }
  return turns;
}
