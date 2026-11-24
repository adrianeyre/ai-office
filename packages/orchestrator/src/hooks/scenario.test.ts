import {
  createEventBus,
  memoryEventStore,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  hookInputSchema,
  type Hook,
  type HookInput,
  type HookInputRequest,
  type SkillFile,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import {
  ModelCallError,
  type ModelClient,
  type ModelReply,
  type ModelRequest,
} from "../models/client.ts";
import { createNotices } from "../notices/notices.ts";
import { createFloorSkills } from "../skills/floor.ts";
import { skillDigest } from "../skills/skills.ts";
import { memoryStores } from "../stores.ts";
import { createHooksAdmin } from "./admin.ts";
import { createHookRunner, openHooksAction } from "./runner.ts";

// Hooks at work (Guidelines, Specs and Hooks PRD, FR-118 to FR-121; ADR
// 0016), against a fake GitHub and a fake AI Gateway: a Hook runs on its
// trigger, honours its filters, rate-limits, skips a run already going on
// the same issue or pull request, never fires on an event its own run
// caused, and turns itself off after three failed runs in a row. Each run
// is one model call made as its Agent, with the Skill's instructions and
// the event's details as untrusted data, and its answer is posted on the
// issue or pull request.

const repository = "adrianeyre/web-shop";
const floorId = "web-shop";

const skillFiles: SkillFile[] = [
  {
    path: "SKILL.md",
    content:
      "---\nname: migration-check\ndescription: Checks a change's database migrations can be rolled back.\n---\n\nSay whether each migration can be rolled back.\n",
  },
];

/** A promise, and the functions that settle it. */
const deferred = <Value>() => {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<Value>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

async function setUp() {
  let clock = new Date("2026-11-24T10:00:00Z");
  const now = () => clock;
  const stores = memoryStores();
  const bus = createEventBus({ store: memoryEventStore(), now });
  const github = createFakeGitHub();
  github.installRepository(repository);
  await createFloors({ store: stores.floors, github, events: bus, now }).add(
    repository,
  );
  const team = await stores.agents.list(floorId);
  const agentOf = (role: string) => {
    const agent = team.find((each) => each.role === role);
    if (agent === undefined) {
      throw new Error(`A new Floor has a ${role}.`);
    }
    return agent;
  };
  await stores.skills.add({
    id: "skill-1",
    name: "migration-check",
    description: "Checks a change's database migrations can be rolled back.",
    source: "editor",
    origin: null,
    files: skillFiles,
    digest: skillDigest(skillFiles),
    enabled: true,
    reviewedAt: now(),
    createdAt: now(),
    updatedAt: now(),
  });
  const skills = createFloorSkills({
    floors: stores.floors,
    library: stores.skills,
    roles: stores.roles,
    toggles: stores.floorSkills,
    events: bus,
    reviews: stores.repositorySkillReviews,
    github,
    now,
  });
  // Issues #1 to #10, which the scenarios move between Stages.
  for (let number = 1; number <= 10; number += 1) {
    github.createIssue(repository, { title: `Issue ${String(number)}` });
  }
  const notices = createNotices({ store: stores.notices, events: bus, now });
  const calls: ModelRequest[] = [];
  let answer: (request: ModelRequest) => Promise<ModelReply> = () =>
    Promise.resolve({
      text: "Both migrations can be rolled back.",
      stopReason: "end_turn",
    });
  const models: ModelClient = {
    complete(request) {
      calls.push(request);
      return answer(request);
    },
    stream() {
      return Promise.reject(new Error("Hooks do not stream."));
    },
  };
  const errors: unknown[] = [];
  const runner = createHookRunner({
    floors: stores.floors,
    agents: stores.agents,
    roles: stores.roles,
    store: stores.hooks,
    events: bus,
    github,
    skills,
    models,
    notices,
    now,
    pushPollMs: 0,
    onError: (error) => errors.push(error),
  });
  const stop = await runner.start();
  const admin = createHooksAdmin({
    floors: stores.floors,
    agents: stores.agents,
    roles: stores.roles,
    store: stores.hooks,
    skills,
    runner,
    events: bus,
    now,
  });
  const published: OfficeEvent[] = [];
  bus.subscribe(({ event }) => {
    published.push(event);
  });
  const client = github.repository(repository);

  const addHook = async (input: Partial<HookInputRequest> = {}) => {
    const list = await admin.create(
      floorId,
      hookInputSchema.parse({
        name: "Migration check",
        trigger: "pull_request_opened",
        role: "reviewer",
        skillName: "migration-check",
        ...input,
      }),
    );
    const hook = list.hooks.at(-1);
    if (hook === undefined) {
      throw new Error("The Hook was added.");
    }
    await runner.idle();
    return hook;
  };

  /** Publishes an event as the pipeline would, and waits for the Hooks it sets off. */
  const happen = async (event: OfficeEvent) => {
    await bus.publish(event);
    await runner.idle();
  };

  /** An issue moving to a Stage, as the pipeline moves it. */
  const moveTo = (issue: number, to: string) =>
    happen({
      type: "issue.label_changed",
      version: 1,
      floorId,
      issue,
      from: "needs-work",
      to,
    });

  /** An issue's pull request, with `files`, as the App opens it. */
  const openPullRequest = async (
    issue: number,
    files: Readonly<Record<string, string>>,
    options: { readonly announce?: boolean } = {},
  ) => {
    const branch = `ai-office/${String(issue)}-change`;
    github.pushCommit(repository, branch, { files });
    const pullRequest = await client.createPullRequest({
      title: `Change ${String(issue)}`,
      body: `Closes #${String(issue)}`,
      head: branch,
      base: "main",
    });
    if (options.announce !== false) {
      await happen({
        type: "pull_request.opened",
        version: 1,
        floorId,
        agentId: agentOf("coder").id,
        issue,
        pullRequest: pullRequest.number,
        url: pullRequest.htmlUrl,
        branch,
      });
    }
    return pullRequest;
  };

  const runsOf = (hookId: number) =>
    [...stores.hooks.hookRuns.values()].filter((run) => run.hookId === hookId);
  const ofType = <Type extends OfficeEvent["type"]>(type: Type) =>
    published.filter(
      (event): event is Extract<OfficeEvent, { type: Type }> =>
        event.type === type,
    );

  return {
    stores,
    bus,
    github,
    client,
    runner,
    admin,
    notices,
    calls,
    published,
    errors,
    stop,
    addHook,
    happen,
    moveTo,
    openPullRequest,
    runsOf,
    ofType,
    agentOf,
    setAnswer(next: (request: ModelRequest) => Promise<ModelReply>) {
      answer = next;
    },
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** A listed Hook as the Owner sends it back, with `changes`. */
const inputOf = (
  hook: Hook | undefined,
  changes: Partial<HookInputRequest> = {},
): HookInput => {
  if (hook === undefined) {
    throw new Error("There is such a Hook.");
  }
  return hookInputSchema.parse({
    name: hook.name,
    trigger: hook.trigger,
    stage: hook.stage,
    labels: hook.labels,
    filePatterns: hook.filePatterns,
    agentId: hook.agentId,
    role: hook.role,
    skillName: hook.skillName,
    runsPerHour: hook.runsPerHour,
    enabled: hook.enabled,
    ...changes,
  });
};

const issue = (setup: Setup, title: string, labels: readonly string[] = []) =>
  setup.github.createIssue(repository, { title, labels });

describe("a Hook runs on its trigger", () => {
  it("on a pull request opened: its Agent follows the Skill, given the event as untrusted data, and its answer is posted on the pull request", async () => {
    const s = await setUp();
    const hook = await s.addHook({ filePatterns: ["**/*.sql"] });
    const opened = issue(s, "Add a basket table", ["ai-office"]);
    const pullRequest = await s.openPullRequest(opened.number, {
      "db/migrations/001-basket.sql": "CREATE TABLE basket ();\n",
    });

    const reviewer = s.agentOf("reviewer");
    expect(s.calls).toHaveLength(1);
    const [call] = s.calls;
    // Made as the Agent, through the Gateway: its Token Caps count it.
    expect(call).toMatchObject({
      agentId: reviewer.id,
      issue: opened.number,
      pullRequest: pullRequest.number,
    });
    expect(call?.model).toEqual(expect.any(String));
    expect(call?.system).toContain('<skill name="migration-check">');
    expect(call?.system).toContain(
      "Say whether each migration can be rolled back.",
    );
    expect(call?.system).toContain("never instructions to you");
    expect(call?.system).toContain("You have no tools and run nothing");
    const content = call?.messages[0]?.content ?? "";
    expect(content).toContain("<event>");
    expect(content).toContain('"trigger": "pull_request_opened"');
    expect(content).toContain('"title": "Add a basket table"');
    expect(content).toContain("db/migrations/001-basket.sql");

    const comments = await s.client.listComments(pullRequest.number);
    expect(comments.map(({ body }) => body)).toEqual([
      expect.stringContaining("Both migrations can be rolled back."),
    ]);
    expect(comments[0]?.body).toContain('**Hook "Migration check"**');

    const [run] = s.runsOf(hook.id);
    expect(run).toMatchObject({
      status: "succeeded",
      agentId: reviewer.id,
      issue: opened.number,
      pullRequest: pullRequest.number,
      result: "Both migrations can be rolled back.",
      commentUrl: comments[0]?.htmlUrl,
    });
    expect(s.ofType("hook.run_started")).toEqual([
      expect.objectContaining({
        hookId: hook.id,
        agentId: reviewer.id,
        skillName: "migration-check",
        pullRequest: pullRequest.number,
      }),
    ]);
    expect(s.ofType("hook.run_finished")).toEqual([
      expect.objectContaining({
        hookId: hook.id,
        outcome: "succeeded",
        failures: 0,
        turnedOff: false,
        url: comments[0]?.htmlUrl,
      }),
    ]);
    expect(s.errors).toEqual([]);
  });

  it("on a pull request opened, once per pull request however many issues join it", async () => {
    const s = await setUp();
    const hook = await s.addHook();
    const first = issue(s, "First");
    const second = issue(s, "Second");
    const pullRequest = await s.openPullRequest(first.number, {
      "a.txt": "a\n",
    });
    // The next issue of a One-pull-request Batch joins the same one.
    await s.happen({
      type: "pull_request.opened",
      version: 1,
      floorId,
      agentId: s.agentOf("coder").id,
      issue: second.number,
      pullRequest: pullRequest.number,
      url: pullRequest.htmlUrl,
      branch: `ai-office/${String(first.number)}-change`,
    });
    expect(s.runsOf(hook.id)).toHaveLength(1);
  });

  it("on an issue moving to the Stage it watches, posting on the issue, and not on another Stage", async () => {
    const s = await setUp();
    const hook = await s.addHook({
      name: "QA notes",
      trigger: "stage",
      stage: "needs-qa",
      role: "qa",
    });
    const opened = issue(s, "Add a basket");
    await s.moveTo(opened.number, "needs-review");
    expect(s.calls).toEqual([]);
    await s.moveTo(opened.number, "needs-qa");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]?.agentId).toBe(s.agentOf("qa").id);
    expect(s.calls[0]?.messages[0]?.content).toContain('"stage": "needs-qa"');
    const comments = await s.client.listComments(opened.number);
    expect(comments).toHaveLength(1);
    expect(s.runsOf(hook.id)[0]).toMatchObject({
      status: "succeeded",
      issue: opened.number,
      pullRequest: null,
    });
  });

  it("on a push to the default branch touching matching files, from where it stood when the Hook was added", async () => {
    const s = await setUp();
    const hook = await s.addHook({
      name: "Schema watch",
      trigger: "push",
      filePatterns: ["db/**"],
    });
    s.github.pushCommit(repository, "main", {
      files: { "README.md": "# Web shop\n" },
    });
    await s.happen({
      type: "repository.changed",
      version: 1,
      floorId,
      change: "push",
    });
    expect(s.calls).toEqual([]);
    const head = s.github.pushCommit(repository, "main", {
      files: { "db/schema.sql": "CREATE TABLE basket ();\n" },
    });
    await s.happen({
      type: "repository.changed",
      version: 1,
      floorId,
      change: "push",
    });
    expect(s.calls).toHaveLength(1);
    const content = s.calls[0]?.messages[0]?.content ?? "";
    expect(content).toContain('"trigger": "push"');
    expect(content).toContain(`"after": "${head}"`);
    expect(content).toContain("db/schema.sql");
    expect(content).not.toContain("README.md");
    // Nothing to post it on: it is kept with the run.
    expect(s.runsOf(hook.id)[0]).toMatchObject({
      status: "succeeded",
      result: "Both migrations can be rolled back.",
      commentUrl: null,
    });
    // The same head is not a push again.
    await s.happen({
      type: "repository.changed",
      version: 1,
      floorId,
      change: "push",
    });
    expect(s.calls).toHaveLength(1);
  });

  it("on a Batch's Wrap-up and on a Spec's issues filed", async () => {
    const s = await setUp();
    const wrapUp = await s.addHook({
      name: "Release notes",
      trigger: "wrap_up",
      role: "docs",
    });
    const spec = await s.addHook({
      name: "Spec review",
      trigger: "spec_filed",
      role: "reviewer",
    });
    const manager = s.agentOf("manager").id;
    await s.happen({
      type: "batch.finished",
      version: 1,
      floorId,
      batchId: 3,
      agentId: manager,
      agentIds: [],
      issues: [1, 2],
      merged: 2,
      closed: 0,
      blocked: 0,
      notStarted: 0,
      tokens: 1200,
    });
    // A Floor without a docs Agent: the Hook's run fails, saying so.
    expect(s.runsOf(wrapUp.id)[0]).toMatchObject({
      status: "failed",
      agentId: null,
      error: "The Floor has no Agent in the docs Role to run it.",
    });
    await s.happen({
      type: "batch.planned",
      version: 1,
      floorId,
      batchId: 4,
      planVersion: 1,
      agentId: manager,
      draftedBy: "rules",
      issues: [5, 6],
      specSessionId: 2,
    });
    expect(s.runsOf(spec.id)).toHaveLength(1);
    expect(s.calls.at(-1)?.messages[0]?.content).toContain(
      '"specSessionId": 2',
    );
    // A Plan not filed from a Spec is not a Spec's issues filed.
    await s.happen({
      type: "batch.planned",
      version: 1,
      floorId,
      batchId: 5,
      planVersion: 1,
      agentId: manager,
      draftedBy: "rules",
      issues: [7],
    });
    expect(s.runsOf(spec.id)).toHaveLength(1);
  });

  it("with Run now, when the Owner presses it, and only a Run now Hook that is on", async () => {
    const s = await setUp();
    const hook = await s.addHook({
      name: "Weekly tidy",
      trigger: "run_now",
      agentId: s.agentOf("coder").id,
      role: null,
    });
    const started = await s.admin.runNow(floorId, hook.id);
    expect(started.run).toMatchObject({
      status: "running",
      agentId: s.agentOf("coder").id,
      agentName: s.agentOf("coder").name,
    });
    await s.runner.idle();
    expect(s.runsOf(hook.id)[0]?.status).toBe("succeeded");

    const other = await s.addHook({ name: "Other" });
    await expect(s.admin.runNow(floorId, other.id)).rejects.toMatchObject({
      code: "hook_not_run_now",
    });
    await s.admin.update(floorId, hook.id, inputOf(hook, { enabled: false }));
    await expect(s.admin.runNow(floorId, hook.id)).rejects.toMatchObject({
      code: "hook_disabled",
    });
  });

  it("not while it is off, nor on an archived Floor", async () => {
    const s = await setUp();
    const hook = await s.addHook({ trigger: "stage", stage: "needs-review" });
    await s.admin.update(floorId, hook.id, inputOf(hook, { enabled: false }));
    await s.moveTo(1, "needs-review");
    expect(s.calls).toEqual([]);
    await s.admin.update(floorId, hook.id, inputOf(hook, { enabled: true }));
    await s.stores.floors.archive(floorId, new Date());
    await s.moveTo(1, "needs-review");
    expect(s.calls).toEqual([]);
  });
});

describe("a Hook honours its filters", () => {
  it("by label: the issue carries one of its labels", async () => {
    const s = await setUp();
    const hook = await s.addHook({
      trigger: "stage",
      stage: "needs-review",
      labels: ["database", "api"],
    });
    const plain = issue(s, "Copy change", ["ai-office"]);
    const labelled = issue(s, "New table", ["ai-office", "database"]);
    await s.moveTo(plain.number, "needs-review");
    expect(s.runsOf(hook.id)).toEqual([]);
    await s.moveTo(labelled.number, "needs-review");
    expect(s.runsOf(hook.id).map(({ issue: number }) => number)).toEqual([
      labelled.number,
    ]);
  });

  it("by file pattern: the pull request changes a matching file", async () => {
    const s = await setUp();
    const hook = await s.addHook({ filePatterns: ["**/*.sql"] });
    const copy = issue(s, "Copy change");
    await s.openPullRequest(copy.number, { "src/copy.ts": "export {};\n" });
    expect(s.runsOf(hook.id)).toEqual([]);
    const table = issue(s, "New table");
    await s.openPullRequest(table.number, {
      "db/002-orders.sql": "CREATE TABLE orders ();\n",
    });
    expect(s.runsOf(hook.id)).toHaveLength(1);
  });

  it("by file pattern on a Stage: the files of the issue's pull request", async () => {
    const s = await setUp();
    const hook = await s.addHook({
      trigger: "stage",
      stage: "needs-qa",
      filePatterns: ["db/**"],
    });
    const without = issue(s, "No pull request yet");
    await s.moveTo(without.number, "needs-qa");
    expect(s.runsOf(hook.id)).toEqual([]);
    const table = issue(s, "New table");
    await s.openPullRequest(table.number, {
      "db/003-items.sql": "CREATE TABLE items ();\n",
    });
    await s.moveTo(table.number, "needs-qa");
    expect(s.runsOf(hook.id)).toHaveLength(1);
  });

  it("by label on a Wrap-up: one of the Batch's issues carries it", async () => {
    const s = await setUp();
    const hook = await s.addHook({
      trigger: "wrap_up",
      labels: ["release"],
    });
    const plain = issue(s, "Plain");
    const release = issue(s, "Release", ["release"]);
    const finished = (issues: number[]): OfficeEvent => ({
      type: "batch.finished",
      version: 1,
      floorId,
      batchId: issues[0] ?? 1,
      agentId: s.agentOf("manager").id,
      agentIds: [],
      issues,
      merged: issues.length,
      closed: 0,
      blocked: 0,
      notStarted: 0,
      tokens: 10,
    });
    await s.happen(finished([plain.number]));
    expect(s.runsOf(hook.id)).toEqual([]);
    await s.happen(finished([plain.number, release.number]));
    expect(s.runsOf(hook.id)).toHaveLength(1);
  });
});

describe("a Hook's limits", () => {
  it("rate-limits: at most its runs an hour, each one past them skipped, saying so", async () => {
    const s = await setUp();
    const hook = await s.addHook({
      trigger: "stage",
      stage: "needs-review",
      runsPerHour: 2,
    });
    for (const number of [1, 2, 3]) {
      await s.moveTo(number, "needs-review");
    }
    expect(s.runsOf(hook.id).map(({ issue: number }) => number)).toEqual([
      1, 2,
    ]);
    expect(s.ofType("hook.run_skipped")).toEqual([
      expect.objectContaining({
        hookId: hook.id,
        issue: 3,
        reason: "rate_limited",
      }),
    ]);
    // An hour after the first, it may run again.
    s.advance(60 * 60 * 1000);
    await s.moveTo(4, "needs-review");
    expect(s.runsOf(hook.id)).toHaveLength(3);
  });

  it("rate-limits Run now too, refusing it", async () => {
    const s = await setUp();
    const hook = await s.addHook({
      trigger: "run_now",
      runsPerHour: 1,
    });
    await s.admin.runNow(floorId, hook.id);
    await s.runner.idle();
    await expect(s.admin.runNow(floorId, hook.id)).rejects.toMatchObject({
      code: "hook_rate_limited",
    });
  });

  it("skips a run already going on the same issue, and runs on another", async () => {
    const s = await setUp();
    const hook = await s.addHook({ trigger: "stage", stage: "needs-review" });
    const answer = deferred<ModelReply>();
    s.setAnswer(() => answer.promise);
    await s.bus.publish({
      type: "issue.label_changed",
      version: 1,
      floorId,
      issue: 1,
      from: "needs-work",
      to: "needs-review",
    });
    // Let the first run start, then the issue comes back to review.
    while (s.runsOf(hook.id).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await s.bus.publish({
      type: "issue.label_changed",
      version: 1,
      floorId,
      issue: 1,
      from: "needs-work",
      to: "needs-review",
    });
    await s.bus.publish({
      type: "issue.label_changed",
      version: 1,
      floorId,
      issue: 2,
      from: "needs-work",
      to: "needs-review",
    });
    answer.resolve({ text: "Done.", stopReason: "end_turn" });
    await s.runner.idle();
    expect(s.runsOf(hook.id).map(({ issue: number }) => number)).toEqual([
      1, 2,
    ]);
    expect(s.ofType("hook.run_skipped")).toEqual([
      expect.objectContaining({ issue: 1, reason: "already_running" }),
    ]);
    // Once it has ended, the same issue runs it again.
    await s.moveTo(1, "needs-review");
    expect(s.runsOf(hook.id)).toHaveLength(3);
  });

  it("refuses Run now while a run of it is going", async () => {
    const s = await setUp();
    const hook = await s.addHook({ trigger: "run_now" });
    const answer = deferred<ModelReply>();
    s.setAnswer(() => answer.promise);
    await s.admin.runNow(floorId, hook.id);
    await expect(s.admin.runNow(floorId, hook.id)).rejects.toMatchObject({
      code: "hook_running",
    });
    answer.resolve({ text: "Done.", stopReason: "end_turn" });
    await s.runner.idle();
  });

  it("gives a Role's Hook to its least busy Agent", async () => {
    const s = await setUp();
    const hook = await s.addHook({ trigger: "stage", stage: "needs-review" });
    const first = s.agentOf("reviewer");
    const second = { ...first, id: "reviewer-2", name: "Second reviewer" };
    await s.stores.agents.create({ ...second, createdAt: new Date() });
    const answer = deferred<ModelReply>();
    s.setAnswer(() => answer.promise);
    await s.bus.publish({
      type: "issue.label_changed",
      version: 1,
      floorId,
      issue: 1,
      from: "needs-work",
      to: "needs-review",
    });
    while (s.runsOf(hook.id).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await s.bus.publish({
      type: "issue.label_changed",
      version: 1,
      floorId,
      issue: 2,
      from: "needs-work",
      to: "needs-review",
    });
    answer.resolve({ text: "Done.", stopReason: "end_turn" });
    await s.runner.idle();
    expect(s.runsOf(hook.id).map(({ agentId }) => agentId)).toEqual([
      first.id,
      "reviewer-2",
    ]);
  });
});

describe("a Hook never fires on an event its own run caused", () => {
  it("ignores what its run sets off, while another Hook still runs on it", async () => {
    const s = await setUp();
    const own = await s.addHook({
      name: "Own",
      trigger: "stage",
      stage: "needs-review",
    });
    const other = await s.addHook({
      name: "Other",
      trigger: "stage",
      stage: "needs-qa",
      role: "qa",
    });
    let caused = false;
    s.setAnswer(async (request) => {
      if (!caused && request.agentId === s.agentOf("reviewer").id) {
        caused = true;
        // Something the run went on to cause, such as an issue moving on.
        await s.bus.publish({
          type: "issue.label_changed",
          version: 1,
          floorId,
          issue: 1,
          from: "needs-qa",
          to: "needs-review",
        });
        await s.bus.publish({
          type: "issue.label_changed",
          version: 1,
          floorId,
          issue: 1,
          from: "needs-review",
          to: "needs-qa",
        });
      }
      return { text: "Done.", stopReason: "end_turn" };
    });
    await s.moveTo(1, "needs-review");
    await s.runner.idle();
    expect(caused).toBe(true);
    // Its own run's event set off the other Hook, never itself.
    expect(s.runsOf(own.id)).toHaveLength(1);
    expect(s.runsOf(other.id)).toHaveLength(1);
    // The same event from anywhere else still runs it.
    await s.moveTo(2, "needs-review");
    expect(s.runsOf(own.id)).toHaveLength(2);
  });

  it("does not run itself again by way of another Hook's run", async () => {
    const s = await setUp();
    const first = await s.addHook({
      name: "First",
      trigger: "stage",
      stage: "needs-review",
    });
    const second = await s.addHook({
      name: "Second",
      trigger: "stage",
      stage: "needs-qa",
      role: "qa",
    });
    // Each run moves the issue to the other Hook's Stage.
    s.setAnswer(async (request) => {
      await s.bus.publish({
        type: "issue.label_changed",
        version: 1,
        floorId,
        issue: 1,
        from: null,
        to:
          request.agentId === s.agentOf("qa").id ? "needs-review" : "needs-qa",
      });
      return { text: "Done.", stopReason: "end_turn" };
    });
    await s.moveTo(1, "needs-review");
    await s.runner.idle();
    expect(s.runsOf(first.id)).toHaveLength(1);
    expect(s.runsOf(second.id)).toHaveLength(1);
  });
});

describe("a Hook's failed runs", () => {
  it("raise an info Notice each, and three in a row turn it off with an action Notice", async () => {
    const s = await setUp();
    const hook = await s.addHook({ trigger: "stage", stage: "needs-review" });
    s.setAnswer(() =>
      Promise.reject(
        new ModelCallError(
          429,
          "The daily Token Cap of this Agent is reached.",
        ),
      ),
    );
    for (const number of [1, 2]) {
      await s.moveTo(number, "needs-review");
    }
    expect((await s.stores.hooks.get(floorId, hook.id))?.failures).toBe(2);
    let open = await s.notices.open({ floorId });
    const reviewer = s.agentOf("reviewer").name;
    expect(
      open
        .map(({ kind, title }) => ({ kind, title }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    ).toEqual(
      [1, 2].map((number) => ({
        kind: "info",
        title: `The Hook "Migration check" failed on #${String(number)} on web-shop: The AI Gateway did not answer ${reviewer}'s call: The daily Token Cap of this Agent is reached.`,
      })),
    );

    await s.moveTo(3, "needs-review");
    const after = await s.stores.hooks.get(floorId, hook.id);
    expect(after).toMatchObject({ enabled: false, failures: 3 });
    expect(
      s.ofType("hook.run_finished").map((event) => event.turnedOff),
    ).toEqual([false, false, true]);
    expect(s.ofType("hook.changed")).toEqual([
      expect.objectContaining({
        hookId: hook.id,
        fields: ["enabled"],
        by: "failures",
        enabled: false,
      }),
    ]);
    open = await s.notices.open({ floorId });
    const action = open.find(({ kind }) => kind === "action");
    expect(action).toMatchObject({
      title:
        'The Hook "Migration check" on web-shop is off: its last 3 runs failed',
      actions: [
        {
          id: openHooksAction,
          label: "Open Hooks",
          href: "/floor-settings/web-shop#hooks",
        },
      ],
    });

    // Off, it runs no more.
    s.setAnswer(() =>
      Promise.resolve({ text: "Fine.", stopReason: "end_turn" }),
    );
    await s.moveTo(4, "needs-review");
    expect(s.runsOf(hook.id)).toHaveLength(3);

    // The Notice stays until the Owner turns it on again.
    await expect(
      s.notices.act(action?.id ?? "", openHooksAction),
    ).rejects.toThrow('"Migration check" is still off');
    const turnedOn = await s.admin.update(
      floorId,
      hook.id,
      inputOf(hook, { enabled: true }),
    );
    expect(turnedOn.hooks[0]).toMatchObject({ enabled: true, failures: 0 });
    await s.notices.act(action?.id ?? "", openHooksAction);
    await s.moveTo(4, "needs-review");
    expect(s.runsOf(hook.id)).toHaveLength(4);
  });

  it("start counting again after a run succeeds", async () => {
    const s = await setUp();
    const hook = await s.addHook({ trigger: "stage", stage: "needs-review" });
    let fail = true;
    s.setAnswer(() =>
      fail
        ? Promise.reject(new Error("The Gateway is down."))
        : Promise.resolve({ text: "Fine.", stopReason: "end_turn" }),
    );
    await s.moveTo(1, "needs-review");
    await s.moveTo(2, "needs-review");
    fail = false;
    await s.moveTo(3, "needs-review");
    fail = true;
    await s.moveTo(4, "needs-review");
    await s.moveTo(5, "needs-review");
    expect(await s.stores.hooks.get(floorId, hook.id)).toMatchObject({
      enabled: true,
      failures: 2,
    });
  });

  it("fail, saying why, when its Agent left the Floor or its Skill is gone, and never put a credential in a Notice", async () => {
    const s = await setUp();
    const coder = s.agentOf("coder");
    const named = await s.addHook({
      name: "Named",
      trigger: "stage",
      stage: "needs-review",
      agentId: coder.id,
      role: null,
    });
    await s.stores.agents.remove(floorId, coder.id, new Date());
    await s.moveTo(1, "needs-review");
    expect(s.runsOf(named.id)[0]).toMatchObject({
      status: "failed",
      error:
        "The Agent it names is no longer on the Floor: choose another in the Hooks card.",
    });

    const gone = await s.addHook({
      name: "Gone",
      trigger: "stage",
      stage: "needs-qa",
    });
    await s.stores.skills.remove("skill-1");
    await s.moveTo(2, "needs-qa");
    expect(s.runsOf(gone.id)[0]?.error).toContain(
      "The Floor's Skill /migration-check could not be read",
    );

    const secret = `sk-ant-api03-${"x".repeat(40)}`;
    s.setAnswer(() => Promise.reject(new Error(`Refused ${secret}`)));
    await s.stores.skills.add({
      id: "skill-2",
      name: "migration-check",
      description: "Again.",
      source: "editor",
      origin: null,
      files: skillFiles,
      digest: skillDigest(skillFiles),
      enabled: true,
      reviewedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await s.moveTo(3, "needs-qa");
    const notices = await s.notices.open({ floorId });
    expect(notices.map(({ title }) => title).join("\n")).not.toContain(secret);
    expect(JSON.stringify([...s.stores.hooks.hookRuns.values()])).not.toContain(
      secret,
    );
  });
});

describe("the Hooks admin", () => {
  it("adds, changes, turns off and deletes a Hook, each an event", async () => {
    const s = await setUp();
    const hook = await s.addHook();
    expect(hook).toMatchObject({
      name: "Migration check",
      trigger: "pull_request_opened",
      role: "reviewer",
      agentId: null,
      runsPerHour: 12,
      enabled: true,
      failures: 0,
      runs: [],
    });
    const changed = await s.admin.update(
      floorId,
      hook.id,
      inputOf(hook, { filePatterns: ["**/*.sql"], runsPerHour: 4 }),
    );
    expect(changed.hooks[0]).toMatchObject({
      filePatterns: ["**/*.sql"],
      runsPerHour: 4,
    });
    await s.admin.update(
      floorId,
      hook.id,
      inputOf(changed.hooks[0], { enabled: false }),
    );
    // Nothing changed: no event.
    await s.admin.update(
      floorId,
      hook.id,
      inputOf(changed.hooks[0], { enabled: false }),
    );
    const removed = await s.admin.remove(floorId, hook.id);
    expect(removed.hooks).toEqual([]);
    expect(
      s.published
        .filter(({ type }) => type.startsWith("hook."))
        .map((event) =>
          event.type === "hook.changed"
            ? { type: event.type, fields: event.fields, enabled: event.enabled }
            : { type: event.type },
        ),
    ).toEqual([
      { type: "hook.added" },
      {
        type: "hook.changed",
        fields: ["filePatterns", "runsPerHour"],
        enabled: true,
      },
      { type: "hook.changed", fields: ["enabled"], enabled: false },
      { type: "hook.removed" },
    ]);
  });

  it("lists the Skills a Hook can run, never one that starts a Grilling Session", async () => {
    const s = await setUp();
    const list = await s.admin.list(floorId);
    const names = list.skills.map(({ name }) => name);
    expect(names).toContain("migration-check");
    expect(names).toContain("pr");
    expect(names).not.toContain("grilling");
    expect(names).not.toContain("spec");
  });

  it("refuses an Agent, Role or Skill the Floor does not have, a name taken, and an unknown Hook", async () => {
    const s = await setUp();
    const parse = (input: Partial<HookInputRequest>) =>
      hookInputSchema.parse({
        name: "Check",
        trigger: "run_now",
        role: "reviewer",
        skillName: "migration-check",
        ...input,
      });
    await expect(
      s.admin.create(floorId, parse({ agentId: "nobody", role: null })),
    ).rejects.toMatchObject({ code: "hook_invalid" });
    await expect(
      s.admin.create(
        floorId,
        parse({ agentId: s.agentOf("manager").id, role: null }),
      ),
    ).rejects.toMatchObject({
      code: "hook_invalid",
      message: "The Manager does not run Hooks.",
    });
    await expect(
      s.admin.create(floorId, parse({ role: "astronaut" })),
    ).rejects.toMatchObject({ code: "hook_invalid" });
    await expect(
      s.admin.create(floorId, parse({ skillName: "no-such-skill" })),
    ).rejects.toMatchObject({
      code: "hook_invalid",
      message: "web-shop has no Skill /no-such-skill a Hook can run.",
    });
    await expect(
      s.admin.create(floorId, parse({ skillName: "grilling" })),
    ).rejects.toMatchObject({ code: "hook_invalid" });
    const hook = (await s.admin.create(floorId, parse({}))).hooks[0];
    await expect(
      s.admin.create(floorId, parse({ name: "CHECK" })),
    ).rejects.toMatchObject({ code: "hook_name_taken" });
    await expect(s.admin.update(floorId, 999, parse({}))).rejects.toMatchObject(
      { code: "hook_not_found" },
    );
    await expect(s.admin.remove(floorId, 999)).rejects.toMatchObject({
      code: "hook_not_found",
    });
    await expect(s.admin.list("no-such-floor")).rejects.toMatchObject({
      code: "floor_not_found",
    });
    // A Hook whose Skill has gone can still be turned off.
    await s.stores.skills.remove("skill-1");
    const off = await s.admin.update(
      floorId,
      hook?.id ?? 0,
      parse({ enabled: false }),
    );
    expect(off.hooks[0]?.enabled).toBe(false);
  });

  it("changes nothing on an archived Floor", async () => {
    const s = await setUp();
    await s.stores.floors.archive(floorId, new Date());
    await expect(
      s.admin.create(
        floorId,
        hookInputSchema.parse({
          name: "Check",
          trigger: "run_now",
          role: "reviewer",
          skillName: "migration-check",
        }),
      ),
    ).rejects.toMatchObject({ code: "floor_archived" });
  });
});
