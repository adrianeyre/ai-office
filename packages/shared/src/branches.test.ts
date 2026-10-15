import { describe, expect, it } from "vitest";

import {
  behindWarning,
  branchCommitSchema,
  likelyToConflict,
  officeBranchOf,
} from "./branches.ts";
import { grillingBranch } from "./grilling.ts";

describe("officeBranchOf", () => {
  it("knows an issue's branch, with its slug or without one", () => {
    expect(officeBranchOf("ai-office/4-add-a-basket")).toEqual({
      kind: "issue",
      issue: 4,
    });
    expect(officeBranchOf("ai-office/126")).toEqual({
      kind: "issue",
      issue: 126,
    });
    expect(officeBranchOf("ai-office/12-3d-office")).toEqual({
      kind: "issue",
      issue: 12,
    });
  });

  it("knows a one-pull-request Batch's shared branch", () => {
    expect(officeBranchOf("ai-office/batch-7")).toEqual({
      kind: "batch",
      batchId: 7,
    });
  });

  it("knows a Grilling Session's documents branch", () => {
    expect(officeBranchOf(grillingBranch(3))).toEqual({
      kind: "grilling",
      sessionId: 3,
    });
  });

  it("knows no other branch, AI Office's prefix or not", () => {
    for (const name of [
      "main",
      "feature/4-add-a-basket",
      "ai-office/",
      "ai-office/contract-1a2b-lane-a",
      "ai-office/0-zero",
      "ai-office/04-leading-zero",
      "ai-office/4-Add-A-Basket",
      "ai-office/4--double",
      "ai-office/grilling-",
      "ai-office/grilling-3-notes",
      "ai-office/batch-",
      "ai-office/batch-0",
      "ai-office/batch-7-notes",
      "ai-office/4-add/a-basket",
      "refs/heads/ai-office/4-add-a-basket",
    ]) {
      expect(officeBranchOf(name)).toBeUndefined();
    }
  });
});

describe("likelyToConflict", () => {
  const now = new Date("2026-10-12T12:00:00.000Z");
  const daysAgo = (days: number) =>
    new Date(now.getTime() - days * 86_400_000).toISOString();

  it("is not for a branch at most 20 commits behind that split off at most 7 days ago", () => {
    expect(behindWarning).toEqual({ commits: 20, days: 7 });
    expect(
      likelyToConflict({ behindBy: 0, mergeBaseAt: daysAgo(0) }, now),
    ).toBe(false);
    expect(
      likelyToConflict({ behindBy: 20, mergeBaseAt: daysAgo(7) }, now),
    ).toBe(false);
  });

  it("is for a branch more than 20 commits behind", () => {
    expect(
      likelyToConflict({ behindBy: 21, mergeBaseAt: daysAgo(0) }, now),
    ).toBe(true);
  });

  it("is for a branch that split off more than 7 days ago, however few commits behind", () => {
    expect(
      likelyToConflict(
        { behindBy: 0, mergeBaseAt: daysAgo(7 + 1 / 86_400) },
        now,
      ),
    ).toBe(true);
  });
});

describe("branchCommitSchema", () => {
  it("takes only an http(s) address for a commit's page, as it becomes a link", () => {
    const commit = {
      sha: "a".repeat(40),
      message: "Add a basket",
      author: "Adrian Eyre",
      agent: null,
      authoredAt: "2026-10-12T09:00:00.000Z",
      url: `https://github.com/adrianeyre/web-shop/commit/${"a".repeat(40)}`,
    };
    expect(branchCommitSchema.safeParse(commit).success).toBe(true);
    expect(
      branchCommitSchema.safeParse({ ...commit, url: "javascript:alert(1)" })
        .success,
    ).toBe(false);
  });
});
