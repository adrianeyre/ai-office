import type { Notice } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  boardPreview,
  boardSize,
  cardSize,
  charactersPerLine,
  maxCards,
  maxLines,
  maxStackedSheets,
  maxTilt,
  unitHash,
  writingLines,
} from "./notice-board-preview.ts";

// The lobby's 3D Notice Board (PRD FR-50, FR-57): which Notices it shows as
// cards, where, and how, from the open Notices the API lists.

const notice = (id: string, overrides: Partial<Notice> = {}): Notice => ({
  id,
  kind: "info",
  title: "PR #3 opened",
  floorId: "web-shop",
  agentId: null,
  issue: null,
  pullRequest: null,
  ciRunUrl: null,
  actions: [],
  createdAt: "2026-10-08T12:00:00.000Z",
  dismissedAt: null,
  actedAt: null,
  actedOn: null,
  links: [],
  positions: [],
  ...overrides,
});

/** `count` Notices, a minute apart, the last the newest. */
const minuteApart = (count: number, overrides: Partial<Notice> = {}) =>
  Array.from({ length: count }, (_, index) =>
    notice(`notice-${String(index + 1)}`, {
      createdAt: new Date(Date.UTC(2026, 9, 8, 12, index)).toISOString(),
      ...overrides,
    }),
  );

describe("the Notice Board's preview", () => {
  it("is empty, and says so, with no open Notices", () => {
    const preview = boardPreview([]);
    expect(preview.cards).toEqual([]);
    expect(preview.hidden).toBe(0);
    expect(preview.stackedSheets).toBe(0);
    expect(preview.counts).toEqual({ action: 0, info: 0 });
    expect(preview.summary).toBe(
      "The Notice Board is empty: nothing needs you right now.",
    );
  });

  it("pins the latest Notices newest first, filling the grid from the top left", () => {
    const preview = boardPreview(minuteApart(4));
    expect(preview.cards.map(({ id }) => id)).toEqual([
      "notice-4",
      "notice-3",
      "notice-2",
      "notice-1",
    ]);
    expect(preview.cards.map(({ column, row }) => [column, row])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
    ]);
    // Left to right, then top to bottom, in metres from the board's centre.
    const [first, second, third, fourth] = preview.cards.map(
      ({ position }) => position,
    );
    expect(first?.[0]).toBeLessThan(second?.[0] ?? 0);
    expect(second?.[0]).toBeLessThan(third?.[0] ?? 0);
    expect(fourth?.[0]).toBe(first?.[0]);
    expect(fourth?.[1]).toBeLessThan(first?.[1] ?? 0);
    expect(second?.[0]).toBe(0);
  });

  it("orders by when each was raised, whatever order they come in", () => {
    const [older, newer] = minuteApart(2);
    if (older === undefined || newer === undefined) {
      throw new Error("Two Notices were made.");
    }
    expect(boardPreview([older, newer]).cards.map(({ id }) => id)).toEqual([
      "notice-2",
      "notice-1",
    ]);
    // Raised at the same moment, they are in a stable order.
    const same = { createdAt: "2026-10-08T12:00:00.000Z" };
    expect(
      boardPreview([notice("b", same), notice("a", same)]).cards.map(
        ({ id }) => id,
      ),
    ).toEqual(["a", "b"]);
  });

  it("shows at most six cards; the rest are a stack of up to three sheets", () => {
    const seven = boardPreview(minuteApart(7));
    expect(maxCards).toBe(6);
    expect(seven.cards).toHaveLength(6);
    expect(seven.cards.map(({ id }) => id)).not.toContain("notice-1");
    expect(seven.hidden).toBe(1);
    expect(seven.stackedSheets).toBe(1);

    const twenty = boardPreview(minuteApart(20));
    expect(twenty.cards).toHaveLength(6);
    expect(twenty.hidden).toBe(14);
    expect(twenty.stackedSheets).toBe(maxStackedSheets);
    expect(twenty.summary).toBe(
      "The Notice Board has 20 info Notices; the latest 6 are pinned up.",
    );

    expect(boardPreview(minuteApart(6)).hidden).toBe(0);
  });

  it("tells an action Notice from an info one by colour and by its pins", () => {
    const preview = boardPreview([
      notice("approve", {
        kind: "action",
        title: "PR #14 awaiting your approval",
        createdAt: "2026-10-08T12:01:00.000Z",
      }),
      notice("opened"),
    ]);
    const [action, info] = preview.cards;
    expect(action).toMatchObject({ kind: "action", token: "state-critical" });
    expect(info).toMatchObject({ kind: "info", token: "state-info" });
    expect(action?.pins).toHaveLength(2);
    expect(info?.pins).toHaveLength(1);
    expect(preview.counts).toEqual({ action: 1, info: 1 });
    expect(preview.summary).toBe(
      "The Notice Board has 1 action Notice and 1 info Notice.",
    );
  });

  it("shows every Floor's Notices, and those about the whole Office", () => {
    const preview = boardPreview([
      notice("shop", { floorId: "web-shop" }),
      notice("blog", { floorId: "blog" }),
      notice("office", { floorId: null }),
    ]);
    expect(preview.cards.map(({ id }) => id).toSorted()).toEqual([
      "blog",
      "office",
      "shop",
    ]);
  });

  it("leaves off a Notice already dismissed or acted on", () => {
    const preview = boardPreview([
      notice("open"),
      notice("dismissed", { dismissedAt: "2026-10-08T13:00:00.000Z" }),
      notice("acted", {
        kind: "action",
        actedAt: "2026-10-08T13:00:00.000Z",
        actedOn: "approve_and_merge",
      }),
    ]);
    expect(preview.cards.map(({ id }) => id)).toEqual(["open"]);
    expect(preview.counts).toEqual({ action: 0, info: 1 });
  });

  it("keeps every card, turned and pinned, on the board", () => {
    const preview = boardPreview(
      minuteApart(6).map((each, index) =>
        index % 2 === 0 ? { ...each, kind: "action" as const } : each,
      ),
    );
    const frame = 0.05;
    for (const { position, tilt, pins } of preview.cards) {
      expect(Math.abs(tilt)).toBeLessThanOrEqual(maxTilt);
      // The turned card's half extents.
      const halfWidth =
        (cardSize.width / 2) * Math.cos(tilt) +
        (cardSize.height / 2) * Math.abs(Math.sin(tilt));
      const halfHeight =
        (cardSize.width / 2) * Math.abs(Math.sin(tilt)) +
        (cardSize.height / 2) * Math.cos(tilt);
      expect(Math.abs(position[0]) + halfWidth).toBeLessThan(
        boardSize.width / 2 - frame,
      );
      expect(Math.abs(position[1]) + halfHeight).toBeLessThan(
        boardSize.height / 2 - frame,
      );
      for (const [x, y] of pins) {
        expect(Math.abs(x)).toBeLessThan(cardSize.width / 2);
        expect(Math.abs(y)).toBeLessThan(cardSize.height / 2);
      }
    }
    // No two cards overlap: their centres are further apart than a card.
    const cards = preview.cards;
    for (const [index, a] of cards.entries()) {
      for (const b of cards.slice(index + 1)) {
        const apartX = Math.abs(a.position[0] - b.position[0]);
        const apartY = Math.abs(a.position[1] - b.position[1]);
        expect(apartX > cardSize.width || apartY > cardSize.height).toBe(true);
      }
    }
  });

  it("gives a card the same tilt whatever else is on the board", () => {
    const alone = boardPreview([notice("steady")]).cards[0];
    const crowded = boardPreview([
      notice("steady"),
      ...minuteApart(3),
    ]).cards.find(({ id }) => id === "steady");
    expect(crowded?.tilt).toBe(alone?.tilt);
    // Different Notices are turned differently.
    const tilts = new Set(
      boardPreview(minuteApart(6)).cards.map(({ tilt }) => tilt),
    );
    expect(tilts.size).toBe(6);
  });

  it("writes a card's title as lines as long as the title, never as text", () => {
    const short = boardPreview([notice("short", { title: "Agent recovered" })])
      .cards[0];
    const long = boardPreview([
      notice("long", {
        title:
          "Token Cap reached: Ada has used 100% of the daily Token Cap on web-shop",
      }),
    ]).cards[0];
    expect(short?.lines).toHaveLength(1);
    expect(long?.lines).toHaveLength(maxLines);
    // A card holds numbers only: nothing of its title.
    expect(JSON.stringify(long)).not.toContain("Token Cap");
  });
});

