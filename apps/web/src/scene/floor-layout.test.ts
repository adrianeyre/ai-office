import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { deskDressings, floorThemes, type Role } from "@ai-office/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { chair, desk, deskSpacing, monitor, ticketPile } from "./desk-set.ts";
import type { Rect } from "./desk-set.ts";
import {
  deskGrid,
  floorCeiling,
  floorLayout,
  floorLogo,
  floorSpots,
  dartboardRings,
  gamesHall,
  gym,
  lounge,
  managersOffice,
  meetingRoom,
  posterSize,
  wallBoard,
  wallPosters,
  whiteboard,
  type FloorAgent,
  type FloorLayout,
  type WallPoster,
} from "./floor-layout.ts";
import { themeZone } from "./floor-themes.ts";
import { idlePlaces } from "./idle-behaviours.ts";
import { liftDoorway } from "./lift-layout.ts";
import {
  placedSize,
  type LoadedModels,
  type ModelPlacement,
} from "./models.ts";
import { pieceGeometry, triangles } from "./piece-geometry.ts";
import { footprint, type Piece } from "./pieces.ts";
import { loadModelsFromDisk } from "./test-models.ts";
import { distance, reachable, walk, type FloorPoint } from "./waypoints.ts";

// A Floor's layout, generated from its Agents (PRD FR-57), checked against
// docs/reference/art-direction.md without WebGL: a desk per Agent that
// overlaps nothing, for teams of 1 to 12; waypoints that reach every desk
// along paths clear of furniture; and the rooms at the spec's sizes.

const spec = await readFile(
  join(import.meta.dirname, "../../../../docs/reference/art-direction.md"),
  "utf8",
);

const workRoles: Role[] = ["coder", "reviewer", "qa", "docs", "designer"];

/** A team of `size` Agents: the Manager first (unless left out), then the Roles in turn. */
function team(size: number, { manager = true } = {}): FloorAgent[] {
  return Array.from({ length: size }, (_, index) => ({
    id: `agent-${String(index + 1)}`,
    role:
      manager && index === 0
        ? "manager"
        : (workRoles[index % workRoles.length] ?? "coder"),
  }));
}

/** The Manager, then an Agent of a library Role in each desk dressing. */
const dressedTeam: FloorAgent[] = [
  { id: "manager", role: "manager" },
  ...deskDressings.map((deskDressing): FloorAgent => ({
    id: `dressed-${deskDressing}`,
    role: `${deskDressing}-role`,
    stage: "work",
    deskDressing,
  })),
];

const sizes = Array.from({ length: 12 }, (_, index) => index + 1);

const overlaps = (a: Rect, b: Rect) =>
  a.x[0] < b.x[1] - 1e-6 &&
  b.x[0] < a.x[1] - 1e-6 &&
  a.z[0] < b.z[1] - 1e-6 &&
  b.z[0] < a.z[1] - 1e-6;

const modelFootprint = (placement: ModelPlacement): Rect => {
  const [width, , depth] = placedSize(placement);
  const [x, , z] = placement.position;
  return {
    x: [x - width / 2, x + width / 2],
    z: [z - depth / 2, z + depth / 2],
  };
};

const bottom = (piece: Piece) => piece.position[1] - piece.size[1] / 2;
const top = (piece: Piece) => piece.position[1] + piece.size[1] / 2;

/** What an Agent cannot walk through: anything standing between the floor and head height. */
function obstacles(layout: FloorLayout): { name: string; rect: Rect }[] {
  return [
    ...layout.pieces
      .filter((piece) => top(piece) > 0.05 && bottom(piece) < 1.9)
      .map((piece) => ({ name: piece.name, rect: footprint(piece) })),
    ...layout.models
      .filter(({ position }) => position[1] < 1.9)
      .map((placement) => ({
        name: placement.name,
        rect: modelFootprint(placement),
      })),
  ];
}

/** How far a point is from a rectangle, 0 inside it. */
function clearance([x, z]: FloorPoint, rect: Rect): number {
  const dx = Math.max(rect.x[0] - x, 0, x - rect.x[1]);
  const dz = Math.max(rect.z[0] - z, 0, z - rect.z[1]);
  return Math.hypot(dx, dz);
}

/** Half an Agent's shoulders: how close a path may come to anything. */
const shoulder = 0.2;

