import type { PaletteToken } from "@ai-office/shared/palette";
import {
  BoxGeometry,
  CylinderGeometry,
  Matrix4,
  SphereGeometry,
  type BufferGeometry,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { Surface } from "./materials.ts";
import { castsShadow, chamfer, type Piece } from "./pieces.ts";

// Pieces (pieces.ts) as three.js geometry: each one's shape in place, and
// the pieces that share a material merged into one geometry, which the
// scene draws as one mesh.

/**
 * One flat bevel per edge: the spec's chamfer, at 108 triangles a box
 * rather than the 300 of a two-step round, so a desk set fits its budget.
 */
const chamferSegments = 1;

const roundSegments = 12;

/** A piece's geometry, in place. */
export function pieceGeometry(piece: Piece): BufferGeometry {
  const [width, height, depth] = piece.size;
  let geometry: BufferGeometry;
  if (piece.shape === "box") {
    // A thin box (a mat, a sheet) gets as much chamfer as it has room for.
    const radius = Math.min(chamfer, Math.min(...piece.size) / 2 - 0.0005);
    geometry =
      radius > 0
        ? new RoundedBoxGeometry(width, height, depth, chamferSegments, radius)
        : new BoxGeometry(width, height, depth);
  } else if (piece.shape === "cylinder") {
    // A slice takes its share of the sides, at least one.
    const [start, length] = piece.arc ?? [0, 2 * Math.PI];
    geometry = new CylinderGeometry(
      0.5,
      0.5,
      1,
      Math.max(1, Math.round((roundSegments * length) / (2 * Math.PI))),
      1,
      piece.open === true,
      start,
      length,
    );
    // Laid along x or z, then sized: its size is still its bounding box.
    if (piece.axis === "x") {
      geometry.rotateZ(Math.PI / 2);
    } else if (piece.axis === "z") {
      geometry.rotateX(Math.PI / 2);
    }
    geometry.scale(width, height, depth);
  } else {
    geometry = new SphereGeometry(0.5, roundSegments, 8);
    geometry.scale(width, height, depth);
  }
  geometry.applyMatrix4(new Matrix4().makeTranslation(...piece.position));
  // A rounded box has no index and the others do; merging needs them alike.
  if (geometry.index === null) {
    return geometry;
  }
  const unindexed = geometry.toNonIndexed();
  geometry.dispose();
  return unindexed;
}

export interface MergedPieces {
  /** `token/surface`: the shared material's name. */
  readonly token: PaletteToken;
  readonly surface: Surface;
  readonly castShadow: boolean;
  readonly geometry: BufferGeometry;
}

/**
 * The pieces merged into one geometry per material and shadow: what the
 * scene draws, one mesh each.
 */
export function mergePieces(pieces: readonly Piece[]): MergedPieces[] {
  const groups = new Map<string, Piece[]>();
  for (const piece of pieces) {
    const key = `${piece.token}/${piece.surface}/${String(castsShadow(piece))}`;
    groups.set(key, [...(groups.get(key) ?? []), piece]);
  }
  return [...groups.values()].map((group) => {
    const [first] = group as [Piece, ...Piece[]];
    const parts = group.map(pieceGeometry);
    const geometry = mergeGeometries(parts);
    for (const part of parts) {
      part.dispose();
    }
    return {
      token: first.token,
      surface: first.surface,
      castShadow: castsShadow(first),
      geometry,
    };
  });
}

/** The triangles a geometry draws. */
export function triangles(geometry: BufferGeometry): number {
  return (geometry.index?.count ?? geometry.getAttribute("position").count) / 3;
}
