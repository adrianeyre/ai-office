import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  guidelineNamePattern,
  sandboxGuidelinesDirectory,
} from "@ai-office/shared";

import type { GuidelineFile } from "../guidelines/prompt.ts";
import type { SkillMount } from "./skills.ts";

// A task's Guidelines in its sandbox (Guidelines, Specs and Hooks PRD,
// FR-104, FR-106): written to a folder of their own beside the clone, as
// the memory is (never in it, so they cannot be committed, and never the
// repository's own `.agents/guidelines/`), each file read-only, then
// bind-mounted read-only for every agent tool. The Agent's prompt says
// where, and which to follow.

/** The mount that gives a sandbox the Guidelines written to `hostPath`. */
export const guidelinesMount = (hostPath: string): SkillMount => ({
  hostPath,
  sandboxPath: sandboxGuidelinesDirectory,
  readonly: true,
});

/** Writes each Guideline's file to `into`, read-only. */
export async function writeGuidelines(
  into: string,
  files: readonly GuidelineFile[],
): Promise<void> {
  await mkdir(into, { recursive: true });
  for (const { name, content } of files) {
    // A Guideline's name was checked when it was read; checked again, so
    // that no file is written outside the folder.
    if (
      !guidelineNamePattern.test(name.replace(/\.md$/, "")) ||
      !name.endsWith(".md")
    ) {
      throw new Error(`"${name}" is not a Guideline's file name.`);
    }
    const target = join(into, name);
    await writeFile(target, content, { flag: "wx" });
    await chmod(target, 0o444);
  }
}
