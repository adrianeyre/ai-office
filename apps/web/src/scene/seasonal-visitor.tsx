import type { SeasonalActorId } from "@ai-office/shared";
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Group } from "three";
import { create } from "zustand";

import { avatarFigure } from "./avatar-figure.ts";
import { avatarLods } from "./avatar-geometry.ts";
import { bubbleHeight } from "./idle-activities.tsx";
import { useSceneSettings } from "./scene-settings.ts";
import { useSeason } from "./season.ts";
import { actorLooks } from "./seasonal-dress.ts";
import {
  leavingVisit,
  visitGap,
  visitLiftDoors,
  visitPose,
  type Visit,
  type VisitPose,
} from "./seasonal-visits.ts";
import type { FloorPoint } from "./waypoints.ts";

// The seasonal actor visiting where the lift is now: a scheduler that,
// while the season has actors, waits a while, picks one at random and
// plans its trip, and the figure that goes on it, saying one of its lines
// over its head as it stops. Only one visits at a time. The Owner may
// call one at once, and send it away again, from the 3D view's Call Actor
// button. With reduced motion nobody visits.

/** Whether an actor is visiting where the view is, and the Call Actor button's doings. */
export interface ActorCalls {
  readonly visiting: boolean;
  /** Calls an actor out of the lift now; undefined while nobody may visit. */
  readonly call: (() => void) | undefined;
  /** Sends the visiting actor back to the lift and away. */
  readonly remove: (() => void) | undefined;
}

export const useActorCalls = create<ActorCalls>(() => ({
  visiting: false,
  call: undefined,
  remove: undefined,
}));

export interface VisitScheduler {
  /**
   * Moves the clock on: waiting, then planning a visit by one of `actors`
   * with `plan`, then following it to its end.
   */
  advance(
    delta: number,
    actors: readonly SeasonalActorId[],
    plan: (actor: SeasonalActorId) => Visit | undefined,
  ): void;
  /** The visit under way, if any. */
  visit(): Visit | undefined;
  /** Where the visitor is now; undefined while nobody visits. */
  pose(): VisitPose | undefined;
  /** How open the visitor holds the lift's doors, 0 to 1. */
  liftDoors(): number;
  /** Has an actor visit on the next move on, unless one is visiting. */
  call(): void;
  /**
   * Sends the visitor back to the lift from where it is, by `back` from
   * the way it came if that gives a way, else back the way it came.
   */
  dismiss(
    back?: (way: readonly FloorPoint[]) => FloorPoint[] | undefined,
  ): void;
}

const between = (random: () => number, [min, max]: readonly [number, number]) =>
  min + (max - min) * random();

export function createVisitScheduler(
  random: () => number = Math.random,
): VisitScheduler {
  let waiting = between(random, visitGap.first);
  let current: { visit: Visit; elapsed: number } | undefined;
  return {
    advance(delta, actors, plan) {
      if (actors.length === 0) {
        current = undefined;
        return;
      }
      if (current !== undefined) {
        current.elapsed += delta;
        if (current.elapsed >= current.visit.seconds) {
          current = undefined;
          waiting = between(random, visitGap.next);
        }
        return;
      }
      waiting -= delta;
      if (waiting > 0) {
        return;
      }
      const actor = actors[Math.floor(random() * actors.length)];
      const visit = actor === undefined ? undefined : plan(actor);
      if (visit === undefined || visit.seconds === 0) {
        waiting = between(random, visitGap.next);
        return;
      }
      current = { visit, elapsed: 0 };
    },
    visit: () => current?.visit,
    pose: () =>
      current === undefined
        ? undefined
        : visitPose(current.visit, current.elapsed),
    liftDoors() {
      return visitLiftDoors(
        current === undefined
          ? undefined
          : visitPose(current.visit, current.elapsed),
      );
    },
    call() {
      if (current === undefined) {
        waiting = 0;
      }
    },
    dismiss(back) {
      if (current === undefined) {
        return;
      }
      const leaving = leavingVisit(current.visit, current.elapsed, back);
      current =
        leaving === undefined || leaving.seconds === 0
          ? undefined
          : { visit: leaving, elapsed: 0 };
      if (current === undefined) {
        waiting = between(random, visitGap.next);
      }
    },
  };
}

