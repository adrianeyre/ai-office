import { seasonalEventIds, type Role } from "@ai-office/shared";
import { paletteTokens } from "@ai-office/shared/palette";
import { beforeAll, describe, expect, it } from "vitest";

import { avatarTriangleBudget, shapesGeometry } from "./avatar-geometry.ts";
import type { Rect } from "./desk-set.ts";
import { floorLayout, meetingTable, type FloorAgent } from "./floor-layout.ts";
import { lobbySize, lobbyWalkways } from "./lobby-layout.ts";
import { placedSize, provideModels } from "./models.ts";
import { triangles } from "./piece-geometry.ts";
import { footprint } from "./pieces.ts";
import {
  floorDecor,
  floorSpots,
  floorTreeSpot,
  lobbyDecor,
  lobbySpots,
  allDecorations,
  lobbyTreeRadius,
  lobbyTreeSpot,
  partyFood,
  nibbles,
  eggClearance,
  floorEggSpots,
  halloweenFood,
  lobbyEggSpots,
  type Decor,
} from "./seasonal-decor.ts";
import { loadModelsFromDisk } from "./test-models.ts";
import { distance, type FloorPoint } from "./waypoints.ts";

beforeAll(async () => {
  provideModels(await loadModelsFromDisk());
});

const roles: Role[] = ["coder", "reviewer", "qa", "docs", "designer"];
const team = (size: number): FloorAgent[] =>
  Array.from({ length: size }, (_, index) => ({
    id: `agent-${String(index + 1)}`,
    role: index === 0 ? "manager" : (roles[index % roles.length] ?? "coder"),
  }));

const around = ([x, z]: readonly [number, number], half: number): Rect => ({
  x: [x - half, x + half],
  z: [z - half, z + half],
});

const overlaps = (a: Rect, b: Rect) =>
  a.x[0] < b.x[1] && b.x[0] < a.x[1] && a.z[0] < b.z[1] && b.z[0] < a.z[1];

/** How far a point is from the segment from `a` to `b`. */
function fromSegment(
  [x, z]: FloorPoint,
  [ax, az]: FloorPoint,
  [bx, bz]: FloorPoint,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(
    0,
    Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)),
  );
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
}

