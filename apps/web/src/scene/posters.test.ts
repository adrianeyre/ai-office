import { floorThemes, type Role } from "@ai-office/shared";
import { palette } from "@ai-office/shared/palette";
import { describe, expect, it } from "vitest";

import { arcadeInks, arcadePosterArt } from "./arcade-posters.ts";
import {
  arcadePosterPlaces,
  floorLayout,
  gamesHall,
  lounge,
  posterSize,
  wallPosters,
  type FloorAgent,
} from "./floor-layout.ts";
import { themeZone } from "./floor-themes.ts";
import { placedSize } from "./models.ts";
import {
  drawPoster,
  posterArt,
  posterInks,
  posterTitleLines,
  posterUnits,
  type PosterContext,
} from "./posters.ts";
import { qualityLevels, qualityPresets } from "./quality.ts";
import { posterCell, posterGrid, postersGeometry } from "./wall-posters.tsx";

// The adventure and arcade game posters (FR-61), affectionate parodies,
// drawn without a canvas: a context that records what is drawn on it, so each
// poster's title and colours can be read back.

interface Drawn {
  readonly texts: { text: string; x: number; font: string }[];
  readonly colours: Set<string>;
  readonly shapes: number;
}

/**
 * A 2D context that records its text, its colours and how many shapes it
 * fills, and measures text as about 0.6 of its size a character.
 */
function recorder(): { context: PosterContext; drawn: Drawn } {
  const drawn = { texts: [], colours: new Set<string>(), shapes: 0 } as {
    texts: Drawn["texts"];
    colours: Set<string>;
    shapes: number;
  };
  const state = { font: "", fillStyle: "", strokeStyle: "" };
  const size = () => Number(/(\d+(?:\.\d+)?)px/.exec(state.font)?.[1] ?? 0);
  const gradient = () => ({
    addColorStop: (_offset: number, colour: string) => {
      drawn.colours.add(colour);
    },
  });
  const target: Record<string, unknown> = {
    measureText: (text: string) => ({ width: text.length * size() * 0.6 }),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    fillText: (text: string, x: number) => {
      drawn.texts.push({ text, x, font: state.font });
    },
    fill: () => {
      drawn.shapes += 1;
    },
    fillRect: () => {
      drawn.shapes += 1;
    },
  };
  const context = new Proxy(target, {
    get: (object, key: string) =>
      key in object
        ? object[key]
        : key in state
          ? state[key as keyof typeof state]
          : () => undefined,
    set: (_object, key: string, value: unknown) => {
      if (key in state) {
        state[key as keyof typeof state] = String(value);
        if (key !== "font" && typeof value === "string") {
          drawn.colours.add(value);
        }
      }
      return true;
    },
  });
  return { context: context as unknown as PosterContext, drawn };
}

describe("the adventure game posters", () => {
  it("are parodies of nine classic adventures, each its own picture", () => {
    expect(posterArt.map(({ title, parodies }) => [parodies, title])).toEqual([
      ["Day of the Tentacle", "Night of the Tentacle"],
      ["Sam & Max Hit the Road", "Sam & Bob Hit the Road"],
      [
        "Indiana Jones and the Fate of Atlantis",
        "Montana Jones and the Fate of Atlantis",
      ],
      ["Space Quest III", "Space Quack III"],
      ["Simon the Sorcerer", "Simone the Sorcerer"],
      ["Beneath a Steel Sky", "Beneath a Tin Sky"],
      [
        "King's Quest VII: The Princeless Bride",
        "Queen's Quest VII: The Princeless Groom",
      ],
      ["The Secret of Monkey Island", "The Secret of Donkey Island"],
      [
        "Monkey Island 2: LeChuck's Revenge",
        "Donkey Island 2: LeDuck's Revenge",
      ],
    ]);
    // Never the game's own title, and each a picture of its own.
    for (const { title, parodies } of posterArt) {
      expect(title).not.toBe(parodies);
    }
    expect(new Set(posterArt.map(({ motif }) => motif)).size).toBe(9);
  });

  it("have inks of their own that never shadow a palette token", () => {
    for (const ink of Object.keys(posterInks)) {
      expect(ink in palette, ink).toBe(false);
    }
  });

  it.each(posterArt.map((art) => [art.title, art] as const))(
    "%s: shows its title, whole, across the top, within the poster",
    (_title, art) => {
      const { context, drawn } = recorder();
      drawPoster(context, art);
      expect(drawn.texts.map(({ text }) => text).join(" ")).toBe(art.title);
      const { size, lines } = posterTitleLines(recorder().context, art);
      expect(lines.length).toBeLessThanOrEqual(3);
      expect(size).toBeGreaterThanOrEqual(8);
      for (const line of lines) {
        // Centred, and no wider than the poster less its border, however
        // its letters are stretched.
        expect(
          line.length * size * 0.6 * (art.lettering.stretch ?? 1),
        ).toBeLessThanOrEqual(posterUnits[0] - 10);
      }
      for (const { x, font } of drawn.texts) {
        expect(x).toBe(posterUnits[0] / 2);
        expect(font).toMatch(/^bold /);
      }
    },
  );

  it.each(posterArt.map((art) => [art.title, art] as const))(
    "%s: is drawn in the palette's colours and the posters' inks, with a picture of its own",
    (_title, art) => {
      const { context, drawn } = recorder();
      drawPoster(context, art);
      const colours = new Set<string>([
        ...Object.values(palette),
        ...Object.values(posterInks),
      ]);
      for (const colour of drawn.colours) {
        // A colour may be faded, an alpha after its hex.
        expect(colours.has(colour.slice(0, 7)), colour).toBe(true);
        expect(colour).toMatch(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/);
      }
      // Its sky, and a picture of many shapes over it.
      expect(drawn.shapes).toBeGreaterThan(20);
    },
  );
});

