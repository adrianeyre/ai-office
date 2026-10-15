import {
  createEventBus,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import type { GitHubApp } from "@ai-office/github";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import { createRedactor } from "@ai-office/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProgressComments,
  progressMarker,
  type ProgressComments,
  type ProgressCommentsOptions,
  type ProgressSubject,
} from "./progress.ts";

// Progress comments (PRD FR-21): one comment per issue, edited in place at
// most once a minute, with a final summary. Timers and the clock are fake,
// so minutes pass at once.

const repository = "adrianeyre/web-shop";
const start = new Date("2026-10-09T09:00:00.000Z");
const minute = 60_000;

interface Setup {
  readonly fake: FakeGitHub;
  readonly bus: EventBus;
  readonly progress: ProgressComments;
  /** When each comment was created or edited, in ms since `start`. */
  readonly writes: { kind: "create" | "edit"; at: number }[];
  readonly errors: unknown[];
  readonly subject: ProgressSubject;
}

/** The fake GitHub, noting when each comment is created or edited. */
function recording(
  fake: FakeGitHub,
  writes: Setup["writes"],
  failing: { now: boolean; slowMs?: number },
): GitHubApp {
  const slowly = () =>
    failing.slowMs === undefined
      ? Promise.resolve()
      : new Promise((resolve) => setTimeout(resolve, failing.slowMs));
  const at = () => Date.now() - start.getTime();
  return {
    installations: () => fake.installations(),
    repositories: () => fake.repositories(),
    repository(fullName) {
      const client = fake.repository(fullName);
      return {
        ...client,
        createComment(issue, body) {
          if (failing.now) {
            return Promise.reject(new Error("GitHub is down."));
          }
          writes.push({ kind: "create", at: at() });
          return slowly().then(() => client.createComment(issue, body));
        },
        updateComment(id, body) {
          if (failing.now) {
            return Promise.reject(new Error("GitHub is down."));
          }
          writes.push({ kind: "edit", at: at() });
          return slowly().then(() => client.updateComment(id, body));
        },
      };
    },
  };
}

const failing: { now: boolean; slowMs?: number } = { now: false };

function setUp(options: Partial<ProgressCommentsOptions> = {}): Setup {
  const fake = createFakeGitHub();
  fake.installRepository(repository);
  fake.createIssue(repository, {
    title: "Add a basket",
    labels: ["ai-office"],
  });
  const writes: Setup["writes"] = [];
  const errors: unknown[] = [];
  const bus = createEventBus({ store: memoryEventStore() });
  const progress = createProgressComments({
    github: recording(fake, writes, failing),
    events: bus,
    publicUrl: "https://office.example.com",
    onError: (error) => errors.push(error),
    ...options,
  });
  return {
    fake,
    bus,
    progress,
    writes,
    errors,
    subject: {
      floor: { id: "web-shop", repository },
      issue: 1,
      agent: { id: "ada", name: "Ada", role: "coder" },
      stage: "needs-work",
    },
  };
}

/** The Agent's `n`th step, as the sandbox runner publishes it. */
const step = (bus: EventBus, n: number) =>
  bus.publish({
    type: "sandbox.tool_call",
    version: 1,
    floorId: "web-shop",
    agentId: "ada",
    issue: 1,
    sandboxId: "sbx-1",
    name: "Bash",
    args: `step ${String(n)}`,
  });

const comments = async (setup: Setup) =>
  setup.fake.repository(repository).listComments(1);

/** Each write at least a minute after the one before. */
const spacedByAMinute = (writes: Setup["writes"]) =>
  writes.every(
    (write, index) =>
      index === 0 || write.at - (writes[index - 1]?.at ?? 0) >= minute,
  );

