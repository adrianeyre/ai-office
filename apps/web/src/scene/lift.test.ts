import type { Floor, Notice } from "@ai-office/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { destination } from "./camera-rig.ts";
import { defaultView, resetCamera, useCameraStore } from "./camera-store.ts";
import {
  advanceLift,
  callLift,
  doorSeconds,
  isRiding,
  liftAt,
  liftDestination,
  liftLocation,
  maximumTravel,
  minimumTravel,
  travelDuration,
  type LiftState,
} from "./lift.ts";
import { liftViewName, resetLift, useLiftStore } from "./lift-store.ts";
import { liftStops, lobby, sameLocation, stopAt } from "./lift-stops.ts";

// The lift and its floor picker (PRD FR-57): its stops, the ride, and the
// store that ties it to the camera.

const floor = (id: string, name: string, archivedAt: string | null = null) =>
  ({
    id,
    name,
    repository: `adrianeyre/${id}`,
    githubRepositoryId: 1,
    template: { id: "development", name: "Development" },
    theme: "office",
    defaultBranch: "main",
    setupCommand: "",
    testCommand: "",
    mergePolicy: "send_to_me",
    roundCap: 3,
    tokenCaps: { daily: null, monthly: null },
    concurrencyLimit: null,
    priority: 0,
    requiredReviewerAgentIds: [],
    planApproval: true,
    mostAgents: 8,
    spinOffFromChat: true,
    hourlyStatusUpdates: true,
    freshStartThreshold: 85,
    gitIdentity: null,
    createdAt: "2026-10-08T12:00:00.000Z",
    archivedAt,
  }) satisfies Floor;

const notice = (id: string, overrides: Partial<Notice>): Notice => ({
  id,
  kind: "action",
  title: "PR #14 awaiting your approval",
  floorId: "web-shop",
  agentId: null,
  issue: null,
  pullRequest: null,
  ciRunUrl: null,
  actions: [],
  createdAt: "2026-10-08T12:00:00.000Z",
  dismissedAt: null,
  actedAt: null,
  actedOn: null,
  links: [],
  positions: [],
  ...overrides,
});

const webShop = {
  order: 1,
  location: { kind: "floor", floorId: "web-shop" },
} as const;
const blog = {
  order: 2,
  location: { kind: "floor", floorId: "blog" },
} as const;
const theLobby = { order: 0, location: lobby } as const;
const moving = { reducedMotion: false };

/** The lift after `seconds`, a frame of 1/60 s at a time. */
function run(lift: LiftState, seconds: number): LiftState {
  let state = lift;
  for (let frame = 0; frame < Math.round(seconds * 60); frame += 1) {
    state = advanceLift(state, 1 / 60, moving);
  }
  return state;
}

describe("the lift's stops", () => {
  it("are the lobby, then each Floor in use, in order", () => {
    const stops = liftStops(
      [
        floor("web-shop", "Web shop"),
        floor("old", "Old", "2026-10-01T00:00:00.000Z"),
        floor("blog", "Blog"),
      ],
      [],
    );
    expect(
      stops.map(({ order, name, repository }) => [order, name, repository]),
    ).toEqual([
      [0, "Lobby", undefined],
      [1, "Web shop", "adrianeyre/web-shop"],
      [2, "Blog", "adrianeyre/blog"],
    ]);
    expect(stops[1]?.location).toEqual({ kind: "floor", floorId: "web-shop" });
    expect(stopAt(stops, lobby)?.name).toBe("Lobby");
    expect(stopAt(stops, { kind: "floor", floorId: "old" })).toBeUndefined();
  });

  it("count each Floor's open action Notices, and the lobby the Office's own", () => {
    const stops = liftStops(
      [floor("web-shop", "Web shop"), floor("blog", "Blog")],
      [
        notice("1", { floorId: "web-shop" }),
        notice("2", { floorId: "web-shop" }),
        notice("3", { floorId: "web-shop", kind: "info" }),
        notice("4", {
          floorId: "web-shop",
          dismissedAt: "2026-10-08T13:00:00.000Z",
        }),
        notice("5", { floorId: "blog", kind: "info" }),
        notice("6", { floorId: null }),
        notice("7", { floorId: "gone" }),
      ],
    );
    expect(
      stops.map(({ name, actionNotices }) => [name, actionNotices]),
    ).toEqual([
      ["Lobby", 1],
      ["Web shop", 2],
      ["Blog", 0],
    ]);
  });

  it("tell places apart", () => {
    expect(sameLocation(lobby, { kind: "lobby" })).toBe(true);
    expect(sameLocation(lobby, webShop.location)).toBe(false);
    expect(
      sameLocation(webShop.location, { kind: "floor", floorId: "web-shop" }),
    ).toBe(true);
    expect(sameLocation(webShop.location, blog.location)).toBe(false);
  });
});

