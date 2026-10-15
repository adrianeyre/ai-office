import { communicationsAgentId, type Role } from "@ai-office/shared";
import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import type { Vec3 } from "./camera-rig.ts";
import { monitor } from "./desk-set.ts";
import {
  bookshelf,
  floorLayout,
  managersBookshelf,
  managersOffice,
  whiteboard,
} from "./floor-layout.ts";
import {
  floorInspectables,
  inspectableKinds,
  inspectableViewName,
  inspectHref,
  inspectSearch,
  inspectTargetOf,
  isInspectable,
  lobbyInspectables,
  controlsShare,
  officeNoticeBoardId,
  panelShare,
  type InspectableAgent,
  type InspectableObject,
} from "./inspectable.ts";
import { lobby } from "./lift-stops.ts";
import { lobbyPieces, lobbySize, receptionSeat } from "./lobby-layout.ts";
import { placedSize } from "./models.ts";
import type { Piece } from "./pieces.ts";

// The inspectable objects of PRD FR-58 as data: one of each where it
// stands, a box over each that takes in what is drawn there, and a view
// close in on each that shows it whole, clear of the panel, with nothing
// in the way.

const roles: Role[] = ["coder", "reviewer", "qa", "docs", "designer"];

/** A Manager, then `size - 1` Agents in the Roles in turn. */
const team = (size: number): InspectableAgent[] =>
  Array.from({ length: size }, (_, index) => ({
    id: `agent-${String(index + 1)}`,
    name: `Agent ${String(index + 1)}`,
    role:
      index === 0 ? "manager" : (roles[(index - 1) % roles.length] ?? "coder"),
  }));

interface Box {
  readonly min: Vec3;
  readonly max: Vec3;
}

const axes = [0, 1, 2] as const;

const boxOf = (centre: Vec3, size: Vec3): Box => {
  const edge = (sign: number) =>
    axes.map((axis) => centre[axis] + (sign * size[axis]) / 2) as [
      number,
      number,
      number,
    ];
  return { min: edge(-1), max: edge(1) };
};

const pieceBox = (piece: Piece) => boxOf(piece.position, piece.size);

const contains = (outer: Box, inner: Box) =>
  axes.every(
    (axis) =>
      outer.min[axis] <= inner.min[axis] + 1e-9 &&
      inner.max[axis] <= outer.max[axis] + 1e-9,
  );

const overlaps = (a: Box, b: Box) =>
  axes.every((axis) => a.min[axis] < b.max[axis] && b.min[axis] < a.max[axis]);

/** Whether the segment from `from` to `to` passes through `box` (the slab method). */
function crosses(from: Vec3, to: Vec3, box: Box): boolean {
  let enter = 0;
  let leave = 1;
  for (const axis of axes) {
    const start = from[axis];
    const step = to[axis] - start;
    if (Math.abs(step) < 1e-12) {
      if (start < box.min[axis] || start > box.max[axis]) {
        return false;
      }
      continue;
    }
    const near = (box.min[axis] - start) / step;
    const far = (box.max[axis] - start) / step;
    enter = Math.max(enter, Math.min(near, far));
    leave = Math.min(leave, Math.max(near, far));
    if (enter > leave) {
      return false;
    }
  }
  return true;
}

/** A value a test expects to be there. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

const hitBox = (object: InspectableObject) =>
  boxOf(object.box.centre, object.box.size);

/** Everything solid in a place: its pieces, and its models as boxes. */
function solids(
  pieces: readonly Piece[],
  models: ReturnType<typeof floorLayout>["models"] = [],
): { name: string; box: Box }[] {
  return [
    ...pieces.map((piece) => ({ name: piece.name, box: pieceBox(piece) })),
    ...models.map((placement) => {
      const size = placedSize(placement);
      const [x, y, z] = placement.position;
      return {
        name: placement.name,
        box: boxOf([x, y + size[1] / 2, z], size),
      };
    }),
  ];
}