describe("a Floor's desks", () => {
  it.each(sizes)("gives each of %i Agents a desk, none overlapping", (size) => {
    for (const agents of [team(size), team(size, { manager: false })]) {
      const layout = floorLayout(agents);
      expect(layout.desks.map(({ agentId }) => agentId)).toEqual(
        agents.map(({ id }) => id),
      );
      layout.desks.forEach((each, index) => {
        for (const other of layout.desks.slice(index + 1)) {
          expect(
            overlaps(each.footprint, other.footprint),
            `${each.agentId} and ${other.agentId}`,
          ).toBe(false);
        }
      });
    }
  });

  it.each(sizes)(
    "keeps the desks of %i Agents clear of every other thing on the Floor, and of its walkways",
    (size) => {
      const layout = floorLayout(team(size));
      for (const each of layout.desks) {
        const own = `desk of ${each.agentId},`;
        for (const { name, rect } of obstacles(layout)) {
          if (!name.startsWith(own)) {
            expect(overlaps(each.footprint, rect), `${own} ${name}`).toBe(
              false,
            );
          }
        }
        for (const walkway of layout.walkways) {
          expect(
            overlaps(each.footprint, walkway),
            `${own} ${walkway.name}`,
          ).toBe(false);
        }
      }
    },
  );

  it.each(sizes)(
    "keeps the desks of %i Agents on the Floor, out of its rooms",
    (size) => {
      const layout = floorLayout(team(size));
      const rooms: Rect[] = [managersOffice, meetingRoom];
      for (const each of layout.desks) {
        const { x, z } = each.footprint;
        expect(x[0]).toBeGreaterThanOrEqual(layout.bounds.x[0]);
        expect(x[1]).toBeLessThanOrEqual(layout.bounds.x[1]);
        expect(z[0]).toBeGreaterThanOrEqual(layout.bounds.z[0]);
        expect(z[1]).toBeLessThanOrEqual(layout.bounds.z[1]);
        const inOffice = !overlaps(each.footprint, managersOffice)
          ? false
          : x[0] >= managersOffice.x[0] &&
            x[1] <= managersOffice.x[1] &&
            z[0] >= managersOffice.z[0] &&
            z[1] <= managersOffice.z[1];
        if (each.role === "manager") {
          expect(each.zone).toBe("manager's office");
          expect(inOffice).toBe(true);
        } else {
          expect(each.zone).toBe("open plan");
          for (const room of rooms) {
            expect(overlaps(each.footprint, room)).toBe(false);
          }
        }
      }
    },
  );

  it("puts open-plan desks 2.4 m apart side by side and 2.8 m front to back, on the 0.1 m grid", () => {
    expect(metres("| Desk spacing |")).toEqual([
      deskSpacing.across,
      deskSpacing.rows,
    ]);
    const layout = floorLayout(team(12, { manager: false }));
    const xs = [...new Set(layout.desks.map(({ seat }) => seat[0]))].sort(
      (a, b) => a - b,
    );
    const zs = [...new Set(layout.desks.map(({ seat }) => seat[2]))].sort(
      (a, b) => a - b,
    );
    xs.slice(1).forEach((x, index) => {
      expect(x - (xs[index] ?? NaN)).toBeCloseTo(deskSpacing.across, 6);
    });
    zs.slice(1).forEach((z, index) => {
      expect(z - (zs[index] ?? NaN)).toBeCloseTo(deskSpacing.rows, 6);
    });
    for (const { desk: rect } of layout.desks) {
      const centre = [(rect.x[0] + rect.x[1]) / 2, rect.z[0] + desk.depth / 2];
      for (const value of centre) {
        expect(Math.abs(value * 10 - Math.round(value * 10))).toBeLessThan(
          1e-6,
        );
      }
    }
  });

  it("adapts to the team: rows of up to five, and a deeper Floor once more rows need it", () => {
    expect(deskGrid(0)).toEqual({ rows: 0, columns: 0 });
    expect(deskGrid(1)).toEqual({ rows: 1, columns: 1 });
    expect(deskGrid(3)).toEqual({ rows: 1, columns: 3 });
    expect(deskGrid(5)).toEqual({ rows: 1, columns: 5 });
    expect(deskGrid(6)).toEqual({ rows: 2, columns: 3 });
    expect(deskGrid(11)).toEqual({ rows: 3, columns: 4 });
    expect(deskGrid(12)).toEqual({ rows: 3, columns: 4 });
    const depth = (size: number) => {
      const { bounds } = floorLayout(team(size));
      return bounds.z[1] - bounds.z[0];
    };
    // Deep enough for the gym and the games hall in front of it
    // at first; deeper once the rows reach the hall, which moves forwards.
    expect(depth(4)).toBe(depth(1));
    expect(depth(12)).toBe(depth(4));
    expect(depth(21)).toBeGreaterThan(depth(12));
    expect(depth(26)).toBeGreaterThan(depth(21));
    // Even a Floor with no Agents yet has its rooms.
    expect(floorLayout([]).desks).toEqual([]);
    expect(
      floorLayout([]).pieces.some(({ name }) => name === "whiteboard"),
    ).toBe(true);
  });
});

