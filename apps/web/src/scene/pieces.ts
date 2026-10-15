import type { PaletteToken } from "@ai-office/shared/palette";

import type { Vec3 } from "./camera-rig.ts";
import type { Surface } from "./materials.ts";

// Rooms are built from pieces: simple shapes at real size in a palette
// token and a surface (docs/reference/art-direction.md). A room is data, so
// tests check it against the spec without WebGL; the scene merges the
// pieces that share a material into one mesh, one draw call each
// (piece-geometry.ts). This module is data only, without three.js, so the
// Office's HTML can use a room's layout without loading the scene.

export type PieceShape = "box" | "cylinder" | "sphere";

/**
 * Architecture (walls, floors, glass, door frames) casts no shadow;
 * furniture and props do. Walkways must stay clear of furniture and props.
 */
export type PieceRole = "architecture" | "furniture" | "prop";

export interface Piece {
  readonly name: string;
  readonly shape: PieceShape;
  readonly token: PaletteToken;
  readonly surface: Surface;
  readonly role: PieceRole;
  /** Its extent along x, y and z, in metres: a cylinder's or sphere's bounding box. */
  readonly size: Vec3;
  /** Its centre. */
  readonly position: Vec3;
  /**
   * The axis a cylinder lies along, for a roller, a wheel or a roll: x or
   * z. Without one it stands upright, along y.
   */
  readonly axis?: "x" | "z";
  /**
   * A slice of a cylinder, as a dartboard's segment: from `start` round
   * `length` radians about its axis. Without one it is whole.
   */
  readonly arc?: readonly [start: number, length: number];
  /** A cylinder open at both ends: a band, as a basketball hoop's rim. */
  readonly open?: boolean;
}

/** A rectangle of floor kept clear, from `min` to `max` on x and z. */
export interface Walkway {
  readonly name: string;
  readonly x: readonly [number, number];
  readonly z: readonly [number, number];
}

/** The chamfer on a box's edges (the spec's 1 to 2 cm). */
export const chamfer = 0.015;

/** A piece, from its parts in order. */
export function piece(
  name: string,
  shape: PieceShape,
  token: PaletteToken,
  surface: Surface,
  role: PieceRole,
  size: Vec3,
  position: Vec3,
): Piece {
  return { name, shape, token, surface, role, size, position };
}

/** A cylinder laid along `axis`: its length is its size along that axis. */
export const lying = (axis: "x" | "z", cylinder: Piece): Piece => ({
  ...cylinder,
  axis,
});

/** A piece standing on the floor, its footprint centred at `x`, `z`. */
export const standing = (
  name: string,
  token: PaletteToken,
  surface: Surface,
  role: PieceRole,
  size: Vec3,
  [x, z]: readonly [number, number],
  shape: PieceShape = "box",
) => piece(name, shape, token, surface, role, size, [x, size[1] / 2, z]);

/** Quarter turns about the vertical, anticlockwise seen from above: 2 is about-face. */
export type QuarterTurns = 0 | 1 | 2 | 3;

/** A point turned by quarter turns about the origin, then moved to `x`, `z`. */
export function turnPoint(
  [px, py, pz]: Vec3,
  turns: QuarterTurns,
  [x, z]: readonly [number, number],
): Vec3 {
  // three.js's rotation about +y: x' = x cos + z sin, z' = -x sin + z cos.
  const [cos, sin] = (
    [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ] as const
  )[turns];
  return [x + px * cos + pz * sin, py, z - px * sin + pz * cos];
}

/** A size turned by quarter turns: x and z swap on a quarter turn. */
export const turnSize = (
  [width, height, depth]: Vec3,
  turns: QuarterTurns,
): Vec3 => (turns % 2 === 0 ? [width, height, depth] : [depth, height, width]);

/** Pieces laid out about the origin, turned and moved to `x`, `z`. */
export const placePieces = (
  pieces: readonly Piece[],
  turns: QuarterTurns,
  at: readonly [number, number],
): Piece[] =>
  pieces.map((each) => ({
    ...each,
    size: turnSize(each.size, turns),
    position: turnPoint(each.position, turns, at),
    // A quarter turn lays an x-axis cylinder along z, and a z-axis one along x.
    ...(each.axis === undefined || turns % 2 === 0
      ? {}
      : { axis: each.axis === "x" ? ("z" as const) : ("x" as const) }),
  }));

/** Whether a piece casts a shadow: everything but architecture. */
export const castsShadow = (piece: Piece) => piece.role !== "architecture";

/** A piece's footprint on the floor, from `min` to `max` on x and z. */
export function footprint(piece: Piece): {
  x: [number, number];
  z: [number, number];
} {
  const [x, , z] = piece.position;
  const [width, , depth] = piece.size;
  return {
    x: [x - width / 2, x + width / 2],
    z: [z - depth / 2, z + depth / 2],
  };
}
