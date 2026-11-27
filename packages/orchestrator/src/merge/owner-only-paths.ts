import { posix } from "node:path";

import type { PullRequestFile } from "@ai-office/github";
import type { FloorSettings } from "@ai-office/shared";

// Owner-only Paths and the changed-lines limit (Scorecards PRD, FR-122 to
// FR-125): what the Owner, not AI Office, chose for a Floor to keep from
// being merged automatically, beside the rules in `owner-only.ts`. Both
// are plain rules on the paths a pull request changes and how many lines
// it changes: no model or heuristic scores the diff. No label or
// per-issue setting loosens them (FR-124): the gate asks them of every
// pull request on a Floor that merges automatically.
//
// - **Owner-only Paths** are globs from the top of the repository, read
//   as a Guideline's `fileMatchPattern` is (`*`, `**`, `?`, `[…]` and
//   `{a,b}`, by Node's `path.matchesGlob`), but whatever their case, as
//   the built-in rules are: on a case-insensitive file system
//   `SRC/Auth/x.ts` is `src/auth/x.ts`. A renamed file's old path counts
//   too, so moving a file out of `src/auth/` is held back as well.
// - **Changed lines** are lines added plus lines removed, as GitHub counts
//   them, leaving out well-known lockfiles and the files the repository's
//   `.gitattributes` marks `linguist-generated`, as GitHub does when it
//   collapses them in a diff. The `.gitattributes` is read from the base
//   branch, so a pull request cannot mark its own files generated.

/** The Owner-only rules of a Floor (FR-122). */
export type OwnerOnlyRules = Pick<
  FloorSettings,
  "ownerOnlyPaths" | "changedLinesLimit"
>;

/** A path as Git names it, from the top of the repository, in lower case. */
const normalised = (path: string): string =>
  path
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "")
    .toLowerCase();

/**
 * Whether a repository path matches an Owner-only Path's glob, whatever
 * their case. A glob Node cannot read matches nothing.
 */
export function matchesOwnerOnlyPath(pattern: string, path: string): boolean {
  const glob = normalised(pattern);
  const file = normalised(path);
  if (glob === "" || file === "") {
    return false;
  }
  try {
    return posix.matchesGlob(file, glob);
  } catch {
    return false;
  }
}

/** Every path a pull request's files change: a renamed one's old path too. */
const pathsOf = (files: readonly PullRequestFile[]): string[] =>
  files.flatMap(({ path, previousPath }) =>
    previousPath === undefined ? [path] : [path, previousPath],
  );

/** The first changed path an Owner-only Path matches, and that glob. */
export function ownerOnlyPathChanged(
  files: readonly PullRequestFile[],
  patterns: readonly string[],
):
  | { readonly path: string; readonly pattern: string; readonly more: number }
  | undefined {
  const matched = pathsOf(files).flatMap((path) => {
    const pattern = patterns.find((glob) => matchesOwnerOnlyPath(glob, path));
    return pattern === undefined ? [] : [{ path, pattern }];
  });
  const [first] = matched;
  return first === undefined
    ? undefined
    : {
        ...first,
        more: new Set(matched.map(({ path }) => path)).size - 1,
      };
}

/**
 * Lockfiles, by name in lower case, wherever they are: written by a
 * package manager, not by hand, so their lines are not counted.
 */
export const lockfiles: ReadonlySet<string> = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "pdm.lock",
  "uv.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "go.work.sum",
  "podfile.lock",
  "package.resolved",
  "packages.lock.json",
  "paket.lock",
  "mix.lock",
  "pubspec.lock",
  "flake.lock",
  "gradle.lockfile",
  "conan.lock",
  "cartfile.resolved",
]);

/** Whether `path` is a well-known lockfile. */
export const isLockfile = (path: string): boolean =>
  lockfiles.has(path.toLowerCase().split("/").at(-1) ?? "");

/** One line of `.gitattributes` that says whether files are generated. */
interface GeneratedRule {
  readonly pattern: string;
  readonly generated: boolean;
}

/**
 * The `linguist-generated` rules of a `.gitattributes` file, in order:
 * `linguist-generated` and `linguist-generated=true` mark files generated,
 * `-linguist-generated`, `!linguist-generated` and `=false` unmark them.
 */
