import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { memoryMount, writeMemory } from "./memory.ts";
import { dockerSandbox } from "./runner.ts";
import { skillMounts } from "./skills.ts";

// Office-wide and Role memory in sandboxes (PRD FR-54, FR-55): mounted
// read-only at the same place for every agent tool. Docker is not run
// here: its provider is replaced, to see the mounts the sandbox is
// started with.

const dockerOptions = vi.hoisted(() => [] as unknown[]);
vi.mock("./docker.ts", () => ({
  dockerProvider: (options: unknown) => {
    dockerOptions.push(options);
    return { tag: "bind-mount", name: "docker" };
  },
}));

describe("the memory mount", () => {
  it("is given to Docker read-only, beside the Skills, for every agent tool", () => {
    dockerOptions.length = 0;
    const sandbox = dockerSandbox();
    for (const tool of ["Claude Code", "Codex", "opencode"] as const) {
      sandbox({ GH_TOKEN: "read-only" }, tool, [
        ...skillMounts("/srv/skills", tool),
        memoryMount("/srv/memory"),
      ]);
    }
    expect(
      dockerOptions.map(
        (options) => (options as { mounts: unknown[] }).mounts[1],
      ),
    ).toEqual([
      {
        hostPath: "/srv/memory",
        sandboxPath: "/home/agent/.ai-office/memory",
        readonly: true,
      },
      {
        hostPath: "/srv/memory",
        sandboxPath: "/home/agent/.ai-office/memory",
        readonly: true,
      },
      {
        hostPath: "/srv/memory",
        sandboxPath: "/home/agent/.ai-office/memory",
        readonly: true,
      },
    ]);
  });

  it("writes each file read-only, and never over one already there", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-office-memory-"));
    try {
      const into = join(root, "sbx-1-memory");
      await writeMemory(into, [
        { name: "OFFICE.md", content: "- Use pnpm.\n" },
        { name: "ROLE.md", content: "- Test first.\n" },
      ]);
      expect(await readFile(join(into, "OFFICE.md"), "utf8")).toBe(
        "- Use pnpm.\n",
      );
      for (const file of ["OFFICE.md", "ROLE.md"]) {
        expect((await stat(join(into, file))).mode & 0o222).toBe(0);
      }
      // Root writes whatever the mode says; in the sandbox the mount is
      // read-only regardless.
      if (process.getuid?.() !== 0) {
        await expect(
          writeFile(join(into, "OFFICE.md"), "- Use npm.\n"),
        ).rejects.toThrow(/EACCES|EPERM/);
      }
      await expect(
        writeMemory(into, [{ name: "OFFICE.md", content: "- Use npm.\n" }]),
      ).rejects.toThrow(/EEXIST/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