describe("a desk set", () => {
  const layout = floorLayout(team(6));
  const deskOf = (role: Role) => {
    const found = layout.desks.find((each) => each.role === role);
    if (found === undefined) {
      throw new Error(`No ${role} desk.`);
    }
    return {
      ...found,
      own: layout.pieces.filter(({ name }) =>
        name.startsWith(`desk of ${found.agentId},`),
      ),
    };
  };
  const named = (pieces: readonly Piece[], part: string) =>
    pieces.filter(({ name }) => name.endsWith(part));

  it("is at the spec's sizes: desk top, monitor and chair", () => {
    expect(metres("| Desk top |")).toEqual([desk.width, desk.depth, desk.top]);
    expect(metres("| Monitor |").slice(0, 2)).toEqual([
      monitor.width,
      monitor.height,
    ]);
    expect(metres("| Chair |")).toEqual([
      chair.seat,
      chair.size,
      chair.size,
      chair.back,
    ]);
    const { own, seat } = deskOf("coder");
    const deskTop = defined(named(own, "desk top")[0]);
    expect(deskTop.size).toEqual([desk.width, desk.thickness, desk.depth]);
    expect(top(deskTop)).toBeCloseTo(desk.top, 6);
    const screen = defined(named(own, "monitor, screen")[0]);
    expect(top(screen)).toBeCloseTo(monitor.top, 6);
    // The Agent faces -z, so the desk's front edge is at its +z side.
    const frontEdge = deskTop.position[2] + desk.depth / 2;
    expect(frontEdge - screen.position[2]).toBeCloseTo(
      monitor.fromFrontEdge,
      6,
    );
    const seatPiece = defined(named(own, "chair, seat")[0]);
    expect(top(seatPiece)).toBeCloseTo(chair.seat, 6);
    expect(top(defined(named(own, "chair, back")[0]))).toBeCloseTo(
      chair.back,
      6,
    );
    expect(seatPiece.position[2]).toBeCloseTo(seat[2], 6);
    expect(seat[2]).toBeGreaterThan(frontEdge);
  });

  it("is dressed for its Role", () => {
    expect(named(deskOf("designer").own, "screen")).toHaveLength(2);
    expect(named(deskOf("designer").own, "drawing tablet")).toHaveLength(1);
    for (const role of [
      "coder",
      "reviewer",
      "qa",
      "docs",
      "manager",
    ] as const) {
      expect(named(deskOf(role).own, "screen"), role).toHaveLength(1);
    }
    const qa = deskOf("qa");
    expect(named(qa.own, "test tablet")).toHaveLength(1);
    expect(named(qa.own, "test phone")).toHaveLength(1);
    expect(qa.models.map(({ model }) => model)).toEqual(["laptop"]);
    expect(deskOf("docs").models.map(({ model }) => model)).toEqual(["books"]);
    expect(named(deskOf("docs").own, "notebook")).toHaveLength(1);
    expect(named(deskOf("reviewer").own, "printouts")).toHaveLength(1);
    expect(named(deskOf("manager").own, "desk lamp shade")[0]?.surface).toBe(
      "lamp",
    );
  });

  it("is dressed as the Role library dresses its Role, built in or not", () => {
    const library = floorLayout([
      { id: "ada", role: "manager" },
      {
        id: "mo",
        role: "merchandiser",
        stage: "work",
        deskDressing: "product-samples",
      },
      {
        id: "cy",
        role: "copywriter",
        stage: "work",
        deskDressing: "notebooks",
      },
      {
        id: "bo",
        role: "brand-reviewer",
        stage: "review",
        deskDressing: "printouts",
      },
      // The library may dress a built-in Role differently.
      { id: "di", role: "coder", stage: "work", deskDressing: "books" },
      // A Role the Office knows nothing of yet: a monitor, and no stripe.
      { id: "ed", role: "garden-designer" },
    ]);
    const own = (agentId: string) =>
      library.pieces.filter(({ name }) =>
        name.startsWith(`desk of ${agentId},`),
      );
    const deskModels = (agentId: string) =>
      library.desks
        .find((each) => each.agentId === agentId)
        ?.models.map(({ model }) => model);

    // A merchandiser's product samples, the small box in its Stage's colour.
    expect(named(own("mo"), ", product box")).toHaveLength(1);
    expect(named(own("mo"), "small product box")[0]?.token).toBe("stage-work");
    expect(named(own("mo"), "sample jar")).toHaveLength(1);
    expect(named(own("mo"), "stripe")[0]?.token).toBe("stage-work");
    // A copywriter's notebooks: two shut, one open.
    expect(named(own("cy"), ", notebook")).toHaveLength(1);
    expect(named(own("cy"), "notebook on top")).toHaveLength(1);
    expect(named(own("cy"), "open notebook")).toHaveLength(1);
    expect(deskModels("cy")).toEqual([]);
    // A library review Role: printouts, and the review Stage's stripe.
    expect(named(own("bo"), "printouts")).toHaveLength(1);
    expect(named(own("bo"), "stripe")[0]?.token).toBe("stage-review");
    expect(named(own("di"), ", notebook")).toHaveLength(1);
    expect(deskModels("di")).toEqual(["books"]);
    expect(named(own("ed"), "screen")).toHaveLength(1);
    expect(named(own("ed"), "stripe")).toEqual([]);
    expect(named(own("ada"), "stripe")).toEqual([]);
  });

  it("carries its Stage's colour on a stripe along the desk's edge; the Manager's has none", () => {
    const stages: Partial<Record<Role, string>> = {
      coder: "stage-work",
      designer: "stage-work",
      reviewer: "stage-review",
      qa: "stage-qa",
      docs: "stage-docs",
    };
    for (const [role, token] of Object.entries(stages)) {
      expect(named(deskOf(role).own, "stripe")[0]?.token, role).toBe(token);
    }
    expect(named(deskOf("manager").own, "stripe")).toEqual([]);
  });

  it("keeps the ticket pile's spot on the desk's left clear for every Role and desk dressing", () => {
    const dressed = floorLayout(dressedTeam);
    const dressedDesk = (role: Role) => {
      const found = dressed.desks.find((each) => each.role === role);
      if (found === undefined) {
        throw new Error(`No ${role} desk.`);
      }
      return {
        ...found,
        own: dressed.pieces.filter(({ name }) =>
          name.startsWith(`desk of ${found.agentId},`),
        ),
      };
    };
    for (const [role, found] of [
      ...(["manager", ...workRoles] as Role[]).map(
        (each) => [each, deskOf(each)] as const,
      ),
      ...dressedTeam.map(
        ({ role: each }) => [each, dressedDesk(each)] as const,
      ),
    ]) {
      // The ticket pile's rectangle, turned with the desk.
      const [cx, cz] = ticketPile.centre;
      const [width, depth] = ticketPile.size;
      const sign = found.turns === 0 ? 1 : -1;
      const deskCentre = [
        (found.desk.x[0] + found.desk.x[1]) / 2,
        found.seat[2] - sign * 0.7,
      ] as const;
      const pile: Rect = {
        x: [
          deskCentre[0] + sign * cx - width / 2,
          deskCentre[0] + sign * cx + width / 2,
        ],
        z: [
          deskCentre[1] + sign * cz - depth / 2,
          deskCentre[1] + sign * cz + depth / 2,
        ],
      };
      const onTop = [
        ...found.own.filter((piece) => bottom(piece) >= desk.top - 1e-6),
      ].map((piece) => ({ name: piece.name, rect: footprint(piece) }));
      for (const { name, rect } of [
        ...onTop,
        ...found.models.map((each) => ({
          name: each.name,
          rect: modelFootprint(each),
        })),
      ]) {
        expect(overlaps(pile, rect), `${role}: ${name}`).toBe(false);
      }
    }
  });

  it("puts the Manager's desk in the glass office, facing its door", () => {
    const manager = deskOf("manager");
    expect(manager.turns).toBe(2);
    expect(manager.seat[2]).toBeLessThan(manager.desk.z[0]);
  });
});