/** The camera of office-scene.tsx at a view, on a 16:9 canvas. */
function cameraAt(object: InspectableObject): PerspectiveCamera {
  const camera = new PerspectiveCamera(35, 16 / 9, 0.1, 200);
  camera.position.set(...object.view.position);
  camera.lookAt(...object.view.target);
  camera.updateMatrixWorld();
  return camera;
}

/** Where a box's corners are on screen, from -1 to 1 each way. */
function onScreen(camera: PerspectiveCamera, box: Box): Vector3[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((corner) =>
    new Vector3(
      corner & 1 ? box.max[0] : box.min[0],
      corner & 2 ? box.max[1] : box.min[1],
      corner & 4 ? box.max[2] : box.min[2],
    ).project(camera),
  );
}

/** Where the controls end and the panel starts on screen, from -1 to 1. */
const controlsEdge = -1 + 2 * controlsShare;
const panelEdge = 1 - 2 * panelShare;

/**
 * Checks a place's objects' views: each shows its object whole, left of
 * the panel; the camera is in nothing solid; and nothing solid stands
 * between it and the object's front.
 */
function expectClearViews(
  objects: readonly InspectableObject[],
  things: { name: string; box: Box }[],
) {
  for (const object of objects) {
    const hit = hitBox(object);
    const camera = cameraAt(object);
    for (const corner of onScreen(camera, hit)) {
      expect(corner.x, object.label).toBeGreaterThan(controlsEdge);
      expect(corner.x, object.label).toBeLessThan(panelEdge);
      expect(Math.abs(corner.y), object.label).toBeLessThan(1);
    }
    const [x, , z] = object.view.position;
    const inside = things.filter(({ box }) =>
      overlaps(box, boxOf(object.view.position, [0.3, 0.3, 0.3])),
    );
    expect(
      inside.map(({ name }) => name),
      object.label,
    ).toEqual([]);
    expect(Number.isFinite(x + z)).toBe(true);

    // Its own parts are inside its box; anything else is in the way.
    const inTheWay = things.filter(
      ({ box }) =>
        !overlaps(box, hit) &&
        crosses(object.view.position, object.box.centre, box),
    );
    expect(
      inTheWay.map(({ name }) => name),
      object.label,
    ).toEqual([]);
  }
}

