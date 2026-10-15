import { floorThemes, type FloorTheme, type Role } from "@ai-office/shared";
import { beforeAll, describe, expect, it } from "vitest";

import type { Rect } from "./desk-set.ts";
import {
  dartboardRings,
  floorCeiling,
  floorLayout,
  gamesHall,
  lounge,
  type FloorAgent,
  type FloorLayout,
} from "./floor-layout.ts";
import { floorThemeProps, themeLayout, themeZone } from "./floor-themes.ts";
import { modelCatalogue } from "./model-catalogue.ts";
import { placedSize, type LoadedModels } from "./models.ts";
import { pieceGeometry, triangles } from "./piece-geometry.ts";
import { footprint, lying, piece, placePieces, type Piece } from "./pieces.ts";
import { loadModelsFromDisk } from "./test-models.ts";

// A Floor's 3D theme (PRD FR-57, FR-99), checked as data without WebGL:
// each built-in template's theme sets out its own props in the theme's
// zone, clear of the desks and every walkway for teams of 1 to 12, on the
// floor and under the ceiling, within the spec's budgets; Development's
// office is a break area for the lounge; and a theme changes nothing an
// Agent walks or works by, so it never delays work.

const workRoles: Role[] = ["coder", "reviewer", "qa", "docs", "designer"];

/** A Manager, then `size - 1` Agents in the Roles in turn. */
const team = (size: number): FloorAgent[] =>
  Array.from({ length: size }, (_, index) => ({
    id: `agent-${String(index + 1)}`,
    role:
      index === 0
        ? "manager"
        : (workRoles[index % workRoles.length] ?? "coder"),
  }));

const sizes = Array.from({ length: 12 }, (_, index) => index + 1);

const themed = floorThemes;

/** A theme's own pieces and models in a layout: their names start with it. */
const ownPieces = (layout: FloorLayout, theme: FloorTheme) =>
  layout.pieces.filter(({ name }) => name.startsWith(`${theme} `));
const ownModels = (layout: FloorLayout, theme: FloorTheme) =>
  layout.models.filter(({ name }) => name.startsWith(`${theme} `));

const within = (rect: Rect, zone: Rect) =>
  rect.x[0] >= zone.x[0] - 1e-6 &&
  rect.x[1] <= zone.x[1] + 1e-6 &&
  rect.z[0] >= zone.z[0] - 1e-6 &&
  rect.z[1] <= zone.z[1] + 1e-6;

const overlaps = (a: Rect, b: Rect) =>
  a.x[0] < b.x[1] - 1e-6 &&
  b.x[0] < a.x[1] - 1e-6 &&
  a.z[0] < b.z[1] - 1e-6 &&
  b.z[0] < a.z[1] - 1e-6;

const modelRect = (placement: Parameters<typeof placedSize>[0]): Rect => {
  const [width, , depth] = placedSize(placement);
  const [x, , z] = placement.position;
  return {
    x: [x - width / 2, x + width / 2],
    z: [z - depth / 2, z + depth / 2],
  };
};

const bottom = (each: Piece) => each.position[1] - each.size[1] / 2;
const top = (each: Piece) => each.position[1] + each.size[1] / 2;

