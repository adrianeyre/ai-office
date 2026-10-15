import { useEffect, useMemo } from "react";
import {
  CanvasTexture,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  type BufferGeometry,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { posterSize, type WallPoster } from "./floor-layout.ts";
import { surfaces } from "./materials.ts";
import { drawPoster, posterUnits } from "./posters.ts";
import { qualityPresets, type QualityLevel } from "./quality.ts";
import { useSceneSettings } from "./scene-settings.ts";

// A Floor's adventure and arcade game posters in the scene (FR-61): every poster's
// art drawn once into one texture, a grid of them, and their faces merged
// into one mesh over their frames (floor-layout.ts), one draw call for
// them all. The texture is as large as the quality setting's largest
// texture allows (docs/reference/art-direction.md), so Low draws them
// coarser and High sharper. The art is paper on the wall: matte, and lit
// as the room is. Where there is no canvas to draw on (jsdom), the faces
// are not shown, and the frames hang empty.

/**
 * The posters' grid in the texture: as many across as gives each poster
 * the largest cell in a square texture, the fewest across of those.
 */
export function posterGrid(count: number): { columns: number; rows: number } {
  const [unitsWide, unitsHigh] = posterUnits;
  let best = { columns: 1, rows: Math.max(count, 1), side: 0 };
  for (let columns = 1; columns <= Math.max(count, 1); columns += 1) {
    const rows = Math.ceil(Math.max(count, 1) / columns);
    // A cell's height, as a share of the texture's side, as the rows and
    // the columns each allow.
    const side = Math.min(1 / rows, unitsHigh / unitsWide / columns);
    if (side > best.side + 1e-9) {
      best = { columns, rows, side };
    }
  }
  return { columns: best.columns, rows: best.rows };
}

/** Each poster's cell in the texture, in pixels: the poster, and a gutter round it. */
export function posterCell(
  quality: QualityLevel,
  count: number,
): { width: number; height: number; gutter: number } {
  const { columns, rows } = posterGrid(count);
  const [unitsWide, unitsHigh] = posterUnits;
  const side = qualityPresets[quality].largestTexture;
  // The texture's longer side fits the largest texture.
  const cellHeight = Math.floor(
    Math.min(side / rows, (side / columns) * (unitsHigh / unitsWide)),
  );
  const gutter = Math.ceil(cellHeight / 64);
  const height = cellHeight - 2 * gutter;
  const width = Math.floor((height * unitsWide) / unitsHigh);
  return { width, height, gutter };
}

/** The posters' art drawn into one texture, or none without a canvas. */
function postersTexture(
  posters: readonly WallPoster[],
  quality: QualityLevel,
): CanvasTexture<OffscreenCanvas> | undefined {
  if (typeof OffscreenCanvas === "undefined" || posters.length === 0) {
    return undefined;
  }
  const { width, height, gutter } = posterCell(quality, posters.length);
  const { columns, rows } = posterGrid(posters.length);
  const canvas = new OffscreenCanvas(
    columns * (width + 2 * gutter),
    rows * (height + 2 * gutter),
  );
  const context = canvas.getContext("2d");
  if (context === null) {
    return undefined;
  }
  posters.forEach(({ art }, index) => {
    const left = (index % columns) * (width + 2 * gutter);
    const top = Math.floor(index / columns) * (height + 2 * gutter);
    context.save();
    context.translate(left + gutter, top + gutter);
    context.scale(width / posterUnits[0], height / posterUnits[1]);
    drawPoster(context, art);
    context.restore();
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = quality === "low" ? 1 : 8;
  return texture;
}

/** The posters' faces, each its cell of the texture, merged into one geometry. */
export function postersGeometry(
  posters: readonly WallPoster[],
  quality: QualityLevel,
): BufferGeometry {
  const { width, height, gutter } = posterCell(quality, posters.length);
  const { columns, rows } = posterGrid(posters.length);
  const atlasWidth = columns * (width + 2 * gutter);
  const atlasHeight = rows * (height + 2 * gutter);
  const faces = posters.map(({ centre: [x, y, z], rotationY }, index) => {
    const face = new PlaneGeometry(...posterSize.art);
    const left =
      ((index % columns) * (width + 2 * gutter) + gutter) / atlasWidth;
    const top =
      (Math.floor(index / columns) * (height + 2 * gutter) + gutter) /
      atlasHeight;
    // The canvas's rows run down; the texture's v runs up.
    const uv = face.getAttribute("uv");
    for (let vertex = 0; vertex < uv.count; vertex += 1) {
      uv.setXY(
        vertex,
        left + uv.getX(vertex) * (width / atlasWidth),
        1 - top - (1 - uv.getY(vertex)) * (height / atlasHeight),
      );
    }
    face.rotateY(rotationY);
    face.translate(x, y, z);
    return face;
  });
  const merged = mergeGeometries(faces);
  for (const face of faces) {
    face.dispose();
  }
  return merged;
}

/** A Floor's posters' faces, over their frames. */
export function WallPosters({ posters }: { posters: readonly WallPoster[] }) {
  const quality = useSceneSettings((settings) => settings.quality);
  const texture = useMemo(
    () => postersTexture(posters, quality),
    [posters, quality],
  );
  const geometry = useMemo(
    () => postersGeometry(posters, quality),
    [posters, quality],
  );
  const posterMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        name: "wall-posters/paint",
        map: texture ?? null,
        ...surfaces.paint,
      }),
    [texture],
  );
  useEffect(
    () => () => {
      texture?.dispose();
    },
    [texture],
  );
  useEffect(
    () => () => {
      geometry.dispose();
    },
    [geometry],
  );
  useEffect(
    () => () => {
      posterMaterial.dispose();
    },
    [posterMaterial],
  );
  return (
    <mesh
      name="wall-posters"
      geometry={geometry}
      material={posterMaterial}
      visible={texture !== undefined}
      receiveShadow
    />
  );
}
