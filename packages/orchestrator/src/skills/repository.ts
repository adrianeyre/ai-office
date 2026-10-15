import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RepositoryClient } from "@ai-office/github";
import {
  describeSkill,
  maxSkillBytes,
  maxSkillFiles,
  repositorySkillFolders,
  skillFileName,
  skillFileSchema,
  skillProblems,
  type IgnoredSkill,
  type SkillFile,
} from "@ai-office/shared";

// A Floor repository's own Skills (PRD FR-72): one folder each under
// `.agents/skills/` and `.claude/skills/`, in the Agent Skills format.
// They are read from a clone on disk, for a sandbox, or from GitHub, for
// the Floor admin. Either way the same rules apply: a folder must hold a
// valid Skill named as the folder is, and a Skill in both places is taken
// from `.agents/skills/`. Anything else is left out, saying why.
//
// A repository is not AI Office's own, so a clone is read warily: nothing
// behind a symbolic link is followed (it could point anywhere on the
// host), and reading stops at the format's size limits.

/** A Skill found in a Floor's repository. */
export interface RepositorySkill {
  readonly name: string;
  readonly description: string;
  /** Its folder from the repository's top, such as `.claude/skills/pdf`. */
  readonly folder: string;
  /** Its files; from GitHub, only its `SKILL.md`. */
  readonly files: readonly SkillFile[];
}

export interface RepositorySkills {
  /** By name. */
  readonly skills: readonly RepositorySkill[];
  /** Folders that hold no usable Skill, with why. */
  readonly ignored: readonly IgnoredSkill[];
}

/** An entry in one of the repository's folders. */
export interface FolderEntry {
  readonly name: string;
  readonly type: "file" | "dir" | "symlink" | "other";
}

/** How Skills are read from a repository. */
export interface SkillFolderReader {
  /** What a folder holds; undefined when there is no such folder. */
  list(path: string): Promise<readonly FolderEntry[] | undefined>;
  /** A Skill folder's files, or why they cannot be read. */
  read(
    folder: string,
  ): Promise<{ files: SkillFile[] } | { problems: string[] }>;
}

