import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Box3, Vector3 } from "three";
import { beforeAll, describe, expect, it } from "vitest";

import {
  furnitureKit,
  modelCatalogue,
  modelNames,
  modelUrl,
} from "./model-catalogue.ts";
import { materialName, type LoadedModels } from "./models.ts";
import { triangles } from "./piece-geometry.ts";
import { loadModelsFromDisk, readModelFile } from "./test-models.ts";

// The prepared models against the art direction's checklist
// (docs/reference/art-direction.md, "Adding an asset"): real size, origin
// on the floor at the centre of the footprint, palette materials, within
// their limits, compressed, and with their licence recorded.

const repository = join(import.meta.dirname, "../../../..");

/** A GLB's JSON chunk. */
async function gltfJson(url: URL): Promise<{
  extensionsRequired?: string[];
  materials?: { name: string }[];
}> {
  const file = Buffer.from(await readModelFile(url));
  const length = file.readUInt32LE(12);
  return JSON.parse(file.subarray(20, 20 + length).toString("utf8")) as {
    extensionsRequired?: string[];
  };
}

/** The spec's per-asset triangle limits on Low, the tightest setting. */
const lowLimit = { small: 300, large: 2000 } as const;
const largeProps = new Set(["coffee-machine", "fridge", "bookcase"]);

let models: LoadedModels;

beforeAll(async () => {
  models = await loadModelsFromDisk();
});

describe("the prepared models", () => {
  it("are every file in models/, and nothing else is", async () => {
    const files = await readdir(join(import.meta.dirname, "models"));
    expect(files.sort()).toEqual(
      modelNames.map((name) => `${name}.glb`).sort(),
    );
  });

  it.each(modelNames)(
    "has %s at its size, on the floor, its footprint centred",
    (name) => {
      const box = new Box3();
      for (const { geometry } of models[name]) {
        geometry.computeBoundingBox();
        if (geometry.boundingBox !== null) {
          box.union(geometry.boundingBox);
        }
      }
      const size = box.getSize(new Vector3());
      const [width, height, depth] = modelCatalogue[name].size;
      expect(size.x).toBeCloseTo(width, 2);
      expect(size.y).toBeCloseTo(height, 2);
      expect(size.z).toBeCloseTo(depth, 2);
      expect(box.min.y).toBeCloseTo(0, 2);
      expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 2);
      expect((box.min.z + box.max.z) / 2).toBeCloseTo(0, 2);
    },
  );

  it.each(modelNames)(
    "recolours %s to the palette, with shared material names",
    async (name) => {
      const { materials = [] } = await gltfJson(modelUrl(name));
      const expected = new Set(
        Object.values<readonly [string, string]>(
          modelCatalogue[name].recolour,
        ).map(([token, surface]) => `${token}/${surface}`),
      );
      expect(materials.length).toBeGreaterThan(0);
      for (const { name: material } of materials) {
        expect(() => materialName(material)).not.toThrow();
        expect(expected.has(material), material).toBe(true);
      }
      expect(
        models[name].map(({ token, surface }) => `${token}/${surface}`),
      ).toEqual([
        ...new Set(
          models[name].map(({ token, surface }) => `${token}/${surface}`),
        ),
      ]);
    },
  );

  it.each(modelNames)(
    "keeps %s within its triangle limit on Low, Meshopt-compressed and under 1 MB",
    async (name) => {
      const count = models[name].reduce(
        (sum, { geometry }) => sum + triangles(geometry),
        0,
      );
      expect(count).toBeLessThanOrEqual(
        largeProps.has(name) ? lowLimit.large : lowLimit.small,
      );
      const { extensionsRequired = [] } = await gltfJson(modelUrl(name));
      expect(extensionsRequired).toContain("EXT_meshopt_compression");
      const file = await readModelFile(modelUrl(name));
      expect(file.byteLength).toBeLessThan(1024 * 1024);
    },
  );

  it("puts the bookshelf's shelves where the catalogue says", () => {
    const up = new Set<string>();
    for (const { geometry } of models.bookcase) {
      const position = geometry.getAttribute("position");
      const normal = geometry.getAttribute("normal");
      for (let index = 0; index < position.count; index += 1) {
        if (normal.getY(index) > 0.9) {
          up.add(position.getY(index).toFixed(2));
        }
      }
    }
    for (const shelf of modelCatalogue.bookcase.shelves) {
      expect(up.has(shelf.toFixed(2)), `a shelf at ${String(shelf)} m`).toBe(
        true,
      );
    }
  });

  it("are listed in THIRD-PARTY-NOTICES.md with their source and licence", async () => {
    const notices = await readFile(
      join(repository, "THIRD-PARTY-NOTICES.md"),
      "utf8",
    );
    const row = notices
      .split("\n")
      .find((line) => line.includes("apps/web/src/scene/models/"));
    expect(row).toBeDefined();
    const cells = (row ?? "").split("|").map((cell) => cell.trim());
    // | Asset | Used for | Source | Author | Licence |
    expect(cells[2]).toContain("modified");
    expect(cells[3]).toContain(furnitureKit.url);
    expect(cells[3]).toContain(furnitureKit.version);
    expect(cells[4]).toBe(furnitureKit.author);
    expect(cells[5]).toBe(furnitureKit.licence);
    for (const name of modelNames) {
      expect(cells[1]).toContain(`${name}.glb`);
    }
  });
});
