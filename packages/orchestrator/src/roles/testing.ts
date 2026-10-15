import { builtInRole, managerRole, type Stage } from "@ai-office/shared";

import type { RoleRecord } from "./store.ts";

// The built-in Roles, for tests that build prompts and Agents by hand.

/** A built-in Role, by id; throws for any other. */
export function builtIn(id: string): RoleRecord {
  const role = builtInRole(id);
  if (role === undefined) {
    throw new Error(`"${id}" is not a built-in Role.`);
  }
  return role;
}

/** The Stage of a built-in Role, or null for the Manager. */
export const builtInStage = (id: string): Stage | null =>
  id === managerRole ? null : builtIn(id).stage;
