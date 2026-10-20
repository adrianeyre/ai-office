// `pnpm dev` (docker/dev.ts and docker-compose.dev.yml): every workspace
// package's node_modules is a volume of the development stack, and the
// stack runs as the user running it.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { devEnvironment, workspaceNodeModules } from "./dev.ts";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFile(join(root, path), "utf8");

/** Every workspace package's directory, as pnpm-workspace.yaml lists them. */
const workspacePackages = async (): Promise<string[]> => {
  const { packages } = parse(await read("pnpm-workspace.yaml")) as {
    packages: string[];
  };
  const found = await Promise.all(
    packages.map(async (pattern) => {
      if (!pattern.endsWith("/*")) {
        return [pattern];
      }
      const parent = pattern.slice(0, -2);
      const entries = await readdir(join(root, parent), {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`);
    }),
  );
  return found.flat();
};

describe("pnpm dev's node_modules volumes", () => {
  it("cover the root and every workspace package", async () => {
    const expected = [
      "node_modules",
      ...(await workspacePackages()).map((path) => `${path}/node_modules`),
    ];
    expect([...workspaceNodeModules].sort()).toEqual(expected.sort());
  });

  it("are each mounted by docker-compose.dev.yml and made writable by the dev image", async () => {
    const compose = await read("docker-compose.dev.yml");
    const dockerfile = await read("docker/dev/Dockerfile");
    for (const path of workspaceNodeModules) {
      expect(compose, path).toMatch(
        new RegExp(`- node-modules[\\w-]*:/app/${path}\\n`),
      );
      expect(dockerfile, path).toContain(`/app/${path}`);
    }
  });
});

describe("pnpm dev's environment for compose", () => {
  const user = { uid: 1017, gid: 1019 };

  it("runs the stack as the user running it, with the Docker socket's group and a sandbox directory in their home", () => {
    expect(devEnvironment({}, user, 999, "/home/someone")).toEqual({
      AI_OFFICE_DEV_UID: "1017",
      AI_OFFICE_DEV_GID: "1019",
      AI_OFFICE_DEV_DOCKER_GID: "999",
      AI_OFFICE_DEV_SANDBOX_DIR: "/home/someone/.ai-office/dev-sandboxes",
    });
  });

  it("never runs it as root, and takes group 0 where the socket is not found", () => {
    expect(devEnvironment({}, { uid: 0, gid: 0 }, undefined, "/root")).toEqual(
      expect.objectContaining({
        AI_OFFICE_DEV_UID: "1000",
        AI_OFFICE_DEV_GID: "1000",
        AI_OFFICE_DEV_DOCKER_GID: "0",
      }),
    );
  });

  it("keeps values already set, and treats .env's empty ones as unset", () => {
    expect(
      devEnvironment(
        { AI_OFFICE_DEV_SANDBOX_DIR: "/srv/clones", AI_OFFICE_DEV_UID: "" },
        user,
        999,
        "/home/someone",
      ),
    ).toEqual(
      expect.objectContaining({
        AI_OFFICE_DEV_UID: "1017",
        AI_OFFICE_DEV_SANDBOX_DIR: "/srv/clones",
      }),
    );
  });
});
