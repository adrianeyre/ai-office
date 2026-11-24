import { grillingTurnSchema, newGrillingSpec } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { applyTurn, type GrillingSessionRecord } from "./session.ts";
import {
  confirmProblem,
  confirmSpecPhase,
  reopenProblem,
  reopenSpecPhase,
  skipProblem,
  skipSpecDesign,
  specFiles,
  specIssueDrafts,
} from "./spec.ts";

// A `/spec` session's plain-code rules (Guidelines, Specs and Hooks PRD,
// FR-113): only the current phase's draft is kept from a turn, the Owner
// confirms, skips and reopens phases, the branch holds exactly the
// approved documents, and the approved tasks become the issue drafts.

const at = new Date("2026-11-24T12:00:00.000Z");
const later = new Date("2026-11-24T12:05:00.000Z");

const start: GrillingSessionRecord = {
  id: 7,
  floorId: "web-shop",
  topic: "saved cards",
  skill: "spec",
  status: "active",
  round: 0,
  awaitingConfirmation: false,
  questions: [],
  decisions: [],
  terms: [],
  facts: [],
  outline: [],
  adrs: [],
  processes: [],
  documents: null,
  issues: null,
  sources: [],
  guidelines: [],
  spec: newGrillingSpec("saved-cards"),
  startedAt: at,
  updatedAt: at,
  pausedAt: null,
  endedAt: null,
};

const requirements = {
  introduction: "",
  requirements: [
    {
      title: "Save a card",
      story: "As a shopper, I want to save my card.",
      criteria: ["R1.1 WHEN a card is saved THE SYSTEM SHALL keep its token."],
    },
  ],
};
const design = {
  overview: "",
  architecture: "A vault.",
  data: "A table.",
  errorHandling: "Declines are not saved.",
  testing: "Per criterion.",
};
const tasks = [
  { title: "Vault", description: "The vault.", meets: ["R1.1"], dependsOn: [] },
  {
    title: "Tick box",
    description: "The tick box.",
    meets: ["R1.1", "R1.1"],
    dependsOn: [2, 1, 5],
  },
];

/** A turn with the documents given, and nothing left to ask. */
const drafted = (session: GrillingSessionRecord, spec: unknown) =>
  applyTurn(session, grillingTurnSchema.parse({ spec }), at).session;

/** The session with every phase drafted and confirmed in turn. */
const throughTasks = () => {
  let session = drafted(start, { requirements });
  session = confirmSpecPhase(session, at);
  session = drafted(session, { design });
  session = confirmSpecPhase(session, at);
  return drafted(session, { tasks });
};

describe("a /spec turn", () => {
  it("keeps only the current phase's document as its draft", () => {
    const session = drafted(start, { requirements, design, tasks });
    expect(session.spec?.drafts).toEqual({
      requirements,
      design: null,
      tasks: null,
    });
    expect(session.awaitingConfirmation).toBe(true);
  });

  it("leaves a draft as it was when the turn gives none, and keeps no other session's", () => {
    const first = drafted(start, { requirements });
    expect(drafted(first, {}).spec?.drafts.requirements).toEqual(requirements);
    const grilling = drafted(
      { ...start, skill: "grilling", spec: null },
      {
        requirements,
      },
    );
    expect(grilling.spec).toBeNull();
  });

  it("has each task depend only on earlier tasks, and name each criterion once", () => {
    const session = throughTasks();
    expect(session.spec?.drafts.tasks?.[1]).toMatchObject({
      meets: ["R1.1"],
      dependsOn: [1],
    });
  });
});

describe("confirming a phase", () => {
  it("is refused without a draft, with questions open, or for another phase", () => {
    expect(confirmProblem(start, "requirements")).toBe(
      "The requirements are not drafted yet: answer the open questions, or send a message for the draft.",
    );
    const asking = applyTurn(
      start,
      grillingTurnSchema.parse({
        spec: { requirements },
        questions: [{ text: "Five cards?", recommended: "Yes." }],
      }),
      at,
    ).session;
    expect(confirmProblem(asking, "requirements")).toBe(
      "The requirements still have questions to settle: answer the open ones first.",
    );
    const ready = drafted(start, { requirements });
    expect(confirmProblem(ready, "requirements")).toBeUndefined();
    expect(confirmProblem(ready, "tasks")).toBe(
      "The Spec is on the requirements: the tasks come after the requirements are confirmed.",
    );
  });

  it("keeps the draft as the approved copy, and moves to the next phase", () => {
    const confirmed = confirmSpecPhase(drafted(start, { requirements }), later);
    expect(confirmed.spec).toMatchObject({
      phase: "design",
      approved: { requirements, design: null, tasks: null },
      confirmedAt: { requirements: later.toISOString(), design: null },
    });
    expect(confirmed.awaitingConfirmation).toBe(false);
    expect(confirmProblem(confirmed, "requirements")).toBe(
      'The requirements are confirmed already; the Spec is on the design. Say "reopen requirements" to draft them again.',
    );
  });

  it("stays on the tasks once they are confirmed, the session's end", () => {
    const confirmed = confirmSpecPhase(throughTasks(), later);
    expect(confirmed.spec?.phase).toBe("tasks");
    expect(confirmed.spec?.approved.tasks).toHaveLength(2);
    expect(confirmed.awaitingConfirmation).toBe(true);
  });
});

