import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { skillErrorCodes } from "@ai-office/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runGit } from "../git/command.ts";
import { SkillError } from "./errors.ts";
import { gitSkillRepository, type SkillRepository } from "./git.ts";

// Reading a Skill from a Git repository (PRD FR-72), with real Git against
// repositories on disk. Only these tests let Git use `file://`; AI Office
// itself clones over HTTPS alone.

const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: What ${name} does.\n---\n\nSteps.\n`;

let root: string;
let scratchDir: string;

/** Makes a repository from `files` (a `→ target` value is a link) and commits it. */
async function repository(
  name: string,
  files: Record<string, string | Buffer>,
  branches: Record<string, Record<string, string>> = {},
): Promise<{ url: string; commits: Record<string, string> }> {
  const dir = join(root, name);
  const git = (args: string[]) =>
    runGit("set up the test repository", args, {
      cwd: dir,
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  const write = async (tree: Record<string, string | Buffer>) => {
    for (const [path, content] of Object.entries(tree)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      if (typeof content === "string" && content.startsWith("→ ")) {
        await symlink(content.slice(2), join(dir, path));
      } else {
        await writeFile(join(dir, path), content);
      }
    }
    await git(["add", "--all"]);
    await git(["commit", "--quiet", "--message", "Skills"]);
    return git(["rev-parse", "HEAD"]);
  };
  await mkdir(dir, { recursive: true });
  await git(["init", "--quiet", "--initial-branch", "main"]);
  const commits: Record<string, string> = { main: await write(files) };
  for (const [branch, tree] of Object.entries(branches)) {
    await git(["checkout", "--quiet", "-b", branch]);
    commits[branch] = await write(tree);
    await git(["checkout", "--quiet", "main"]);
  }
  return { url: `file://${dir}`, commits };
}

const refusal = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SkillError);
  const { code, message, problems } = error as SkillError;
  return { code, message, problems };
};

let fromDisk: SkillRepository;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ai-office-skill-repos-"));
  scratchDir = await mkdtemp(join(tmpdir(), "ai-office-skill-scratch-"));
  fromDisk = gitSkillRepository({ scratchDir, protocols: ["file"] });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratchDir, { recursive: true, force: true });
});

