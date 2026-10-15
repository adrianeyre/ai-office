import { defaultAiProvider, managerRole, type Stage } from "@ai-office/shared";

import type { RoleRecord, RoleStore } from "./store.ts";

// What the Role library means for an Agent (PRD FR-98): its Role's Stage,
// which the pipeline and dispatch go by; the AI Provider and Model a new
// Agent in a Role starts with; and the Role its next task reads.

/**
 * The Stage of `role` in `library`: null for the Manager, which is built
 * in, and for a Role the library does not have.
 */
export const stageIn = (
  library: readonly Pick<RoleRecord, "id" | "stage">[],
  role: string,
): Stage | null =>
  role === managerRole
    ? null
    : (library.find(({ id }) => id === role)?.stage ?? null);

/**
 * The AI Provider and Model a new Agent in `role` starts with (FR-98): the
 * Role's suggestion, unless the Owner has no AI Account for the suggested
 * AI Provider (`hasAccount`), when the office default AI Provider and its
 * default Model stand in. A Role that suggests none, and the Manager, get
 * the office default. Without `hasAccount`, the suggestion is taken.
 */
export function startingModel(
  role: Pick<RoleRecord, "aiProvider" | "model"> | undefined,
  hasAccount?: (aiProvider: string) => boolean,
): { readonly aiProvider: string; readonly modelOverride: string | null } {
  const suggested = role?.aiProvider ?? null;
  if (
    suggested !== null &&
    (suggested === defaultAiProvider ||
      hasAccount === undefined ||
      hasAccount(suggested))
  ) {
    return { aiProvider: suggested, modelOverride: role?.model ?? null };
  }
  return { aiProvider: defaultAiProvider, modelOverride: null };
}

/** Why a task could not read its Agent's Role. */
export class RoleNotFoundError extends Error {
  constructor(role: string) {
    super(`The office Role library has no Role "${role}".`);
    this.name = "RoleNotFoundError";
  }
}

/**
 * The library Role an Agent fills, as it is now: a task reads it as it
 * starts, so editing the Role changes the Agent's next task.
 */
export async function roleOfAgent(
  library: Pick<RoleStore, "get">,
  agent: { readonly role: string },
): Promise<RoleRecord> {
  const role = await library.get(agent.role);
  if (role === undefined) {
    throw new RoleNotFoundError(agent.role);
  }
  return role;
}
