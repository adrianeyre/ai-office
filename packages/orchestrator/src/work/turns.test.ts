import { postgresTest } from "@ai-office/db/testing";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import {
  afterDelivery,
  createWorkTurns,
  fixRole,
  type WorkTurnsRecord,
} from "./turns.ts";

// The turns of the work Roles a Plan gives one issue (PRD FR-25 (1)): each
// Role takes its turn on the branch, then review; the Review Loop's fixes
// go to the Role whose changes its blocking comments concern, or to the
// last. Kept in memory and in Postgres 18, alike.

const at = (minute: number) =>
  new Date(`2026-10-10T09:${String(minute).padStart(2, "0")}:00.000Z`);

const record = (fields: Partial<WorkTurnsRecord> = {}): WorkTurnsRecord => ({
  floorId: "shop-theme",
  issue: 1,
  batchId: 1,
  roles: ["merchandiser", "copywriter", "seo"],
  turn: 0,
  reviewing: false,
  files: {},
  updatedAt: at(0),
  ...fields,
});

describe("taking turns", () => {
  it("hands the issue to each Role in order, then to review; a fix goes back to review", () => {
    const first = afterDelivery(record(), ["products/a.json"], at(1));
    expect(first).toEqual({
      record: record({
        turn: 1,
        files: { merchandiser: ["products/a.json"] },
        updatedAt: at(1),
      }),
      delivered: { next: "role", role: "copywriter" },
    });
    const second = afterDelivery(
      first.record,
      ["copy/a.md", "products/a.json"],
      at(2),
    );
    expect(second.delivered).toEqual({ next: "role", role: "seo" });
    const last = afterDelivery(second.record, ["copy/a.md"], at(3));
    expect(last).toEqual({
      record: record({
        turn: 2,
        reviewing: true,
        files: {
          merchandiser: ["products/a.json"],
          copywriter: ["copy/a.md", "products/a.json"],
          seo: ["copy/a.md"],
        },
        updatedAt: at(3),
      }),
      delivered: { next: "review" },
    });
    // Once reviewing, a fix by the first Role goes straight back to
    // review, and the last Role's turn is next.
    const fix = afterDelivery(
      { ...last.record, turn: 0 },
      ["products/b.json"],
      at(4),
    );
    expect(fix.delivered).toEqual({ next: "review" });
    expect(fix.record.turn).toBe(2);
    expect(fix.record.files["merchandiser"]).toEqual([
      "products/a.json",
      "products/b.json",
    ]);
  });

  it("one Role goes straight to review", () => {
    expect(
      afterDelivery(record({ roles: ["copywriter"] }), ["a.md"], at(1)),
    ).toEqual({
      record: record({
        roles: ["copywriter"],
        reviewing: true,
        files: { copywriter: ["a.md"] },
        updatedAt: at(1),
      }),
      delivered: { next: "review" },
    });
  });

  it("a fix goes to the one Role whose changes its comments concern, else to the last", () => {
    const turns = {
      roles: ["merchandiser", "copywriter", "seo"],
      files: {
        merchandiser: ["products/a.json", "shared.txt"],
        copywriter: ["copy/a.md", "shared.txt"],
        seo: ["meta/a.json"],
      },
    };
    expect(fixRole(turns, ["products/a.json"])).toEqual({
      role: "merchandiser",
      clear: true,
    });
    expect(fixRole(turns, ["copy/a.md", "copy/a.md"])).toEqual({
      role: "copywriter",
      clear: true,
    });
    // Two Roles' files.
    expect(fixRole(turns, ["products/a.json", "copy/a.md"])).toEqual({
      role: "seo",
      clear: false,
    });
    // A file two Roles changed.
    expect(fixRole(turns, ["shared.txt"])).toEqual({
      role: "seo",
      clear: false,
    });
    // A file no Role changed, or no file at all.
    expect(fixRole(turns, ["README.md"])).toEqual({
      role: "seo",
      clear: false,
    });
    expect(fixRole(turns, ["products/a.json", "README.md"])).toEqual({
      role: "seo",
      clear: false,
    });
    expect(fixRole(turns, [])).toEqual({ role: "seo", clear: false });
  });
});

async function run(stores: OfficeStores): Promise<void> {
  const fake = createFakeGitHub();
  fake.installRepository("adrianeyre/shop-theme");
  await createFloors({
    store: stores.floors,
    github: fake,
    events: createEventBus({ store: memoryEventStore() }),
  }).add("adrianeyre/shop-theme");
  let minute = 0;
  const turns = createWorkTurns({
    store: stores.workTurns,
    now: () => at((minute += 1)),
  });

  expect(await turns.get("shop-theme", 1)).toBeUndefined();
  expect(await turns.role("shop-theme", 1)).toBeNull();
  expect(await turns.delivered("shop-theme", 1, ["a"])).toBeUndefined();
  expect(await turns.sendBack("shop-theme", 1, ["a"])).toBeUndefined();
  await expect(turns.plan("shop-theme", 1, [], null)).rejects.toThrow(
    "An issue's turns need at least one work Role.",
  );

  await turns.plan("shop-theme", 1, ["merchandiser", "copywriter"], null);
  expect(await turns.role("shop-theme", 1)).toBe("merchandiser");
  expect(
    await turns.delivered("shop-theme", 1, ["products/autumn.json"]),
  ).toEqual({ next: "role", role: "copywriter" });
  expect(await turns.role("shop-theme", 1)).toBe("copywriter");
  expect(await turns.delivered("shop-theme", 1, ["copy/autumn.md"])).toEqual({
    next: "review",
  });
  expect(await turns.get("shop-theme", 1)).toEqual({
    floorId: "shop-theme",
    issue: 1,
    batchId: null,
    roles: ["merchandiser", "copywriter"],
    turn: 1,
    reviewing: true,
    files: {
      merchandiser: ["products/autumn.json"],
      copywriter: ["copy/autumn.md"],
    },
    updatedAt: at(3),
  });
  expect(
    await turns.sendBack("shop-theme", 1, ["products/autumn.json"]),
  ).toEqual({ role: "merchandiser", clear: true });
  expect(await turns.role("shop-theme", 1)).toBe("merchandiser");
  expect(await turns.sendBack("shop-theme", 1, ["README.md"])).toEqual({
    role: "copywriter",
    clear: false,
  });
  expect(await turns.role("shop-theme", 1)).toBe("copywriter");

  // Planned again (another Batch's Plan): the turns start over.
  await turns.plan("shop-theme", 1, ["copywriter"], null);
  expect(await turns.get("shop-theme", 1)).toEqual(
    expect.objectContaining({
      roles: ["copywriter"],
      turn: 0,
      reviewing: false,
      files: {},
    }),
  );
  // Each issue has its own.
  expect(await turns.get("shop-theme", 2)).toBeUndefined();
}

describe("the turns' store", () => {
  it("in memory keeps each issue's work Roles, whose turn it is and the files each changed", async () => {
    await run(memoryStores());
  });

  postgresTest(
    "in Postgres 18 keeps each issue's work Roles, whose turn it is and the files each changed",
    async ({ database }) => {
      await run(databaseStores(database.db));
    },
  );
});
