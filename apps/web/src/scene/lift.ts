import { easeInOutCubic } from "./camera-rig.ts";
import { sameLocation, type OfficeLocation } from "./lift-stops.ts";

// The lift's ride, as pure data and functions like the camera rig, so it is
// tested without WebGL. Called to a stop, the doors close, the car travels
// (eased) and the doors open on the new stop; the scene shows the stop the
// car is at, so it changes, behind closed doors, when the car arrives. The
// scene's `LiftDriver` advances it every frame.

/** Where a ride goes. */
export interface LiftDestination {
  /** Its place in the lift's run, as `LiftStop.order`. */
  readonly order: number;
  readonly location: OfficeLocation;
}

export type LiftPhase = "idle" | "closing" | "travelling" | "opening";

export interface LiftState {
  /** The stop the car is at, or left from while the doors close and it travels. */
  readonly at: LiftDestination;
  /** Where the ride under way goes; none when idle or opening. */
  readonly to: LiftDestination | undefined;
  readonly phase: LiftPhase;
  /** How closed the doors are: 0 open, 1 shut. */
  readonly doors: number;
  /** Where the car is in the run, between two stops while it travels. */
  readonly car: number;
  /** The travel under way: from where in the run, how long it takes, how far in. */
  readonly travel:
    | {
        readonly from: number;
        readonly duration: number;
        readonly elapsed: number;
      }
    | undefined;
}

export interface LiftAdvanceOptions {
  /** Cut straight to the end of the ride (PRD §7, reduced motion). */
  readonly reducedMotion: boolean;
}

/** Seconds the doors take to close, or to open. */
export const doorSeconds = 0.6;

/** The shortest and longest travel, in seconds, and the time per stop passed. */
export const minimumTravel = 0.8;
export const maximumTravel = 2.4;
export const secondsPerStop = 0.35;

/** Seconds to travel `stops` stops along the run, either way. */
export function travelDuration(stops: number): number {
  return Math.min(
    maximumTravel,
    minimumTravel + secondsPerStop * Math.abs(stops),
  );
}

/** The lift idle at a stop, doors open. */
export function liftAt(destination: LiftDestination): LiftState {
  return {
    at: destination,
    to: undefined,
    phase: "idle",
    doors: 0,
    car: destination.order,
    travel: undefined,
  };
}

/** Where the lift will be once the ride under way is over. */
export function liftDestination(lift: LiftState): LiftDestination {
  return lift.to ?? lift.at;
}

/** Whether a ride is under way: the doors closing or the car travelling. */
export function isRiding(lift: LiftState): boolean {
  return lift.to !== undefined;
}

/** The place the scene shows: the stop the car is at. */
export function liftLocation(lift: LiftState): OfficeLocation {
  return lift.at.location;
}

/**
 * Call the lift to a stop. Idle or opening, its doors close and it sets
 * off; closing, it goes to the new stop instead; travelling, it turns
 * towards the new stop from where the car is. Calling it back to the stop
 * it is leaving before it sets off opens the doors again. A call to where
 * it already is, or is already going, changes nothing.
 */
export function callLift(
  lift: LiftState,
  destination: LiftDestination,
): LiftState {
  if (sameLocation(liftDestination(lift).location, destination.location)) {
    return lift;
  }
  switch (lift.phase) {
    case "idle":
    case "opening":
      return { ...lift, to: destination, phase: "closing" };
    case "closing":
      return sameLocation(lift.at.location, destination.location)
        ? { ...lift, to: undefined, phase: "opening" }
        : { ...lift, to: destination };
    case "travelling":
      return {
        ...lift,
        to: destination,
        travel: {
          from: lift.car,
          duration: travelDuration(destination.order - lift.car),
          elapsed: 0,
        },
      };
  }
}

/** The lift `seconds` later. A lift with nothing to do is returned as is. */
export function advanceLift(
  lift: LiftState,
  seconds: number,
  { reducedMotion }: LiftAdvanceOptions,
): LiftState {
  if (lift.phase === "idle") {
    return lift;
  }
  if (reducedMotion) {
    return liftAt(liftDestination(lift));
  }
  let state = lift;
  let left = Math.max(0, seconds);
  // Each step uses up time, or ends a phase; time left over carries on.
  while (state.phase !== "idle") {
    if (state.phase === "closing") {
      const needed = (1 - state.doors) * doorSeconds;
      if (left < needed) {
        return { ...state, doors: state.doors + left / doorSeconds };
      }
      left -= needed;
      const to = state.to ?? state.at;
      state = {
        ...state,
        doors: 1,
        phase: "travelling",
        travel: {
          from: state.car,
          duration: travelDuration(to.order - state.car),
          elapsed: 0,
        },
      };
    } else if (state.phase === "travelling") {
      const to = state.to ?? state.at;
      const travel = state.travel ?? {
        from: state.car,
        duration: 0,
        elapsed: 0,
      };
      const elapsed = travel.elapsed + left;
      if (elapsed < travel.duration) {
        const progress = easeInOutCubic(elapsed / travel.duration);
        return {
          ...state,
          travel: { ...travel, elapsed },
          car: travel.from + (to.order - travel.from) * progress,
        };
      }
      left = elapsed - travel.duration;
      state = {
        ...state,
        at: to,
        to: undefined,
        car: to.order,
        travel: undefined,
        phase: "opening",
      };
    } else {
      const needed = state.doors * doorSeconds;
      if (left < needed) {
        return { ...state, doors: state.doors - left / doorSeconds };
      }
      left -= needed;
      state = { ...state, doors: 0, phase: "idle" };
    }
  }
  return state;
}