describe("the arcade game posters", () => {
  it("are parodies of eight coin-op classics, each its own picture under a lit marquee", () => {
    expect(
      arcadePosterArt.map(({ title, parodies }) => [parodies, title]),
    ).toEqual([
      ["Space Invaders", "Space Intruders"],
      ["Pac-Man", "Pac-Mum"],
      ["Donkey Kong", "Donkey Kongo"],
      ["Galaxian", "Galaxia"],
      ["Asteroids", "Asteroidz"],
      ["Frogger", "Frogga"],
      ["Centipede", "Centipeed"],
      ["Tetris", "Tetrus"],
    ]);
    for (const { title, parodies, lettering } of arcadePosterArt) {
      // Never the game's own title, nor a word of it whole.
      expect(title).not.toBe(parodies);
      expect(title.split(" ").at(-1)).not.toBe(parodies.split(" ").at(-1));
      expect(lettering.marquee, title).toBeDefined();
      expect(lettering.typeface).toBe("sans");
    }
    const motifs = new Set(arcadePosterArt.map(({ motif }) => motif));
    expect(motifs.size).toBe(8);
    for (const { motif } of posterArt) {
      expect(motifs.has(motif as never)).toBe(false);
    }
  });

  it("have inks of their own, among the posters' inks, that never shadow a palette token", () => {
    for (const [ink, hex] of Object.entries(arcadeInks)) {
      expect(ink in palette, ink).toBe(false);
      expect(posterInks[ink as keyof typeof posterInks]).toBe(hex);
    }
  });

  it.each(arcadePosterArt.map((art) => [art.title, art] as const))(
    "%s: shows its title, whole, across its marquee, within the poster",
    (_title, art) => {
      const { context, drawn } = recorder();
      drawPoster(context, art);
      expect(drawn.texts.map(({ text }) => text).join(" ")).toBe(art.title);
      const { size, lines } = posterTitleLines(recorder().context, art);
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(size).toBeGreaterThanOrEqual(10);
      for (const line of lines) {
        expect(
          line.length * size * 0.6 * (art.lettering.stretch ?? 1),
        ).toBeLessThanOrEqual(posterUnits[0] - 10);
      }
    },
  );

  it.each(arcadePosterArt.map((art) => [art.title, art] as const))(
    "%s: is drawn in the palette's colours and the posters' inks, in many blocks",
    (_title, art) => {
      const { context, drawn } = recorder();
      drawPoster(context, art);
      const colours = new Set<string>([
        ...Object.values(palette),
        ...Object.values(posterInks),
      ]);
      for (const colour of drawn.colours) {
        expect(colours.has(colour.slice(0, 7)), colour).toBe(true);
        expect(colour).toMatch(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/);
      }
      // A screen of many blocks (a vector screen's are mostly strokes).
      expect(drawn.shapes).toBeGreaterThan(60);
    },
  );
});

const workRoles: Role[] = ["coder", "reviewer", "qa", "docs", "designer"];
const team = (size: number): FloorAgent[] =>
  Array.from({ length: size }, (_, index) => ({
    id: `agent-${String(index + 1)}`,
    role:
      index === 0
        ? "manager"
        : (workRoles[(index - 1) % workRoles.length] ?? "coder"),
  }));

