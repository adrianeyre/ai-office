import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Mesh } from "three";

import type { AgentLook } from "./agent-state.ts";
import { rally } from "./avatar-animations.ts";
import type { Vec3 } from "./camera-rig.ts";
import { gamesHall, type FloorLayout } from "./floor-layout.ts";
import { awayOnWork } from "./away-pose.ts";
import { useDeskReturnStore } from "./desk-return.ts";
import { material } from "./materials.ts";
import type { HandoffWalker } from "./handoff-walks.ts";
import {
  idleStateOf,
  idleTrip,
  type IdleBehaviours,
  type IdlePlanner,
  type IdleState,
} from "./idle-behaviours.ts";
import type { MeetingWalker } from "./meeting-walks.ts";
import { useSceneSettings } from "./scene-settings.ts";

// Idle behaviours on a Floor (PRD FR-61): each frame, each Agent's state
// (from how it looks, and whether it is on a Handoff walk or gathered for
// a meeting, away-pose.ts) moves its idling on (idle-behaviours.ts), and the Agents themselves move in
// desk-agents.tsx. A dozing Agent has "zzz" over its head, in HTML over
// the canvas (no text in the scene, PRD §7). The moment an Agent's look
// changes, its state is taken again, so a new task brings it back to its
// desk at once rather than on the next frame. With reduced motion no one
// idles about: every Agent stays in its chair. While two Agents play
// table tennis, the ball flies between their bats, bouncing once on the
// far side of the net; it is there only while they play, so never with
// reduced motion. "Return to desks" (desk-return.ts) calls every activity
// off at once.

/** How high a bubble floats over the floor: clear of a seated Agent's head. */
export const bubbleHeight = 1.55;

/** The table tennis ball's radius, at the rules' 40 mm. */
const ballRadius = 0.02;

/**
 * Where the table tennis ball is, `seconds` into a rally at the games
 * hall's table, the hall's walkway's middle line at `hallZ`: from the
 * near end's bat (the Agent facing +x, its bat to its right, at +z) over
 * the net to a bounce on the far half, up to the far end's bat, and back
 * the same way, each crossing half a swing's loop (avatar-animations.ts'
 * `rally`), so it meets each bat as it swings.
 */
export function tableTennisBall(seconds: number, hallZ: number): Vec3 {
  const {
    at: [tableX, fromHall],
    size: [length],
  } = gamesHall.tableTennis;
  const tableZ = fromHall + hallZ;
  const tableTop = 0.76 + ballRadius;
  const batHeight = 0.95;
  const near: Vec3 = [tableX - length / 2 - 0.05, batHeight, tableZ + 0.2];
  const far: Vec3 = [tableX + length / 2 + 0.05, batHeight, tableZ - 0.2];
  const half = rally.seconds / 2;
  const since =
    (((seconds - rally.batMeetsBall) % rally.seconds) + rally.seconds) %
    rally.seconds;
  const [from, to] = since < half ? [near, far] : [far, near];
  const along = (since < half ? since : since - half) / half;
  // It bounces 70% of the way across: on the far half.
  const bounce = 0.7;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const arc = (a: number, b: number, t: number, lift: number) =>
    lerp(a, b, t) + 4 * lift * t * (1 - t);
  const y =
    along < bounce
      ? arc(from[1], tableTop, along / bounce, 0.22)
      : arc(tableTop, to[1], (along - bounce) / (1 - bounce), 0.16);
  return [lerp(from[0], to[0], along), y, lerp(from[2], to[2], along)];
}

/** The table tennis ball, while two Agents play each other. */
function TableTennisBall({
  idle,
  layout,
}: {
  idle: IdleBehaviours;
  layout: Pick<FloorLayout, "waypoints">;
}) {
  const ball = useRef<Mesh>(null);
  // The table is in the games hall, placed from its walkway, where the
  // table's waypoint is.
  const hallZ =
    layout.waypoints.waypoints.find(({ id }) => id === "table-tennis")
      ?.position[1] ?? 0;
  useFrame(() => {
    const current = ball.current;
    if (current === null) {
      return;
    }
    const players = idle.playing("table-tennis");
    const first = players.get(0);
    const second = players.get(1);
    const rallying = first !== undefined && first.activity === second?.activity;
    current.visible = rallying;
    if (rallying) {
      current.position.set(...tableTennisBall(first.seconds, hallZ));
    }
  });
  return (
    <mesh
      ref={ball}
      name="table-tennis-ball"
      visible={false}
      material={material("paper", "plastic")}
      castShadow
    >
      <sphereGeometry args={[ballRadius, 10, 8]} />
    </mesh>
  );
}

