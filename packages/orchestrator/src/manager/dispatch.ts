import {
  designerRole,
  issuePriorities,
  sandboxStages,
  stageOfLabel,
  type IssueSize,
  type PipelineStage,
  type Role,
  type Stage,
} from "@ai-office/shared";

import type { AgentRecord } from "../agents/store.ts";
import type { WorkItem } from "../work/store.ts";

// The Manager's dispatch (PRD FR-23): each piece of sandbox work goes to an
// Agent on its Floor whose Role is in the work's Stage (ADR 0003: by the
// Role's Stage, never its name), balancing the load across those Agents,
// so several coders share a Floor's issues. When the Manager's triage chose
// a work Role for an issue (FR-23), its work goes only to Agents in that
// Role, unless the Floor has none in it any more. A stage worked by more
// than one Role in turn (QA, then a designer's design review) names the
// Role on each piece of work after the first, and that work goes only to
// Agents in the Role it names. These are
// dispatch rules, so they are plain code: no model is asked. The work queue
// applies them as work is queued and each time it looks for work to start,
// and starts work only within the office-wide and per-Floor limits (FR-22).
//
// 1. **New work** goes to the enabled Agent in the Stage with the least
//    work (queued or running), one not paused at a Token Cap if there is
//    one (FR-33); the oldest among equals.
// 2. **Waiting work moves to a free Agent.** An Agent is free when it is
//    enabled, not paused at a Token Cap, and has no work queued or
//    running. Work waits behind its Agent while that Agent runs something
//    else, is paused at a Token Cap, is paused in the Agent editor, has
//    gone, or when no Agent fitted it as it was queued. Each free Agent
//    takes one such piece of waiting work in its Stage, in the order work
//    starts (its issue's priority, then oldest first), so no Agent stands
//    idle while work waits for another.
//
// 3. **By Size** (Scorecards PRD, FR-133): of the Agents a piece of work
//    may go to (its Stage's, within its Role), only those that take its
//    issue's Size, chosen in the Agent editor (all three by default). When
//    none of them takes that Size, any of them may, as the triage comment
//    says. When those that take it are busy, the work waits for them: it
//    never moves to an Agent that does not.
//
// No work starts for an Agent paused in the Agent editor or at a Token
// Cap: the queue holds it until the Agent resumes or the work moves. An
// Agent that is leaving (FR-10) takes none: it finishes its task, and its
// waiting work moves on as if it had gone. A Contractor in a one-off Role
// (ADR 0004) takes only the work its Batch's Plan gives that Role.

/**
 * The Stage whose Agents work an issue at `label` in a sandbox (FR-19):
 * work, QA or docs. Undefined for review, whose rounds are every required
 * reviewer's at once, and for labels no Agent works.
 */
export const sandboxStageAt = (label: PipelineStage): Stage | undefined => {
  const stage = stageOfLabel(label);
  return stage !== undefined && sandboxStages.includes(stage)
    ? stage
    : undefined;
};

/**
 * The Role a piece of work names, whose Agents alone may do it: a
 * designer's review of the UI at `needs-qa` (FR-10). Undefined for work
 * that goes by its Stage, as all other work does.
 */
export const roleOfWork = (work: {
  readonly stage: PipelineStage;
  readonly role?: Role | null | undefined;
}): Role | undefined =>
  work.stage === "needs-qa" && work.role === designerRole
    ? designerRole
    : undefined;

/** Whether new work may go to an Agent: enabled, and not leaving (FR-10). */
export const takesWork = (
  agent: Pick<AgentRecord, "enabled" | "leavingAt">,
): boolean => agent.enabled && agent.leavingAt === null;

/**
 * Of `agents` in a Stage, those that may take an issue's work given the
 * work `role` chosen for it: the Role's, while the Floor has any Agent in
 * it; every one otherwise, as when no Role was chosen. A Contractor in a
 * one-off Role takes only the work given to that Role (ADR 0004).
 */
export const inRole = <
  Agent extends Pick<AgentRecord, "role"> & {
    readonly contractor?: AgentRecord["contractor"];
  },
>(
  agents: readonly Agent[],
  role: string | null | undefined,
): Agent[] => {
  const open = agents.filter(
    (agent) => agent.contractor?.oneOffRole !== true || agent.role === role,
  );
  return role == null || !open.some((agent) => agent.role === role)
    ? open
    : open.filter((agent) => agent.role === role);
};

/**
 * Of `agents` (those a piece of work may go to), the ones that take the
 * issue's `size` (FR-133); every one of them when none does, or when the
 * issue has no Size. An Agent that is leaving counts for neither.
 */
