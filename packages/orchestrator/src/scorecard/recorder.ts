import type { EventBus, OfficeEvent } from "@ai-office/events";
import type { GitHubApp } from "@ai-office/github";
import {
  managerRole,
  type IssueSize,
  type ScorecardOutcome,
  type Stage,
} from "@ai-office/shared";

import type { AgentStore } from "../agents/store.ts";
import type { FloorStore } from "../floors/store.ts";
import type { ReviewLoopStore } from "../review/store.ts";
import type { RoleStore } from "../roles/store.ts";
import type { ScorecardEntry, ScorecardStore } from "./store.ts";

// Recording how each piece of work turned out, for the Scorecard
// (Scorecards PRD, FR-126, FR-127, FR-135). A piece of work ends when its
// issue is merged (`pull_request.merged`), handed to the Owner (moved to
// `needs-human`) or closed without being merged (found by a sweep, once an
// hour, of the issues picked up in the last 30 days: GitHub's webhooks only
// say when to look). It is then recorded, a row for each Agent that worked
// a Stage of it (Contractors included, the Manager not) and each Model
// that served that Agent's requests on it:
//
// - who worked it: the Agents its events name (a sandbox started, a
//   branch pushed, a pull request opened, a review, a QA or design report,
//   a Handoff), and those whose Gateway requests name the issue;
// - its outcome, the Review Loop rounds until every reviewer approved and
//   the QA rounds that failed, from the Review Loop's own records;
// - the stalls and failures the watchdog recorded, each charged to the
//   Agent holding the work then (`manager.decision`'s `fromAgentId`);
// - for reviewers, the rounds each reviewed and its blocking comments;
// - the tokens and estimated cost of the Gateway requests naming the
//   issue, by Agent and Model, as Analytics attribute them: summed while
//   the requests are kept, from what the request history still holds;
// - the issue's Size from its triage.
//
// A piece of work that ends again (handed to the Owner, then merged) is
// recorded afresh, in place of what it had.

/** What a Gateway request naming an issue used, by Agent and Model. */
export interface IssueUsage {
  readonly agentId: string;
  /** The Model that served it; null when none did. */
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
}

/** The Gateway requests naming an issue on a Floor, added up. */
export type IssueUsageOf = (
  floorId: string,
  issue: number,
) => Promise<readonly IssueUsage[]>;

export interface ScorecardRecorderOptions {
  readonly store: ScorecardStore;
  readonly floors: Pick<FloorStore, "get" | "list">;
  readonly agents: Pick<AgentStore, "list">;
  readonly roles: Pick<RoleStore, "get">;
  readonly events: Pick<EventBus, "history" | "subscribe">;
  readonly reviews: Pick<ReviewLoopStore, "verdicts" | "qaReports">;
  /** What the request history holds of an issue's Gateway requests. */
  readonly usage?: IssueUsageOf;
  /** The issue's Size from its triage (FR-135); none when absent. */
  readonly sizeOf?: (
    floorId: string,
    issue: number,
  ) => Promise<IssueSize | null | undefined>;
  /** For the sweep for issues closed without being merged. */
  readonly github?: GitHubApp;
  readonly now?: () => Date;
  /** How often the sweep runs; an hour by default. */
  readonly sweepMs?: number;
  /** Told when recording or the sweep fails; it carries on. */
  readonly onError?: (error: unknown) => void;
}

export interface ScorecardRecorder {
  /** Records a piece of work that ended, now. */
  record(
    floorId: string,
    issue: number,
    outcome: ScorecardOutcome,
  ): Promise<ScorecardEntry[]>;
  /** Records the picked-up issues closed without being merged. */
  sweep(): Promise<number>;
  /** Records each piece of work as it ends, and sweeps every hour. */
  start(): void;
  stop(): Promise<void>;
}

/** The events that name the Agents who worked an issue. */
const workedTypes = [
  "sandbox.started",
  "branch.pushed",
  "pull_request.opened",
  "review.posted",
  "qa.reported",
  "design.reported",
  "handoff",
] as const;

/** How far back the sweep looks for issues picked up. */
const sweepDays = 30;
/** The most issues a sweep reads from GitHub on one Floor. */
const sweepLimit = 200;

/** The Agent whose work an event shows, if it shows one. */
const workerOf = (event: OfficeEvent): string | undefined => {
  switch (event.type) {
    case "sandbox.started":
    case "branch.pushed":
    case "pull_request.opened":
    case "review.posted":
    case "qa.reported":
    case "design.reported":
      return event.agentId;
    case "handoff":
      return event.fromAgentId;
    default:
      return undefined;
  }
};

