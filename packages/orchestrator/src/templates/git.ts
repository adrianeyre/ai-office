import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";

import {
  floorTemplateErrorCodes,
  floorTemplateManifestFileName,
  maxFloorTemplateBytes,
  maxFloorTemplateFiles,
  type FloorTemplateFile,
  type ImportFloorTemplateFromGitRequest,
} from "@ai-office/shared";

import {
  findFoldersHolding,
  isMissing,
  linkOnTheWay,
  maxListed,
  readTextFolder,
  withShallowClone,
  type GitSkillRepositoryOptions,
} from "../skills/git.ts";
import { FloorTemplateLibraryError } from "./errors.ts";

// Importing a Floor Template from a Git repository (PRD FR-101): the
// template's folder, as a built-in one is under `templates/`. The
// repository is someone else's, so it is cloned as a Skill's is (over
// HTTPS alone, no hooks, no LFS filters, no submodules, into a scratch
// directory deleted afterwards), and only regular text files are read
// from the folder; a symbolic link is refused rather than followed.

/** A template's folder read from a repository, not yet checked or stored. */
export interface FetchedTemplate {
  readonly files: readonly FloorTemplateFile[];
  /** Its folder's name, which its id is made from; absent at the top. */
  readonly folder?: string;
  /** The commit the files were read at. */
  readonly commit: string;
  /** Its folder in the repository; "" for the top. */
  readonly path: string;
}

/** Reads one template's folder from a Git repository. */
export type TemplateRepository = (
  request: ImportFloorTemplateFromGitRequest,
  signal?: AbortSignal,
) => Promise<FetchedTemplate>;

const notFound = (path: string): FloorTemplateLibraryError =>
  new FloorTemplateLibraryError(
    floorTemplateErrorCodes.noTemplateInRepository,
    path === ""
      ? `The repository has no ${floorTemplateManifestFileName}.`
      : `The repository has no ${floorTemplateManifestFileName} in "${path}".`,
  );

const invalid = (problems: string[]): FloorTemplateLibraryError =>
  new FloorTemplateLibraryError(
    floorTemplateErrorCodes.invalidTemplate,
    "The repository's Floor Template cannot be imported.",
    problems,
  );

/** Reads Floor Templates from public Git repositories over HTTPS. */
export function gitTemplateRepository(
  options: GitSkillRepositoryOptions,
): TemplateRepository {
  return (request, signal) =>
    withShallowClone(
      request,
      options,
      signal,
      async (clone, commit) => {
        let path = request.path;
        if (path === undefined) {
          const found = await findFoldersHolding(
            clone,
            floorTemplateManifestFileName,
          );
          if (found.length === 0) {
            throw notFound("");
          }
          // A template at the top is the repository's template.
          if (found.length > 1 && found[0] !== "") {
            throw new FloorTemplateLibraryError(
              floorTemplateErrorCodes.templatePathRequired,
              "The repository holds several Floor Templates: name the folder of the one to import.",
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
          const [manifest, folderStats] = await Promise.all([
            lstat(join(folder, floorTemplateManifestFileName)),
            lstat(folder),
          ]);
          if (!manifest.isFile() || !folderStats.isDirectory()) {
            throw notFound(path);
          }
        } catch (error) {
          throw isMissing(error) ? notFound(path) : error;
        }
        const link = await linkOnTheWay(clone, path);
        if (link !== undefined) {
          throw invalid([
            `"${link}" is a symbolic link; a Floor Template holds files only.`,
          ]);
        }

        return {
          files: await readTextFolder(folder, {
            maxFiles: maxFloorTemplateFiles,
            maxBytes: maxFloorTemplateBytes,
            holder: "a Floor Template",
            holders: "Floor Templates",
            invalid,
          }),
          ...(path === "" ? {} : { folder: posix.basename(path) }),
          commit,
          path,
        };
      },
      (message, cause) =>
        new FloorTemplateLibraryError(
          floorTemplateErrorCodes.importFailed,
          message,
          undefined,
          { cause },
        ),
    );
}
