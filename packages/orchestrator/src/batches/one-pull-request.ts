import { isGitHubError, type RepositoryClient } from "@ai-office/github";
import type { PipelineStage } from "@ai-office/shared";

import { ownerOnly } from "../merge/owner-only.ts";
import { issueList } from "../manager/commands.ts";
import { PipelineError, positionOf } from "../pipeline/pipeline.ts";
import type { ReviewLoopStore } from "../review/store.ts";
import { batchBranch, issueBranch } from "../sandbox/branch.ts";
import type { BatchStore, PlanContent } from "./store.ts";

// One-pull-request Batches (PRD FR-21, FR-25a; ADR 0010). "complete issues
// 1 to 10 in one PR" hands the Manager a Batch whose issues are worked one
// after another, in the Plan's order, on one branch, `ai-office/batch-<id>`,
// each building on the commits of the issue before it. Every Stage still
// works each issue on its own (code, review, QA and docs), so the pipeline's
// labels and the Review Loop mean what they always do; only the branch they
// work on is the Batch's, and an issue's own work is what came after where
// the branch stood as it started (its base). The next issue starts once
// every issue before it has passed its pipeline (`ready-to-merge`), so
// nothing on the branch is still changing when it begins.
//
// One pull request carries the Batch: opened as its first issue goes to
// review, and written again as each issue joins it, with `Closes #N` for
// every issue that has, in the shape of the `pr` Skill (a Summary sketching
// the change, Evidence before and after, and the Merge Danger). The Merge
// Policy considers merging it only once every issue of the Batch is ready
// to merge (`merge/merge.ts`).

/** One of a one-pull-request Batch's issues, in its Plan's order. */
export interface BatchBranchIssue {
  readonly issue: number;
  /** As its Plan names it (redacted). */
  readonly title: string;
  /** Whether its work has started. */
  readonly started: boolean;
  /**
   * Where the branch stood as its work started: its own work is what came
   * after. Null before it starts, and for the issue that began the branch.
   */
  readonly base: string | null;
}

/** An open Batch whose issues go in one pull request, from one branch. */
export interface BatchBranch {
  readonly batchId: number;
  /** `ai-office/batch-<id>`. */
  readonly branch: string;
  /** The issues of its latest Plan, in order. */
  readonly issues: readonly BatchBranchIssue[];
}

export interface BatchBranches {
  /**
   * The open one-pull-request Batch whose latest Plan holds the issue on
   * the Floor; undefined when the issue's pull request is its own.
   */
  of(floorId: string, issue: number): Promise<BatchBranch | undefined>;
}

/** Finds the one-pull-request Batches issues belong to, from the store. */
export function createBatchBranches(
  store: Pick<BatchStore, "open" | "latestPlan" | "started">,
): BatchBranches {
  return {
    async of(floorId, issue) {
      for (const batch of await store.open(floorId)) {
        if (!batch.onePullRequest) {
          continue;
        }
        const plan = await store.latestPlan(batch.id);
        if (plan?.items.some((item) => item.issue === issue) !== true) {
          continue;
        }
        const started = new Map(
          (await store.started(batch.id)).map((each) => [each.issue, each]),
        );
        return {
          batchId: batch.id,
          branch: batchBranch(batch.id),
          issues: plan.items.map((item) => ({
            issue: item.issue,
            title: item.title,
            started: started.has(item.issue),
            base: started.get(item.issue)?.base ?? null,
          })),
        };
      }
      return undefined;
    },
  };
}

/** The branch an issue is worked on, and its Batch's when it shares one. */
export async function branchOf(
  branches: BatchBranches | undefined,
  floorId: string,
  issue: { readonly number: number; readonly title: string },
): Promise<{ readonly branch: string; readonly batch?: BatchBranch }> {
  const batch = await branches?.of(floorId, issue.number);
  return batch === undefined
    ? { branch: issueBranch(issue.number, issue.title) }
    : { branch: batch.branch, batch };
}

/** Where the issue's own work begins on the branch; undefined from its start. */
export const baseOf = (batch: BatchBranch, issue: number): string | undefined =>
  batch.issues.find((each) => each.issue === issue)?.base ?? undefined;

/**
 * Where the issue's own work ends on the branch: where the next issue to
 * start began; undefined while no later issue has, so its work runs to the
 * head.
 */
export function endOf(batch: BatchBranch, issue: number): string | undefined {
  const at = batch.issues.findIndex((each) => each.issue === issue);
  return (
    batch.issues
      .slice(at + 1)
      .find(({ started, base }) => started && base !== null)?.base ?? undefined
  );
}

