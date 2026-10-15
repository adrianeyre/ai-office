import {
  randomAvatar,
  type PlanDraft,
  type PlanItem,
  type Role,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import type { AgentRecord } from "../agents/store.ts";
import { builtInStage } from "../roles/testing.ts";
import type { WorkItem } from "../work/store.ts";
import {
  changedOrder,
  parallelGroups,
  planByRules,
  planFromDraft,
  replanByRules,
  replanFromDraft,
  replanMidBatch,
  type EditedIssue,
  type PlanIssue,
  type PlanTeam,
} from "./plan.ts";

// A Batch's Plan in plain code (PRD FR-25): the Manager's draft is checked
// against the Batch, then completed: issues that share a likely file run
// one after another, issues given to no coder go to the least busy, and
// the issues with no dependency between them form parallel groups. AI
// Office's rules draft a Plan when the Model gives none. After the Owner
// edits a Plan, the Manager's replan must keep their order; the rules
// replan it when the Model cannot. Changed from the chat while its work is
// under way, the rules replan it, leaving the issues started as they were.

const agent = (
  id: string,
  role: Role,
  overrides: Partial<AgentRecord> = {},
): AgentRecord => ({
  id,
  floorId: "web-shop",
  name: `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
  role,
  stage: builtInStage(role),
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

const running = (issue: number, agentId: string): WorkItem => ({
  id: issue,
  floorId: "web-shop",
  issue,
  stage: "needs-work",
  agentId,
  status: "running",
  priority: "normal",
  createdAt: new Date("2026-10-09T09:00:00.000Z"),
  startedAt: new Date("2026-10-09T09:00:00.000Z"),
  finishedAt: null,
});

const agents = [
  agent("grace", "manager"),
  agent("ada", "coder"),
  agent("alan", "coder"),
  agent("hopper", "coder", { enabled: false }),
  agent("linus", "reviewer"),
];
const team: PlanTeam = { agents, active: [], paused: [] };

const issues: PlanIssue[] = [1, 2, 3, 4, 5].map((number) => ({
  number,
  title: `Issue ${String(number)}`,
}));

const planned = (
  issue: number,
  overrides: Partial<PlanDraft["issues"][number]> = {},
): PlanDraft["issues"][number] => ({
  issue,
  dependsOn: [],
  files: [],
  agent: null,
  note: "",
  ...overrides,
});

const draft = (...planIssues: PlanDraft["issues"]): PlanDraft => ({
  summary: "Basket first, then the rest.",
  issues: planIssues,
});

describe("a Plan from the Manager's draft", () => {
  it("keeps the order, dependencies, files, coders and notes, and works out the parallel groups", () => {
    const result = planFromDraft(
      draft(
        planned(1, {
          files: ["./src/basket.ts", "src/basket.ts", "/src/types.ts"],
          agent: "Ada",
          note: "The others build on its basket.",
        }),
        planned(3, { files: ["src/wish-list.ts"], agent: "alan" }),
        planned(2, { dependsOn: [1], files: ["src\\checkout.ts"] }),
        planned(5, { dependsOn: [2, 3] }),
        planned(4, { agent: "Ada" }),
      ),
      issues,
      team,
      [{ issue: 6, reason: "it is closed" }],
    );
    expect(result).toEqual({
      ok: true,
      value: {
        draftedBy: "model",
        summary: "Basket first, then the rest.",
        items: [
          {
            issue: 1,
            title: "Issue 1",
            dependsOn: [],
            files: ["src/basket.ts", "src/types.ts"],
            agentId: "ada",
            note: "The others build on its basket.",
          },
          {
            issue: 3,
            title: "Issue 3",
            dependsOn: [],
            files: ["src/wish-list.ts"],
            agentId: "alan",
            note: "",
          },
          {
            issue: 2,
            title: "Issue 2",
            dependsOn: [1],
            files: ["src/checkout.ts"],
            // Alan had one issue, Ada two: the least busy coder.
            agentId: "alan",
            note: "",
          },
          {
            issue: 5,
            title: "Issue 5",
            dependsOn: [3, 2],
            files: [],
            agentId: "ada",
            note: "",
          },
          {
            issue: 4,
            title: "Issue 4",
            dependsOn: [],
            files: [],
            agentId: "ada",
            note: "",
          },
        ],
        overlaps: [],
        parallel: [[1, 3, 4], [2], [5]],
        leftOut: [{ issue: 6, reason: "it is closed" }],
      },
    });
  });

  it("runs issues that share a likely file one after another", () => {
    const result = planFromDraft(
      draft(
        planned(1, { files: ["src/basket.ts"] }),
        planned(2, { files: ["src/basket.ts", "src/checkout.ts"] }),
        planned(3, { files: ["src/checkout.ts"] }),
        planned(4, { dependsOn: [1], files: ["src/basket.ts"] }),
        planned(5, { files: ["README.md"] }),
      ),
      issues,
      team,
      [],
    );
    if (!result.ok) {
      throw new Error(result.problem);
    }
    expect(result.value.overlaps).toEqual([
      { issues: [1, 2], files: ["src/basket.ts"] },
      { issues: [2, 3], files: ["src/checkout.ts"] },
      { issues: [1, 4], files: ["src/basket.ts"] },
      { issues: [2, 4], files: ["src/basket.ts"] },
    ]);
    expect(
      result.value.items.map(({ issue, dependsOn }) => [issue, dependsOn]),
    ).toEqual([
      [1, []],
      // Added for the shared file.
      [2, [1]],
      // #3 shares a file with #2 only.
      [3, [2]],
      // Already after #1; added after #2.
      [4, [1, 2]],
      [5, []],
    ]);
    expect(result.value.parallel).toEqual([[1, 5], [2], [3, 4]]);
  });

  it("does not add a dependency an issue already has through others", () => {
    const result = planFromDraft(
      draft(
        planned(1, { files: ["a.ts"] }),
        planned(2, { dependsOn: [1] }),
        planned(3, { dependsOn: [2], files: ["a.ts"] }),
      ),
      issues.slice(0, 3),
      team,
      [],
    );
    if (!result.ok) {
      throw new Error(result.problem);
    }
    expect(result.value.overlaps).toEqual([
      { issues: [1, 3], files: ["a.ts"] },
    ]);
    expect(result.value.items[2]?.dependsOn).toEqual([2]);
  });

  it("shares issues given to no coder across the least busy, preferring those not paused at a Token Cap", () => {
    const busy: PlanTeam = {
      agents,
      active: [running(40, "ada"), running(41, "ada")],
      paused: [],
    };
    const result = planFromDraft(
      draft(planned(1), planned(2), planned(3), planned(4)),
      issues.slice(0, 4),
      busy,
      [],
    );
    if (!result.ok) {
      throw new Error(result.problem);
    }
    // Ada has two pieces of work already: Alan takes two before her turn.
    expect(result.value.items.map(({ agentId }) => agentId)).toEqual([
      "alan",
      "alan",
      "ada",
      "alan",
    ]);

    const capped = planFromDraft(
      draft(planned(1), planned(2)),
      issues.slice(0, 2),
      { agents, active: [], paused: ["ada"] },
      [],
    );
    expect(
      capped.ok && capped.value.items.map(({ agentId }) => agentId),
    ).toEqual(["alan", "alan"]);
  });

  it("gives an issue to no one when the Floor has no coder", () => {
    const result = planFromDraft(
      draft(planned(1)),
      issues.slice(0, 1),
      { agents: [agent("grace", "manager")], active: [], paused: [] },
      [],
    );
    expect(result.ok && result.value.items[0]?.agentId).toBeNull();
  });

  it("says what is wrong with a draft that does not fit the Batch", () => {
    const result = planFromDraft(
      draft(
        planned(1, { dependsOn: [3] }),
        planned(2, { dependsOn: [2, 9] }),
        planned(2),
        planned(7),
        planned(3, { agent: "Hopper" }),
        planned(4, { agent: "Linus" }),
      ),
      issues,
      team,
      [],
    );
    expect(result).toEqual({
      ok: false,
      problem: [
        "#1 depends on #3, which comes after it: an issue may depend only on issues before it, so put #3 first.",
        "#2 depends on itself.",
        "#2 depends on #9, which is not in the Batch: depend only on #1, #2, #3, #4 and #5.",
        "#2 is planned twice: plan each issue once.",
        "#7 is not in the Batch: plan only #1, #2, #3, #4 and #5.",
        '#3 is given to "Hopper", who is not one of the Floor\'s coders: give it to Ada or Alan, or make agent null.',
        '#4 is given to "Linus", who is not one of the Floor\'s coders: give it to Ada or Alan, or make agent null.',
        "#5 is missing: plan every issue in the Batch once.",
      ].join(" "),
    });
  });
});

describe("AI Office's rules", () => {
  it("plan the issues in the order named, all at once, shared across the coders", () => {
    expect(
      planByRules(
        issues.slice(0, 3),
        team,
        [{ issue: 9, reason: "it was not found on GitHub" }],
        "Grace is paused",
      ),
    ).toEqual({
      draftedBy: "rules",
      summary:
        "AI Office's rules drafted this Plan, as Grace is paused: the issues in the order you named them, with no dependencies between them, so they run in parallel as the Floor's coders and sandboxes are free.",
      items: [
        {
          issue: 1,
          title: "Issue 1",
          dependsOn: [],
          files: [],
          agentId: "ada",
          note: "",
        },
        {
          issue: 2,
          title: "Issue 2",
          dependsOn: [],
          files: [],
          agentId: "alan",
          note: "",
        },
        {
          issue: 3,
          title: "Issue 3",
          dependsOn: [],
          files: [],
          agentId: "ada",
          note: "",
        },
      ],
      overlaps: [],
      parallel: [[1, 2, 3]],
      leftOut: [{ issue: 9, reason: "it was not found on GitHub" }],
    });
  });
});

describe("replanning the Owner's edits", () => {
  // The Owner kept #3, #1 and #2, in that order, dropping #4 and #5.
  const edited: EditedIssue[] = [
    { number: 3, title: "Issue 3", annotation: "Most urgent." },
    { number: 1, title: "Issue 1", annotation: "" },
    { number: 2, title: "Issue 2", annotation: "Small, please." },
  ];
  const dropped = [
    { issue: 4, reason: "you dropped it from the Plan" },
    { issue: 5, reason: "you dropped it from the Plan" },
  ];

  it("keeps the Manager's replan only in the Owner's order, with their annotations", () => {
    const wrongOrder = replanFromDraft(
      draft(planned(1), planned(3), planned(2)),
      edited,
      team,
      dropped,
    );
    expect(wrongOrder).toEqual({
      ok: false,
      problem:
        "Keep the Owner's order exactly: #3, #1, #2, each once, and no other issue.",
    });
    expect(
      replanFromDraft(
        draft(planned(3), planned(1), planned(2), planned(4)),
        edited,
        team,
        dropped,
      ).ok,
    ).toBe(false);
    // Otherwise it is checked as a draft is.
    expect(
      replanFromDraft(
        draft(planned(3), planned(1, { dependsOn: [2] }), planned(2)),
        edited,
        team,
        dropped,
      ),
    ).toMatchObject({
      ok: false,
      problem: expect.stringContaining(
        "#1 depends on #2, which comes after it",
      ) as unknown,
    });

    const replanned = replanFromDraft(
      draft(
        planned(3, { files: ["src/a.ts"], agent: "Alan", note: "First." }),
        planned(1, { files: ["src/b.ts"] }),
        planned(2, { files: ["./src/a.ts"] }),
      ),
      edited,
      team,
      dropped,
    );
    expect(replanned).toEqual({
      ok: true,
      value: {
        draftedBy: "model",
        summary: "Basket first, then the rest.",
        items: [
          {
            issue: 3,
            title: "Issue 3",
            dependsOn: [],
            files: ["src/a.ts"],
            agentId: "alan",
            note: "First.",
            annotation: "Most urgent.",
          },
          {
            issue: 1,
            title: "Issue 1",
            dependsOn: [],
            files: ["src/b.ts"],
            agentId: "ada",
            note: "",
          },
          {
            issue: 2,
            title: "Issue 2",
            dependsOn: [3],
            files: ["src/a.ts"],
            agentId: "ada",
            note: "",
            annotation: "Small, please.",
          },
        ],
        overlaps: [{ issues: [3, 2], files: ["src/a.ts"] }],
        parallel: [[3, 1], [2]],
        leftOut: dropped,
      },
    });
  });

  it("by AI Office's rules: the Owner's order, keeping each issue's files, coder, note and the dependencies still before it", () => {
    const previous = planFromDraft(
      draft(
        planned(1, { files: ["src/a.ts"], agent: "Ada", note: "Base." }),
        planned(2, { dependsOn: [1], agent: "Ada" }),
        planned(3, { files: ["src/a.ts"], agent: "Hopper" }),
        planned(4),
        planned(5),
      ),
      issues,
      {
        ...team,
        // Hopper was a coder then; it is paused now.
        agents: agents.map((member) =>
          member.id === "hopper" ? { ...member, enabled: true } : member,
        ),
      },
      [],
    );
    if (!previous.ok) {
      throw new Error(previous.problem);
    }
    // #3 shared src/a.ts with #1, so came after it.
    expect(previous.value.items[2]?.dependsOn).toEqual([1]);

    expect(
      replanByRules(previous.value, edited, team, dropped, "Grace is paused"),
    ).toEqual({
      draftedBy: "rules",
      summary:
        "AI Office's rules replanned your edits, as Grace is paused: the issues in your order, each keeping its likely files, its coder and the issues it depends on that still come before it. Issues that share a likely file run one after another.",
      items: [
        {
          issue: 3,
          title: "Issue 3",
          // #1 comes after it now.
          dependsOn: [],
          files: ["src/a.ts"],
          // Hopper is paused: shared out again.
          agentId: "alan",
          note: "",
          annotation: "Most urgent.",
        },
        {
          issue: 1,
          title: "Issue 1",
          // The shared file now puts #1 after #3.
          dependsOn: [3],
          files: ["src/a.ts"],
          agentId: "ada",
          note: "Base.",
        },
        {
          issue: 2,
          title: "Issue 2",
          dependsOn: [1],
          files: [],
          agentId: "ada",
          note: "",
          annotation: "Small, please.",
        },
      ],
      overlaps: [{ issues: [3, 1], files: ["src/a.ts"] }],
      parallel: [[3], [1], [2]],
      leftOut: dropped,
    });
  });
});

describe("changing a Batch while its work is under way", () => {
  it("skips or moves only issues still to start, putting those started first", () => {
    const order = [1, 2, 3, 4, 5];
    // #2 waited for something; #4 did not.
    const started = new Set([1, 4]);
    expect(changedOrder(order, started, { kind: "skip", issues: [3] })).toEqual(
      { ok: true, value: { order: [1, 4, 2, 5], skipped: [3] } },
    );
    expect(
      changedOrder(order, started, { kind: "skip", issues: [5, 2, 3] }),
    ).toEqual({ ok: true, value: { order: [1, 4], skipped: [2, 3, 5] } });
    expect(
      changedOrder(order, started, {
        kind: "move",
        issue: 5,
        direction: "up",
      }),
    ).toEqual({ ok: true, value: { order: [1, 4, 2, 5, 3], skipped: [] } });
    expect(
      changedOrder(order, started, {
        kind: "move",
        issue: 2,
        direction: "down",
      }),
    ).toEqual({ ok: true, value: { order: [1, 4, 3, 2, 5], skipped: [] } });
    // Before approval nothing has started.
    expect(
      changedOrder(order, new Set(), {
        kind: "move",
        issue: 2,
        direction: "up",
      }),
    ).toEqual({ ok: true, value: { order: [2, 1, 3, 4, 5], skipped: [] } });
  });

  it("says why a change does not fit", () => {
    const order = [1, 2, 3];
    const started = new Set([1]);
    expect(
      changedOrder(order, started, { kind: "skip", issues: [1, 9] }),
    ).toEqual({
      ok: false,
      problem:
        "#1's work has started, so it is not skipped: work that has started carries on. #9 is not in the Plan.",
    });
    expect(
      changedOrder(order, started, {
        kind: "move",
        issue: 1,
        direction: "down",
      }),
    ).toEqual({
      ok: false,
      problem: "#1's work has started, so moving it would change nothing.",
    });
    expect(
      changedOrder(order, started, {
        kind: "move",
        issue: 2,
        direction: "up",
      }),
    ).toEqual({
      ok: false,
      problem:
        "#2 is already the first issue still to start, so it cannot move up.",
    });
    expect(
      changedOrder(order, started, {
        kind: "move",
        issue: 3,
        direction: "down",
      }),
    ).toEqual({
      ok: false,
      problem:
        "#3 is already the last issue still to start, so it cannot move down.",
    });
    expect(
      changedOrder(order, new Set(), { kind: "skip", issues: [1, 2, 3] }),
    ).toEqual({
      ok: false,
      problem: "Keep at least one issue: a Plan cannot drop every issue.",
    });
  });

  it("by AI Office's rules: the issues started exactly as they were, the rest re-sequenced in the new order", () => {
    const item = (issue: number, fields: Partial<PlanItem> = {}): PlanItem => ({
      issue,
      title: `Issue ${String(issue)}`,
      dependsOn: [],
      files: [],
      agentId: null,
      note: "",
      ...fields,
    });
    const previous = {
      items: [
        item(1, { files: ["src/a.ts"], agentId: "ada", note: "First." }),
        // Started beside #1, though they share a file.
        item(2, { files: ["src/a.ts"], agentId: "alan" }),
        item(3, {
          files: ["src/b.ts"],
          agentId: "hopper",
          annotation: "Small.",
        }),
        item(4, {
          dependsOn: [3],
          files: ["src/a.ts"],
          agentId: "ada",
          note: "After #3.",
        }),
      ],
    };
    const started = new Set([1, 2]);
    const moved = changedOrder(
      previous.items.map(({ issue }) => issue),
      started,
      { kind: "move", issue: 4, direction: "up" },
    );
    if (!moved.ok) {
      throw new Error(moved.problem);
    }
    const leftOut = [{ issue: 5, reason: "you skipped it" }];
    expect(
      replanMidBatch(
        previous,
        moved.value.order,
        started,
        { ...team, active: [running(1, "ada"), running(2, "alan")] },
        leftOut,
        "Replanned.",
      ),
    ).toEqual({
      draftedBy: "rules",
      summary: "Replanned.",
      items: [
        previous.items[0],
        // Started: nothing new to wait for.
        previous.items[1],
        // #3 comes after it now; it shares src/a.ts with #1 and #2.
        { ...previous.items[3], dependsOn: [1, 2] },
        // Hopper is paused: shared out again, to the least busy coder.
        { ...previous.items[2], agentId: "alan" },
      ],
      overlaps: [
        { issues: [1, 2], files: ["src/a.ts"] },
        { issues: [1, 4], files: ["src/a.ts"] },
        { issues: [2, 4], files: ["src/a.ts"] },
      ],
      parallel: [[1, 2, 3], [4]],
      leftOut,
    });
  });
});

describe("parallel groups", () => {
  it("put each issue after every group holding one it depends on", () => {
    const item = (issue: number, dependsOn: number[]) => ({
      issue,
      title: "",
      dependsOn,
      files: [],
      agentId: null,
      note: "",
    });
    expect(
      parallelGroups([
        item(1, []),
        item(2, [1]),
        item(3, []),
        item(4, [2, 3]),
        item(5, [1]),
      ]),
    ).toEqual([[1, 3], [2, 5], [4]]);
    expect(parallelGroups([])).toEqual([]);
  });
});

describe("work Roles in turn (FR-25 (1))", () => {
  // A store's Floor: two merchandisers and a copywriter.
  const worker = (id: string, role: string) => ({
    ...agent(id, "coder"),
    role,
  });
  const store: PlanTeam = {
    agents: [
      agent("grace", "manager"),
      worker("mia", "merchandiser"),
      worker("max", "merchandiser"),
      worker("cole", "copywriter"),
    ],
    active: [running(9, "mia")],
    paused: [],
    roles: [
      { id: "merchandiser", name: "merchandiser", description: "Products." },
      { id: "copywriter", name: "Copywriter", description: "Words." },
    ],
  };
  const two = issues.slice(0, 2);

  it("keeps each issue's work Roles in order, giving it a coder of its first Role", () => {
    const plan = planFromDraft(
      draft(
        planned(1, { roles: ["merchandiser", "copywriter"] }),
        planned(2, { roles: ["COPYWRITER"] }),
      ),
      two,
      store,
      [],
    );
    expect(plan.ok && plan.value.items).toEqual([
      {
        issue: 1,
        title: "Issue 1",
        dependsOn: [],
        files: [],
        // The least busy merchandiser.
        agentId: "max",
        roles: ["merchandiser", "copywriter"],
        note: "",
      },
      {
        issue: 2,
        title: "Issue 2",
        dependsOn: [],
        files: [],
        agentId: "cole",
        roles: ["copywriter"],
        note: "",
      },
    ]);
    // An issue given none gets its Role from triage as it starts.
    const none = planFromDraft(draft(planned(1), planned(2)), two, store, []);
    expect(none.ok && none.value.items.map(({ roles }) => roles)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("says what is wrong with an issue's work Roles", () => {
    expect(
      planFromDraft(
        draft(
          planned(1, { roles: ["merchandiser", "seo"] }),
          planned(2, {
            roles: ["copywriter", "copywriter"],
            agent: "Mia",
          }),
        ),
        two,
        store,
        [],
      ),
    ).toEqual({
      ok: false,
      problem: [
        `#1 names "seo" in roles, which is not one of the Floor's work Roles: name only merchandiser or Copywriter.`,
        "#2 names a work Role twice in roles: each Role takes one turn.",
        `#2 is given to "Mia", who is not a Copywriter, its first work Role: give it to Cole, or make agent null.`,
      ].join(" "),
    });
  });

  it("gives none on a Floor with one work Role", () => {
    const plan = planFromDraft(
      draft(planned(1, { roles: ["coder", "anything"] })),
      issues.slice(0, 1),
      { ...team, roles: [{ id: "coder", name: "coder", description: "" }] },
      [],
    );
    expect(plan.ok && plan.value.items[0]?.roles).toBeUndefined();
  });

  it("the Manager's replan keeps the Owner's work Roles exactly; the rules keep them too", () => {
    const edited: EditedIssue[] = [
      {
        number: 1,
        title: "Issue 1",
        annotation: "",
        roles: ["copywriter", "merchandiser"],
      },
      { number: 2, title: "Issue 2", annotation: "", roles: ["copywriter"] },
    ];
    expect(
      replanFromDraft(
        draft(
          planned(1, { roles: ["merchandiser", "copywriter"] }),
          planned(2, { roles: ["copywriter"] }),
        ),
        edited,
        store,
        [],
      ),
    ).toEqual({
      ok: false,
      problem:
        "Keep the Owner's work Roles for #1 exactly, in turn: the Copywriter, then the merchandiser.",
    });
    const kept = replanFromDraft(
      draft(
        planned(1, { roles: ["copywriter", "merchandiser"] }),
        planned(2, { roles: ["copywriter"] }),
      ),
      edited,
      store,
      [],
    );
    expect(
      kept.ok && kept.value.items.map(({ roles, agentId }) => [roles, agentId]),
    ).toEqual([
      [["copywriter", "merchandiser"], "cole"],
      [["copywriter"], "cole"],
    ]);

    // The rules: the Owner's Roles, and a coder of the new first Role in
    // place of the merchandiser the Plan had.
    const replanned = replanByRules(
      {
        items: [
          {
            issue: 1,
            title: "Issue 1",
            dependsOn: [],
            files: [],
            agentId: "mia",
            roles: ["merchandiser", "copywriter"],
            note: "",
          },
          {
            issue: 2,
            title: "Issue 2",
            dependsOn: [],
            files: [],
            agentId: "cole",
            roles: ["copywriter", "merchandiser"],
            note: "",
          },
        ],
      },
      edited,
      store,
      [],
      "Grace is paused",
    );
    expect(
      replanned.items.map(({ roles, agentId }) => [roles, agentId]),
    ).toEqual([
      [["copywriter", "merchandiser"], "cole"],
      [["copywriter"], "cole"],
    ]);
    expect(replanned.summary).toContain("its work Roles as you left them");
  });
});
