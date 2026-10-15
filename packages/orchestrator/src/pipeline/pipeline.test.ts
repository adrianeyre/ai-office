import {
  createEventBus,
  memoryEventStore,
  type EventBus,
} from "@ai-office/events";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import {
  pipelineStages,
  randomAvatar,
  type PipelineStage,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { memoryAgentStore } from "../agents/store.ts";
import { memoryRoleStore } from "../roles/store.ts";
import { builtIn } from "../roles/testing.ts";
import {
  canMove,
  createPipeline,
  PipelineError,
  pipelineErrorCodes,
  positionOf,
  nextRoleAt,
  roleOfQueued,
  stageAfter,
  stageRoles,
  transitions,
  type Pipeline,
} from "./pipeline.ts";

// The label pipeline (PRD FR-18): legal moves are applied on GitHub and
// recorded as events, in order; illegal ones are refused and change
// nothing.

const repository = "adrianeyre/web-shop";
const floor = { id: "web-shop", repository };

function setUp(): {
  github: FakeGitHub;
  bus: EventBus;
  pipeline: Pipeline;
  issue: (labels?: string[]) => number;
  labels: (issue: number) => Promise<readonly string[]>;
  changes: () => Promise<unknown[]>;
} {
  const github = createFakeGitHub();
  github.installRepository(repository);
  const bus = createEventBus({ store: memoryEventStore() });
  return {
    github,
    bus,
    pipeline: createPipeline({ github, events: bus }),
    issue: (labels = ["ai-office"]) =>
      github.createIssue(repository, { title: "Add a basket", labels }).number,
    labels: async (issue) =>
      (await github.repository(repository).getIssue(issue)).labels,
    changes: async () =>
      (await bus.eventsAfter(0))
        .map(({ event }) => event)
        .filter((event) => event.type === "issue.label_changed")
        .map((event) => [event.from, event.to, event.agentId]),
  };
}

const refusal = async (promise: Promise<unknown>): Promise<PipelineError> => {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(PipelineError);
  return error as PipelineError;
};

describe("the pipeline's transitions", () => {
  it("go forward through the stages, back to code, back to review from ready-to-merge, or out to a human", () => {
    expect(canMove(null, "needs-work")).toBe(true);
    expect(canMove("needs-work", "needs-review")).toBe(true);
    expect(canMove("needs-review", "needs-qa")).toBe(true);
    expect(canMove("needs-qa", "needs-docs")).toBe(true);
    expect(canMove("needs-docs", "ready-to-merge")).toBe(true);
    // A Floor without QA or docs Agents skips their stages.
    expect(canMove("needs-review", "ready-to-merge")).toBe(true);
    expect(canMove("needs-qa", "ready-to-merge")).toBe(true);
    // The Review Loop sends changes back to the coder.
    expect(canMove("needs-review", "needs-work")).toBe(true);
    expect(canMove("needs-qa", "needs-work")).toBe(true);
    // The Merge Policy sends commits pushed after the reviewers approved
    // back to them (P1-1).
    expect(canMove("ready-to-merge", "needs-review")).toBe(true);
    for (const stage of pipelineStages) {
      expect(canMove(stage, "needs-human")).toBe(stage !== "needs-human");
    }
  });

  it("refuse skipping review, going backwards, standing still or leaving needs-human", () => {
    const illegal: [PipelineStage | null, PipelineStage][] = [
      [null, "needs-review"],
      [null, "ready-to-merge"],
      ["needs-work", "needs-qa"],
      ["needs-work", "ready-to-merge"],
      ["needs-work", "needs-work"],
      ["needs-qa", "needs-review"],
      ["needs-docs", "needs-qa"],
      ["ready-to-merge", "needs-work"],
      ["ready-to-merge", "needs-qa"],
      ["ready-to-merge", "needs-docs"],
      ["needs-human", "needs-work"],
      ["needs-human", "ready-to-merge"],
    ];
    for (const [from, to] of illegal) {
      expect(canMove(from, to), `${String(from)} → ${to}`).toBe(false);
    }
    // Every stage has an entry.
    expect([...transitions.keys()]).toEqual([null, ...pipelineStages]);
  });

  it("read an issue's position from its labels", () => {
    expect(positionOf(4, ["ai-office"])).toEqual({ stage: null, held: false });
    expect(positionOf(4, ["needs-qa", "in-progress", "bug"])).toEqual({
      stage: "needs-qa",
      held: true,
    });
    expect(() => positionOf(4, ["needs-work", "needs-qa"])).toThrow(
      PipelineError,
    );
  });
});

describe("the pipeline on GitHub", () => {
  it("applies each move on GitHub and records it, in order", async () => {
    const { pipeline, issue, labels, changes } = setUp();
    const number = issue();
    await pipeline.move(floor, number, "needs-work");
    expect(await labels(number)).toEqual(["ai-office", "needs-work"]);

    await pipeline.hold(floor, number, "ada");
    expect(await labels(number)).toEqual([
      "ai-office",
      "needs-work",
      "in-progress",
    ]);
    expect(await pipeline.position(floor, number)).toEqual({
      stage: "needs-work",
      held: true,
    });

    // Moving on lets go of the issue.
    expect(
      await pipeline.move(floor, number, "needs-review", { agentId: "ada" }),
    ).toEqual({ stage: "needs-review", held: false });
    expect(await labels(number)).toEqual(["ai-office", "needs-review"]);

    await pipeline.hold(floor, number, "grace");
    await pipeline.release(floor, number, "grace");
    await pipeline.move(floor, number, "needs-qa");
    await pipeline.move(floor, number, "needs-docs");
    await pipeline.move(floor, number, "ready-to-merge");
    expect(await labels(number)).toEqual(["ai-office", "ready-to-merge"]);

    expect(await changes()).toEqual([
      [null, "needs-work", undefined],
      [null, "in-progress", "ada"],
      ["needs-work", "needs-review", "ada"],
      ["in-progress", null, "ada"],
      [null, "in-progress", "grace"],
      ["in-progress", null, "grace"],
      ["needs-review", "needs-qa", undefined],
      ["needs-qa", "needs-docs", undefined],
      ["needs-docs", "ready-to-merge", undefined],
    ]);
  });

  it("refuses an illegal move, changing nothing on GitHub or in the log", async () => {
    const { pipeline, issue, labels, changes } = setUp();
    const number = issue();
    const skip = await refusal(pipeline.move(floor, number, "ready-to-merge"));
    expect(skip.code).toBe(pipelineErrorCodes.illegalTransition);
    expect(skip.message).toBe(
      `Issue #${String(number)} cannot move from outside the pipeline to ready-to-merge.`,
    );

    await pipeline.move(floor, number, "needs-work");
    await pipeline.move(floor, number, "needs-human");
    for (const to of pipelineStages) {
      expect((await refusal(pipeline.move(floor, number, to))).code).toBe(
        pipelineErrorCodes.illegalTransition,
      );
    }
    expect(await labels(number)).toEqual(["ai-office", "needs-human"]);
    expect(await changes()).toEqual([
      [null, "needs-work", undefined],
      ["needs-work", "needs-human", undefined],
    ]);
  });

  it("holds only workable issues, once, and releases only held ones", async () => {
    const { pipeline, issue, labels } = setUp();
    const number = issue();
    expect((await refusal(pipeline.hold(floor, number, "ada"))).code).toBe(
      pipelineErrorCodes.notWorkable,
    );
    expect((await refusal(pipeline.release(floor, number))).code).toBe(
      pipelineErrorCodes.notHeld,
    );

    await pipeline.move(floor, number, "needs-work");
    await pipeline.hold(floor, number, "ada");
    expect((await refusal(pipeline.hold(floor, number, "linus"))).code).toBe(
      pipelineErrorCodes.held,
    );

    await pipeline.move(floor, number, "needs-review");
    await pipeline.move(floor, number, "ready-to-merge");
    expect((await refusal(pipeline.hold(floor, number, "ada"))).code).toBe(
      pipelineErrorCodes.notWorkable,
    );
    expect(await labels(number)).toEqual(["ai-office", "ready-to-merge"]);
  });

  it("refuses to guess where an issue with two stage labels is", async () => {
    const { pipeline, issue } = setUp();
    const number = issue(["ai-office", "needs-work", "needs-qa"]);
    expect(
      (await refusal(pipeline.move(floor, number, "needs-human"))).code,
    ).toBe(pipelineErrorCodes.conflictingLabels);
    expect((await refusal(pipeline.hold(floor, number, "ada"))).code).toBe(
      pipelineErrorCodes.conflictingLabels,
    );
  });

  it("finishes a move that stopped after adding the new stage", async () => {
    const { pipeline, issue, labels, changes } = setUp();
    // The last attempt added needs-review but never removed needs-work.
    const number = issue(["ai-office", "needs-work", "needs-review"]);
    await pipeline.move(floor, number, "needs-review");
    expect(await labels(number)).toEqual(["ai-office", "needs-review"]);
    expect(await changes()).toEqual([
      ["needs-work", "needs-review", undefined],
    ]);
  });
});

describe("the Roles that work each stage in turn", () => {
  const team = ["manager", "coder", "reviewer"] as const;
  // Their Stages.
  const stages = [null, "work", "review"] as const;

  it("has QA, then a designer, at needs-qa", () => {
    // After the QA Stage's own Agents, a designer.
    expect(stageRoles["needs-qa"]).toEqual(["designer"]);
    expect(nextRoleAt("needs-qa", [...team, "qa", "designer"])).toBe(
      "designer",
    );
    expect(
      nextRoleAt("needs-qa", [...team, "qa", "designer"], "designer"),
    ).toBeUndefined();
    expect(nextRoleAt("needs-qa", [...team, "qa"])).toBeUndefined();
    expect(nextRoleAt("needs-qa", [...team, "designer"])).toBe("designer");
    expect(nextRoleAt("needs-review", team)).toBeUndefined();
  });

  it("names the Role on queued work only when it is not the stage's first", () => {
    expect(
      roleOfQueued(
        "needs-qa",
        [...stages, "qa", "work"],
        [...team, "qa", "designer"],
      ),
    ).toEqual({});
    expect(
      roleOfQueued("needs-qa", [...stages, "work"], [...team, "designer"]),
    ).toEqual({ role: "designer" });
    expect(
      roleOfQueued("needs-docs", [...stages, "docs"], [...team, "docs"]),
    ).toEqual({});
    expect(roleOfQueued("ready-to-merge", stages, team)).toEqual({});
  });
});

describe("stageAfter", () => {
  it("goes on to QA for a designer alone, and past it once QA and the designer are done", () => {
    const team = ["manager", "coder", "reviewer"] as const;
    // Their Stages; a designer's is work.
    const stages = [null, "work", "review", "work"] as const;
    expect(stageAfter("needs-review", stages, [...team, "designer"])).toBe(
      "needs-qa",
    );
    expect(
      stageAfter(
        "needs-qa",
        [...stages, "qa", "docs"],
        [...team, "qa", "designer", "docs"],
      ),
    ).toBe("needs-docs");
    expect(stageAfter("needs-qa", stages, [...team, "designer"])).toBe(
      "ready-to-merge",
    );
  });

  it("goes on to QA, then docs, then ready-to-merge, skipping a Stage the Floor has no Agent in", () => {
    // The Stages of a Manager, a coder and a reviewer.
    const team = [null, "work", "review"] as const;
    expect(stageAfter("needs-review", [...team, "qa", "docs"])).toBe(
      "needs-qa",
    );
    expect(stageAfter("needs-review", [...team, "docs"])).toBe("needs-docs");
    expect(stageAfter("needs-review", team)).toBe("ready-to-merge");
    expect(stageAfter("needs-qa", [...team, "qa", "docs"])).toBe("needs-docs");
    expect(stageAfter("needs-qa", [...team, "qa"])).toBe("ready-to-merge");
    expect(stageAfter("needs-docs", [...team, "qa", "docs"])).toBe(
      "ready-to-merge",
    );
    // Each is a move the pipeline allows.
    for (const from of ["needs-review", "needs-qa", "needs-docs"] as const) {
      for (const stages of [team, [...team, "qa", "docs"] as const]) {
        expect(canMove(from, stageAfter(from, stages))).toBe(true);
      }
    }
  });

  it("goes by the Agents' Stages, whatever their Roles are called", async () => {
    // A Floor whose QA-Stage Role is a store's, not `qa`: its Agents'
    // Stages, read from the Role library, are what count.
    const roles = memoryRoleStore();
    await roles.create(
      {
        ...builtIn("qa"),
        id: "store-qa",
        name: "store QA",
        description: "Checks links, prices and images.",
      },
      new Date(),
    );
    const agents = memoryAgentStore(roles);
    const created = new Date("2026-10-09T09:00:00.000Z");
    agents.insert(
      ["manager", "coder", "reviewer", "store-qa"].map((role, index) => ({
        id: role,
        floorId: "web-shop",
        name: role,
        role,
        stage: null,
        aiProvider: "Claude",
        modelOverride: null,
        effort: null,
        extraInstructions: "",
        enabled: true,
        avatar: randomAvatar(),
        tokenCaps: { daily: null, monthly: null },
        freshStartThreshold: null,
        createdAt: new Date(created.getTime() + index),
        leavingAt: null,
        contractor: null,
      })),
    );
    const stages = (await agents.list("web-shop")).map(({ stage }) => stage);
    expect(stages).toEqual([null, "work", "review", "qa"]);
    expect(stageAfter("needs-review", stages)).toBe("needs-qa");
    expect(stageAfter("needs-qa", stages)).toBe("ready-to-merge");
  });
});
