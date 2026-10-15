import { deskDressings, type Role } from "@ai-office/shared";
import { deskItemKinds, type DeskItemKind } from "@ai-office/shared/avatar";
import { beforeAll, describe, expect, it } from "vitest";

import {
  deskItemFootprint,
  placeDeskItems,
  type DeskItemPlacement,
} from "./desk-item-layout.ts";
import { desk, type DeskRole } from "./desk-set.ts";
import { provideModels } from "./models.ts";
import { loadModelsFromDisk } from "./test-models.ts";

beforeAll(async () => {
  provideModels(await loadModelsFromDisk());
});

const owners: DeskRole[] = [
  { role: "manager" },
  ...(["coder", "reviewer", "qa", "docs", "designer"] as Role[]).map(
    (role) => ({ role }),
  ),
  ...deskDressings.map((deskDressing) => ({
    role: `${deskDressing}-role`,
    stage: "work" as const,
    deskDressing,
  })),
];

/** Where a placed item covers the desk, about its centre. */
function covers({ item, x, z, rotation }: DeskItemPlacement) {
  const {
    size: [width, depth],
    centre: [cx, cz],
  } = deskItemFootprint(item);
  const [w, d] = rotation === 0 ? [width, depth] : [depth, width];
  const [ox, oz] = rotation === 0 ? [cx, cz] : [cz, -cx];
  return {
    x: [x + ox - w / 2, x + ox + w / 2],
    z: [z + oz - d / 2, z + oz + d / 2],
  } as const;
}

describe("the things on an Agent's desk", () => {
  it.each<[DeskItemKind, number, number]>([
    // Across and front to back, in metres, give or take a few centimetres.
    // Open, its lid leans back past its base.
    ["laptop", 0.32, 0.27],
    ["paper", 0.22, 0.3],
    ["notebook", 0.15, 0.21],
    ["tablet", 0.19, 0.25],
    ["phone", 0.08, 0.16],
  ])("are the real size: a %s is about %f m by %f m", (item, width, depth) => {
    const { size } = deskItemFootprint(item);
    expect(Math.abs(size[0] - width), item).toBeLessThan(0.04);
    expect(Math.abs(size[1] - depth), item).toBeLessThan(0.04);
  });

  it("make a ruler about 30 cm long and a mug about 8 cm across", () => {
    expect(Math.max(...deskItemFootprint("ruler").size)).toBeGreaterThan(0.28);
    expect(Math.max(...deskItemFootprint("ruler").size)).toBeLessThan(0.34);
    const mug = deskItemFootprint("coffee-mug").size;
    expect(Math.min(...mug)).toBeGreaterThan(0.06);
    expect(Math.max(...mug)).toBeLessThan(0.13);
  });

  it("fit one at a time on a plain desk, every one of the thirty", () => {
    for (const item of deskItemKinds) {
      expect(placeDeskItems({ role: "coder" }, [item]), item).toHaveLength(1);
    }
  });

  it("lie on the desk top, clear of each other, for every Role and desk dressing", () => {
    const choices: DeskItemKind[][] = [
      ["laptop", "coffee-mug", "paper", "ruler", "pen"],
      ["desk-lamp", "potted-plant", "globe", "book-stack", "tablet"],
      ["phone", "stapler", "notebook", "water-bottle", "trophy"],
    ];
    for (const owner of owners) {
      for (const items of choices) {
        const placed = placeDeskItems(owner, items);
        // In the order chosen, leaving off only what has no room.
        expect(
          placed.map(({ item }) => item),
          owner.role,
        ).toEqual(items.filter((item) => placed.some((p) => p.item === item)));
        expect(placed.length, owner.role).toBeGreaterThanOrEqual(2);
        const rects = placed.map(covers);
        for (const rect of rects) {
          expect(rect.x[0]).toBeGreaterThanOrEqual(-desk.width / 2 - 1e-9);
          expect(rect.x[1]).toBeLessThanOrEqual(desk.width / 2 + 1e-9);
          expect(rect.z[0]).toBeGreaterThanOrEqual(-desk.depth / 2 - 1e-9);
          expect(rect.z[1]).toBeLessThanOrEqual(desk.depth / 2 + 1e-9);
        }
        rects.forEach((a, i) => {
          rects.slice(i + 1).forEach((b) => {
            const overlap =
              a.x[0] < b.x[1] - 1e-9 &&
              b.x[0] < a.x[1] - 1e-9 &&
              a.z[0] < b.z[1] - 1e-9 &&
              b.z[0] < a.z[1] - 1e-9;
            expect(overlap, `${owner.role}: ${items.join(", ")}`).toBe(false);
          });
        });
      }
    }
  });

  it("put a laptop on an ordinary desk beside the monitor", () => {
    expect(placeDeskItems({ role: "coder" }, ["laptop"])).toHaveLength(1);
  });
});
