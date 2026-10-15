import type { GitHubApp } from "@ai-office/github";
import {
  createRedactor,
  floorErrorCodes,
  maxShownMemoryLength,
  type Redactor,
  type RepositoryMemoryView,
} from "@ai-office/shared";

import { FloorError } from "../floors/errors.ts";
import type { FloorStore } from "../floors/store.ts";
import { readMemoryFile } from "./memory.ts";
import type { MemoryStore } from "./store.ts";

// A Floor's repository memory as its bookshelf shows it (PRD FR-53,
// FR-58): `.agents/MEMORY.md` on the default branch, read through the
// GitHub App and redacted as every Agent reads it, with the proposals
// waiting for the Manager's next curation and the pull request of its
// latest. Only reading: the memory changes through pull requests.

export interface RepositoryMemoryShelf {
  /** The Floor's repository memory; a `FloorError` when there is no such Floor. */
  show(floorId: string): Promise<RepositoryMemoryView>;
}

export interface RepositoryMemoryShelfOptions {
  readonly floors: Pick<FloorStore, "get">;
  readonly store: Pick<MemoryStore, "pending" | "latestCuration">;
  /** Reads the memory; without it, the memory is not shown. */
  readonly github?: GitHubApp;
  /** Removes credentials from the memory, and from why it was not read. */
  readonly redactor?: Redactor;
}

export function createRepositoryMemoryShelf(
  options: RepositoryMemoryShelfOptions,
): RepositoryMemoryShelf {
  const redactor = options.redactor ?? createRedactor();
  return {
    async show(floorId) {
      const floor = await options.floors.get(floorId);
      if (floor === undefined) {
        throw new FloorError(
          floorErrorCodes.floorNotFound,
          `There is no Floor "${floorId}".`,
        );
      }
      let content: string | null = null;
      let readError: string | null = null;
      if (options.github === undefined) {
        readError =
          "The GitHub App is not set up, so the repository's memory cannot be read.";
      } else {
        try {
          content =
            (await readMemoryFile(options.github, floor, redactor)) ?? null;
        } catch (error) {
          readError = redactor.redactText(
            `The repository's memory could not be read from GitHub: ${(error as Error).message}`,
          );
        }
      }
      const [proposals, latest] = await Promise.all([
        options.store.pending(floorId),
        options.store.latestCuration(floorId),
      ]);
      return {
        repository: floor.repository,
        branch: floor.defaultBranch,
        content: content?.slice(0, maxShownMemoryLength) ?? null,
        truncated: (content?.length ?? 0) > maxShownMemoryLength,
        readError,
        proposals: proposals.map(({ id, text, issue, agentId, createdAt }) => ({
          id,
          text,
          issue,
          agentId,
          createdAt: createdAt.toISOString(),
        })),
        pullRequest: latest?.pullRequest ?? null,
      };
    },
  };
}
