// The hostile-content corpus (corpus.ts, Enablement E2, #188): every item
// carries a unique canary and names a hypothesis, the canaries phone home to
// the stub upstream and nowhere else, and the artefact kinds and hypotheses
// the PRD lists are all present.

import { describe, expect, it } from "vitest";

import {
  canaryCorpusPrefix,
  corpusCanary,
  corpusHypotheses,
  hostileCorpus,
  phoneHome,
  type CorpusItem,
  type CorpusKind,
} from "./corpus.ts";

const stub = "http://stub-upstream:3050";

describe("the hostile-content corpus", () => {
  const corpus = hostileCorpus(stub);

  it("gives every item a canary and a hypothesis", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(8);
    for (const item of corpus) {
      expect(item.canary).toBe(corpusCanary(item.id));
      expect(item.canary.startsWith(canaryCorpusPrefix)).toBe(true);
      expect(corpusHypotheses).toContain(item.hypothesis);
      expect(item.summary).not.toBe("");
    }
  });

  it("gives every item a unique id and a unique canary", () => {
    expect(new Set(corpus.map((item) => item.id)).size).toBe(corpus.length);
    expect(new Set(corpus.map((item) => item.canary)).size).toBe(corpus.length);
  });

  it("covers every hypothesis the PRD names (H8, H9, H10, H13)", () => {
    const covered = new Set(corpus.map((item) => item.hypothesis));
    for (const hypothesis of corpusHypotheses) {
      expect(covered).toContain(hypothesis);
    }
  });

  it("covers every artefact kind position 2 controls", () => {
    const kinds: readonly CorpusKind[] = [
      "issue",
      "file",
      "review-comment",
      "skill",
      "floor-template",
      "memory-proposal",
    ];
    const present = new Set(corpus.map((item) => item.kind));
    for (const kind of kinds) {
      expect(present).toContain(kind);
    }
  });

  it("ships the repository files the PRD lists, by path", () => {
    const paths = new Set(
      corpus.filter((item) => item.kind === "file").map((item) => item.path),
    );
    for (const path of [
      "CLAUDE.md",
      ".claude/settings.json",
      "package.json",
      "scripts/ci-setup.sh",
    ]) {
      expect(paths).toContain(path);
    }
  });

  it("phones every canary home to the stub upstream, never anywhere else", () => {
    const beacon = (canary: string) => phoneHome(stub, canary);
    for (const item of corpus) {
      // Where the hostile text lives: the content, plus the Skill's and Floor
      // Template's own fields (the floor-template's canary is in its
      // setupCommand, not its content).
      const surface = [item.content, item.template?.setupCommand ?? ""].join(
        "\n",
      );
      const urls = [...surface.matchAll(/https?:\/\/[^\s"'`)|]+/g)].map(
        (match) => match[0],
      );
      // Every URL that carries this item's canary is the stub's beacon, bar a
      // query string the payload may append.
      const carrying = urls.filter((url) => url.includes(item.canary));
      expect(carrying.length).toBeGreaterThan(0);
      for (const url of carrying) {
        expect(url.startsWith(beacon(item.canary))).toBe(true);
      }
    }
  });

  it("maps each DB-seeded kind to the hypothesis it tests", () => {
    // The hypothesis is the item's, not buried in the hostile text.
    const byKind = (kind: CorpusKind): CorpusItem[] =>
      corpus.filter((item) => item.kind === kind);
    expect(byKind("memory-proposal")[0]?.hypothesis).toBe("H9");
    expect(byKind("floor-template")[0]?.hypothesis).toBe("H13");
    expect(byKind("skill")[0]?.hypothesis).toBe("H10");
  });

  it("keeps the memory proposal to one line within the limit", () => {
    const proposal = corpus.find((item) => item.kind === "memory-proposal");
    expect(proposal).toBeDefined();
    expect(proposal?.content.includes("\n")).toBe(false);
    expect(proposal?.content.length ?? 0).toBeLessThanOrEqual(300);
  });

  it("builds valid JSON for the .claude/settings.json and package.json files", () => {
    for (const path of [".claude/settings.json", "package.json"]) {
      const item = corpus.find((candidate) => candidate.path === path);
      expect(item).toBeDefined();
      expect(() => {
        JSON.parse(item?.content ?? "");
      }).not.toThrow();
    }
  });
});
