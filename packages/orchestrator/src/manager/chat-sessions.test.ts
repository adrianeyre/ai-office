import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { postgresTest } from "@ai-office/db/testing";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import type { GitHubApp } from "@ai-office/github";
import { createFakeGitHub } from "@ai-office/github/testing";
import { afterEach, describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { sessionImagePath } from "../models/agent-tool-session.ts";
import type { ToolRun } from "../models/agent-tool-client.ts";
import {
  proxyEnvironmentKeys,
  SandboxEnvironmentError,
} from "../sandbox/environment.ts";
import { databaseStores } from "../stores.ts";
import {
  databaseManagerChatSessionStore,
  memoryManagerChatSessionStore,
  type ManagerChatSessionStore,
} from "./chat-session-store.ts";
import {
  createManagerChatSessions,
  dockerSessionTool,
  instructionsChangedTurn,
  type ManagerChatTurn,
} from "./chat-sessions.ts";
import { createFakeSessionTool } from "./fake-chat-sessions.ts";

// The Manager chat's continuing, read-only agent sessions (PRD FR-24, ADR
// 0004): one session per conversation, given the conversation so far on
// its first turn and only the newest turn after; run like a sandbox, on a
// read-only clone of the Floor's repository refreshed before each turn,
// reaching models through the AI Gateway with the Manager's own Gateway
// Key (ADR 0001); and kept by the tool's own id, in memory and in
// Postgres 18.

const git = promisify(execFile);
const repository = "adrianeyre/web-shop";
const gatewayKey = "aio_gk_joansownkeyforhersession00000000000";
const ownersKey = "sk-ant-api03-the-owners-real-key-0123456789";
const conversation = "manager-chat:web-shop:0";

const turnOf = (
  overrides: Partial<ManagerChatTurn> = {},
): ManagerChatTurn & { readonly told: string[]; readonly used: string[] } => {
  const told: string[] = [];
  const used: string[] = [];
  return {
    floor: { id: "web-shop", repository, defaultBranch: "main" },
    manager: { id: "joan", aiProvider: "Claude" },
    model: "claude-opus-5-5",
    effort: "high",
    system: "You are Joan.",
    messages: [{ role: "user", content: "Where are totals worked out?" }],
    conversation,
    signal: new AbortController().signal,
    onText: (text) => told.push(text),
    onTool: (tool) => used.push(`${tool.name} ${tool.summary}`),
    ...overrides,
    told,
    used,
  };
};

describe("the Manager chat's sessions", () => {
  it("starts a conversation's session with the conversation so far, then resumes it with only the newest turn", async () => {
    const store = memoryManagerChatSessionStore();
    const tool = createFakeSessionTool();
    const sessions = createManagerChatSessions({ store, tool });
    tool.answer(
      {
        text: "In src/total.ts.",
        tools: [{ name: "Read", summary: "src/total.ts" }],
      },
      "It adds VAT last.",
    );

    const first = turnOf({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hello, Owner." },
        { role: "user", content: "Where are totals worked out?" },
      ],
    });
    expect(await sessions.turn(first)).toEqual({
      text: "In src/total.ts.",
      stopReason: "end_turn",
    });
    expect(first.used).toEqual(["Read src/total.ts"]);
    const [started] = tool.runs;
    expect(started?.session.resume).toBe(false);
    expect(started?.input).toContain("The conversation so far:");
    expect(started?.input).toContain("Hello, Owner.");
    const id = started?.session.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.get("web-shop", conversation)).toMatchObject({
      tool: "Claude Code",
      toolSessionId: id,
    });

    await sessions.turn(
      turnOf({
        messages: [
          ...first.messages,
          { role: "assistant", content: "In src/total.ts." },
          { role: "user", content: "And VAT?" },
        ],
      }),
    );
    expect(tool.runs[1]?.session).toEqual({ resume: true, id });
    expect(tool.runs[1]?.input).toBe("And VAT?");
  });

  it("gives a resumed turn the Manager's instructions when they changed", async () => {
    const tool = createFakeSessionTool();
    const sessions = createManagerChatSessions({
      store: memoryManagerChatSessionStore(),
      tool,
    });
    tool.answer("[use skill: release]", "Released.");
    await sessions.turn(turnOf());
    await sessions.turn(turnOf({ system: "You are Joan. Follow /release." }));
    expect(tool.runs[1]?.input).toBe(
      instructionsChangedTurn(
        "You are Joan. Follow /release.",
        "Where are totals worked out?",
      ),
    );
  });

  it("starts a new session for a new conversation, as after /clear", async () => {
    const tool = createFakeSessionTool();
    const sessions = createManagerChatSessions({
      store: memoryManagerChatSessionStore(),
      tool,
    });
    tool.answer("One.", "Two.");
    await sessions.turn(turnOf());
    await sessions.turn(turnOf({ conversation: "manager-chat:web-shop:7" }));
    expect(tool.runs.map(({ session }) => session.resume)).toEqual([
      false,
      false,
    ]);
    expect(tool.runs[1]?.session.id).not.toBe(tool.runs[0]?.session.id);
  });

  it("keeps the session Codex names, and resumes it by that id", async () => {
    const store = memoryManagerChatSessionStore();
    const tool = createFakeSessionTool();
    const sessions = createManagerChatSessions({ store, tool });
    tool.answer("One.", "Two.");
    const codex = {
      manager: { id: "joan", aiProvider: "ChatGPT" },
      model: "gpt-5.5",
    };
    await sessions.turn(turnOf(codex));
    expect(tool.runs[0]?.session).toEqual({ resume: false, id: null });
    expect(await store.get("web-shop", conversation)).toMatchObject({
      tool: "Codex",
      toolSessionId: "codex-thread-1",
    });
    await sessions.turn(turnOf(codex));
    expect(tool.runs[1]?.session).toEqual({
      resume: true,
      id: "codex-thread-1",
    });
  });

  it("starts afresh when the tool no longer holds the session", async () => {
    const store = memoryManagerChatSessionStore();
    await store.put(
      {
        floorId: "web-shop",
        conversation,
        tool: "Claude Code",
        toolSessionId: "lost-with-the-volume",
      },
      new Date(),
    );
    const tool = createFakeSessionTool();
    tool.answer("Fresh.");
    await createManagerChatSessions({ store, tool }).turn(turnOf());
    expect(tool.runs[0]?.session.resume).toBe(false);
    expect(tool.runs[0]?.session.id).not.toBe("lost-with-the-volume");
  });

  it("serves only Models whose AI Provider has Claude Code or Codex", () => {
    const sessions = createManagerChatSessions({
      store: memoryManagerChatSessionStore(),
      tool: createFakeSessionTool(),
    });
    expect(sessions.serves("claude-opus-5-5")).toBe(true);
    expect(sessions.serves("gpt-5.5")).toBe(true);
    expect(sessions.serves("grok-4")).toBe(false);
  });
});