describe("a Floor's 3D theme", () => {
  it("is set out for every built-in template's theme, Development's office by default", () => {
    for (const size of [1, 4, 12]) {
      expect(floorLayout(team(size), "office")).toEqual(
        floorLayout(team(size)),
      );
    }
    for (const theme of themed) {
      expect(floorThemeProps[theme].length, theme).toBeGreaterThanOrEqual(3);
      const layout = floorLayout(team(6), theme);
      expect(
        ownPieces(layout, theme).length + ownModels(layout, theme).length,
        theme,
      ).toBeGreaterThan(10);
    }
  });

  it("gives each theme its own props, so no two look alike", () => {
    const kinds = themed.map((theme) =>
      [...new Set(floorThemeProps[theme].map(({ prop }) => prop))]
        .sort()
        .join(", "),
    );
    expect(new Set(kinds).size).toBe(themed.length);
  });

  it("is what its Floor Template is known by: stock and parcels, presses and books, dashboards, racks", () => {
    const props = (theme: FloorTheme) =>
      new Set(floorThemeProps[theme].map(({ prop }) => prop));
    const has = (theme: FloorTheme, part: string) =>
      ownPieces(floorLayout(team(6), theme), theme).filter(({ name }) =>
        name.includes(part),
      );
    // Online store: stock shelves and parcels.
    expect(props("stockroom")).toContain("stock shelves 1");
    expect(props("stockroom")).toContain("pallet of parcels");
    expect(has("stockroom", "parcel").length).toBeGreaterThan(10);
    // Content & blog: bookshelves and a printing press.
    expect(props("editorial")).toContain("bookcase");
    expect(has("editorial", "printing press, roller")).toHaveLength(3);
    // Documentation: a wall of bookcases and a ladder.
    expect(
      floorThemeProps.library.filter(({ prop }) => prop === "bookcase"),
    ).toHaveLength(4);
    expect(props("library")).toContain("library ladder");
    // Data & analytics: dashboards on the wall, their charts glowing.
    const dashboards = has("observatory", "wall dashboard");
    expect(dashboards.length).toBeGreaterThan(20);
    expect(
      dashboards.filter(({ surface }) => surface === "screen").length,
    ).toBeGreaterThan(15);
    // Infrastructure: server racks with their status lights lit.
    expect(
      floorThemeProps["data-centre"].filter(
        ({ prop }) => prop === "server rack",
      ),
    ).toHaveLength(8);
    expect(
      has("data-centre", "light").filter(
        ({ surface, token }) => surface === "lamp" && token === "state-ok",
      ).length,
    ).toBeGreaterThan(16);
    // Website & marketing: a photo studio; Design system: colour swatches;
    // Mobile app: a wall of phones.
    expect(props("studio")).toContain("backdrop");
    expect(props("studio")).toContain("softbox");
    expect(has("atelier", "swatch wall, swatch")).toHaveLength(12);
    expect(has("device-lab", "device wall, phone")).toHaveLength(18);
    // Development: a break area for the lounge, its trophies on a shelf.
    expect(props("office")).toContain("darts scoreboard");
    expect(props("office")).toContain("bench");
    expect(has("office", "trophy shelves, trophy")).toHaveLength(12);
  });

  it("fills Development's left wall and floor between the dartboard and the games hall, clear of the darts players", () => {
    const layout = floorLayout(team(6));
    const own = ownPieces(layout, "office");
    const models = ownModels(layout, "office");
    // What hangs on the wall, over the bench and the plant.
    const onWall = (each: Piece) =>
      bottom(each) > 1 && footprint(each).x[0] < themeZone.x[0] + 0.3;
    const wall = own.filter(onWall);
    const floor = own.filter(
      (each) =>
        !onWall(each) && each.role !== "architecture" && bottom(each) < 0.05,
    );
    expect(wall.length).toBeGreaterThan(40);
    expect(floor.length + models.length).toBeGreaterThan(5);
    // Along the wall from the dartboard nearly to the games hall's
    // walkway, nothing bare for as much as half a metre.
    const [, , dartZ] = lounge.dartboard;
    let reached = dartZ + dartboardRings.board;
    for (const [from, to] of wall
      .map((each) => footprint(each).z)
      .sort((a, b) => a[0] - b[0])) {
      expect(from - reached, `bare from z ${String(reached)}`).toBeLessThan(
        0.5,
      );
      reached = Math.max(reached, to);
    }
    expect(reached).toBeGreaterThan(gamesHall.from - 0.3);
    // The darts players' end of the lounge, and the games hall, stay clear.
    for (const { name, rect } of [
      ...own.map((each) => ({ name: each.name, rect: footprint(each) })),
      ...models.map((each) => ({ name: each.name, rect: modelRect(each) })),
    ]) {
      expect(rect.z[0], name).toBeGreaterThan(lounge.walkway.z[1]);
      expect(rect.z[1], name).toBeLessThanOrEqual(gamesHall.from);
    }
  });

  it("hangs Development's pennants flat on the wall, point down from their string", () => {
    const pennant = ownPieces(floorLayout(team(1)), "office").find(({ name }) =>
      name.endsWith("pennants, pennant 1"),
    );
    expect(pennant).toBeDefined();
    if (pennant === undefined) {
      return;
    }
    const geometry = pieceGeometry(pennant);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const [, y] = pennant.position;
    // Its wide end at the string, its point at its disc's centre below.
    expect(box?.max.y).toBeGreaterThan(y + pennant.size[1] / 2 - 0.01);
    expect(box?.min.y).toBeCloseTo(y, 3);
    expect((box?.max.x ?? 1) - (box?.min.x ?? 0)).toBeLessThan(0.01);
    geometry.dispose();
  });

  it("stands in its zone along the left wall, on the floor and under the ceiling", () => {
    for (const theme of floorThemes) {
      const layout = themeLayout(theme);
      for (const each of layout.pieces) {
        expect(within(footprint(each), themeZone), each.name).toBe(true);
        expect(bottom(each), each.name).toBeGreaterThanOrEqual(-1e-6);
        expect(top(each), each.name).toBeLessThanOrEqual(floorCeiling + 1e-6);
      }
      for (const each of layout.models) {
        expect(within(modelRect(each), themeZone), each.name).toBe(true);
        expect(
          each.position[1] + modelCatalogue[each.model].size[1],
          each.name,
        ).toBeLessThanOrEqual(floorCeiling);
      }
      for (const rect of layout.contactShadows) {
        expect(within(rect, themeZone), theme).toBe(true);
      }
    }
  });

  it("keeps clear of every desk and every walkway, for teams of 1 to 12", () => {
    for (const theme of themed) {
      for (const size of sizes) {
        const layout = floorLayout(team(size), theme);
        expect(
          within(themeZone, layout.bounds),
          `${theme}, ${String(size)}`,
        ).toBe(true);
        const things = [
          ...ownPieces(layout, theme)
            .filter(
              (each) =>
                each.role !== "architecture" &&
                top(each) > 0.05 &&
                bottom(each) < 1.9,
            )
            .map((each) => ({ name: each.name, rect: footprint(each) })),
          ...ownModels(layout, theme).map((each) => ({
            name: each.name,
            rect: modelRect(each),
          })),
        ];
        for (const { name, rect } of things) {
          for (const deskSet of layout.desks) {
            expect(
              overlaps(rect, deskSet.footprint),
              `${theme}, ${String(size)}: ${name} and ${deskSet.agentId}'s desk`,
            ).toBe(false);
          }
          for (const walkway of layout.walkways) {
            expect(
              overlaps(rect, walkway),
              `${theme}, ${String(size)}: ${name} in ${walkway.name}`,
            ).toBe(false);
          }
        }
        // Nor does anything of the theme stand on the carpet under the desks.
        const carpet = layout.pieces.find(
          ({ name }) => name === "carpet under the desks",
        );
        if (carpet !== undefined) {
          expect(footprint(carpet).x[0]).toBeGreaterThan(themeZone.x[1]);
        }
      }
    }
  });

  it("is decoration only: the desks, walkways and waypoints are the same in every theme", () => {
    for (const size of [1, 6, 12]) {
      const office = floorLayout(team(size));
      for (const theme of themed) {
        const layout = floorLayout(team(size), theme);
        expect(layout.desks, theme).toEqual(office.desks);
        expect(layout.walkways, theme).toEqual(office.walkways);
        expect(layout.waypoints, theme).toEqual(office.waypoints);
        expect(layout.meetingSeats, theme).toEqual(office.meetingSeats);
        expect(layout.bounds, theme).toEqual(office.bounds);
      }
    }
  });

  it("puts a soft contact shadow under each prop that stands on the floor", () => {
    // The Floor's own shadows, without the office's props'.
    const office = floorLayout(team(6)).contactShadows.slice(
      0,
      -themeLayout("office").contactShadows.length,
    );
    for (const theme of themed) {
      const { contactShadows } = themeLayout(theme);
      expect(contactShadows.length, theme).toBeGreaterThan(0);
      expect(floorLayout(team(6), theme).contactShadows).toEqual([
        ...office,
        ...contactShadows,
      ]);
    }
    // The racks stand on a raised floor, which itself casts nothing.
    expect(themeLayout("data-centre").contactShadows).toHaveLength(8);
  });
});

