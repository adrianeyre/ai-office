import { setTimeout as delay } from "node:timers/promises";

import type { EventBus } from "@ai-office/events";
import {
  GitHubError,
  type GitHubApp,
  type Issue,
  type MergeMethod,
  type PullRequest,
  type RepositoryClient,
} from "@ai-office/github";
import {
  mergeActions,
  mergePolicyOverrides,
  type MergePolicy,
} from "@ai-office/shared";

import type { AgentStore } from "../agents/store.ts";
import {
  endOf,
  writeBatchPullRequest,
  type BatchBranch,
  type BatchBranches,
} from "../batches/one-pull-request.ts";
import type { BatchStore } from "../batches/store.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import type { IntakeQueue } from "../intake/intake.ts";
import type { NoticeRecord } from "../notices/store.ts";
import { NoticeOutdatedError, type Notices } from "../notices/notices.ts";
import {
  createPipeline,
  positionOf,
  type Pipeline,
} from "../pipeline/pipeline.ts";
import { everyRoundLinks } from "../qa/caps.ts";
import type {
  QaReportRecord,
  ReviewLoopStore,
  VerdictRecord,
} from "../review/store.ts";
import { issueBranch } from "../sandbox/branch.ts";
import type { ExecuteWork } from "../work/queue.ts";
import type { WorkItem } from "../work/store.ts";
import {
  approvedBefore,
  ciHeldBack,
  ciOf,
  ciRunOf,
  heldBack,
  roundLeft,
  type CapReachedOnIssue,
  type CiState,
} from "./gate.ts";
import { ownerOnly } from "./owner-only.ts";

// The Merge Policy (PRD FR-29, FR-49; §5 scenario 3; ADR 0002): work queued
// at `ready-to-merge`, once a pull request has passed review, QA and docs,
// decides what becomes of it. No Agent does it and it uses no sandbox: it
// only asks GitHub, as the App.
//
// - **Send to me** (each Floor's default): an action Notice, "PR #N
//   awaiting your approval", links the pull request, the issue, its CI run
//   and each round of review and QA, and offers "Approve and merge".
// - **Auto-merge**: once CI on the head commit has finished (waited for,
//   up to half an hour), the App merges the pull request when the gate
//   (`gate.ts`) lets it: every required reviewer approved the head it
//   merges, no blocking comments remain, the required CI checks passed and
//   no cap was exceeded. An info Notice records it. Otherwise it goes to
//   the Owner as "send to me" does, the Notice saying why. When all that
//   stands in the way is commits pushed after the reviewers approved (QA's
//   tests, the designer's fixes, the docs Agent's changes), it goes back to
//   `needs-review` instead, while the Review Loop has a round left, and
//   its reviewers review them too (P1-1): nothing is merged by policy that
//   they were not shown. A pull request that changes what CI runs
//   (`owner-only.ts`) always goes to the Owner (P1-2): CI runs what the
//   pull request says, so neither it nor the reviewers are a check on it.
//   So does one that changes what later Agents read as memory, Skills or
//   their agent tool's instructions and settings (P1-3): the memory
//   changes only by the Owner's merge (FR-53), and a Skill only with the
//   Owner's review (FR-76).
// - An issue a chat request's Batch holds always goes to the Owner (P2-3,
//   the Owner's decision in #199): the Plan behind it was written by the
//   Manager's session, after reading content anyone may have planted, and
//   no deterministic rule can tell that from what the Owner meant. The
//   request still starts its Batch at once (ADR 0004); only its merge
//   waits for the Owner, whatever the Floor's policy.
// - A Batch handed over "in one PR" (ADR 0010) has one pull request for
//   all its issues, which is considered only once every one of them is at
//   `ready-to-merge`: until then each issue that gets there waits, and one
//   handed to the Owner (`needs-human`) holds the whole pull request, as a
//   Notice says. The gate then asks of each issue what it asks of one: its
//   reviewers approved its own work, as it stood when the next issue began
//   (or at the head), with no blocking comments left and no cap exceeded;
//   its labels may send the whole pull request to the Owner. Once merged,
//   each issue's merge is recorded.
//
// An issue overrides its Floor's policy with a label: `ai-office:manual`
// sends it to the Owner, and `ai-office:auto-merge` merges it
// automatically, but only when the Owner added that label (anyone may ask
// for the Owner's approval; only the Owner may waive it). With both, the
// Owner decides.
//
// "Approve and merge" has the App merge the pull request as the Owner
// approved it: the Owner is the human of last resort, so the gate is not
// asked again, though GitHub's branch protection still is. Each merge is a
// `pull_request.merged` event and an info Notice saying who merged it.
// The Owner approves one head (W1-6): the Notice names the head it was
// raised for, and only that head is merged. If the branch has moved on
// since, nothing is merged and a new Notice asks about the new head; if
// the issue has left `ready-to-merge`, nothing is merged at all. Either
// way the old Notice is closed, as it is when the pull request is sent to
// the Owner again for another head.