beforeEach(() => {
  vi.useFakeTimers({ now: start });
  failing.now = false;
  delete failing.slowMs;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("progress comments", () => {
  it("turns fifty events into one comment, edited at most once a minute", async () => {
    const setup = setUp();
    const comment = setup.progress.start(setup.subject);
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.writes).toEqual([{ kind: "create", at: 0 }]);

    // Fifty steps, one every three seconds: two and a half minutes.
    for (let n = 1; n <= 50; n++) {
      await step(setup.bus, n);
      await vi.advanceTimersByTimeAsync(3000);
    }
    const finished = comment.finish({
      outcome: "pull_request",
      stage: "needs-review",
      pullRequest: {
        number: 2,
        url: "https://github.com/adrianeyre/web-shop/pull/2",
      },
      opened: true,
    });
    await vi.advanceTimersByTimeAsync(2 * minute);
    await finished;

    // One comment, created once, then edited at the minute marks only.
    const posted = await comments(setup);
    expect(posted).toHaveLength(1);
    expect(setup.writes.filter(({ kind }) => kind === "create")).toHaveLength(
      1,
    );
    expect(setup.writes.map(({ at }) => at)).toEqual([
      0,
      minute,
      2 * minute,
      3 * minute,
    ]);
    expect(spacedByAMinute(setup.writes)).toBe(true);

    // The last edit is the final summary, with the last few steps.
    const body = posted[0]?.body ?? "";
    expect(body.startsWith(progressMarker)).toBe(true);
    expect(body).toContain("### AI Office finished working on this issue");
    expect(body).toContain("- **Stage:** `needs-review`");
    expect(body).toContain(
      "- **Agent:** Ada (coder) · [live view](https://office.example.com/floors/web-shop/agents/ada)",
    );
    expect(body).toContain(
      "- **Pull request:** [#2](https://github.com/adrianeyre/web-shop/pull/2) opened",
    );
    expect(body).toContain("- **Steps taken:** 50");
    expect(body).toContain("5. `Bash step 50`");
    expect(body).toContain("1. `Bash step 46`");
    expect(body).not.toContain("step 45`");

    // Nothing more is written once it is finished.
    await step(setup.bus, 51);
    await vi.advanceTimersByTimeAsync(5 * minute);
    expect(setup.writes).toHaveLength(4);
  });

  it("shows a burst of steps a minute later, in one edit", async () => {
    const setup = setUp();
    setup.progress.start(setup.subject);
    await vi.advanceTimersByTimeAsync(0);
    for (let n = 1; n <= 50; n++) {
      await step(setup.bus, n);
    }
    await vi.advanceTimersByTimeAsync(minute - 1);
    expect(setup.writes).toEqual([{ kind: "create", at: 0 }]);
    const [first] = await comments(setup);
    expect(first?.body).toContain("### AI Office is working on this issue");
    expect(first?.body).toContain("- **Stage:** `needs-work`");
    expect(first?.body).toContain("- **Steps so far:** 0");

    await vi.advanceTimersByTimeAsync(1);
    expect(setup.writes).toEqual([
      { kind: "create", at: 0 },
      { kind: "edit", at: minute },
    ]);
    const [edited] = await comments(setup);
    expect(edited?.body).toContain("- **Steps so far:** 50");
    expect(edited?.body).toContain("**Latest steps**");
    // Quiet work is not written again.
    await vi.advanceTimersByTimeAsync(10 * minute);
    expect(setup.writes).toHaveLength(2);
  });

  it("waits a minute after a slow write before the next, whatever arrives meanwhile", async () => {
    const setup = setUp();
    failing.slowMs = 20_000;
    const comment = setup.progress.start(setup.subject);
    // Steps keep arriving while GitHub takes 20 seconds over each write.
    for (let n = 1; n <= 100; n++) {
      await step(setup.bus, n);
      await vi.advanceTimersByTimeAsync(1000);
    }
    const finished = comment.finish({ outcome: "stopped" });
    await vi.advanceTimersByTimeAsync(5 * minute);
    await finished;

    expect(setup.writes.map(({ at }) => at)).toEqual([0, minute, 2 * minute]);
    expect(spacedByAMinute(setup.writes)).toBe(true);
    expect(await comments(setup)).toHaveLength(1);
  });

  it("follows only its own Agent and issue", async () => {
    const setup = setUp();
    setup.progress.start(setup.subject);
    await setup.bus.publish({
      type: "sandbox.tool_call",
      version: 1,
      floorId: "web-shop",
      agentId: "grace",
      issue: 1,
      sandboxId: "sbx-2",
      name: "Bash",
      args: "someone else",
    });
    await setup.bus.publish({
      type: "sandbox.text",
      version: 1,
      floorId: "web-shop",
      agentId: "ada",
      issue: 2,
      sandboxId: "sbx-3",
      text: "another issue",
    });
    await vi.advanceTimersByTimeAsync(5 * minute);
    expect(setup.writes).toHaveLength(1);
  });

  it("edits the issue's progress comment from an earlier run instead of adding one", async () => {
    const setup = setUp();
    const earlier = await setup.fake
      .repository(repository)
      .createComment(1, `${progressMarker}\nEarlier work.`);
    await setup.fake.repository(repository).createComment(1, "A question.");
    setup.progress.start(setup.subject);
    await vi.advanceTimersByTimeAsync(0);

    expect(setup.writes).toEqual([{ kind: "edit", at: 0 }]);
    const posted = await comments(setup);
    expect(posted.map(({ id }) => id)).toEqual([earlier.id, earlier.id + 1]);
    expect(posted[0]?.body).toContain("AI Office is working on this issue");
  });

  it("says why the Agent is blocked, writing no credential", async () => {
    const setup = setUp({
      redactor: createRedactor({ secrets: ["hunter2-is-the-secret"] }),
    });
    const comment = setup.progress.start(setup.subject);
    await vi.advanceTimersByTimeAsync(0);
    const finished = comment.finish({
      outcome: "blocked",
      reason:
        "Git could not push: `token` hunter2-is-the-secret ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    await vi.advanceTimersByTimeAsync(minute);
    await finished;

    const [posted] = await comments(setup);
    expect(posted?.body).toContain("### AI Office is blocked on this issue");
    expect(posted?.body).toContain(
      "- **Blocked:** `Git could not push: 'token'",
    );
    expect(posted?.body).not.toContain("hunter2-is-the-secret");
    expect(posted?.body).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    );
    expect(setup.writes.map(({ at }) => at)).toEqual([0, minute]);
  });

  it("says what QA found, and where the issue went", async () => {
    const setup = setUp();
    const comment = setup.progress.start({
      ...setup.subject,
      stage: "needs-qa",
    });
    await vi.advanceTimersByTimeAsync(0);
    const finished = comment.finish({
      outcome: "qa",
      passed: false,
      stage: "needs-work",
      pullRequest: {
        number: 2,
        url: "https://github.com/adrianeyre/web-shop/pull/2",
      },
    });
    await vi.advanceTimersByTimeAsync(minute);
    await finished;

    const [posted] = await comments(setup);
    expect(posted?.body).toContain(
      "### AI Office finished working on this issue",
    );
    expect(posted?.body).toContain("- **Stage:** `needs-work`");
    expect(posted?.body).toContain(
      "- **QA:** failed on [#2](https://github.com/adrianeyre/web-shop/pull/2)",
    );
  });

  it("says which work Role the issue was handed on to (FR-25 (1))", async () => {
    const setup = setUp();
    const comment = setup.progress.start(setup.subject);
    await vi.advanceTimersByTimeAsync(0);
    const finished = comment.finish({
      outcome: "handed_on",
      role: "copy*writer*",
    });
    await vi.advanceTimersByTimeAsync(minute);
    await finished;

    const [posted] = await comments(setup);
    expect(posted?.body).toContain(
      "### AI Office finished working on this issue",
    );
    expect(posted?.body).toContain("- **Stage:** `needs-work`");
    expect(posted?.body).toContain(
      "- **Handed on:** to the copywriter, who works on the same branch next",
    );
  });

  it("says what a designer found, and where the issue went", async () => {
    const setup = setUp();
    const comment = setup.progress.start({
      ...setup.subject,
      stage: "needs-qa",
    });
    await vi.advanceTimersByTimeAsync(0);
    const finished = comment.finish({
      outcome: "design",
      approved: false,
      stage: "needs-work",
      pullRequest: {
        number: 2,
        url: "https://github.com/adrianeyre/web-shop/pull/2",
      },
    });
    await vi.advanceTimersByTimeAsync(minute);
    await finished;

    const [posted] = await comments(setup);
    expect(posted?.body).toContain(
      "### AI Office finished working on this issue",
    );
    expect(posted?.body).toContain("- **Stage:** `needs-work`");
    expect(posted?.body).toContain(
      "- **Design:** changes requested on [#2](https://github.com/adrianeyre/web-shop/pull/2)",
    );
  });

  it("keeps the work going when GitHub refuses a write", async () => {
    const setup = setUp();
    failing.now = true;
    const comment = setup.progress.start(setup.subject);
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.errors).toHaveLength(1);

    failing.now = false;
    await step(setup.bus, 1);
    const finished = comment.finish({ outcome: "stopped" });
    await vi.advanceTimersByTimeAsync(minute);
    await finished;
    const posted = await comments(setup);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain("AI Office paused work on this issue");
  });

  it("writes what is pending at once when AI Office stops", async () => {
    const setup = setUp();
    const comment = setup.progress.start(setup.subject);
    await vi.advanceTimersByTimeAsync(0);
    await step(setup.bus, 1);
    void comment.finish({ outcome: "stopped" });
    await vi.advanceTimersByTimeAsync(10_000);
    await setup.progress.stop();

    expect(setup.writes).toEqual([
      { kind: "create", at: 0 },
      { kind: "edit", at: 10_000 },
    ]);
    const [posted] = await comments(setup);
    expect(posted?.body).toContain("AI Office paused work on this issue");
    expect(posted?.body).toContain("- **Steps taken:** 1");
  });
});