/**
 * The Plan worked one issue at a time, in its order: each issue a group of
 * its own, as a one-pull-request Batch runs them.
 */
export const oneAtATime = (plan: PlanContent): PlanContent => ({
  ...plan,
  parallel: plan.items.map(({ issue }) => [issue]),
});

/** What the Owner reads of a one-pull-request Batch, in its Plan. */
export const onePullRequestLine = (batchId: number): string =>
  `All its issues go in one pull request, from one branch (${batchBranch(batchId)}): each is worked once the one before it is ready to merge, and the pull request merges once every one of them is.`;

/** The pull request's title: its Batch and issues. */
export function batchPullRequestTitle(
  batchId: number,
  issues: readonly number[],
): string {
  const first = issues[0];
  const last = issues.at(-1);
  return issues.length <= 5 || first === undefined || last === undefined
    ? `Batch ${String(batchId)}: ${issueList(issues)}`
    : `Batch ${String(batchId)}: ${String(issues.length)} issues, #${String(first)} to #${String(last)}`;
}

/** Where an issue is, as the pull request's body says it. */
export type BatchIssueState = PipelineStage | "closed" | null;

/** One issue as the pull request's body tells it. */
export interface BatchPullRequestIssue {
  readonly issue: number;
  readonly title: string;
  readonly state: BatchIssueState;
  /** Its latest round of review, and whether every verdict in it approved. */
  readonly review: { readonly round: number; readonly approved: boolean };
  /** Its latest round of QA's result, if QA checked it. */
  readonly qa: "pass" | "fail" | null;
}

/** The longest list of files the Summary sketches. */
const maxSketchedFiles = 30;

const stateWords: Record<Exclude<BatchIssueState, null>, string> = {
  "needs-work": "being worked",
  "needs-review": "in review",
  "needs-qa": "in QA",
  "needs-docs": "being documented",
  "ready-to-merge": "ready to merge",
  "needs-human": "handed to you",
  closed: "closed",
};

const stateOf = (state: BatchIssueState): string =>
  state === null ? "not started" : stateWords[state];

/** What the pipeline found of an issue so far, for its Evidence. */
function afterOf(issue: BatchPullRequestIssue): string {
  const found: string[] = [];
  if (issue.review.round > 0) {
    found.push(
      issue.review.approved
        ? `approved in review round ${String(issue.review.round)}`
        : `changes asked for in review round ${String(issue.review.round)}`,
    );
  }
  if (issue.qa !== null) {
    found.push(issue.qa === "pass" ? "QA passed" : "QA failed");
  }
  found.push(stateOf(issue.state));
  return found.join("; ");
}

/** A changed file in the Summary's sketch: `+` added, `-` removed. */
const sketched = (file: {
  readonly path: string;
  readonly status: string;
}): string =>
  file.status === "added"
    ? `+${file.path}`
    : file.status === "removed"
      ? `-${file.path}`
      : ` ${file.path}`;

/**
 * The one pull request's body, in the `pr` Skill's shape: a Summary
 * sketching the Batch's issues on the branch and the files they change,
 * with `Closes #N` for each issue that has joined it; Evidence before and
 * after for each; and the Merge Danger.
 */
