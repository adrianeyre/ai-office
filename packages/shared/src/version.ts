import { z } from "zod";

// The version check: whether the AI Office running is the latest. The
// latest version is the one in the root package.json on the repository's
// `main`, which the release workflow sets with each release and tags
// `v<version>` (release/publish.ts).

/**
 * AI Office's repository on GitHub, as `owner/name`: where its source,
 * issues and releases are, and whose `main` says which version is latest.
 * The one place it is named.
 */
export const releaseRepository = "adrianeyre/ai-office";

/** The repository on GitHub. */
export const repositoryUrl = `https://github.com/${releaseRepository}`;

/** The root package.json on `main`, whose `version` is the latest. */
export const latestPackageUrl = `https://raw.githubusercontent.com/${releaseRepository}/main/package.json`;

/** The repository's releases on GitHub. */
export const releasesUrl = `${repositoryUrl}/releases`;

/** The changelog on `main`, as each release adds to it. */
export const changelogUrl = `${repositoryUrl}/blob/main/CHANGELOG.md`;

/** The longest version taken as one: `1.2.3-rc.1` is ten characters. */
export const maxVersionLength = 64;

/**
 * A version as the release workflow writes it in package.json: semantic
 * versioning's `1.2.3`, with an optional pre-release (`-rc.1`) and build
 * (`+build.5`), and nothing else, so no other text an answer carries is
 * kept, shown or linked to.
 */
const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Whether `value` is a version number, such as `1.2.3` or `1.2.3-rc.1`. */
export function isVersion(value: string): boolean {
  return value.length <= maxVersionLength && versionPattern.test(value);
}

/**
 * `version`'s release page on GitHub (each release is tagged `v<version>`),
 * or the releases page when `version` is not a version number.
 */
export function releasePageOf(version: string): string {
  const number = version.trim().replace(/^v/, "");
  return isVersion(number)
    ? `${releasesUrl}/tag/v${encodeURIComponent(number)}`
    : releasesUrl;
}

/**
 * The body of `GET /api/version/latest`, and what the server takes from
 * GitHub's answer: anything but a version number is refused, never kept.
 */
export const latestVersionSchema = z.object({
  /** The latest version, such as `1.2.3`. */
  version: z.string().refine(isVersion, { error: "Not a version number." }),
});

export type LatestVersion = z.infer<typeof latestVersionSchema>;

/** Error codes `GET /api/version/latest` answers with. */
export const versionErrorCodes = {
  /** GitHub could not be reached, or did not say which version is latest. */
  versionCheckFailed: "version_check_failed",
} as const;

/** A version's numbers, and its pre-release, if it has one. */
function parts(version: string): { numbers: number[]; pre: string | null } {
  // Build metadata (`+…`) plays no part in which is newer.
  const [withoutBuild = ""] = version.trim().replace(/^v/, "").split("+", 1);
  const [core = "", ...pre] = withoutBuild.split("-");
  return {
    numbers: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
    pre: pre.length === 0 ? null : pre.join("-"),
  };
}

/**
 * `a` against `b`, both such as `1.2.3` or `1.2.3-rc.1`: negative if `a`
 * is older, positive if newer, 0 if the same. A pre-release is older than
 * its release.
 */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let at = 0; at < Math.max(x.numbers.length, y.numbers.length); at += 1) {
    const difference = (x.numbers[at] ?? 0) - (y.numbers[at] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  if (x.pre === y.pre) {
    return 0;
  }
  if (x.pre === null) {
    return 1;
  }
  if (y.pre === null) {
    return -1;
  }
  return x.pre < y.pre ? -1 : 1;
}
