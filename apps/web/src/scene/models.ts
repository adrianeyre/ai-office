import { palette, type PaletteToken } from "@ai-office/shared/palette";
import { useEffect, useSyncExternalStore } from "react";
import {
  BufferGeometry,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  type BufferAttribute,
  type Material,
  type InterleavedBufferAttribute,
} from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { Vec3 } from "./camera-rig.ts";
import { surfaces, type Surface } from "./materials.ts";
import {
  modelCatalogue,
  modelNames,
  modelUrl,
  type ModelName,
} from "./model-catalogue.ts";
import type { MergedPieces } from "./piece-geometry.ts";
import type { PieceRole, QuarterTurns } from "./pieces.ts";

// The prepared models (model-catalogue.ts) in the scene. Each is loaded
// once, its materials read as the palette's `token/surface` names, and
// its meshes turned into plain geometry in model space. A room places
// models like pieces, and the scene merges them by shared material, so a
// model costs no draw calls of its own.

/** One material's share of a model: geometry in model space, in metres. */
export interface ModelPart {
  readonly token: PaletteToken;
  readonly surface: Surface;
  readonly geometry: BufferGeometry;
}

export type LoadedModels = Readonly<Record<ModelName, readonly ModelPart[]>>;

/** A model placed in a room. */
export interface ModelPlacement {
  readonly name: string;
  readonly model: ModelName;
  /** The centre of its footprint, on whatever it stands on. */
  readonly position: Vec3;
  readonly turns: QuarterTurns;
  readonly role: Exclude<PieceRole, "architecture">;
}

/** A placed model's size, turned as it stands. */
export function placedSize({ model, turns }: ModelPlacement): Vec3 {
  const [width, height, depth] = modelCatalogue[model].size;
  return turns % 2 === 0 ? [width, height, depth] : [depth, height, width];
}

const isToken = (token: string): token is PaletteToken => token in palette;
const isSurface = (surface: string): surface is Surface => surface in surfaces;

/** A material's `token/surface` name, read; anything else is refused. */
export function materialName(name: string): [PaletteToken, Surface] {
  const [token = "", surface = "", ...rest] = name.split("/");
  if (!isToken(token) || !isSurface(surface) || rest.length > 0) {
    throw new Error(`"${name}" is not a palette material (token/surface).`);
  }
  return [token, surface];
}

/** An attribute as plain floats, quantization and interleaving undone. */
function floats(
  attribute: BufferAttribute | InterleavedBufferAttribute,
): Float32BufferAttribute {
  const array = new Float32Array(attribute.count * 3);
  for (let index = 0; index < attribute.count; index += 1) {
    array[index * 3] = attribute.getX(index);
    array[index * 3 + 1] = attribute.getY(index);
    array[index * 3 + 2] = attribute.getZ(index);
  }
  return new Float32BufferAttribute(array, 3);
}

/** A prepared model's parts, one per material, from its GLB. */
export async function parseModel(data: ArrayBuffer): Promise<ModelPart[]> {
  await MeshoptDecoder.ready;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(data, "");
  gltf.scene.updateMatrixWorld(true);
  const byMaterial = new Map<string, BufferGeometry[]>();
  gltf.scene.traverse((object) => {
    if (!(object instanceof Mesh)) {
      return;
    }
    const mesh = object as Mesh<BufferGeometry, Material>;
    const loaded = mesh.geometry.index
      ? mesh.geometry.toNonIndexed()
      : mesh.geometry;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", floats(loaded.getAttribute("position")));
    geometry.setAttribute("normal", floats(loaded.getAttribute("normal")));
    geometry.applyMatrix4(mesh.matrixWorld);
    const name = mesh.material.name;
    byMaterial.set(name, [...(byMaterial.get(name) ?? []), geometry]);
  });
  return [...byMaterial].map(([name, geometries]) => {
    const [token, surface] = materialName(name);
    return { token, surface, geometry: mergeGeometries(geometries) };
  });
}

/** Every model in the catalogue, each file read by `read`. */
export async function loadModels(
  read: (url: URL) => Promise<ArrayBuffer>,
): Promise<LoadedModels> {
  const entries = await Promise.all(
    modelNames.map(
      async (name) =>
        [name, await parseModel(await read(modelUrl(name)))] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<ModelName, ModelPart[]>;
}

/** The placement's transform: turned about its origin, then moved into place. */
function placementMatrix({ position, turns }: ModelPlacement): Matrix4 {
  return new Matrix4()
    .makeTranslation(...position)
    .multiply(new Matrix4().makeRotationY((turns * Math.PI) / 2));
}

/**
 * The placed models merged into one geometry per material, as pieces are
 * (`mergePieces`). Every placed model casts a shadow: models are furniture
 * and props.
 */
export function mergeModels(
  placements: readonly ModelPlacement[],
  models: LoadedModels,
): MergedPieces[] {
  const groups = new Map<
    string,
    { token: PaletteToken; surface: Surface; parts: BufferGeometry[] }
  >();
  for (const placement of placements) {
    const matrix = placementMatrix(placement);
    for (const { token, surface, geometry } of models[placement.model]) {
      const key = `${token}/${surface}`;
      const group = groups.get(key) ?? { token, surface, parts: [] };
      group.parts.push(geometry.clone().applyMatrix4(matrix));
      groups.set(key, group);
    }
  }
  return [...groups.values()].map(({ token, surface, parts }) => {
    const geometry = mergeGeometries(parts);
    for (const part of parts) {
      part.dispose();
    }
    return { token, surface, castShadow: true, geometry };
  });
}

// The loaded models, shared by every Floor: loaded once, on first use.
let loaded: LoadedModels | undefined;
let failed: Error | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

function settle(models: LoadedModels | undefined, error?: Error) {
  loaded = models;
  failed = error;
  for (const listener of listeners) {
    listener();
  }
}

/** Use these models from now on: tests load them from disk. */
export function provideModels(models: LoadedModels | undefined): void {
  loading = undefined;
  settle(models);
}

async function fetchModel(url: URL): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `${url.pathname} could not be loaded (${String(response.status)}).`,
    );
  }
  return response.arrayBuffer();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * The models, once loaded; undefined until then, so a room draws its
 * pieces at once and its models when they arrive. A failure is thrown, for
 * the scene's error boundary to show.
 */
export function useModels(): LoadedModels | undefined {
  const models = useSyncExternalStore(subscribe, () => loaded);
  const error = useSyncExternalStore(subscribe, () => failed);
  useEffect(() => {
    if (loaded === undefined && loading === undefined) {
      loading = loadModels(fetchModel).then(
        (models) => {
          settle(models);
        },
        (reason: unknown) => {
          settle(
            undefined,
            reason instanceof Error ? reason : new Error(String(reason)),
          );
        },
      );
    }
  }, []);
  if (error !== undefined) {
    throw error;
  }
  return models;
}