describe("the seasonal decorations", () => {
  it("keep the lobby's walkways clear, and stay inside its walls", () => {
    const placed = [
      around(lobbyTreeSpot, lobbyTreeRadius),
      ...lobbySpots.map((spot) => around(spot, 0.25)),
    ];
    for (const rect of placed) {
      for (const walkway of lobbyWalkways) {
        expect(overlaps(rect, walkway), walkway.name).toBe(false);
      }
    }
    for (const event of seasonalEventIds) {
      for (const { at } of lobbyDecor([event]).lights) {
        expect(Math.abs(at[0])).toBeLessThan(lobbySize.width / 2);
        expect(Math.abs(at[2])).toBeLessThan(lobbySize.depth / 2);
        expect(at[1]).toBeLessThan(lobbySize.ceiling);
        expect(at[1]).toBeGreaterThan(0);
      }
    }
  });

  it.each([1, 4, 8, 12])(
    "keep clear of everything on a Floor of %i Agents, and of every path",
    (size) => {
      const layout = floorLayout(team(size));
      const taken: Rect[] = [
        ...layout.pieces
          .filter(
            (piece) =>
              piece.position[1] + piece.size[1] / 2 > 0.05 &&
              piece.position[1] - piece.size[1] / 2 < 2.9,
          )
          .map((piece) => footprint(piece)),
        ...layout.models.map((placement): Rect => {
          const [width, , depth] = placedSize(placement);
          const [x, , z] = placement.position;
          return {
            x: [x - width / 2, x + width / 2],
            z: [z - depth / 2, z + depth / 2],
          };
        }),
      ];
      const byId = new Map(
        layout.waypoints.waypoints.map(({ id, position }) => [id, position]),
      );
      const spots: [readonly [number, number], number][] = [
        [floorTreeSpot, 0.5],
        ...floorSpots.map((spot): [readonly [number, number], number] => [
          spot,
          0.25,
        ]),
      ];
      for (const [spot, half] of spots) {
        for (const rect of taken) {
          expect(overlaps(around(spot, half), rect), String(spot)).toBe(false);
        }
        for (const [a, b] of layout.waypoints.edges) {
          const from = byId.get(a);
          const to = byId.get(b);
          if (from === undefined || to === undefined) {
            continue;
          }
          // Half an Agent's shoulders past the decoration.
          expect(
            fromSegment([spot[0], spot[1]], from, to),
            `${String(spot)} by ${a} to ${b}`,
          ).toBeGreaterThan(half + 0.2);
        }
      }
      for (const event of seasonalEventIds) {
        for (const { at } of floorDecor([event], layout.bounds).lights) {
          expect(at[0]).toBeGreaterThan(layout.bounds.x[0]);
          expect(at[0]).toBeLessThan(layout.bounds.x[1]);
          expect(at[2]).toBeGreaterThan(layout.bounds.z[0]);
          expect(at[2]).toBeLessThan(layout.bounds.z[1]);
        }
      }
    },
  );

  it("put New Year's nibbles on the meeting room table's top", () => {
    const [cx, cz] = meetingTable.centre;
    const [width, depth] = meetingTable.size;
    const geometry = shapesGeometry(nibbles().shapes, 2);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    expect(box?.min.y).toBeGreaterThanOrEqual(0.74 - 1e-6);
    expect(box?.min.x).toBeGreaterThan(cx - width / 2);
    expect(box?.max.x).toBeLessThan(cx + width / 2);
    expect(box?.min.z).toBeGreaterThan(cz - depth / 2);
    expect(box?.max.z).toBeLessThan(cz + depth / 2);
  });

  it("light in palette tokens only, and cost no more than a few Avatars", () => {
    const layout = floorLayout(team(8));
    for (const event of seasonalEventIds) {
      for (const decor of [
        lobbyDecor([event]),
        floorDecor([event], layout.bounds, {
          nibbles: true,
          halloweenFood: event === "halloween",
          eggSpots: floorEggSpots(layout),
        }),
      ]) {
        for (const { token } of decor.lights) {
          expect(paletteTokens).toContain(token);
        }
        expect(decor.lights.length).toBeLessThan(400);
        const geometry = shapesGeometry(
          [...decor.shapes, ...(decor.overhead ?? [])],
          2,
        );
        expect(triangles(geometry), event).toBeLessThan(
          avatarTriangleBudget.low * 8,
        );
        geometry.dispose();
      }
    }
  });

  it("put Christmas's party food on the meeting room table's top", () => {
    const [cx, cz] = meetingTable.centre;
    const [width, depth] = meetingTable.size;
    const geometry = shapesGeometry(partyFood().shapes, 2);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    expect(box?.min.y).toBeGreaterThanOrEqual(0.74 - 1e-6);
    expect(box?.min.x).toBeGreaterThan(cx - width / 2);
    expect(box?.max.x).toBeLessThan(cx + width / 2);
    expect(box?.min.z).toBeGreaterThan(cz - depth / 2);
    expect(box?.max.z).toBeLessThan(cz + depth / 2);
    // On the day both are on, the party food takes the table.
    const layout = floorLayout(team(4));
    const both = floorDecor([], layout.bounds, {
      nibbles: true,
      partyFood: true,
    });
    expect(both.shapes).toEqual(partyFood().shapes);
  });

  it("cover the lobby and every Floor in tinsel and more at Christmas, each part only if chosen", () => {
    const layout = floorLayout(team(4));
    const everything = (decor: Decor) => [
      ...decor.shapes,
      ...(decor.overhead ?? []),
    ];
    const names = (decor: Decor) =>
      new Set(everything(decor).map(({ name }) => name));
    for (const decor of [
      (choices = allDecorations) => lobbyDecor(["christmas"], choices),
      (choices = allDecorations) =>
        floorDecor(["christmas"], layout.bounds, { choices }),
    ]) {
      const all = decor();
      expect(
        everything(all).filter(({ name }) => name === "tinsel").length,
      ).toBeGreaterThan(200);
      for (const name of [
        "hanging bauble",
        "hanging star",
        "snowflake",
        "star",
      ]) {
        expect(names(all)).toContain(name);
      }
      // Above heads, and under the ceiling.
      const geometry = shapesGeometry(
        everything(all).filter(({ name }) => name === "tinsel"),
        2,
      );
      geometry.computeBoundingBox();
      expect(geometry.boundingBox?.min.y).toBeGreaterThan(2.2);
      expect(geometry.boundingBox?.max.y).toBeLessThanOrEqual(3);
      geometry.dispose();
      const bare = decor({ ...allDecorations, christmasDecorations: false });
      expect(names(bare)).not.toContain("tinsel");
      expect(names(bare)).toContain("star");
      const treeless = decor({ ...allDecorations, trees: false });
      expect(names(treeless)).not.toContain("star");
      expect(treeless.lights.length).toBeGreaterThan(0);
      expect(decor({ ...allDecorations, lights: false }).lights).toEqual([]);
    }
    expect(
      lobbyDecor(["new-year"], {
        ...allDecorations,
        newYearDecorations: false,
      }),
    ).toEqual({ shapes: [], lights: [] });
  });

  it.each([1, 4, 8, 12])(
    "hide loads of Easter eggs round a Floor of %i Agents, clear of every path and off the furniture",
    (size) => {
      const layout = floorLayout(team(size));
      const spots = floorEggSpots(layout);
      expect(spots.length).toBeGreaterThan(40);
      const byId = new Map(
        layout.waypoints.waypoints.map(({ id, position }) => [id, position]),
      );
      const furniture = layout.pieces
        .filter(
          (piece) =>
            piece.position[1] - piece.size[1] / 2 < 0.2 &&
            piece.position[1] + piece.size[1] / 2 > 0.02,
        )
        .map((piece) => footprint(piece));
      for (const spot of spots) {
        expect(spot[0]).toBeGreaterThan(layout.bounds.x[0]);
        expect(spot[0]).toBeLessThan(layout.bounds.x[1]);
        expect(spot[1]).toBeGreaterThan(layout.bounds.z[0]);
        expect(spot[1]).toBeLessThan(layout.bounds.z[1]);
        expect(
          furniture.some((rect) => overlaps(around(spot, 0.05), rect)),
        ).toBe(false);
        for (const [a, b] of layout.waypoints.edges) {
          const from = byId.get(a);
          const to = byId.get(b);
          if (from !== undefined && to !== undefined) {
            expect(fromSegment(spot, from, to)).toBeGreaterThan(eggClearance);
          }
        }
      }
      const eggs = (choices = allDecorations) =>
        floorDecor(["easter"], layout.bounds, {
          choices,
          eggSpots: spots,
        }).shapes.filter(({ name }) => name === "easter egg");
      expect(eggs()).toHaveLength(spots.length);
      expect(eggs({ ...allDecorations, eggs: false })).toEqual([]);
    },
  );

  it("hide Easter eggs round the lobby, off its walkways", () => {
    expect(lobbyEggSpots.length).toBeGreaterThan(20);
    for (const spot of lobbyEggSpots) {
      for (const walkway of lobbyWalkways) {
        expect(overlaps(around(spot, 0.05), walkway), walkway.name).toBe(false);
      }
    }
    const names = (choices = allDecorations) =>
      lobbyDecor(["easter"], choices).shapes.map(({ name }) => name);
    expect(names()).toContain("easter egg");
    expect(names()).toContain("basket");
    expect(names({ ...allDecorations, eggs: false })).not.toContain(
      "easter egg",
    );
  });

  it("put up Halloween's decorations and pumpkins, each only if chosen", () => {
    const layout = floorLayout(team(4));
    for (const decor of [
      (choices = allDecorations) => lobbyDecor(["halloween"], choices),
      (choices = allDecorations) =>
        floorDecor(["halloween"], layout.bounds, { choices }),
    ]) {
      const names = (choices = allDecorations) =>
        new Set(decor(choices).shapes.map(({ name }) => name));
      expect(names()).toContain("pumpkin stalk");
      expect(names()).toContain("gravestone");
      expect(names()).toContain("bat");
      const noPumpkins = names({ ...allDecorations, pumpkins: false });
      expect(noPumpkins).not.toContain("pumpkin stalk");
      expect(noPumpkins).toContain("gravestone");
      const bare = decor({ ...allDecorations, halloweenDecorations: false });
      expect(bare.shapes.map(({ name }) => name)).not.toContain("bat");
      expect(bare.shapes.map(({ name }) => name)).not.toContain("gravestone");
      expect(bare.shapes.map(({ name }) => name)).toContain("pumpkin stalk");
      expect(
        decor({
          ...allDecorations,
          halloweenDecorations: false,
          pumpkins: false,
        }),
      ).toEqual({ shapes: [], lights: [] });
    }
  });

  it("put Halloween's food on the meeting room table's top", () => {
    const [cx, cz] = meetingTable.centre;
    const [width, depth] = meetingTable.size;
    const food = halloweenFood();
    const geometry = shapesGeometry(food.shapes, 2);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    expect(box?.min.y).toBeGreaterThanOrEqual(0.74 - 1e-6);
    expect(box?.min.x).toBeGreaterThan(cx - width / 2);
    expect(box?.max.x).toBeLessThan(cx + width / 2);
    expect(box?.min.z).toBeGreaterThan(cz - depth / 2);
    expect(box?.max.z).toBeLessThan(cz + depth / 2);
    geometry.dispose();
    const names = food.shapes.map(({ name }) => name);
    expect(names).toContain("cauldron");
    expect(names).toContain("pumpkin pie");
    const layout = floorLayout(team(4));
    expect(
      floorDecor(["halloween"], layout.bounds, {
        halloweenFood: true,
        choices: {
          ...allDecorations,
          halloweenDecorations: false,
          pumpkins: false,
        },
      }),
    ).toEqual(food);
    expect(
      floorDecor([], layout.bounds, { halloweenFood: false }).shapes,
    ).toEqual([]);
  });

  it("dress nothing out of season", () => {
    expect(lobbyDecor([])).toEqual({ shapes: [], lights: [] });
    expect(distance([0, 0], [0, 0])).toBe(0);
  });
});
