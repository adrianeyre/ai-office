import {
  randomAvatar,
  seededRandom,
  type Avatar,
} from "@ai-office/shared/avatar";
import { useFrame } from "@react-three/fiber";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Matrix4, Quaternion, Vector3, type Group } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { AboveHead, FreshStartSignal } from "./above-head.ts";
import { AgentAboveHead } from "./above-head.tsx";
import type { Vec3 } from "./camera-rig.ts";
import type { AgentLook } from "./agent-state.ts";
import type { AnimationName } from "./avatar-animations.ts";
import { avatarFigure } from "./avatar-figure.ts";
import {
  avatarLods,
  avatarMaterial,
  deskItemGeometry,
  mascotGeometry,
} from "./avatar-geometry.ts";
import { awayPose } from "./away-pose.ts";
import { chairOffset, desk, deskFacing, type DeskRole } from "./desk-set.ts";
import type { FloorAgent, FloorDesk } from "./floor-layout.ts";
import type { HandoffWalker } from "./handoff-walks.ts";
import type { IdleBehaviours } from "./idle-behaviours.ts";
import type { MeetingWalker } from "./meeting-walks.ts";
import { turnPoint, type QuarterTurns } from "./pieces.ts";
import { useSceneSettings } from "./scene-settings.ts";
import {
  deskItemScale,
  mascotSpot,
  placeDeskItems,
  type DeskItemPlacement,
} from "./desk-item-layout.ts";
import { useSeason } from "./season.ts";
import { seasonalDress } from "./seasonal-dress.ts";

// The Floor's Agents at their desks (PRD FR-13, FR-57, FR-62): each sits
// in its chair as its Avatar, typing while it works, leaning back with its
// hands behind its head while its work waits on review, and sitting back
// otherwise (agent-state.ts), with its desk mascot on its desk. At a
// Handoff it gets up and walks its ticket to the next Agent's desk and
// back (FR-59; handoff-walks.ts), and then takes up its state again. At a
// Kickoff or a Wrap-up it walks to the meeting room, sits at the table
// until the meeting ends, and walks back (FR-60; meeting-walks.ts). With
// nothing to do it plays its idle activities (FR-61; idle-behaviours.ts):
// a stretch, a coffee, the gym, the water cooler or a doze. A meeting wins
// over a Handoff walk, and both over an idle activity (away-pose.ts). Over
// its head float its Context Usage bar and its tokens today (FR-62, FR-85;
// above-head.tsx), going wherever it goes. The mascots are merged into one
// mesh; each Avatar is one skinned mesh in the Avatars' one shared material.

/** An Agent's Avatar: its own, or one seeded from its id until it has one. */
export const avatarOf = (agent: Pick<FloorAgent, "id" | "avatar">): Avatar =>
  agent.avatar ?? randomAvatar(seededRandom(agent.id));

export { mascotSpot };

/** Where a desk's mascot stands on the Floor. */
export const mascotAt = (seat: Vec3, turns: QuarterTurns): Vec3 =>
  turnPoint([mascotSpot.x, desk.top, mascotSpot.z - chairOffset], turns, [
    seat[0],
    seat[2],
  ]);