describe("the lift's ride", () => {
  it("waits in the lobby, doors open, with nothing to do", () => {
    const lift = liftAt(theLobby);
    expect(lift).toMatchObject({ phase: "idle", doors: 0, car: 0 });
    expect(liftLocation(lift)).toEqual(lobby);
    expect(isRiding(lift)).toBe(false);
    expect(advanceLift(lift, 1, moving)).toBe(lift);
  });

  it("closes its doors, travels and opens them on the new stop, which is shown only on arrival", () => {
    let lift = callLift(liftAt(theLobby), webShop);
    expect(lift.phase).toBe("closing");
    expect(isRiding(lift)).toBe(true);
    expect(liftDestination(lift)).toBe(webShop);

    lift = advanceLift(lift, doorSeconds / 2, moving);
    expect(lift.doors).toBeCloseTo(0.5);
    expect(liftLocation(lift)).toEqual(lobby);

    lift = advanceLift(lift, doorSeconds / 2 + 0.01, moving);
    expect(lift.phase).toBe("travelling");
    expect(lift.doors).toBe(1);
    expect(lift.car).toBeGreaterThan(0);
    expect(lift.car).toBeLessThan(1);
    // Still the lobby behind the closed doors.
    expect(liftLocation(lift)).toEqual(lobby);

    lift = advanceLift(lift, travelDuration(1), moving);
    expect(lift.phase).toBe("opening");
    expect(lift.car).toBe(1);
    expect(liftLocation(lift)).toEqual(webShop.location);
    expect(isRiding(lift)).toBe(false);

    lift = advanceLift(lift, doorSeconds, moving);
    expect(lift).toMatchObject({ phase: "idle", doors: 0, car: 1 });
  });

  it("eases the car between stops", () => {
    let lift = run(callLift(liftAt(theLobby), blog), doorSeconds);
    const duration = travelDuration(2);
    const positions: number[] = [];
    for (let step = 0; step < 4; step += 1) {
      lift = advanceLift(lift, duration / 4 - 1e-6, moving);
      positions.push(lift.car);
    }
    const [quarter = 0, half = 0, threeQuarters = 0] = positions;
    // Slow, fast, slow: the middle half covers more than either end.
    expect(quarter).toBeLessThan(0.5);
    expect(half).toBeCloseTo(1, 1);
    expect(threeQuarters - quarter).toBeGreaterThan(quarter);
    expect(2 - threeQuarters).toBeLessThan(0.5);
  });

  it("takes longer the further it goes, within its bounds", () => {
    expect(travelDuration(1)).toBeGreaterThanOrEqual(minimumTravel);
    expect(travelDuration(3)).toBeGreaterThan(travelDuration(1));
    expect(travelDuration(-3)).toBe(travelDuration(3));
    expect(travelDuration(100)).toBe(maximumTravel);
  });

  it("carries time left over from one phase into the next", () => {
    const lift = advanceLift(
      callLift(liftAt(theLobby), webShop),
      doorSeconds + travelDuration(1) + doorSeconds / 2,
      moving,
    );
    expect(lift.phase).toBe("opening");
    expect(lift.doors).toBeCloseTo(0.5);
    expect(
      advanceLift(callLift(liftAt(theLobby), webShop), 60, moving),
    ).toEqual(liftAt(webShop));
  });

  it("ignores a call to where it is, or is already going", () => {
    const idle = liftAt(theLobby);
    expect(callLift(idle, theLobby)).toBe(idle);
    const going = callLift(idle, webShop);
    expect(callLift(going, webShop)).toBe(going);
    const travelling = run(going, doorSeconds + 0.2);
    expect(callLift(travelling, webShop)).toBe(travelling);
  });

  it("goes to a new stop if called while its doors close", () => {
    const lift = callLift(
      advanceLift(callLift(liftAt(theLobby), webShop), 0.2, moving),
      blog,
    );
    expect(lift.phase).toBe("closing");
    expect(liftDestination(lift)).toBe(blog);
    expect(run(lift, 5)).toEqual(liftAt(blog));
  });

  it("opens its doors again if called back to the stop it is leaving", () => {
    const closing = advanceLift(
      callLift(liftAt(theLobby), webShop),
      0.3,
      moving,
    );
    const back = callLift(closing, theLobby);
    expect(back.phase).toBe("opening");
    expect(back.doors).toBeCloseTo(0.5);
    expect(isRiding(back)).toBe(false);
    expect(run(back, 1)).toEqual(liftAt(theLobby));
  });

  it("turns towards a new stop from where the car is, mid-travel", () => {
    const travelling = run(callLift(liftAt(theLobby), blog), doorSeconds + 0.6);
    expect(travelling.phase).toBe("travelling");
    const car = travelling.car;
    const turned = callLift(travelling, webShop);
    expect(turned.travel).toMatchObject({ from: car, elapsed: 0 });
    expect(turned.travel?.duration).toBe(travelDuration(1 - car));
    expect(run(turned, 5)).toEqual(liftAt(webShop));
  });

  it("is there at once with reduced motion, even mid-ride", () => {
    const reduced = { reducedMotion: true };
    expect(
      advanceLift(callLift(liftAt(theLobby), webShop), 0, reduced),
    ).toEqual(liftAt(webShop));
    const travelling = run(callLift(liftAt(theLobby), blog), doorSeconds + 0.3);
    expect(advanceLift(travelling, 0.01, reduced)).toEqual(liftAt(blog));
  });

  it("ignores negative time", () => {
    const lift = callLift(liftAt(theLobby), webShop);
    expect(advanceLift(lift, -1, moving).doors).toBe(0);
  });
});