/** How long the gate waits for CI on an auto-merge Floor. */
export interface CiWait {
  /** How often it looks at CI again while it runs. */
  readonly pollMs: number;
  /** How long it waits for CI to finish before sending it to the Owner. */
  readonly timeoutMs: number;
  /**
   * How long it waits for a first check to start when none is required:
   * then a pull request with no CI at all goes to the Owner.
   */
  readonly startMs: number;
}

export const defaultCiWait: CiWait = {
  pollMs: 30_000,
  timeoutMs: 30 * 60_000,
  startMs: 5 * 60_000,
};

export interface MergeFlowOptions {
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  readonly github: GitHubApp;
  readonly notices: Notices;
  readonly events: EventBus;
  /** The Review Loop's verdicts and QA's reports. */
  readonly reviews: ReviewLoopStore;
  /** Which issues a chat request's Batch holds: never merged by policy (P2-3). */
  readonly batches: Pick<BatchStore, "chatIssue">;
  /** The Batches handed over "in one PR", merged as one (ADR 0010). */
  readonly batchBranches?: BatchBranches;
  /** Moves an issue back to review; one on `github` and `events` otherwise. */
  readonly pipeline?: Pipeline;
  /** Where the reviewers' work is queued when it goes back to them. */
  readonly queue?: IntakeQueue;
  /** The Owner's GitHub login (FR-8): whose `ai-office:auto-merge` counts. */
  readonly ownerLogin: () => Promise<string>;
  /** How long to wait for CI; the defaults otherwise. */
  readonly ci?: Partial<CiWait>;
  /** Waits `ms`, or rejects once `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => Date;
}

export interface MergeFlow {
  /** Does the work queued at `ready-to-merge`. */
  readonly execute: ExecuteWork;
  /** Removes the "Approve and merge" action's handler. */
  stop(): void;
  /**
   * CI changed on the Floor's repository, as a GitHub webhook says (FR-8):
   * the gate waiting for it there looks again now, not at its next poll.
   */
  ciChanged(floorId: string): void;
}

/**
 * How the App merges: with a merge commit, never squashed or rebased, so
 * each of the Agents' commits stays as it was pushed, authored as the
 * Owner with its `Agent:` trailer (ADR 0002).
 */
const mergeMethod: MergeMethod = "merge";

/** The longest phrase from GitHub a Notice's title carries. */
const maxReason = 120;

const clip = (text: string, length: number): string =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;

const sameLogin = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

const hasLabel = (issue: Issue, label: string): boolean =>
  issue.labels.some((name) => sameLogin(name, label));

const phrases = (all: readonly string[]): string =>
  all.length <= 1
    ? (all[0] ?? "")
    : `${all.slice(0, -1).join("; ")}; and ${all.at(-1) ?? ""}`;

/** "PR #N awaiting your approval", and why, when auto-merge held it back. */
export const awaitingTitle = (
  pullRequest: number,
  reasons: readonly string[],
  label?: string,
): string => {
  const title = `PR #${String(pullRequest)} awaiting your approval`;
  if (reasons.length > 0) {
    return clip(
      `${title}: not merged automatically, as ${phrases(reasons)}.`,
      200,
    );
  }
  return label === undefined ? title : `${title} (${label})`;
};

