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
  specConfirmationText,
  specFiles,
  specIssueDrafts,
  specIssues,
  specInstructions,
  specSection,
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
  {
    title: "Vault",
    description: "The vault.",
    meets: ["R1.1"],
    dependsOn: [],
    size: "small",
  },
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

  it("refuses the requirements while any Acceptance Criterion fails, naming every one and why", () => {
    const failing = drafted(start, {
      requirements: {
        requirements: [
          {
            title: "Save a card",
            story: "As a shopper, I want to save my card.",
            criteria: [
              "R1.1 WHEN a card is saved THE SYSTEM SHALL keep its token.",
              "Saving should be quick.",
              "R1.1 WHEN a card is saved THE SYSTEM SHALL show its last four digits.",
            ],
          },
          {
            title: "Pay with it",
            story: "As a shopper, I want to pay with a saved card.",
            criteria: [
              "R2.1 WHILE paying THE SYSTEM SHALL disable Pay and SHALL show a spinner.",
              "R1.3 IF a card is declined THEN THE SYSTEM SHALL ask for another.",
            ],
          },
        ],
      },
    });
    const refusal = confirmProblem(failing, "requirements");
    expect(refusal).toBe(
      [
        'The requirements cannot be confirmed yet: 5 Acceptance Criteria fail the check. Each is one testable statement starting with an id of its own, R<requirement>.<number> (R2.3 is one of requirement 2\'s), in the form "WHEN <trigger> THE SYSTEM SHALL <response>", or its "IF … THEN … SHALL", "WHILE … SHALL" or "WHERE … SHALL" forms.',
        "",
        "- Requirement 1, criterion 1 (R1.1), \"R1.1 WHEN a card is saved THE SYSTEM SHALL keep its token.\": its id R1.1 is also requirement 1's criterion 3's: each id is used once.",
        `- Requirement 1, criterion 2, "Saving should be quick.": it has no id: start it with one, such as R1.2; it is not in a criterion's form: "WHEN <trigger> THE SYSTEM SHALL <response>", or its "IF … THEN … SHALL", "WHILE … SHALL" or "WHERE … SHALL" forms, its keywords in capitals.`,
        "- Requirement 1, criterion 3 (R1.1), \"R1.1 WHEN a card is saved THE SYSTEM SHALL show its last four digits.\": its id R1.1 is also requirement 1's criterion 1's: each id is used once.",
        '- Requirement 2, criterion 1 (R2.1), "R2.1 WHILE paying THE SYSTEM SHALL disable Pay and SHALL show a spinner.": it says SHALL more than once: give each behaviour a criterion of its own.',
        '- Requirement 2, criterion 2 (R1.3), "R1.3 IF a card is declined THEN THE SYSTEM SHALL ask for another.": its id R1.3 is not one of requirement 2\'s: they are R2.1, R2.2 and on.',
        "",
        "Say what to change, or ask for them to be fixed, and the Manager drafts them again.",
      ].join("\n"),
    );
    // Nothing is approved; once fixed, the requirements are confirmed.
    expect(failing.spec?.approved.requirements).toBeNull();
    expect(
      confirmProblem(drafted(failing, { requirements }), "requirements"),
    ).toBeUndefined();
  });

  it("says, when the requirements are drafted, that failing criteria hold them back, and tells the Manager which", () => {
    const failing = drafted(start, {
      requirements: {
        requirements: [
          {
            title: "Save a card",
            story: "As a shopper, I want to save my card.",
            criteria: ["Saving should be quick."],
          },
        ],
      },
    });
    const told = specConfirmationText("", failing);
    expect(told).toMatch(
      /^The requirements are drafted, and no open questions remain, but they cannot be confirmed yet: 1 Acceptance Criterion fails the check\./,
    );
    expect(told).toContain(
      '- Requirement 1, criterion 1, "Saving should be quick.": it has no id',
    );
    expect(told).not.toContain('Reply "confirm requirements"');
    const prompt = specSection(failing).join("\n");
    expect(prompt).toContain(
      "#### Acceptance Criteria in your draft that fail the check\n\n1 Acceptance Criterion fails the check.",
    );
    expect(prompt).toContain(
      "The Owner cannot confirm the requirements until every one passes: fix each in your next draft",
    );
    // Passing criteria: the usual invitation, and nothing for the Manager to fix.
    const passing = drafted(start, { requirements });
    expect(specConfirmationText("", passing)).toContain(
      'Reply "confirm requirements" to move on to the design',
    );
    expect(specSection(passing).join("\n")).not.toContain("fail the check");
  });

  it("teaches the Manager the criteria's form and what the check refuses", () => {
    const taught = specInstructions(start).join("\n");
    expect(taught).toContain(
      '"R2.3 WHEN <trigger> THE SYSTEM SHALL <response>", or its "IF <condition> THEN THE SYSTEM SHALL <response>", "WHILE <state> THE SYSTEM SHALL <response>" or "WHERE <option> THE SYSTEM SHALL <response>" forms',
    );
    expect(taught).toContain(
      "AI Office checks every criterion in plain code, and the Owner cannot confirm the requirements while any fails",
    );
    expect(taught).toContain("no other criterion has it");
    expect(taught).toContain("it says SHALL once, one behaviour per criterion");
    expect(taught).toContain("never in `criteria`");
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

  it("give each task a Size as it is written, medium unless the Model says, which its draft and tasks.md carry (Scorecards PRD, FR-132)", async () => {
    const confirmed = confirmSpecPhase(throughTasks(), at);
    expect(confirmed.spec?.approved.tasks?.map(({ size }) => size)).toEqual([
      "small",
      "medium",
    ]);
    const issues = specIssueDrafts(confirmed, at);
    expect(issues?.drafts.map(({ size }) => size)).toEqual(["small", "medium"]);
    const tasksFile = specFiles(confirmed).find(({ path }) =>
      path.endsWith("tasks.md"),
    );
    expect(tasksFile?.content).toContain("- **Size:** small");
    // The issues filed for them take those Sizes at triage.
    const filed = {
      ...confirmed,
      issues:
        issues === undefined
          ? null
          : {
              ...issues,
              drafts: issues.drafts.map((draft, index) => ({
                ...draft,
                filed: {
                  number: 40 + index,
                  url: `https://github.com/adrianeyre/web-shop/issues/${String(40 + index)}`,
                },
              })),
            },
    };
    expect(
      await specIssues({ list: () => Promise.resolve([filed]) }, "web-shop"),
    ).toEqual(
      new Map([
        [40, "small"],
        [41, "medium"],
      ]),
    );
  });

  it("are refused with a Size that is none of the three", () => {
    expect(
      grillingTurnSchema
        .safeParse({
          spec: { tasks: [{ ...tasks[0], size: "huge" }] },
        })
        .error?.issues.map(({ message }) => message),
    ).toEqual(['A task\'s size is "small", "medium" or "large".']);
  });
});
