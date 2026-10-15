import type { GitHubApp } from "@ai-office/github";
import {
  floorErrorCodes,
  maxMentionedFileBytes,
  maxMentionSuggestions,
} from "@ai-office/shared";

import { FloorError } from "../floors/errors.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";

// The repository's files in the Manager chat (PRD FR-24, ADR 0004), as
// Claude Code offers them: typing `@` offers the paths that match, read
// from the repository's tree at its default branch through the GitHub App
// (reads only), kept a minute per Floor; and a message that mentions
// `@path` gives the Manager each file's text at the default branch with
// the Owner's turn. A missing file is noted, never an error.

/** A file a message mentioned, as the Manager is given it. */
export interface MentionedFile {
  readonly path: string;
  /** Its text, at most `maxMentionedFileBytes`; undefined if there is none. */
  readonly content: string | undefined;
  /** Whether its text was cut short at `maxMentionedFileBytes`. */
  readonly truncated: boolean;
  /** The branch it was read at. */
  readonly ref: string;
}

export interface ChatRepositoryFiles {
  /**
   * The Floor's repository paths matching `query` (case-insensitive, in
   * the path), best first, at most `maxMentionSuggestions`.
   */
  search(floorId: string, query: string): Promise<string[]>;
  /** Each mentioned file's text at the Floor's default branch, in order. */
  read(
    floor: Pick<FloorRecord, "id" | "repository" | "defaultBranch">,
    paths: readonly string[],
  ): Promise<MentionedFile[]>;
}

export interface ChatRepositoryFilesOptions {
  readonly floors: Pick<FloorStore, "get">;
  readonly github: Pick<GitHubApp, "repository">;
  readonly now?: () => Date;
  /** How long a Floor's paths are kept; a minute by default. */
  readonly cacheMs?: number;
}

/**
 * How well `path` matches `query` (lower case): lower is better, and
 * undefined is no match. A file named the query comes first, then one
 * whose name starts with it, has it, a path that starts with it, then any
 * path that has it.
 */
function rankOf(path: string, query: string): number | undefined {
  const lower = path.toLowerCase();
  if (!lower.includes(query)) {
    return undefined;
  }
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  if (name === query || stem === query) {
    return 0;
  }
  if (name.startsWith(query)) {
    return 1;
  }
  if (name.includes(query)) {
    return 2;
  }
  return lower.startsWith(query) ? 3 : 4;
}

/** The paths matching `query`, best first, then the shorter, then by name. */
export function matchingPaths(
  paths: readonly string[],
  query: string,
  limit = maxMentionSuggestions,
): string[] {
  const wanted = query.trim().replace(/^@/, "").toLowerCase();
  const ranked: { path: string; rank: number }[] = [];
  for (const path of paths) {
    const rank = rankOf(path, wanted);
    if (rank !== undefined) {
      ranked.push({ path, rank });
    }
  }
  return ranked
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.path.split("/").length - b.path.split("/").length ||
        a.path.length - b.path.length ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
    .slice(0, limit)
    .map(({ path }) => path);
}

/** Whether `path` is one a mention may read: inside the repository. */
const readable = (path: string): boolean =>
  path !== "" &&
  !path.startsWith("/") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** `text` cut to at most `bytes` of UTF-8, at a whole character. */
function cutTo(
  text: string,
  bytes: number,
): { text: string; truncated: boolean } {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= bytes) {
    return { text, truncated: false };
  }
  // A cut through a character drops what is left of it.
  return {
    text: encoded.subarray(0, bytes).toString("utf8").replace(/�$/, ""),
    truncated: true,
  };
}

export function createChatRepositoryFiles(
  options: ChatRepositoryFilesOptions,
): ChatRepositoryFiles {
  const now = options.now ?? (() => new Date());
  const cacheMs = options.cacheMs ?? 60_000;
  /** Each Floor's paths, by its repository and default branch. */
  const cache = new Map<
    string,
    { key: string; at: number; paths: Promise<string[]> }
  >();

  const pathsOf = (floor: FloorRecord): Promise<string[]> => {
    const key = `${floor.repository}@${floor.defaultBranch}`;
    const at = now().getTime();
    const cached = cache.get(floor.id);
    if (cached?.key === key && at - cached.at < cacheMs) {
      return cached.paths;
    }
    const paths = options.github
      .repository(floor.repository)
      .listFiles(floor.defaultBranch);
    cache.set(floor.id, { key, at, paths });
    // A failure is not kept: the next search asks again.
    paths.catch(() => {
      if (cache.get(floor.id)?.paths === paths) {
        cache.delete(floor.id);
      }
    });
    return paths;
  };

  return {
    async search(floorId, query) {
      const floor = await options.floors.get(floorId);
      if (floor === undefined) {
        throw new FloorError(
          floorErrorCodes.floorNotFound,
          `There is no Floor "${floorId}".`,
        );
      }
      return matchingPaths(await pathsOf(floor), query);
    },

    async read(floor, paths) {
      const repository = options.github.repository(floor.repository);
      const ref = floor.defaultBranch;
      return Promise.all(
        paths.map(async (path): Promise<MentionedFile> => {
          if (!readable(path)) {
            return { path, content: undefined, truncated: false, ref };
          }
          try {
            const text = await repository.getFileContent(path, ref);
            if (text === undefined) {
              return { path, content: undefined, truncated: false, ref };
            }
            const cut = cutTo(text, maxMentionedFileBytes);
            return { path, content: cut.text, truncated: cut.truncated, ref };
          } catch {
            return { path, content: undefined, truncated: false, ref };
          }
        }),
      );
    },
  };
}
