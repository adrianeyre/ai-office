import { delimiter, join } from "node:path";

import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gitGuardDirectory, runGit } from "../git/command.ts";
import { createSandboxFactFinder } from "../grilling/fact-finding.ts";
import { createSandboxRunner } from "./runner.ts";
import { createFakeSandbox } from "./fake-sandbox.ts";
import { guardSandcastleGit } from "./sandcastle-git.ts";

// The `git` Sandcastle runs on the host is AI Office's guarded one (S1-2):
// see `sandcastle-git.pen-test.test.ts` for what it no longer runs.

const unguarded = (process.env["PATH"] ?? "")
  .split(delimiter)
  .filter((directory) => directory !== gitGuardDirectory)
  .join(delimiter);

const path = () => (process.env["PATH"] ?? "").split(delimiter);

beforeEach(() => {
  vi.stubEnv("PATH", unguarded);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const options = async () => {
  const sandbox = await createFakeSandbox();
  return {
    github: createFakeGitHub(),
    events: createEventBus({ store: memoryEventStore() }),
    sandbox: () => sandbox.provider({}),
    gateway: () => Promise.resolve({ url: "http://app:4000", key: "aio_gk_x" }),
    workDir: join("/nonexistent", "work"),
  };
};

describe("guardSandcastleGit", () => {
  it("puts AI Office's `git` first on the PATH, once", () => {
    guardSandcastleGit();
    guardSandcastleGit();

    expect(path()[0]).toBe(gitGuardDirectory);
    expect(path().filter((dir) => dir === gitGuardDirectory)).toHaveLength(1);
    expect(path().slice(1).join(delimiter)).toBe(unguarded);
  });

  it("is installed by the sandbox runner before any Sandcastle run", async () => {
    createSandboxRunner(await options());

    expect(path()[0]).toBe(gitGuardDirectory);
  });

  it("is installed by the fact finder before any Sandcastle run", async () => {
    createSandboxFactFinder(await options());

    expect(path()[0]).toBe(gitGuardDirectory);
  });

  it("is skipped by AI Office's own Git, which runs Git itself", async () => {
    guardSandcastleGit();

    // Git's own environment for its programs has no guard in its PATH.
    const env = await runGit("print the environment", [
      "-c",
      "alias.env=!env",
      "env",
    ]);
    const gitPath = env
      .split("\n")
      .find((line) => line.startsWith("PATH="))
      ?.slice("PATH=".length);
    expect(gitPath?.split(delimiter)).not.toContain(gitGuardDirectory);
  });
});
