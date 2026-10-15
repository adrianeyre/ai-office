// Prepares the Floors' 3D models from Kenney's Furniture Kit, as
// src/scene/model-catalogue.ts lists them, following the asset checklist
// of docs/reference/art-direction.md: real size, origin on the floor at
// the centre of the footprint, facing +z, recoloured to the palette with
// shared material names, and Meshopt-compressed.
//
//   node apps/web/scripts/prepare-models.ts <the unzipped Furniture Kit>
//
// It writes src/scene/models/<name>.glb. The kit is not kept in the
// repository: download it from the page in `furnitureKit.url`.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { palette } from "@ai-office/shared/palette";
import { getBounds, NodeIO, type mat4 } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  clearNodeTransform,
  dedup,
  flatten,
  join as joinPrimitives,
  meshopt,
  prune,
  transformMesh,
} from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { Color } from "three";

import { surfaces } from "../src/scene/materials.ts";
import {
  furnitureKit,
  modelCatalogue,
  modelNames,
  modelUrl,
  type ModelSpec,
} from "../src/scene/model-catalogue.ts";

const [kitArgument] = process.argv.slice(2);
if (kitArgument === undefined) {
  console.error(
    `Usage: node apps/web/scripts/prepare-models.ts <the unzipped ${furnitureKit.name}>`,
  );
  process.exit(1);
}
const kit = kitArgument;

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    "meshopt.encoder": MeshoptEncoder,
    "meshopt.decoder": MeshoptDecoder,
  });

async function prepare(name: string, spec: ModelSpec, output: URL) {
  const source = join(kit, furnitureKit.directory, spec.source);
  const document = await io.readBinary(new Uint8Array(await readFile(source)));
  const root = document.getRoot();

  // Every mesh into the scene's root, its node's transform baked into it.
  await document.transform(flatten());
  for (const node of root.listNodes()) {
    clearNodeTransform(node);
  }

  // To its real size, its footprint centred on the origin, on the floor.
  const scene = root.listScenes()[0];
  if (scene === undefined) {
    throw new Error(`${spec.source} has no scene.`);
  }
  const {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  } = getBounds(scene);
  const [width, height, depth] = spec.size;
  const [sx, sy, sz] = [
    width / (maxX - minX),
    height / (maxY - minY),
    depth / (maxZ - minZ),
  ];
  // Column-major: scale, then move the footprint's centre to the origin
  // and the bottom to the floor.
  // prettier-ignore
  const fit: mat4 = [
    sx, 0, 0, 0,
    0, sy, 0, 0,
    0, 0, sz, 0,
    (-(minX + maxX) / 2) * sx, -minY * sy, (-(minZ + maxZ) / 2) * sz, 1,
  ];
  for (const mesh of root.listMeshes()) {
    transformMesh(mesh, fit);
  }

  // Recoloured to the palette, each material named `token/surface`.
  for (const material of root.listMaterials()) {
    const recolour = spec.recolour[material.getName()];
    if (recolour === undefined) {
      throw new Error(
        `${spec.source}: material "${material.getName()}" has no palette token.`,
      );
    }
    const [token, surface] = recolour;
    const colour = new Color(palette[token]);
    const finish = surfaces[surface];
    material
      .setName(`${token}/${surface}`)
      .setBaseColorFactor([colour.r, colour.g, colour.b, 1])
      .setMetallicFactor(finish.metalness)
      .setRoughnessFactor(finish.roughness)
      .setAlphaMode("OPAQUE");
    for (const extension of material.listExtensions()) {
      material.setExtension(extension.extensionName, null);
    }
  }
  for (const extension of root.listExtensionsUsed()) {
    if (extension.extensionName === "KHR_materials_unlit") {
      extension.dispose();
    }
  }

  // No textures, so no texture coordinates.
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitive.setAttribute("TEXCOORD_0", null);
    }
  }
  for (const node of root.listNodes()) {
    node.setName(name);
  }

  await document.transform(
    dedup(),
    joinPrimitives({ keepNamed: false }),
    prune(),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
  );
  await writeFile(output, await io.writeBinary(document));
}

for (const name of modelNames) {
  const output = modelUrl(name);
  await prepare(name, modelCatalogue[name], output);
  console.log(`Wrote ${fileURLToPath(output)}`);
}