describe("the lift store", () => {
  beforeEach(() => {
    resetLift();
    resetCamera();
  });

  it("starts in the lobby with the floor picker open", () => {
    const { lift, pickerOpen } = useLiftStore.getState();
    expect(liftLocation(lift)).toEqual(lobby);
    expect(pickerOpen).toBe(true);
    useLiftStore.getState().setPickerOpen(false);
    expect(useLiftStore.getState().pickerOpen).toBe(false);
  });

  it("flies the camera to the lift doors when called, and back to the overview on arrival", () => {
    useLiftStore.getState().call(webShop);
    expect(destination(useCameraStore.getState().rig)).toBe(liftViewName);

    // A second call mid-ride leaves the camera where it is going.
    useLiftStore.getState().call(blog);
    expect(destination(useCameraStore.getState().rig)).toBe(liftViewName);

    const store = useLiftStore.getState();
    store.advance(doorSeconds + 0.1, false);
    expect(liftLocation(useLiftStore.getState().lift)).toEqual(lobby);
    expect(destination(useCameraStore.getState().rig)).toBe(liftViewName);

    useLiftStore.getState().advance(maximumTravel, false);
    expect(liftLocation(useLiftStore.getState().lift)).toEqual(blog.location);
    expect(destination(useCameraStore.getState().rig)).toBe(defaultView);
  });

  it("notifies no one while the lift is idle", () => {
    let notified = 0;
    const unsubscribe = useLiftStore.subscribe(() => {
      notified += 1;
    });
    useLiftStore.getState().advance(1 / 60, false);
    useLiftStore.getState().call(theLobby);
    unsubscribe();
    expect(notified).toBe(0);
  });

  it("is on the new stop by the next frame with reduced motion", () => {
    useLiftStore.getState().call(webShop);
    useLiftStore.getState().advance(1 / 60, true);
    expect(useLiftStore.getState().lift).toEqual(liftAt(webShop));
    expect(destination(useCameraStore.getState().rig)).toBe(defaultView);
  });
});