/** Review Loop rounds until every reviewer of a round approved. */
const roundsToApproval = (
  verdicts: readonly { round: number; verdict: { verdict: string } }[],
): number | null => {
  const rounds = [...new Set(verdicts.map(({ round }) => round))].sort(
    (a, b) => a - b,
  );
  return (
    rounds.find((round) =>
      verdicts
        .filter((verdict) => verdict.round === round)
        .every(({ verdict }) => verdict.verdict === "approve"),
    ) ?? null
  );
};

export function createScorecardRecorder(
  options: ScorecardRecorderOptions,
): ScorecardRecorder {
  const { store, events, reviews } = options;
  const now = options.now ?? (() => new Date());
  const sweepMs = options.sweepMs ?? 60 * 60 * 1000;
  const report = (error: unknown) => options.onError?.(error);

  /** Who an Agent was: from the team, or the events that added it. */
  const agentInfo = async (
    floorId: string,
    agentIds: readonly string[],
  ): Promise<
    Map<
      string,
      {
        name: string;
        role: string;
        stage: Stage | null;
        contractor: boolean;
        model: string;
      }
    >
  > => {
    const info = new Map<
      string,
      {
        name: string;
        role: string;
        stage: Stage | null;
        contractor: boolean;
        model: string;
      }
    >();
    for (const agent of await options.agents.list(floorId)) {
      info.set(agent.id, {
        name: agent.name,
        role: agent.role,
        stage: agent.stage,
        contractor: agent.contractor !== null,
        model: agent.modelOverride ?? "",
      });
    }
    const missing = agentIds.filter((id) => !info.has(id));
    if (missing.length === 0) {
      return info;
    }
    // Removed since: as the events that added them name them.
    const added = await events.history({
      filter: { floorId, types: ["agent.created", "contractor.added"] },
      limit: 5000,
    });
    for (const id of missing) {
      const created = added.find(
        ({ event }) => event.type === "agent.created" && event.agentId === id,
      )?.event;
      if (created?.type !== "agent.created") {
        continue;
      }
      const role = await options.roles.get(created.role).catch(() => undefined);
      info.set(id, {
        name: created.name,
        role: created.role,
        stage: role?.stage ?? null,
        contractor: added.some(
          ({ event }) =>
            event.type === "contractor.added" && event.agentId === id,
        ),
        model: created.model,
      });
    }
    return info;
  };

  const record = async (
    floorId: string,
    issue: number,
    outcome: ScorecardOutcome,
  ): Promise<ScorecardEntry[]> => {
    const endedAt = now();
    const history = await events.history({
      filter: {
        floorId,
        issue,
        types: [...workedTypes, "manager.decision"],
      },
      limit: 5000,
    });
    const usage = (await options.usage?.(floorId, issue)) ?? [];
    const workers = new Set<string>();
    const stalls = new Map<string, number>();
    const failures = new Map<string, number>();
    // Oldest first: the Agents in the order they took the work up.
    for (const { event } of history.toReversed()) {
      const worker = workerOf(event);
      if (worker !== undefined) {
        workers.add(worker);
      }
      if (
        event.type === "manager.decision" &&
        event.fromAgentId !== undefined
      ) {
        const tally = event.trigger === "stalled" ? stalls : failures;
        if (event.trigger !== "near_cap") {
          tally.set(event.fromAgentId, (tally.get(event.fromAgentId) ?? 0) + 1);
        }
      }
    }
    for (const { agentId } of usage) {
      workers.add(agentId);
    }
    const info = await agentInfo(floorId, [...workers]);
    const verdicts = await reviews.verdicts(floorId, issue);
    const reports = await reviews.qaReports(floorId, issue);
    const approval = roundsToApproval(verdicts);
    const qaRoundsFailed = reports.filter(
      ({ result }) => result === "fail",
    ).length;
    const size = (await options.sizeOf?.(floorId, issue)) ?? null;

    const entries: ScorecardEntry[] = [];
    for (const agentId of workers) {
      const agent = info.get(agentId);
      // The Manager triages and plans; it works no Stage.
      if (
        agent === undefined ||
        agent.role === managerRole ||
        agent.stage === null
      ) {
        continue;
      }
      const own = verdicts.filter((verdict) => verdict.agentId === agentId);
      // Each Model that served it, the most tokens first: the Agent's own
      // counts go on the first.
      const models = [
        ...usage
          .filter((row) => row.agentId === agentId)
          .reduce((byModel, row) => {
            const model = row.model ?? "";
            const sums = byModel.get(model) ?? {
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostUsd: 0,
            };
            sums.inputTokens += row.inputTokens;
            sums.outputTokens += row.outputTokens;
            sums.estimatedCostUsd += row.estimatedCostUsd;
            return byModel.set(model, sums);
          }, new Map<string, { inputTokens: number; outputTokens: number; estimatedCostUsd: number }>())
          .entries(),
      ].sort(
        ([, a], [, b]) =>
          b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
      );
      const served =
        models.length === 0
          ? [
              [
                agent.model,
                { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
              ] as const,
            ]
          : models;
      served.forEach(([model, sums], index) => {
        const first = index === 0;
        entries.push({
          floorId,
          issue,
          agentId,
          agentName: agent.name,
          role: agent.role,
          stage: agent.stage ?? "work",
          contractor: agent.contractor,
          model,
          size,
          outcome,
          roundsToApproval: approval,
          qaRoundsFailed,
          stalls: first ? (stalls.get(agentId) ?? 0) : 0,
          failures: first ? (failures.get(agentId) ?? 0) : 0,
          roundsReviewed: first
            ? new Set(own.map(({ round }) => round)).size
            : 0,
          blockingComments: first
            ? own.reduce(
                (total, { verdict }) =>
                  total +
                  verdict.comments.filter(
                    ({ severity }) => severity === "blocking",
                  ).length,
                0,
              )
            : 0,
          inputTokens: sums.inputTokens,
          outputTokens: sums.outputTokens,
          estimatedCostUsd: Math.round(sums.estimatedCostUsd * 1e6) / 1e6,
          endedAt,
        });
      });
    }
    await store.record(floorId, issue, entries);
    return entries;
  };

  /** Issues the sweep found closed with nothing to record: not read again. */
  const swept = new Set<string>();

  const sweep = async (): Promise<number> => {
    const { github } = options;
    if (github === undefined) {
      return 0;
    }
    let recorded = 0;
    const since = new Date(now().getTime() - sweepDays * 24 * 60 * 60 * 1000);
    for (const floor of await options.floors.list()) {
      const picked = await events.history({
        filter: { floorId: floor.id, types: ["issue.picked_up"] },
        from: since,
        limit: 5000,
      });
      const issues = [
        ...new Set(
          picked.flatMap(({ event }) =>
            event.type === "issue.picked_up" ? [event.issue] : [],
          ),
        ),
      ].slice(0, sweepLimit);
      const client = github.repository(floor.repository);
      for (const issue of issues) {
        const key = `${floor.id}#${String(issue)}`;
        if (
          swept.has(key) ||
          (await store.outcomeOf(floor.id, issue)) !== undefined
        ) {
          continue;
        }
        try {
          const found = await client.getIssue(issue);
          if (found.state !== "closed") {
            continue;
          }
          const merged = await events.history({
            filter: {
              floorId: floor.id,
              issue,
              types: ["pull_request.merged"],
            },
            limit: 1,
          });
          const entries = await record(
            floor.id,
            issue,
            merged.length > 0 ? "merged" : "closed",
          );
          swept.add(key);
          recorded += entries.length > 0 ? 1 : 0;
        } catch (error) {
          report(error);
        }
      }
    }
    return recorded;
  };

  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> = Promise.resolve();
  /** One recording at a time, in the order the work ended. */
  const queue = (task: () => Promise<unknown>) => {
    running = running.then(task).catch(report);
  };

  return {
    record,
    sweep,
    start() {
      if (unsubscribe !== undefined) {
        return;
      }
      unsubscribe = events.subscribe(
        ({ event }) => {
          if (event.type === "pull_request.merged") {
            queue(() => record(event.floorId, event.issue, "merged"));
          } else if (
            event.type === "issue.label_changed" &&
            event.to === "needs-human"
          ) {
            queue(() => record(event.floorId, event.issue, "handed_to_owner"));
          }
        },
        { types: ["pull_request.merged", "issue.label_changed"] },
      );
      const tick = () => {
        queue(sweep);
        timer = setTimeout(tick, sweepMs);
        timer.unref();
      };
      timer = setTimeout(tick, sweepMs);
      timer.unref();
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      clearTimeout(timer);
      await running;
    },
  };
}
