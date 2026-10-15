// Generating the throwaway target repository's issues and files from the
// corpus (generate-target.ts, Enablement E2, #188), against the in-memory fake
// GitHub, with the file commit faked (no Git remote). It opens the corpus's
// issues, writes its files, and does both idempotently.

import { describe, expect, it } from "vitest";

import { createFakeGitHub } from "../../packages/github/src/testing.ts";

import { hostileCorpus } from "./corpus.ts";
import {
  corpusLabel,
  generateTarget,
  intakeLabel,
  type CommitFiles,
} from "./generate-target.ts";

const stub = "http://stub-upstream:3050";
const repository = "acme/pen-test-target";

/** A fake commit port that records the files written. */
function recordingCommit(): {
  readonly commit: CommitFiles;
  readonly writes: { files: readonly string[]; message: string }[];
} {
  const writes: { files: readonly string[]; message: string }[] = [];
  return {
    writes,
    commit: (files, message) => {
      writes.push({ files: files.map(({ path }) => path), message });
      return Promise.resolve();
    },
  };
}

describe("generating the target repository", () => {
  it("opens the corpus's issues and writes its files", async () => {
    const github = createFakeGitHub();
    github.installRepository(repository);
    const { commit, writes } = recordingCommit();

    const result = await generateTarget({
      app: github,
      repository,
      commit,
      stubUpstreamUrl: stub,
    });

    const corpus = hostileCorpus(stub);
    const issueItems = corpus.filter((item) => item.kind === "issue");
    const fileItems = corpus.filter((item) => item.kind === "file");

    expect(result.issues).toHaveLength(issueItems.length);
    expect(result.files).toEqual(fileItems.map((item) => item.path));

    // Each issue is open, labelled for intake and the corpus, and names its
    // canary.
    const issues = await github
      .repository(repository)
      .listIssues({ state: "all" });
    for (const made of result.issues) {
      const issue = issues.find(
        (candidate) => candidate.number === made.number,
      );
      expect(issue).toBeDefined();
      expect(issue?.labels).toContain(intakeLabel);
      expect(issue?.labels).toContain(corpusLabel);
      expect(issue?.body).toContain(made.canary);
    }

    // The files were committed once, by path.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.files).toEqual(fileItems.map((item) => item.path));
  });

  it("is idempotent: a second run opens no new issue and re-commits the files", async () => {
    const github = createFakeGitHub();
    github.installRepository(repository);
    const { commit } = recordingCommit();

    const first = await generateTarget({
      app: github,
      repository,
      commit,
      stubUpstreamUrl: stub,
    });
    const second = await generateTarget({
      app: github,
      repository,
      commit,
      stubUpstreamUrl: stub,
    });

    expect(second.issues).toEqual(first.issues);
    const all = await github
      .repository(repository)
      .listIssues({ state: "all" });
    // Exactly one issue per corpus issue item, not two.
    expect(all).toHaveLength(first.issues.length);
  });

  it("names each issue's corpus id, hypothesis and canary in its body, for triage", async () => {
    const github = createFakeGitHub();
    github.installRepository(repository);
    const { commit } = recordingCommit();
    await generateTarget({
      app: github,
      repository,
      commit,
      stubUpstreamUrl: stub,
    });
    const issues = await github
      .repository(repository)
      .listIssues({ state: "all" });
    const corpus = hostileCorpus(stub).filter((item) => item.kind === "issue");
    for (const item of corpus) {
      const issue = issues.find((candidate) =>
        candidate.body.includes(`pen-test-corpus: ${item.id}`),
      );
      expect(issue, `issue for ${item.id}`).toBeDefined();
      expect(issue?.body).toContain(`hypothesis: ${item.hypothesis}`);
      expect(issue?.body).toContain(`canary: ${item.canary}`);
    }
  });
});