describe("a Floor's waypoints", () => {
  it.each(sizes)(
    "connect every desk of %i Agents to the lift and every spot",
    (size) => {
      const layout = floorLayout(team(size));
      const { waypoints } = layout;
      const ids = new Set(waypoints.waypoints.map(({ id }) => id));
      expect(ids.size).toBe(waypoints.waypoints.length);
      for (const [a, b] of waypoints.edges) {
        expect(ids.has(a), a).toBe(true);
        expect(ids.has(b), b).toBe(true);
      }
      expect(reachable(waypoints, "lift")).toEqual(ids);
      for (const each of layout.desks) {
        expect(ids.has(each.waypoint), each.waypoint).toBe(true);
        for (const spot of floorSpots) {
          const path = walk(waypoints, each.waypoint, spot);
          expect(path?.[0]?.id, `${each.waypoint} to ${spot}`).toBe(
            each.waypoint,
          );
          expect(path?.at(-1)?.id).toBe(spot);
        }
      }
    },
  );

  it.each(sizes)(
    "keep every path of %i Agents' Floor clear of furniture and walls",
    (size) => {
      const layout = floorLayout(team(size));
      const byId = new Map(
        layout.waypoints.waypoints.map((each) => [each.id, each.position]),
      );
      const blocking = obstacles(layout);
      for (const [a, b] of layout.waypoints.edges) {
        const from = defined(byId.get(a));
        const to = defined(byId.get(b));
        const steps = Math.ceil(distance(from, to) / 0.05);
        for (let step = 0; step <= steps; step += 1) {
          const t = step / steps;
          const at: FloorPoint = [
            from[0] + (to[0] - from[0]) * t,
            from[1] + (to[1] - from[1]) * t,
          ];
          expect(at[0]).toBeGreaterThan(layout.bounds.x[0]);
          expect(at[0]).toBeLessThan(layout.bounds.x[1]);
          expect(at[1]).toBeGreaterThan(layout.bounds.z[0]);
          expect(at[1]).toBeLessThan(layout.bounds.z[1]);
          for (const { name, rect } of blocking) {
            expect(
              clearance(at, rect),
              `${a} to ${b} passes ${name}`,
            ).toBeGreaterThanOrEqual(shoulder);
          }
        }
      }
    },
    // Every path on the Floor: slow under a full parallel run.
    30_000,
  );

  it("put each desk's waypoint just behind its chair, in the walkway", () => {
    const layout = floorLayout(team(12));
    const byId = new Map(
      layout.waypoints.waypoints.map((each) => [each.id, each.position]),
    );
    for (const each of layout.desks) {
      const position = defined(byId.get(each.waypoint));
      expect(distance(position, [each.seat[0], each.seat[2]])).toBeLessThan(
        1.2,
      );
      if (each.zone === "open plan") {
        expect(
          layout.walkways.some(
            ({ x, z }) =>
              position[0] >= x[0] &&
              position[0] <= x[1] &&
              position[1] >= z[0] &&
              position[1] <= z[1],
          ),
        ).toBe(true);
      }
    }
  });

  it("walk the shortest way: from the lift down the aisle to a desk", () => {
    const layout = floorLayout(team(12, { manager: false }));
    const [first] = layout.desks;
    const path = walk(layout.waypoints, "lift", first?.waypoint ?? "") ?? [];
    expect(path.map(({ id }) => id)).toEqual([
      "lift",
      "corridor by the lift",
      "aisle by the gym",
      "aisle by row 1",
      first?.waypoint,
    ]);
    expect(walk(layout.waypoints, "lift", "nowhere")).toBeUndefined();
  });
});

describe("a Floor's rooms and amenities", () => {
  const layout = floorLayout(team(4));
  const named = (name: string) => {
    const found = layout.pieces.find((piece) => piece.name === name);
    if (found === undefined) {
      throw new Error(`No piece named "${name}".`);
    }
    return found;
  };

  it("has the Manager's glass office and the meeting room at the spec's sizes", () => {
    const [officeWidth, officeDepth] = metres("| The Manager's glass office |");
    expect(managersOffice.x[1] - managersOffice.x[0]).toBe(officeWidth);
    expect(managersOffice.z[1] - managersOffice.z[0]).toBe(officeDepth);
    const [roomWidth, roomDepth, boardWidth, boardHeight, boardBottom] = metres(
      "| The meeting room |",
    );
    expect(meetingRoom.x[1] - meetingRoom.x[0]).toBe(roomWidth);
    expect(meetingRoom.z[1] - meetingRoom.z[0]).toBe(roomDepth);
    expect(layout.meetingSeats).toHaveLength(10);
    expect(whiteboard.width).toBe(boardWidth);
    expect(whiteboard.height).toBe(boardHeight);
    expect(whiteboard.centre[1] - whiteboard.height / 2).toBe(boardBottom);
    // Glass from 0.9 m to the ceiling, over a solid base, with a doorway.
    const glass = layout.pieces.filter(
      ({ name, surface }) =>
        name.startsWith("Manager's office") && surface === "glass",
    );
    expect(glass.length).toBeGreaterThan(0);
    for (const pane of glass) {
      expect(top(pane)).toBeCloseTo(floorCeiling, 6);
      expect(bottom(pane)).toBeGreaterThanOrEqual(0.9 - 1e-6);
    }
    expect(top(named("Manager's office front, base 1"))).toBeCloseTo(0.9, 6);
    const [doorWidth = NaN, doorHeight = NaN] = metres("doors are");
    expect(managersOffice.door[1] - managersOffice.door[0]).toBeCloseTo(
      doorWidth,
      6,
    );
    expect(meetingRoom.door[1] - meetingRoom.door[0]).toBeCloseTo(doorWidth, 6);
    expect(
      bottom(named("Manager's office front, glass over the door")),
    ).toBeCloseTo(doorHeight, 6);
  });

  it("has the wall board on the back wall at the spec's size and height", () => {
    const [width, height, centre] = metres("| Wall boards and Notice Boards |");
    expect(wallBoard.width).toBe(width);
    expect(wallBoard.height).toBe(height);
    expect(wallBoard.centre[1]).toBe(centre);
    expect(named("wall board, felt").size.slice(0, 2)).toEqual([width, height]);
    expect(wallBoard.centre[2]).toBe(liftDoorway.position[2]);
  });

  it("has a bookshelf with books, a canteen with a coffee machine, a gym and a water cooler", () => {
    const models = layout.models.map(({ model }) => model);
    expect(models).toContain("bookcase");
    expect(
      models.filter((model) => model === "books").length,
    ).toBeGreaterThanOrEqual(3);
    expect(models).toContain("coffee-machine");
    expect(models).toContain("fridge");
    expect(layout.pieces.some(({ name }) => name.startsWith("treadmill"))).toBe(
      true,
    );
    expect(
      layout.pieces.some(({ name }) => name.startsWith("weight bench")),
    ).toBe(true);
    const cooler = layout.pieces.filter(({ name }) =>
      name.startsWith("water cooler"),
    );
    const height = Math.max(...cooler.map(top));
    expect(height).toBeCloseTo(1.1, 6);
    expect(named("water cooler").size[0]).toBeCloseTo(0.35, 6);
    // The coffee machine stands on the counter's worktop.
    const machine = layout.models.find(
      ({ model }) => model === "coffee-machine",
    );
    expect(machine?.position[1]).toBeCloseTo(
      top(named("canteen counter, worktop")),
      6,
    );
  });

  it("stands on its floor, under its 3 m ceiling", () => {
    for (const each of floorLayout(team(12)).pieces) {
      expect(top(each), each.name).toBeLessThanOrEqual(floorCeiling + 1e-6);
      expect(bottom(each), each.name).toBeGreaterThanOrEqual(
        each.name === "floor" ? -0.1 : -1e-6,
      );
    }
  });

  it("keeps walkways at least 1.5 m wide, on the Floor and clear of furniture and props", () => {
    const [minimum = NaN] = metres("**Walkways** are at least");
    for (const size of [1, 6, 12]) {
      const each = floorLayout(team(size));
      const things = obstacles(each);
      for (const walkway of each.walkways) {
        expect(
          Math.min(walkway.x[1] - walkway.x[0], walkway.z[1] - walkway.z[0]),
          walkway.name,
        ).toBeGreaterThanOrEqual(minimum - 1e-6);
        expect(walkway.x[0]).toBeGreaterThanOrEqual(each.bounds.x[0]);
        expect(walkway.z[1]).toBeLessThanOrEqual(each.bounds.z[1]);
        for (const { name, rect } of things) {
          const piece = each.pieces.find((found) => found.name === name);
          if (piece?.role === "architecture") {
            continue;
          }
          expect(overlaps(walkway, rect), `${walkway.name}: ${name}`).toBe(
            false,
          );
        }
      }
    }
  });

  it("casts shadows from furniture and props only, never from walls", () => {
    expect(
      layout.pieces.every(({ role }) =>
        ["architecture", "furniture", "prop"].includes(role),
      ),
    ).toBe(true);
    for (const name of [
      "back wall",
      "left wall",
      "floor",
      "Manager's office front, glass 1",
    ]) {
      expect(named(name).role).toBe("architecture");
    }
  });
});

