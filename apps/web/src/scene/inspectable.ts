import { communicationsAgentId, type Agent } from "@ai-office/shared";

import type { CameraPose, Vec3 } from "./camera-rig.ts";
import { chair, type Rect } from "./desk-set.ts";
import {
  bookshelf,
  floorLayout,
  managersBookshelf,
  meetingTable,
  wallBoard,
  whiteboard,
} from "./floor-layout.ts";
import { grillingPlace } from "./grilling-walks.ts";
import { lobby, type OfficeLocation } from "./lift-stops.ts";
import { noticeBoardPosition, receptionSeat } from "./lobby-layout.ts";
import { modelCatalogue } from "./model-catalogue.ts";
import { boardSize } from "./notice-board-preview.ts";
import { turnPoint, turnSize, type QuarterTurns } from "./pieces.ts";
import type { SelectableKind, Selection } from "./selection-store.ts";

// The inspectable objects of PRD FR-58, as data: the monitors, the
// whiteboard, the Notice Boards (the lobby's, and each Floor's wall board),
// the bookshelf, and the Manager's bookshelf of Skills (FR-73); the
// Agents themselves, whose panel is the Agent's card (FR-63), with its Avatar Editor (FR-13);
// and, while a Grilling Session runs, its table, whose panel is the
// session chat (FR-83). Clicking the Manager or the whiteboard then opens
// the session chat too. Each one is an object type
// and an id, with where it stands, the box the pointer picks it by and that
// is highlighted, and a camera view close in on it. One mechanism serves them all: the scene's
// hotspots (inspectable-hotspots.tsx), the keyboard list and the HTML
// panel (inspector.tsx), and the Office's address (`inspectHref`).

export const inspectableKinds = [
  "monitor",
  "whiteboard",
  "notice-board",
  "wall-board",
  "bookshelf",
  "skills-bookshelf",
  "agent",
  "grilling-session",
] as const satisfies readonly SelectableKind[];

export type InspectableKind = (typeof inspectableKinds)[number];

/** An inspectable object: its type, and its id (an Agent's for a monitor, the Floor's for its whiteboard). */
export interface Inspectable extends Selection {
  readonly kind: InspectableKind;
}

/** An inspectable object where it stands in the Office. */
export interface InspectableObject extends Inspectable {
  /** What it is called in the list and on its panel, such as "Ada's monitor". */
  readonly label: string;
  /** The lobby, or the Floor it is on. */
  readonly location: OfficeLocation;
  /** The box, in world space, that the pointer picks it by and that is highlighted. */
  readonly box: { readonly centre: Vec3; readonly size: Vec3 };
  /** The camera's view of it, close in. */
  readonly view: CameraPose;
  /**
   * What clicking it in the scene opens, when that is another object: the
   * session chat, for the Manager and the whiteboard while a Grilling
   * Session runs. The keyboard list still opens it itself.
   */
  readonly opens?: Inspectable | undefined;
}

/** The id of the lobby's Notice Board, the office-wide one. */
export const officeNoticeBoardId = "office";

export function isInspectable(
  selection: Selection | undefined,
): selection is Inspectable {
  return (
    selection !== undefined &&
    (inspectableKinds as readonly string[]).includes(selection.kind)
  );
}

/** The name of the camera view close in on an inspectable object. */
export const inspectableViewName = ({ kind, id }: Inspectable) =>
  `inspect:${kind}:${id}`;

/** An inspectable object, and where it is: what the Office's address names. */
export interface InspectTarget extends Inspectable {
  readonly location: OfficeLocation;
}

/** The Office's address's search for an object (see `inspectHref`). */
export interface InspectSearch {
  readonly floor?: string | undefined;
  readonly inspect?: string | undefined;
}

/**
 * The Office's search for an object: `floor`, the Floor it is on (none in
 * the lobby), and `inspect`, its type and id (`monitor:ada`).
 */
export function inspectSearch({
  kind,
  id,
  location,
}: InspectTarget): InspectSearch {
  return location.kind === "floor"
    ? { floor: location.floorId, inspect: `${kind}:${id}` }
    : { inspect: `${kind}:${id}` };
}

/** The object the Office's search names; undefined when it names none. */
export function inspectTargetOf({
  floor,
  inspect,
}: InspectSearch): InspectTarget | undefined {
  const colon = inspect?.indexOf(":") ?? -1;
  if (inspect === undefined || colon < 1 || colon === inspect.length - 1) {
    return undefined;
  }
  const selection = {
    kind: inspect.slice(0, colon),
    id: inspect.slice(colon + 1),
  } as Selection;
  return isInspectable(selection)
    ? {
        kind: selection.kind,
        id: selection.id,
        location:
          floor === undefined ? lobby : { kind: "floor", floorId: floor },
      }
    : undefined;
}

