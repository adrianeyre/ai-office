import type { PaletteToken } from "@ai-office/shared/palette";

import type { Vec3 } from "./camera-rig.ts";
import type { Surface } from "./materials.ts";

// The 3D models the Floors use from an asset pack, rather than building
// them from pieces: shapes too fiddly for boxes and cylinders. Each comes
// from Kenney's Furniture Kit (CC0-1.0, an approved source in
// docs/reference/art-direction.md) and is prepared by
// `scripts/prepare-models.ts`, which follows the spec's checklist:
//
// - scaled to `size`, in metres, its origin the centre of its footprint on
//   the floor, facing +z (as the kit's models already face);
// - recoloured to the palette: each of the kit's materials becomes the
//   shared material `token/surface` named in `recolour`;
// - only positions and normals kept (there are no textures), then
//   compressed with Meshopt.
//
// The licence of every file in `models/` is recorded in
// THIRD-PARTY-NOTICES.md.

/** The pack the models come from. */
export const furnitureKit = {
  name: "Furniture Kit",
  version: "2.0",
  author: "Kenney",
  url: "https://kenney.nl/assets/furniture-kit",
  licence: "CC0-1.0",
  /** Where its glTF models are, inside the pack's zip. */
  directory: "Models/GLTF format",
} as const;

export interface ModelSpec {
  /** Its file in the pack's `directory`. */
  readonly source: string;
  /** What it is, for THIRD-PARTY-NOTICES.md and the scene's names. */
  readonly description: string;
  /** Its size once prepared: x, y and z, in metres. */
  readonly size: Vec3;
  /** Each of the pack's material names, as a palette token on a surface. */
  readonly recolour: Readonly<Record<string, readonly [PaletteToken, Surface]>>;
  /** The heights of its shelves above its base, in metres, where it has any. */
  readonly shelves?: readonly number[];
}

export const modelCatalogue = {
  "coffee-machine": {
    source: "kitchenCoffeeMachine.glb",
    description: "The canteen's coffee machine, with its mug",
    size: [0.32, 0.42, 0.4],
    recolour: {
      metalMedium: ["metal-dark", "metal"],
      metal: ["metal-light", "metal"],
      carpetWhite: ["ceramic", "plastic"],
    },
  },
  fridge: {
    source: "kitchenFridge.glb",
    description: "The canteen's fridge",
    size: [0.7, 1.8, 0.7],
    // An enamelled body: brushed steel reads almost black in the
    // Office's dim environment light.
    recolour: {
      metalLight: ["ceramic", "plastic"],
      metalDark: ["metal-dark", "metal"],
      metal: ["metal-light", "metal"],
      glass: ["metal-dark", "metal"],
    },
  },
  bookcase: {
    source: "bookcaseOpen.glb",
    description: "The bookshelf for memory",
    size: [0.9, 1.9, 0.35],
    recolour: { wood: ["desk-top", "wood"] },
    // The kit's shelves are at 0.13, 0.37 and 0.61 of 0.88, its top at
    // 0.88; `model-catalogue.test.ts` reads them from the prepared file.
    shelves: [0.281, 0.799, 1.317, 1.9],
  },
  books: {
    source: "books.glb",
    description: "Books, on the bookshelf and a docs Agent's desk",
    size: [0.3, 0.21, 0.19],
    recolour: {
      carpetDarker: ["sofa", "fabric"],
      carpetWhite: ["paper", "paint"],
      plant: ["chair", "fabric"],
      metal: ["wall-feature", "paint"],
    },
  },
  laptop: {
    source: "laptop.glb",
    description: "A QA Agent's test laptop",
    size: [0.34, 0.21, 0.31],
    recolour: {
      metalDark: ["metal-dark", "metal"],
      metal: ["metal-light", "metal"],
      metalMedium: ["screen-off", "screen"],
    },
  },
  "potted-plant": {
    source: "pottedPlant.glb",
    description: "Potted plants",
    size: [0.55, 1.2, 0.55],
    recolour: {
      wood: ["ceramic", "plastic"],
      woodDark: ["floor-wood", "wood"],
      plant: ["plant", "plastic"],
    },
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelName = keyof typeof modelCatalogue;

export const modelNames = Object.keys(modelCatalogue) as ModelName[];

/** A prepared model's file, beside this module. */
export const modelUrl = (name: ModelName): URL =>
  new URL(`./models/${name}.glb`, import.meta.url);