describe("a Floor's cost", () => {
  let models: LoadedModels;
  beforeAll(async () => {
    models = await loadModelsFromDisk();
  });

  const modelTriangles = (placements: readonly ModelPlacement[]) =>
    placements.reduce(
      (sum, { model }) =>
        sum +
        models[model].reduce(
          (total, { geometry }) => total + triangles(geometry),
          0,
        ),
      0,
    );
  const pieceTriangles = (pieces: readonly Piece[]) =>
    pieces.reduce((sum, each) => {
      const geometry = pieceGeometry(each);
      const count = triangles(geometry);
      geometry.dispose();
      return sum + count;
    }, 0);

  it("keeps each Role's desk set within the spec's Low budget, the tightest, in every desk dressing", () => {
    const [low = 0] = budget("| A desk set");
    for (const layout of [floorLayout(team(6)), floorLayout(dressedTeam)]) {
      for (const each of layout.desks) {
        const own = layout.pieces.filter(({ name }) =>
          name.startsWith(`desk of ${each.agentId},`),
        );
        const count = pieceTriangles(own) + modelTriangles(each.models);
        expect(count, each.role).toBeLessThanOrEqual(low);
      }
    }
  });

  it("keeps the architecture within Medium's budget, and a 12-Agent Floor well within a frame's", () => {
    const [, medium = 0] = budget("| A Floor's architecture");
    const [, frame = 0] = budget("| Triangles in view, per frame |");
    const layout = floorLayout(team(12));
    const architecture = layout.pieces.filter(
      ({ role }) => role === "architecture",
    );
    expect(pieceTriangles(architecture)).toBeLessThanOrEqual(medium);
    const total = pieceTriangles(layout.pieces) + modelTriangles(layout.models);
    // Room left for 13 Avatars at Medium's 6,000 triangles each.
    expect(total + 13 * 6000).toBeLessThanOrEqual(frame);
  });
});

/** A value a test knows is there. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

/** The numbers in metres in the spec's line that starts with `start`. */
function metres(start: string): number[] {
  const line = spec.split("\n").find((each) => each.includes(start));
  if (line === undefined) {
    throw new Error(`The spec has no line with "${start}".`);
  }
  const after = line.slice(line.indexOf(start) + start.length);
  return [...after.matchAll(/(\d+(?:\.\d+)?) ?m\b/g)].map(([, value]) =>
    Number(value),
  );
}

/** The Low, Medium and High numbers in a row of the spec's limits table. */
function budget(start: string): number[] {
  const line = spec.split("\n").find((each) => each.startsWith(start));
  if (line === undefined) {
    throw new Error(`The spec has no row "${start}".`);
  }
  return line
    .split("|")
    .slice(2, 5)
    .map((cell) => Number(cell.replaceAll(",", "").trim()));
}

describe("the Floor's logo", () => {
  it("hangs on the left wall over the open plan, clear of every piece, for any team", () => {
    const [x, y, z] = floorLogo.position;
    const [width, height] = floorLogo.size;
    // 3 mm proud of the left wall's face, at x = -10.
    expect(x).toBeCloseTo(-10 + 0.003);
    expect(width / height).toBeCloseTo(244 / 64);
    expect(y - height / 2).toBeGreaterThan(1.2);
    expect(y + height / 2).toBeLessThan(floorCeiling);
    expect(z - width / 2).toBeGreaterThan(managersOffice.z[1]);
    for (const size of [0, 1, 4, 12]) {
      const layout = floorLayout(team(size));
      expect(z + width / 2).toBeLessThan(layout.bounds.z[1]);
      // Nothing near the wall reaches up to it.
      const near = layout.pieces.filter(
        ({ position, size: [sx, sy, sz] }) =>
          position[0] - sx / 2 < x + 0.5 &&
          position[1] + sy / 2 > y - height / 2 &&
          position[2] + sz / 2 > z - width / 2 &&
          position[2] - sz / 2 < z + width / 2,
      );
      expect(near.map(({ name }) => name)).toEqual(["left wall"]);
    }
  });
});

