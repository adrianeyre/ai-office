import { subjectOf, type EventBus, type EventType } from "@ai-office/events";
import {
  GitHubNotConfiguredError,
  isGitHubError,
  type Branch,
  type BranchComparison,
  type CheckRun,
  type Commit,
  type GitHubApp,
  type Issue,
  type PullRequest,
  type RepositoryClient,
} from "@ai-office/github";
import {
  floorErrorCodes,
  isPipelineStage,
  type PipelineStage,
  likelyToConflict,
  managerRole,
  officeBranchOf,
  officeBranchPrefix,
  type BranchCiStatus,
  type BranchCommit,
  type BranchLane,
  type BranchWork,
  type FloorBranches,
  type OfficeBranch,
} from "@ai-office/shared";

import type { AgentRecord, AgentStore } from "../agents/store.ts";
import { FloorError } from "../floors/errors.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import type { BatchStore } from "../batches/store.ts";
import type { GrillingStore } from "../grilling/store.ts";
import type { RoleStore } from "../roles/store.ts";
import type { WorkItem, WorkQueueStore } from "../work/store.ts";

// A Floor's AI Office branches, for the Branches page: each branch AI
// Office pushed for an issue or a Grilling Session, as a lane off the
// Floor's default branch, with how far ahead and behind it is, its own
// commits, its issue, open pull request and CI, read through the GitHub
// App, and the Agent working on it (or the stage it waits in), read from
// the work queue. It only reads: nothing here changes the repository.
//
// GitHub is asked sparingly (PRD §11: GitHub rate limits). What it said of
// a Floor is kept for `freshForMs` (a minute), so nothing that asks on a
// timer reads GitHub more often than that; it is read again sooner only
// once the Floor's repository has changed (a webhook's `repository.changed`,
// or a branch AI Office pushed or a pull request it opened or merged), and
// then no sooner than `minIntervalMs` after the last time, so a burst of
// changes is read once. Callers at the same time share one read. A
// comparison is kept by its two commits, which it never outlives; a
// finished CI result by its commit, until a check changes; an issue for
// five minutes. The Agents and stages are read afresh every time, from the
// database.

/** A Floor's AI Office branches, from GitHub and the work queue. */
export interface Branches {
  /**
   * A Floor in use's branches. Throws a `FloorError`: the Floor is
   * unknown or archived, the GitHub App is not configured, or GitHub
   * could not be asked.
   */
  floorBranches(floorId: string): Promise<FloorBranches>;
  /**
   * The Floor's repository changed (`change`, when a webhook said what):
   * its branches are read from GitHub again next time.
   */
  changed(floorId: string, change?: string): void;
}

export interface BranchesOptions {
  readonly floors: Pick<FloorStore, "get">;
  readonly agents: Pick<AgentStore, "list">;
  readonly roles: Pick<RoleStore, "get">;
  readonly work: Pick<WorkQueueStore, "active">;
  readonly grilling: Pick<GrillingStore, "get">;
  /** The Batches, whose one-pull-request branches are lanes too (ADR 0010). */
  readonly batches?: Pick<BatchStore, "get"> | undefined;
  /** The GitHub App; absent until the Owner has configured it. */
  readonly github?: GitHubApp | undefined;
  /** Where the changes that make a Floor's branches stale are heard. */
  readonly events?: Pick<EventBus, "subscribe">;
  readonly now?: () => Date;
  /** Waits `ms`; a timer unless a test says otherwise. */
  readonly wait?: (ms: number) => Promise<void>;
  /** How long what GitHub said is kept; a minute by default. */
  readonly freshForMs?: number;
  /** The least time between two reads of a Floor; 5 seconds by default. */
  readonly minIntervalMs?: number;
}

/** The events after which a Floor's branches are read from GitHub again. */
export const branchChangeEventTypes: readonly EventType[] = [
  "repository.changed",
  "branch.pushed",
  "pull_request.opened",
  "pull_request.merged",
  "grilling.documents_written",
  "grilling.pull_request_opened",
];

/** How many calls one Floor's read makes to GitHub at once. */
const concurrentCalls = 4;

/** How long an issue's title and labels are kept. */
const issueKeptMs = 5 * 60_000;

