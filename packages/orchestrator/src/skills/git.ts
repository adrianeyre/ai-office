import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, posix } from "node:path";

import {
  maxSkillBytes,
  maxSkillFiles,
  skillErrorCodes,
  skillFileName,
  skillFilesInOrder,
  type ImportSkillRequest,
  type SkillFile,
} from "@ai-office/shared";
import {
  InternalHostError,
  checkOwnerUrl,
} from "@ai-office/shared/internal-hosts-guard";

import { runGit } from "../git/command.ts";
import { SkillError } from "./errors.ts";

// Importing a Skill from a Git repository (PRD FR-72). The repository is
// someone else's, so nothing in it runs: it is cloned shallowly over HTTPS
// alone (submodules included), with no hooks, no LFS filters and no
// system or global Git config, into a scratch directory that is deleted
// afterwards. Only regular text files are read from the Skill's folder; a
// symbolic link is refused rather than followed. Its host may not be, or
// resolve to, an internal address the Owner did not allow (ADR 0007,
// I1-3): Git is pinned to the address checked and follows no redirect, so
// a clone cannot probe the stack's own network.

/** A Skill read from a repository, not yet checked or stored. */
export interface FetchedSkill {
  readonly files: readonly SkillFile[];
  /** Its folder's name, which its own name must match; absent at the top. */
  readonly folder?: string;
  /** The commit the files were read at. */
  readonly commit: string;
  /** Its folder in the repository; "" for the top. */
  readonly path: string;
}

/** Reads one Skill from a Git repository. */
export type SkillRepository = (
  request: ImportSkillRequest,
  signal?: AbortSignal,
) => Promise<FetchedSkill>;

export interface GitSkillRepositoryOptions {
  /** Where to clone; each clone is deleted once read. */
  readonly scratchDir: string;
  /**
   * The protocols Git may use, for the clone and anything it is sent to:
   * `https` alone, unless a test serves a repository from disk (`file`).
   */
  readonly protocols?: readonly string[];
  /** How long a clone may take: a minute by default. */
  readonly timeoutMs?: number;
}

/** How deep in a repository to look for Skills. */
const maxSearchDepth = 6;
/** At most this many Skills are named when the Owner must choose one. */
export const maxListed = 20;

const notFound = (path: string): SkillError =>
  new SkillError(
    skillErrorCodes.noSkillInRepository,
    path === ""
      ? `The repository has no ${skillFileName}.`
      : `The repository has no ${skillFileName} in "${path}".`,
  );

const invalid = (problems: string[]): SkillError =>
  new SkillError(
    skillErrorCodes.invalidSkill,
    "The repository's Skill cannot be imported.",
    problems,
  );

export const isMissing = (error: unknown): boolean =>
  (error as { code?: unknown }).code === "ENOENT" ||
  (error as { code?: unknown }).code === "ENOTDIR";

/** The folders (relative, `/`-separated) that hold a file `fileName`. */
export async function findFoldersHolding(
  root: string,
  fileName: string,
): Promise<string[]> {
  const found: string[] = [];
  const visit = async (relative: string, depth: number): Promise<void> => {
    const entries = await readdir(join(root, relative), {
      withFileTypes: true,
    });
    if (entries.some((entry) => entry.isFile() && entry.name === fileName)) {
      found.push(relative);
    }
    if (depth >= maxSearchDepth) {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && entry.name !== ".git") {
        await visit(posix.join(relative, entry.name), depth + 1);
      }
    }
  };
  await visit("", 0);
  return found.map((folder) => (folder === "." ? "" : folder));
}

/** How a folder read from a repository is limited, and what it is called. */
export interface TextFolderLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  /** What holds the files, as in "a Skill holds files only". */
  readonly holder: string;
  /** What hold text, as in "Skills hold text only". */
  readonly holders: string;
  /** The error for what is wrong with the folder, one line each. */
  readonly invalid: (problems: string[]) => Error;
}

/** Every file in `folder`, as text, within the limits; links are refused. */
export async function readTextFolder(
  folder: string,
  limits: TextFolderLimits,
): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  const problems: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  const visit = async (relative: string): Promise<void> => {
    const entries = await readdir(join(folder, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.name === ".git") {
        continue;
      }
      // `lstat`, so a link is seen as a link and never followed.
      const stats = await lstat(join(folder, path));
      if (stats.isDirectory()) {
        await visit(path);
      } else if (!stats.isFile()) {
        problems.push(
          `"${path}" is ${stats.isSymbolicLink() ? "a symbolic link" : "not a file"}; ${limits.holder} holds files only.`,
        );
      } else {
        bytes += stats.size;
        if (files.length >= limits.maxFiles || bytes > limits.maxBytes) {
          throw limits.invalid([
            `${limits.holder.charAt(0).toUpperCase()}${limits.holder.slice(1)} holds at most ${String(limits.maxFiles)} files and ${String(limits.maxBytes / 1_000_000)} MB; this folder holds more.`,
          ]);
        }
        try {
          files.push({
            path,
            content: decoder.decode(await readFile(join(folder, path))),
          });
        } catch {
          problems.push(
            `"${path}" is not a text file; ${limits.holders} hold text only.`,
          );
        }
      }
    }
  };
  await visit("");
  if (problems.length > 0) {
    throw limits.invalid(problems);
  }
  return files;
}

/** What `withShallowClone` asks of a repository, and how it fails. */
export interface CloneRequest {
  readonly url: string;
  /** The branch or tag; the default branch when absent. */
  readonly ref?: string | undefined;
}