describe("skipping the design", () => {
  it("is only for the design phase", () => {
    expect(skipProblem(start)).toBe(
      'The Spec is on the requirements: say "confirm requirements" first, then "skip design".',
    );
    expect(skipProblem(throughTasks())).toBe(
      'The design is confirmed already; say "reopen design" to draft it again first.',
    );
  });

  it("goes to the tasks with no design, its open questions withdrawn", () => {
    const onDesign = applyTurn(
      confirmSpecPhase(drafted(start, { requirements }), at),
      grillingTurnSchema.parse({
        spec: { design },
        questions: [{ text: "A vault?", recommended: "Yes." }],
      }),
      at,
    ).session;
    expect(skipProblem(onDesign)).toBeUndefined();
    const skipped = skipSpecDesign(onDesign, later);
    expect(skipped.spec).toMatchObject({
      phase: "tasks",
      designSkipped: true,
      approved: { requirements, design: null },
    });
    expect(skipped.questions.map(({ status }) => status)).toEqual([
      "withdrawn",
    ]);
    expect(skipProblem(skipped)).toBe("The design is skipped already.");
    expect(specFiles(skipped).map(({ path }) => path)).toEqual([
      ".agents/specs/saved-cards/requirements.md",
    ]);
  });
});

describe("reopening a phase", () => {
  it("is only for an earlier phase", () => {
    expect(reopenProblem(start, "requirements")).toBe(
      "The Spec is on the requirements already.",
    );
    expect(reopenProblem(start, "design")).toBe(
      "The Spec is on the requirements: the design has not been drafted yet.",
    );
    expect(reopenProblem(throughTasks(), "design")).toBeUndefined();
  });

  it("redrafts it from its draft, drops what is approved from it on, and drafts the later phases afresh", () => {
    const reopened = reopenSpecPhase(throughTasks(), "requirements", later);
    expect(reopened.spec).toEqual({
      slug: "saved-cards",
      phase: "requirements",
      drafts: { requirements, design: null, tasks: null },
      approved: { requirements: null, design: null, tasks: null },
      designSkipped: false,
      confirmedAt: { requirements: null, design: null, tasks: null },
    });
    expect(reopened.awaitingConfirmation).toBe(false);
    expect(specFiles(reopened)).toEqual([]);
  });

  it("keeps the phases before it as approved", () => {
    const reopened = reopenSpecPhase(throughTasks(), "design", later);
    expect(reopened.spec).toMatchObject({
      phase: "design",
      drafts: { requirements, design, tasks: null },
      approved: { requirements, design: null, tasks: null },
      confirmedAt: { requirements: at.toISOString(), design: null },
    });
  });

  it("undoes a skipped design when the requirements are reopened", () => {
    const skipped = skipSpecDesign(
      confirmSpecPhase(drafted(start, { requirements }), at),
      at,
    );
    expect(reopenSpecPhase(skipped, "requirements", later).spec).toMatchObject({
      designSkipped: false,
      confirmedAt: { design: null },
    });
  });
});

describe("the Spec's files and issue drafts", () => {
  it("are the approved documents, in .agents/specs/<slug>/", () => {
    const confirmed = confirmSpecPhase(throughTasks(), at);
    expect(specFiles(confirmed).map(({ path }) => path)).toEqual([
      ".agents/specs/saved-cards/requirements.md",
      ".agents/specs/saved-cards/design.md",
      ".agents/specs/saved-cards/tasks.md",
    ]);
  });

  it("are one issue draft per approved task, quoting its criteria; none before", () => {
    expect(specIssueDrafts(throughTasks(), at)).toBeUndefined();
    const issues = specIssueDrafts(confirmSpecPhase(throughTasks(), at), at);
    expect(
      issues?.drafts.map(({ id, title, blockedBy }) => [id, title, blockedBy]),
    ).toEqual([
      [1, "Vault", []],
      [2, "Tick box", [1]],
    ]);
    expect(issues?.drafts[0]?.acceptanceCriteria).toEqual([
      "R1.1 WHEN a card is saved THE SYSTEM SHALL keep its token.",
    ]);
    expect(issues?.approvedAt).toBeNull();
  });
});
