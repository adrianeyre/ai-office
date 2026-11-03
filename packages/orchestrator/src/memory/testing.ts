import type { Role } from "@ai-office/shared";

import type { AgentMemory } from "./shared.ts";

// Memory as long as AI Office keeps, for tests of the prompt budgets.

/** A repository's memory of 6,410 characters. */
export const longMemory = `# Memory\n\n${"- Run pnpm test before pushing.\n".repeat(200)}`;

/**
 * Office-wide memory of 7,014 characters, and 40 Role memory entries of
 * 290 characters each, `Entry 1` the oldest.
 */
export const longAgentMemory = (roleOf: Role): AgentMemory => ({
  office: "Use pnpm, never npm.\n".repeat(334),
  role: Array.from(
    { length: 40 },
    (_, index) =>
      `Entry ${String(index + 1).padStart(2, "0")}: ${"x".repeat(280)}`,
  ),
  roleOf,
});
