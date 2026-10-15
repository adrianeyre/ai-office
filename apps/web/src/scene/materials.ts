import { palette, type PaletteToken } from "@ai-office/shared/palette";
import { MeshStandardMaterial } from "three";

// The scene's materials (docs/reference/art-direction.md, Materials): one
// per token and surface, shared by name (`desk-top/wood`), so meshes batch.
// Each surface has the metalness and roughness of its row in the spec's
// table; `materials.test.ts` reads them against it.

export interface SurfaceFinish {
  readonly metalness: 0 | 1;
  readonly roughness: number;
}

/** The surfaces of the spec's table, with the finish each one gets. */
export const surfaces = {
  /** Paint, plaster and ceilings; paper is matte like them. */
  paint: { metalness: 0, roughness: 0.9 },
  wood: { metalness: 0, roughness: 0.7 },
  /** Fabric and carpet. */
  fabric: { metalness: 0, roughness: 0.95 },
  /** Plastic and ceramic; leaves get the same. */
  plastic: { metalness: 0, roughness: 0.5 },
  metal: { metalness: 1, roughness: 0.4 },
  /** A screen glows in its own token. */
  screen: { metalness: 0, roughness: 0.2 },
  /** A lamp's shade or panel: plastic that glows in its own token. */
  lamp: { metalness: 0, roughness: 0.5 },
  glass: { metalness: 0, roughness: 0.05 },
} as const satisfies Record<string, SurfaceFinish>;

export type Surface = keyof typeof surfaces;

/** How brightly screens and lamps glow (the spec allows 1.2 to 2.0). */
export const emissiveIntensity = { screen: 1.2, lamp: 1.6 } as const;

/** Glass is `glass` at 25% opacity, on Low and Medium. */
export const glassOpacity = 0.25;

const shared = new Map<string, MeshStandardMaterial>();

/** The shared material for a token on a surface, made once. */
export function material(
  token: PaletteToken,
  surface: Surface,
): MeshStandardMaterial {
  const name = `${token}/${surface}`;
  const existing = shared.get(name);
  if (existing !== undefined) {
    return existing;
  }
  const finish: SurfaceFinish = surfaces[surface];
  const made = new MeshStandardMaterial({
    name,
    color: palette[token],
    metalness: finish.metalness,
    roughness: finish.roughness,
  });
  if (surface === "screen" || surface === "lamp") {
    made.emissive.set(palette[token]);
    made.emissiveIntensity = emissiveIntensity[surface];
  }
  if (surface === "glass") {
    made.transparent = true;
    made.opacity = glassOpacity;
    made.depthWrite = false;
  }
  shared.set(name, made);
  return made;
}
