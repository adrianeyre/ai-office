// The release scripts behind .github/workflows/release.yml (I1-6):
// release/plan.ts, which runs semantic-release in a job with no write
// token, and release/publish.ts, which writes in a job that runs no
// dependency code. Both run here against throwaway Git repositories, and
// publish against a fake GitHub API.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { planRelease, stepOutputs } from "../release/plan.ts";
import {
  checkRelease,
  maxNotesLength,
  publish,
  releaseMessage,
  withNotes,
  withVersion,
} from "../release/publish.ts";

const root = join(import.meta.dirname, "..");

/** Git with no global or system configuration, as a fresh runner has. */
const gitEnv = {
  PATH: process.env["PATH"] ?? "",
  HOME: tmpdir(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();

const scratch: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close();
  }
  for (const path of scratch.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

/**
 * A repository released once (`v1.0.0`), then given a feature, with a bare
 * `origin` it was pushed to. Returns the clone, the remote and the head.
 */
async function releasedOnce(): Promise<{
  clone: string;
  remote: string;
  head: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "release-"));
  scratch.push(base);
  const remote = join(base, "remote.git");
  const clone = join(base, "clone");
  git(base, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  git(base, "init", "--quiet", "--initial-branch=main", clone);
  await writeFile(
    join(clone, "package.json"),
    '{\n  "name": "x",\n  "version": "1.0.0",\n  "devEngines": { "runtime": { "version": ">=26" } }\n}\n',
  );
  await writeFile(join(clone, "CHANGELOG.md"), "## 1.0.0\n");
  git(clone, "add", ".");
  git(clone, "commit", "--quiet", "--message", "feat: the first release");
  git(clone, "tag", "v1.0.0");
  await writeFile(join(clone, "feature.txt"), "a feature\n");
  git(clone, "add", ".");
  git(clone, "commit", "--quiet", "--message", "feat: a wall clock");
  git(clone, "remote", "add", "origin", remote);
  git(clone, "push", "--quiet", "origin", "main", "v1.0.0");
  return { clone, remote, head: git(clone, "rev-parse", "HEAD") };
}

/** A fake GitHub API that records what it is asked. */
async function fakeGitHub(status = 201): Promise<{
  url: string;
  requests: { url: string; authorization: string; body: unknown }[];
}> {
  const requests: { url: string; authorization: string; body: unknown }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      requests.push({
        url: request.url ?? "",
        authorization: request.headers.authorization ?? "",
        body: JSON.parse(body) as unknown,
      });
      response.writeHead(status).end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, requests };
}

const head = "a".repeat(40);

describe("release/publish.ts checks what it is handed", () => {
  it("accepts a plain version above every tag, for the commit checked out", () => {
    expect(
      checkRelease(
        { version: "1.10.0", gitHead: head, notes: "## 1.10.0\n" },
        { head, tags: ["v1.0.0", "v1.9.3", "not-a-release"] },
      ),
    ).toEqual({ version: "1.10.0", gitHead: head, notes: "## 1.10.0\n" });
  });

  it("refuses anything but a plain version", () => {
    for (const version of [
      undefined,
      "",
      "1.2",
      "v1.2.3",
      "1.2.3-beta.1",
      "01.2.3",
      "1.2.3\nversion=9.9.9",
      "1.2.3 && curl example.invalid",
    ]) {
      expect(
        () => checkRelease({ version, gitHead: head }, { head, tags: [] }),
        String(version),
      ).toThrow("not a plain version");
    }
  });

  it("refuses a version at or below one already tagged, so no tag is ever moved", () => {
    for (const version of ["1.0.0", "0.9.9", "1.0.0"]) {
      expect(() =>
        checkRelease({ version, gitHead: head }, { head, tags: ["v1.0.0"] }),
      ).toThrow("is not above the release already tagged v1.0.0");
    }
  });

  it("refuses a release planned for another commit", () => {
    expect(() =>
      checkRelease(
        { version: "1.1.0", gitHead: "b".repeat(40) },
        { head, tags: [] },
      ),
    ).toThrow("not the commit checked out");
  });

  it("refuses notes that are not plain text of a bounded size", () => {
    for (const notes of ["a\0b", "x".repeat(maxNotesLength + 1)]) {
      expect(() =>
        checkRelease(
          { version: "1.1.0", gitHead: head, notes },
          { head, tags: [] },
        ),
      ).toThrow("not plain text");
    }
  });

  it("sets package.json's own version, never a nested one, keeping its layout", async () => {
    const text = await readFile(join(root, "package.json"), "utf8");
    const updated = withVersion(text, "9.8.7");
    const before = JSON.parse(text) as {
      version: string;
      devEngines: unknown;
    };
    const after = JSON.parse(updated) as typeof before;
    expect(after.version).toBe("9.8.7");
    expect(after.devEngines).toEqual(before.devEngines);
    expect(updated.split("\n")).toHaveLength(text.split("\n").length);
  });

  it("puts the notes on top of the changelog, as semantic-release's changelog did", () => {
    expect(withNotes("## 1.0.0\n", "## 1.1.0\n\n* a\n")).toBe(
      "## 1.1.0\n\n* a\n\n## 1.0.0\n",
    );
    expect(withNotes("", "## 1.0.0\n")).toBe("## 1.0.0\n");
    expect(
      releaseMessage({ version: "1.1.0", gitHead: head, notes: "## 1.1.0" }),
    ).toBe("chore(release): 1.1.0 [skip ci]\n\n## 1.1.0");
  });

  it("imports nothing but Node's own modules, so no dependency code runs beside the token", async () => {
    const source = await readFile(join(root, "release/publish.ts"), "utf8");
    const imports = [
      ...source.matchAll(/^\s*import\b[^;]*?from\s+"([^"]+)"/gm),
      ...source.matchAll(/\bimport\(\s*"([^"]+)"/g),
      ...source.matchAll(/\brequire\(\s*"([^"]+)"/g),
    ].map((match) => match[1] ?? "");
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((name) => !name.startsWith("node:"))).toEqual([]);
  });
});

