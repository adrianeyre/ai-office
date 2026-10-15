import { readFileSync } from "node:fs";
import { join } from "node:path";

import { paletteTokens } from "@ai-office/shared/palette";
import { describe, expect, it } from "vitest";

import {
  liftCorePieces,
  liftDoor,
  liftDoorway,
  liftLamps,
  liftWall,
} from "./lift-layout.ts";
import {
  entrance,
  featureWall,
  lobbyPieces,
  lobbySize,
  lobbyWalkways,
  noticeBoardPosition,
  receptionLogo,
  receptionPosition,
} from "./lobby-layout.ts";
import { surfaces } from "./materials.ts";
import { boardSize } from "./notice-board-preview.ts";
import { mergePieces, triangles } from "./piece-geometry.ts";
import { castsShadow, footprint, type Piece } from "./pieces.ts";

// The lobby (PRD FR-57) against docs/reference/art-direction.md: its
// colours, sizes, walkways and budgets, checked as data without WebGL.

const spec = readFileSync(
  join(import.meta.dirname, "../../../../docs/reference/art-direction.md"),
  "utf8",
);

/** The first number of metres the spec gives after `phrase`. */
function metres(phrase: string): number[] {
  const at = spec.indexOf(phrase);
  if (at === -1) {
    throw new Error(`The art direction spec does not say "${phrase}".`);
  }
  const sentence = spec.slice(at + phrase.length, spec.indexOf("\n", at));
  return [...sentence.matchAll(/(\d+(?:\.\d+)?) m/g)].map(([, n]) => Number(n));
}

/** The cells after the first of the spec's table row that starts with `label`. */
function row(label: string): string[] {
  const line = spec.split("\n").find((each) => each.startsWith(`| ${label} |`));
  if (line === undefined) {
    throw new Error(`The art direction spec has no "${label}" row.`);
  }
  return line
    .split("|")
    .slice(2, -1)
    .map((cell) => cell.trim());
}

const named = (name: string): Piece => {
  const found = lobbyPieces.find((piece) => piece.name === name);
  if (found === undefined) {
    throw new Error(`The lobby has no piece named "${name}".`);
  }
  return found;
};

const bottom = ({ position, size }: Piece) => position[1] - size[1] / 2;
const top = ({ position, size }: Piece) => position[1] + size[1] / 2;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Whether two ranges overlap by more than touching. */
const overlaps = (
  [a0, a1]: readonly [number, number],
  [b0, b1]: readonly [number, number],
) => a0 < b1 - 1e-6 && b0 < a1 - 1e-6;