/** One actor's figure, posed each frame from the scheduler. */
function Visitor({
  actor,
  scheduler,
}: {
  actor: SeasonalActorId;
  scheduler: VisitScheduler;
}) {
  const quality = useSceneSettings((settings) => settings.quality);
  const figure = useMemo(() => {
    const { avatar, dress } = actorLooks[actor];
    return avatarFigure(avatar, avatarLods[quality], "idle", dress);
  }, [actor, quality]);
  useEffect(
    () => () => {
      figure.dispose();
    },
    [figure],
  );
  const group = useRef<Group>(null);
  const [said, setSaid] = useState<{
    text: string;
    at: VisitPose["position"];
  }>();
  const shown = useRef<string | undefined>(undefined);
  useFrame((_state, delta) => {
    const pose = scheduler.pose();
    const current = group.current;
    if (current === null) {
      return;
    }
    current.visible = pose !== undefined;
    if (pose !== undefined) {
      current.position.set(pose.position[0], 0, pose.position[1]);
      current.rotation.set(0, pose.heading, 0);
      figure.play(pose.animation);
      figure.mixer.update(delta);
    }
    const bubble = pose?.bubble;
    if (bubble !== shown.current) {
      shown.current = bubble;
      setSaid(
        bubble === undefined || pose === undefined
          ? undefined
          : { text: bubble, at: pose.position },
      );
    }
  });
  return (
    <>
      <group ref={group} name={`seasonal-visitor ${actor}`} visible={false}>
        <primitive object={figure.mesh} />
      </group>
      {said !== undefined && (
        <group
          name="seasonal-visitor-bubble"
          position={[said.at[0], bubbleHeight + 0.45, said.at[1]]}
        >
          <Html center zIndexRange={[0, 0]} style={{ pointerEvents: "none" }}>
            <span
              aria-hidden
              data-seasonal-bubble={actor}
              className="block rounded-lg bg-office-paper px-3 py-1.5 text-center text-sm font-medium whitespace-nowrap text-office-ink shadow-md"
            >
              {said.text}
            </span>
          </Html>
        </group>
      )}
    </>
  );
}

/**
 * The seasonal actors' visits where the lift is: `plan` makes an actor's
 * trip from here, and `back` the way back to the lift for one sent away.
 * The scheduler is the caller's, so the lift can read how open the
 * visitor holds its doors.
 */
export function SeasonalVisitors({
  scheduler,
  plan,
  back,
}: {
  scheduler: VisitScheduler;
  plan: (actor: SeasonalActorId) => Visit | undefined;
  back?: (way: readonly FloorPoint[]) => FloorPoint[] | undefined;
}) {
  const [actor, setActor] = useState<SeasonalActorId>();
  const planned = useRef(plan);
  const wayBack = useRef(back);
  useEffect(() => {
    planned.current = plan;
    wayBack.current = back;
  });
  const reducedMotion = useSceneSettings((settings) => settings.reducedMotion);
  const anyone = useSeason((season) => season.actors.length > 0);
  useEffect(() => {
    useActorCalls.setState({
      call:
        anyone && !reducedMotion
          ? () => {
              scheduler.call();
            }
          : undefined,
      remove: () => {
        scheduler.dismiss((way) => wayBack.current?.(way));
      },
    });
    return () => {
      useActorCalls.setState({
        visiting: false,
        call: undefined,
        remove: undefined,
      });
    };
  }, [scheduler, anyone, reducedMotion]);
  useFrame((_state, delta) => {
    scheduler.advance(
      delta,
      useSceneSettings.getState().reducedMotion
        ? []
        : useSeason.getState().actors,
      (chosen) => planned.current(chosen),
    );
    const now = scheduler.visit()?.actor;
    if (now !== actor) {
      setActor(now);
    }
    const visiting = now !== undefined;
    if (useActorCalls.getState().visiting !== visiting) {
      useActorCalls.setState({ visiting });
    }
  });
  return actor === undefined ? null : (
    <Visitor key={actor} actor={actor} scheduler={scheduler} />
  );
}
