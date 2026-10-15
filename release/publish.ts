// Publishes the release `release/plan.ts` planned, for release.yml's
// `publish` job, the one job that holds a write token (`contents: write`):
// it bumps package.json's version (the version the footer shows), adds the
// notes to CHANGELOG.md, commits both with `[skip ci]`, tags the commit
// `v<version>`, pushes the two together and creates the GitHub release.
//
// It imports nothing but Node's own modules, and its job installs nothing,
// so no dependency code runs beside the token (I1-6); test/release.test.ts
// checks both. The plan comes from a job that did run dependency code, so
// nothing in it is trusted: the version must be a plain version above every
// tag, the commit the one checked out, and the notes plain text of a
// bounded size. A tag is never moved and nothing is force-pushed.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A planned release, once checked. */
export interface Release {
  readonly version: string;
  readonly gitHead: string;
  readonly notes: string;
}

/** The most a release's notes may be: GitHub's limit on a release's body. */
export const maxNotesLength = 125_000;

const plainVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The version a `v<version>` tag names, if it is a plain version. */
function versionOfTag(tag: string): number[] | undefined {
  const match = plainVersion.exec(tag.slice(1));
  return tag.startsWith("v") && match !== null
    ? match.slice(1).map(Number)
    : undefined;
}

function isAbove(
  version: readonly number[],
  other: readonly number[],
): boolean {
  for (const [index, part] of version.entries()) {
    const otherPart = other[index] ?? 0;
    if (part !== otherPart) {
      return part > otherPart;
    }
  }
  return false;
}

/**
 * `planned`, checked against the clone it is to be published from (its
 * `head` commit and its `tags`), or an error saying what is wrong with it.
 */
export function checkRelease(
  planned: {
    readonly version?: string | undefined;
    readonly gitHead?: string | undefined;
    readonly notes?: string | undefined;
  },
  clone: { readonly head: string; readonly tags: readonly string[] },
): Release {
  const { version = "", gitHead = "", notes = "" } = planned;
  const parts = plainVersion.exec(version)?.slice(1).map(Number);
  if (parts === undefined) {
    throw new Error(
      `The planned version is not a plain version: ${JSON.stringify(version.slice(0, 40))}.`,
    );
  }
  if (gitHead !== clone.head) {
    throw new Error(
      `The release was planned for ${JSON.stringify(gitHead.slice(0, 40))}, not the commit checked out (${clone.head}).`,
    );
  }
  for (const tag of clone.tags) {
    const released = versionOfTag(tag);
    if (released !== undefined && !isAbove(parts, released)) {
      throw new Error(
        `The planned version ${version} is not above the release already tagged ${tag}.`,
      );
    }
  }
  if (notes.length > maxNotesLength || notes.includes("\0")) {
    throw new Error(
      `The release notes are not plain text of at most ${String(maxNotesLength)} characters.`,
    );
  }
  return { version, gitHead, notes };
}

/** `packageJson`'s text with its own `version` (not a nested one) set. */
export function withVersion(packageJson: string, version: string): string {
  const { version: current } = JSON.parse(packageJson) as { version: string };
  const field = `"version": ${JSON.stringify(current)}`;
  const updated = packageJson.replace(
    field,
    `"version": ${JSON.stringify(version)}`,
  );
  const { version: written } = JSON.parse(updated) as { version: string };
  if (written !== version) {
    throw new Error("package.json's version could not be set.");
  }
  return updated;
}

/** `changelog` with `notes` on top, as semantic-release's changelog writes it. */
export function withNotes(changelog: string, notes: string): string {
  const current = changelog.trim();
  return `${notes.trim()}\n${current === "" ? "" : `\n${current}\n`}`;
}

/** The release commit's message. */
export function releaseMessage({ version, notes }: Release): string {
  return `chore(release): ${version} [skip ci]\n\n${notes}`;
}

/** Who the release commit is by: the Actions bot, as GitHub shows it. */
const releaser = {
  name: "github-actions[bot]",
  email: "41898282+github-actions[bot]@users.noreply.github.com",
};

/**
 * Publishes the release `env` names (`RELEASE_VERSION`, `RELEASE_GIT_HEAD`,
 * `RELEASE_NOTES`) from the clone at `cwd` to its `origin`, with the token
 * in `GITHUB_TOKEN`, for the repository `GITHUB_REPOSITORY` at
 * `GITHUB_SERVER_URL` and `GITHUB_API_URL`.
 */
export async function publish({
  cwd,
  env,
  branch = "main",
}: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly branch?: string;
}): Promise<Release> {
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") {
      throw new Error(`${name} is not set.`);
    }
    return value;
  };
  const token = required("GITHUB_TOKEN");
  const repository = required("GITHUB_REPOSITORY");
  const serverUrl = env["GITHUB_SERVER_URL"] ?? "https://github.com";
  const apiUrl = env["GITHUB_API_URL"] ?? "https://api.github.com";
  const git = (
    args: readonly string[],
    extraEnv: Readonly<Record<string, string>> = {},
  ): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: releaser.name,
        GIT_AUTHOR_EMAIL: releaser.email,
        GIT_COMMITTER_NAME: releaser.name,
        GIT_COMMITTER_EMAIL: releaser.email,
        ...extraEnv,
      },
    }).trim();

  const release = checkRelease(
    {
      version: env["RELEASE_VERSION"],
      gitHead: env["RELEASE_GIT_HEAD"],
      notes: env["RELEASE_NOTES"],
    },
    {
      head: git(["rev-parse", "HEAD"]),
      tags: git(["tag", "--list"]).split("\n").filter(Boolean),
    },
  );
  const tag = `v${release.version}`;

  const packagePath = join(cwd, "package.json");
  writeFileSync(
    packagePath,
    withVersion(readFileSync(packagePath, "utf8"), release.version),
  );
  const changelogPath = join(cwd, "CHANGELOG.md");
  writeFileSync(
    changelogPath,
    withNotes(readFileSync(changelogPath, "utf8"), release.notes),
  );
  git(["add", "package.json", "CHANGELOG.md"]);
  git(["commit", "--no-verify", "--message", releaseMessage(release)]);
  git(["tag", tag]);
  // Both or neither; the token goes to git in its environment, never on its
  // command line.
  git(
    [
      "push",
      "--atomic",
      "origin",
      `HEAD:refs/heads/${branch}`,
      `refs/tags/${tag}`,
    ],
    {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${serverUrl}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    },
  );

  const response = await fetch(`${apiUrl}/repos/${repository}/releases`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ tag_name: tag, name: tag, body: release.notes }),
  });
  if (!response.ok) {
    throw new Error(
      `The ${tag} tag is pushed, but GitHub answered ${String(response.status)} to creating its release.`,
    );
  }
  return release;
}

if (import.meta.main) {
  try {
    const { version } = await publish({ cwd: process.cwd(), env: process.env });
    console.log(`Published release ${version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