/** Each desk's Agent's idle state. */
function statesOf(
  layout: Pick<FloorLayout, "desks">,
  looks: ReadonlyMap<string, AgentLook>,
  walker: HandoffWalker | undefined,
  meetings: Pick<MeetingWalker, "poseOf" | "attending"> | undefined,
): ReadonlyMap<string, IdleState> {
  return new Map(
    layout.desks.map(({ agentId }) => [
      agentId,
      idleStateOf(
        looks.get(agentId),
        awayOnWork(agentId, { walker, meetings }),
      ),
    ]),
  );
}

const keyOf = (bubbles: ReadonlyMap<string, string>) =>
  [...bubbles].map(([agentId, bubble]) => `${agentId}:${bubble}`).join();

/** Plays a Floor's idle behaviours, and shows their bubbles. */
export function IdleActivities({
  idle,
  walker,
  meetings,
  layout,
  looks,
  labelsIn,
}: {
  idle: IdleBehaviours;
  /** The Floor's Handoff walks: an Agent on one is not idle. */
  walker?: HandoffWalker | undefined;
  /** The Floor's meetings: an Agent gathered for one is not idle. */
  meetings?: Pick<MeetingWalker, "poseOf" | "attending"> | undefined;
  layout: Pick<FloorLayout, "desks" | "waypoints">;
  /** How each Agent looks, by its id. */
  looks: ReadonlyMap<string, AgentLook>;
  /** Where the bubbles go in the page; beside the canvas by default. */
  labelsIn?: RefObject<HTMLElement> | undefined;
}) {
  const plan = useMemo<IdlePlanner>(
    () => (agentId, activity, place) =>
      idleTrip(layout, agentId, activity, place),
    [layout],
  );
  const current = useRef({ plan, looks, layout });
  useEffect(() => {
    current.current = { plan, looks, layout };
    // A new task interrupts any activity at once.
    if (!useSceneSettings.getState().reducedMotion) {
      idle.advance(0, statesOf(layout, looks, walker, meetings), plan);
    }
  }, [idle, walker, meetings, plan, looks, layout]);

  // "Return to desks" (desk-return.ts): each time the Owner asks, every
  // Agent away on an activity walks back (with reduced motion, is back at
  // once), and rests a full rest before it idles again.
  useEffect(
    () =>
      useDeskReturnStore.subscribe((state, previous) => {
        if (state.requests !== previous.requests) {
          idle.recall(!useSceneSettings.getState().reducedMotion);
        }
      }),
    [idle],
  );
  useEffect(
    () => () => {
      useDeskReturnStore.getState().setWandering(false);
    },
    [],
  );

  const [bubbles, setBubbles] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const bubblesKey = useRef("");
  useFrame((_state, delta) => {
    if (useSceneSettings.getState().reducedMotion) {
      idle.stopAll();
    } else {
      const { plan: planned, looks: looked, layout: laid } = current.current;
      idle.advance(delta, statesOf(laid, looked, walker, meetings), planned);
    }
    // Whether anyone is away on an activity, for the button to show.
    const wandering = current.current.layout.desks.some(({ agentId }) =>
      idle.wandering(agentId),
    );
    if (useDeskReturnStore.getState().wandering !== wandering) {
      useDeskReturnStore.getState().setWandering(wandering);
    }
    const now = idle.bubbles();
    const key = keyOf(now);
    if (key !== bubblesKey.current) {
      bubblesKey.current = key;
      setBubbles(now);
    }
  });

  return (
    <group name="idle-bubbles">
      <TableTennisBall idle={idle} layout={layout} />
      {[...bubbles].map(([agentId, bubble]) => {
        // A bubble shows only while its Agent is at its activity, standing
        // still: over where it is.
        const pose = idle.poseOf(agentId);
        if (pose === undefined) {
          return null;
        }
        const [x, z] = pose.position;
        return (
          <group
            key={agentId}
            name={`idle-bubble-${agentId}`}
            position={[x, bubbleHeight, z]}
          >
            <Html
              center
              zIndexRange={[0, 0]}
              style={{ pointerEvents: "none" }}
              {...(labelsIn === undefined ? {} : { portal: labelsIn })}
            >
              <span
                aria-hidden
                data-idle-bubble={agentId}
                className="rounded-full bg-office-paper px-1.5 py-0.5 font-mono text-xs font-semibold text-office-ink italic shadow-sm"
              >
                {bubble}
              </span>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