describe("a title's lines of writing", () => {
  it("are one full line per line's worth of characters, then the rest", () => {
    expect(writingLines("x".repeat(charactersPerLine))).toEqual([1]);
    expect(writingLines("x".repeat(charactersPerLine + 14))).toEqual([1, 0.5]);
    expect(writingLines("x".repeat(charactersPerLine * 2 + 7))).toEqual([
      1, 1, 0.25,
    ]);
  });

  it("are at most three, however long the title", () => {
    expect(writingLines("x".repeat(500))).toEqual([1, 1, 1]);
  });

  it("make even a very short title a word, not a dot", () => {
    expect(writingLines("OK")).toEqual([0.2]);
    expect(writingLines("")).toEqual([0.2]);
    expect(writingLines("   PR   ")).toEqual(writingLines("PR"));
  });
});

describe("the hash that turns a card", () => {
  it("is stable and between 0 and 1", () => {
    expect(unitHash("notice-1")).toBe(unitHash("notice-1"));
    expect(unitHash("notice-1")).not.toBe(unitHash("notice-2"));
    for (const text of ["", "a", "notice-123", "x".repeat(200)]) {
      expect(unitHash(text)).toBeGreaterThanOrEqual(0);
      expect(unitHash(text)).toBeLessThanOrEqual(1);
    }
  });
});
