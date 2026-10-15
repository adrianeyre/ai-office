import { create } from "zustand";

import {
  advance,
  flyTo,
  queueMove,
  restingAt,
  type CameraPose,
  type CameraRigState,
} from "./camera-rig.ts";

// The camera's state for the scene and the HTML panels around it. Rooms
// register their own named views (a desk, the whiteboard) as they are built;
// the Office starts with the views of the empty Floor.

/** The named views every Floor has, in the order the view picker lists them. */
export const officeViews = {
  /** The default: a high three-quarter view down at the Floor. */
  overview: { position: [14, 16, 18], target: [0, 0, 0] },
  /** Straight down, like a floor plan (a little off vertical, so "up" is defined). */
  plan: { position: [0, 32, 0.5], target: [0, 0, 0] },
  /** Lower and closer, for a look across the Floor. */
  close: { position: [6, 4.5, 8], target: [0, 0.8, 0] },
} as const satisfies Record<string, CameraPose>;

export type OfficeView = keyof typeof officeViews;

export const defaultView: OfficeView = "overview";

/**
 * The view the camera rests at once it is moved by hand, by touch: where
 * the fingers left it, so closing a panel flies back there.
 */
export const handView = "by-hand";

/** The camera's vertical field of view, in degrees. */
export const cameraFov = 35;

export interface CameraState {
  /** Every named view the camera can go to. */
  readonly views: Readonly<Record<string, CameraPose>>;
  readonly rig: CameraRigState;
  /** Add or move a named view. */
  readonly registerView: (view: string, pose: CameraPose) => void;
  /** Fly to a view now, dropping moves still queued. */
  readonly flyTo: (view: string) => void;
  /** Fly to a view after the moves already queued. */
  readonly queueView: (view: string) => void;
  /** Move the camera on by a frame's `seconds`. */
  readonly advance: (seconds: number, reducedMotion: boolean) => void;
  /**
   * Put the camera where a touch gesture moved it, at once: it rests there
   * as `handView`, and a move under way or queued is dropped.
   */
  readonly placeByHand: (pose: CameraPose) => void;
}

function initialCamera(): Pick<CameraState, "views" | "rig"> {
  return {
    views: officeViews,
    rig: restingAt({ view: defaultView, pose: officeViews[defaultView] }),
  };
}

export const useCameraStore = create<CameraState>()((set, get) => {
  const move = (view: string) => {
    const pose = get().views[view];
    if (pose === undefined) {
      throw new Error(`There is no camera view named "${view}".`);
    }
    return { view, pose };
  };
  // Only a changed rig is set, so a camera at rest notifies no one.
  const setRig = (rig: CameraRigState) => {
    if (rig !== get().rig) {
      set({ rig });
    }
  };
  return {
    ...initialCamera(),
    registerView: (view, pose) => {
      set((state) => ({ views: { ...state.views, [view]: pose } }));
    },
    flyTo: (view) => {
      setRig(flyTo(get().rig, move(view)));
    },
    queueView: (view) => {
      setRig(queueMove(get().rig, move(view)));
    },
    advance: (seconds, reducedMotion) => {
      setRig(advance(get().rig, seconds, { reducedMotion }));
    },
    placeByHand: (pose) => {
      set((state) => ({
        views: { ...state.views, [handView]: pose },
        rig: restingAt({ view: handView, pose }),
      }));
    },
  };
});

/** Back to the overview with only the Office's own views; for tests. */
export function resetCamera(): void {
  useCameraStore.setState(initialCamera());
}