describe("the lobby", () => {
  it("is coloured from the palette only, each token on a surface that suits it", () => {
    for (const piece of lobbyPieces) {
      expect(paletteTokens, piece.name).toContain(piece.token);
      expect(Object.keys(surfaces), piece.name).toContain(piece.surface);
      // Glass is the glass token, and the glass token is glass.
      expect(piece.surface === "glass", piece.name).toBe(
        piece.token === "glass",
      );
      // Only screens and lamps glow, in their tokens.
      if (piece.surface === "screen") {
        expect(["screen-off", "screen-glow"]).toContain(piece.token);
      }
      if (piece.surface === "lamp") {
        expect(piece.token).toBe("lamp");
      }
    }
  });

  it("stands on its floor, under its 3 m ceiling", () => {
    expect(metres("**Ceiling height** is")[0]).toBe(lobbySize.ceiling);
    for (const piece of lobbyPieces.filter(({ name }) => name !== "floor")) {
      expect(bottom(piece), piece.name).toBeGreaterThanOrEqual(-1e-9);
      expect(top(piece), piece.name).toBeLessThanOrEqual(
        lobbySize.ceiling + 1e-9,
      );
    }
    expect(top(named("floor"))).toBe(0);
  });

  it("keeps its furniture inside its walls", () => {
    for (const piece of lobbyPieces.filter(
      (each) => each.role !== "architecture",
    )) {
      const { x, z } = footprint(piece);
      expect(x[0], piece.name).toBeGreaterThanOrEqual(-lobbySize.width / 2);
      expect(x[1], piece.name).toBeLessThanOrEqual(lobbySize.width / 2);
      expect(z[0], piece.name).toBeGreaterThanOrEqual(-lobbySize.depth / 2);
      expect(z[1], piece.name).toBeLessThanOrEqual(lobbySize.depth / 2);
    }
  });

  it("has the Notice Board on the back wall at the spec's size and height", () => {
    const [width = 0, height = 0, centre = 0] = metres(
      "| Wall boards and Notice Boards |",
    );
    expect([boardSize.width, boardSize.height]).toEqual([width, height]);
    const felt = named("Notice Board, felt");
    expect(felt.size.slice(0, 2)).toEqual([width, height]);
    expect(felt.position[1]).toBe(centre);
    expect(noticeBoardPosition[1]).toBe(centre);
    // Flat on the back wall's face.
    expect(
      close(felt.position[2] - felt.size[2] / 2, -lobbySize.depth / 2),
    ).toBe(true);
    // The frame is the board's edge.
    const frameTop = named("Notice Board frame, top");
    expect(close(top(frameTop), centre + height / 2)).toBe(true);
    expect(frameTop.size[0]).toBe(width);
  });

  it("has doors of the spec's size: the entrance two, the lift one", () => {
    const [doorWidth, doorHeight] = metres("doors are");
    expect([liftDoorway.width, liftDoorway.height]).toEqual([
      doorWidth,
      doorHeight,
    ]);
    expect(entrance.height).toBe(doorHeight);
    expect(entrance.z[1] - entrance.z[0]).toBeCloseTo(2 * (doorWidth ?? 0));
    // The lift's two sliding doors close the doorway between them.
    expect(liftDoor.size[0] * 2).toBe(liftDoorway.width);
    expect(liftDoor.size[1]).toBe(liftDoorway.height);
    // Open, each slides almost all the way into the wall beside it.
    expect(liftDoor.travel).toBeGreaterThan(liftDoor.size[0] * 0.9);
    // The wall over the lift doors holds a lamp for every stop it shows.
    const overDoors = named("lift wall, over the doors");
    expect(
      (liftLamps.max - 1) * liftLamps.spacing + liftLamps.size[0],
    ).toBeLessThan(overDoors.size[0]);
    expect(liftLamps.height).toBeGreaterThan(bottom(overDoors));
    expect(
      liftLamps.markerHeight - liftLamps.markerSize[1] / 2,
    ).toBeGreaterThan(bottom(overDoors));
  });

  it("seats the Communications Agent's reception as the spec sizes a desk", () => {
    const seat = named("reception chair, seat");
    const back = named("reception chair, back");
    const monitor = named("reception monitor");
    const deskTop = named("reception desk, top");
    expect(row("Chair")[0]).toContain("Seat 0.46 m high");
    expect(top(seat)).toBeCloseTo(0.46);
    expect(top(back)).toBeCloseTo(0.95);
    expect(row("Desk top")[0]).toContain("0.74 m above the floor");
    expect(top(deskTop)).toBeCloseTo(0.74);
    expect(row("Monitor")[0]).toContain("its top 1.15 m above the floor");
    expect(top(monitor)).toBeCloseTo(1.15);
    // 0.45 m from the desk's front edge: the Agent's side, behind the counter.
    const frontEdge = deskTop.position[2] - deskTop.size[2] / 2;
    expect(monitor.position[2] - frontEdge).toBeCloseTo(0.45);
    expect(seat.position[2]).toBeLessThan(frontEdge);
  });

  it("mounts the company logo on the feature wall behind reception, over the desk", () => {
    const wall = named("feature wall behind reception");
    const counter = named("reception counter, front");
    const [x, y, z] = receptionLogo.position;
    const [width, height] = receptionLogo.size;
    // Centred on the desk, at the logo's 244:64 proportions.
    expect(x).toBe(receptionPosition[0]);
    expect(x).toBe(counter.position[0]);
    expect(width / height).toBeCloseTo(244 / 64);
    // On the wall behind the desk, a few millimetres proud of its face.
    expect(wall.position[0]).toBe(x);
    expect(wall.size[0]).toBe(featureWall.width);
    const face = wall.position[2] + wall.size[2] / 2;
    expect(z - face).toBeGreaterThan(0);
    expect(z - face).toBeLessThan(0.01);
    expect(z).toBeLessThan(receptionPosition[2]);
    // Above the counter's top, under the ceiling, within the wall's width.
    expect(y - height / 2).toBeGreaterThan(top(counter) + 0.3);
    expect(y + height / 2).toBeLessThan(lobbySize.ceiling);
    expect(width).toBeLessThan(featureWall.width);
    expect(width).toBeGreaterThan(counter.size[0] * 0.5);
  });

  it("keeps walkways at least 1.5 m wide, and clear of furniture and props", () => {
    expect(metres("**Walkways** are at least")[0]).toBe(1.5);
    for (const { name, x, z } of lobbyWalkways) {
      expect(Math.min(x[1] - x[0], z[1] - z[0]), name).toBeGreaterThanOrEqual(
        1.5,
      );
      for (const piece of lobbyPieces.filter(
        (each) => each.role !== "architecture",
      )) {
        const spot = footprint(piece);
        expect(
          overlaps(spot.x, x) && overlaps(spot.z, z),
          `${piece.name} is in the walkway ${name}`,
        ).toBe(false);
      }
    }
  });

  it("has walkways from the entrance to the lift's doors", () => {
    const [fromEntrance, toLift] = lobbyWalkways;
    // Through the entrance in the left wall…
    expect(fromEntrance?.x[0]).toBe(-lobbySize.width / 2);
    expect(fromEntrance?.z).toEqual(entrance.z);
    // …joining the walkway that runs to the doorway in the back wall.
    expect(overlaps(fromEntrance?.x ?? [0, 0], toLift?.x ?? [0, 0])).toBe(true);
    expect(toLift?.z[0]).toBe(-lobbySize.depth / 2);
    expect(toLift?.x[0]).toBeLessThanOrEqual(
      liftDoorway.position[0] - liftDoorway.width / 2,
    );
    expect(toLift?.x[1]).toBeGreaterThanOrEqual(
      liftDoorway.position[0] + liftDoorway.width / 2,
    );
    expect(liftDoorway.position[2]).toBe(-lobbySize.depth / 2);
  });

  it("casts shadows from furniture and props only, never from walls", () => {
    for (const piece of lobbyPieces) {
      expect(castsShadow(piece), piece.name).toBe(
        piece.role !== "architecture",
      );
    }
    for (const piece of lobbyPieces.filter(({ name }) =>
      name.includes("wall"),
    )) {
      expect(piece.role, piece.name).toBe("architecture");
    }
  });

  it("is within the spec's Medium budgets, in few draw calls", () => {
    const [architectureLimit] = row(
      "A Floor's architecture (walls, floors, glass)",
    )
      .slice(1)
      .map((cell) => Number(cell.replaceAll(",", "")));
    const merged = mergePieces(lobbyPieces);
    const architecture = mergePieces(
      lobbyPieces.filter(({ role }) => role === "architecture"),
    );
    const count = (groups: typeof merged) =>
      groups.reduce((sum, { geometry }) => sum + triangles(geometry), 0);
    expect(count(architecture)).toBeLessThanOrEqual(architectureLimit ?? 0);
    // One mesh per material and shadow, a small share of Medium's 200 draw calls.
    expect(merged.length).toBeLessThan(30);
    expect(count(merged)).toBe(
      lobbyPieces.reduce(
        (sum, piece) =>
          sum + triangles(mergePieces([piece])[0]?.geometry ?? never()),
        0,
      ),
    );
  });
});

