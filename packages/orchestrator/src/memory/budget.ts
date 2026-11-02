import {
  defaultPromptBudgetSettings,
  type PromptBudgetSettings,
} from "@ai-office/shared";

import { charactersIn, type ContextWindowOf } from "../context/window.ts";
import type { AgentMemory } from "./shared.ts";

// Prompt budgets: the most characters of the repository's memory, the
// office-wide memory, the Role's memory and the Floor's Skills listing an
// Agent's prompt carries (the Owner's settings), each lowered further on
// a small known context window, so they never take more than their share
// of it: a twentieth for each memory, a tenth for the Skills. The defaults
// are within those shares from a window of about 69,000 tokens (memory)
// and 115,000 (Skills) up, so a large window's prompts do not change. A
// part over its budget is truncated, deterministically, and the prompt
// says so: the head of a memory file (as the repository's memory always
// was), the newest of the Role's entries, the first of the Skills.

/** The most characters of each part of the prompt, after the window. */
export type PromptBudget = PromptBudgetSettings;

/** The share of the context window, in characters, each part may take. */
const windowShares: Readonly<Record<keyof PromptBudget, number>> = {
  repositoryMemory: 1 / 20,
  officeMemory: 1 / 20,
  roleMemory: 1 / 20,
  skills: 1 / 10,
};

/**
 * The budget for a Model with `contextWindow` tokens: the Owner's
 * settings, each at most its share of the window; the settings as they
 * are when the window is unknown (null).
 */
export function promptBudgetFor(
  settings: PromptBudgetSettings,
  contextWindow: number | null,
): PromptBudget {
  if (contextWindow === null) {
    return { ...settings };
  }
  const within = (key: keyof PromptBudget) =>
    Math.min(
      settings[key],
      Math.floor(charactersIn(contextWindow) * windowShares[key]),
    );
  return {
    repositoryMemory: within("repositoryMemory"),
    officeMemory: within("officeMemory"),
    roleMemory: within("roleMemory"),
    skills: within("skills"),
  };
}

/** An Agent's Model's prompt budget, by its AI Provider and Model. */
export type PromptBudgetOf = (
  aiProvider: string,
  model: string,
) => Promise<PromptBudget>;

/** The prompt budget from the Owner's settings and the Model's window. */
export const promptBudgetOf =
  (
    settings: () => Promise<PromptBudgetSettings>,
    contextWindow?: ContextWindowOf,
  ): PromptBudgetOf =>
  async (aiProvider, model) =>
    promptBudgetFor(
      await settings(),
      (await contextWindow?.(aiProvider, model)) ?? null,
    );

/** The default budget: what a prompt carried before budgets. */
export const defaultPromptBudget: PromptBudget = {
  ...defaultPromptBudgetSettings,
};

/**
 * The office-wide and Role memory within `budget`: the office-wide memory
 * cut at its budget, and as many of the Role's newest entries as fit in
 * its, each noted (`officeCut`, `roleLeftOut`) so the prompt can say so.
 * As it is without a budget, or when it fits.
 */
export function agentMemoryWithin(
  memory: AgentMemory,
  budget: PromptBudget | undefined,
): AgentMemory {
  if (budget === undefined) {
    return memory;
  }
  const { office } = memory;
  const officeCut = office !== undefined && office.length > budget.officeMemory;
  // The newest entries, as many as fit: the oldest go first.
  let room = budget.roleMemory;
  let kept = 0;
  for (let index = memory.role.length - 1; index >= 0; index -= 1) {
    const length = memory.role[index]?.length ?? 0;
    if (length > room) {
      break;
    }
    room -= length;
    kept += 1;
  }
  const roleLeftOut = memory.role.length - kept;
  if (!officeCut && roleLeftOut === 0) {
    return memory;
  }
  return {
    ...memory,
    ...(officeCut
      ? {
          office: office.slice(0, budget.officeMemory),
          officeCut: budget.officeMemory,
        }
      : {}),
    ...(roleLeftOut === 0
      ? {}
      : {
          role: memory.role.slice(roleLeftOut),
          roleLeftOut,
          roleBudget: budget.roleMemory,
        }),
  };
}

/** A Skill as a listing names it. */
export interface ListedSkill {
  readonly name: string;
  readonly description: string;
}

/**
 * The Skills whose listing (each one's name and description) fits in
 * `budget` characters, first first, and how many were left out after
 * them; all of them without a budget.
 */
export function skillsWithin<Skill extends ListedSkill>(
  skills: readonly Skill[],
  budget: number | undefined,
): { readonly skills: Skill[]; readonly leftOut: number } {
  if (budget === undefined) {
    return { skills: [...skills], leftOut: 0 };
  }
  let room = budget;
  let kept = 0;
  for (const { name, description } of skills) {
    const length = name.length + description.length;
    if (length > room) {
      break;
    }
    room -= length;
    kept += 1;
  }
  return { skills: skills.slice(0, kept), leftOut: skills.length - kept };
}

/** What a prompt says of Skills left out of its listing, if any. */
export const skillsLeftOutLine = (leftOut: number, budget: number): string =>
  `(${String(leftOut)} more ${leftOut === 1 ? "Skill was" : "Skills were"} left out: the list is longer than the ${budget.toLocaleString("en-GB")} characters a prompt carries.)`;