/**
 * The 2D address that opens an object in the Office, from anywhere:
 * `/?floor=web-shop&inspect=monitor:ada`, or `/?inspect=notice-board:office`
 * for the lobby's Notice Board.
 */
export function inspectHref(target: InspectTarget): string {
  const search = new URLSearchParams(
    Object.entries(inspectSearch(target)) as [string, string][],
  );
  return `/?${search.toString()}`;
}

// The camera's lens (office-scene.tsx): 35° up and down, so at 16:9 about
// 58° side to side. These are the tangents of half of each.
const halfHeight = Math.tan((35 / 2) * (Math.PI / 180));
const halfWidth = halfHeight * (16 / 9);

/**
 * The shares of the canvas's width the HTML over it takes beside an open
 * object, on a 1280-pixel canvas: on the left the controls (the view
 * picker, the floor picker and the list, 16 rem and a margin), on the right
 * the panel (20 rem and its margins). The object is framed between them.
 */
export const controlsShare = 0.21;
export const panelShare = 0.27;

/** How much of the free part of the view the object fills, each way at most. */
const fill = 0.85;

/**
 * The view close in on something `size` across (width and height, as seen)
 * at `centre`, its front facing `facing` (a level unit vector). It fills
 * most of the view between the controls and the panel, seen from a little
 * above.
 */
export function viewOf(
  centre: Vec3,
  facing: Vec3,
  [width, height]: readonly [number, number],
  { nearest = 1.3 }: { nearest?: number } = {},
): CameraPose {
  // The free part of the view, on screen from -1 to 1 side to side.
  const freeMiddle = controlsShare - panelShare;
  const freeHalf = 1 - controlsShare - panelShare;
  const distance = Math.max(
    nearest,
    width / (2 * halfWidth * freeHalf * fill),
    height / (2 * halfHeight * fill),
  );
  // The camera's right, looking back at the object's front. Moving the
  // camera that way puts the object in the middle of the free part.
  const right: Vec3 = [facing[2], 0, -facing[0]];
  const aside = -freeMiddle * halfWidth * distance;
  const target: Vec3 = [
    centre[0] + right[0] * aside,
    centre[1],
    centre[2] + right[2] * aside,
  ];
  return {
    position: [
      target[0] + facing[0] * distance,
      centre[1] + 0.15 * distance,
      target[2] + facing[2] * distance,
    ],
    target,
  };
}

/** Facing out from the back wall, into the room. */
const fromBackWall: Vec3 = [0, 0, 1];

/** A board or shelf on the back wall, `depth` deep, standing out of it. */
function onBackWall(
  centre: Vec3,
  [width, height, depth]: readonly [number, number, number],
): Pick<InspectableObject, "box" | "view"> {
  // The hit box reaches 5 cm past the object every way.
  const size: Vec3 = [width + 0.1, height + 0.1, depth + 0.1];
  return {
    box: { centre: [centre[0], centre[1], centre[2] + depth / 2], size },
    view: viewOf(centre, fromBackWall, [width, height]),
  };
}

/** What the inspectables need of an Agent: where its desk is, and its name. */
export type InspectableAgent = Pick<Agent, "id" | "role" | "name">;

/**
 * An Agent sat at its desk, from its seat (on the floor, under the chair's
 * middle): from its knees under the desk's front edge to its chair's back,
 * and up past the top of its head. Before the desk is turned, the Agent
 * faces -z.
 */
export const seatedAgentBox = {
  width: 0.7,
  height: 1.45,
  /** From its seat towards its desk, and away from it. */
  front: 0.4,
  back: chair.size / 2 + 0.05,
} as const;

/** How wide the lobby's reception desk is, end to end. */
const deskWidth = 2.8;

/**
 * The Communications Agent at the lobby's reception desk (FR-96), sat in
 * its chair facing +z, and the view of it over the counter from the front
 * right: from the counter's height, the counter would hide it.
 */
export function communicationsAgentObject(
  name: string | undefined,
): InspectableObject {
  const { width, height, front, back } = seatedAgentBox;
  const centre: Vec3 = [
    receptionSeat[0],
    height / 2,
    receptionSeat[1] + (front - back) / 2,
  ];
  // The whole desk, from end to end, so its out-tray and marker are in
  // view too, looked down on over the counter.
  const view = viewOf(centre, [0.36, 0, 0.93], [deskWidth, height * 1.4], {
    nearest: 3,
  });
  return {
    kind: "agent",
    id: communicationsAgentId,
    label: name ?? "The Communications Agent",
    location: lobby,
    box: { centre, size: [width, height, front + back] },
    view: {
      ...view,
      position: [view.position[0], view.position[1] + 3.4, view.position[2]],
    },
  };
}

