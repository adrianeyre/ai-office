import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createEventBus,
  memoryEventStore,
  type EventBus,
  type EventOfType,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentRecord } from "../agents/store.ts";
import { createFreshStarts, type FreshStarts } from "../context/fresh-start.ts";
import {
  createContextUsage,
  followSandboxSessions,
  type ContextUsage,
} from "../context/usage.ts";
import { createFloors } from "../floors/floors.ts";
import { createFakeModel, type FakeModel } from "../models/fake-model.ts";
import { createNotices, type Notices } from "../notices/notices.ts";
import { memoryStores } from "../stores.ts";
import {
  createFakeSandbox,
  result,
  say,
  type FakeAgent,
  type FakeAgentContext,
} from "./fake-sandbox.ts";
import {
  createSandboxRunner,
  freshStartCommitMessage,
  type SandboxRunner,
  type SandboxTask,
} from "./runner.ts";

// Fresh Starts in the sandbox runner (PRD FR-86, FR-87, FR-89), with real
// Sandcastle, a fake sandbox provider (the host stands in for Docker, a
// script for Claude Code) and a local bare repository for GitHub's Git
// remote. The fake agent's model calls are told to Context Usage as the
// AI Gateway would record them, naming the session its sandbox was given.

const git = promisify(execFile);
const repository = "adrianeyre/web-shop";
const identity = {
  name: "adrianeyre",
  email: "21265837+adrianeyre@users.noreply.github.com",
};
const gatewayKey = "aio_gk_thecoderskeyforitssandboxes00000000000000";
const opus = "claude-opus-5-5";

/** The summary the coder's Model writes, as JSON. */
const summary = {
  done: ["The basket model is committed."],
  inProgress: ["The basket view is half written."],
  nextSteps: ["Finish the basket view.", "Run the tests."],
  decisions: ["Keep the basket in memory, not in the database."],
  filesTouched: ["model.txt", "view.txt"],
};

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
  readonly github: ReturnType<typeof createFakeGitHub>;
  readonly bus: EventBus;
  readonly stores: ReturnType<typeof memoryStores>;
  readonly coder: AgentRecord;
  readonly usage: ContextUsage;
  readonly freshStarts: FreshStarts;
  readonly models: FakeModel;
  readonly notices: Notices;
  readonly runner: SandboxRunner;
  readonly task: SandboxTask;
  /** Each session's prompt, in order. */
  readonly prompts: string[];
  readonly events: () => Promise<OfficeEvent[]>;
}

let setup: Setup | undefined;

afterEach(async () => {
  if (setup !== undefined) {
    await rm(setup.root, { recursive: true, force: true });
  }
  setup = undefined;
});

/** Sets up a Floor whose coder's sessions run `sessions`, one each. */
async function setUp(sessions: readonly FakeAgent[]): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "ai-office-fresh-start-"));
  const remote = join(root, "web-shop.git");
  const seed = join(root, "seed");
  await git("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await git("git", ["init", "--quiet", "-b", "main", seed]);
  await writeFile(join(seed, "README.md"), "# Web shop\n");
  await gitIn(seed, "add", "-A");
  await gitIn(seed, "commit", "--quiet", "-m", "chore: start");
  await gitIn(seed, "push", "--quiet", remote, "main");

  const github = createFakeGitHub();
  github.installRepository(repository);
  const bus = createEventBus({ store: memoryEventStore() });
  const stores = memoryStores();
  await createFloors({ store: stores.floors, github, events: bus }).add(
    repository,
  );
  const coder = (await stores.agents.list("web-shop")).find(
    ({ role }) => role === "coder",
  );
  if (coder === undefined) {
    throw new Error("A new Floor has a coder.");
  }
  const usage = createContextUsage({
    events: bus,
    agents: stores.agents,
    contextWindow: () => Promise.resolve(200_000),
  });
  followSandboxSessions(bus, usage);
  const notices = createNotices({ store: stores.notices, events: bus });
  const models = createFakeModel();
  const freshStarts = createFreshStarts({
    contextUsage: usage,
    floors: stores.floors,
    agents: stores.agents,
    models,
    events: bus,
    notices,
  });

  const prompts: string[] = [];
  let next = 0;
  const sandbox = await createFakeSandbox(async (context) => {
    prompts.push(context.prompt);
    const session = sessions[next];
    next += 1;
    if (session === undefined) {
      throw new Error(`No session ${String(next)} was scripted.`);
    }
    await session(context);
  });
  const runner = createSandboxRunner({
    github,
    events: bus,
    sandbox: (environment) => sandbox.provider(environment),
    gateway: () =>
      Promise.resolve({ url: "http://gateway:4000", key: gatewayKey }),
    workDir: join(root, "work"),
    cloneUrl: () => remote,
    freshStarts,
  });
  return {
    root,
    github,
    bus,
    stores,
    coder,
    usage,
    freshStarts,
    models,
    notices,
    runner,
    task: {
      floor: {
        id: "web-shop",
        repository,
        defaultBranch: "main",
        setupCommand: "",
      },
      agent: {
        id: coder.id,
        role: "coder",
        aiProvider: "Claude",
        model: opus,
        effort: null,
      },
      issue: { number: 4, title: "Add a basket!" },
      prompt: "Work issue #4.",
      gitIdentity: identity,
    },
    prompts,
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
  };
}

