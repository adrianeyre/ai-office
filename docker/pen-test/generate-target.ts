// Generates the throwaway target repository's issues and files from the
// hostile-content corpus (`corpus.ts`, Enablement E2, #188). The pen-test
// stack's target Floor works this repository, and its own Agents are attacker
// position 2's victims (docs/pen-testing/stack.md).
//
// The corpus's `issue` items become GitHub issues the Owner opened (so intake
// takes them in, PRD FR-8), each labelled `ai-office` and `pen-test-corpus`
// with its id and canary in the body. The `file` items become files on the
// default branch. It is idempotent: an issue whose body already names its
// canary is left, and `commitFiles` pushes nothing when a file is already as
// given.
//
// It is written against ports, so it is tested with the in-memory fake GitHub
// (`generate-target.test.ts`) without a Git remote; `generateTargetCli` wires
// the real GitHub App and `commitFiles` for the stand-up.

import type { GitHubApp, Issue } from "../../packages/github/src/index.ts";

import { hostileCorpus, type CorpusItem } from "./corpus.ts";

/** The label every corpus issue and the throwaway repository carry. */
export const corpusLabel = "pen-test-corpus";

/** The label that makes AI Office take an issue in (PRD FR-8). */
export const intakeLabel = "ai-office";

/** Commits files to the default branch; `commitFiles` wrapped, for the real run. */
export type CommitFiles = (
  files: readonly { readonly path: string; readonly content: string }[],
  message: string,
) => Promise<void>;

export interface GenerateTargetOptions {
  readonly app: GitHubApp;
  /** The throwaway repository, as `owner/name`. */
  readonly repository: string;
  readonly commit: CommitFiles;
  /** The stub upstream the canaries phone home to. */
  readonly stubUpstreamUrl: string;
}

/** What `generateTarget` did. */
export interface GenerateTargetResult {
  /** The issues it opened, by corpus id and issue number. */
  readonly issues: readonly {
    readonly id: string;
    readonly canary: string;
    readonly number: number;
  }[];
  /** The repository paths it wrote. */
  readonly files: readonly string[];
}

/** The body of a corpus issue, with its id and canary where tests can find them. */
export function issueBody(item: CorpusItem): string {
  return [
    item.content,
    "",
    "<!--",
    `pen-test-corpus: ${item.id}`,
    `hypothesis: ${item.hypothesis}`,
    `canary: ${item.canary}`,
    "-->",
  ].join("\n");
}

/** Whether an existing issue is already this corpus item's. */
const isItemIssue = (issue: Issue, item: CorpusItem): boolean =>
  issue.body.includes(`pen-test-corpus: ${item.id}`);

export async function generateTarget(
  options: GenerateTargetOptions,
): Promise<GenerateTargetResult> {
  const { app, repository, commit } = options;
  const repo = app.repository(repository);
  const corpus = hostileCorpus(options.stubUpstreamUrl);

  await repo.ensureLabel({
    name: corpusLabel,
    color: "b60205",
    description: "Seeded hostile content for the pen-test (position 2, #188).",
  });

  const existing = await repo.listIssues({ state: "all" });
  const issues: { id: string; canary: string; number: number }[] = [];
  for (const item of corpus.filter(({ kind }) => kind === "issue")) {
    const already = existing.find((issue) => isItemIssue(issue, item));
    const number =
      already?.number ??
      (
        await repo.createIssue({
          title: item.title ?? item.summary,
          body: issueBody(item),
          labels: [intakeLabel, corpusLabel],
        })
      ).number;
    issues.push({ id: item.id, canary: item.canary, number });
  }

  const files = corpus.filter(({ kind }) => kind === "file");
  if (files.length > 0) {
    await commit(
      files.map((item) => ({
        path: item.path ?? item.id,
        content: item.content,
      })),
      "Seed the pen-test hostile-content corpus (#188)",
    );
  }

  return {
    issues,
    files: files.map((item) => item.path ?? item.id),
  };
}