const byName = <T extends { readonly name: string }>(a: T, b: T): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Every Skill in a repository's Skill folders, as `reader` reads them. */
export async function discoverRepositorySkills(
  reader: SkillFolderReader,
): Promise<RepositorySkills> {
  const skills = new Map<string, RepositorySkill>();
  const ignored: IgnoredSkill[] = [];
  for (const base of repositorySkillFolders) {
    const entries = (await reader.list(base)) ?? [];
    for (const entry of [...entries].sort(byName)) {
      const folder = `${base}/${entry.name}`;
      if (entry.type === "symlink") {
        ignored.push({
          folder,
          problems: ["It is a symbolic link, which AI Office does not follow."],
        });
        continue;
      }
      if (entry.type !== "dir") {
        // A README beside the Skills, say.
        continue;
      }
      const read = await reader.read(folder);
      const problems =
        "problems" in read
          ? read.problems
          : skillProblems(read.files, { folder: entry.name });
      if ("problems" in read || problems.length > 0) {
        ignored.push({ folder, problems });
        continue;
      }
      const { name, description } = describeSkill(read.files);
      const earlier = skills.get(name);
      if (earlier !== undefined) {
        ignored.push({
          folder,
          problems: [
            `"${earlier.folder}" holds a Skill of this name, so it is used instead.`,
          ],
        });
        continue;
      }
      skills.set(name, { name, description, folder, files: read.files });
    }
  }
  return { skills: [...skills.values()].sort(byName), ignored };
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Reads Skills from a clone at `root`. A folder on the way to the Skills
 * that is a symbolic link counts as no folder; within a Skill, a symbolic
 * link, a file that is not UTF-8 text, or too many files or bytes, makes
 * the whole Skill unusable.
 */
export function fileSystemSkillReader(root: string): SkillFolderReader {
  /** Whether every part of `path` below `root` is a real folder. */
  const isFolder = async (path: string): Promise<boolean> => {
    let at = root;
    for (const part of path.split("/")) {
      at = join(at, part);
      try {
        if (!(await lstat(at)).isDirectory()) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  };

  return {
    async list(path) {
      if (!(await isFolder(path))) {
        return undefined;
      }
      const entries = await readdir(join(root, path), { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.isSymbolicLink()
          ? "symlink"
          : entry.isDirectory()
            ? "dir"
            : entry.isFile()
              ? "file"
              : "other",
      }));
    },

    async read(folder) {
      if (!(await isFolder(folder))) {
        return { problems: ["It is not a folder."] };
      }
      const files: SkillFile[] = [];
      let bytes = 0;
      const walk = async (relative: string): Promise<string | undefined> => {
        const entries = await readdir(join(root, folder, relative), {
          withFileTypes: true,
        });
        for (const entry of entries.sort(byName)) {
          const path =
            relative === "" ? entry.name : `${relative}/${entry.name}`;
          if (entry.isSymbolicLink()) {
            return `"${path}" is a symbolic link, which AI Office does not follow.`;
          }
          if (entry.isDirectory()) {
            const problem = await walk(path);
            if (problem !== undefined) {
              return problem;
            }
            continue;
          }
          if (!entry.isFile()) {
            return `"${path}" is not a file or a folder.`;
          }
          if (files.length >= maxSkillFiles) {
            return `A Skill holds at most ${String(maxSkillFiles)} files.`;
          }
          const absolute = join(root, folder, path);
          bytes += (await lstat(absolute)).size;
          if (bytes > maxSkillBytes) {
            return `A Skill's files come to at most ${String(maxSkillBytes / 1_000_000)} MB.`;
          }
          let content: string;
          try {
            content = decoder.decode(await readFile(absolute));
          } catch {
            return `"${path}" is not text.`;
          }
          const file = skillFileSchema.safeParse({ path, content });
          if (!file.success) {
            return file.error.issues[0]?.message ?? `"${path}" cannot be read.`;
          }
          files.push(file.data);
        }
        return undefined;
      };
      const problem = await walk("");
      return problem === undefined ? { files } : { problems: [problem] };
    },
  };
}

/**
 * Reads Skills from a repository on GitHub at `ref`: each folder's
 * `SKILL.md` only, which is all a list of them needs.
 */
export function gitHubSkillReader(
  repository: Pick<RepositoryClient, "listDirectory" | "getFileContent">,
  ref: string,
): SkillFolderReader {
  return {
    async list(path) {
      const entries = await repository.listDirectory(path, ref);
      return entries?.map(({ name, type }) => ({
        name,
        type: type === "submodule" ? "other" : type,
      }));
    },
    async read(folder) {
      const content = await repository.getFileContent(
        `${folder}/${skillFileName}`,
        ref,
      );
      return content === undefined
        ? {
            problems: [
              `A Skill has a ${skillFileName} at the top of its folder.`,
            ],
          }
        : { files: [{ path: skillFileName, content }] };
    },
  };
}

/**
 * One Skill's whole folder from a repository on GitHub at `ref`: its
 * `SKILL.md` and every supporting file, for the Owner to read (FR-73). It
 * is read as warily as a clone: a symbolic link, a submodule, a file that
 * is not text, or more files or bytes than a Skill may hold, and it cannot
 * be read.
 */
export async function readGitHubSkillFolder(
  repository: Pick<RepositoryClient, "listDirectory" | "getFileContent">,
  ref: string,
  folder: string,
): Promise<{ files: SkillFile[] } | { problems: string[] }> {
  const files: SkillFile[] = [];
  let bytes = 0;
  const walk = async (relative: string): Promise<string | undefined> => {
    const at = relative === "" ? folder : `${folder}/${relative}`;
    const entries = await repository.listDirectory(at, ref);
    if (entries === undefined) {
      return relative === "" ? "It is not a folder." : `"${relative}" is gone.`;
    }
    for (const entry of [...entries].sort(byName)) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.type === "symlink") {
        return `"${path}" is a symbolic link, which AI Office does not follow.`;
      }
      if (entry.type === "submodule") {
        return `"${path}" is not a file or a folder.`;
      }
      if (entry.type === "dir") {
        const problem = await walk(path);
        if (problem !== undefined) {
          return problem;
        }
        continue;
      }
      if (files.length >= maxSkillFiles) {
        return `A Skill holds at most ${String(maxSkillFiles)} files.`;
      }
      const content = await repository.getFileContent(`${folder}/${path}`, ref);
      if (content === undefined) {
        return `"${path}" cannot be read.`;
      }
      bytes += Buffer.byteLength(content);
      if (bytes > maxSkillBytes) {
        return `A Skill's files come to at most ${String(maxSkillBytes / 1_000_000)} MB.`;
      }
      const file = skillFileSchema.safeParse({ path, content });
      if (!file.success) {
        return file.error.issues[0]?.message ?? `"${path}" cannot be read.`;
      }
      files.push(file.data);
    }
    return undefined;
  };
  const problem = await walk("");
  return problem === undefined ? { files } : { problems: [problem] };
}