export function generatedRules(gitattributes: string): GeneratedRule[] {
  return gitattributes.split(/\r?\n/).flatMap((line) => {
    const [pattern, ...attributes] = line.trim().split(/\s+/);
    if (pattern === undefined || pattern === "" || pattern.startsWith("#")) {
      return [];
    }
    const said = attributes.flatMap((attribute): boolean[] => {
      if (
        attribute === "linguist-generated" ||
        attribute === "linguist-generated=true"
      ) {
        return [true];
      }
      if (
        attribute === "-linguist-generated" ||
        attribute === "!linguist-generated" ||
        attribute === "linguist-generated=false"
      ) {
        return [false];
      }
      return [];
    });
    const generated = said.at(-1);
    return generated === undefined ? [] : [{ pattern, generated }];
  });
}

/**
 * Whether a `.gitattributes` pattern matches `path`, as Git reads one at
 * the top of the repository: one without a slash matches a file's name at
 * any depth, one with a slash the path from the top, and one ending in a
 * slash only folders (so here, the files in them).
 */
const matchesAttributePattern = (pattern: string, path: string): boolean => {
  const file = normalised(path);
  let glob = pattern.trim().toLowerCase();
  const folder = glob.endsWith("/");
  glob = glob.replace(/\/+$/, "");
  const anchored = glob.includes("/");
  glob = glob.replace(/^\/+/, "");
  if (glob === "") {
    return false;
  }
  const full = anchored ? glob : `**/${glob}`;
  try {
    return folder
      ? posix.matchesGlob(file, `${full}/**`)
      : posix.matchesGlob(file, full) || posix.matchesGlob(file, `${full}/**`);
  } catch {
    return false;
  }
};

/** Whether the rules mark `path` generated: the last that matches says. */
export const markedGenerated = (
  rules: readonly GeneratedRule[],
  path: string,
): boolean =>
  rules.findLast(({ pattern }) => matchesAttributePattern(pattern, path))
    ?.generated ?? false;

/** Lines a patch adds and removes, for a file GitHub gave no counts for. */
const patchLines = (patch: string | null): number =>
  patch === null
    ? 0
    : patch
        .split("\n")
        .filter(
          (line) =>
            (line.startsWith("+") && !line.startsWith("+++")) ||
            (line.startsWith("-") && !line.startsWith("---")),
        ).length;

/**
 * The lines a pull request changes (FR-123): lines added plus lines
 * removed, leaving out lockfiles and the files `generated` says are.
 */
export function changedLines(
  files: readonly PullRequestFile[],
  generated: (path: string) => boolean = () => false,
): number {
  return files
    .filter(({ path }) => !isLockfile(path) && !generated(path))
    .reduce(
      (sum, file) =>
        sum +
        (file.additions === undefined && file.deletions === undefined
          ? patchLines(file.patch)
          : (file.additions ?? 0) + (file.deletions ?? 0)),
      0,
    );
}

const count = (value: number): string => value.toLocaleString("en-GB");

/**
 * Why a Floor's own rules send a pull request to the Owner (FR-123,
 * FR-125), each as a phrase for the Notice: "it changes
 * `src/auth/session.ts`, an Owner-only Path (`src/auth/**`)", or "it
 * changes 812 lines, over the Floor's limit of 500". Empty when neither
 * holds it back. `generated` says which files `.gitattributes` marks
 * generated; it is asked only when the Floor has a limit.
 */
export function heldBackByFloor(
  files: readonly PullRequestFile[],
  rules: OwnerOnlyRules,
  generated: (path: string) => boolean = () => false,
): string[] {
  const reasons: string[] = [];
  const changed = ownerOnlyPathChanged(files, rules.ownerOnlyPaths);
  if (changed !== undefined) {
    const others =
      changed.more === 0
        ? ""
        : ` and ${count(changed.more)} more ${changed.more === 1 ? "file" : "files"}`;
    reasons.push(
      `it changes \`${changed.path}\`${others}, an Owner-only Path (\`${changed.pattern}\`)`,
    );
  }
  if (rules.changedLinesLimit !== null) {
    const lines = changedLines(files, generated);
    if (lines > rules.changedLinesLimit) {
      reasons.push(
        `it changes ${count(lines)} lines, over the Floor's limit of ${count(rules.changedLinesLimit)}`,
      );
    }
  }
  return reasons;
}