describe("the Floor's idle amenities", () => {
  it.each([0, 1, 6, 12])(
    "has the lounge, the gym, the printer and the canteen's extras for %i Agents, each with its waypoint",
    (size) => {
      const layout = floorLayout(team(size));
      const names = new Set(layout.pieces.map(({ name }) => name));
      for (const name of [
        "fish tank",
        "lounge sofa, seat",
        "dartboard",
        "treadmill, deck",
        "weight bench, pad",
        "kettlebell rack",
        "printer",
        "kettle",
        "microwave",
      ]) {
        expect(names.has(name), name).toBe(true);
      }
      const ids = new Set(layout.waypoints.waypoints.map(({ id }) => id));
      for (const spot of floorSpots) {
        expect(ids.has(spot), spot).toBe(true);
      }
      // Deep enough for the gym, past its front.
      expect(layout.bounds.z[1]).toBeGreaterThanOrEqual(gym.z[1]);
    },
  );

  it.each([0, 1, 6, 12, 21, 26])(
    "has the games hall in front of %i Agents' desks: a walkway the Floor's width, and its amenities beyond it, clear of every desk",
    (size) => {
      const layout = floorLayout(team(size));
      const names = new Set(layout.pieces.map(({ name }) => name));
      for (const name of [
        "basketball hoop, backboard",
        "putting green",
        "pool table, felt",
        "table tennis table, top",
        "foosball table, cabinet",
        "chess table, top",
        "bean bag 1",
        "television, screen",
        "piano, keys",
        "piano bench",
        "vending machine",
        "arcade machine",
      ]) {
        expect(names.has(name), name).toBe(true);
      }
      const hall = layout.walkways.find(
        ({ name }) => name === "the games hall",
      );
      expect(hall).toBeDefined();
      const [start = NaN] = hall?.z ?? [];
      expect(start).toBeGreaterThanOrEqual(gamesHall.from);
      expect(hall?.x[1]).toBe(layout.bounds.x[1]);
      const hallPieces = layout.pieces.filter(
        ({ position: [, , z] }) => z > start,
      );
      for (const each of layout.desks) {
        expect(each.footprint.z[1]).toBeLessThanOrEqual(start + 1e-6);
        for (const piece of hallPieces) {
          expect(overlaps(each.footprint, footprint(piece)), piece.name).toBe(
            false,
          );
        }
      }
      // Its amenities are on the Floor, short of its open front.
      for (const piece of hallPieces) {
        const { x, z } = footprint(piece);
        expect(x[0], piece.name).toBeGreaterThanOrEqual(layout.bounds.x[0]);
        expect(x[1], piece.name).toBeLessThanOrEqual(layout.bounds.x[1]);
        expect(z[1], piece.name).toBeLessThanOrEqual(layout.bounds.z[1]);
      }
    },
  );

  it("keeps the theme's zone and the lounge clear of the games hall", () => {
    const layout = floorLayout(team(6));
    const hall = layout.pieces.filter(({ name }) =>
      /basketball|putting|pool|table tennis|foosball|chess|bean bag|television|guitar|piano|vending|arcade/.test(
        name,
      ),
    );
    expect(hall.length).toBeGreaterThan(50);
    for (const piece of hall) {
      const { x, z } = footprint(piece);
      expect(
        overlaps({ x, z }, themeZone) && piece.role !== "architecture",
        piece.name,
      ).toBe(false);
      expect(z[0], piece.name).toBeGreaterThanOrEqual(lounge.walkway.z[1]);
    }
  });
});

describe("the gym", () => {
  /** Every piece of fitness equipment, wherever it once stood. */
  const fitness =
    /^(treadmill|weight bench|kettlebell|yoga mat|exercise bike|rowing machine|punchbag|weights rack|dumbbell|exercise ball)/;
  const gymRect: Rect = { x: gym.x, z: gym.z };
  const inside = (rect: Rect, outer: Rect) =>
    rect.x[0] >= outer.x[0] - 1e-6 &&
    rect.x[1] <= outer.x[1] + 1e-6 &&
    rect.z[0] >= outer.z[0] - 1e-6 &&
    rect.z[1] <= outer.z[1] + 1e-6;

  it.each([0, 6, 12, 26])(
    "has every piece of fitness equipment within its one zone, on its mat, for %i Agents",
    (size) => {
      const layout = floorLayout(team(size));
      const equipment = layout.pieces.filter(({ name }) => fitness.test(name));
      const kinds = new Set(
        equipment.map(({ name }) => fitness.exec(name)?.[1]),
      );
      expect([...kinds].sort()).toEqual(
        [
          "treadmill",
          "weight bench",
          "kettlebell",
          "yoga mat",
          "exercise bike",
          "rowing machine",
          "punchbag",
          "weights rack",
          "dumbbell",
          "exercise ball",
        ].sort(),
      );
      const mat = layout.pieces.find(({ name }) => name === "gym mat");
      expect(mat).toBeDefined();
      const matRect = footprint(defined(mat));
      for (const piece of equipment) {
        expect(inside(footprint(piece), gymRect), piece.name).toBe(true);
        // On the mat, bar the punchbag stand's base at the Floor's edge.
        if (!piece.name.startsWith("punchbag stand")) {
          expect(inside(footprint(piece), matRect), piece.name).toBe(true);
        }
      }
      // Nothing else stands in it but the gym's own walkways.
      const others = layout.pieces.filter(
        (piece) =>
          !fitness.test(piece.name) &&
          piece.role !== "architecture" &&
          overlaps(footprint(piece), gymRect),
      );
      expect(others.map(({ name }) => name)).toEqual([]);
      // It is clear of the games hall, in front of it.
      const hall = defined(
        layout.walkways.find(({ name }) => name === "the games hall"),
      );
      expect(gym.z[1]).toBeLessThanOrEqual(hall.z[0]);
    },
  );

  it("has each of its spots' waypoints and places within it", () => {
    const layout = floorLayout(team(6));
    for (const spot of [
      "gym",
      "treadmill",
      "weight-bench",
      "kettlebells",
      "yoga-mats",
      "exercise-bike",
      "rowing-machine",
      "dumbbells",
      "punchbag",
    ] as const) {
      const waypoint = layout.waypoints.waypoints.find(({ id }) => id === spot);
      const [x = NaN, z = NaN] = waypoint?.position ?? [];
      expect(x, spot).toBeGreaterThanOrEqual(gym.walkwayIn.x[0]);
      expect(z, spot).toBeGreaterThanOrEqual(gym.z[0]);
      expect(z, spot).toBeLessThanOrEqual(gym.z[1]);
      for (const { at, inHall } of idlePlaces[spot]) {
        expect(inHall, spot).toBeUndefined();
        expect(clearance(at, gymRect), spot).toBe(0);
      }
    }
  });
});