describe("a theme's cost", () => {
  let models: LoadedModels;
  beforeAll(async () => {
    models = await loadModelsFromDisk();
  });

  const pieceTriangles = (pieces: readonly Piece[]) =>
    pieces.reduce((sum, each) => {
      const geometry = pieceGeometry(each);
      const count = triangles(geometry);
      geometry.dispose();
      return sum + count;
    }, 0);
  const modelTriangles = (placements: FloorLayout["models"]) =>
    placements.reduce(
      (sum, { model }) =>
        sum +
        models[model].reduce(
          (total, { geometry }) => total + triangles(geometry),
          0,
        ),
      0,
    );

  it("leaves a 12-Agent Floor in every theme room for its Avatars within a frame's triangles", () => {
    for (const theme of floorThemes) {
      const layout = floorLayout(team(12), theme);
      const total =
        pieceTriangles(layout.pieces) + modelTriangles(layout.models);
      // Medium's 300,000 a frame, less 13 Avatars at 6,000 each.
      expect(total + 13 * 6000, theme).toBeLessThanOrEqual(300_000);
      // And the theme itself is no more than a large prop's few thousand
      // triangles for each of its props.
      const own =
        pieceTriangles(ownPieces(layout, theme)) +
        modelTriangles(ownModels(layout, theme));
      expect(own, theme).toBeLessThanOrEqual(
        floorThemeProps[theme].length * 4000,
      );
    }
  });
});

describe("a lying cylinder", () => {
  it("is drawn along its axis, its size still its bounding box", () => {
    for (const [axis, size] of [
      ["x", [1.2, 0.2, 0.3]],
      ["z", [0.2, 0.3, 1.2]],
    ] as const) {
      const geometry = pieceGeometry(
        lying(
          axis,
          piece(
            "roller",
            "cylinder",
            "metal-light",
            "metal",
            "prop",
            [...size],
            [1, 2, 3],
          ),
        ),
      );
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      expect(box?.max.x).toBeCloseTo(1 + size[0] / 2, 3);
      expect(box?.max.y).toBeCloseTo(2 + size[1] / 2, 3);
      expect(box?.max.z).toBeCloseTo(3 + size[2] / 2, 3);
      geometry.dispose();
    }
  });

  it("is laid along the other axis by a quarter turn", () => {
    const roller = lying(
      "x",
      piece(
        "roller",
        "cylinder",
        "metal-light",
        "metal",
        "prop",
        [1.2, 0.2, 0.2],
        [0, 1, 0],
      ),
    );
    const [turned] = placePieces([roller], 1, [0, 0]);
    expect(turned?.axis).toBe("z");
    expect(turned?.size).toEqual([0.2, 0.2, 1.2]);
    expect(placePieces([roller], 2, [0, 0])[0]?.axis).toBe("x");
  });
});