/**
 * The Git config that holds a clone of `url` to the address AI Office
 * checked: none for a local repository (a test's), no redirects, and the
 * host pinned to the address it resolved to. Throws `InternalHostError`
 * for an internal host the Owner did not allow.
 */
async function pinnedTo(url: string): Promise<string[]> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return [];
  }
  const address = await checkOwnerUrl(url, { what: "The repository" });
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return [
    "-c",
    "http.followRedirects=false",
    ...(address === undefined || address === host
      ? []
      : [
          "-c",
          `http.curloptResolve=${host}:${port}:${address.includes(":") ? `[${address}]` : address}`,
        ]),
  ];
}

/**
 * Clones `request`'s repository shallowly into a scratch directory, runs
 * `read` on the clone at the commit it read, then deletes it. Nothing in
 * the repository runs: only the allowed protocols, no hooks, no LFS
 * filters and no submodules. Nor does it reach an internal host the Owner
 * did not allow (`pinnedTo`). A clone that fails, takes too long or is
 * refused is `cloneFailed`'s error.
 */
export async function withShallowClone<Result>(
  request: CloneRequest,
  options: GitSkillRepositoryOptions,
  signal: AbortSignal | undefined,
  read: (clone: string, commit: string) => Promise<Result>,
  cloneFailed: (message: string, cause: unknown) => Error,
): Promise<Result> {
  const protocols = options.protocols ?? ["https"];
  const timeoutMs = options.timeoutMs ?? 60_000;
  const scratch = await mkdtemp(join(options.scratchDir, "git-import-"));
  const clone = join(scratch, "repository");
  const signals = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(signal === undefined ? [] : [signal]),
  ]);
  try {
    let pinned: string[];
    try {
      pinned = await pinnedTo(request.url);
    } catch (error) {
      throw error instanceof InternalHostError
        ? cloneFailed(error.message, error)
        : error;
    }
    try {
      await runGit(
        "clone the repository",
        [
          "-c",
          "core.hooksPath=/dev/null",
          ...pinned,
          "clone",
          "--quiet",
          "--depth",
          "1",
          "--no-tags",
          "--single-branch",
          "--no-recurse-submodules",
          ...(request.ref === undefined ? [] : ["--branch", request.ref]),
          "--",
          request.url,
          clone,
        ],
        {
          env: {
            GIT_ALLOW_PROTOCOL: protocols.join(":"),
            GIT_LFS_SKIP_SMUDGE: "1",
          },
          signal: signals,
        },
      );
    } catch (error) {
      throw cloneFailed(
        signals.aborted
          ? "The repository took too long to clone."
          : `The repository could not be cloned. ${(error as Error).message}`,
        error,
      );
    }
    const commit = await runGit("read the commit", ["rev-parse", "HEAD"], {
      cwd: clone,
    });
    return await read(clone, commit);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The first folder on the way from the clone's top to `path` that is a
 * symbolic link, if any: a folder that was checked to stay inside the
 * clone could still be a link out of it.
 */
export async function linkOnTheWay(
  clone: string,
  path: string,
): Promise<string | undefined> {
  for (
    let partial = path;
    partial !== "" && partial !== ".";
    partial = posix.dirname(partial)
  ) {
    if ((await lstat(join(clone, partial))).isSymbolicLink()) {
      return partial;
    }
  }
  return undefined;
}

const skillLimits: TextFolderLimits = {
  maxFiles: maxSkillFiles,
  maxBytes: maxSkillBytes,
  holder: "a Skill",
  holders: "Skills",
  invalid,
};

/** Reads Skills from public Git repositories over HTTPS. */
export function gitSkillRepository(
  options: GitSkillRepositoryOptions,
): SkillRepository {
  return (request, signal) =>
    withShallowClone(
      request,
      options,
      signal,
      async (clone, commit) => {
        let path = request.path;
        if (path === undefined) {
          const found = await findFoldersHolding(clone, skillFileName);
          if (found.length === 0) {
            throw notFound("");
          }
          // A Skill at the top is the repository's Skill.
          if (found.length > 1 && found[0] !== "") {
            throw new SkillError(
              skillErrorCodes.skillPathRequired,
              "The repository holds several Skills: name the folder of the one to import.",
              found
                .slice(0, maxListed)
                .concat(
                  found.length > maxListed
                    ? [`…and ${String(found.length - maxListed)} more`]
                    : [],
                ),
            );
          }
          path = found[0] ?? "";
        }

        const folder = join(clone, path);
        try {
          const [skillMd, folderStats] = await Promise.all([
            lstat(join(folder, skillFileName)),
            lstat(folder),
          ]);
          if (!skillMd.isFile() || !folderStats.isDirectory()) {
            throw notFound(path);
          }
        } catch (error) {
          throw isMissing(error) ? notFound(path) : error;
        }
        const link = await linkOnTheWay(clone, path);
        if (link !== undefined) {
          throw invalid([
            `"${link}" is a symbolic link; a Skill holds files only.`,
          ]);
        }

        const name = posix.basename(path);
        return {
          files: skillFilesInOrder(await readTextFolder(folder, skillLimits)),
          ...(path === "" ? {} : { folder: name }),
          commit,
          path,
        };
      },
      (message, cause) =>
        new SkillError(skillErrorCodes.importFailed, message, undefined, {
          cause,
        }),
    );
}