describe("the games hall's table games", () => {
  it.each([0, 6, 26])(
    "put the table tennis table beside the pool table and the foosball table, in a row, for %i Agents",
    (size) => {
      const layout = floorLayout(team(size));
      const rect = (name: string) =>
        footprint(defined(layout.pieces.find((piece) => piece.name === name)));
      const pool = rect("pool table, body");
      const tennis = rect("table tennis table, top");
      const foosball = rect("foosball table, cabinet");
      // Left to right: the pool table, the table tennis table, the
      // foosball table, with nothing else on the floor between them.
      expect(pool.x[1]).toBeLessThan(tennis.x[0]);
      expect(tennis.x[1]).toBeLessThan(foosball.x[0]);
      const gaps: Rect[] = [
        { x: [pool.x[1], tennis.x[0]], z: tennis.z },
        { x: [tennis.x[1], foosball.x[0]], z: tennis.z },
      ];
      for (const gap of gaps) {
        // Close enough to read as one group, with room for a player.
        expect(gap.x[1] - gap.x[0]).toBeLessThan(2);
        const between = layout.pieces.filter(
          (piece) =>
            piece.role !== "architecture" &&
            !/^(pool|table tennis|foosball)/.test(piece.name) &&
            overlaps(footprint(piece), gap),
        );
        expect(between.map(({ name }) => name)).toEqual([]);
      }
      // Side by side: each overlaps the others front to back.
      for (const other of [pool, foosball]) {
        expect(other.z[0]).toBeLessThan(tennis.z[1]);
        expect(other.z[1]).toBeGreaterThan(tennis.z[0]);
      }
      // Each is played from the hall's walkway, its players either end.
      const [left, right] = idlePlaces["table-tennis"];
      expect(left?.inHall).toBe(true);
      expect(right?.inHall).toBe(true);
      expect(left?.at[0] ?? NaN).toBeLessThan(tennis.x[0]);
      expect(right?.at[0] ?? NaN).toBeGreaterThan(tennis.x[1]);
    },
  );
});

describe("the adventure and arcade game posters", () => {
  const titles = [
    "Night of the Tentacle",
    "Sam & Bob Hit the Road",
    "Montana Jones and the Fate of Atlantis",
    "Space Quack III",
    "Simone the Sorcerer",
    "Beneath a Tin Sky",
    "Queen's Quest VII: The Princeless Groom",
    "The Secret of Donkey Island",
    "Donkey Island 2: LeDuck's Revenge",
    "Space Intruders",
    "Pac-Mum",
    "Donkey Kongo",
    "Galaxia",
    "Asteroidz",
    "Frogga",
    "Centipeed",
    "Tetrus",
  ];
  const [artWidth, artHeight] = posterSize.art;
  const halfWidth = artWidth / 2 + posterSize.frame;
  const halfHeight = artHeight / 2 + posterSize.frame;
  const backZ = liftDoorway.position[2];

  /** A poster's wall, and its extent along that wall and up it. */
  const onWall = ({ centre: [x, y, z], rotationY }: WallPoster) =>
    rotationY === 0
      ? {
          wall: "back" as const,
          along: [x - halfWidth, x + halfWidth] as const,
          up: [y - halfHeight, y + halfHeight] as const,
        }
      : {
          wall: "left" as const,
          along: [z - halfWidth, z + halfWidth] as const,
          up: [y - halfHeight, y + halfHeight] as const,
        };
  const apart = (a: readonly [number, number], b: readonly [number, number]) =>
    a[1] <= b[0] + 1e-6 || b[1] <= a[0] + 1e-6;

  it("are the seventeen games, each once, framed on the back or the left wall", () => {
    expect(wallPosters.map(({ art }) => art.title).sort()).toEqual(
      [...titles].sort(),
    );
    const layout = floorLayout(team(4));
    const frames = layout.pieces.filter(({ name }) =>
      name.startsWith("poster frame"),
    );
    expect(frames).toHaveLength(17);
    wallPosters.forEach((poster, index) => {
      const [x, , z] = poster.centre;
      const frame = defined(frames[index]);
      expect(frame.role).toBe("architecture");
      if (poster.rotationY === 0) {
        // Its art 2 mm proud of its frame, on the back wall's paint.
        expect(z).toBeCloseTo(backZ + 0.02 + posterSize.depth + 0.002, 6);
        expect(frame.position[2] - frame.size[2] / 2).toBeCloseTo(
          backZ + 0.02,
          6,
        );
      } else {
        expect(poster.rotationY).toBeCloseTo(Math.PI / 2, 6);
        expect(x).toBeCloseTo(-10 + posterSize.depth + 0.002, 6);
        expect(frame.position[0] - frame.size[0] / 2).toBeCloseTo(-10, 6);
      }
    });
    // On more than one wall, each at a height to be seen over the furniture.
    expect(new Set(wallPosters.map((poster) => onWall(poster).wall)).size).toBe(
      2,
    );
    for (const poster of wallPosters) {
      const { up } = onWall(poster);
      expect(up[0]).toBeGreaterThan(1.2);
      expect(up[1]).toBeLessThan(floorCeiling);
    }
  });

  it("all seventeen hang, framed, on every Floor, in every theme, for any team", () => {
    expect(wallPosters).toHaveLength(17);
    for (const theme of floorThemes) {
      for (const size of [0, 1, 4, 12, 20]) {
        for (const manager of [true, false]) {
          const frames = floorLayout(team(size, { manager }), theme)
            .pieces.filter(({ name }) => name.startsWith("poster frame"))
            .map(({ name }) => name);
          expect(frames, `${theme} with ${String(size)}`).toEqual(
            wallPosters.map((_, index) => `poster frame ${String(index + 1)}`),
          );
        }
      }
    }
  });

  it("overlap nothing else on their walls, nor each other, in any theme, for any team", () => {
    const placed = wallPosters.map(onWall);
    placed.forEach((poster, index) => {
      for (const other of placed.slice(index + 1)) {
        if (other.wall === poster.wall) {
          // Side by side, or one above the other (the arcade gallery).
          expect(
            apart(poster.along, other.along) || apart(poster.up, other.up),
          ).toBe(true);
        }
      }
    });
    // Off the walls' ends: the left wall's corner, the lift core and the
    // glass rooms' partitions.
    for (const { wall, along } of placed) {
      if (wall === "back") {
        expect(
          apart(along, [-6.06, -5.94]) &&
            apart(along, [-0.06, 0.06]) &&
            apart(along, [3.6, 6.4]),
        ).toBe(true);
        expect(along[0]).toBeGreaterThan(-10);
      } else {
        expect(along[0]).toBeGreaterThan(managersOffice.z[1] + 0.05);
      }
    }
    // Clear of the logo, the theme's zone along the left wall, and the
    // whiteboard and the wall board on the back wall.
    const logo = [
      floorLogo.position[2] - floorLogo.size[0] / 2,
      floorLogo.position[2] + floorLogo.size[0] / 2,
    ] as const;
    for (const { wall, along } of placed) {
      if (wall === "left") {
        expect(apart(along, logo)).toBe(true);
        expect(apart(along, themeZone.z)).toBe(true);
      } else {
        for (const board of [whiteboard, wallBoard]) {
          expect(
            apart(along, [
              board.centre[0] - board.width / 2 - 0.03,
              board.centre[0] + board.width / 2 + 0.03,
            ]),
          ).toBe(true);
        }
      }
    }
    // Nothing on the floor or the wall reaches into a poster: nothing
    // near its wall, across its extent, at its height, bar the walls.
    const walls =
      /^(back wall|left wall|floor$|meeting room, feature wall|canteen, feature wall|poster frame)/;
    for (const theme of floorThemes) {
      for (const size of [0, 4, 12]) {
        const layout = floorLayout(team(size), theme);
        const things = [
          ...layout.pieces
            .filter(({ name }) => !walls.test(name))
            .map((piece) => ({
              name: piece.name,
              rect: footprint(piece),
              up: [bottom(piece), top(piece)] as const,
            })),
          ...layout.models.map((placement) => ({
            name: placement.name,
            rect: modelFootprint(placement),
            up: [
              placement.position[1],
              placement.position[1] + placedSize(placement)[1],
            ] as const,
          })),
        ];
        for (const poster of placed) {
          for (const { name, rect, up } of things) {
            const near =
              poster.wall === "back"
                ? rect.z[0] < backZ + 0.5
                : rect.x[0] < -10 + 0.5;
            const across = poster.wall === "back" ? rect.x : rect.z;
            const clear =
              !near || apart(across, poster.along) || apart(up, poster.up);
            expect(clear, `${theme}, ${String(size)}: ${name}`).toBe(true);
          }
        }
      }
    }
  });
});

