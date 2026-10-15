import { seasonalActorIds, seasonalActors, type Role } from "@ai-office/shared";
import { seededRandom } from "@ai-office/shared/avatar";
import { beforeAll, describe, expect, it } from "vitest";

import { floorLayout, type FloorAgent } from "./floor-layout.ts";
import { pointAlong } from "./handoff-walks.ts";
import { liftDoorway } from "./lift-layout.ts";
import { lobbyPieces } from "./lobby-layout.ts";
import { provideModels } from "./models.ts";
import { footprint } from "./pieces.ts";
import { floorTreeSpot, lobbyTreeSpot } from "./seasonal-decor.ts";
import { createVisitScheduler } from "./seasonal-visitor.tsx";
import {
  floorVisit,
  floorWayBack,
  insideLift,
  leavingVisit,
  lobbyStops,
  lobbyVisit,
  playSeconds,
  playthings,
  visitGap,
  visitLiftDoors,
  visitPose,
  visitsPerTrip,
  type Visit,
  type VisitStep,
} from "./seasonal-visits.ts";
import { loadModelsFromDisk } from "./test-models.ts";
import { distance } from "./waypoints.ts";

beforeAll(async () => {
  provideModels(await loadModelsFromDisk());
});

const roles: Role[] = ["coder", "reviewer", "qa", "docs", "designer"];
const team = (size: number): FloorAgent[] =>
  Array.from({ length: size }, (_, index) => ({
    id: `agent-${String(index + 1)}`,
    role: index === 0 ? "manager" : (roles[index % roles.length] ?? "coder"),
  }));

/** A visit's stops. */
const stopsOf = (visit: Visit) =>
  visit.steps.filter(
    (step): step is Extract<VisitStep, { kind: "stop" }> =>
      step.kind === "stop",
  );

