import type { DeskItemKind } from "@ai-office/shared/avatar";
import { randomAvatar, seededRandom } from "@ai-office/shared/avatar";

import { deskItemGeometry } from "./avatar-geometry.ts";
import {
  desk,
  deskSet,
  ticketPile,
  type DeskRole,
  type Rect,
} from "./desk-set.ts";
import { placedSize } from "./models.ts";
import { footprint } from "./pieces.ts";

// Where the things an Avatar keeps on its desk go (FR-13): each at its
// real size (a laptop 32 cm across, A4 paper, a 30 cm ruler), laid out in
// the order chosen wherever the desk has room, clear of the ticket pile,
// the mascot and the Role's own dressing. One that does not fit on that
// desk is left off it.

/**
 * How much bigger than its shapes each item is drawn: the shapes are
 * modelled small, and this brings each to its real size.
 */
export const deskItemScale: Readonly<Record<DeskItemKind, number>> = {
  laptop: 3.2,
  pen: 1.55,
  pencil: 1.9,
  paper: 3,
  ruler: 3,
  notebook: 2.2,
  "coffee-mug": 1.27,
  stapler: 1.7,
  "desk-lamp": 2.5,
  "potted-plant": 2,
  "sticky-notes": 1.5,
  calculator: 1.67,
  scissors: 2,
  "tape-dispenser": 1.55,
  "paper-clips": 1.25,
  "pen-pot": 1.2,
  headphones: 1.8,
  phone: 1.95,
  tablet: 2.5,
  "water-bottle": 1.45,
  "book-stack": 2.5,
  "desk-clock": 1.65,
  "photo-frame": 2,
  "tissue-box": 2.4,
  eraser: 1.1,
  highlighter: 1.35,
  envelope: 2.4,
  apple: 1.25,
  trophy: 1.8,
  globe: 2.4,
};

/** An item's size on the desk at its real size, and its centre's offset from its origin. */
export interface DeskItemFootprint {
  /** Across (x) and front to back (z), in metres. */
  readonly size: readonly [number, number];
  /** Where its footprint's centre is from the point it stands on. */
  readonly centre: readonly [number, number];
}

const footprints = new Map<DeskItemKind, DeskItemFootprint>();

/** An item's footprint at its real size. */
export function deskItemFootprint(item: DeskItemKind): DeskItemFootprint {
  const known = footprints.get(item);
  if (known !== undefined) {
    return known;
  }
  const geometry = deskItemGeometry(randomAvatar(seededRandom(item)), item, 2);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  geometry.dispose();
  const scale = deskItemScale[item];
  const [minX, maxX, minZ, maxZ] = [
    box?.min.x ?? 0,
    box?.max.x ?? 0,
    box?.min.z ?? 0,
    box?.max.z ?? 0,
  ];
  const found: DeskItemFootprint = {
    size: [(maxX - minX) * scale, (maxZ - minZ) * scale],
    centre: [((maxX + minX) / 2) * scale, ((maxZ + minZ) / 2) * scale],
  };
  footprints.set(item, found);
  return found;
}

/**
 * A desk item laid out on the desk: where it stands about the desk's
 * centre (its origin, not its footprint's centre), and its turn.
 */
export interface DeskItemPlacement {
  readonly item: DeskItemKind;
  readonly x: number;
  readonly z: number;
  /** About the vertical, from facing the Agent: 0 or a quarter turn. */
  readonly rotation: number;
}

/** Where the desk mascot stands, about the desk's centre. */
export const mascotSpot = { x: -0.64, z: -0.27 } as const;
const mascotHalf = 0.065;

const overlaps = (a: Rect, b: Rect) =>
  a.x[0] < b.x[1] && b.x[0] < a.x[1] && a.z[0] < b.z[1] && b.z[0] < a.z[1];

const taken = new Map<string, readonly Rect[]>();

/** What already stands on a desk of `owner`'s look, about its centre. */
function takenOn(owner: DeskRole): readonly Rect[] {
  const key = JSON.stringify([owner.role, owner.stage, owner.deskDressing]);
  const known = taken.get(key);
  if (known !== undefined) {
    return known;
  }
  const set = deskSet("desk", owner, [0, 0], 0);
  const [px, pz] = ticketPile.centre;
  const [pw, pd] = ticketPile.size;
  const found: Rect[] = [
    ...set.pieces
      .filter(
        (piece) =>
          piece.position[1] - piece.size[1] / 2 >= desk.top - 1e-6 &&
          !piece.name.endsWith("desk top"),
      )
      .map((piece) => footprint(piece)),
    ...set.models.map((placement): Rect => {
      const [width, , depth] = placedSize(placement);
      const [x, , z] = placement.position;
      return {
        x: [x - width / 2, x + width / 2],
        z: [z - depth / 2, z + depth / 2],
      };
    }),
    { x: [px - pw / 2, px + pw / 2], z: [pz - pd / 2, pz + pd / 2] },
    {
      x: [mascotSpot.x - mascotHalf, mascotSpot.x + mascotHalf],
      z: [mascotSpot.z - mascotHalf, mascotSpot.z + mascotHalf],
    },
  ];
  taken.set(key, found);
  return found;
}

/** How far apart things are kept, and from the desk's edges. */
const gap = 0.015;
const step = 0.02;

/**
 * The desk's items laid out in the order chosen: each at the first place
 * with room, looking along the back first and outwards from the middle,
 * turned a quarter if it fits only so. One with no room is left off.
 */
export function placeDeskItems(
  owner: DeskRole,
  items: readonly DeskItemKind[],
): DeskItemPlacement[] {
  const used: Rect[] = [...takenOn(owner)];
  const placed: DeskItemPlacement[] = [];
  const halfWidth = desk.width / 2 - gap;
  const halfDepth = desk.depth / 2 - gap;
  const xs: number[] = [];
  for (let x = 0; x <= halfWidth; x += step) {
    xs.push(x, -x);
  }
  for (const item of items) {
    const {
      size: [width, depth],
      centre: [cx, cz],
    } = deskItemFootprint(item);
    let found: DeskItemPlacement | undefined;
    for (const rotation of [0, Math.PI / 2]) {
      const [w, d] = rotation === 0 ? [width, depth] : [depth, width];
      for (
        let z = -halfDepth + d / 2;
        z <= halfDepth - d / 2 && found === undefined;
        z += step
      ) {
        for (const x of xs) {
          if (Math.abs(x) + w / 2 > halfWidth) {
            continue;
          }
          const rect: Rect = {
            x: [x - w / 2 - gap, x + w / 2 + gap],
            z: [z - d / 2 - gap, z + d / 2 + gap],
          };
          if (!used.some((other) => overlaps(rect, other))) {
            // Its origin, from where its footprint's centre goes: turned a
            // quarter, (cx, cz) becomes (cz, -cx).
            const [ox, oz] = rotation === 0 ? [cx, cz] : [cz, -cx];
            found = { item, x: x - ox, z: z - oz, rotation };
            used.push(rect);
            break;
          }
        }
      }
      if (found !== undefined) {
        break;
      }
    }
    if (found !== undefined) {
      placed.push(found);
    }
  }
  return placed;
}
