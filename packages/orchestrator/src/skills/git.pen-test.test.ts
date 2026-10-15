import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import {
  allowInternalHosts,
  importFloorTemplateFromGitRequestSchema,
  importSkillRequestSchema,
  skillRepositoryUrlSchema,
} from "@ai-office/shared";
import { afterEach, describe, expect, it } from "vitest";

import { FloorTemplateLibraryError } from "../templates/errors.ts";
import { gitTemplateRepository } from "../templates/git.ts";
import { gitSkillRepository } from "./git.ts";
import { SkillError } from "./errors.ts";

// I1 probe (pen-testing, "Infrastructure and delivery"): Skill and Floor
// Template import as Owner-triggered fetches to an internal address (H13).
// The Owner (or a hostile imported Template that names another repository)
// gives the URL, so the positions are 4 and 2. See
// docs/pen-testing/assessments/I1.md.
//
// Both import paths share `withShallowClone` and `skillRepositoryUrlSchema`.
// The schema limits the clone to https and bars credentials, a query and a
// fragment — but not the host. A clone of an internal https git server
// (there is no address block) is attempted, and the outcome is an oracle:
// the clone's error, which names what git saw, is returned to the Owner, so
// a reachable host, a refused port and a name that does not resolve are told
// apart. Nothing in the repository runs (hooks off, no submodules, no LFS):
// this is reconnaissance of the stack's network, not code execution.
//
// Fixed (I1-3, ADR 0007): the same host policy as I1-1. The schema refuses
// an internal host the Owner did not allow in ALLOWED_INTERNAL_HOSTS, and
// so does the clone itself, before Git runs: a live port and a closed one
// fail alike, and neither is asked anything. Git is pinned to the address
// checked and follows no redirect.

const servers: Server[] = [];
let scratch: string | undefined;

afterEach(async () => {
  allowInternalHosts([]);
  asked.length = 0;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  if (scratch !== undefined) {
    await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

/** Every request an `internalService` was asked. */
const asked: string[] = [];

/** A plain HTTP server standing in for an internal service (not a git server). */
async function internalService(): Promise<string> {
  const server = createServer((request, response) => {
    asked.push(request.url ?? "");
    request.resume();
    response
      .writeHead(200, { "content-type": "text/html" })
      .end("<html>internal</html>");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

/** Hosts an import should arguably never be allowed to clone from. */
const internalHosts = [
  "https://127.0.0.1/repo.git",
  "https://169.254.169.254/repo.git",
  "https://localhost:3047/repo.git",
  "https://[::1]/repo.git",
  "https://10.0.0.5/repo.git",
  "https://app:3047/repo.git",
  "https://postgres/repo.git",
];

describe("I1-3 (H13): Skill and Template import may name an internal host", () => {
  it("regression (I1-3): the import URL schema no longer accepts loopback, the metadata service, private addresses or bare internal names over https", () => {
    for (const url of internalHosts) {
      const skill = skillRepositoryUrlSchema.safeParse(url);
      expect(skill.success, url).toBe(false);
      expect(skill.error?.issues[0]?.message, url).toContain(
        "ALLOWED_INTERNAL_HOSTS",
      );
      expect(
        importFloorTemplateFromGitRequestSchema.safeParse({ url }).success,
        url,
      ).toBe(false);
    }
    expect(
      skillRepositoryUrlSchema.safeParse("https://github.com/owner/skills")
        .success,
    ).toBe(true);
  });

  it("regression (I1-3): a clone no longer reaches the host, so its failure is no oracle — a live internal port fails as a closed one does", async () => {
    scratch = await mkdtemp(join(tmpdir(), "i1-import-"));
    // The harness permits http so a plain server can stand in for an
    // internal https git host; the same refusal holds over https.
    const repository = gitSkillRepository({
      scratchDir: scratch,
      protocols: ["http"],
      timeoutMs: 5000,
    });

    const live = await internalService();
    const liveError = await repository({ url: `${live}/repo.git` }).catch(
      (error: unknown) => error,
    );
    const closedError = await repository({
      url: `${live.replace(/:\d+/, ":1")}/repo.git`,
    }).catch((error: unknown) => error);

    // Both are refused, by the same words, before Git runs.
    expect(closedError).toBeInstanceOf(SkillError);
    expect((closedError as SkillError).message).toBe(
      "The repository is on an internal address (127.0.0.1), which AI Office reaches only if ALLOWED_INTERNAL_HOSTS names it.",
    );
    expect(liveError).toBeInstanceOf(SkillError);
    expect((liveError as SkillError).message).toEqual(
      (closedError as SkillError).message,
    );
    expect(asked).toEqual([]);
  });

  it("Skill and Template import cannot be aimed at a loopback, link-local or private address", () => {
    const refused = internalHosts.filter(
      (url) => !skillRepositoryUrlSchema.safeParse(url).success,
    );
    // The property: every internal host is refused.
    expect(refused).toEqual(internalHosts);
  });
});

describe("I1-3 siblings: the Floor Template clone, and a host the Owner allowed", () => {
  it("a Floor Template's clone refuses an internal host as a Skill's does, before Git runs", async () => {
    scratch = await mkdtemp(join(tmpdir(), "i1-import-"));
    const live = await internalService();
    const error = await gitTemplateRepository({
      scratchDir: scratch,
      protocols: ["http"],
      timeoutMs: 5000,
    })({ url: `${live}/templates.git` }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FloorTemplateLibraryError);
    expect((error as Error).message).toContain("internal address (127.0.0.1)");
    expect(asked).toEqual([]);
  });

  it("a host the Owner allowed is accepted by both schemas and cloned from", async () => {
    allowInternalHosts(["git.lan", "127.0.0.1"]);
    expect(
      importSkillRequestSchema.safeParse({ url: "https://git.lan/skills.git" })
        .success,
    ).toBe(true);
    expect(
      importFloorTemplateFromGitRequestSchema.safeParse({
        url: "https://git.lan/templates.git",
      }).success,
    ).toBe(true);

    scratch = await mkdtemp(join(tmpdir(), "i1-import-"));
    const live = await internalService();
    await gitSkillRepository({
      scratchDir: scratch,
      protocols: ["http"],
      timeoutMs: 5000,
    })({ url: `${live}/repo.git` }).catch(() => undefined);
    // Git reached it (and failed, as it is no Git server).
    expect(asked.length).toBeGreaterThan(0);
  });
});