export const takingSize = <
  Agent extends Pick<AgentRecord, "sizes" | "leavingAt">,
>(
  agents: readonly Agent[],
  size: IssueSize | null | undefined,
): Agent[] => {
  if (size == null) {
    return [...agents];
  }
  const taking = agents.filter(
    (agent) => agent.leavingAt === null && agent.sizes.includes(size),
  );
  return taking.length === 0 ? [...agents] : taking;
};

/**
 * Whether any of `agents` (a Role's, or a Stage's) takes `size`: when none
 * does, any of them may work the issue, and its triage says so.
 */
export const noneTakes = (
  agents: readonly Pick<AgentRecord, "sizes" | "leavingAt">[],
  size: IssueSize,
): boolean =>
  agents.length > 0 &&
  !agents.some(
    (agent) => agent.leavingAt === null && agent.sizes.includes(size),
  );

/**
 * The Floor's required reviewers who review an issue of `size` (FR-133):
 * those that take its Size, in the Floor's order; every one of them when
 * none does, or the issue has no Size. Each review round, and the Merge
 * Policy's gate, ask the same reviewers.
 */
export const reviewersFor = (
  required: readonly string[],
  team: readonly Pick<AgentRecord, "id" | "sizes" | "leavingAt">[],
  size: IssueSize | null | undefined,
): string[] => {
  const ofTeam = required.flatMap((id) => {
    const agent = team.find((member) => member.id === id);
    return agent === undefined ? [] : [agent];
  });
  const taking = takingSize(ofTeam, size).map(({ id }) => id);
  return required.filter(
    (id) => taking.includes(id) || !ofTeam.some((agent) => agent.id === id),
  );
};

/**
 * Of `agents`, those who may do work at `stage`: when `role` is a Role the
 * work names (`roleOfWork`), only its Agents, whatever their Stage;
 * otherwise those in the label's Stage, within `role`, the work Role
 * chosen for the issue, if any (`inRole`); and of those, the ones that
 * take the issue's `size` (`takingSize`).
 */
const eligible = (
  stage: PipelineStage,
  agents: readonly AgentRecord[],
  role: string | null | undefined,
  size?: IssueSize | null,
): AgentRecord[] => {
  const named = roleOfWork({ stage, role });
  if (named !== undefined) {
    return takingSize(
      agents.filter((agent) => agent.role === named),
      size,
    );
  }
  const inStage = sandboxStageAt(stage);
  return takingSize(
    inRole(
      agents.filter(
        (agent) => inStage !== undefined && agent.stage === inStage,
      ),
      role,
    ),
    size,
  );
};

/** How many pieces of work, queued or running, wait for each Agent. */
export const loads = (active: readonly WorkItem[]): Map<string, number> => {
  const load = new Map<string, number>();
  for (const { agentId } of active) {
    if (agentId !== null) {
      load.set(agentId, (load.get(agentId) ?? 0) + 1);
    }
  }
  return load;
};

/**
 * The Agent for new work at `stage`: of `agents` (a Floor's, oldest
 * first), the enabled one in the label's Stage (and in `role`, the work
 * Role chosen for the issue, if any; or only in `role` when the work names
 * it, as a designer's review at QA does) with the least `active` work,
 * preferring those not `paused` at a Token Cap. Null when the stage is no
 * one Agent's (review rounds) or no Agent fits.
 */
export function chooseAgent(
  stage: PipelineStage,
  agents: readonly AgentRecord[],
  active: readonly WorkItem[],
  paused: readonly string[],
  role?: string | null,
  size?: IssueSize | null,
): string | null {
  return chooseAgentByLoad(stage, agents, loads(active), paused, role, size);
}

/**
 * `chooseAgent`, with each Agent's work counted already (`load`), as when
 * a Batch's Plan gives out several issues in turn (FR-25).
 */
export function chooseAgentByLoad(
  stage: PipelineStage,
  agents: readonly AgentRecord[],
  load: ReadonlyMap<string, number>,
  paused: readonly string[],
  role?: string | null,
  size?: IssueSize | null,
): string | null {
  const enabled = eligible(stage, agents, role, size).filter(takesWork);
  const working = enabled.filter(({ id }) => !paused.includes(id));
  const candidates = working.length > 0 ? working : enabled;
  const [best] = candidates.reduce<AgentRecord[]>(
    (chosen, agent) =>
      chosen[0] === undefined ||
      (load.get(agent.id) ?? 0) < (load.get(chosen[0].id) ?? 0)
        ? [agent]
        : chosen,
    [],
  );
  return best?.id ?? null;
}