describe("where the arcade game posters hang", () => {
  const arcade = wallPosters.filter(({ art }) => arcadePosterArt.includes(art));
  const [width, height] = posterSize.art;
  const half = {
    across: width / 2 + posterSize.frame,
    up: height / 2 + posterSize.frame,
  };

  it("in two rows of four on the left wall, facing into the room, none overlapping", () => {
    expect(arcade).toHaveLength(8);
    expect(arcadePosterPlaces).toHaveLength(8);
    for (const { centre, rotationY } of arcade) {
      expect(rotationY).toBeCloseTo(Math.PI / 2);
      expect(centre[0]).toBeCloseTo(-10 + posterSize.depth + 0.002);
      // Clear of the floor and the ceiling.
      expect(centre[1] - half.up).toBeGreaterThan(1.2);
      expect(centre[1] + half.up).toBeLessThan(3 - 0.2);
    }
    arcade.forEach((one, index) => {
      for (const other of arcade.slice(index + 1)) {
        const apart =
          Math.abs(one.centre[2] - other.centre[2]) >= 2 * half.across ||
          Math.abs(one.centre[1] - other.centre[1]) >= 2 * half.up;
        expect(apart, `${one.art.title} and ${other.art.title}`).toBe(true);
      }
    });
  });

  it("between the dartboard and the hoop, clear of the darts players and the theme's props", () => {
    const [, , dartZ] = lounge.dartboard;
    for (const { centre } of arcade) {
      const [from, to] = [centre[2] - half.across, centre[2] + half.across];
      // Past the darts players' end of the lounge and the theme's zone.
      expect(from).toBeGreaterThan(Math.max(dartZ + 0.5, lounge.walkway.z[1]));
      expect(from).toBeGreaterThanOrEqual(themeZone.z[1]);
      // Short of the backboard on the smallest Floor.
      expect(to).toBeLessThan(
        gamesHall.from + gamesHall.walkway + gamesHall.hoop.z - 0.55,
      );
    }
  });

  const sizes = [1, 2, 6, 12, 18, 30];
  it.each(
    floorThemes.flatMap((theme) => sizes.map((size) => [theme, size] as const)),
  )(
    "%s, a team of %i: every one hangs, its frame on the wall, nothing in front of it",
    (theme, size) => {
      const layout = floorLayout(team(size), theme);
      const frames = layout.pieces.filter(({ name }) =>
        name.startsWith("poster frame"),
      );
      expect(frames).toHaveLength(wallPosters.length);
      // Anything within a metre of the wall that could stand in front of a
      // poster, or cover it.
      type Span = readonly [number, number];
      const blocking: { name: string; x: Span; y: Span; z: Span }[] = [
        ...layout.pieces
          .filter(
            ({ name }) =>
              !name.startsWith("poster frame") &&
              name !== "left wall" &&
              name !== "floor",
          )
          .map(({ name, position, size: [w, h, d] }) => ({
            name,
            x: [position[0] - w / 2, position[0] + w / 2] as const,
            y: [position[1] - h / 2, position[1] + h / 2] as const,
            z: [position[2] - d / 2, position[2] + d / 2] as const,
          })),
        ...layout.models.map((placement) => {
          const [w, h, d] = placedSize(placement);
          const [x, y, z] = placement.position;
          return {
            name: placement.name,
            x: [x - w / 2, x + w / 2] as const,
            y: [y, y + h] as const,
            z: [z - d / 2, z + d / 2] as const,
          };
        }),
      ];
      for (const { art, centre } of arcade) {
        const [, y, z] = centre;
        for (const each of blocking) {
          const overlaps =
            each.x[0] < -9 &&
            each.y[0] < y + half.up &&
            each.y[1] > y - half.up &&
            each.z[0] < z + half.across &&
            each.z[1] > z - half.across;
          expect(overlaps, `${art.title} behind ${each.name}`).toBe(false);
        }
      }
    },
  );
});

describe("the posters' texture", () => {
  it.each(qualityLevels)(
    "%s: fits the quality's largest texture, every poster in one",
    (quality) => {
      const count = wallPosters.length;
      expect(count).toBe(17);
      const { width, height, gutter } = posterCell(quality, count);
      const { columns, rows } = posterGrid(count);
      expect(columns * rows).toBeGreaterThanOrEqual(count);
      const side = qualityPresets[quality].largestTexture;
      expect(columns * (width + 2 * gutter)).toBeLessThanOrEqual(side);
      expect(rows * (height + 2 * gutter)).toBeLessThanOrEqual(side);
      expect(height / width).toBeCloseTo(posterUnits[1] / posterUnits[0], 1);
      expect(gutter).toBeGreaterThan(0);
    },
  );

  it("is one mesh's geometry: a face for each poster, on its wall, facing the room", () => {
    const geometry = postersGeometry(wallPosters, "medium");
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const uv = geometry.getAttribute("uv");
    // Four corners a poster.
    expect(position.count).toBe(4 * wallPosters.length);
    wallPosters.forEach(({ centre, rotationY }, index) => {
      for (let corner = 0; corner < 4; corner += 1) {
        const vertex = index * 4 + corner;
        if (rotationY === 0) {
          expect(position.getZ(vertex)).toBeCloseTo(centre[2], 6);
          expect(normal.getZ(vertex)).toBeCloseTo(1, 6);
        } else {
          expect(position.getX(vertex)).toBeCloseTo(centre[0], 6);
          expect(normal.getX(vertex)).toBeCloseTo(1, 6);
        }
        expect(uv.getX(vertex)).toBeGreaterThanOrEqual(0);
        expect(uv.getX(vertex)).toBeLessThanOrEqual(1);
        expect(uv.getY(vertex)).toBeGreaterThanOrEqual(0);
        expect(uv.getY(vertex)).toBeLessThanOrEqual(1);
      }
    });
    geometry.dispose();
  });
});