describe("release/publish.ts, end to end", () => {
  it("commits the version and notes, tags and pushes them together, and creates the release", async () => {
    const { clone, remote, head } = await releasedOnce();
    const github = await fakeGitHub();
    const notes = "## 1.1.0 (2026-10-11)\n\n### Features\n\n* a wall clock\n";
    await publish({
      cwd: clone,
      env: {
        ...gitEnv,
        RELEASE_VERSION: "1.1.0",
        RELEASE_GIT_HEAD: head,
        RELEASE_NOTES: notes,
        GITHUB_TOKEN: "fake-token-for-tests",
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_API_URL: github.url,
      },
    });

    // The remote's main is the release commit, on top of what was planned,
    // and the tag names it.
    const released = git(remote, "rev-parse", "main");
    expect(git(remote, "rev-parse", "v1.1.0^{commit}")).toBe(released);
    expect(git(remote, "rev-parse", `${released}^`)).toBe(head);
    expect(git(remote, "log", "-1", "--format=%B", released)).toBe(
      `chore(release): 1.1.0 [skip ci]\n\n${notes}`.trim(),
    );
    expect(git(remote, "log", "-1", "--format=%an", released)).toBe(
      "github-actions[bot]",
    );
    expect(
      JSON.parse(git(remote, "show", `${released}:package.json`)),
    ).toMatchObject({ version: "1.1.0" });
    expect(git(remote, "show", `${released}:CHANGELOG.md`)).toBe(
      `${notes}\n## 1.0.0`,
    );
    expect(github.requests).toEqual([
      {
        url: "/repos/owner/repo/releases",
        authorization: "Bearer fake-token-for-tests",
        body: { tag_name: "v1.1.0", name: "v1.1.0", body: notes },
      },
    ]);
  });

  it("pushes nothing and creates no release when what it is handed fails its checks", async () => {
    const { clone, remote, head } = await releasedOnce();
    const github = await fakeGitHub();
    await expect(
      publish({
        cwd: clone,
        env: {
          ...gitEnv,
          // A compromised plan trying to re-point the existing tag.
          RELEASE_VERSION: "1.0.0",
          RELEASE_GIT_HEAD: head,
          RELEASE_NOTES: "",
          GITHUB_TOKEN: "fake-token-for-tests",
          GITHUB_REPOSITORY: "owner/repo",
          GITHUB_API_URL: github.url,
        },
      }),
    ).rejects.toThrow("is not above the release already tagged v1.0.0");
    expect(git(remote, "rev-parse", "main")).toBe(head);
    expect(git(remote, "tag", "--list")).toBe("v1.0.0");
    expect(github.requests).toEqual([]);
  });
});

describe("release/plan.ts, end to end", () => {
  it("works out the next version and its notes with no credential, pointing semantic-release's Git at the clone itself", async () => {
    const { clone, head } = await releasedOnce();
    // The address a runner's checkout has, which needs a token to reach:
    // every Git use of it must go to the clone instead.
    git(clone, "remote", "set-url", "origin", "https://github.com/owner/repo");
    const plan = await planRelease({ cwd: clone, env: gitEnv });
    expect(plan?.version).toBe("1.1.0");
    expect(plan?.gitHead).toBe(head);
    expect(plan?.notes).toContain("a wall clock");
    // The links still name the repository on GitHub.
    expect(plan?.notes).toContain(
      "https://github.com/owner/repo/compare/v1.0.0...v1.1.0",
    );
    // Nothing was tagged or committed: it is a dry run. And the clone's
    // Git configuration is as it was.
    expect(git(clone, "tag", "--list")).toBe("v1.0.0");
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(git(clone, "config", "--local", "--list")).not.toContain(
      "insteadof",
    );

    const outputs = stepOutputs(
      plan ?? { version: "", gitHead: "", notes: "" },
    );
    expect(outputs).toMatch(
      /^version=1\.1\.0\ngit-head=[0-9a-f]{40}\nnotes<<(notes_[0-9a-f-]+)\n[\s\S]*\n\1\n$/,
    );
  }, 60_000);

  it("plans nothing when there is nothing to release", async () => {
    const { clone } = await releasedOnce();
    git(clone, "tag", "v1.1.0");
    git(clone, "remote", "set-url", "origin", "https://github.com/owner/repo");
    expect(await planRelease({ cwd: clone, env: gitEnv })).toBeUndefined();
  }, 60_000);
});