describe("a Floor's inspectable objects", () => {
  it("are its whiteboard, wall board, bookshelf and the Manager's bookshelf, then each Agent's monitor, then each Agent, in order", () => {
    const objects = floorInspectables("web-shop", team(4));
    expect(objects.map(({ kind, id, label }) => [kind, id, label])).toEqual([
      ["whiteboard", "web-shop", "The whiteboard"],
      ["wall-board", "web-shop", "The wall board"],
      ["bookshelf", "web-shop", "The bookshelf"],
      ["skills-bookshelf", "web-shop", "The Manager's bookshelf"],
      ["monitor", "agent-1", "Agent 1's monitor"],
      ["monitor", "agent-2", "Agent 2's monitor"],
      ["monitor", "agent-3", "Agent 3's monitor"],
      ["monitor", "agent-4", "Agent 4's monitor"],
      ["agent", "agent-1", "Agent 1"],
      ["agent", "agent-2", "Agent 2"],
      ["agent", "agent-3", "Agent 3"],
      ["agent", "agent-4", "Agent 4"],
    ]);
    for (const object of objects) {
      expect(object.location).toEqual({ kind: "floor", floorId: "web-shop" });
      expect(isInspectable(object)).toBe(true);
    }
    // With no Agents, the room's objects are still there.
    expect(floorInspectables("web-shop", []).map(({ kind }) => kind)).toEqual([
      "whiteboard",
      "wall-board",
      "bookshelf",
      "skills-bookshelf",
    ]);
  });

  it.each(Array.from({ length: 12 }, (_, index) => index + 1))(
    "put a box over every screen of %i Agents' desks, and over each board and both bookshelves",
    (size) => {
      const agents = team(size);
      const layout = floorLayout(agents);
      const objects = floorInspectables("web-shop", agents);
      const named = (name: string) =>
        layout.pieces.filter((piece) => piece.name === name);

      for (const { id, role } of agents) {
        const object = defined(
          objects.find((each) => each.kind === "monitor" && each.id === id),
        );
        const hit = hitBox(object);
        const screens = layout.pieces.filter(
          ({ name }) =>
            name.startsWith(`desk of ${id}, monitor`) &&
            name.endsWith("screen"),
        );
        expect(screens).toHaveLength(role === "designer" ? 2 : 1);
        for (const screen of screens) {
          expect(contains(hit, pieceBox(screen)), screen.name).toBe(true);
        }
        // No bigger than the desk is wide, so it picks this desk's screens alone.
        expect(Math.max(object.box.size[0], object.box.size[2])).toBeLessThan(
          1.4,
        );
      }
      const box = (kind: string) =>
        hitBox(defined(objects.find((each) => each.kind === kind)));
      for (const piece of named("whiteboard")) {
        expect(contains(box("whiteboard"), pieceBox(piece))).toBe(true);
      }
      for (const piece of named("wall board, felt")) {
        expect(contains(box("wall-board"), pieceBox(piece))).toBe(true);
      }
      const [x, , z] = bookshelf.at;
      expect(
        contains(
          box("bookshelf"),
          boxOf([x, bookshelf.size[1] / 2, z], bookshelf.size),
        ),
      ).toBe(true);
      const [managersX, , managersZ] = managersBookshelf.at;
      expect(
        contains(
          box("skills-bookshelf"),
          boxOf(
            [managersX, managersBookshelf.size[1] / 2, managersZ],
            managersBookshelf.size,
          ),
        ),
      ).toBe(true);
      // Inside the Manager's glass office.
      expect(managersX).toBeGreaterThan(managersOffice.x[0]);
      expect(managersX).toBeLessThan(managersOffice.x[1]);

      // No two boxes overlap, so each click picks one object.
      for (const [index, a] of objects.entries()) {
        for (const b of objects.slice(index + 1)) {
          expect(
            overlaps(hitBox(a), hitBox(b)),
            `${a.label} and ${b.label}`,
          ).toBe(false);
        }
      }
    },
  );

  it.each(Array.from({ length: 12 }, (_, index) => index + 1))(
    "fly in to each of %i Agents' Floor's objects, seeing it whole between the controls and the panel, with nothing in the way",
    (size) => {
      const agents = team(size);
      const layout = floorLayout(agents);
      const objects = floorInspectables("web-shop", agents);
      expectClearViews(objects, solids(layout.pieces, layout.models));
      for (const object of objects) {
        const [x, y, z] = object.view.position;
        expect(x).toBeGreaterThan(layout.bounds.x[0]);
        expect(x).toBeLessThan(layout.bounds.x[1]);
        expect(z).toBeGreaterThan(layout.bounds.z[0]);
        expect(z).toBeLessThan(layout.bounds.z[1]);
        expect(y).toBeGreaterThan(0.5);
        expect(y).toBeLessThan(3);
      }
    },
  );

  it.each(Array.from({ length: 12 }, (_, index) => index + 1))(
    "put a box over each of %i Agents sat at their desks: their chairs, and up past their heads",
    (size) => {
      const agents = team(size);
      const layout = floorLayout(agents);
      const objects = floorInspectables("web-shop", agents);
      for (const { id } of agents) {
        const object = defined(
          objects.find((each) => each.kind === "agent" && each.id === id),
        );
        const hit = hitBox(object);
        const chair = layout.pieces.filter(({ name }) =>
          name.startsWith(`desk of ${id}, chair`),
        );
        expect(chair).toHaveLength(4);
        for (const piece of chair) {
          expect(contains(hit, pieceBox(piece)), piece.name).toBe(true);
        }
        // The tallest Avatar (1.85 m) sits with its head at about 1.3 m.
        expect(hit.max[1]).toBeGreaterThan(1.4);
        expect(hit.min[1]).toBe(0);
        // Its knees, under the desk's front edge; never the screens.
        const desk = defined(
          layout.pieces.find(({ name }) => name === `desk of ${id}, desk top`),
        );
        expect(overlaps(hit, pieceBox(desk))).toBe(true);
      }
    },
  );

  it("while a Grilling Session runs: its table, the Manager sat there, and the whiteboard and the Manager opening the session chat", () => {
    const agents = team(4);
    const layout = floorLayout(agents);
    const objects = floorInspectables("web-shop", agents, { grilling: true });
    expect(objects.map(({ kind, id }) => `${kind}:${id}`)).toEqual([
      ...floorInspectables("web-shop", agents).map(
        ({ kind, id }) => `${kind}:${id}`,
      ),
      "grilling-session:web-shop",
    ]);
    const session = defined(
      objects.find(({ kind }) => kind === "grilling-session"),
    );
    expect(session.label).toBe("The Grilling Session");
    expect(isInspectable(session)).toBe(true);
    // Clicking the whiteboard or the Manager opens the session; nothing else does.
    expect(
      objects
        .filter(({ opens }) => opens !== undefined)
        .map(({ kind, id, opens }) => [kind, id, opens]),
    ).toEqual([
      ["whiteboard", "web-shop", { kind: "grilling-session", id: "web-shop" }],
      ["agent", "agent-1", { kind: "grilling-session", id: "web-shop" }],
    ]);
    // The table and its chairs are in the session's box.
    const table = layout.pieces.filter(
      ({ name }) =>
        name.startsWith("meeting table") || name.startsWith("meeting chair"),
    );
    expect(table.length).toBeGreaterThan(10);
    for (const piece of table) {
      expect(contains(hitBox(session), pieceBox(piece)), piece.name).toBe(true);
    }
    // The Manager's box is over the meeting chair it sits in, not its desk.
    const manager = hitBox(
      defined(
        objects.find(({ kind, id }) => kind === "agent" && id === "agent-1"),
      ),
    );
    for (const piece of layout.pieces.filter(({ name }) =>
      name.startsWith("meeting chair 5,"),
    )) {
      expect(contains(manager, pieceBox(piece)), piece.name).toBe(true);
    }
    expect(manager.max[1]).toBeGreaterThan(1.4);
    // Its view looks down into the room over its glass front: the table
    // whole between the controls and the panel, the Manager and the
    // whiteboard on screen, and nothing in the way of the table.
    const camera = cameraAt(session);
    for (const corner of onScreen(camera, hitBox(session))) {
      expect(corner.x).toBeGreaterThan(controlsEdge);
      expect(corner.x).toBeLessThan(panelEdge);
      expect(Math.abs(corner.y)).toBeLessThan(1);
    }
    for (const corner of [
      ...onScreen(camera, manager),
      ...onScreen(
        camera,
        boxOf(whiteboard.centre, [whiteboard.width, whiteboard.height, 0]),
      ),
    ]) {
      expect(corner.x).toBeGreaterThan(controlsEdge);
      expect(corner.x).toBeLessThan(panelEdge);
      expect(Math.abs(corner.y)).toBeLessThan(1);
    }
    const inTheWay = solids(layout.pieces, layout.models).filter(
      ({ box }) =>
        !overlaps(box, hitBox(session)) &&
        crosses(session.view.position, session.box.centre, box),
    );
    expect(inTheWay.map(({ name }) => name)).toEqual([]);
  });

  it("comes close in: a monitor fills a good part of the view", () => {
    const [manager, coder] = floorInspectables("web-shop", team(2)).filter(
      ({ kind }) => kind === "monitor",
    );
    for (const object of [defined(manager), defined(coder)]) {
      const camera = cameraAt(object);
      const screen = boxOf(object.box.centre, [
        monitor.width,
        monitor.height,
        0,
      ]);
      const corners = onScreen(camera, screen);
      const xs = corners.map(({ x }) => x);
      // At least a fifth of the canvas wide.
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.4);
    }
  });
});

