import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import type { ReviewVerdict } from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { createAgents } from "../agents/agents.ts";
import type { AgentRecord } from "../agents/store.ts";
import { createFloors } from "../floors/floors.ts";
import { createNotices, type Notices } from "../notices/notices.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createWorkQueue, type WorkQueue } from "../work/queue.ts";
import {
  databaseWorkQueueStore,
  memoryWorkQueueStore,
  type WorkQueueStore,
} from "../work/store.ts";
import { ManagerAuthorityError, managerGitHub } from "./authority.ts";
import {
  createWatchdog,
  decisionCommentMarker,
  type DecisionRequest,
  type Watchdog,
} from "./watchdog.ts";

// The Manager's watchdog (PRD FR-23) as scenarios: the work queue runs a
// stand-in for each Agent's sandbox, which ends only when told to (or when
// the watchdog stops it), on a clock the test moves. A stuck task is
// reassigned to a free coder; work that keeps stalling or failing is
// retried, then handed to the Owner; an Agent that keeps failing is
// paused; a Review Loop with one round left is escalated; and whatever is
// beyond the Manager's authority (merging, raising a cap, changing
// repository settings) is refused. Each case runs in memory and in
// Postgres 18.

const webShop = "adrianeyre/web-shop";
const start = new Date("2026-10-09T09:00:00.000Z");
const minutes = (count: number) => count * 60_000;

interface Setup {
  readonly github: FakeGitHub;
  readonly stores: OfficeStores;
  readonly workStore: WorkQueueStore;
  readonly bus: EventBus;
  readonly notices: Notices;
  readonly queue: WorkQueue;
  readonly watchdog: Watchdog;
  readonly manager: AgentRecord;
  /** The Floor's two coders, oldest first. */
  readonly ada: AgentRecord;
  readonly alan: AgentRecord;
  /** Each start of work: its issue and Agent, in order. */
  readonly ran: { issue: number; agentId: string | null }[];
  /** Moves the clock on. */
  advance(ms: number): void;
  /** Ends the running work for an issue. */
  finish(issue: number, outcome?: "finished" | "failed"): void;
  /** Opens an issue at `needs-work`, as intake would leave it. */
  openIssue(title: string): number;
  labels(issue: number): Promise<readonly string[]>;
  /** The issue's comments that log the Manager's decisions. */
  decisionComments(issue: number): Promise<string[]>;
  /** Every event of a type, oldest first. */
  eventsOf<Type extends OfficeEvent["type"]>(
    type: Type,
  ): Promise<Extract<OfficeEvent, { type: Type }>[]>;
  /** Pauses an Agent in the Agent editor. */
  pause(agent: AgentRecord): Promise<void>;
  agent(id: string): Promise<AgentRecord | undefined>;
}