/** A piece of waiting work moved from one Agent (or none) to another. */
export interface Reassignment {
  readonly id: number;
  readonly floorId: string;
  readonly issue: number;
  readonly from: string | null;
  readonly to: string;
}

/** Higher for work that should start sooner, on one Floor. */
const startsBefore = (a: WorkItem, b: WorkItem): number =>
  issuePriorities.indexOf(b.priority) - issuePriorities.indexOf(a.priority) ||
  a.createdAt.getTime() - b.createdAt.getTime() ||
  a.id - b.id;

/**
 * The waiting work on one Floor to move to its free Agents: `agents` are
 * the Floor's (oldest first), `active` its work queued or running, and
 * `paused` the Agents paused at a Token Cap. `roleOf` is the work Role
 * chosen for each issue, if any: its work-Stage work moves only within
 * that Role. Work that names its Role (a designer's review at QA) moves
 * only between that Role's Agents, never to the Stage's.
 */
export function rebalance(
  agents: readonly AgentRecord[],
  active: readonly WorkItem[],
  paused: readonly string[],
  roleOf: (issue: number) => string | null | undefined = () => null,
  /** Each issue's Size (FR-133): its work moves only to Agents that take it. */
  sizeOf: (issue: number) => IssueSize | null | undefined = () => null,
): Reassignment[] {
  const load = loads(active);
  const running = new Set(
    active
      .filter(({ status }) => status === "running")
      .map(({ agentId }) => agentId),
  );
  const available = agents.filter(
    (agent) => takesWork(agent) && !paused.includes(agent.id),
  );
  const moves: Reassignment[] = [];
  const pools: {
    readonly everyone: readonly AgentRecord[];
    readonly holds: (item: WorkItem) => boolean;
    readonly roleOfItem: (item: WorkItem) => string | null | undefined;
  }[] = [
    ...sandboxStages.map((inStage) => ({
      everyone: agents.filter((agent) => agent.stage === inStage),
      holds: (item: WorkItem) =>
        roleOfWork(item) === undefined &&
        sandboxStageAt(item.stage) === inStage,
      roleOfItem: (item: WorkItem) =>
        inStage === "work" ? roleOf(item.issue) : null,
    })),
    // A designer's review at QA: only designers take it.
    {
      everyone: agents.filter((agent) => agent.role === designerRole),
      holds: (item: WorkItem) => roleOfWork(item) === designerRole,
      roleOfItem: () => null,
    },
  ];
  for (const { everyone, holds, roleOfItem } of pools) {
    const team = everyone.filter((agent) => available.includes(agent));
    const free = team.filter(({ id }) => (load.get(id) ?? 0) === 0);
    if (free.length === 0) {
      continue;
    }
    const canStart = new Set(
      team.filter(({ id }) => !running.has(id)).map(({ id }) => id),
    );
    const waiting = active
      .filter(
        (item) =>
          item.status === "queued" &&
          holds(item) &&
          (item.agentId === null || !canStart.has(item.agentId)),
      )
      .sort(startsBefore);
    for (const agent of free) {
      // The first waiting work this Agent's Role may take.
      const index = waiting.findIndex((item) =>
        takingSize(inRole(everyone, roleOfItem(item)), sizeOf(item.issue)).some(
          ({ id }) => id === agent.id,
        ),
      );
      const [item] = index === -1 ? [] : waiting.splice(index, 1);
      if (item === undefined) {
        continue;
      }
      moves.push({
        id: item.id,
        floorId: item.floorId,
        issue: item.issue,
        from: item.agentId,
        to: agent.id,
      });
    }
  }
  return moves;
}

/**
 * An Agent free to take `stage`'s work now, other than `except`: of
 * `agents` (a Floor's, oldest first), one in the label's Stage (and in
 * `role`, the work Role chosen for the issue, if any; or only in `role`
 * when the work names it, as a designer's review at QA does) that is
 * enabled, not
 * `paused` at a Token Cap, and has no `active` work, the oldest. Null when
 * there is none, or the stage is no one Agent's. The Manager's watchdog
 * reassigns work to it (FR-23).
 */
export function freeAgent(
  stage: PipelineStage,
  agents: readonly AgentRecord[],
  active: readonly WorkItem[],
  paused: readonly string[],
  except?: string | null,
  role?: string | null,
  size?: IssueSize | null,
): string | null {
  const load = loads(active);
  return (
    eligible(stage, agents, role, size).find(
      ({ id, ...agent }) =>
        takesWork(agent) &&
        id !== except &&
        !paused.includes(id) &&
        (load.get(id) ?? 0) === 0,
    )?.id ?? null
  );
}