describe("the lobby's inspectable objects", () => {
  it("are the office-wide Notice Board and the Communications Agent at reception", () => {
    const objects = lobbyInspectables("Grace");
    expect(
      objects.map(({ kind, id, label, location }) => [
        kind,
        id,
        label,
        location,
      ]),
    ).toEqual([
      ["notice-board", officeNoticeBoardId, "The Notice Board", lobby],
      ["agent", communicationsAgentId, "Grace", lobby],
    ]);
    const hit = hitBox(defined(objects[0]));
    for (const piece of lobbyPieces.filter(
      ({ name }) => name === "Notice Board, felt",
    )) {
      expect(contains(hit, pieceBox(piece))).toBe(true);
    }
    // Until its name is known, it goes by what it is.
    expect(lobbyInspectables()[1]?.label).toBe("The Communications Agent");
  });

  it("pick the Communications Agent by its seat at the reception desk", () => {
    const agent = defined(lobbyInspectables("Grace")[1]);
    const hit = hitBox(agent);
    const [x, z] = receptionSeat;
    expect(contains(hit, boxOf([x, 0.8, z], [0.4, 1, 0.3]))).toBe(true);
    // Its chair's seat is in it; the counter in front is not.
    const seat = lobbyPieces.find(
      ({ name }) => name === "reception chair, seat",
    );
    expect(overlaps(hit, pieceBox(defined(seat)))).toBe(true);
    const counter = lobbyPieces.find(
      ({ name }) => name === "reception counter, front",
    );
    expect(overlaps(hit, pieceBox(defined(counter)))).toBe(false);
  });

  it("fly in to each, seeing it whole between the controls and the panel, with nothing in the way", () => {
    const objects = lobbyInspectables("Grace");
    expectClearViews(objects, solids(lobbyPieces));
    for (const object of objects) {
      const [x, , z] = object.view.position;
      expect(Math.abs(x)).toBeLessThan(lobbySize.width / 2);
      expect(Math.abs(z)).toBeLessThan(lobbySize.depth / 2);
    }
  });
});

