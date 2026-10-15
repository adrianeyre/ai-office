import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sandboxMemoryDirectory } from "@ai-office/shared";

import type { MemoryFile } from "../memory/shared.ts";
import type { SkillMount } from "./skills.ts";

// Office-wide and Role memory in sandboxes (PRD FR-54, FR-55): written to
// a folder of their own beside the clone (never in it, so they cannot be
// committed), each file read-only, then bind-mounted read-only at the same
// place for every agent tool. The Agent's prompt says where.

/** The mount that gives a sandbox the memory written to `hostPath`. */
export const memoryMount = (hostPath: string): SkillMount => ({
  hostPath,
  sandboxPath: sandboxMemoryDirectory,
  readonly: true,
});

/** Writes each memory file to `into`, read-only. */
export async function writeMemory(
  into: string,
  files: readonly MemoryFile[],
): Promise<void> {
  await mkdir(into, { recursive: true });
  for (const { name, content } of files) {
    const target = join(into, name);
    await writeFile(target, content, { flag: "wx" });
    await chmod(target, 0o444);
  }
}