async function setUp(
  stores: OfficeStores,
  workStore: WorkQueueStore,
  bus: EventBus,
): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository(webShop);
  let clock = start.getTime();
  const now = () => new Date(clock);
  await createFloors({ store: stores.floors, github, events: bus, now }).add(
    webShop,
  );
  // The default team is a Manager, a coder, a reviewer and QA; add a coder.
  clock += 1000;
  await createAgents({
    store: stores.agents,
    floors: stores.floors,
    events: bus,
    now,
  }).add("web-shop", { role: "coder" });
  const team = await stores.agents.list("web-shop");
  const [manager] = team.filter(({ role }) => role === "manager");
  const [ada, alan] = team.filter(({ role }) => role === "coder");
  if (manager === undefined || ada === undefined || alan === undefined) {
    throw new Error("The Floor's team is not as expected.");
  }

  const ran: { issue: number; agentId: string | null }[] = [];
  const running = new Map<number, (outcome: "finished" | "failed") => void>();
  const notices = createNotices({ store: stores.notices, events: bus, now });
  const queue = createWorkQueue({
    store: workStore,
    agents: stores.agents,
    events: bus,
    limit: () => Promise.resolve(3),
    execute: (work, signal) =>
      new Promise((resolve) => {
        ran.push({ issue: work.issue, agentId: work.agentId });
        running.set(work.issue, resolve);
        signal.addEventListener("abort", () => {
          resolve("failed");
        });
      }),
    now,
  });
  const watchdog = createWatchdog({
    floors: stores.floors,
    agents: stores.agents,
    github,
    queue,
    work: workStore,
    reviews: stores.reviews,
    notices,
    events: bus,
    decisions: stores.decisions,
    limits: { stallTimeoutMs: minutes(20) },
    now,
  });
  const repository = github.repository(webShop);
  return {
    github,
    stores,
    workStore,
    bus,
    notices,
    queue,
    watchdog,
    manager,
    ada,
    alan,
    ran,
    advance(ms) {
      clock += ms;
    },
    finish(issue, outcome = "finished") {
      running.get(issue)?.(outcome);
      running.delete(issue);
    },
    openIssue: (title) =>
      github.createIssue(webShop, {
        title,
        body: "- [ ] It works",
        labels: ["ai-office", "needs-work"],
      }).number,
    labels: async (issue) => (await repository.getIssue(issue)).labels,
    decisionComments: async (issue) =>
      (await repository.listComments(issue))
        .map(({ body }) => body)
        .filter((body) => body.startsWith(decisionCommentMarker)),
    eventsOf: async <Type extends OfficeEvent["type"]>(type: Type) =>
      (await bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter(
          (event): event is Extract<OfficeEvent, { type: Type }> =>
            event.type === type,
        ),
    async pause(agent) {
      const current = (await stores.agents.list("web-shop")).find(
        ({ id }) => id === agent.id,
      );
      if (current !== undefined) {
        await stores.agents.update({ ...current, enabled: false });
      }
    },
    agent: async (id) =>
      (await stores.agents.list("web-shop")).find((agent) => agent.id === id),
  };
}

/** Waits for the queue to have started the given runs, in order. */
const ranAs = async (
  setup: Setup,
  runs: { issue: number; agentId: string | null }[],
) => {
  await vi.waitFor(() => {
    expect(setup.ran).toEqual(runs);
  });
};