describe("the Manager's session, run like a sandbox", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** A local bare repository standing in for GitHub's Git remote. */
  const seeded = async () => {
    root = await mkdtemp(join(tmpdir(), "ai-office-manager-chat-"));
    const remote = join(root, "web-shop.git");
    const seed = join(root, "seed");
    const gitIn = (cwd: string, ...args: string[]) =>
      git(
        "git",
        ["-c", "user.name=Seed", "-c", "user.email=seed@example.com", ...args],
        { cwd },
      );
    await git("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
    await git("git", ["init", "--quiet", "-b", "main", seed]);
    await writeFile(join(seed, "total.ts"), "export const vat = 0.2;\n");
    await mkdir(join(seed, ".sandcastle"));
    await writeFile(join(seed, ".sandcastle", ".env"), "ANTHROPIC_API_KEY=\n");
    await gitIn(seed, "add", "-A");
    await gitIn(seed, "commit", "--quiet", "-m", "chore: start");
    await gitIn(seed, "push", "--quiet", remote, "main");
    return { root, remote, seed, gitIn };
  };

  const runner = (lines: readonly string[]) => {
    const runs: ToolRun[] = [];
    return {
      runs,
      async *run(run: ToolRun) {
        runs.push(run);
        await Promise.resolve();
        yield* lines;
      },
    };
  };

  const answered = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "VAT is 20%.",
    }),
  ];

  it("mounts a fresh, read-only clone where Claude Code works, with only the way to the Gateway", async () => {
    const { remote, seed, gitIn } = await seeded();
    const github = createFakeGitHub();
    github.installRepository(repository);
    const fake = runner(answered);
    const workDir = join(root ?? "", "work");
    const tool = dockerSessionTool({
      github,
      gateway: () =>
        Promise.resolve({ url: "http://app:4000", key: gatewayKey }),
      run: (run) => fake.run(run),
      workDir,
      cloneUrl: () => remote,
    });
    const run = {
      tool: "Claude Code" as const,
      floor: { id: "web-shop", repository, defaultBranch: "main" },
      manager: { id: "joan", aiProvider: "Claude" },
      model: "claude-opus-5-5",
      effort: "high",
      system: "You are Joan.",
      conversation,
      session: {
        resume: false as const,
        id: "6f0c1a52-3b7e-4c39-9d0e-1f2a3b4c5d6e",
      },
      input: "Where is VAT?",
      images: [],
      signal: new AbortController().signal,
      onText: () => undefined,
      onTool: () => undefined,
      onSession: () => undefined,
    };
    expect(await tool.run(run)).toEqual({
      text: "VAT is 20%.",
      stopReason: "end_turn",
    });
    const [made] = fake.runs;
    const clone = join(workDir, "web-shop", "repo");
    expect(made?.mounts).toEqual([
      { host: clone, container: "/home/agent/workspace", readOnly: true },
      {
        host: join(workDir, "web-shop", "claude"),
        container: "/home/agent/.claude",
        readOnly: false,
      },
      // AI Office's repository tools, in place of a shell (P2-1, P2-2).
      {
        host: join(workDir, "web-shop", "tools"),
        container: "/home/agent/ai-office",
        readOnly: true,
      },
    ]);
    expect(
      await readFile(
        join(workDir, "web-shop", "tools", "repository-tools.ts"),
        "utf8",
      ),
    ).toBe(
      await readFile(new URL("./repository-tools.ts", import.meta.url), "utf8"),
    );
    expect(made?.workdir).toBe("/home/agent/workspace");
    expect(made?.input).toBe("Where is VAT?");
    expect(made?.args).toContain("--session-id");
    // Only the way to the Gateway, naming the conversation as the session,
    // and the relay as its only way out.
    expect(Object.keys(made?.environment ?? {}).sort()).toEqual(
      [
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS",
        ...proxyEnvironmentKeys,
      ].sort(),
    );
    expect(made?.environment["ANTHROPIC_CUSTOM_HEADERS"]).toContain(
      conversation,
    );
    expect(made?.args.join(" ")).not.toContain(gatewayKey);
    // The repository chooses nothing the tool is given.
    expect(existsSync(join(clone, ".sandcastle", ".env"))).toBe(false);

    // The clone is brought up to date before the next turn.
    await writeFile(join(seed, "total.ts"), "export const vat = 0.25;\n");
    await gitIn(seed, "commit", "--quiet", "-am", "fix: VAT");
    await gitIn(seed, "push", "--quiet", remote, "main");
    await tool.run({ ...run, session: { resume: true, id: run.session.id } });
    expect(await readFile(join(clone, "total.ts"), "utf8")).toContain("0.25");
    expect(fake.runs[1]?.args).toContain("--resume");

    // It holds a session once Claude Code has kept it in its home.
    expect(await tool.holds("web-shop", "Claude Code", run.session.id)).toBe(
      false,
    );
    const projects = join(
      workDir,
      "web-shop",
      "claude",
      "projects",
      "-home-agent-workspace",
    );
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, `${run.session.id}.jsonl`), "{}\n");
    expect(await tool.holds("web-shop", "Claude Code", run.session.id)).toBe(
      true,
    );
    expect(await tool.holds("web-shop", "Codex", run.session.id)).toBe(false);
  });

  it("clones with a read-only token of each turn's own, revoked once the clone is fresh and before the session runs (W1-3)", async () => {
    const { remote } = await seeded();
    const github = createFakeGitHub();
    github.installRepository(repository);
    const minted: string[] = [];
    const counted: GitHubApp = {
      ...github,
      repository(fullName) {
        const client = github.repository(fullName);
        return {
          ...client,
          readOnlyToken: async () => {
            const token = await client.readOnlyToken();
            minted.push(token.token);
            return token;
          },
        };
      },
    };
    const fake = runner(answered);
    /** Whether each token minted so far still works, as each turn runs. */
    const live: boolean[][] = [];
    const workDir = join(root ?? "", "work");
    const tool = dockerSessionTool({
      github: counted,
      gateway: () =>
        Promise.resolve({ url: "http://app:4000", key: gatewayKey }),
      run: (run) => {
        live.push(
          minted.map((token) => github.tokenScope(token) !== undefined),
        );
        return fake.run(run);
      },
      workDir,
      cloneUrl: () => remote,
    });
    const run = {
      tool: "Claude Code" as const,
      floor: { id: "web-shop", repository, defaultBranch: "main" },
      manager: { id: "joan", aiProvider: "Claude" },
      model: "claude-opus-5-5",
      effort: "high",
      system: "You are Joan.",
      conversation,
      session: {
        resume: false as const,
        id: "6f0c1a52-3b7e-4c39-9d0e-1f2a3b4c5d6e",
      },
      input: "Where is VAT?",
      images: [],
      signal: new AbortController().signal,
      onText: () => undefined,
      onTool: () => undefined,
      onSession: () => undefined,
    };
    await tool.run(run);
    await tool.run({ ...run, session: { resume: true, id: run.session.id } });
    expect(minted).toHaveLength(2);
    expect(minted[1]).not.toBe(minted[0]);
    expect(live).toEqual([[false], [false, false]]);
  });

  it("gives Codex its instructions with the session's first turn, and its own home", async () => {
    const { remote } = await seeded();
    const github = createFakeGitHub();
    github.installRepository(repository);
    const fake = runner([
      JSON.stringify({ type: "thread.started", thread_id: "0199-thread" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "VAT is 20%." },
      }),
      JSON.stringify({ type: "turn.completed" }),
    ]);
    const workDir = join(root ?? "", "work");
    const named: string[] = [];
    await dockerSessionTool({
      github,
      gateway: () =>
        Promise.resolve({ url: "http://app:4000", key: gatewayKey }),
      run: (run) => fake.run(run),
      workDir,
      cloneUrl: () => remote,
    }).run({
      tool: "Codex",
      floor: { id: "web-shop", repository, defaultBranch: "main" },
      manager: { id: "joan", aiProvider: "ChatGPT" },
      model: "gpt-5.5",
      effort: null,
      system: "You are Joan.",
      conversation,
      session: { resume: false, id: null },
      input: "Where is VAT?",
      images: [],
      signal: new AbortController().signal,
      onText: () => undefined,
      onTool: () => undefined,
      onSession: (id) => named.push(id),
    });
    const [made] = fake.runs;
    expect(made?.input).toBe("You are Joan.\n\nWhere is VAT?");
    expect(made?.mounts?.[0]?.readOnly).toBe(true);
    expect(made?.mounts?.[1]?.container).toBe("/home/agent/.codex");
    expect(made?.environment).toMatchObject({
      OPENAI_BASE_URL: "http://app:4000/v1",
      AI_OFFICE_GATEWAY_KEY: gatewayKey,
      AI_OFFICE_SESSION: conversation,
    });
    expect(named).toEqual(["0199-thread"]);
  });

  it("mounts the turn's images read-only where its text says, shows them to Codex, and removes them after", async () => {
    const { remote } = await seeded();
    const github = createFakeGitHub();
    github.installRepository(repository);
    const runs: ToolRun[] = [];
    const seen: string[] = [];
    const workDir = join(root ?? "", "work");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await dockerSessionTool({
      github,
      gateway: () =>
        Promise.resolve({ url: "http://app:4000", key: gatewayKey }),
      run: async function* (run) {
        runs.push(run);
        const attached = run.mounts?.find(
          ({ container }) => container === "/home/agent/attachments",
        );
        // The bytes are there while the tool runs.
        seen.push(
          (
            await readFile(join(attached?.host ?? "", "1-checkout_error.png"))
          ).toString("hex"),
        );
        yield JSON.stringify({ type: "thread.started", thread_id: "t" });
        yield JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "A 500 from /checkout." },
        });
        yield JSON.stringify({ type: "turn.completed" });
      },
      workDir,
      cloneUrl: () => remote,
    }).run({
      tool: "Codex",
      floor: { id: "web-shop", repository, defaultBranch: "main" },
      manager: { id: "joan", aiProvider: "ChatGPT" },
      model: "gpt-5.5",
      effort: null,
      system: "You are Joan.",
      conversation,
      session: { resume: true, id: "t" },
      input: "What is this error?",
      images: [
        { name: "checkout error.png", mediaType: "image/png", content: png },
      ],
      signal: new AbortController().signal,
      onText: () => undefined,
      onTool: () => undefined,
      onSession: () => undefined,
    });
    const [made] = runs;
    const path = "/home/agent/attachments/1-checkout_error.png";
    expect(sessionImagePath(0, "checkout error.png")).toBe(path);
    expect(made?.mounts?.[2]).toMatchObject({
      container: "/home/agent/attachments",
      readOnly: true,
    });
    expect(made?.args.slice(made.args.indexOf("--image"))[1]).toBe(path);
    expect(seen).toEqual([png.toString("hex")]);
    expect(existsSync(made?.mounts?.[2]?.host ?? "")).toBe(false);
  });

  it("refuses an environment holding one of the Owner's AI Account credentials", async () => {
    const { remote } = await seeded();
    const github = createFakeGitHub();
    github.installRepository(repository);
    const fake = runner(answered);
    await expect(
      dockerSessionTool({
        github,
        gateway: () =>
          Promise.resolve({ url: "http://app:4000", key: gatewayKey }),
        run: (run) => fake.run(run),
        workDir: join(root ?? "", "work"),
        cloneUrl: () => remote,
        isAiAccountCredential: (value) =>
          Promise.resolve(value === gatewayKey || value.includes(ownersKey)),
      }).run({
        tool: "Claude Code",
        floor: { id: "web-shop", repository, defaultBranch: "main" },
        manager: { id: "joan", aiProvider: "Claude" },
        model: "claude-opus-5-5",
        effort: null,
        system: "You are Joan.",
        conversation,
        session: { resume: false, id: "6f0c1a52-3b7e-4c39-9d0e-1f2a3b4c5d6e" },
        input: "Hi",
        images: [],
        signal: new AbortController().signal,
        onText: () => undefined,
        onTool: () => undefined,
        onSession: () => undefined,
      }),
    ).rejects.toBeInstanceOf(SandboxEnvironmentError);
    expect(fake.runs).toEqual([]);
  });
});