describe("gitSkillRepository", () => {
  it("reads a Skill's folder at a branch, every file as text", async () => {
    const { url, commits } = await repository(
      "several",
      {
        "README.md": "# Skills\n",
        "skills/pdf-processing/SKILL.md": skillMd("pdf-processing"),
        "skills/release-notes/SKILL.md": skillMd("release-notes"),
      },
      {
        v2: {
          "skills/pdf-processing/scripts/extract.py": "print('v2')\n",
          "skills/pdf-processing/references/FORMS.md": "# Forms\n",
        },
      },
    );
    expect(
      await fromDisk({ url, ref: "v2", path: "skills/pdf-processing" }),
    ).toEqual({
      files: [
        { path: "SKILL.md", content: skillMd("pdf-processing") },
        { path: "references/FORMS.md", content: "# Forms\n" },
        { path: "scripts/extract.py", content: "print('v2')\n" },
      ],
      folder: "pdf-processing",
      commit: commits["v2"],
      path: "skills/pdf-processing",
    });
    // The default branch, without the v2 files.
    expect(
      (await fromDisk({ url, path: "skills/pdf-processing" })).files,
    ).toEqual([{ path: "SKILL.md", content: skillMd("pdf-processing") }]);
    // Nothing is left behind.
    expect(await readdir(scratchDir)).toEqual([]);
  });

  it("asks which Skill, when a repository holds several", async () => {
    const { url } = await repository("choose", {
      "skills/pdf-processing/SKILL.md": skillMd("pdf-processing"),
      "skills/release-notes/SKILL.md": skillMd("release-notes"),
    });
    expect(await refusal(fromDisk({ url }))).toEqual({
      code: skillErrorCodes.skillPathRequired,
      message:
        "The repository holds several Skills: name the folder of the one to import.",
      problems: ["skills/pdf-processing", "skills/release-notes"],
    });
  });

  it("takes a repository's only Skill, or the one at its top", async () => {
    const only = await repository("only", {
      "README.md": "# One Skill\n",
      "pdf-processing/SKILL.md": skillMd("pdf-processing"),
    });
    expect(await fromDisk({ url: only.url })).toMatchObject({
      folder: "pdf-processing",
      path: "pdf-processing",
    });

    const top = await repository("top", {
      "SKILL.md": skillMd("top-skill"),
      "notes/extra.md": "Extra.\n",
      "nested/other/SKILL.md": skillMd("other"),
    });
    const fetched = await fromDisk({ url: top.url });
    // At the top, the folder is the clone's, so its name is not checked.
    expect(fetched).toEqual({
      files: [
        { path: "SKILL.md", content: skillMd("top-skill") },
        { path: "nested/other/SKILL.md", content: skillMd("other") },
        { path: "notes/extra.md", content: "Extra.\n" },
      ],
      commit: top.commits["main"],
      path: "",
    });
  });

  it("says when there is no Skill to import", async () => {
    const { url } = await repository("none", {
      "README.md": "# Nothing here\n",
      "docs/guide.md": "Guide.\n",
    });
    expect(await refusal(fromDisk({ url }))).toMatchObject({
      code: skillErrorCodes.noSkillInRepository,
      message: "The repository has no SKILL.md.",
    });
    for (const path of ["docs", "missing", "README.md"]) {
      expect(await refusal(fromDisk({ url, path }))).toMatchObject({
        code: skillErrorCodes.noSkillInRepository,
        message: `The repository has no SKILL.md in "${path}".`,
      });
    }
  });

  it("refuses links and binary files rather than reading them", async () => {
    const { url } = await repository("unsafe", {
      "linked/SKILL.md": skillMd("linked"),
      "linked/secrets": "→ /etc/passwd",
      "binary/SKILL.md": skillMd("binary"),
      "binary/logo.png": Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff,
      ]),
      "real/SKILL.md": skillMd("real"),
      "via-link": "→ real",
    });
    expect(await refusal(fromDisk({ url, path: "linked" }))).toMatchObject({
      code: skillErrorCodes.invalidSkill,
      problems: ['"secrets" is a symbolic link; a Skill holds files only.'],
    });
    expect(await refusal(fromDisk({ url, path: "binary" }))).toMatchObject({
      code: skillErrorCodes.invalidSkill,
      problems: ['"logo.png" is not a text file; Skills hold text only.'],
    });
    // A folder reached through a link is not followed.
    expect(await refusal(fromDisk({ url, path: "via-link" }))).toMatchObject({
      code: skillErrorCodes.noSkillInRepository,
    });
  });

  it("refuses a folder holding more than a Skill may", async () => {
    const files: Record<string, string> = {
      "big/SKILL.md": skillMd("big"),
    };
    for (let index = 0; index < 200; index += 1) {
      files[`big/notes/${String(index)}.md`] = "x";
    }
    const { url } = await repository("big", files);
    expect(await refusal(fromDisk({ url, path: "big" }))).toMatchObject({
      code: skillErrorCodes.invalidSkill,
      problems: [
        "A Skill holds at most 200 files and 4 MB; this folder holds more.",
      ],
    });
  });

  it("says why a clone failed, and uses HTTPS alone", async () => {
    const { url } = await repository("https-only", {
      "SKILL.md": skillMd("https-only"),
    });
    const httpsOnly = gitSkillRepository({ scratchDir });
    const refused = await refusal(httpsOnly({ url }));
    expect(refused.code).toBe(skillErrorCodes.importFailed);
    expect(refused.message).toMatch(
      /^The repository could not be cloned\. Git could not clone the repository: /,
    );

    expect((await refusal(fromDisk({ url, ref: "no-such-branch" }))).code).toBe(
      skillErrorCodes.importFailed,
    );
    expect(
      (await refusal(fromDisk({ url: `file://${root}/missing` }))).code,
    ).toBe(skillErrorCodes.importFailed);
    expect(await readdir(scratchDir)).toEqual([]);
  });
});