/**
 * The lobby's inspectable objects: the office-wide Notice Board, and the
 * Communications Agent at its reception desk, called `communicationsName`
 * once that is known.
 */
export function lobbyInspectables(
  communicationsName?: string,
): InspectableObject[] {
  return [
    {
      kind: "notice-board",
      id: officeNoticeBoardId,
      label: "The Notice Board",
      location: lobby,
      ...onBackWall(noticeBoardPosition, [
        boardSize.width,
        boardSize.height,
        0.05,
      ]),
    },
    communicationsAgentObject(communicationsName),
  ];
}

/**
 * Where the camera may look at a seated Agent from, before its desk is
 * turned, best first: over its right shoulder, then its left, from either
 * side, then from in front at either side. Its desk's wall or a
 * neighbour's screens may be in the way of some; the first clear one is
 * used.
 */
const seatedAgentAngles: readonly [Vec3, ...Vec3[]] = [
  [0.6, 0, 0.8],
  [-0.6, 0, 0.8],
  [1, 0, 0],
  [-1, 0, 0],
  [0.6, 0, -0.8],
  [-0.6, 0, -0.8],
];

/** A box, from its least corner to its greatest. */
interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

const axes = [0, 1, 2] as const;

const boundsOf = (centre: Vec3, size: Vec3): Bounds => ({
  min: axes.map((axis) => centre[axis] - size[axis] / 2) as unknown as Vec3,
  max: axes.map((axis) => centre[axis] + size[axis] / 2) as unknown as Vec3,
});

const overlaps = (a: Bounds, b: Bounds) =>
  axes.every((axis) => a.min[axis] < b.max[axis] && b.min[axis] < a.max[axis]);