describe("the dartboard", () => {
  const layout = floorLayout(team(4));
  const board = layout.pieces.filter(({ name }) =>
    name.startsWith("dartboard"),
  );

  it("is round, on the lounge's wall at the rules' height, facing the oche", () => {
    const [x, y, z] = lounge.dartboard;
    expect(y).toBe(1.73);
    for (const piece of board) {
      expect(piece.shape, piece.name).toBe("cylinder");
      expect(piece.axis, piece.name).toBe("x");
      expect(piece.position[1]).toBe(y);
      expect(piece.position[2]).toBe(z);
      expect(piece.position[0]).toBeGreaterThan(-10);
      expect(piece.position[0]).toBeLessThan(x + 0.05);
    }
    const base = board.find(({ name }) => name === "dartboard");
    expect(base?.size[1]).toBeCloseTo(2 * dartboardRings.board, 6);
  });

  it("has twenty segments black and cream in turn, red and green doubles and trebles, and a green and red bull", () => {
    const ring = (name: string) =>
      board.filter((piece) =>
        new RegExp(`^dartboard, ${name} \\d+$`).test(piece.name),
      );
    for (const [name, tokens, radius] of [
      ["single", ["ink", "ceramic"], dartboardRings.double[0]],
      ["inner single", ["ink", "ceramic"], dartboardRings.treble[0]],
      ["double", ["state-critical", "plant"], dartboardRings.double[1]],
      ["treble", ["state-critical", "plant"], dartboardRings.treble[1]],
    ] as const) {
      const slices = ring(name);
      expect(slices, name).toHaveLength(20);
      slices.forEach((slice, index) => {
        expect(slice.token, `${name} ${String(index)}`).toBe(tokens[index % 2]);
        expect(slice.size[1]).toBeCloseTo(2 * radius, 6);
        expect(slice.arc?.[1]).toBeCloseTo(Math.PI / 10, 6);
      });
      // Each ring's slices go round the board once.
      const starts = slices.map(({ arc }) => arc?.[0] ?? NaN);
      expect((starts.at(-1) ?? NaN) - (starts[0] ?? NaN)).toBeCloseTo(
        (19 * Math.PI) / 10,
        6,
      );
    }
    const token = (name: string) =>
      board.find((piece) => piece.name === name)?.token;
    expect(token("dartboard")).toBe("ink");
    expect(token("dartboard, outer bull")).toBe("plant");
    expect(token("dartboard, bull")).toBe("state-critical");
    // Each ring proud of the one under it, so its band shows.
    const depthOf = (name: string) =>
      board.find((piece) => piece.name === name)?.position[0] ?? NaN;
    expect(depthOf("dartboard, double 1")).toBeLessThan(
      depthOf("dartboard, single 1"),
    );
    expect(depthOf("dartboard, single 1")).toBeLessThan(
      depthOf("dartboard, treble 1"),
    );
    expect(depthOf("dartboard, treble 1")).toBeLessThan(
      depthOf("dartboard, inner single 1"),
    );
    expect(depthOf("dartboard, inner single 1")).toBeLessThan(
      depthOf("dartboard, outer bull"),
    );
    expect(depthOf("dartboard, outer bull")).toBeLessThan(
      depthOf("dartboard, bull"),
    );
  });
});
