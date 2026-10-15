import {
  randomAvatar,
  type IssuePriority,
  type PipelineStage,
  type Role,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import type { AgentRecord } from "../agents/store.ts";
import { builtInStage } from "../roles/testing.ts";
import type { WorkItem, WorkStatus } from "../work/store.ts";
import {
  chooseAgent,
  freeAgent,
  rebalance,
  roleOfWork,
  sandboxStageAt,
} from "./dispatch.ts";

// The Manager's dispatch rules (PRD FR-23), which are plain code: new work
// goes to the Agent in its Role with the least work, and waiting work
// moves to an Agent of its Role that is free.

const agent = (
  id: string,
  role: Role,
  overrides: Partial<AgentRecord> = {},
): AgentRecord => ({
  id,
  floorId: "web-shop",
  name: id,
  role,
  // A built-in Role's Stage, unless the test gives another Role's.
  stage: overrides.stage === undefined ? builtInStage(role) : overrides.stage,
  aiProvider: "Claude",
  modelOverride: null,
  effort: null,
  extraInstructions: "",
  freshStartThreshold: null,
  enabled: true,
  avatar: randomAvatar(),
  tokenCaps: { daily: null, monthly: null },
  createdAt: new Date("2026-10-09T09:00:00.000Z"),
  leavingAt: null,
  contractor: null,
  ...overrides,
});

let nextId = 1;
const item = (
  issue: number,
  agentId: string | null,
  status: WorkStatus = "queued",
  {
    stage = "needs-work",
    priority = "normal",
    minute = issue,
  }: { stage?: PipelineStage; priority?: IssuePriority; minute?: number } = {},
): WorkItem => ({
  id: nextId++,
  floorId: "web-shop",
  issue,
  stage,
  agentId,
  status,
  priority,
  createdAt: new Date(Date.UTC(2026, 9, 9, 9, minute)),
  startedAt: status === "running" ? new Date() : null,
  finishedAt: null,
});

const team = [
  agent("manager", "manager"),
  agent("ada", "coder"),
  agent("grace", "coder"),
  agent("rex", "reviewer"),
  agent("quinn", "qa"),
];

describe("choosing the Agent for new work", () => {
  it("gives it to the Agent in the stage's Role with the least work, the oldest among equals", () => {
    expect(chooseAgent("needs-work", team, [], [])).toBe("ada");
    expect(chooseAgent("needs-work", team, [item(1, "ada")], [])).toBe("grace");
    expect(
      chooseAgent(
        "needs-work",
        team,
        [item(1, "ada"), item(2, "grace", "running")],
        [],
      ),
    ).toBe("ada");
    expect(chooseAgent("needs-qa", team, [item(1, "ada")], [])).toBe("quinn");
  });

  it("gives four issues in turn to two coders, two each", () => {
    const active: WorkItem[] = [];
    for (const issue of [1, 2, 3, 4]) {
      active.push(item(issue, chooseAgent("needs-work", team, active, [])));
    }
    expect(active.map(({ agentId }) => agentId)).toEqual([
      "ada",
      "grace",
      "ada",
      "grace",
    ]);
  });

  it("passes over Agents paused in the Agent editor, and those paused at a Token Cap while another can work", () => {
    const adaPaused = team.map((each) =>
      each.id === "ada" ? { ...each, enabled: false } : each,
    );
    expect(chooseAgent("needs-work", adaPaused, [item(1, "grace")], [])).toBe(
      "grace",
    );
    expect(chooseAgent("needs-work", team, [], ["ada"])).toBe("grace");
    // Both at their caps: the work still has an Agent, and waits for it.
    expect(chooseAgent("needs-work", team, [], ["ada", "grace"])).toBe("ada");
  });

  it("gives no one Agent a review round, nor work no Agent's Role fits", () => {
    expect(chooseAgent("needs-review", team, [], [])).toBeNull();
    expect(chooseAgent("needs-docs", team, [], [])).toBeNull();
    expect(chooseAgent("ready-to-merge", team, [], [])).toBeNull();
  });
});

describe("moving waiting work to a free Agent", () => {
  it("moves nothing while each waiting piece of work's Agent can start it", () => {
    expect(rebalance(team, [item(1, "ada"), item(2, "grace")], [])).toEqual([]);
    // Both busy: nobody is free to take #3.
    expect(
      rebalance(
        team,
        [
          item(1, "ada", "running"),
          item(2, "grace", "running"),
          item(3, "ada"),
        ],
        [],
      ),
    ).toEqual([]);
  });

  it("moves work waiting behind a busy Agent to a free one in the Role", () => {
    const waiting = item(4, "grace");
    expect(rebalance(team, [item(2, "grace", "running"), waiting], [])).toEqual(
      [
        {
          id: waiting.id,
          floorId: "web-shop",
          issue: 4,
          from: "grace",
          to: "ada",
        },
      ],
    );
  });

  it("moves work whose Agent is paused, in the editor or at a Token Cap, has gone, or never was", () => {
    const forPaused = item(1, "ada");
    expect(rebalance(team, [forPaused], ["ada"])).toEqual([
      expect.objectContaining({ id: forPaused.id, from: "ada", to: "grace" }),
    ]);
    const disabled = team.map((each) =>
      each.id === "grace" ? { ...each, enabled: false } : each,
    );
    const forDisabled = item(2, "grace");
    expect(rebalance(disabled, [forDisabled], [])).toEqual([
      expect.objectContaining({ id: forDisabled.id, from: "grace", to: "ada" }),
    ]);
    const forGone = item(3, "hopper");
    const forNoOne = item(4, null);
    expect(rebalance(team, [forGone, forNoOne], [])).toEqual([
      expect.objectContaining({ id: forGone.id, from: "hopper", to: "ada" }),
      expect.objectContaining({ id: forNoOne.id, from: null, to: "grace" }),
    ]);
  });

  it("gives each free Agent one piece, in the order work starts: issue priority, then oldest", () => {
    const coders = [...team, agent("hopper", "coder"), agent("lin", "coder")];
    const oldLow = item(3, "ada", "queued", { priority: "low", minute: 0 });
    const normal = item(4, "ada", "queued", { minute: 1 });
    const high = item(5, "ada", "queued", { priority: "high", minute: 2 });
    const moves = rebalance(
      coders,
      [item(1, "ada", "running"), oldLow, normal, high],
      [],
    );
    // grace, hopper and lin are free; #5 (high) first, then #4, then #3.
    expect(moves.map(({ issue, to }) => [issue, to])).toEqual([
      [5, "grace"],
      [4, "hopper"],
      [3, "lin"],
    ]);
  });

  it("keeps to the stage's Role, and leaves review rounds alone", () => {
    const qaWork = item(1, "quinn", "queued", { stage: "needs-qa" });
    const review = item(2, null, "queued", { stage: "needs-review" });
    expect(
      rebalance(
        team,
        [item(3, "quinn", "running", { stage: "needs-qa" }), qaWork, review],
        [],
      ),
    ).toEqual([]);
  });

  it("does not count an Agent paused at a Token Cap as free", () => {
    expect(
      rebalance(team, [item(1, "ada", "running"), item(2, "ada")], ["grace"]),
    ).toEqual([]);
  });
});

describe("an Agent leaving its Floor (PRD FR-10)", () => {
  const leaving = new Date("2026-10-09T10:00:00.000Z");
  const graceLeaving = team.map((each) =>
    each.id === "grace" ? { ...each, leavingAt: leaving } : each,
  );

  it("takes no new work, whatever its load", () => {
    expect(chooseAgent("needs-work", graceLeaving, [item(1, "ada")], [])).toBe(
      "ada",
    );
    expect(freeAgent("needs-work", graceLeaving, [], [], "ada")).toBeNull();
  });

  it("has the work waiting for it move to a free Agent of its Role", () => {
    const waiting = item(3, "grace");
    expect(
      rebalance(graceLeaving, [item(2, "grace", "running"), waiting], []),
    ).toEqual([
      {
        id: waiting.id,
        floorId: "web-shop",
        issue: 3,
        from: "grace",
        to: "ada",
      },
    ]);
  });
});

describe("finding a free Agent for the Manager's watchdog", () => {
  it("is the oldest enabled Agent of the Role with no work, not paused, other than the one named", () => {
    expect(freeAgent("needs-work", team, [], [], "ada")).toBe("grace");
    expect(freeAgent("needs-work", team, [], [])).toBe("ada");
    // Busy, paused at a Token Cap, or paused in the Agent editor: not free.
    expect(
      freeAgent("needs-work", team, [item(1, "grace", "running")], [], "ada"),
    ).toBeNull();
    expect(freeAgent("needs-work", team, [item(1, "grace")], [], "ada")).toBe(
      null,
    );
    expect(freeAgent("needs-work", team, [], ["grace"], "ada")).toBeNull();
    expect(
      freeAgent(
        "needs-work",
        team.map((one) =>
          one.id === "grace" ? { ...one, enabled: false } : one,
        ),
        [],
        [],
        "ada",
      ),
    ).toBeNull();
    // Only in the stage's Role, and no one for a review round.
    expect(freeAgent("needs-qa", team, [], [])).toBe("quinn");
    expect(freeAgent("needs-review", team, [], [])).toBeNull();
  });
});

describe("choosing by Stage, never by a Role's name (ADR 0003)", () => {
  // A Role the Owner made, in the work Stage, that no code knows by name.
  const cora = agent("cora", "copywriter", { stage: "work" });
  // And one called `qa` that is, for this test, in the docs Stage.
  const dot = agent("dot", "qa", { stage: "docs" });

  it("dispatches a new work-Stage Role's Agent like a coder", () => {
    const store = [agent("manager", "manager"), cora, agent("rex", "reviewer")];
    expect(chooseAgent("needs-work", store, [], [])).toBe("cora");
    expect(freeAgent("needs-work", store, [], [])).toBe("cora");
    expect(
      rebalance(store, [item(1, null), item(2, "gone")], []).map(
        ({ issue, to }) => [issue, to],
      ),
    ).toEqual([[1, "cora"]]);
  });

  it("balances work across every Agent in the work Stage, whatever its Role", () => {
    const mixed = [...team, cora];
    expect(chooseAgent("needs-work", mixed, [item(1, "ada")], [])).toBe(
      "grace",
    );
    expect(
      chooseAgent("needs-work", mixed, [item(1, "ada"), item(2, "grace")], []),
    ).toBe("cora");
    // Work waiting behind a busy coder moves to the free copywriter.
    expect(
      rebalance(
        mixed,
        [
          item(1, "ada", "running"),
          item(2, "grace", "running"),
          item(3, "ada"),
        ],
        [],
      ).map(({ issue, from, to }) => [issue, from, to]),
    ).toEqual([[3, "ada", "cora"]]);
  });

  it("goes by an Agent's Stage, not its Role's name", () => {
    const named = [agent("manager", "manager"), dot];
    expect(chooseAgent("needs-docs", named, [], [])).toBe("dot");
    expect(chooseAgent("needs-qa", named, [], [])).toBeNull();
    expect(freeAgent("needs-qa", named, [], [])).toBeNull();
  });
});

describe("within the work Role the Manager's triage chose (FR-23)", () => {
  const mia = agent("mia", "merchandiser", { stage: "work" });
  const max = agent("max", "merchandiser", { stage: "work" });
  const cora = agent("cora", "copywriter", { stage: "work" });
  const shop = [agent("manager", "manager"), mia, max, cora];

  it("gives new work only to an Agent in the issue's Role", () => {
    expect(chooseAgent("needs-work", shop, [], [], "copywriter")).toBe("cora");
    // The copywriter is busier, but the work is a copywriter's.
    expect(
      chooseAgent("needs-work", shop, [item(1, "cora")], [], "copywriter"),
    ).toBe("cora");
    // Balanced between the Role's own Agents.
    expect(
      chooseAgent("needs-work", shop, [item(1, "mia")], [], "merchandiser"),
    ).toBe("max");
    // With no Role chosen, every work-Stage Agent may take it.
    expect(
      chooseAgent("needs-work", shop, [item(1, "mia"), item(2, "max")], []),
    ).toBe("cora");
    // A Role paused in the Agent editor: the work waits for it.
    const paused = [mia, { ...cora, enabled: false }];
    expect(chooseAgent("needs-work", paused, [], [], "copywriter")).toBeNull();
  });

  it("goes by Stage when the Floor no longer has an Agent in the Role", () => {
    expect(chooseAgent("needs-work", shop, [], [], "designer")).toBe("mia");
    expect(freeAgent("needs-work", shop, [], [], null, "designer")).toBe("mia");
  });

  it("moves waiting work only to a free Agent in its issue's Role", () => {
    const roles = new Map([
      [3, "merchandiser"],
      [4, "copywriter"],
    ]);
    // Mia is busy with #1 and has #3 waiting; the copywriter is free, but
    // #3 is a merchandiser's.
    expect(
      rebalance(
        [agent("manager", "manager"), mia, cora],
        [item(1, "mia", "running"), item(3, "mia")],
        [],
        (issue) => roles.get(issue),
      ),
    ).toEqual([]);
    // A free merchandiser takes it; the copywriter takes the copy.
    expect(
      rebalance(
        shop,
        [
          item(1, "mia", "running"),
          item(2, "cora", "running"),
          item(3, "mia"),
          item(4, null),
        ],
        [],
        (issue) => roles.get(issue),
      ).map(({ issue, from, to }) => [issue, from, to]),
    ).toEqual([[3, "mia", "max"]]);
    expect(
      rebalance(
        shop,
        [item(1, "mia", "running"), item(3, "mia"), item(4, null)],
        [],
        (issue) => roles.get(issue),
      ).map(({ issue, from, to }) => [issue, from, to]),
    ).toEqual([
      [3, "mia", "max"],
      [4, null, "cora"],
    ]);
  });

  it("reassigns stalled work only within its Role", () => {
    const active = [item(1, "mia", "running")];
    expect(
      freeAgent("needs-work", shop, active, [], "mia", "merchandiser"),
    ).toBe("max");
    expect(
      freeAgent(
        "needs-work",
        [agent("manager", "manager"), mia, cora],
        active,
        [],
        "mia",
        "merchandiser",
      ),
    ).toBeNull();
  });
});

describe("a Contractor in a one-off Role (ADR 0004)", () => {
  const ada = agent("ada", "coder");
  const writer = agent("writer", "contractor-1a2b3c4d5e", {
    stage: "work",
    contractor: { kind: "work", batchId: 3, oneOffRole: true },
  });
  const second = agent("second", "coder", {
    contractor: { kind: "work", batchId: 3, oneOffRole: false },
  });
  const shop = [agent("manager", "manager"), ada, writer, second];

  it("takes only the work given to its Role, never other work in its Stage", () => {
    expect(
      chooseAgent("needs-work", shop, [], [], "contractor-1a2b3c4d5e"),
    ).toBe("writer");
    // With no Role chosen, or the coder's, it takes none; a Contractor in a
    // library Role is a coder like any other.
    expect(chooseAgent("needs-work", shop, [item(1, "ada")], [])).toBe(
      "second",
    );
    expect(
      chooseAgent(
        "needs-work",
        shop,
        [item(1, "ada"), item(2, "second")],
        [],
        "coder",
      ),
    ).toBe("ada");
    expect(
      rebalance(
        shop,
        [item(1, "ada", "running"), item(2, "ada")],
        [],
        () => undefined,
      ).map(({ to }) => to),
    ).toEqual(["second"]);
  });
});

describe("a stage worked by more than one Role in turn (QA, then a designer)", () => {
  const designers = [
    ...team,
    agent("dee", "designer"),
    agent("dan", "designer"),
  ];
  const design = (
    issue: number,
    agentId: string | null,
    status: WorkStatus = "queued",
  ): WorkItem => ({
    ...item(issue, agentId, status, { stage: "needs-qa" }),
    role: "designer",
  });

  it("gives a designer's work at needs-qa to a designer, and QA's to the QA Agent", () => {
    expect(roleOfWork(design(1, null))).toBe("designer");
    // QA's own work names no Role: it goes by the QA Stage.
    expect(
      roleOfWork(item(1, null, "queued", { stage: "needs-qa" })),
    ).toBeUndefined();
    expect(sandboxStageAt("needs-qa")).toBe("qa");
    expect(chooseAgent("needs-qa", designers, [], [], "designer")).toBe("dee");
    expect(
      chooseAgent("needs-qa", designers, [design(1, "dee")], [], "designer"),
    ).toBe("dan");
    expect(chooseAgent("needs-qa", designers, [], [])).toBe("quinn");
    // No designer on the Floor: no one fits.
    expect(chooseAgent("needs-qa", team, [], [], "designer")).toBeNull();
  });

  it("moves a designer's waiting work only to a free designer, never to QA", () => {
    const waiting = design(2, "dee");
    // Dee is busy; Quinn (QA) is free, but it is not QA's work.
    expect(
      rebalance(
        [...team, agent("dee", "designer")],
        [design(1, "dee", "running"), waiting],
        [],
      ),
    ).toEqual([]);
    // Dan is a free designer: it moves to him.
    expect(
      rebalance(designers, [design(1, "dee", "running"), waiting], []),
    ).toEqual([
      { id: waiting.id, floorId: "web-shop", issue: 2, from: "dee", to: "dan" },
    ]);
    // QA's waiting work never moves to a designer.
    expect(
      rebalance(
        designers.filter(({ role }) => role !== "qa"),
        [item(3, null, "queued", { stage: "needs-qa" })],
        [],
      ),
    ).toEqual([]);
  });

  it("finds a free designer for the watchdog's designer work", () => {
    expect(freeAgent("needs-qa", designers, [], [], "dee", "designer")).toBe(
      "dan",
    );
    expect(freeAgent("needs-qa", designers, [], [], "quinn")).toBeNull();
  });
});