/** Whether the segment from `from` to `to` passes through `box`. */
function crosses(from: Vec3, to: Vec3, box: Bounds): boolean {
  let enter = 0;
  let leave = 1;
  for (const axis of axes) {
    const step = to[axis] - from[axis];
    if (Math.abs(step) < 1e-12) {
      if (from[axis] < box.min[axis] || from[axis] > box.max[axis]) {
        return false;
      }
      continue;
    }
    const near = (box.min[axis] - from[axis]) / step;
    const far = (box.max[axis] - from[axis]) / step;
    enter = Math.max(enter, Math.min(near, far));
    leave = Math.min(leave, Math.max(near, far));
    if (enter > leave) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a view of `box` is clear: the camera inside `bounds` and in
 * nothing solid, and nothing solid between it and the box's middle but
 * what is in the box itself (the Agent's chair).
 */
function clearView(
  view: CameraPose,
  box: Bounds,
  centre: Vec3,
  solids: readonly Bounds[],
  bounds: Rect,
): boolean {
  const [x, , z] = view.position;
  const camera = boundsOf(view.position, [0.3, 0.3, 0.3]);
  return (
    x > bounds.x[0] &&
    x < bounds.x[1] &&
    z > bounds.z[0] &&
    z < bounds.z[1] &&
    solids.every(
      (solid) =>
        !overlaps(solid, camera) &&
        (overlaps(solid, box) || !crosses(view.position, centre, solid)),
    )
  );
}

/**
 * The meeting room's table and its chairs, where a Grilling Session sits
 * (FR-83), and the view down into the room over its glass front (the
 * Floor is a cut-away, with no ceiling): the table, the Manager's seat and
 * the whiteboard behind it, between the controls and the panel. From
 * inside the room, 4 m deep, the lens could not take in the table.
 */
export const grillingTableBox: Pick<InspectableObject, "box" | "view"> = {
  box: {
    centre: [meetingTable.centre[0], 0.5, meetingTable.centre[1]],
    size: [meetingTable.size[0] + 1.3, 1, meetingTable.size[1] + 1.1],
  },
  view: {
    position: [-1.65, 10, 1.8],
    target: [-2.7, 0.9, -4.3],
  },
};

/**
 * A Floor's inspectable objects: its whiteboard, wall board, bookshelf and
 * the bookshelf in the Manager's office, then each Agent's monitor, then
 * each Agent, in the order the Agents came; and, while a Grilling Session
 * runs, its table last. The Manager is then at the table, and clicking it,
 * or the whiteboard, opens the session chat (FR-83).
 */
export function floorInspectables(
  floorId: string,
  agents: readonly InspectableAgent[],
  {
    grilling = false,
  }: {
    /** Whether a Grilling Session runs: its Manager is at the meeting room's table. */
    grilling?: boolean;
  } = {},
): InspectableObject[] {
  const location: OfficeLocation = { kind: "floor", floorId };
  const layout = floorLayout(agents);
  const { desks } = layout;
  // Everything solid on the Floor, as boxes, for the Agents' views.
  let solidBoxes: Bounds[] | undefined;
  const solids = () =>
    (solidBoxes ??= [
      ...layout.pieces.map(({ position, size }) => boundsOf(position, size)),
      ...layout.models.map(({ model, position: [x, y, z], turns }) => {
        const [w, h, d] = modelCatalogue[model].size;
        return boundsOf(
          [x, y + h / 2, z],
          turns % 2 === 0 ? [w, h, d] : [d, h, w],
        );
      }),
    ]);
  const names = new Map(agents.map(({ id, name }) => [id, name]));
  const [shelfWidth, shelfHeight, shelfDepth] = bookshelf.size;
  /** An Agent sat at `seat`, facing `turns`: at its desk, or at the meeting room's table. */
  const agentObject = (
    agentId: string,
    seat: Vec3,
    turns: QuarterTurns,
  ): InspectableObject => {
    const { width, height, front, back } = seatedAgentBox;
    const centre = turnPoint([0, height / 2, (back - front) / 2], turns, [
      seat[0],
      seat[2],
    ]);
    const size = turnSize([width, height, front + back], turns);
    const box = boundsOf(centre, size);
    // Seen from a corner, its box is wider than its face, and its
    // nearer corners loom: framed with room for both.
    const viewFrom = (angle: Vec3) =>
      viewOf(
        centre,
        turnPoint(angle, turns, [0, 0]),
        [
          width * Math.abs(angle[2]) + (front + back) * Math.abs(angle[0]),
          height * 1.15,
        ],
        { nearest: 2 },
      );
    return {
      kind: "agent",
      id: agentId,
      label: names.get(agentId) ?? "An Agent",
      location,
      box: { centre, size },
      view:
        seatedAgentAngles
          .map(viewFrom)
          .find((view) =>
            clearView(view, box, centre, solids(), layout.bounds),
          ) ?? viewFrom(seatedAgentAngles[0]),
    };
  };
  // While a Grilling Session runs, the Manager sits at the meeting room's
  // table, facing it (+z: half a turn), and the table opens the session.
  const managerId = agents.find(({ role }) => role === "manager")?.id;
  const place = grillingPlace(layout);
  const meetingSeat =
    place === undefined
      ? undefined
      : {
          seat: [place.at[0], 0, place.at[1]] as Vec3,
          turns: 2 as const,
        };
  const session: Inspectable = { kind: "grilling-session", id: floorId };
  const sessionObject: InspectableObject = {
    ...session,
    label: "The Grilling Session",
    location,
    ...grillingTableBox,
  };
  return [
    {
      kind: "whiteboard",
      id: floorId,
      label: "The whiteboard",
      location,
      ...onBackWall(whiteboard.centre, [
        whiteboard.width,
        whiteboard.height,
        0.04,
      ]),
      ...(grilling ? { opens: session } : {}),
    },
    {
      kind: "wall-board",
      id: floorId,
      label: "The wall board",
      location,
      ...onBackWall(wallBoard.centre, [
        wallBoard.width,
        wallBoard.height,
        0.05,
      ]),
    },
    {
      kind: "bookshelf",
      id: floorId,
      label: "The bookshelf",
      location,
      ...onBackWall(
        [bookshelf.at[0], shelfHeight / 2, bookshelf.at[2] - shelfDepth / 2],
        [shelfWidth, shelfHeight, shelfDepth],
      ),
    },
    {
      kind: "skills-bookshelf",
      id: floorId,
      label: "The Manager's bookshelf",
      location,
      ...onBackWall(
        [
          managersBookshelf.at[0],
          shelfHeight / 2,
          managersBookshelf.at[2] - shelfDepth / 2,
        ],
        [shelfWidth, shelfHeight, shelfDepth],
      ),
    },
    ...desks.map(({ agentId, screens, turns }): InspectableObject => {
      // The screens face the chair: +z before the desk is turned.
      const facing = turnPoint([0, 0, 1], turns, [0, 0]);
      const across = turns % 2 === 0 ? screens.size[0] : screens.size[2];
      return {
        kind: "monitor",
        id: agentId,
        label: `${names.get(agentId) ?? "An Agent"}'s monitor`,
        location,
        box: {
          centre: screens.centre,
          // 20 cm deep, to take in the stand behind the screen.
          size: turnSize([across + 0.1, screens.size[1] + 0.1, 0.2], turns),
        },
        view: viewOf(screens.centre, facing, [across, screens.size[1]]),
      };
    }),
    ...desks.map(({ agentId, seat, turns }): InspectableObject => {
      const manager = grilling && agentId === managerId;
      const at = manager ? meetingSeat : undefined;
      return {
        ...agentObject(agentId, at?.seat ?? seat, at?.turns ?? turns),
        ...(manager ? { opens: session } : {}),
      };
    }),
    ...(grilling ? [sessionObject] : []),
  ];
}