describe("the lift core", () => {
  it("is in the lobby's back wall, the wall running up to it on both sides", () => {
    for (const piece of liftCorePieces) {
      expect(lobbyPieces).toContain(piece);
    }
    const left = named("back wall");
    const right = named("back wall, right of the lift");
    const core = { x: liftDoorway.position[0], width: liftWall.width };
    expect(
      close(left.position[0] + left.size[0] / 2, core.x - core.width / 2),
    ).toBe(true);
    expect(
      close(right.position[0] - right.size[0] / 2, core.x + core.width / 2),
    ).toBe(true);
    expect(
      close(left.position[0] - left.size[0] / 2, -lobbySize.width / 2),
    ).toBe(true);
  });

  it("leaves the doorway open, between its frame", () => {
    const [x, , z] = liftDoorway.position;
    const doorway = {
      x: [x - liftDoorway.width / 2, x + liftDoorway.width / 2] as const,
      y: [0, liftDoorway.height] as const,
    };
    for (const piece of liftCorePieces.filter(
      ({ position, size }) =>
        position[2] + size[2] / 2 > z - liftWall.thickness,
    )) {
      const { x: spanX } = footprint(piece);
      const spanY = [bottom(piece), top(piece)] as const;
      const inDoorway =
        overlaps(spanX, doorway.x) && overlaps(spanY, doorway.y);
      expect(
        inDoorway && !["lift car floor", "lift door sill"].includes(piece.name),
        piece.name,
      ).toBe(false);
    }
  });
});

function never(): never {
  throw new Error("A piece always makes a geometry.");
}