describe("a seasonal actor's visit", () => {
  it("comes out of the lift, makes its stops saying its piece, and goes back", () => {
    const layout = floorLayout(team(6));
    const agents = layout.desks.map(({ agentId }) => agentId);
    for (const actor of seasonalActorIds) {
      const visit = floorVisit(layout, actor, agents, undefined, {
        random: seededRandom(actor),
      });
      expect(visitPose(visit, 0)?.position).toEqual(insideLift);
      const stops = stopsOf(visit);
      expect(stops).toHaveLength(visitsPerTrip);
      for (const stop of stops) {
        expect(stop.bubble).toBeTruthy();
      }
      const last = visit.steps.at(-1);
      expect(last?.kind === "go" && last.path.at(-1)).toEqual(insideLift);
      expect(visitPose(visit, visit.seconds)).toBeUndefined();
    }
  });

  it("goes a different way each time, by Agents and things to play", () => {
    const layout = floorLayout(team(6));
    const agents = layout.desks.map(({ agentId }) => agentId);
    const ways = new Set<string>();
    const animations = new Set<string>();
    const deskStops = new Set(
      layout.desks.map(({ agentId }) => {
        const desk = layout.waypoints.waypoints.find(
          ({ id }) => id === `desk:${agentId}`,
        );
        return JSON.stringify(desk?.position);
      }),
    );
    let byAgents = 0;
    for (let seed = 0; seed < 40; seed += 1) {
      const visit = floorVisit(layout, "zombie", agents, undefined, {
        random: seededRandom(seed),
      });
      ways.add(
        JSON.stringify(
          visit.steps.flatMap((step) => (step.kind === "go" ? step.path : [])),
        ),
      );
      for (const stop of stopsOf(visit)) {
        animations.add(stop.animation);
        if (deskStops.has(JSON.stringify(stop.at))) {
          byAgents += 1;
          expect(stop.animation).toBe("scare");
        } else {
          expect(stop.seconds).toBe(playSeconds);
        }
      }
    }
    // Nearly every trip its own way round.
    expect(ways.size).toBeGreaterThan(35);
    expect(byAgents).toBeGreaterThan(0);
    // Darts, table tennis, pool and more among them.
    expect(animations).toContain("throw");
    expect(animations).toContain("swing");
    expect(animations).toContain("pool");
    const places = playthings(layout).map(({ location }) => location);
    expect(places).toContain("darts");
    expect(places).not.toContain("lounge-sofa");
    expect(places).not.toContain("treadmill");
  });

  it("has Santa say one of his lines at each stop and leave presents under the tree", () => {
    const layout = floorLayout(team(4));
    const desks = layout.desks.map(({ agentId }) => agentId);
    const visit = floorVisit(layout, "santa", desks, [...floorTreeSpot], {
      random: seededRandom("santa"),
    });
    const stops = stopsOf(visit);
    expect(stops).toHaveLength(visitsPerTrip + 1);
    for (const stop of stops) {
      expect(
        seasonalActors.santa.says.some((line) => stop.bubble?.endsWith(line)),
      ).toBe(true);
    }
    expect(stops.at(-1)?.animation).toBe("hand-over");
    const told = floorVisit(layout, "santa", desks, [...floorTreeSpot], {
      lines: ["Ho!", "Presents!"],
      random: () => 0.6,
    });
    for (const { bubble } of stopsOf(told)) {
      expect(bubble?.endsWith("Presents!")).toBe(true);
    }
    // No lines of its own: it says its usual ones.
    expect(seasonalActors.santa.says).toContain(
      stopsOf(lobbyVisit("santa", undefined, { lines: [] }))[0]?.bubble,
    );
    const lobby = lobbyVisit("santa", [...lobbyTreeSpot], {
      random: () => 0,
    });
    expect(lobby.steps.filter((step) => step.kind === "stop")).toHaveLength(2);
  });

  it("walks for Santa, runs for Halloween's frights, floats for the ghost alone and hops for the Easter Bunny", () => {
    const moving = (actor: (typeof seasonalActorIds)[number]) =>
      visitPose(lobbyVisit(actor), 0.5)?.animation;
    expect(moving("santa")).toBe("walk");
    expect(moving("skeleton")).toBe("run");
    expect(moving("ghost")).toBe("float");
    expect(moving("easter-bunny")).toBe("hop");
    expect(moving("drunk-man")).toBe("stagger");
    expect(
      seasonalActorIds.filter((actor) => moving(actor) === "float"),
    ).toEqual(["ghost"]);
    expect(
      stopsOf(lobbyVisit("drunk-woman", undefined, { random: () => 0 }))[0]
        ?.animation,
    ).toBe("sway");
    // Running, it is round quicker than walking.
    expect(
      lobbyVisit("skeleton", undefined, { random: () => 0.3 }).seconds,
    ).toBeLessThan(
      lobbyVisit("santa", undefined, { random: () => 0.3 }).seconds,
    );
  });

  it("goes round the lobby a different way each time, clear of its furniture", () => {
    const furniture = lobbyPieces
      .filter(
        (piece) =>
          piece.position[1] - piece.size[1] / 2 < 1.5 &&
          piece.position[1] + piece.size[1] / 2 > 0.1,
      )
      .map((piece) => footprint(piece));
    const ways = new Set<string>();
    for (let seed = 0; seed < 30; seed += 1) {
      const visit = lobbyVisit("witch", undefined, {
        random: seededRandom(seed),
      });
      const path = visit.steps.flatMap((step) =>
        step.kind === "go" ? step.path : [],
      );
      ways.add(JSON.stringify(path));
      expect(stopsOf(visit).length).toBeGreaterThan(0);
      // Every 5 cm along the way, out of the lift, clear of everything.
      for (const step of visit.steps) {
        if (step.kind !== "go") {
          continue;
        }
        const length = step.path.reduce(
          (sum, point, index) =>
            sum + distance(step.path[index - 1] ?? point, point),
          0,
        );
        for (let along = 0; along <= length; along += 0.05) {
          const [x, z] = pointAlong(step.path, along);
          const hit = furniture.find(
            (rect) =>
              z > liftDoorway.position[2] + 0.2 &&
              x > rect.x[0] &&
              x < rect.x[1] &&
              z > rect.z[0] &&
              z < rect.z[1],
          );
          if (hit !== undefined) {
            expect.fail(`${String(x)}, ${String(z)} is in the furniture`);
          }
        }
      }
    }
    expect(ways.size).toBeGreaterThan(20);
    expect(Object.keys(lobbyStops)).toContain("reception");
  });

  it("holds the lift's doors open while near them", () => {
    const visit = lobbyVisit("vampire");
    expect(visitLiftDoors(visitPose(visit, 0))).toBe(1);
    const middle = visit.steps.find((step) => step.kind === "stop");
    expect(
      visitLiftDoors(
        middle?.kind === "stop"
          ? {
              position: middle.at,
              heading: 0,
              animation: "idle",
              bubble: undefined,
            }
          : undefined,
      ),
    ).toBe(0);
  });
});