/** One Agent at its desk, as its Avatar, on a Handoff walk, in a meeting, or idling. */
export function DeskAgent({
  agentId,
  avatar,
  seat,
  turns,
  animation,
  walker,
  idle,
  meetings,
  children,
}: {
  agentId: string;
  avatar: Avatar;
  seat: Vec3;
  turns: QuarterTurns;
  animation: AnimationName;
  /** What goes with the Agent wherever it is, such as its display above its head. */
  children?: ReactNode;
  /** The Floor's Handoff walks; while it is on one, it walks it. */
  walker?: HandoffWalker | undefined;
  /** The Floor's idle behaviours; while it is on an activity, it plays it. */
  idle?: IdleBehaviours | undefined;
  /** The Floor's meetings; while it is in one, it is there. */
  meetings?: Pick<MeetingWalker, "poseOf" | "attending"> | undefined;
}) {
  const quality = useSceneSettings((settings) => settings.quality);
  const reducedMotion = useSceneSettings((settings) => settings.reducedMotion);
  // Seated from the start: the figure is made already in its chair, in
  // the look it first has (sitting back until the Office knows better),
  // so no Agent is ever seen standing at its desk or walking in. Idle
  // activities take it away from the desk only later (FR-61).
  const [starting] = useState(animation);
  // In season, a Halloween costume or a New Year party hat, never saved.
  const costumes = useSeason((season) => season.costumes);
  const partyHats = useSeason((season) => season.partyHats);
  const figure = useMemo(
    () =>
      avatarFigure(
        avatar,
        avatarLods[quality],
        starting,
        seasonalDress(agentId, { costumes, partyHats }),
      ),
    [avatar, quality, starting, agentId, costumes, partyHats],
  );
  useEffect(
    () => () => {
      figure.dispose();
    },
    [figure],
  );
  const group = useRef<Group>(null);
  const atDesk = useRef({ animation, seat, turns });
  useEffect(() => {
    atDesk.current = { animation, seat, turns };
  });
  const walking = useRef(false);
  // Away from its chair's state: in a meeting, on a Handoff walk, or on an
  // idle activity, in that order.
  const away = useRef(() => awayPose(agentId, { meetings, walker, idle }));
  useEffect(() => {
    away.current = () => awayPose(agentId, { meetings, walker, idle });
    if (away.current() === undefined) {
      figure.play(animation, reducedMotion || figure.playing() === undefined);
    }
  }, [figure, animation, reducedMotion, walker, idle, meetings, agentId]);
  // With reduced motion an Avatar holds its pose (PRD §7), and never walks.
  useFrame((_state, delta) => {
    const pose = away.current();
    const current = group.current;
    if (pose !== undefined && current !== null) {
      walking.current = true;
      current.position.set(pose.position[0], 0, pose.position[1]);
      current.rotation.set(0, pose.heading, 0);
      figure.play(pose.animation, false, pose.phase);
    } else if (walking.current && current !== null) {
      // Back in its chair: as it was before it got up.
      walking.current = false;
      const back = atDesk.current;
      current.position.set(...back.seat);
      current.rotation.set(0, deskFacing(back.turns), 0);
      figure.play(back.animation);
    }
    if (!useSceneSettings.getState().reducedMotion) {
      figure.mixer.update(delta * (pose?.pace ?? 1));
    }
  });
  return (
    <group
      ref={group}
      name={`agent-${agentId}`}
      position={seat}
      rotation={[0, deskFacing(turns), 0]}
    >
      <primitive object={figure.mesh} />
      {children}
    </group>
  );
}

/** Where a desk's thing stands on the Floor, from where it is on the desk. */
export const deskItemAt = (
  seat: Vec3,
  turns: QuarterTurns,
  placement: Pick<DeskItemPlacement, "x" | "z">,
): Vec3 =>
  turnPoint([placement.x, desk.top, placement.z - chairOffset], turns, [
    seat[0],
    seat[2],
  ]);

