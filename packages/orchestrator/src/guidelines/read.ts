import type { GitHubApp, RepositoryClient } from "@ai-office/github";
import {
  guidelineNameOf,
  guidelinesFolder,
  isGuidelineFileName,
  noGuidelines,
  parseGuideline,
  type FloorGuidelines,
  type Guideline,
  type RefusedGuideline,
  type Redactor,
} from "@ai-office/shared";

import type { FloorRecord } from "../floors/store.ts";

// Reading a Floor's Guidelines (Guidelines, Specs and Hooks PRD, FR-102,
// FR-112; ADR 0014): every `.agents/guidelines/*.md` on its default
// branch, read through the GitHub App, never from a clone (FR-104), and
// each checked as `parseGuideline` checks it. A file that breaks the rules
// is kept with its reason and reaches no Agent; one with a line that looks
// like a credential is refused, naming the line and never what it holds.
//
// This is only the reading: which versions the Owner approved, and which
// Guidelines each task gets, are decided elsewhere. A Floor with no
// Guidelines folder reads as none, and nothing changes for it.

const byPath = <T extends { readonly path: string }>(a: T, b: T): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * The Guidelines in a repository's `.agents/guidelines/` at `ref` (a
 * branch or a commit). Folders inside it, and files that are not `*.md`,
 * are not Guidelines and are passed over; an `*.md` entry that is not a
 * plain file (a symbolic link, say, which could point anywhere) is
 * refused. A file gone between listing and reading is gone.
 */
export async function readGuidelines(
  repository: Pick<RepositoryClient, "listDirectory" | "getFileContent">,
  ref: string,
  options: { readonly redactor?: Redactor } = {},
): Promise<FloorGuidelines> {
  const entries = await repository.listDirectory(guidelinesFolder, ref);
  if (entries === undefined || entries.length === 0) {
    return noGuidelines;
  }
  const guidelines: Guideline[] = [];
  const refused: RefusedGuideline[] = [];
  for (const entry of entries) {
    if (entry.type === "dir" || !isGuidelineFileName(entry.name)) {
      continue;
    }
    const path = `${guidelinesFolder}/${entry.name}`;
    if (entry.type !== "file") {
      refused.push({
        name: guidelineNameOf(entry.name),
        path,
        refusal: "invalid",
        reason:
          entry.type === "symlink"
            ? "It is a symbolic link, which AI Office does not follow."
            : "It is not a file.",
        secretLines: [],
      });
      continue;
    }
    const text = await repository.getFileContent(path, ref);
    if (text === undefined) {
      continue;
    }
    const parsed = parseGuideline(entry.name, text, options);
    if (parsed.ok) {
      guidelines.push(parsed.guideline);
    } else {
      refused.push(parsed.refused);
    }
  }
  return {
    guidelines: guidelines.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
    refused: refused.sort(byPath),
  };
}

/** A Floor's Guidelines, as they stand on its default branch now. */
export async function readFloorGuidelines(
  github: Pick<GitHubApp, "repository">,
  floor: Pick<FloorRecord, "repository" | "defaultBranch">,
  options: { readonly redactor?: Redactor } = {},
): Promise<FloorGuidelines> {
  return readGuidelines(
    github.repository(floor.repository),
    floor.defaultBranch,
    options,
  );
}
