import type { VerdictComment } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  changedLines,
  commentSimilarity,
  describedBlocking,
  describeStall,
  judgedStall,
  minFixLines,
  stallOf,
} from "./stall.ts";
import type { VerdictRecord } from "./store.ts";

const verdict = (
  round: number,
  ...comments: (Pick<VerdictComment, "path" | "body"> & {
    readonly severity?: VerdictComment["severity"];
  })[]
): VerdictRecord => ({
  floorId: "web-shop",
  issue: 1,
  pullRequest: 2,
  round,
  agentId: "quinta",
  headSha: "a".repeat(40),
  verdict: {
    verdict: comments.some(({ severity }) => severity !== "nit")
      ? "changes_requested"
      : "approve",
    summary: "Summary.",
    comments: comments.map(({ path, body, severity = "blocking" }) => ({
      severity,
      path,
      line: 1,
      body,
    })),
  },
  reviewUrl: "https://github.com/adrianeyre/web-shop/pull/2",
  createdAt: new Date("2026-10-09T12:00:00Z"),
});

const blocking = (path: string, body: string) => ({ path, body });
const plenty = 40;

describe("commentSimilarity", () => {
  it("is the share of words two comments share, ignoring case and punctuation", () => {
    expect(
      commentSimilarity(
        "Add an add(sku) function.",
        "add an ADD SKU function!",
      ),
    ).toBe(1);
    expect(
      commentSimilarity("Reject an empty sku.", "Reject a blank sku."),
    ).toBe(2 / 6);
    expect(commentSimilarity("Add tests.", "Rename the basket.")).toBe(0);
  });
});

describe("stallOf", () => {
  it("finds a round whose blocking comments mostly repeat the previous round's", () => {
    const previous = [
      verdict(
        1,
        blocking("src/basket.ts", "Add an add(sku) function."),
        blocking("src/basket.ts", "Reject an empty sku."),
      ),
    ];
    const current = [
      verdict(
        2,
        blocking("src/basket.ts", "Add an add(sku) function, please."),
        blocking("src/basket.ts", "Reject an empty sku!"),
        blocking("README.md", "Document the basket."),
      ),
    ];
    expect(stallOf({ current, previous, fixLines: plenty })).toEqual({
      reason: "repeated",
      repeated: 2,
      of: 3,
    });
  });

  it("does not count half, nits, or the same words on another file", () => {
    const previous = [
      verdict(
        1,
        blocking("src/basket.ts", "Add an add(sku) function."),
        blocking("src/basket.ts", "Reject an empty sku."),
      ),
    ];
    // Half repeat: not most.
    expect(
      stallOf({
        current: [
          verdict(
            2,
            blocking("src/basket.ts", "Add an add(sku) function."),
            blocking("src/basket.ts", "Name it Basket."),
          ),
        ],
        previous,
        fixLines: plenty,
      }),
    ).toBeUndefined();
    // On another file.
    expect(
      stallOf({
        current: [verdict(2, blocking("src/cart.ts", "Reject an empty sku."))],
        previous,
        fixLines: plenty,
      }),
    ).toBeUndefined();
    // Repeating an earlier nit is not repeating a blocking comment.
    expect(
      stallOf({
        current: [verdict(2, blocking("src/basket.ts", "Name it Basket."))],
        previous: [
          verdict(1, {
            path: "src/basket.ts",
            body: "Name it Basket.",
            severity: "nit",
          }),
        ],
        fixLines: plenty,
      }),
    ).toBeUndefined();
  });

  it("finds a fix that barely changed the diff", () => {
    const previous = [verdict(1, blocking("src/basket.ts", "Add add(sku)."))];
    const current = [verdict(2, blocking("src/basket.ts", "Reject empty."))];
    expect(stallOf({ current, previous, fixLines: minFixLines - 1 })).toEqual({
      reason: "tiny_fix",
      lines: minFixLines - 1,
    });
    expect(
      stallOf({ current, previous, fixLines: minFixLines }),
    ).toBeUndefined();
  });

  it("finds no stall in a round without blocking comments", () => {
    expect(
      stallOf({
        current: [verdict(2)],
        previous: [verdict(1, blocking("src/basket.ts", "Add add(sku)."))],
        fixLines: 0,
      }),
    ).toBeUndefined();
  });
});

describe("changedLines", () => {
  it("adds up each file's added and deleted lines", () => {
    expect(
      changedLines([
        {
          path: "a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: null,
        },
        {
          path: "b.ts",
          status: "added",
          additions: 3,
          deletions: 0,
          patch: null,
        },
      ]),
    ).toBe(5);
    expect(changedLines([])).toBe(0);
  });
});

describe("describeStall", () => {
  it("says why, for the Notice", () => {
    expect(describeStall({ reason: "repeated", repeated: 1, of: 1 }, 1)).toBe(
      "its blocking comment repeats round 1's",
    );
    expect(describeStall({ reason: "repeated", repeated: 2, of: 3 }, 2)).toBe(
      "2 of its 3 blocking comments repeat round 2's",
    );
    expect(describeStall({ reason: "tiny_fix", lines: 1 }, 1)).toBe(
      "the fix since round 1 changed only 1 line, and blocking comments remain",
    );
    expect(describeStall({ reason: "judged", progress: "repeating" }, 1)).toBe(
      "the Decision Model judged that its blocking comments repeat round 1's",
    );
    expect(describeStall({ reason: "judged", progress: "stalled" }, 2)).toBe(
      "the Decision Model judged that the fix since round 2 made no real progress on its blocking comments",
    );
  });
});

describe("the Decision Model's judgement of a round (FR-17)", () => {
  it("is a stall when Jev judges it repeating or stalled, and none when converging", () => {
    expect(judgedStall({ progress: "converging", confidence: 0.9 })).toBe(
      undefined,
    );
    expect(judgedStall({ progress: "repeating", confidence: 0.6 })).toEqual({
      reason: "judged",
      progress: "repeating",
    });
    expect(judgedStall({ progress: "stalled", confidence: 0.6 })).toEqual({
      reason: "judged",
      progress: "stalled",
    });
  });

  it("reads each blocking comment, and no nit, with its file and line", () => {
    expect(
      describedBlocking([
        verdict(2, blocking("src/basket.ts", "Handle an empty basket."), {
          path: "src/basket.ts",
          body: "Rename it.",
          severity: "nit",
        }),
      ]),
    ).toEqual(["src/basket.ts line 1: Handle an empty basket."]);
  });
});
