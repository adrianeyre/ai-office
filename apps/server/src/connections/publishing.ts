import type { BatchReport, CompletedIssue } from "@ai-office/communications";
import type { EventBus, EventType } from "@ai-office/events";
import {
  issueRecord,
  issueRecordTypes,
  type AgentStore,
  type BatchStore,
  type FloorStore,
} from "@ai-office/orchestrator";
import type { TokenUsageRow } from "@ai-office/shared";

// What the Communications Agent publishes from (PRD FR-90, FR-92): a
// finished Batch's Wrap-up, with its Plan's order and dependencies and its
// coders' names, for the Wrap-up report; an issue's title, as intake read
// it, for a changelog entry; and a completed issue's Agents, Review Loop
// rounds, tokens and estimated cost, for a work log's row. It reads AI
// Office's own records, the event bus and the AI Gateway's usage, never
// GitHub: it has no repository access.

/** A finished Batch, as its Wrap-up report is made from it; undefined otherwise. */
export async function batchReportOf(
  stores: {
    readonly batches: BatchStore;
    readonly floors: FloorStore;
    readonly agents: AgentStore;
  },
  floorId: string,
  batchId: number,
): Promise<BatchReport | undefined> {
  const batch = await stores.batches.get(batchId);
  const floor = await stores.floors.get(floorId);
  if (
    batch?.floorId !== floorId ||
    batch.wrapUp === null ||
    batch.finishedAt === null ||
    floor === undefined
  ) {
    return undefined;
  }
  const { wrapUp } = batch;
  const plans = await stores.batches.plans(batchId);
  const plan =
    plans.find(({ version }) => version === wrapUp.planVersion) ?? plans.at(-1);
  const agents = await stores.agents.list(floorId);
  return {
    batchId,
    floor: { id: floor.id, name: floor.name, repository: floor.repository },
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    planVersion: wrapUp.planVersion,
    issues: wrapUp.issues.map((issue) => ({
      issue: issue.issue,
      title: issue.title,
      agent: agents.find(({ id }) => id === issue.agentId)?.name ?? null,
      dependsOn:
        plan?.items.find((item) => item.issue === issue.issue)?.dependsOn ?? [],
      outcome: issue.outcome,
      pullRequest: issue.pullRequest,
      rounds: issue.rounds,
      tokens: issue.tokens,
      estimatedCostUsd: issue.estimatedCostUsd,
    })),
    parallel: plan?.parallel ?? [],
    leftOut: wrapUp.leftOut,
    totals: wrapUp.totals,
  };
}

/** An issue's title, as intake last read it (redacted, as every event is). */
export async function issueTitleOf(
  events: Pick<EventBus, "history">,
  floorId: string,
  issue: number,
): Promise<string | undefined> {
  const [picked] = await events.history({
    filter: { floorId, issue, types: ["issue.picked_up"] },
    limit: 1,
  });
  return picked?.event.type === "issue.picked_up"
    ? picked.event.title
    : undefined;
}

/** The events naming an Agent that worked an issue. */
const workedTypes = [
  "issue.assigned",
  "sandbox.started",
  "review.posted",
  "qa.reported",
] as const satisfies readonly EventType[];

/** Rounds `usd` to a millionth, so sums of prices stay tidy. */
const priced = (usd: number): number => Math.round(usd * 1e6) / 1e6;

/**
 * A completed issue, for its work log row: its title as intake last read
 * it, the Agents that worked it (dispatched to it, or reviewing or
 * checking it) in the order they began, its Review Loop's rounds, and the
 * tokens and estimated cost of every model call made for it.
 */
export async function completedIssueOf(
  sources: {
    readonly events: Pick<EventBus, "history">;
    readonly agents: Pick<AgentStore, "list">;
    /** The AI Gateway's usage in [`from`, `to`), by caller and issue. */
    readonly usage: (from: Date, to: Date) => Promise<TokenUsageRow[]>;
    readonly now: () => Date;
  },
  floorId: string,
  issue: number,
): Promise<CompletedIssue> {
  const history = await sources.events.history({
    filter: {
      floorId,
      issue,
      types: [...issueRecordTypes, ...workedTypes, "issue.picked_up"],
    },
    limit: 2000,
  });
  const oldestFirst = [...history].sort((a, b) => a.id - b.id);
  const title = history.find(({ event }) => event.type === "issue.picked_up");
  const agentIds = [
    ...new Set(
      oldestFirst.flatMap(({ event }) =>
        (workedTypes as readonly string[]).includes(event.type) &&
        "agentId" in event &&
        typeof event.agentId === "string"
          ? [event.agentId]
          : [],
      ),
    ),
  ];
  const agents = await sources.agents.list(floorId);
  const rows = (await sources.usage(new Date(0), sources.now())).filter(
    (row) => row.floorId === floorId && row.issue === issue,
  );
  return {
    title: title?.event.type === "issue.picked_up" ? title.event.title : null,
    agents: agentIds.flatMap((id) => {
      const agent = agents.find((candidate) => candidate.id === id);
      return agent === undefined ? [] : [agent.name];
    }),
    reviewRounds: issueRecord(history).rounds.review,
    tokens: rows.reduce((sum, { totals }) => sum + totals.tokens, 0),
    estimatedCostUsd: priced(
      rows.reduce((sum, { totals }) => sum + totals.estimatedCostUsd, 0),
    ),
  };
}
