import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createEventBus,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { readOnlyPermissions } from "@ai-office/github";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import { maxGrillingFactLength } from "@ai-office/shared";
import { toolCallRules } from "../decision-model/tool-call-rules.ts";
import { createToolCallScreens } from "../sandbox/tool-call-screens.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bash,
  createFakeSandbox,
  result,
  say,
  type FakeAgent,
  type FakeSandbox,
  serveToolCallScreens,
} from "../sandbox/fake-sandbox.ts";
import {
  createSandboxFactFinder,
  readFact,
  type FactRequest,
  type SandboxFactFinderOptions,
} from "./fact-finding.ts";

// Fact-finding in a Grilling Session (PRD FR-79) with real Sandcastle, a
// fake sandbox provider (the host stands in for Docker), a local bare
// repository standing in for GitHub's Git remote and the fake GitHub for
// its API.

const git = promisify(execFile);
const repository = "adrianeyre/web-shop";
const gatewayKey = "aio_gk_mosownkeyforfindingfacts0000000000000000";
const ownersKey = "sk-ant-api03-the-owners-real-key-0123456789";

/** Runs Git in `cwd` as a test helper, not as AI Office. */
const gitIn = async (cwd: string, ...args: string[]) =>
  (
    await git(
      "git",
      ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", ...args],
      { cwd },
    )
  ).stdout.trim();

interface Setup {
  readonly root: string;
  readonly remote: string;
  readonly github: FakeGitHub;
  readonly bus: EventBus;
  readonly sandbox: FakeSandbox;
  readonly finder: ReturnType<typeof createSandboxFactFinder>;
  readonly request: FactRequest;
  readonly events: () => Promise<OfficeEvent[]>;
}

let setup: Setup;

async function setUp(
  agent: FakeAgent,
  options: Partial<SandboxFactFinderOptions> = {},
): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "ai-office-facts-"));
  const remote = join(root, "web-shop.git");
  const seed = join(root, "seed");
  await git("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await git("git", ["init", "--quiet", "-b", "main", seed]);
  await mkdir(join(seed, "docs"));
  await writeFile(
    join(seed, "docs", "stack.md"),
    "# Stack\n\nOrders are kept in Postgres 18, in the `orders` table.\n",
  );
  // A repository naming host secrets for Sandcastle to pass through.
  await mkdir(join(seed, ".sandcastle"));
  await writeFile(
    join(seed, ".sandcastle", ".env"),
    "DATABASE_URL=\nSESSION_SECRET=\nANTHROPIC_API_KEY=\n",
  );
  await gitIn(seed, "add", "-A");
  await gitIn(seed, "commit", "--quiet", "-m", "chore: start");
  await gitIn(seed, "push", "--quiet", remote, "main");

  const github = createFakeGitHub();
  github.installRepository(repository);
  const bus = createEventBus({ store: memoryEventStore() });
  const sandbox = await createFakeSandbox(agent);
  const finder = createSandboxFactFinder({
    github,
    events: bus,
    sandbox: (environment) => sandbox.provider(environment),
    gateway: () => Promise.resolve({ url: "http://app:4000", key: gatewayKey }),
    isAiAccountCredential: (value) =>
      Promise.resolve(value.includes(ownersKey)),
    workDir: join(root, "work"),
    cloneUrl: () => remote,
    ...options,
  });
  return {
    root,
    remote,
    github,
    bus,
    sandbox,
    finder,
    request: {
      floor: { id: "web-shop", repository, defaultBranch: "main" },
      agent: {
        id: "mo",
        name: "Mo",
        aiProvider: "Claude",
        model: "claude-opus-5-5",
        effort: null,
      },
      sessionId: 3,
      topic: "CSV export for orders",
      question: "Which database are orders kept in?",
    },
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
  };
}

/** The work directory's contents: empty once every clone is deleted. */
const leftOver = async (): Promise<string[]> => {
  const work = join(setup.root, "work");
  return existsSync(work) ? await readdir(work) : [];
};

/** An agent that reads the docs and answers from what it read. */
const readsTheDocs: FakeAgent = async ({ print, sh }) => {
  print(bash("cat docs/stack.md"));
  const read = await sh("grep -h Postgres docs/stack.md");
  print(
    say(
      `It says so in docs/stack.md.\n<fact>${read.stdout.trim()} (docs/stack.md)</fact>`,
    ),
  );
  print(result({ input: 900, output: 120 }));
};

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgres://ai_office:db-secret@db/ai_office");
  vi.stubEnv("SESSION_SECRET", "a-session-secret-the-sandbox-must-not-see");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(setup.root, { recursive: true, force: true });
});

