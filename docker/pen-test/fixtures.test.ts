// The fixture ID listing (fixtures.ts, Enablement E2, #188): it names the
// seeded Floor IDs, Agent IDs and the throwaway repository's issue numbers for
// the credentials package (E4, #190), and holds no credential.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canaryCorpusPrefix } from "./corpus.ts";
import {
  fixtureListing,
  writeFixtureListing,
  type FixtureListing,
} from "./fixtures.ts";
import type { GenerateTargetResult } from "./generate-target.ts";
import type { SeedResult } from "./seed.ts";

const seedResult: SeedResult = {
  floors: [
    {
      id: "pen-test-target",
      repository: "acme/pen-test-target",
      mergePolicy: "auto_merge",
      agents: [
        { id: "a1", name: "Ada", role: "manager", stage: null },
        { id: "a2", name: "Ben", role: "coder", stage: "work" },
        { id: "a3", name: "Cleo", role: "reviewer", stage: "review" },
        { id: "a4", name: "Dan", role: "qa", stage: "qa" },
        { id: "a5", name: "Eve", role: "docs", stage: "docs" },
      ],
    },
    {
      id: "pen-test-review",
      repository: "acme/pen-test-review",
      mergePolicy: "send_to_me",
      agents: [{ id: "b1", name: "Fin", role: "manager", stage: null }],
    },
  ],
  aiAccounts: ["Claude (pen-test stub)", "Grok (pen-test stub)"],
  skill: { id: "pen-test-corpus-skill", name: "pen-test-release-helper" },
  template: { id: "pen-test-corpus-template", name: "Pen-test target kit" },
  memoryProposal: { id: 7, floorId: "pen-test-target" },
  corpus: [
    {
      id: "claude-md",
      kind: "file",
      hypothesis: "H10",
      canary: `${canaryCorpusPrefix}claude-md`,
      summary: "x",
      content: "x",
      path: "CLAUDE.md",
    },
  ],
};

const generated: GenerateTargetResult = {
  issues: [
    {
      id: "issue-override",
      canary: `${canaryCorpusPrefix}issue-override`,
      number: 4,
    },
  ],
  files: ["CLAUDE.md"],
};

const fixedNow = () => new Date("2026-10-11T00:00:00Z");

describe("the fixture ID listing", () => {
  it("names the Floor IDs, Agent IDs, AI Accounts and issue numbers", () => {
    const listing = fixtureListing(seedResult, {
      targetRepository: "acme/pen-test-target",
      generated,
      now: fixedNow,
    });
    expect(listing.targetRepository).toBe("acme/pen-test-target");
    expect(listing.floors.map((floor) => floor.id)).toEqual([
      "pen-test-target",
      "pen-test-review",
    ]);
    expect(listing.floors[0]?.agents.map((agent) => agent.id)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
    ]);
    expect(listing.aiAccounts).toEqual(seedResult.aiAccounts);
    expect(listing.issues).toEqual([
      {
        id: "issue-override",
        canary: `${canaryCorpusPrefix}issue-override`,
        number: 4,
      },
    ]);
    expect(listing.corpus.skill.id).toBe("pen-test-corpus-skill");
    expect(listing.corpus.items[0]?.hypothesis).toBe("H10");
  });

  it("holds no credential: only the harmless corpus canaries", () => {
    const listing = fixtureListing(seedResult, {
      targetRepository: "acme/pen-test-target",
      now: fixedNow,
    });
    const text = JSON.stringify(listing);
    // The AI Account canary credentials (pen-test-canary-<provider>-…) are
    // never in the listing; only the corpus beacons (pen-test-canary-corpus-…).
    for (const canary of text.match(/pen-test-canary-[\w-]+/g) ?? []) {
      expect(canary.startsWith(canaryCorpusPrefix)).toBe(true);
    }
  });

  it("writes the listing to a file as JSON", () => {
    const base = mkdtempSync(join(tmpdir(), "pen-test-fixtures-"));
    try {
      const path = join(base, "fixtures.json");
      const listing = fixtureListing(seedResult, {
        targetRepository: "acme/pen-test-target",
        now: fixedNow,
      });
      writeFixtureListing(path, listing);
      const read = JSON.parse(readFileSync(path, "utf8")) as FixtureListing;
      expect(read.floors).toHaveLength(2);
      expect(read.generatedAt).toBe("2026-10-11T00:00:00.000Z");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
