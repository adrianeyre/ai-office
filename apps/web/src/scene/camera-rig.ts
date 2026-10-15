// The camera rig: where the camera is, the named view it rests at, and the
// eased moves queued between views (PRD §7, Motion: "eased camera moves
// between every view"). Pure data and functions, so the queue is tested
// without WebGL; the scene's `CameraRig` component advances it every frame
// and puts the camera where it says.

export type Vec3 = readonly [number, number, number];

/** Where the camera is, and the point it looks at. 1 unit is 1 metre. */
export interface CameraPose {
  readonly position: Vec3;
  readonly target: Vec3;
}

/** A move to a named view. */
export interface CameraMove {
  readonly view: string;
  readonly pose: CameraPose;
}

/** The move under way. */
export interface CameraFlight {
  readonly view: string;
  readonly from: CameraPose;
  readonly to: CameraPose;
  /** Seconds the whole move takes. */
  readonly duration: number;
  /** Seconds of it already flown. */
  readonly elapsed: number;
}

export interface CameraRigState {
  /** Where the camera is now. */
  readonly pose: CameraPose;
  /** The named view the camera rests at, or undefined while it moves. */
  readonly view: string | undefined;
  readonly flight: CameraFlight | undefined;
  /** Moves still to make, in order, after the flight. */
  readonly queue: readonly CameraMove[];
}

export interface AdvanceOptions {
  /** Cut straight to where the moves end, with no transition (PRD §7). */
  readonly reducedMotion: boolean;
}

/** The shortest and longest a move takes, in seconds. */
export const minimumFlight = 0.8;
export const maximumFlight = 1.8;

/** A rig at rest at a view, with nothing to do. */
export function restingAt(move: CameraMove): CameraRigState {
  return { pose: move.pose, view: move.view, flight: undefined, queue: [] };
}

/** The view the camera will rest at once every move is made. */
export function destination(rig: CameraRigState): string | undefined {
  return rig.queue.at(-1)?.view ?? rig.flight?.view ?? rig.view;
}

/** Whether the camera is moving, or has moves still to make. */
export function isMoving(rig: CameraRigState): boolean {
  return rig.flight !== undefined || rig.queue.length > 0;
}

/**
 * Fly to a view now: moves still queued are dropped, and a move under way
 * turns towards the new view from wherever the camera is. Asking for the
 * view the camera already rests at, or is already flying to with nothing
 * after it, changes nothing.
 */
export function flyTo(rig: CameraRigState, move: CameraMove): CameraRigState {
  if (rig.queue.length === 0 && destination(rig) === move.view) {
    return rig;
  }
  return {
    pose: rig.pose,
    view: rig.flight === undefined ? rig.view : undefined,
    flight: undefined,
    queue: [move],
  };
}

/**
 * Queue a move after the moves already queued, such as backing out to the
 * overview before flying into a desk. A move to where the last one already
 * ends is dropped.
 */
export function queueMove(
  rig: CameraRigState,
  move: CameraMove,
): CameraRigState {
  return destination(rig) === move.view
    ? rig
    : { ...rig, queue: [...rig.queue, move] };
}

/**
 * The rig `seconds` later. Moves are flown one after another, eased in and
 * out; time left over when one lands carries into the next. With reduced
 * motion, every move (including one under way) is cut to its end at once.
 * Returns the same object when there is nothing to do.
 */
export function advance(
  rig: CameraRigState,
  seconds: number,
  { reducedMotion }: AdvanceOptions,
): CameraRigState {
  if (!isMoving(rig)) {
    return rig;
  }
  if (reducedMotion) {
    const last = rig.queue.at(-1) ?? rig.flight;
    return last === undefined
      ? rig
      : restingAt({
          view: last.view,
          pose: "pose" in last ? last.pose : last.to,
        });
  }

  let { pose, view, flight, queue } = rig;
  let remaining = Math.max(0, seconds);
  for (;;) {
    if (flight === undefined) {
      const [next, ...rest] = queue;
      if (next === undefined) {
        return { pose, view, flight, queue };
      }
      queue = rest;
      flight = {
        view: next.view,
        from: pose,
        to: next.pose,
        duration: flightDuration(pose, next.pose),
        elapsed: 0,
      };
      view = undefined;
    }
    const elapsed = flight.elapsed + remaining;
    if (elapsed >= flight.duration) {
      remaining = elapsed - flight.duration;
      pose = flight.to;
      view = flight.view;
      flight = undefined;
      continue;
    }
    flight = { ...flight, elapsed };
    pose = interpolatePose(
      flight.from,
      flight.to,
      easeInOutCubic(elapsed / flight.duration),
    );
    return { pose, view, flight, queue };
  }
}

/**
 * How long a move takes: longer the further it goes, from
 * `minimumFlight` to `maximumFlight` seconds. A move that goes nowhere takes
 * no time at all.
 */
export function flightDuration(from: CameraPose, to: CameraPose): number {
  const distance = Math.max(
    distanceBetween(from.position, to.position),
    distanceBetween(from.target, to.target),
  );
  if (distance < 1e-6) {
    return 0;
  }
  return Math.min(maximumFlight, minimumFlight + distance * 0.04);
}

/** Slow out, fast through the middle, slow in. */
export function easeInOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped < 0.5 ? 4 * clamped ** 3 : 1 - (-2 * clamped + 2) ** 3 / 2;
}

export function interpolatePose(
  from: CameraPose,
  to: CameraPose,
  t: number,
): CameraPose {
  return {
    position: lerp(from.position, to.position, t),
    target: lerp(from.target, to.target, t),
  };
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function distanceBetween(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