describe("the sandbox fact finder", () => {
  it("answers from the repository, read in a sandbox with a read-only token and no Git identity, then deletes the clone", async () => {
    const prompts: string[] = [];
    // What its GitHub token may do, while the sandbox runs.
    const scopes: unknown[] = [];
    setup = await setUp(async (context) => {
      prompts.push(context.prompt);
      const token = (await context.sh('printf %s "$GH_TOKEN"')).stdout;
      scopes.push(setup.github.tokenScope(token)?.permissions);
      await readsTheDocs(context);
    });

    const found = await setup.finder.find(setup.request);

    expect(found).toEqual({
      status: "found",
      answer:
        "Orders are kept in Postgres 18, in the `orders` table. (docs/stack.md)",
    });
    const [sandbox] = setup.sandbox.sandboxes;
    // Only the way to models and a token that can read: no Git identity,
    // as it commits nothing, and none of the host's secrets.
    expect(Object.keys(sandbox?.env ?? {}).sort()).toEqual(
      [
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "GH_TOKEN",
        // The relay as its only way out (`proxyEnvironment`).
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "NO_PROXY",
        "no_proxy",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      ].sort(),
    );
    expect(scopes).toEqual([readOnlyPermissions]);
    // Its own, revoked once the sandbox stopped (W1-3).
    expect(
      setup.github.tokenScope(sandbox?.env["GH_TOKEN"] ?? ""),
    ).toBeUndefined();
    expect(sandbox?.env["ANTHROPIC_AUTH_TOKEN"]).toBe(gatewayKey);
    // Its calls name its sandbox as their session, and no issue.
    const headers = sandbox?.env["ANTHROPIC_CUSTOM_HEADERS"] ?? "";
    expect(headers).toMatch(/^x-ai-office-session: sbx-[0-9a-f-]+$/);
    expect(sandbox?.closed).toBe(true);
    // The prompt: the question, the session, and read only.
    expect(prompts[0]).toContain("You are Mo, finding a fact");
    expect(prompts[0]).toContain("on: CSV export for orders");
    expect(prompts[0]).toContain("Which database are orders kept in?");
    expect(prompts[0]).toContain("Only read.");
    expect(prompts[0]).toContain("between <fact> and </fact>");

    expect(await leftOver()).toEqual([]);
    const events = await setup.events();
    const sandboxId =
      events[0]?.type === "grilling.fact_finding_started"
        ? events[0].sandboxId
        : "";
    expect(events).toEqual([
      {
        type: "grilling.fact_finding_started",
        version: 1,
        floorId: "web-shop",
        agentId: "mo",
        sessionId: 3,
        sandboxId,
      },
      {
        type: "grilling.fact_finding_stopped",
        version: 1,
        floorId: "web-shop",
        agentId: "mo",
        sessionId: 3,
        sandboxId,
        outcome: "found",
      },
    ]);
    expect(headers).toContain(sandboxId);
  });

  it("keeps no answer from a sandbox that changed the repository, and nothing of its changes reaches GitHub", async () => {
    setup = await setUp(async ({ print, sh }) => {
      await sh(
        "echo 'Orders are kept in SQLite.' > docs/stack.md && git -c user.name=x -c user.email=x@example.com commit --quiet -am 'docs: lie'",
      );
      print(say("<fact>Orders are kept in SQLite.</fact>"));
    });
    const before = await gitIn(setup.remote, "rev-parse", "main");

    const found = await setup.finder.find(setup.request);

    expect(found).toEqual({
      status: "failed",
      answer:
        "Mo changed the repository, though asked only to read, so the answer was not kept. The changes were thrown away.",
    });
    expect(await gitIn(setup.remote, "rev-parse", "main")).toBe(before);
    expect(await gitIn(setup.remote, "branch", "--list")).toBe("* main");
    expect(await leftOver()).toEqual([]);
    expect((await setup.events()).at(-1)).toMatchObject({
      type: "grilling.fact_finding_stopped",
      outcome: "failed",
    });
  });

  it("works on a branch of its own, so Sandcastle merges nothing back with Git on the host while the sandbox runs (S1-2)", async () => {
    let branch = "";
    setup = await setUp(async ({ print, sh }) => {
      branch = (await sh("git rev-parse --abbrev-ref HEAD")).stdout.trim();
      await sh(
        "echo 'Orders are kept in SQLite.' > docs/stack.md && git -c user.name=x -c user.email=x@example.com commit --quiet -am 'docs: lie'",
      );
      print(say("<fact>Orders are kept in SQLite.</fact>"));
    });

    expect((await setup.finder.find(setup.request)).status).toBe("failed");

    expect(branch).toMatch(/^ai-office\/fact-sbx-[0-9a-f-]+$/);
    // Sandcastle's merge-back starts by detaching the sandbox's HEAD.
    expect(setup.sandbox.sandboxes[0]?.commands).not.toContainEqual(
      expect.stringContaining("checkout --detach"),
    );
    expect(await leftOver()).toEqual([]);
  });

  it("keeps no answer from a sandbox that left a file changed without committing it", async () => {
    setup = await setUp(async ({ print, sh }) => {
      await sh("echo scratch > notes.txt");
      print(say("<fact>Postgres.</fact>"));
    });
    expect((await setup.finder.find(setup.request)).status).toBe("failed");
    expect(await leftOver()).toEqual([]);
  });

  it("says when the Agent finished without an answer", async () => {
    setup = await setUp(({ print }) => {
      print(say("I could not tell."));
      return Promise.resolve();
    });
    expect(await setup.finder.find(setup.request)).toEqual({
      status: "failed",
      answer: "Mo finished without an answer.",
    });
    expect((await setup.events()).at(-1)).toMatchObject({
      outcome: "unanswered",
    });
  });

  it("says why when the sandbox could not be started, never with a credential", async () => {
    setup = await setUp(readsTheDocs, {
      gateway: () =>
        Promise.resolve({ url: "http://app:4000", key: ownersKey }),
    });
    const found = await setup.finder.find(setup.request);
    expect(found.status).toBe("failed");
    expect(found.answer).toContain("Mo's sandbox failed:");
    expect(found.answer).not.toContain(ownersKey);
    expect(setup.sandbox.sandboxes).toEqual([]);
    expect(await leftOver()).toEqual([]);
    expect((await setup.events()).at(-1)).toMatchObject({ outcome: "failed" });
  });

  it("stops when it is cancelled, killing the sandbox", async () => {
    const controller = new AbortController();
    setup = await setUp(async ({ print, killed }) => {
      print(say("Looking."));
      controller.abort(new Error("The Owner stopped the chat."));
      await killed;
    });
    expect(
      await setup.finder.find({ ...setup.request, signal: controller.signal }),
    ).toEqual({ status: "failed", answer: "Finding it was cancelled." });
    expect(setup.sandbox.sandboxes[0]?.closed).toBe(true);
    expect(await leftOver()).toEqual([]);
    expect((await setup.events()).at(-1)).toMatchObject({
      outcome: "cancelled",
    });
  });

  it("kills a sandbox that runs out of time", async () => {
    setup = await setUp(
      async ({ killed }) => {
        await killed;
      },
      { timeoutMs: 1500 },
    );
    expect(await setup.finder.find(setup.request)).toEqual({
      status: "failed",
      answer: "Mo ran out of time to find it.",
    });
    expect(setup.sandbox.sandboxes[0]?.closed).toBe(true);
    expect((await setup.events()).at(-1)).toMatchObject({
      outcome: "timed_out",
    });
  });
  it("asks AI Office's rules about each tool call before it runs, and keeps no answer from a sandbox one stopped (P1-8)", async () => {
    const screens = createToolCallScreens();
    const gateway = await serveToolCallScreens(screens, "mo");
    const marks = await mkdtemp(join(tmpdir(), "ai-office-facts-marks-"));
    const leak = join(marks, "leaked");
    let ran: { exitCode: number; stderr: string } | undefined;
    try {
      setup = await setUp(
        async ({ print, sh, killed }) => {
          print(say("Reading the docs."));
          ran = await sh(`cat /proc/self/environ > ${leak}`);
          print(say("<fact>Postgres 18.</fact>"));
          await killed;
        },
        {
          gateway: () => Promise.resolve({ url: gateway.url, key: gatewayKey }),
          screens,
          toolCallCheck: (call) => Promise.resolve(toolCallRules(call)),
        },
      );
      expect(await setup.finder.find(setup.request)).toEqual({
        status: "failed",
        answer:
          "Mo's sandbox was stopped: AI Office's rules judged a Bash call unsafe: it reads the whole environment, where the sandbox's credentials are",
      });
      expect(ran?.exitCode).toBe(1);
      expect(existsSync(leak)).toBe(false);
      expect(await leftOver()).toEqual([]);
    } finally {
      await gateway.close();
      await rm(marks, { recursive: true, force: true });
    }
  });
});

describe("readFact", () => {
  it("reads the last answer between the tags, cut to fit", () => {
    expect(readFact("no answer")).toBeUndefined();
    expect(readFact("<fact>  </fact>")).toBeUndefined();
    expect(
      readFact(
        "Draft: <fact>MySQL</fact>\nNo, rather:\n<fact>\nPostgres 18.\n</fact>",
      ),
    ).toBe("Postgres 18.");
    const long = readFact(
      `<fact>${"a".repeat(maxGrillingFactLength + 10)}</fact>`,
    );
    expect(long).toHaveLength(maxGrillingFactLength);
    expect(long?.endsWith("…")).toBe(true);
  });
});
