import type { AnimationName } from "./avatar-animations.ts";
import type { HandoffWalker } from "./handoff-walks.ts";
import type { IdleBehaviours } from "./idle-behaviours.ts";
import type { MeetingWalker } from "./meeting-walks.ts";
import type { FloorPoint } from "./waypoints.ts";

// What takes an Agent away from its chair, when more than one thing would:
// a meeting (PRD FR-60) wins over a Handoff walk (FR-59), and both win over
// an idle activity (FR-61). Meetings and Handoffs are work, so an Agent
// gathered for a Kickoff or on a Handoff walk is never idle: its idle
// activity stops at once, as a new task stops it. A meeting waits for a
// Handoff walk under way to finish before its Agent sets off, and a
// Handoff from an Agent in the meeting room is handed over at once, so the
// two rarely meet; when they do, the meeting is what is shown. A Grilling
// Session's walks (grilling-walks.ts) count as meetings: the whole Floor
// gathered at the table, Agents at work in their sandboxes too, and any
// the Manager sends to find facts, visiting it.

/** Where an Agent away from its chair is, which way it faces, and what it plays. */
export interface AwayPose {
  readonly position: FloorPoint;
  readonly heading: number;
  readonly animation: AnimationName;
  /** How fast its animation plays: hurried on a Handoff walk another waits for. */
  readonly pace: number;
  /**
   * How far through its animation's loop it starts it, as a share of it:
   * partners at a game play out of step (idle-behaviours.ts).
   */
  readonly phase?: number | undefined;
}

/** What may take a Floor's Agents away from their chairs. */
export interface AwaySources {
  readonly meetings?: Pick<MeetingWalker, "poseOf" | "attending"> | undefined;
  readonly walker?: Pick<HandoffWalker, "poseOf"> | undefined;
  readonly idle?: Pick<IdleBehaviours, "poseOf"> | undefined;
}

/**
 * Where an Agent is while away from its chair: in a meeting, else on a
 * Handoff walk, else on an idle activity; undefined in its chair.
 */
export function awayPose(
  agentId: string,
  { meetings, walker, idle }: AwaySources,
): AwayPose | undefined {
  const meeting = meetings?.poseOf(agentId);
  if (meeting !== undefined) {
    return { ...meeting, pace: 1 };
  }
  return walker?.poseOf(agentId) ?? idle?.poseOf(agentId);
}

/**
 * Whether an Agent is away on work rather than free to idle: in a meeting
 * (or waiting to set off for one), or on a Handoff walk.
 */
export function awayOnWork(
  agentId: string,
  { meetings, walker }: Omit<AwaySources, "idle">,
): boolean {
  return (
    meetings?.attending(agentId) === true ||
    walker?.poseOf(agentId) !== undefined
  );
}