describe("the visits' schedule", () => {
  it("sends nobody out of season, and one actor at a time in season", () => {
    const scheduler = createVisitScheduler(() => 0);
    const plan = (actor: (typeof seasonalActorIds)[number]) =>
      lobbyVisit(actor);
    scheduler.advance(1000, [], plan);
    expect(scheduler.visit()).toBeUndefined();
    // The first comes after visitGap.first's least.
    scheduler.advance(visitGap.first[0] - 1, ["ghost", "vampire"], plan);
    expect(scheduler.visit()).toBeUndefined();
    scheduler.advance(2, ["ghost", "vampire"], plan);
    expect(scheduler.visit()?.actor).toBe("ghost");
    expect(scheduler.liftDoors()).toBe(1);
    const seconds = scheduler.visit()?.seconds ?? 0;
    scheduler.advance(seconds + 1, ["ghost", "vampire"], plan);
    expect(scheduler.visit()).toBeUndefined();
    expect(scheduler.pose()).toBeUndefined();
  });

  it("calls an actor at once, one at a time, and sends it away", () => {
    const scheduler = createVisitScheduler(() => 0);
    const plan = (actor: (typeof seasonalActorIds)[number]) =>
      lobbyVisit(actor);
    scheduler.call();
    scheduler.advance(0.01, ["elf"], plan);
    const first = scheduler.visit();
    expect(first?.actor).toBe("elf");
    scheduler.advance(3, ["elf"], plan);
    // A second call while one visits brings nobody else.
    scheduler.call();
    scheduler.advance(0.01, ["elf"], plan);
    expect(scheduler.visit()).toBe(first);
    scheduler.dismiss();
    const leaving = scheduler.visit();
    expect(leaving).not.toBe(first);
    expect(leaving?.steps.some((step) => step.kind === "stop")).toBe(false);
    scheduler.advance((leaving?.seconds ?? 0) + 0.1, ["elf"], plan);
    expect(scheduler.visit()).toBeUndefined();
    // The next comes by itself only after a while.
    scheduler.advance(1, ["elf"], plan);
    expect(scheduler.visit()).toBeUndefined();
  });
});

describe("an actor sent away", () => {
  it("goes from where it is back to the lift, on a Floor the short way", () => {
    const layout = floorLayout(team(6));
    const visit = floorVisit(
      layout,
      "zombie",
      layout.desks.map(({ agentId }) => agentId),
      undefined,
      { random: seededRandom("sent away") },
    );
    const elapsed = visit.seconds * 0.6;
    const leaving = leavingVisit(visit, elapsed, (way) =>
      floorWayBack(layout, way),
    );
    expect(leaving?.actor).toBe("zombie");
    expect(leaving?.steps.some((step) => step.kind === "stop")).toBe(false);
    expect(leaving && visitPose(leaving, 0)?.position).toEqual(
      visitPose(visit, elapsed)?.position,
    );
    const last = leaving?.steps.at(-1);
    expect(last?.kind === "go" && last.path.at(-1)).toEqual(insideLift);
    expect(leaving?.seconds ?? Infinity).toBeLessThan(visit.seconds);
  });

  it("in the lobby goes back the way it came", () => {
    const visit = lobbyVisit("witch");
    const leaving = leavingVisit(visit, 3);
    const last = leaving?.steps.at(-1);
    expect(last?.kind === "go" && last.path.at(-1)).toEqual(insideLift);
    expect(leaving && visitPose(leaving, 0)?.position).toEqual(
      visitPose(visit, 3)?.position,
    );
  });
});
