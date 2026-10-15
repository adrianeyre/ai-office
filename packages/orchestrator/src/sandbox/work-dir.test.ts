import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeWorkDir, WorkDirError } from "./work-dir.ts";

// The sandboxes' work directory (pen-testing I2-4, I2-5): made, or taken
// only as this user's own directory, never through a symbolic link, and
// private to this user.

const made: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A directory standing in for the system's temporary directory. */
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "work-dir-"));
  made.push(dir);
  return dir;
};

describe("makeWorkDir", () => {
  it("makes the directory, and any missing above it, private to this user", async () => {
    const base = await scratch();
    const path = join(base, "ai-office-sandboxes", "runs");
    await makeWorkDir(path);
    expect((await lstat(path)).isDirectory()).toBe(true);
    for (const made of [path, join(base, "ai-office-sandboxes")]) {
      expect((await lstat(made)).mode & 0o777).toBe(0o700);
    }
  });

  it("makes this user's own directory private if it was not, as one made before was", async () => {
    const path = join(await scratch(), "ai-office-sandboxes");
    await mkdir(path, { mode: 0o755 });
    await chmod(path, 0o755);
    await makeWorkDir(path);
    expect((await lstat(path)).mode & 0o777).toBe(0o700);
  });

  it("takes this user's own directory as it is, its contents kept", async () => {
    const path = join(await scratch(), "ai-office-sandboxes");
    await mkdir(path);
    await writeFile(join(path, "a-clone"), "kept");
    await makeWorkDir(path);
    expect(await readdir(path)).toEqual(["a-clone"]);
  });

  it("refuses a symbolic link, even to a directory of this user's, and makes nothing through it", async () => {
    const base = await scratch();
    const elsewhere = join(base, "elsewhere");
    await mkdir(elsewhere);
    const path = join(base, "ai-office-sandboxes");
    await symlink(elsewhere, path);
    await expect(makeWorkDir(path)).rejects.toThrow(WorkDirError);
    await expect(makeWorkDir(path)).rejects.toThrow(/symbolic link/);
    expect(await readdir(elsewhere)).toEqual([]);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  it("refuses a link to nowhere", async () => {
    const base = await scratch();
    const path = join(base, "ai-office-sandboxes");
    await symlink(join(base, "nowhere"), path);
    await expect(makeWorkDir(path)).rejects.toThrow(/symbolic link/);
    expect(await readdir(base)).toEqual(["ai-office-sandboxes"]);
  });

  it("refuses something that is not a directory", async () => {
    const path = join(await scratch(), "ai-office-sandboxes");
    await writeFile(path, "");
    await expect(makeWorkDir(path)).rejects.toThrow(/not a directory/);
  });

  it("refuses a directory another user made", async () => {
    const path = join(await scratch(), "ai-office-sandboxes");
    await mkdir(path);
    const owner = (await lstat(path)).uid;
    // As if AI Office ran as another user than the one who made it.
    vi.spyOn(process, "getuid").mockReturnValue(owner + 1);
    await expect(makeWorkDir(path)).rejects.toThrow(
      new RegExp(`belongs to UID ${String(owner)}`),
    );
  });
});