const verdict = (kind: "approve" | "changes_requested"): ReviewVerdict => ({
  verdict: kind,
  summary: kind === "approve" ? "Looks good." : "One thing to fix.",
  comments:
    kind === "approve"
      ? []
      : [
          {
            path: "src/basket.ts",
            line: 3,
            severity: "blocking",
            body: "The total ignores quantities.",
          },
        ],
});

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "a stuck task is reassigned to a free coder, with its decision on the issue and in the Activity Feed",
    async (setup) => {
      const { ada, alan, manager } = setup;
      await setup.queue.start();
      const issue = setup.openIssue("Add a basket");
      await setup.queue.enqueue({
        floorId: "web-shop",
        issue,
        stage: "needs-work",
      });
      await ranAs(setup, [{ issue, agentId: ada.id }]);

      // Working: ten minutes in, then output at fifteen, is not stuck.
      setup.advance(minutes(10));
      expect(await setup.watchdog.check()).toEqual([]);
      setup.advance(minutes(5));
      await setup.bus.publish({
        type: "sandbox.text",
        version: 1,
        floorId: "web-shop",
        agentId: ada.id,
        issue,
        sandboxId: "sbx-1",
        text: "Adding the basket page.",
      });
      setup.advance(minutes(15));
      expect(await setup.watchdog.check()).toEqual([]);

      // Twenty-one minutes with no sign of progress: stuck.
      setup.advance(minutes(6));
      const decisions = await setup.watchdog.check();
      expect(decisions).toEqual([
        expect.objectContaining({
          issue,
          agentId: manager.id,
          action: "reassign",
          trigger: "stalled",
          stage: "needs-work",
          fromAgentId: ada.id,
          toAgentId: alan.id,
        }),
      ]);
      // The same work, stopped for Ada and started for Alan.
      await ranAs(setup, [
        { issue, agentId: ada.id },
        { issue, agentId: alan.id },
      ]);
      expect(await setup.workStore.active()).toEqual([
        expect.objectContaining({
          issue,
          agentId: alan.id,
          status: "running",
        }),
      ]);
      expect(
        (await setup.eventsOf("issue.assigned")).map(({ agentId }) => agentId),
      ).toEqual([ada.id, alan.id]);

      // Logged as a comment on the issue and an event.
      const [comment, ...more] = await setup.decisionComments(issue);
      expect(more).toEqual([]);
      expect(comment).toContain("### Manager: reassigned");
      expect(comment).toContain(
        `${manager.name} (the Manager) gave this issue's work at \`needs-work\` to ${alan.name}, from ${ada.name}.`,
      );
      expect(comment).toContain(
        `> ${ada.name}'s work on it at needs-work showed no progress for 20 minutes`,
      );
      expect(await setup.eventsOf("manager.decision")).toEqual([
        {
          type: "manager.decision",
          version: 1,
          floorId: "web-shop",
          issue,
          agentId: manager.id,
          action: "reassign",
          trigger: "stalled",
          stage: "needs-work",
          fromAgentId: ada.id,
          toAgentId: alan.id,
        },
      ]);
      expect(await setup.stores.decisions.list("web-shop", issue)).toEqual([
        expect.objectContaining({ action: "reassign", toAgentId: alan.id }),
      ]);
      // Alan's run has just started: nothing more to decide.
      expect(await setup.watchdog.check()).toEqual([]);
      expect(await setup.notices.open()).toEqual([]);
      await setup.watchdog.stop();
      await setup.queue.stop();
    },
  ],
  [
    "a stuck designer's review is reassigned to a free designer, never to the free QA Agent",
    async (setup) => {
      const agents = createAgents({
        store: setup.stores.agents,
        floors: setup.stores.floors,
        events: setup.bus,
      });
      const dee = await agents.add("web-shop", { role: "designer" });
      const dan = await agents.add("web-shop", { role: "designer" });
      await setup.queue.start();
      const issue = setup.github.createIssue(webShop, {
        title: "Add a basket",
        body: "- [ ] It works",
        labels: ["ai-office", "needs-qa"],
      }).number;
      await setup.queue.enqueue({
        floorId: "web-shop",
        issue,
        stage: "needs-qa",
        role: "designer",
      });
      await ranAs(setup, [{ issue, agentId: dee.id }]);

      setup.advance(minutes(21));
      expect(await setup.watchdog.check()).toEqual([
        expect.objectContaining({
          action: "reassign",
          trigger: "stalled",
          stage: "needs-qa",
          fromAgentId: dee.id,
          toAgentId: dan.id,
        }),
      ]);
      await ranAs(setup, [
        { issue, agentId: dee.id },
        { issue, agentId: dan.id },
      ]);
      expect(await setup.workStore.active()).toEqual([
        expect.objectContaining({
          issue,
          stage: "needs-qa",
          role: "designer",
          agentId: dan.id,
          status: "running",
        }),
      ]);
      await setup.watchdog.stop();
      await setup.queue.stop();
    },
  ],
  [
    "leaves the Merge Policy's work alone while it waits on CI",
    async (setup) => {
      await setup.queue.start();
      const issue = setup.github.createIssue(webShop, {
        title: "Add a basket",
        body: "- [ ] It works",
        labels: ["ai-office", "ready-to-merge"],
      }).number;
      await setup.queue.enqueue({
        floorId: "web-shop",
        issue,
        stage: "ready-to-merge",
      });
      await ranAs(setup, [{ issue, agentId: null }]);

      // No Agent's work: it bounds its own wait for CI.
      setup.advance(minutes(25));
      expect(await setup.watchdog.check()).toEqual([]);
      expect(setup.ran).toHaveLength(1);
      setup.finish(issue);
    },
  ],
  [
    "work that keeps stalling is retried while no other coder is free, then handed to the Owner",
    async (setup) => {
      const { ada, manager } = setup;
      await setup.pause(setup.alan);
      await setup.queue.start();
      const issue = setup.openIssue("Add a basket");
      await setup.queue.enqueue({
        floorId: "web-shop",
        issue,
        stage: "needs-work",
      });
      await ranAs(setup, [{ issue, agentId: ada.id }]);

      for (const runs of [2, 3]) {
        setup.advance(minutes(21));
        expect(await setup.watchdog.check()).toEqual([
          expect.objectContaining({ action: "retry", fromAgentId: ada.id }),
        ]);
        await ranAs(
          setup,
          Array.from({ length: runs }, () => ({ issue, agentId: ada.id })),
        );
      }

      // A third stall: stopped, and handed to the Owner.
      setup.advance(minutes(21));
      expect(await setup.watchdog.check()).toEqual([
        expect.objectContaining({
          action: "escalate",
          trigger: "stalled",
          toStage: "needs-human",
        }),
      ]);
      expect(await setup.workStore.active()).toEqual([]);
      expect(await setup.labels(issue)).toEqual(["ai-office", "needs-human"]);
      expect(
        (await setup.notices.open()).map(({ kind, title, agentId }) => ({
          kind,
          title,
          agentId,
        })),
      ).toEqual([
        {
          kind: "action",
          title: `${manager.name} escalated #${String(issue)}: its work at needs-work stalled 3 times, the last after 20 minutes with no progress`,
          agentId: ada.id,
        },
      ]);
      const comments = await setup.decisionComments(issue);
      expect(comments).toHaveLength(3);
      expect(comments[0]).toContain(
        `queued this issue's work at \`needs-work\` again, for ${ada.name}.`,
      );
      expect(comments[2]).toContain(
        "handed this issue to the Owner, labelled `needs-human`.",
      );
      expect(
        (await setup.eventsOf("manager.decision")).map(
          ({ action, to }) => to ?? action,
        ),
      ).toEqual(["retry", "retry", "needs-human"]);
      // Handed over: nothing runs or is decided again.
      setup.advance(minutes(60));
      expect(await setup.watchdog.check()).toEqual([]);
      expect(setup.ran).toHaveLength(3);
      await setup.queue.stop();
    },
  ],
  [
    "work that keeps failing goes to another coder, then to the Owner after three failures",
    async (setup) => {
      const { ada, alan, manager } = setup;
      await setup.queue.start();
      const issue = setup.openIssue("Add a basket");
      await setup.queue.enqueue({
        floorId: "web-shop",
        issue,
        stage: "needs-work",
      });
      await ranAs(setup, [{ issue, agentId: ada.id }]);
      setup.finish(issue, "failed");
      await setup.queue.idle();

      // Failed once: Alan is free, so it goes to him.
      expect(await setup.watchdog.check()).toEqual([
        expect.objectContaining({
          action: "reassign",
          trigger: "failing",
          fromAgentId: ada.id,
          toAgentId: alan.id,
          reason: "its work at needs-work failed",
        }),
      ]);
      await ranAs(setup, [
        { issue, agentId: ada.id },
        { issue, agentId: alan.id },
      ]);
      // Nothing more to decide while it is being worked again.
      expect(await setup.watchdog.check()).toEqual([]);
      setup.finish(issue, "failed");
      await setup.queue.idle();
      expect(await setup.watchdog.check()).toEqual([
        expect.objectContaining({
          action: "reassign",
          toAgentId: ada.id,
          reason: "its work at needs-work failed 2 times in a row",
        }),
      ]);
      await ranAs(setup, [
        { issue, agentId: ada.id },
        { issue, agentId: alan.id },
        { issue, agentId: ada.id },
      ]);
      setup.finish(issue, "failed");
      await setup.queue.idle();

      // A third failure in a row: handed to the Owner.
      expect(await setup.watchdog.check()).toEqual([
        expect.objectContaining({ action: "escalate", toStage: "needs-human" }),
      ]);
      expect(await setup.labels(issue)).toEqual(["ai-office", "needs-human"]);
      expect((await setup.notices.open()).map(({ title }) => title)).toEqual([
        `${manager.name} escalated #${String(issue)}: its work at needs-work failed 3 times in a row`,
      ]);
      expect(await setup.watchdog.check()).toEqual([]);
      expect(setup.ran).toHaveLength(3);
      expect(await setup.decisionComments(issue)).toHaveLength(3);
      await setup.queue.stop();
    },
  ],
  [
    "leaves alone failed work whose issue moved on, was closed or finished later",
    async (setup) => {
      await setup.queue.start();
      const moved = setup.openIssue("Moved by the Owner");
      const closed = setup.openIssue("Closed by the Owner");
      const fixed = setup.openIssue("Worked at the second attempt");
      for (const issue of [moved, closed, fixed]) {
        await setup.queue.enqueue({
          floorId: "web-shop",
          issue,
          stage: "needs-work",
        });
      }
      await vi.waitFor(() => {
        expect(setup.ran).toHaveLength(2);
      });
      for (const issue of [moved, closed]) {
        setup.finish(issue, "failed");
      }
      await vi.waitFor(() => {
        expect(setup.ran).toHaveLength(3);
      });
      setup.finish(fixed, "failed");
      await setup.queue.idle();
      // The Owner moves one on and closes another; the third is queued
      // again by hand and works.
      setup.github.removeLabel(webShop, moved, "needs-work");
      setup.github.setLabel(webShop, moved, "needs-human");
      await setup.github.repository(webShop).closeIssue(closed);
      await setup.queue.enqueue({
        floorId: "web-shop",
        issue: fixed,
        stage: "needs-work",
      });
      await vi.waitFor(() => {
        expect(setup.ran).toHaveLength(4);
      });
      setup.finish(fixed);
      await setup.queue.idle();

      expect(await setup.watchdog.check()).toEqual([]);
      expect(await setup.eventsOf("manager.decision")).toEqual([]);
      await setup.queue.stop();
    },
  ],
  [
    "an Agent whose last three tasks failed, on more than one issue, is paused",
    async (setup) => {
      const { ada, alan, manager } = setup;
      await setup.queue.start();
      const issues = [
        setup.openIssue("Add a basket"),
        setup.openIssue("Add a wish list"),
        setup.openIssue("Add a checkout"),
      ];
      for (const [index, issue] of issues.entries()) {
        await setup.queue.enqueue({
          floorId: "web-shop",
          issue,
          stage: "needs-work",
          agentId: ada.id,
        });
        await vi.waitFor(() => {
          expect(setup.ran).toHaveLength(index + 1);
        });
        setup.finish(issue, "failed");
        await setup.queue.idle();
      }

      const decisions = await setup.watchdog.check();
      expect(decisions[0]).toMatchObject({
        issue: issues[2],
        action: "pause",
        trigger: "failing",
        fromAgentId: ada.id,
        reason: `${ada.name}'s last 3 tasks failed, on 3 issues`,
      });
      expect((await setup.agent(ada.id))?.enabled).toBe(false);
      expect(await setup.eventsOf("config.changed")).toContainEqual(
        expect.objectContaining({ agentId: ada.id, keys: ["enabled"] }),
      );
      expect((await setup.notices.open()).map(({ title }) => title)).toEqual([
        `${manager.name} paused ${ada.name}: ${ada.name}'s last 3 tasks failed, on 3 issues. Resume ${ada.name} in the Agent editor.`,
      ]);
      expect(await setup.decisionComments(issues[2] ?? 0)).toEqual([
        expect.stringContaining(
          `paused ${ada.name}, who worked this issue at \`needs-work\`.`,
        ),
        expect.anything(),
      ]);
      // The failed work is tried again, but never by Ada while paused.
      expect(decisions.slice(1).map(({ action }) => action)).toEqual([
        "reassign",
        "retry",
        "retry",
      ]);
      await vi.waitFor(() => {
        expect(setup.ran.slice(3)).toEqual([
          { issue: issues[0], agentId: alan.id },
        ]);
      });
      expect(
        (await setup.workStore.active()).every(
          ({ agentId }) => agentId !== ada.id,
        ),
      ).toBe(true);
      // Paused once: the Owner resumes Ada, and the old failures do not
      // pause her again.
      const paused = await setup.agent(ada.id);
      if (paused !== undefined) {
        await setup.stores.agents.update({ ...paused, enabled: true });
      }
      expect(
        (await setup.watchdog.check()).filter(
          ({ action }) => action === "pause",
        ),
      ).toEqual([]);
      await setup.queue.stop();
    },
  ],
  [
    "a Review Loop with one round left before its Round Cap is escalated, once",
    async (setup) => {
      const { manager } = setup;
      const issue = setup.openIssue("Add a basket");
      const review = (round: number, kind: "approve" | "changes_requested") =>
        setup.stores.reviews.recordVerdict({
          floorId: "web-shop",
          issue,
          pullRequest: 2,
          round,
          agentId:
            kind === "approve" ? setup.ada.id : "reviewer-who-wants-changes",
          headSha: "a".repeat(40),
          verdict: verdict(kind),
          reviewUrl: "https://github.com/adrianeyre/web-shop/pull/2",
          createdAt: start,
        });
      // Round 1 of 3 sent it back: two rounds are left.
      await review(1, "changes_requested");
      await setup.queue.enqueue({
        floorId: "web-shop",
        issue,
        stage: "needs-work",
      });
      expect(await setup.watchdog.check()).toEqual([]);

      // Round 2 of 3 sent it back too: one round is left.
      await review(2, "changes_requested");
      expect(await setup.watchdog.check()).toEqual([
        expect.objectContaining({
          action: "escalate",
          trigger: "near_cap",
          stage: "needs-review",
          toStage: null,
        }),
      ]);
      expect((await setup.notices.open()).map(({ title }) => title)).toEqual([
        `${manager.name} escalated #${String(issue)}: round 2 of its Review Loop asked for changes, so one round is left before its Round Cap of 3`,
      ]);
      // The loop carries on: the issue stays where it is.
      expect(await setup.labels(issue)).toEqual(["ai-office", "needs-work"]);
      expect(await setup.decisionComments(issue)).toEqual([
        expect.stringContaining(
          `${manager.name} (the Manager) asked the Owner to look at this issue.`,
        ),
      ]);
      expect(await setup.watchdog.check()).toEqual([]);
    },
  ],
  [
    "attempts to merge or raise caps are refused, and nothing is merged or raised",
    async (setup) => {
      const { manager } = setup;
      const issue = setup.openIssue("Add a basket");
      setup.github.pushCommit(webShop, "ai-office/1-add-a-basket", {
        files: { "src/basket.ts": "export const basket = [];\n" },
      });
      const pullRequest = await setup.github
        .repository(webShop)
        .createPullRequest({
          title: "Add a basket",
          body: `Closes #${String(issue)}`,
          head: "ai-office/1-add-a-basket",
          base: "main",
        });
      const capsBefore = {
        office: await setup.stores.tokenCaps.officeCaps(),
        issues: await setup.stores.tokenCaps.issueCaps("web-shop"),
        agents: (await setup.stores.agents.list("web-shop")).map(
          ({ tokenCaps }) => tokenCaps,
        ),
        floor: (await setup.stores.floors.get("web-shop"))?.tokenCaps,
      };
      const request = (
        action: string,
        extra: Partial<DecisionRequest> = {},
      ): DecisionRequest => ({
        floorId: "web-shop",
        issue,
        action,
        trigger: "near_cap",
        stage: "needs-review",
        key: `owner-asked:${action}`,
        reason: "the Review Loop is close to its Round Cap",
        ...extra,
      });

      for (const action of [
        "merge",
        "raise_cap",
        "change_repository_settings",
      ]) {
        const refused = setup.watchdog.act(request(action));
        await expect(refused).rejects.toBeInstanceOf(ManagerAuthorityError);
        await expect(refused).rejects.toMatchObject({
          code: "not_permitted",
          action,
        });
      }
      // Nor may it carry work forward, past review, towards a merge.
      setup.github.removeLabel(webShop, issue, "needs-work");
      setup.github.setLabel(webShop, issue, "needs-review");
      await expect(
        setup.watchdog.act(
          request("relabel", { to: "ready-to-merge", key: "forward" }),
        ),
      ).rejects.toMatchObject({ action: "relabel_to_ready-to-merge" });

      // Beneath the check, its GitHub client refuses too.
      const client = managerGitHub(setup.github).repository(webShop);
      await expect(
        client.mergePullRequest(pullRequest.number, { method: "squash" }),
      ).rejects.toMatchObject({ action: "merge" });
      await expect(client.installationToken()).rejects.toBeInstanceOf(
        ManagerAuthorityError,
      );
      await expect(
        client.ensureLabel({ name: "anything", color: "ffffff" }),
      ).rejects.toMatchObject({ action: "change_repository_settings" });

      // Nothing was merged, raised, moved, logged or commented.
      expect(
        (
          await setup.github
            .repository(webShop)
            .getPullRequest(pullRequest.number)
        ).merged,
      ).toBe(false);
      expect({
        office: await setup.stores.tokenCaps.officeCaps(),
        issues: await setup.stores.tokenCaps.issueCaps("web-shop"),
        agents: (await setup.stores.agents.list("web-shop")).map(
          ({ tokenCaps }) => tokenCaps,
        ),
        floor: (await setup.stores.floors.get("web-shop"))?.tokenCaps,
      }).toEqual(capsBefore);
      expect(await setup.labels(issue)).toEqual(["ai-office", "needs-review"]);
      expect(await setup.stores.decisions.list("web-shop", issue)).toEqual([]);
      expect(await setup.decisionComments(issue)).toEqual([]);
      expect(await setup.eventsOf("manager.decision")).toEqual([]);
      // Each refusal is in the Activity Feed.
      expect(
        (await setup.eventsOf("manager.action_refused")).map(
          ({ action, agentId, issue: number }) => ({
            action,
            agentId,
            issue: number,
          }),
        ),
      ).toEqual(
        [
          "merge",
          "raise_cap",
          "change_repository_settings",
          "relabel_to_ready-to-merge",
        ].map((action) => ({ action, agentId: manager.id, issue })),
      );

      // What it may do, it does: send the issue back to the coder.
      expect(
        await setup.watchdog.act(
          request("relabel", { to: "needs-work", key: "back" }),
        ),
      ).toMatchObject({ action: "relabel", toStage: "needs-work" });
      expect(await setup.labels(issue)).toEqual(["ai-office", "needs-work"]);
      expect(await setup.decisionComments(issue)).toEqual([
        expect.stringContaining(
          "moved this issue from `needs-review` to `needs-work`.",
        ),
      ]);
    },
  ],
  [
    "never writes a credential into its comments",
    async (setup) => {
      const issue = setup.openIssue("Add a basket");
      const key = "sk-ant-api03-pastedintoareason-Qw3Er4Ty5Ui6Op7As8Df9";
      await setup.watchdog.act({
        floorId: "web-shop",
        issue,
        action: "escalate",
        trigger: "failing",
        stage: "needs-work",
        key: "credential",
        reason: `its sandbox failed with ${key}`,
      });
      const [comment] = await setup.decisionComments(issue);
      expect(comment).toContain("its sandbox failed with");
      expect(comment).not.toContain(key);
      expect(
        (await setup.notices.open()).map(({ title }) => title).join(""),
      ).not.toContain(key);
      expect(
        JSON.stringify(await setup.stores.decisions.list("web-shop", issue)),
      ).not.toContain(key);
    },
  ],
];

describe("the Manager's watchdog, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const stores = memoryStores();
      await run(
        await setUp(
          stores,
          memoryWorkQueueStore(stores.floors),
          createEventBus({ store: memoryEventStore() }),
        ),
      );
    });
  }
});

describe("the Manager's watchdog, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      await run(
        await setUp(
          databaseStores(database.db),
          databaseWorkQueueStore(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    });
  }
});