/** A conclusion that lets a pull request merge, as the Merge Policy's gate reads them. */
const passing = new Set(["success", "neutral", "skipped"]);

/** A commit's CI, from the check runs on it. */
export function ciStatusOf(runs: readonly CheckRun[]): BranchCiStatus {
  if (runs.length === 0) {
    return "none";
  }
  if (runs.some(({ status }) => status !== "completed")) {
    return "pending";
  }
  return runs.every(
    ({ conclusion }) => conclusion !== null && passing.has(conclusion),
  )
    ? "success"
    : "failure";
}

/** A commit as a lane shows it: its subject, and the Agent its trailer names. */
export function branchCommitOf(commit: Commit): BranchCommit {
  const [subject = ""] = commit.message.split("\n", 1);
  // A commit GitHub gives no time for is drawn as the oldest.
  const authoredAt = Date.parse(commit.authoredAt);
  // `Agent: Ada (coder, Claude claude-opus-5-5)` (FR-69); the last wins.
  const trailers = [...commit.message.matchAll(/^Agent:[ \t]*(.+)$/gm)];
  return {
    sha: commit.sha,
    message: subject.trim(),
    author: commit.author,
    agent: trailers.at(-1)?.[1]?.trim() ?? null,
    authoredAt: new Date(
      Number.isNaN(authoredAt) ? 0 : authoredAt,
    ).toISOString(),
    url: commit.htmlUrl,
  };
}

/** What GitHub says of one lane. */
interface GitHubLane {
  readonly branch: Branch;
  readonly office: OfficeBranch;
  readonly comparison: BranchComparison;
  readonly ci: BranchCiStatus;
  readonly pullRequest: PullRequest | undefined;
  /** Undefined for a Grilling Session's, or an issue GitHub does not have. */
  readonly issue: Issue | undefined;
  /**
   * A one-pull-request Batch's issues, in the order the Owner named them,
   * each as GitHub has it (undefined when it has none); empty otherwise.
   */
  readonly batchIssues: readonly {
    readonly number: number;
    readonly issue: Issue | undefined;
  }[];
}

/** What GitHub says of a Floor's branches, at one time. */
interface Snapshot {
  readonly defaultBranch: Branch;
  readonly htmlUrl: string;
  readonly lanes: readonly GitHubLane[];
  readonly fetchedAt: Date;
}

/** What is kept of one Floor between reads. */
interface FloorCache {
  snapshot: Snapshot | undefined;
  /** When GitHub was last asked, whether it answered or not. */
  askedAt: number;
  /** The repository changed since `snapshot` was asked for. */
  stale: boolean;
  pending: Promise<Snapshot> | undefined;
  /** By `base...head` commits. */
  comparisons: Map<string, BranchComparison>;
  /** Finished CI, by commit. */
  ci: Map<string, BranchCiStatus>;
  /** The repository's page on GitHub, once known. */
  htmlUrl: string | undefined;
  /** By number, with when it was read; undefined when GitHub has none. */
  issues: Map<number, { issue: Issue | undefined; at: number }>;
}

/** `work` on each of `items`, at most `limit` at a time, in order. */
async function mapLimited<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as Item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * Where one of a one-pull-request Batch's issues stands: closed, the stage
 * its work in the queue is at, else its pipeline label; null before it
 * starts.
 */
export function batchIssueStage(
  number: number,
  issue: Pick<Issue, "state" | "labels"> | undefined,
  items: readonly Pick<WorkItem, "issue" | "stage" | "status">[],
): PipelineStage | "closed" | null {
  if (issue?.state === "closed") {
    return "closed";
  }
  const onIssue = items.filter((item) => item.issue === number);
  return (
    onIssue.find((item) => item.status === "running")?.stage ??
    onIssue.find((item) => item.status === "queued")?.stage ??
    issue?.labels.map((label) => label.toLowerCase()).find(isPipelineStage) ??
    null
  );
}

