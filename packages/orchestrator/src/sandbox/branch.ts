// Each issue is worked on a named branch, `ai-office/<issue>-<slug>`
// (PRD FR-19), which AI Office pushes; the issues of a Batch handed over
// "in one PR" share their Batch's, `ai-office/batch-<id>` (ADR 0010).

/** The longest slug a branch takes from the issue's title. */
const maxSlugLength = 40;

/** `ai-office/4-add-a-basket` for issue 4, "Add a basket!". */
export function issueBranch(issue: number, title: string): string {
  const slug = title
    .normalize("NFKD")
    // Accents become marks of their own: drop them, keeping the letters.
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .slice(0, maxSlugLength)
    .replaceAll(/^-+|-+$/g, "");
  return `ai-office/${String(issue)}${slug === "" ? "" : `-${slug}`}`;
}

/** `ai-office/batch-7`: the one branch Batch 7's issues are all worked on. */
export const batchBranch = (batchId: number): string =>
  `ai-office/batch-${String(batchId)}`;

/** An issue's place on its Batch's shared branch, for its Stages' prompts. */
export interface SharedBranch {
  readonly batchId: number;
  /**
   * The commit the branch was at as the issue started: its own work is
   * what came after. Null for the issue that began the branch.
   */
  readonly since: string | null;
}

/** What a prompt says of a shared branch: whose work on it is whose. */
export const sharedBranchLines = (shared: SharedBranch): string[] => [
  shared.since === null
    ? `- This branch is Batch ${String(shared.batchId)}'s: its issues are worked on it one after another and go in one pull request. This issue is the first on it.`
    : `- This branch is Batch ${String(shared.batchId)}'s: its issues are worked on it one after another and go in one pull request. Its commits up to \`${shared.since}\` are earlier issues' work, already reviewed; this issue's work is what comes after. Build on theirs, and change it only where this issue needs to.`,
];