/** The session the sandbox's agent tool names on its model calls. */
async function sessionOf({ sh }: FakeAgentContext): Promise<string> {
  const headers = (await sh('printf %s "$ANTHROPIC_CUSTOM_HEADERS"')).stdout;
  const session = /^x-ai-office-session: (.+)$/m.exec(headers)?.[1];
  if (session === undefined) {
    throw new Error("The sandbox names no session.");
  }
  return session;
}

/** A model call with `tokens` of input, as the Gateway records it. */
async function call(
  context: FakeAgentContext,
  current: Setup,
  tokens: number,
): Promise<void> {
  await current.usage.observe({
    agentId: current.coder.id,
    floorId: "web-shop",
    session: await sessionOf(context),
    issue: 4,
    endpoint: "messages",
    model: opus,
    status: 200,
    startedAt: new Date(),
    inputTokens: 3,
    cacheReadInputTokens: tokens - 3,
    cacheCreationInputTokens: 0,
  });
}

const of = <Type extends OfficeEvent["type"]>(
  events: readonly OfficeEvent[],
  type: Type,
) => events.filter((event): event is EventOfType<Type> => event.type === type);

const subjects = async (workspace: string) =>
  (
    await gitIn(
      workspace,
      "log",
      "--reverse",
      "--format=%s",
      "refs/heads/ai-office/4-add-a-basket",
      "--not",
      "main",
    )
  ).split("\n");

/** The fake agent's last session: it finishes the work. */
const finishes =
  (seen: string[]): FakeAgent =>
  async ({ print, sh }) => {
    seen.push((await sh("cat view.txt")).stdout.trim());
    print(say("Finishing the basket view."));
    await sh(
      "echo full > view.txt && git commit --quiet -am 'feat: the basket view'",
    );
    print(say("Done."));
    print(result({ input: 900, output: 200 }));
  };