/** The store's cases, in memory and in Postgres 18. */
const storeCases: [
  name: string,
  run: (store: ManagerChatSessionStore) => Promise<void>,
][] = [
  [
    "keeps a conversation's session, and replaces it keeping when it began",
    async (store) => {
      expect(await store.get("web-shop", conversation)).toBeUndefined();
      const began = new Date("2026-10-11T09:00:00.000Z");
      const later = new Date("2026-10-11T09:05:00.000Z");
      await store.put(
        {
          floorId: "web-shop",
          conversation,
          tool: "Claude Code",
          toolSessionId: "a",
        },
        began,
      );
      await store.put(
        {
          floorId: "web-shop",
          conversation,
          tool: "Codex",
          toolSessionId: "b",
        },
        later,
      );
      expect(await store.get("web-shop", conversation)).toEqual({
        floorId: "web-shop",
        conversation,
        tool: "Codex",
        toolSessionId: "b",
        createdAt: began,
        updatedAt: later,
      });
      expect(
        await store.get("web-shop", "manager-chat:web-shop:9"),
      ).toBeUndefined();
    },
  ],
];

describe("the Manager chat's session store, in memory", () => {
  for (const [name, run] of storeCases) {
    it(name, () => run(memoryManagerChatSessionStore()));
  }
});

describe("the Manager chat's session store, in Postgres 18", () => {
  for (const [name, run] of storeCases) {
    postgresTest(name, async ({ database }) => {
      const stores = databaseStores(database.db);
      const github = createFakeGitHub();
      github.installRepository(repository);
      await createFloors({
        store: stores.floors,
        github,
        events: createEventBus({ store: memoryEventStore() }),
      }).add(repository);
      await run(databaseManagerChatSessionStore(database.db));
    });
  }
});
