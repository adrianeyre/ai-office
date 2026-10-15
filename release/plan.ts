// Plans a release, for release.yml's `release` job: semantic-release reads
// the Conventional Commits since the last tag and works out the next
// version and its notes, in dry-run, and this hands them to the `publish`
// job as the step's outputs. It runs dependency code (semantic-release and
// its plugins), so its job holds no write token and is given none (I1-6):
// semantic-release's own pushes and fetches are pointed at this clone, so
// it neither needs nor asks for one. `release/publish.ts` does the writing.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import semanticRelease, { type Options } from "semantic-release";

/** What `publish` is handed: the release's version, commit and notes. */
export interface ReleasePlan {
  readonly version: string;
  readonly gitHead: string;
  readonly notes: string;
}

/** The release configuration: analysis and notes only, always a dry run. */
export const releaseOptions = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", ".releaserc.json"), "utf8"),
) as Options;

/**
 * The release semantic-release would make of the repository at `cwd`, or
 * `undefined` when there is nothing to release. While it runs, Git's every
 * use of the `origin` address (semantic-release's fetches, and its `git
 * push --dry-run` to check it may push) goes to `cwd` itself instead, so no
 * credential is needed; the address still names the repository in the
 * notes' links. The redirection is in the clone's own Git configuration,
 * since semantic-release does not give every Git command its environment,
 * and is taken out again afterwards.
 */
export async function planRelease({
  cwd,
  env,
}: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<ReleasePlan | undefined> {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const origin = git("remote", "get-url", "origin");
  const redirect = `url.${cwd}`;
  git("config", "--local", `${redirect}.insteadOf`, origin);
  try {
    const result = await semanticRelease(
      { ...releaseOptions, dryRun: true },
      { cwd, env },
    );
    if (result === false) {
      return undefined;
    }
    const { version, gitHead, notes = "" } = result.nextRelease;
    return { version, gitHead, notes };
  } finally {
    git("config", "--local", "--remove-section", redirect);
  }
}

/** `plan` as GitHub Actions step outputs, for `$GITHUB_OUTPUT`. */
export function stepOutputs(plan: ReleasePlan): string {
  const delimiter = `notes_${randomUUID()}`;
  return [
    `version=${plan.version}`,
    `git-head=${plan.gitHead}`,
    `notes<<${delimiter}`,
    plan.notes,
    delimiter,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const plan = await planRelease({ cwd: process.cwd(), env: process.env });
  if (plan === undefined) {
    console.log("Nothing to release.");
  } else {
    console.log(`Planned release ${plan.version} of ${plan.gitHead}.`);
    const output = process.env["GITHUB_OUTPUT"];
    if (output !== undefined) {
      appendFileSync(output, stepOutputs(plan));
    }
  }
}