export function createBranches(options: BranchesOptions): Branches {
  const { floors, agents, roles, work, grilling } = options;
  const now = options.now ?? (() => new Date());
  const wait =
    options.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const freshForMs = options.freshForMs ?? 60_000;
  const minIntervalMs = options.minIntervalMs ?? 5000;
  const caches = new Map<string, FloorCache>();

  const cacheOf = (floorId: string): FloorCache => {
    let cache = caches.get(floorId);
    if (cache === undefined) {
      cache = {
        snapshot: undefined,
        askedAt: Number.NEGATIVE_INFINITY,
        stale: false,
        pending: undefined,
        comparisons: new Map(),
        ci: new Map(),
        htmlUrl: undefined,
        issues: new Map(),
      };
      caches.set(floorId, cache);
    }
    return cache;
  };

  const changed = (floorId: string, change?: string): void => {
    const cache = caches.get(floorId);
    if (cache === undefined) {
      return;
    }
    cache.stale = true;
    if (change === "check_run" || change === "check_suite") {
      cache.ci.clear();
    }
  };

  options.events?.subscribe(
    ({ event }) => {
      const { floorId } = subjectOf(event);
      if (floorId !== null) {
        changed(
          floorId,
          event.type === "repository.changed" ? event.change : undefined,
        );
      }
    },
    { types: branchChangeEventTypes },
  );

  const onGitHub = async <Result>(call: () => Promise<Result>) => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof FloorError) {
        throw error;
      }
      if (error instanceof GitHubNotConfiguredError) {
        throw new FloorError(
          floorErrorCodes.githubNotConfigured,
          error.message,
        );
      }
      throw new FloorError(
        floorErrorCodes.githubUnavailable,
        `GitHub could not be asked: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };

  /** One lane from GitHub; undefined when its branch went meanwhile. */
  const readLane = async (
    client: RepositoryClient,
    cache: FloorCache,
    trunk: Branch,
    branch: Branch,
    office: OfficeBranch,
    pullRequests: readonly PullRequest[],
  ): Promise<GitHubLane | undefined> => {
    const key = `${trunk.sha}...${branch.sha}`;
    let comparison = cache.comparisons.get(key);
    if (comparison === undefined) {
      try {
        comparison = await client.compareBranches(trunk.sha, branch.sha);
      } catch (error) {
        if (isGitHubError(error, 404)) {
          return undefined;
        }
        throw error;
      }
      cache.comparisons.set(key, comparison);
    }
    let ci = cache.ci.get(branch.sha);
    if (ci === undefined) {
      ci = ciStatusOf(await client.listCheckRuns(branch.sha));
      if (ci === "success" || ci === "failure") {
        cache.ci.set(branch.sha, ci);
      }
    }
    /** An issue, kept a while: undefined when GitHub has none. */
    const issueOf = async (number: number): Promise<Issue | undefined> => {
      const kept = cache.issues.get(number);
      if (kept !== undefined && now().getTime() - kept.at < issueKeptMs) {
        return kept.issue;
      }
      let read: Issue | undefined;
      try {
        read = await client.getIssue(number);
      } catch (error) {
        if (!isGitHubError(error, 404)) {
          throw error;
        }
      }
      cache.issues.set(number, { issue: read, at: now().getTime() });
      return read;
    };
    const issue =
      office.kind === "issue" ? await issueOf(office.issue) : undefined;
    const batch =
      office.kind === "batch"
        ? await options.batches?.get(office.batchId)
        : undefined;
    const batchIssues = await Promise.all(
      (batch?.issues ?? []).map(async (number) => ({
        number,
        issue: await issueOf(number),
      })),
    );
    return {
      branch,
      office,
      comparison,
      ci,
      pullRequest: pullRequests.find(
        (pull) => pull.state === "open" && pull.head.name === branch.name,
      ),
      issue,
      batchIssues,
    };
  };

  const read = async (
    floor: FloorRecord,
    cache: FloorCache,
  ): Promise<Snapshot> => {
    const github = options.github;
    if (github === undefined) {
      throw new FloorError(
        floorErrorCodes.githubNotConfigured,
        new GitHubNotConfiguredError().message,
      );
    }
    const client = github.repository(floor.repository);
    return onGitHub(async () => {
      const [trunk, branches, pullRequests, htmlUrl] = await Promise.all([
        client.getBranch(floor.defaultBranch),
        client.listBranches(officeBranchPrefix),
        client.listPullRequests({ state: "open" }),
        cache.htmlUrl ?? client.get().then((repository) => repository.htmlUrl),
      ]);
      cache.htmlUrl = htmlUrl;
      if (trunk === undefined) {
        throw new FloorError(
          floorErrorCodes.branchNotFound,
          `The Floor's default branch, ${floor.defaultBranch}, is not on GitHub.`,
        );
      }
      const office = branches.flatMap((branch) => {
        const of = officeBranchOf(branch.name);
        return of === undefined ? [] : [{ branch, of }];
      });
      const lanes = (
        await mapLimited(office, concurrentCalls, ({ branch, of }) =>
          readLane(client, cache, trunk, branch, of, pullRequests),
        )
      ).filter((lane) => lane !== undefined);
      // Keep only what the lanes still need.
      const needed = new Set(
        lanes.map(({ branch }) => `${trunk.sha}...${branch.sha}`),
      );
      for (const key of cache.comparisons.keys()) {
        if (!needed.has(key)) {
          cache.comparisons.delete(key);
        }
      }
      const heads = new Set(lanes.map(({ branch }) => branch.sha));
      for (const sha of cache.ci.keys()) {
        if (!heads.has(sha)) {
          cache.ci.delete(sha);
        }
      }
      return {
        defaultBranch: trunk,
        htmlUrl,
        lanes,
        fetchedAt: now(),
      };
    });
  };

  /** What GitHub says of the Floor: kept, or read again. */
  const snapshotOf = (floor: FloorRecord): Promise<Snapshot> => {
    const cache = cacheOf(floor.id);
    if (cache.pending !== undefined) {
      return cache.pending;
    }
    const { snapshot } = cache;
    if (
      snapshot !== undefined &&
      !cache.stale &&
      now().getTime() - snapshot.fetchedAt.getTime() < freshForMs
    ) {
      return Promise.resolve(snapshot);
    }
    const pending = (async () => {
      const since = now().getTime() - cache.askedAt;
      if (since < minIntervalMs) {
        await wait(minIntervalMs - since);
      }
      // A change from here on is not in what GitHub answers.
      cache.stale = false;
      cache.askedAt = now().getTime();
      try {
        const fresh = await read(floor, cache);
        cache.snapshot = fresh;
        return fresh;
      } catch (error) {
        cache.stale = true;
        throw error;
      }
    })().finally(() => {
      cache.pending = undefined;
    });
    cache.pending = pending;
    return pending;
  };

  /**
   * Who works on an issue's branch now; or else the stage it waits in, by
   * its work in the queue, or its pipeline label on GitHub.
   */
  const issueWork = async (
    issue: number,
    labels: readonly string[],
    items: readonly WorkItem[],
    agentOf: (agentId: string) => Promise<BranchWork | undefined>,
  ): Promise<BranchWork | undefined> => {
    const onIssue = items.filter((item) => item.issue === issue);
    const agentId = onIssue.find(
      (item) => item.status === "running" && item.agentId !== null,
    )?.agentId;
    const working =
      agentId === undefined || agentId === null
        ? undefined
        : await agentOf(agentId);
    if (working !== undefined) {
      return working;
    }
    const stage =
      onIssue.find((item) => item.status === "queued")?.stage ??
      labels.map((label) => label.toLowerCase()).find(isPipelineStage);
    return stage === undefined ? undefined : { kind: "stage", stage };
  };

  return {
    changed,

    async floorBranches(floorId) {
      const floor = await floors.get(floorId);
      if (floor === undefined) {
        throw new FloorError(
          floorErrorCodes.floorNotFound,
          `There is no Floor "${floorId}".`,
        );
      }
      if (floor.archivedAt !== null) {
        throw new FloorError(
          floorErrorCodes.floorArchived,
          `The Floor "${floor.name}" is archived.`,
        );
      }
      const snapshot = await snapshotOf(floor);
      const [items, team] = await Promise.all([
        work.active(),
        agents.list(floorId),
      ]);
      const onFloor = items.filter((item) => item.floorId === floorId);
      const roleNames = new Map<string, Promise<string>>();
      const roleName = (agent: AgentRecord): Promise<string> => {
        if (agent.role === managerRole) {
          return Promise.resolve("Manager");
        }
        let name = roleNames.get(agent.role);
        if (name === undefined) {
          name = roles.get(agent.role).then((role) => role?.name ?? agent.role);
          roleNames.set(agent.role, name);
        }
        return name;
      };
      const agentOf = async (
        agentId: string,
      ): Promise<BranchWork | undefined> => {
        const agent = team.find(({ id }) => id === agentId);
        return agent === undefined
          ? undefined
          : {
              kind: "agent",
              agentId: agent.id,
              name: agent.name,
              role: agent.role,
              roleName: await roleName(agent),
              avatar: agent.avatar,
            };
      };
      const at = now();
      const lanes = await Promise.all(
        snapshot.lanes.map(async (lane): Promise<BranchLane> => {
          const { comparison, office, branch } = lane;
          const commits = comparison.commits.map(branchCommitOf);
          const mergeBase = branchCommitOf(comparison.mergeBase);
          let work: BranchWork | undefined;
          let grillingSession: BranchLane["grillingSession"] = null;
          let batch: BranchLane["batch"] = null;
          let issue = lane.issue;
          if (office.kind === "issue") {
            work = await issueWork(
              office.issue,
              lane.issue?.labels ?? [],
              onFloor,
              agentOf,
            );
          } else if (office.kind === "batch") {
            // Its issues are worked one after another: the lane is the
            // one at work now, else the first still to reach the merge.
            const issues = lane.batchIssues.map(({ number, issue: read }) => ({
              number,
              read,
              stage: batchIssueStage(number, read, onFloor),
            }));
            const current =
              issues.find(({ number }) =>
                onFloor.some(
                  (item) => item.issue === number && item.status === "running",
                ),
              ) ??
              issues.find(
                ({ stage }) => stage !== "closed" && stage !== "ready-to-merge",
              );
            batch = {
              id: office.batchId,
              issues: issues.map(({ number, stage }) => ({ number, stage })),
            };
            issue = current?.read;
            if (current !== undefined) {
              work = await issueWork(
                current.number,
                current.read?.labels ?? [],
                onFloor,
                agentOf,
              );
            }
          } else {
            const session = await grilling.get(floorId, office.sessionId);
            if (session !== undefined) {
              grillingSession = { id: session.id, topic: session.topic };
              const manager = team.find(({ role }) => role === managerRole);
              // The Manager writes its documents while the session runs.
              if (session.status === "active" && manager !== undefined) {
                work = await agentOf(manager.id);
              }
            }
          }
          return {
            name: branch.name,
            url: `${snapshot.htmlUrl}/tree/${branch.name}`,
            headSha: branch.sha,
            aheadBy: comparison.aheadBy,
            behindBy: comparison.behindBy,
            mergeBase,
            commits,
            lastCommitAt: (commits.at(-1) ?? mergeBase).authoredAt,
            likelyToConflict: likelyToConflict(
              {
                behindBy: comparison.behindBy,
                mergeBaseAt: mergeBase.authoredAt,
              },
              at,
            ),
            issue:
              issue === undefined
                ? null
                : {
                    number: issue.number,
                    title: issue.title,
                    url: issue.htmlUrl,
                  },
            batch,
            grillingSession,
            pullRequest:
              lane.pullRequest === undefined
                ? null
                : {
                    number: lane.pullRequest.number,
                    title: lane.pullRequest.title,
                    url: lane.pullRequest.htmlUrl,
                    draft: lane.pullRequest.draft,
                  },
            ci: lane.ci,
            work: work ?? null,
          };
        }),
      );
      return {
        floorId,
        repository: floor.repository,
        defaultBranch: {
          name: snapshot.defaultBranch.name,
          sha: snapshot.defaultBranch.sha,
          url: `${snapshot.htmlUrl}/tree/${snapshot.defaultBranch.name}`,
        },
        lanes: lanes.sort(
          (a, b) =>
            Date.parse(b.lastCommitAt) - Date.parse(a.lastCommitAt) ||
            a.name.localeCompare(b.name),
        ),
        fetchedAt: snapshot.fetchedAt.toISOString(),
      };
    },
  };
}
