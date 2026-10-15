import { describe, expect, it } from "vitest";

import {
  advance,
  destination,
  easeInOutCubic,
  flightDuration,
  flyTo,
  isMoving,
  maximumFlight,
  minimumFlight,
  queueMove,
  restingAt,
  type CameraMove,
  type CameraPose,
  type CameraRigState,
} from "./camera-rig.ts";

const pose = (x: number): CameraPose => ({
  position: [x, 10, 10],
  target: [x, 0, 0],
});

const overview: CameraMove = { view: "overview", pose: pose(0) };
const desk: CameraMove = { view: "desk", pose: pose(10) };
const whiteboard: CameraMove = { view: "whiteboard", pose: pose(-10) };

const motion = { reducedMotion: false };
const reduced = { reducedMotion: true };

/** Advance in frames of 1/60 s until the rig rests, or give up. */
function settle(rig: CameraRigState): { rig: CameraRigState; frames: number } {
  let frames = 0;
  while (isMoving(rig) && frames < 10_000) {
    rig = advance(rig, 1 / 60, motion);
    frames += 1;
  }
  return { rig, frames };
}

describe("the camera transition queue", () => {
  it("starts at rest at its view, with nothing to do", () => {
    const rig = restingAt(overview);
    expect(rig).toEqual({
      pose: overview.pose,
      view: "overview",
      flight: undefined,
      queue: [],
    });
    expect(isMoving(rig)).toBe(false);
    expect(advance(rig, 1, motion)).toBe(rig);
  });

  it("flies to a view, eased, and comes to rest exactly at it", () => {
    let rig = flyTo(restingAt(overview), desk);
    expect(destination(rig)).toBe("desk");
    const duration = flightDuration(overview.pose, desk.pose);

    rig = advance(rig, duration / 4, motion);
    expect(rig.view).toBeUndefined();
    expect(rig.flight?.view).toBe("desk");
    // A quarter of the time covers less than a quarter of the way: it eases in.
    const quarter = rig.pose.position[0] / 10;
    expect(quarter).toBeGreaterThan(0);
    expect(quarter).toBeLessThan(0.25);
    expect(quarter).toBeCloseTo(easeInOutCubic(0.25));

    rig = advance(rig, duration / 4, motion);
    expect(rig.pose.position[0]).toBeCloseTo(5);
    expect(rig.pose.target[0]).toBeCloseTo(5);

    rig = advance(rig, duration, motion);
    expect(rig).toEqual(restingAt(desk));
  });

  it("flies queued moves one after another, carrying time over between them", () => {
    let rig = queueMove(queueMove(restingAt(overview), desk), whiteboard);
    expect(rig.queue.map((move) => move.view)).toEqual(["desk", "whiteboard"]);
    expect(destination(rig)).toBe("whiteboard");

    const first = flightDuration(overview.pose, desk.pose);
    const second = flightDuration(desk.pose, whiteboard.pose);
    // Past the end of the first move: the rest of the time goes to the second.
    rig = advance(rig, first + second / 2, motion);
    expect(rig.flight?.view).toBe("whiteboard");
    expect(rig.flight?.from).toEqual(desk.pose);
    expect(rig.flight?.elapsed).toBeCloseTo(second / 2);
    expect(rig.pose.position[0]).toBeCloseTo(0);
    expect(rig.queue).toEqual([]);

    expect(settle(rig).rig).toEqual(restingAt(whiteboard));
  });

  it("lands every queued move it can within one long frame", () => {
    const rig = queueMove(queueMove(restingAt(overview), desk), whiteboard);
    expect(advance(rig, 60, motion)).toEqual(restingAt(whiteboard));
  });

  it("turns a move under way towards a new view from where the camera is, dropping the queue", () => {
    let rig = queueMove(queueMove(restingAt(overview), desk), overview);
    rig = advance(rig, flightDuration(overview.pose, desk.pose) / 2, motion);
    const midway = rig.pose;
    expect(midway.position[0]).toBeCloseTo(5);

    rig = flyTo(rig, whiteboard);
    expect(rig.queue).toEqual([whiteboard]);
    expect(rig.flight).toBeUndefined();
    expect(rig.view).toBeUndefined();
    expect(rig.pose).toBe(midway);

    rig = advance(rig, 1 / 60, motion);
    expect(rig.flight?.from).toEqual(midway);
    expect(rig.flight?.to).toEqual(whiteboard.pose);
    expect(settle(rig).rig).toEqual(restingAt(whiteboard));
  });

  it("ignores a move to where the camera already rests or is already going", () => {
    const resting = restingAt(overview);
    expect(flyTo(resting, overview)).toBe(resting);
    expect(queueMove(resting, overview)).toBe(resting);

    const flying = advance(flyTo(resting, desk), 0.1, motion);
    expect(flyTo(flying, desk)).toBe(flying);
    expect(queueMove(flying, desk)).toBe(flying);

    const queued = queueMove(flying, whiteboard);
    expect(queueMove(queued, whiteboard)).toBe(queued);
    // Flying to the last queued view now skips the moves before it.
    expect(flyTo(queued, whiteboard).queue).toEqual([whiteboard]);
  });

  it("goes back to a view it left, after a move away", () => {
    const rig = queueMove(queueMove(restingAt(overview), desk), overview);
    expect(rig.queue).toHaveLength(2);
    expect(settle(rig).rig).toEqual(restingAt(overview));
  });

  it("cuts straight to the last view with reduced motion, even mid-flight", () => {
    const queued = queueMove(queueMove(restingAt(overview), desk), whiteboard);
    expect(advance(queued, 0, reduced)).toEqual(restingAt(whiteboard));

    const flying = advance(flyTo(restingAt(overview), desk), 0.2, motion);
    expect(flying.flight).toBeDefined();
    expect(advance(flying, 0, reduced)).toEqual(restingAt(desk));

    // A queue behind a flight ends at the queue's last view.
    expect(advance(queueMove(flying, whiteboard), 0, reduced)).toEqual(
      restingAt(whiteboard),
    );
  });

  it("ignores negative time", () => {
    const rig = advance(flyTo(restingAt(overview), desk), 0.3, motion);
    const after = advance(rig, -1, motion);
    expect(after.pose).toEqual(rig.pose);
    expect(after.flight?.elapsed).toBe(rig.flight?.elapsed);
  });

  it("makes a move that goes nowhere at once", () => {
    const twin: CameraMove = { view: "twin", pose: overview.pose };
    expect(advance(flyTo(restingAt(overview), twin), 0, motion)).toEqual(
      restingAt(twin),
    );
  });
});

describe("a move's duration", () => {
  it("is longer the further the camera goes, within its bounds", () => {
    const near = flightDuration(pose(0), pose(1));
    const far = flightDuration(pose(0), pose(10));
    expect(near).toBeGreaterThanOrEqual(minimumFlight);
    expect(far).toBeGreaterThan(near);
    expect(flightDuration(pose(0), pose(1000))).toBe(maximumFlight);
    expect(flightDuration(pose(0), pose(0))).toBe(0);
  });

  it("counts the target's move as well as the camera's", () => {
    const turn: CameraPose = { position: [0, 10, 10], target: [20, 0, 0] };
    expect(flightDuration(pose(0), turn)).toBeGreaterThan(minimumFlight);
  });
});

describe("the easing", () => {
  it("starts and ends still, and is symmetric", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(0.1) + easeInOutCubic(0.9)).toBeCloseTo(1);
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
    // Slow at the ends, fast through the middle.
    expect(easeInOutCubic(0.05)).toBeLessThan(0.05);
    expect(easeInOutCubic(0.55) - easeInOutCubic(0.45)).toBeGreaterThan(0.1);
  });
});