describe("Fresh Starts in the sandbox runner", () => {
  it("makes a Fresh Start when Context Usage crosses 85%, resuming on the same branch with the Agent's summary", async () => {
    const seen: string[] = [];
    const current: Setup = await setUp([
      async (context) => {
        context.print(say("Adding the basket model."));
        await context.sh(
          "echo model > model.txt && git add model.txt && git commit --quiet -m 'feat: the basket model'",
        );
        // Half done, and not committed when the context fills up.
        await context.sh("echo half > view.txt");
        await call(context, current, 120_000);
        await call(context, current, 172_000);
        await context.killed;
      },
      finishes(seen),
    ]);
    setup = current;
    current.models.answer(current.coder.id, JSON.stringify(summary));

    const run = await current.runner.run(current.task);

    expect(run.freshStarts).toBe(1);
    expect(run.escalated).toBe(false);
    expect(run.branch).toBe("ai-office/4-add-a-basket");
    // Every session's commits, on the one branch; the work in progress
    // saved, and found by the next session.
    expect(await subjects(run.workspace)).toEqual([
      "feat: the basket model",
      freshStartCommitMessage,
      "feat: the basket view",
    ]);
    expect(run.commits).toHaveLength(3);
    expect(seen).toEqual(["half"]);

    // The summary, by the coder's own Model, from what the session did.
    const [asked, ...more] = current.models.requestsOf(current.coder.id);
    expect(more).toEqual([]);
    const events = await current.events();
    const [first, second] = of(events, "sandbox.started");
    expect(asked).toMatchObject({
      model: opus,
      issue: 4,
      session: first?.sandboxId,
    });
    const question = asked?.messages[0]?.content ?? "";
    expect(question).toContain("Adding the basket model.");
    expect(question).toContain("- feat: the basket model");
    expect(question).toContain("- model.txt");

    // The next session starts with the issue and the summary.
    const [, resumed] = current.prompts;
    expect(resumed?.startsWith("Work issue #4.")).toBe(true);
    expect(resumed).toContain("## Fresh Start 1 of at most 3");
    expect(resumed).toContain(
      "### In progress\n\n- The basket view is half written.",
    );
    expect(resumed).toContain(
      "### Decisions\n\n- Keep the basket in memory, not in the database.",
    );
    expect(resumed).toContain("### Files touched\n\n- model.txt\n- view.txt");

    // Each Fresh Start is an event; each session its own sandbox.
    expect(of(events, "agent.fresh_start")).toEqual([
      {
        type: "agent.fresh_start",
        version: 1,
        floorId: "web-shop",
        agentId: current.coder.id,
        issue: 4,
        trigger: "threshold",
        contextUsage: 0.86,
      },
    ]);
    expect(second?.sandboxId).not.toBe(first?.sandboxId);
    expect(second?.branch).toBe(first?.branch);
    expect(of(events, "sandbox.stopped").map(({ outcome }) => outcome)).toEqual(
      ["fresh_start", "finished"],
    );
    expect(run.sandboxId).toBe(second?.sandboxId);
    // The ended session's Context Usage is gone.
    expect(
      of(events, "agent.context_usage").map(({ active, contextUsage }) => [
        active,
        contextUsage,
      ]),
    ).toEqual([
      [true, 0.6],
      [true, 0.86],
      [false, null],
    ]);
    await run.discard();
  });

  // S1-1: the app runs Git in the worktree to save the work in progress,
  // reading its config first, so the Agent must not be able to change it
  // meanwhile. Its sandbox is stopped before anything is saved.
  it("stops the sandbox before it saves the work in progress", async () => {
    let atKill: { readonly before: string; readonly head: string } | undefined;
    const current: Setup = await setUp([
      async (context) => {
        await context.sh(
          "echo model > model.txt && git add model.txt && git commit --quiet -m 'feat: the basket model'",
        );
        const before = (await context.sh("git rev-parse HEAD")).stdout.trim();
        const worktree = (await context.sh("pwd")).stdout.trim();
        await context.sh("echo half > view.txt");
        await call(context, current, 172_000);
        await context.killed;
        // At once, before the app could run any Git of its own.
        const head = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: worktree,
          encoding: "utf8",
        }).trim();
        atKill = { before, head };
      },
      finishes([]),
    ]);
    setup = current;
    current.models.answer(current.coder.id, JSON.stringify(summary));

    const run = await current.runner.run(current.task);

    expect(run.freshStarts).toBe(1);
    // Nothing was committed while the sandbox ran...
    expect(atKill).toBeDefined();
    expect(atKill?.head).toBe(atKill?.before);
    // ...and the work in progress was still saved once it had stopped.
    expect(await subjects(run.workspace)).toEqual([
      "feat: the basket model",
      freshStartCommitMessage,
      "feat: the basket view",
    ]);
  });

  it("makes a Fresh Start by hand mid-task", async () => {
    let ready: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const seen: string[] = [];
    const current: Setup = await setUp([
      async (context) => {
        await context.sh("echo half > view.txt");
        await call(context, current, 50_000);
        ready();
        await context.killed;
      },
      finishes(seen),
    ]);
    setup = current;
    current.models.answer(current.coder.id, JSON.stringify(summary));
    // Nothing to end before it starts.
    expect(current.freshStarts.request("web-shop", current.coder.id)).toBe(
      undefined,
    );

    const running = current.runner.run(current.task);
    await waiting;
    const ended = current.freshStarts.request("web-shop", current.coder.id);
    const run = await running;

    const events = await current.events();
    const [first] = of(events, "sandbox.started");
    expect(ended).toBe(first?.sandboxId);
    expect(run.freshStarts).toBe(1);
    expect(seen).toEqual(["half"]);
    expect(of(events, "agent.fresh_start")).toEqual([
      expect.objectContaining({ trigger: "manual", contextUsage: 0.25 }),
    ]);
    expect(current.prompts[1]).toContain("## Fresh Start 1 of at most 3");
    await run.discard();
  });

  it("gives each session's sandbox a read-only token of its own, revoked as that sandbox stops (W1-3)", async () => {
    let ready: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const tokens: string[] = [];
    const live: boolean[] = [];
    const current: Setup = await setUp([
      async (context) => {
        const token = (await context.sh('printf %s "$GH_TOKEN"')).stdout;
        tokens.push(token);
        live.push(current.github.tokenScope(token) !== undefined);
        await call(context, current, 50_000);
        ready();
        await context.killed;
      },
      async (context) => {
        const token = (await context.sh('printf %s "$GH_TOKEN"')).stdout;
        tokens.push(token);
        // The first sandbox's token was revoked as it stopped.
        live.push(current.github.tokenScope(tokens[0] ?? "") !== undefined);
        live.push(current.github.tokenScope(token) !== undefined);
        await finishes([])(context);
      },
    ]);
    setup = current;
    current.models.answer(current.coder.id, JSON.stringify(summary));
    const running = current.runner.run(current.task);
    await waiting;
    current.freshStarts.request("web-shop", current.coder.id);
    const run = await running;

    expect(run.freshStarts).toBe(1);
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).not.toBe(tokens[0]);
    expect(live).toEqual([true, false, true]);
    for (const token of tokens) {
      expect(current.github.tokenScope(token)).toBeUndefined();
    }
    await run.discard();
  });

  it("escalates at the fourth Fresh Start: the Agent is paused and the Owner gets an action Notice", async () => {
    const fills: FakeAgent = async (context) => {
      await context.sh(
        `echo "$(date +%s%N)" >> notes.txt && git add notes.txt && git commit --quiet -m 'docs: a note'`,
      );
      await call(context, current, 180_000);
      await context.killed;
    };
    const current: Setup = await setUp([fills, fills, fills, fills]);
    setup = current;
    current.models.answer(
      current.coder.id,
      JSON.stringify(summary),
      JSON.stringify(summary),
      JSON.stringify(summary),
    );

    const run = await current.runner.run(current.task);

    expect(run.escalated).toBe(true);
    expect(run.freshStarts).toBe(3);
    // Its work is kept for AI Office to push.
    expect(run.commits).toHaveLength(4);
    expect(current.prompts).toHaveLength(4);
    expect(current.prompts[3]).toContain("## Fresh Start 3 of at most 3");
    // Three summaries; the fourth Fresh Start was not made.
    expect(current.models.requestsOf(current.coder.id)).toHaveLength(3);
    const events = await current.events();
    expect(of(events, "agent.fresh_start")).toHaveLength(3);
    expect(of(events, "sandbox.stopped").map(({ outcome }) => outcome)).toEqual(
      ["fresh_start", "fresh_start", "fresh_start", "fresh_start"],
    );

    // Paused: no work starts for it until the Owner resumes it.
    const coder = (await current.stores.agents.list("web-shop")).find(
      ({ id }) => id === current.coder.id,
    );
    expect(coder?.enabled).toBe(false);
    expect(of(events, "config.changed")).toContainEqual({
      type: "config.changed",
      version: 1,
      scope: "agent",
      floorId: "web-shop",
      agentId: current.coder.id,
      keys: ["enabled"],
    });
    const [notice, ...others] = await current.notices.open({
      floorId: "web-shop",
    });
    expect(others).toEqual([]);
    expect(notice).toMatchObject({
      kind: "action",
      agentId: current.coder.id,
      title: `Fresh Start cap reached: ${current.coder.name} is paused on #4 after 3 Fresh Starts. Check the issue, then resume ${current.coder.name} in its Agent editor.`,
    });
    await run.discard();
  });
});