/** Every desk's things, merged into one mesh. */
export function DeskItems({
  desks,
  avatars,
  owners,
}: {
  desks: readonly FloorDesk[];
  avatars: ReadonlyMap<string, Avatar>;
  /** Whose each desk is, by its Agent's id: its Role, Stage and dressing. */
  owners: ReadonlyMap<string, DeskRole>;
}) {
  const geometry = useMemo(() => {
    const placed = desks.flatMap(({ agentId, role, seat, turns }) => {
      const avatar = avatars.get(agentId);
      if (avatar === undefined) {
        return [];
      }
      return placeDeskItems(
        owners.get(agentId) ?? { role },
        avatar.deskItems,
      ).map((placement) => {
        const made = deskItemGeometry(avatar, placement.item);
        const scale = deskItemScale[placement.item];
        made.applyMatrix4(
          new Matrix4().compose(
            new Vector3(...deskItemAt(seat, turns, placement)),
            new Quaternion().setFromAxisAngle(
              new Vector3(0, 1, 0),
              (turns * Math.PI) / 2 + placement.rotation,
            ),
            new Vector3(scale, scale, scale),
          ),
        );
        return made;
      });
    });
    const merged = placed.length === 0 ? undefined : mergeGeometries(placed);
    for (const each of placed) {
      each.dispose();
    }
    return merged;
  }, [desks, avatars, owners]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (geometry === undefined) {
    return null;
  }
  return (
    <mesh
      name="desk-items"
      geometry={geometry}
      material={avatarMaterial()}
      castShadow
      receiveShadow
    />
  );
}

/** Every desk's mascot, merged into one mesh. */
export function DeskMascots({
  desks,
  avatars,
}: {
  desks: readonly FloorDesk[];
  avatars: ReadonlyMap<string, Avatar>;
}) {
  const geometry = useMemo(() => {
    const placed = desks.flatMap(({ agentId, seat, turns }) => {
      const avatar = avatars.get(agentId);
      if (avatar === undefined) {
        return [];
      }
      const mascot = mascotGeometry(avatar);
      mascot.applyMatrix4(
        new Matrix4().compose(
          new Vector3(...mascotAt(seat, turns)),
          new Quaternion().setFromAxisAngle(
            new Vector3(0, 1, 0),
            (turns * Math.PI) / 2,
          ),
          new Vector3(1, 1, 1),
        ),
      );
      return [mascot];
    });
    const merged = placed.length === 0 ? undefined : mergeGeometries(placed);
    for (const each of placed) {
      each.dispose();
    }
    return merged;
  }, [desks, avatars]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (geometry === undefined) {
    return null;
  }
  return (
    <mesh
      name="desk-mascots"
      geometry={geometry}
      material={avatarMaterial()}
      castShadow
      receiveShadow
    />
  );
}

const noFreshStarts: readonly FreshStartSignal[] = [];

/** The Floor's Agents at their desks, and their mascots. */
export function DeskAgents({
  desks,
  team,
  looks,
  walker,
  idle,
  meetings,
  aboveHead,
  freshStarts = noFreshStarts,
  labelsIn,
}: {
  desks: readonly FloorDesk[];
  team: readonly FloorAgent[];
  /** How each Agent looks, by its id; one not in it sits back. */
  looks: ReadonlyMap<string, AgentLook>;
  /**
   * What floats above each Agent's head, by its id (FR-62, FR-85); nothing
   * above any until known.
   */
  aboveHead?: ReadonlyMap<string, AboveHead> | undefined;
  /** The Floor's Fresh Starts, oldest first: each new one empties its Agent's bar. */
  freshStarts?: readonly FreshStartSignal[] | undefined;
  /** Where the displays above the Agents go in the page; beside the canvas by default. */
  labelsIn?: RefObject<HTMLElement> | undefined;
  /** The Floor's Handoff walks. */
  walker?: HandoffWalker | undefined;
  /** The Floor's idle behaviours. */
  idle?: IdleBehaviours | undefined;
  /** The Floor's meetings. */
  meetings?: Pick<MeetingWalker, "poseOf" | "attending"> | undefined;
}) {
  // Keyed by what they look like, so refetching the team rebuilds no
  // Avatar that has not changed.
  const appearances = JSON.stringify(
    team.map(({ id, avatar }) => [id, avatar ?? null]),
  );
  const avatars = useMemo(
    () =>
      new Map(
        (JSON.parse(appearances) as [string, Avatar | null][]).map(
          ([id, avatar]) => [id, avatar ?? avatarOf({ id })],
        ),
      ),
    [appearances],
  );
  const dressing = JSON.stringify(
    team.map(({ id, role, stage, deskDressing }) => [
      id,
      { role, stage, deskDressing },
    ]),
  );
  const owners = useMemo(
    () => new Map(JSON.parse(dressing) as [string, DeskRole][]),
    [dressing],
  );
  return (
    <group name="desk-agents">
      {desks.map(({ agentId, seat, turns }) => {
        const avatar = avatars.get(agentId);
        return avatar === undefined ? null : (
          <DeskAgent
            key={agentId}
            agentId={agentId}
            avatar={avatar}
            seat={seat}
            turns={turns}
            animation={looks.get(agentId)?.animation ?? "sit"}
            walker={walker}
            idle={idle}
            meetings={meetings}
          >
            {aboveHead !== undefined && (
              <AgentAboveHead
                agentId={agentId}
                display={aboveHead.get(agentId)}
                freshStart={freshStarts.findLast(
                  (signal) => signal.agentId === agentId,
                )}
                labelsIn={labelsIn}
              />
            )}
          </DeskAgent>
        );
      })}
      <DeskMascots desks={desks} avatars={avatars} />
      <DeskItems desks={desks} avatars={avatars} owners={owners} />
    </group>
  );
}