/** "Approve and merge" for the head `sha`: it merges no other (W1-6). */
const approveAndMerge = (sha: string) => ({
  id: mergeActions.approveAndMerge,
  label: "Approve and merge",
  sha,
});

/**
 * The head a Notice's "Approve and merge" was offered for: null when it
 * offers none, undefined when it names no head (raised before W1-6).
 */
const approvedHead = (notice: NoticeRecord): string | null | undefined => {
  const action = notice.actions.find(
    ({ id }) => id === mergeActions.approveAndMerge,
  );
  return action === undefined ? null : action.sha;
};

const short = (sha: string): string => sha.slice(0, 7);

/** The policy for one issue: its Floor's, unless a label overrides it. */
interface IssuePolicy {
  readonly policy: MergePolicy;
  /** The label that set it, if one did. */
  readonly label?: string;
  /** Why a label was not followed, if one was not. */
  readonly ignored?: string;
  /** Why it goes to the Owner on a Floor that merges automatically. */
  readonly because?: string;
}

/** Why a chat request's issue is not merged automatically (P2-3). */
export const chatIssueReason = "it was filed for a chat request";

export function createMergeFlow(options: MergeFlowOptions): MergeFlow {
  const { floors, github, notices, events, reviews } = options;
  const pipeline = options.pipeline ?? createPipeline({ github, events });
  const now = options.now ?? (() => new Date());
  const wait = { ...defaultCiWait, ...options.ci };
  const sleep =
    options.sleep ??
    ((ms: number, signal: AbortSignal) =>
      delay(ms, undefined, { signal }).then(() => undefined));

  /** Raises a Notice unless the same one is open on the Floor already. */
  const raiseOnce = async (
    notice: Parameters<Notices["raise"]>[0] & { readonly floorId: string },
    same: (open: NoticeRecord) => boolean,
  ): Promise<void> => {
    const open = await notices.open({ floorId: notice.floorId });
    if (!open.some(same)) {
      await notices.raise(notice);
    }
  };

  const policyOf = async (
    floor: FloorRecord,
    client: RepositoryClient,
    issue: Issue,
  ): Promise<IssuePolicy> => {
    const manual = mergePolicyOverrides.send_to_me;
    const auto = mergePolicyOverrides.auto_merge;
    if (hasLabel(issue, manual)) {
      return { policy: "send_to_me", label: manual };
    }
    const autoLabel = hasLabel(issue, auto);
    if (autoLabel) {
      const owner = await options.ownerLogin();
      const added = (await client.labelEvents(issue.number))
        .filter(
          ({ action, label }) => action === "labeled" && sameLogin(label, auto),
        )
        .at(-1);
      // The Owner's own label waives the Owner's approval, a chat
      // request's issue's too: only the Owner may.
      if (added !== undefined && sameLogin(added.actor, owner)) {
        return { policy: "auto_merge", label: auto };
      }
    }
    const ignored = autoLabel
      ? { ignored: `the ${auto} label was not added by you` }
      : {};
    if (await options.batches.chatIssue(floor.id, issue.number)) {
      return {
        policy: "send_to_me",
        ...(floor.mergePolicy === "auto_merge"
          ? { because: chatIssueReason }
          : {}),
        ...ignored,
      };
    }
    if (autoLabel) {
      return floor.mergePolicy === "auto_merge"
        ? { policy: "auto_merge" }
        : { policy: "send_to_me", ...ignored };
    }
    return { policy: floor.mergePolicy };
  };

  /** The latest pull request from `branch`, open or not. */
  const pullRequestOf = async (
    client: RepositoryClient,
    branch: string,
  ): Promise<PullRequest | undefined> =>
    (await client.listPullRequests({ state: "all", head: branch })).sort(
      (a, b) => b.number - a.number,
    )[0];

  /**
   * The issues of a Batch handed over "in one PR", once every one is ready
   * to merge (or closed); undefined while any is still on its way, or is
   * handed to the Owner, which holds the whole pull request and says so.
   */
  const batchReady = async (
    floor: FloorRecord,
    client: RepositoryClient,
    batch: BatchBranch,
  ): Promise<Issue[] | undefined> => {
    const issues: Issue[] = [];
    const waiting: number[] = [];
    for (const { issue: number } of batch.issues) {
      const each = await client.getIssue(number);
      if (each.state === "closed") {
        continue;
      }
      const stage = positionOf(each.number, each.labels).stage;
      if (stage === "needs-human") {
        const title = `Batch ${String(batch.batchId)}'s pull request is held: #${String(each.number)} is handed to you, and its issues merge together.`;
        await raiseOnce(
          {
            kind: "action",
            title,
            floorId: floor.id,
            issue: { number: each.number, url: each.htmlUrl },
          },
          (open) => open.title === title,
        );
        return undefined;
      }
      if (stage !== "ready-to-merge") {
        waiting.push(each.number);
      }
      issues.push(each);
    }
    return waiting.length > 0 ? undefined : issues;
  };

  /**
   * The policy for a Batch's one pull request: each issue's, and the
   * Owner's whenever any one of them goes to the Owner.
   */
  const batchPolicyOf = async (
    floor: FloorRecord,
    client: RepositoryClient,
    issues: readonly Issue[],
  ): Promise<IssuePolicy> => {
    const each = await Promise.all(
      issues.map((issue) => policyOf(floor, client, issue)),
    );
    const toOwner = each.find(({ policy }) => policy === "send_to_me");
    if (toOwner === undefined) {
      return { policy: "auto_merge" };
    }
    // The label of an issue that sends it to the Owner, such as `ai-office:manual`.
    const label = each.find(
      (policy) => policy.policy === "send_to_me" && policy.label !== undefined,
    )?.label;
    const ignored = each.find(
      (policy) => policy.ignored !== undefined,
    )?.ignored;
    const because = each.find(
      (policy) => policy.because !== undefined,
    )?.because;
    return {
      policy: "send_to_me",
      ...(label === undefined ? {} : { label }),
      ...(ignored === undefined ? {} : { ignored }),
      ...(because === undefined ? {} : { because }),
    };
  };

  /** Where CI is on the pull request's head now. */
  const ciNow = async (
    client: RepositoryClient,
    pullRequest: PullRequest,
  ): Promise<CiState> =>
    ciOf(
      await client.listCheckRuns(pullRequest.head.sha),
      await client.requiredChecks(pullRequest.base),
    );

  /** Token Caps reached on the issue's work, from the Activity Feed. */
  const capsReached = async (
    floor: FloorRecord,
    issue: number,
  ): Promise<CapReachedOnIssue[]> => {
    const team = await options.agents.list(floor.id);
    return (
      await events.history({
        filter: { floorId: floor.id, issue, types: ["cap.reached"] },
        limit: 200,
      })
    ).flatMap(({ event }) => {
      if (event.type !== "cap.reached") {
        return [];
      }
      const name = team.find(({ id }) => id === event.agentId)?.name;
      return [
        {
          period: event.period,
          ...(name === undefined ? {} : { agentName: name }),
        },
      ];
    });
  };

  /**
   * Why the files the pull request changes at its head send it to the
   * Owner, if they do: GitHub lists the files of whatever the head is, so
   * a head that moved as they were listed counts too.
   */
  const changesOwnerOnly = async (
    client: RepositoryClient,
    pullRequest: PullRequest,
  ): Promise<string[]> => {
    const files = await client.listPullRequestFiles(pullRequest.number);
    const { head } = await client.getPullRequest(pullRequest.number);
    return [
      ...ownerOnly(files),
      ...(head.sha === pullRequest.head.sha
        ? []
        : ["its head commit changed as it was being checked"]),
    ];
  };

  /**
   * What the gate makes of the pull request at its head, CI aside: why it
   * may not merge automatically, and whether its reviewers should review
   * it again instead, when all that stands in the way is commits pushed
   * after they approved it and the Review Loop has a round left for them.
   */
  const judged = async (
    floor: FloorRecord,
    client: RepositoryClient,
    issues: readonly Issue[],
    pullRequest: PullRequest,
    batch?: BatchBranch,
  ): Promise<{
    readonly reasons: string[];
    /** The issues whose reviewers should review it again. */
    readonly reviewAgain: Issue[];
  }> => {
    const team = await options.agents.list(floor.id);
    const head = pullRequest.head.sha;
    const common = await changesOwnerOnly(client, pullRequest);
    const reasons = [...common];
    const again: Issue[] = [];
    let onlyAgain = common.length === 0;
    for (const issue of issues) {
      const verdicts = await reviews.verdicts(floor.id, issue.number);
      const last = Math.max(0, ...verdicts.map(({ round }) => round));
      // On a shared branch, an issue's reviewers approved its own work as
      // it stood when the next issue began, unless they approved the head.
      const end =
        batch === undefined ||
        verdicts.some(
          (verdict) => verdict.round === last && verdict.headSha === head,
        )
          ? undefined
          : endOf(batch, issue.number);
      const input = {
        head: end ?? head,
        reviewers: floor.requiredReviewerAgentIds.map((id) => ({
          id,
          name: team.find((agent) => agent.id === id)?.name ?? id,
        })),
        verdicts,
        reports: await reviews.qaReports(floor.id, issue.number),
        roundCap: floor.roundCap,
        capsReached: await capsReached(floor, issue.number),
      };
      const held = heldBack(input);
      reasons.push(
        ...(batch === undefined
          ? held
          : held.map((reason) => `${reason} (#${String(issue.number)})`)),
      );
      if (held.length === 0) {
        continue;
      }
      if (
        held.length === 1 &&
        approvedBefore(input).length > 0 &&
        roundLeft(input)
      ) {
        again.push(issue);
      } else {
        onlyAgain = false;
      }
    }
    return { reasons, reviewAgain: onlyAgain ? again : [] };
  };

  /**
   * Sends the issue back to its reviewers (P1-1), with the Handoff that
   * brought it to ready-to-merge: they review the head, the commits
   * pushed since they approved it included, and an approval brings it
   * back here.
   */
  const reviewAgain = async (floor: FloorRecord, issue: Issue) => {
    const handed = await reviews.latestHandoff(
      floor.id,
      issue.number,
      "ready-to-merge",
    );
    if (handed !== undefined) {
      await reviews.recordHandoff({
        ...handed,
        stage: "needs-review",
        createdAt: now(),
      });
    }
    await pipeline.move(floor, issue.number, "needs-review");
    await options.queue?.enqueue({
      floorId: floor.id,
      issue: issue.number,
      stage: "needs-review",
    });
  };

  /** Hands the pull request to the Owner: "PR #N awaiting your approval". */
  const sendToOwner = async (input: {
    readonly floor: FloorRecord;
    readonly issue: Issue;
    /** Every issue the pull request closes, when it is a Batch's one. */
    readonly issues?: readonly Issue[];
    readonly pullRequest: PullRequest;
    readonly reasons: readonly string[];
    readonly label?: string | undefined;
    readonly ci: CiState;
  }): Promise<void> => {
    const { floor, issue, pullRequest } = input;
    const head = pullRequest.head.sha;
    // One Notice per head: the Owner is asked about this one, and one
    // raised for another head no longer stands (W1-6).
    const asking = (await notices.open({ floorId: floor.id })).filter(
      (open) =>
        open.pullRequest?.number === pullRequest.number &&
        approvedHead(open) !== null,
    );
    if (asking.some((open) => approvedHead(open) === head)) {
      return;
    }
    for (const stale of asking) {
      // Being acted on, it closes itself.
      await notices.dismiss(stale.id).catch(() => undefined);
    }
    const run = ciRunOf(input.ci);
    const verdicts: VerdictRecord[] = [];
    const reports: QaReportRecord[] = [];
    for (const { number } of input.issues ?? [issue]) {
      verdicts.push(...(await reviews.verdicts(floor.id, number)));
      reports.push(...(await reviews.qaReports(floor.id, number)));
    }
    await notices.raise({
      kind: "action",
      title: awaitingTitle(pullRequest.number, input.reasons, input.label),
      floorId: floor.id,
      issue: { number: issue.number, url: issue.htmlUrl },
      pullRequest: { number: pullRequest.number, url: pullRequest.htmlUrl },
      ...(run === undefined || !/^https?:\/\//.test(run.htmlUrl)
        ? {}
        : { ciRunUrl: run.htmlUrl }),
      links: everyRoundLinks(verdicts, reports, pullRequest.htmlUrl),
      actions: [approveAndMerge(head)],
    });
  };

  /** Records a merge: an event, and an info Notice saying who merged it. */
  const merged = async (input: {
    readonly floorId: string;
    readonly issue: { readonly number: number; readonly url: string };
    /** Every issue it closes, for a Batch's one pull request. */
    readonly issues?: readonly number[];
    readonly pullRequest: { readonly number: number; readonly url: string };
    readonly sha: string;
    readonly by: "app" | "owner";
  }): Promise<void> => {
    const { floorId, issue, pullRequest, sha, by } = input;
    for (const number of input.issues ?? [issue.number]) {
      await events.publish({
        type: "pull_request.merged",
        version: 1,
        floorId,
        issue: number,
        pullRequest: pullRequest.number,
        url: pullRequest.url,
        sha,
        by,
      });
    }
    await notices.raise({
      kind: "info",
      title:
        by === "app"
          ? `PR #${String(pullRequest.number)} merged automatically: every required reviewer approved and CI passed.`
          : `PR #${String(pullRequest.number)} merged, as you approved it.`,
      floorId,
      issue,
      pullRequest,
    });
  };

  /** Why GitHub would not merge it, as a phrase for the Notice. */
  const refusal = (error: unknown): string => {
    if (error instanceof GitHubError && error.status === 409) {
      return "its head commit changed as it was being merged";
    }
    const message = (error instanceof Error ? error.message : String(error))
      .replaceAll(/\s+/g, " ")
      .trim();
    return `GitHub refused to merge it (${clip(message, maxReason)})`;
  };

  /** What wakes each gate waiting for CI, by Floor. */
  const waiting = new Map<string, Set<() => void>>();

  /**
   * Sleeps until the next look at CI, or until a webhook says CI changed
   * on the Floor's repository.
   */
  const nap = async (floorId: string, signal: AbortSignal): Promise<void> => {
    const early = new AbortController();
    const wake = () => {
      early.abort();
    };
    const wakers = waiting.get(floorId) ?? new Set();
    waiting.set(floorId, wakers.add(wake));
    try {
      await sleep(wait.pollMs, AbortSignal.any([signal, early.signal]));
    } catch (error) {
      if (signal.aborted || !early.signal.aborted) {
        throw error;
      }
    } finally {
      wakers.delete(wake);
      if (wakers.size === 0) {
        waiting.delete(floorId);
      }
    }
  };

  /**
   * Waits for CI on the pull request's head to finish, up to the timeout,
   * and for a first check to start, up to its own. Each look reads the
   * pull request afresh, so a new head is waited for too.
   */
  const settled = async (
    floorId: string,
    client: RepositoryClient,
    number: number,
    signal: AbortSignal,
  ): Promise<{ pullRequest: PullRequest; ci: CiState; waited: number }> => {
    const started = now().getTime();
    for (;;) {
      const pullRequest = await client.getPullRequest(number);
      const ci = await ciNow(client, pullRequest);
      const waited = now().getTime() - started;
      const waiting =
        (ci.state === "pending" && waited < wait.timeoutMs) ||
        (ci.state === "none" && waited < wait.startMs);
      if (!waiting || pullRequest.state !== "open") {
        return { pullRequest, ci, waited: Math.round(waited / 60_000) };
      }
      await nap(floorId, signal);
    }
  };

  const execute: ExecuteWork = async (work: WorkItem, signal: AbortSignal) => {
    if (work.stage !== "ready-to-merge") {
      throw new Error(
        `The Merge Policy works ready-to-merge, not ${work.stage}.`,
      );
    }
    const floor = await floors.get(work.floorId);
    // An archived Floor's work stops (FR-9).
    if (floor?.archivedAt !== null) {
      return "failed";
    }
    const client = github.repository(floor.repository);
    const issue = await client.getIssue(work.issue);
    if (positionOf(issue.number, issue.labels).stage !== "ready-to-merge") {
      // It moved (to the Owner, say) since it was queued: nothing to do.
      return "finished";
    }
    // A Batch's one pull request waits for every issue (ADR 0010).
    const batch = await options.batchBranches?.of(floor.id, issue.number);
    const issues =
      batch === undefined ? [issue] : await batchReady(floor, client, batch);
    if (issues === undefined) {
      return "finished";
    }
    const together =
      batch === undefined ? {} : { issues: issues.map(({ number }) => number) };
    const pullRequest = await pullRequestOf(
      client,
      batch?.branch ?? issueBranch(issue.number, issue.title),
    );
    if (pullRequest?.merged === true) {
      // Merged already: by the App before a restart, or by the Owner.
      return "finished";
    }
    if (pullRequest?.state !== "open") {
      const title = `#${String(issue.number)} is ready to merge, but has no open pull request.`;
      await raiseOnce(
        {
          kind: "action",
          title,
          floorId: floor.id,
          issue: { number: issue.number, url: issue.htmlUrl },
        },
        (open) => open.title === title,
      );
      return "failed";
    }
    if (batch !== undefined) {
      // Its body, written again: every issue's Evidence is in now.
      await writeBatchPullRequest({
        client,
        reviews,
        floorId: floor.id,
        base: floor.defaultBranch,
        batch,
      });
    }
    const policy =
      batch === undefined
        ? await policyOf(floor, client, issue)
        : await batchPolicyOf(floor, client, issues);

    if (policy.policy === "send_to_me") {
      await sendToOwner({
        floor,
        issue,
        issues,
        pullRequest,
        reasons: [policy.ignored, policy.because].filter(
          (reason) => reason !== undefined,
        ),
        label: policy.label,
        ci: await ciNow(client, pullRequest),
      });
      return "finished";
    }

    // Auto-merge, if the gate lets it.
    const gate = await judged(floor, client, issues, pullRequest, batch);
    // One issue at a time, so no two fixes are ever pushed to one branch
    // at once: the rest are judged again when it is back (ADR 0010).
    const [again] = gate.reviewAgain;
    if (again !== undefined) {
      await reviewAgain(floor, again);
      return "finished";
    }
    const { reasons } = gate;
    if (reasons.length > 0) {
      // Held back whatever CI says: the Owner hears now, not after CI.
      const ci = await ciNow(client, pullRequest);
      const failed = ci.state === "failed" ? ciHeldBack(ci, 0) : undefined;
      await sendToOwner({
        floor,
        issue,
        issues,
        pullRequest,
        reasons: failed === undefined ? reasons : [...reasons, failed],
        ci,
      });
      return "finished";
    }
    const checked = await settled(floor.id, client, pullRequest.number, signal);
    if (checked.pullRequest.state !== "open") {
      return "finished";
    }
    // A head pushed while CI ran is judged afresh: approved, or reviewed.
    const atHead =
      checked.pullRequest.head.sha === pullRequest.head.sha
        ? gate
        : await judged(floor, client, issues, checked.pullRequest, batch);
    const [againAtHead] = atHead.reviewAgain;
    if (againAtHead !== undefined) {
      await reviewAgain(floor, againAtHead);
      return "finished";
    }
    const ci = ciHeldBack(checked.ci, checked.waited);
    const unmet = ci === undefined ? atHead.reasons : [...atHead.reasons, ci];
    if (unmet.length > 0) {
      await sendToOwner({
        floor,
        issue,
        issues,
        pullRequest: checked.pullRequest,
        reasons: unmet,
        ci: checked.ci,
      });
      return "finished";
    }
    let sha: string;
    try {
      // Only the head CI passed on: a later push is checked first.
      ({ sha } = await client.mergePullRequest(checked.pullRequest.number, {
        method: mergeMethod,
        sha: checked.pullRequest.head.sha,
      }));
    } catch (error) {
      await sendToOwner({
        floor,
        issue,
        issues,
        pullRequest: checked.pullRequest,
        reasons: [refusal(error)],
        ci: checked.ci,
      });
      return "finished";
    }
    await merged({
      floorId: floor.id,
      issue: { number: issue.number, url: issue.htmlUrl },
      ...together,
      pullRequest: {
        number: checked.pullRequest.number,
        url: checked.pullRequest.htmlUrl,
      },
      sha,
      by: "app",
    });
    return "finished";
  };

  /**
   * The branch has moved on from the head the Owner was asked about: a new
   * Notice asks about its head, and the old one is closed, unmerged.
   */
  const askAgain = async (
    notice: NoticeRecord & {
      readonly floorId: string;
      readonly issue: NonNullable<NoticeRecord["issue"]>;
    },
    current: PullRequest,
    asked: string | undefined,
  ): Promise<never> => {
    const head = current.head.sha;
    await notices.raise({
      kind: "action",
      title: `PR #${String(current.number)} awaiting your approval: its branch moved on to ${short(head)} since you were last asked.`,
      floorId: notice.floorId,
      issue: notice.issue,
      pullRequest: { number: current.number, url: current.htmlUrl },
      links: [...notice.links],
      actions: [approveAndMerge(head)],
    });
    throw new NoticeOutdatedError(
      `Nothing was merged: PR #${String(current.number)}'s branch has moved on to ${short(head)} since ${asked === undefined ? "you were asked" : `you were asked about ${short(asked)}`}. A new Notice asks you about its head.`,
    );
  };

  // "Approve and merge": the App merges it, as the Owner approved it, and
  // only the head the Owner was asked about (W1-6).
  const stop = notices.registerAction(
    mergeActions.approveAndMerge,
    async (notice) => {
      const floor =
        notice.floorId === null ? undefined : await floors.get(notice.floorId);
      const { pullRequest, issue } = notice;
      if (floor === undefined || pullRequest === null || issue === null) {
        throw new Error("The Notice names no pull request on a Floor.");
      }
      const client = github.repository(floor.repository);
      const current = await client.getPullRequest(pullRequest.number);
      if (current.merged) {
        // Merged on GitHub already: nothing left to do.
        return;
      }
      if (current.state !== "open") {
        throw new Error(
          `PR #${String(current.number)} was closed without being merged.`,
        );
      }
      // A Batch's one pull request merges only with every issue ready (ADR 0010).
      const batch = await options.batchBranches?.of(floor.id, issue.number);
      const numbers = batch?.issues.map((each) => each.issue) ?? [issue.number];
      for (const number of numbers) {
        const now = await client.getIssue(number);
        const stage = positionOf(number, now.labels).stage;
        if (
          stage !== "ready-to-merge" &&
          !(number !== issue.number && now.state === "closed")
        ) {
          throw new NoticeOutdatedError(
            `Nothing was merged: #${String(number)} has left ready-to-merge${stage === null ? "" : ` (it is at ${stage})`} since you were asked, so this approval is for work that has moved on.`,
          );
        }
      }
      const asked = approvedHead(notice) ?? undefined;
      const outdated = { ...notice, floorId: floor.id, issue };
      if (asked !== current.head.sha) {
        return askAgain(outdated, current, asked);
      }
      let sha: string;
      try {
        // GitHub refuses it if the head moved since it was read.
        ({ sha } = await client.mergePullRequest(current.number, {
          method: mergeMethod,
          sha: asked,
        }));
      } catch (error) {
        if (error instanceof GitHubError && error.status === 409) {
          const moved = await client.getPullRequest(current.number);
          if (moved.head.sha !== asked && !moved.merged) {
            return askAgain(outdated, moved, asked);
          }
        }
        throw error;
      }
      await merged({
        floorId: floor.id,
        issue,
        ...(batch === undefined ? {} : { issues: numbers }),
        pullRequest: { number: current.number, url: current.htmlUrl },
        sha,
        by: "owner",
      });
    },
  );

  return {
    execute,
    stop,
    ciChanged(floorId) {
      for (const wake of waiting.get(floorId) ?? []) {
        wake();
      }
    },
  };
}