export function batchPullRequestBody(input: {
  readonly batchId: number;
  readonly branch: string;
  /** In the Plan's order. */
  readonly issues: readonly BatchPullRequestIssue[];
  /** The files the pull request changes; none before it is opened. */
  readonly files: readonly { readonly path: string; readonly status: string }[];
  /** Why the Merge Policy hands it to the Owner whatever the Floor's (`ownerOnly`). */
  readonly ownerOnly: readonly string[];
}): string {
  const { issues, files } = input;
  const joined = issues.filter(({ state }) => state !== null);
  const width = Math.max(
    ...issues.map(({ issue }) => `#${String(issue)}`.length),
  );
  const tree = issues.map(({ issue, title, state }, index) => {
    const branch = index === issues.length - 1 ? "└──" : "├──";
    return `${branch} ${`#${String(issue)}`.padEnd(width)} ${title}: ${stateOf(state)}`;
  });
  const sketch = files.slice(0, maxSketchedFiles).map(sketched);
  const more = files.length - sketch.length;
  const migrations = files.some(({ path }) =>
    /(^|\/)migrations?\//i.test(path),
  );
  const radius =
    files.length <= 3 ? "small" : files.length <= 15 ? "moderate" : "wide";
  return [
    "## Summary",
    "",
    `Batch ${String(input.batchId)}'s issues, worked one after another on one branch, each building on the one before:`,
    "",
    "```text",
    input.branch,
    ...tree,
    "```",
    ...(sketch.length === 0
      ? []
      : [
          "",
          "```diff",
          ...sketch,
          ...(more > 0 ? [` … and ${String(more)} more`] : []),
          "```",
        ]),
    "",
    ...joined.map(({ issue }) => `Closes #${String(issue)}`),
    "",
    "## Evidence",
    "",
    ...issues.map(
      (issue) =>
        `- **Before:** #${String(issue.issue)} open: ${issue.title}\n  **After:** ${afterOf(issue)}`,
    ),
    "",
    "## Merge Danger",
    "",
    `**Door:** ${migrations ? "one-way" : "two-way"}`,
    "",
    migrations
      ? "It changes database migrations, which reverting the merge does not undo."
      : `Reverting its merge commit undoes ${issueList(joined.map(({ issue }) => issue))} together.`,
    "",
    `**Blast Radius:** ${radius}`,
    "",
    [
      `${String(joined.length)} issue${joined.length === 1 ? "" : "s"} and ${String(files.length)} file${files.length === 1 ? "" : "s"} change in one merge, which waits until every issue of the Batch is ready to merge.`,
      ...(input.ownerOnly.length === 0
        ? []
        : [
            `It goes to you whatever the Merge Policy, as ${input.ownerOnly.join("; and ")}.`,
          ]),
    ].join(" "),
    "",
  ].join("\n");
}

/**
 * Writes the Batch's one pull request as it stands: opened from its branch
 * when it has none yet, and its title and body written again from where
 * each issue is on GitHub and what its review and QA found. Answers it,
 * and whether it was opened now.
 */
export async function writeBatchPullRequest(input: {
  readonly client: RepositoryClient;
  readonly reviews?: Pick<ReviewLoopStore, "verdicts" | "qaReports">;
  readonly floorId: string;
  /** The Floor's default branch, which it merges into. */
  readonly base: string;
  readonly batch: BatchBranch;
}): Promise<{
  readonly number: number;
  readonly htmlUrl: string;
  /** The body before it was written again; empty when opened now. */
  readonly before: string;
  readonly opened: boolean;
}> {
  const { client, batch } = input;
  const issues: BatchPullRequestIssue[] = [];
  for (const { issue, title } of batch.issues) {
    const verdicts =
      (await input.reviews?.verdicts(input.floorId, issue)) ?? [];
    const round = Math.max(0, ...verdicts.map((verdict) => verdict.round));
    const latest = verdicts.filter((verdict) => verdict.round === round);
    const qa = (await input.reviews?.qaReports(input.floorId, issue))?.at(-1);
    let state: BatchIssueState;
    try {
      const now = await client.getIssue(issue);
      state =
        now.state === "closed" ? "closed" : positionOf(issue, now.labels).stage;
    } catch (error) {
      // Gone from GitHub, or with conflicting stage labels: told as not
      // started rather than guessed.
      if (!isGitHubError(error, 404) && !(error instanceof PipelineError)) {
        throw error;
      }
      state = null;
    }
    issues.push({
      issue,
      title,
      state,
      review: {
        round,
        approved:
          latest.length > 0 &&
          latest.every(({ verdict }) => verdict.verdict === "approve"),
      },
      qa: qa?.result ?? null,
    });
  }
  const title = batchPullRequestTitle(
    batch.batchId,
    batch.issues.map(({ issue }) => issue),
  );
  const [open] = await client.listPullRequests({ head: batch.branch });
  const body = (files: Parameters<typeof ownerOnly>[0]) =>
    batchPullRequestBody({
      batchId: batch.batchId,
      branch: batch.branch,
      issues,
      files,
      ownerOnly: ownerOnly(files),
    });
  const pullRequest =
    open ??
    (await client.createPullRequest({
      title,
      body: body([]),
      head: batch.branch,
      base: input.base,
    }));
  const files = await client.listPullRequestFiles(pullRequest.number);
  await client.updatePullRequest(pullRequest.number, {
    title,
    body: body(files),
  });
  return {
    number: pullRequest.number,
    htmlUrl: pullRequest.htmlUrl,
    before: open?.body ?? "",
    opened: open === undefined,
  };
}

/** Whether a pull request's body already closes the issue. */
export const closes = (body: string, issue: number): boolean =>
  new RegExp(`^Closes #${String(issue)}$`, "m").test(body);