describe("an inspectable object's names", () => {
  it("has a camera view of its own", () => {
    expect(inspectableViewName({ kind: "monitor", id: "ada" })).toBe(
      "inspect:monitor:ada",
    );
  });

  it("are the five object types of FR-58, the Manager's bookshelf of Skills (FR-73), the Agents (FR-13) and a running Grilling Session (FR-83)", () => {
    expect(inspectableKinds).toEqual([
      "monitor",
      "whiteboard",
      "notice-board",
      "wall-board",
      "bookshelf",
      "skills-bookshelf",
      "agent",
      "grilling-session",
    ]);
    expect(isInspectable({ kind: "agent", id: "ada" })).toBe(true);
    expect(isInspectable(undefined)).toBe(false);
  });

  it("has an address in the Office, and is read back from it", () => {
    const monitor = {
      kind: "monitor",
      id: "ada",
      location: { kind: "floor", floorId: "web-shop" },
    } as const;
    expect(inspectSearch(monitor)).toEqual({
      floor: "web-shop",
      inspect: "monitor:ada",
    });
    expect(inspectHref(monitor)).toBe("/?floor=web-shop&inspect=monitor%3Aada");
    expect(inspectTargetOf(inspectSearch(monitor))).toEqual(monitor);

    const board = {
      kind: "notice-board",
      id: officeNoticeBoardId,
      location: lobby,
    } as const;
    expect(inspectHref(board)).toBe("/?inspect=notice-board%3Aoffice");
    expect(inspectTargetOf(inspectSearch(board))).toEqual(board);

    const agent = {
      kind: "agent",
      id: "ada",
      location: { kind: "floor", floorId: "web-shop" },
    } as const;
    expect(inspectHref(agent)).toBe("/?floor=web-shop&inspect=agent%3Aada");
    expect(inspectTargetOf(inspectSearch(agent))).toEqual(agent);

    // An id may hold a colon; only the first one ends the type.
    expect(inspectTargetOf({ inspect: "monitor:a:b" })?.id).toBe("a:b");
  });

  it("reads nothing from an address that names no object", () => {
    for (const inspect of [
      undefined,
      "",
      "monitor",
      "monitor:",
      ":ada",
      "desk:ada",
    ]) {
      expect(
        inspectTargetOf({ floor: "web-shop", inspect }),
        inspect,
      ).toBeUndefined();
    }
  });
});
