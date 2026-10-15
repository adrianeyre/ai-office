import { create } from "zustand";

import type { CameraPose } from "./camera-rig.ts";
import { defaultView, useCameraStore } from "./camera-store.ts";
import {
  advanceLift,
  callLift,
  doorSeconds,
  isRiding,
  liftAt,
  type LiftDestination,
  type LiftState,
} from "./lift.ts";
import { lobby } from "./lift-stops.ts";
import { liftDoorway } from "./lift-layout.ts";

// The lift's state for the scene and the floor picker. Calling it flies the
// camera to the lift doors to watch them close; when the car arrives, the
// scene shows the new stop and the camera goes back to the overview while
// the doors open. With reduced motion the next frame is already there.
//
// Waiting at a stop, the lift rests with its doors shut. Pressing its call
// button lights it; a moment later the doors open, and the floor picker
// with them. Doors that open, at a call or on arriving, close again after
// `dwellSeconds` once no ride is under way.

/** Seconds from pressing the call button to the doors opening. */
export const answerSeconds = 1.2;

/** Seconds the doors stay open at a stop before they close to rest. */
export const dwellSeconds = 8;

/** The camera view in front of the lift doors, the same in the lobby and on a Floor. */
export const liftViewName = "lift";

export const liftView: CameraPose = {
  position: [liftDoorway.position[0] + 0.6, 2.2, liftDoorway.position[2] + 4.6],
  target: [liftDoorway.position[0], 1.2, liftDoorway.position[2]],
};

export interface LiftStoreState {
  readonly lift: LiftState;
  /** Whether the floor picker is open. */
  readonly pickerOpen: boolean;
  /**
   * How shut the doors are while the lift waits at a stop (0 open, 1
   * shut); a ride's own doors are `lift.doors`.
   */
  readonly restingDoors: number;
  /** Seconds until a call answers, while the call button is lit. */
  readonly answering: number | undefined;
  /** Seconds the doors stay open before they close to rest. */
  readonly dwell: number;
  /** Press the call button: the doors open, then the floor picker. */
  readonly press: (reducedMotion?: boolean) => void;
  readonly setPickerOpen: (open: boolean) => void;
  /** Ride to a stop. */
  readonly call: (destination: LiftDestination) => void;
  /** Move the lift on by a frame's `seconds`. */
  readonly advance: (seconds: number, reducedMotion: boolean) => void;
}

function initialLift(): Pick<
  LiftStoreState,
  "lift" | "pickerOpen" | "restingDoors" | "answering" | "dwell"
> {
  return {
    lift: liftAt({ order: 0, location: lobby }),
    pickerOpen: true,
    restingDoors: 1,
    answering: undefined,
    dwell: 0,
  };
}

/** How shut the doors look: a ride's, or the resting doors' while it waits. */
export const shownDoors = ({
  lift,
  restingDoors,
}: Pick<LiftStoreState, "lift" | "restingDoors">): number =>
  lift.phase === "idle" ? restingDoors : lift.doors;

export const useLiftStore = create<LiftStoreState>()((set, get) => ({
  ...initialLift(),
  setPickerOpen: (pickerOpen) => {
    set({ pickerOpen });
  },
  press: (reducedMotion = false) => {
    const { lift, answering, restingDoors } = get();
    if (isRiding(lift) || answering !== undefined) {
      return;
    }
    if (restingDoors === 0 || reducedMotion) {
      set({ restingDoors: 0, dwell: dwellSeconds, pickerOpen: true });
      return;
    }
    set({ answering: answerSeconds });
  },
  call: (destination) => {
    const { lift: idle, restingDoors } = get();
    // The doors close from where they rest.
    const before =
      idle.phase === "idle" ? { ...idle, doors: restingDoors } : idle;
    const lift = callLift(before, destination);
    if (lift === before) {
      return;
    }
    set({ lift, answering: undefined });
    if (!isRiding(before)) {
      const camera = useCameraStore.getState();
      camera.registerView(liftViewName, liftView);
      camera.flyTo(liftViewName);
    }
  },
  advance: (seconds, reducedMotion) => {
    const state = get();
    const before = state.lift;
    const lift = advanceLift(before, seconds, { reducedMotion });
    if (lift !== before) {
      set({ lift });
      // Arrived: the new stop is in the scene, so the camera steps back.
      if (lift.at !== before.at) {
        useCameraStore.getState().flyTo(defaultView);
      }
      if (lift.phase === "idle") {
        // The doors are open: they rest open a while.
        set({ restingDoors: 0, dwell: dwellSeconds });
      }
      return;
    }
    if (lift.phase !== "idle") {
      return;
    }
    if (state.answering !== undefined) {
      const answering = state.answering - seconds;
      if (answering <= 0 || reducedMotion) {
        set({ answering: undefined, dwell: dwellSeconds, pickerOpen: true });
      } else {
        set({ answering });
      }
      return;
    }
    const step = reducedMotion ? 1 : seconds / doorSeconds;
    if (state.dwell > 0) {
      // Opening, if they were shut, then waiting open.
      set({
        restingDoors: Math.max(0, state.restingDoors - step),
        dwell: Math.max(0, state.dwell - seconds),
      });
    } else if (state.restingDoors < 1) {
      set({ restingDoors: Math.min(1, state.restingDoors + step) });
    }
  },
}));

/** Back in the lobby, idle, doors shut, with the picker open; for tests. */
export function resetLift(): void {
  useLiftStore.setState(initialLift());
}
