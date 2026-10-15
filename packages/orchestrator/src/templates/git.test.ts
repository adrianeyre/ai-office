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

import { createEventBus, memoryEventStore } from "@ai-office/events";
import { floorTemplateErrorCodes, type FloorTemplate } from "@ai-office/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runGit } from "../git/command.ts";
import { memoryStores } from "../stores.ts";
import { FloorTemplateLibraryError } from "./errors.ts";
import { floorTemplateFiles } from "./files.ts";
import { gitTemplateRepository, type TemplateRepository } from "./git.ts";
import { createFloorTemplateLibrary } from "./library.ts";
import { loadFloorTemplates } from "./load.ts";
import {
  cornerShopFiles,
  cornerShopNeighbours,
  templateFolder,
} from "./testing.ts";

// Importing a Floor Template from a Git repository (PRD FR-101), with real
// Git against repositories on disk. Only these tests let Git use `file://`;
// AI Office itself clones over HTTPS alone.

let root: string;
let scratchDir: string;
let fromDisk: TemplateRepository;
let builtIn: readonly FloorTemplate[];

/** Corner shop's files, in the folder `folder` of a repository. */
const cornerShopIn = (folder: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(cornerShopFiles).map(([path, content]) => [
      `${folder}${folder === "" ? "" : "/"}${path.slice("corner-shop/".length)}`,
      content,
    ]),
  );

/** Makes a repository from `files` (a `→ target` value is a link) and commits it. */
async function repository(
  name: string,
  files: Record<string, string>,
): Promise<{ url: string; commit: string }> {
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
  await mkdir(dir, { recursive: true });
  await git(["init", "--quiet", "--initial-branch", "main"]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    if (content.startsWith("→ ")) {
      await symlink(content.slice(2), join(dir, path));
    } else {
      await writeFile(join(dir, path), content);
    }
  }
  await git(["add", "--all"]);
  await git(["commit", "--quiet", "--message", "Templates"]);
  return { url: `file://${dir}`, commit: await git(["rev-parse", "HEAD"]) };
}

const refusal = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(FloorTemplateLibraryError);
  const { code, message, problems } = error as FloorTemplateLibraryError;
  return { code, message, problems };
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ai-office-template-repos-"));
  scratchDir = await mkdtemp(join(tmpdir(), "ai-office-template-scratch-"));
  fromDisk = gitTemplateRepository({ scratchDir, protocols: ["file"] });
  const folder = await templateFolder({ only: cornerShopNeighbours });
  try {
    builtIn = await loadFloorTemplates(folder.root);
  } finally {
    await folder.remove();
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(scratchDir, { recursive: true, force: true });
});

describe("importing a Floor Template from Git", () => {
  it("reads a template's folder, which waits for review with where it came from", async () => {
    const { url, commit } = await repository("shop", {
      "README.md": "# Our templates\n",
      ...cornerShopIn("templates/corner-shop"),
    });
    const fetched = await fromDisk({ url, path: "templates/corner-shop" });
    expect(fetched).toMatchObject({
      folder: "corner-shop",
      commit,
      path: "templates/corner-shop",
    });
    expect(fetched.files.map(({ path }) => path).sort()).toEqual([
      "roles/brand-reviewer.md",
      "roles/copywriter.md",
      "roles/merchandiser.md",
      "skills/price-check/SKILL.md",
      "template.yaml",
    ]);
    // Nothing is left behind.
    expect(await readdir(scratchDir)).toEqual([]);

    const stores = memoryStores();
    const library = createFloorTemplateLibrary({
      builtIn,
      store: stores.floorTemplates,
      roles: stores.roles,
      skills: stores.skills,
      events: createEventBus({ store: memoryEventStore() }),
      repository: fromDisk,
    });
    // Its folder's name is the template's id.
    const imported = await library.importFromGit({ url });
    expect(imported).toMatchObject({
      source: "git",
      origin: { url, ref: null, commit, path: "templates/corner-shop" },
      enabled: false,
      reviewedAt: null,
    });
    expect(imported.template.id).toBe("corner-shop");
    expect(imported.template.name).toBe("Corner shop");
    // Read through the same checks as a built-in template.
    expect(floorTemplateFiles(imported.template).length).toBe(5);
    expect((await library.enabled()).map(({ id }) => id)).toEqual([
      "development",
      "blank",
    ]);
  });

  it("asks which template, when a repository holds several", async () => {
    const { url } = await repository("several", {
      ...cornerShopIn("templates/corner-shop"),
      ...cornerShopIn("templates/market-stall"),
    });
    expect(await refusal(fromDisk({ url }))).toEqual({
      code: floorTemplateErrorCodes.templatePathRequired,
      message:
        "The repository holds several Floor Templates: name the folder of the one to import.",
      problems: ["templates/corner-shop", "templates/market-stall"],
    });
    // One at the top is the repository's template.
    const top = await repository("top", {
      ...cornerShopIn(""),
      ...cornerShopIn("examples/other"),
    });
    expect((await fromDisk({ url: top.url })).path).toBe("");
  });

  it("refuses a repository with no template there, and a link out of it", async () => {
    const { url } = await repository("none", { "README.md": "# None\n" });
    expect(await refusal(fromDisk({ url }))).toEqual({
      code: floorTemplateErrorCodes.noTemplateInRepository,
      message: "The repository has no template.yaml.",
      problems: undefined,
    });
    expect(await refusal(fromDisk({ url, path: "templates/shop" }))).toEqual({
      code: floorTemplateErrorCodes.noTemplateInRepository,
      message: 'The repository has no template.yaml in "templates/shop".',
      problems: undefined,
    });
    const linked = await repository("linked", {
      ...cornerShopIn(""),
      "roles/secret.md": "→ /etc/passwd",
    });
    expect(await refusal(fromDisk({ url: linked.url }))).toEqual({
      code: floorTemplateErrorCodes.invalidTemplate,
      message: "The repository's Floor Template cannot be imported.",
      problems: [
        '"roles/secret.md" is a symbolic link; a Floor Template holds files only.',
      ],
    });
    expect(
      await refusal(fromDisk({ url: "file:///nowhere/at/all" })),
    ).toMatchObject({ code: floorTemplateErrorCodes.importFailed });
  });

  it("refuses a folder that is not a valid template, naming the file at fault", async () => {
    const { url } = await repository("broken", {
      ...cornerShopIn(""),
      "notes.txt": "Not part of it.\n",
    });
    const stores = memoryStores();
    const library = createFloorTemplateLibrary({
      builtIn,
      store: stores.floorTemplates,
      roles: stores.roles,
      skills: stores.skills,
      events: createEventBus({ store: memoryEventStore() }),
      repository: fromDisk,
    });
    expect(await refusal(library.importFromGit({ url }))).toEqual({
      code: floorTemplateErrorCodes.invalidTemplate,
      message: "That is not a valid Floor Template.",
      problems: [
        "notes.txt: Not part of a Floor Template: a template holds template.yaml, roles/<role>.md and skills/<skill>/SKILL.md.",
      ],
    });
    expect(await library.list()).toHaveLength(2);
  });
});
