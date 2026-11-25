import { describe, expect, it } from "vitest";

import {
  acceptanceCriteriaProblems,
  acceptanceCriterionProblemLine,
} from "./acceptance-criteria.ts";
import type { SpecRequirements } from "./spec.ts";

// The Acceptance Criteria checker (Guidelines, Specs and Hooks PRD,
// FR-114): each criterion is one testable statement in one of four forms,
// with an id of its own, and every one that fails is named with why.

/** Requirements of one user story per list of criteria. */
const requirementsOf = (...stories: string[][]): SpecRequirements => ({
  introduction: "",
  requirements: stories.map((criteria, index) => ({
    title: `Story ${String(index + 1)}`,
    story: "As a shopper, I want to save my card, so that I pay faster.",
    criteria,
  })),
});

/** Every problem's place and reasons. */
const problemsOf = (...stories: string[][]) =>
  acceptanceCriteriaProblems(requirementsOf(...stories)).map(
    ({ requirement, criterion, id, reasons }) => ({
      at: `${String(requirement)}.${String(criterion)}`,
      id,
      reasons,
    }),
  );

const notAForm =
  'it is not in a criterion\'s form: "WHEN <trigger> THE SYSTEM SHALL <response>", or its "IF … THEN … SHALL", "WHILE … SHALL" or "WHERE … SHALL" forms, its keywords in capitals';

describe("each form of an Acceptance Criterion", () => {
  it.each([
    [
      "WHEN",
      "R1.1 WHEN a shopper ticks Save card THE SYSTEM SHALL keep the card's token.",
    ],
    [
      "WHEN, with a comma",
      "R1.1 WHEN a shopper ticks Save card, THE SYSTEM SHALL keep the card's token.",
    ],
    [
      "IF … THEN",
      "R1.1 IF a saved card is declined THEN THE SYSTEM SHALL ask for another card.",
    ],
    [
      "IF … THEN, with its own subject",
      "R1.1 IF a saved card is declined THEN the checkout SHALL ask for another card.",
    ],
    [
      "WHILE",
      "R1.1 WHILE a payment is in progress THE SYSTEM SHALL keep the Pay button disabled.",
    ],
    [
      "WHERE",
      "R1.1 WHERE the shop takes wallets THE SYSTEM SHALL offer them beside saved cards.",
    ],
    [
      "WHILE and WHEN together",
      "R1.1 WHILE a shopper is signed in, WHEN they check out THE SYSTEM SHALL offer their saved cards.",
    ],
    [
      "an id in bold, followed by a colon",
      "**R1.1**: WHEN a card is saved THE SYSTEM SHALL show its last four digits.",
    ],
  ])("passes %s", (_form, criterion) => {
    expect(problemsOf([criterion])).toEqual([]);
  });

  it.each([
    ["WHEN without THE SYSTEM SHALL", "R1.1 WHEN a card is saved it is kept."],
    [
      "WHEN with another subject",
      "R1.1 WHEN a card is saved the vault SHALL keep it.",
    ],
    [
      "WHEN with no trigger",
      "R1.1 WHEN THE SYSTEM SHALL keep the card's token.",
    ],
    ["WHEN with no response", "R1.1 WHEN a card is saved THE SYSTEM SHALL"],
    [
      "IF without THEN",
      "R1.1 IF a saved card is declined THE SYSTEM SHALL ask for another.",
    ],
    [
      "IF … THEN with no SHALL",
      "R1.1 IF a saved card is declined THEN ask for another card.",
    ],
    ["WHILE with no SHALL", "R1.1 WHILE a payment is in progress, wait."],
    ["WHERE with no SHALL", "R1.1 WHERE the shop takes wallets, offer them."],
    [
      "its keywords not in capitals",
      "R1.1 When a card is saved the system shall keep its token.",
    ],
    [
      "SHOULD for SHALL",
      "R1.1 WHEN a card is saved THE SYSTEM SHOULD keep its token.",
    ],
  ])("refuses %s", (_form, criterion) => {
    expect(problemsOf([criterion])).toEqual([
      { at: "1.1", id: "R1.1", reasons: [notAForm] },
    ]);
  });

  it("refuses two behaviours in one criterion", () => {
    expect(
      problemsOf([
        "R1.1 WHEN a card is saved THE SYSTEM SHALL keep its token and SHALL email the shopper.",
      ]),
    ).toEqual([
      {
        at: "1.1",
        id: "R1.1",
        reasons: [
          "it says SHALL more than once: give each behaviour a criterion of its own",
        ],
      },
    ]);
  });
});

describe("an Acceptance Criterion's id", () => {
  it("is required", () => {
    expect(
      problemsOf(
        ["R1.1 WHEN a card is saved THE SYSTEM SHALL keep its token."],
        [
          "R2.1 WHEN a shopper checks out THE SYSTEM SHALL offer saved cards.",
          "WHEN a saved card is declined THE SYSTEM SHALL ask for another.",
        ],
      ),
    ).toEqual([
      {
        at: "2.2",
        id: undefined,
        reasons: ["it has no id: start it with one, such as R2.2"],
      },
    ]);
  });

  it("is requirement's own: R<its number>.<a number from 1>, with a capital R", () => {
    expect(
      problemsOf(
        ["R1.1 WHEN a card is saved THE SYSTEM SHALL keep its token."],
        [
          "R1.2 WHEN a shopper checks out THE SYSTEM SHALL offer saved cards.",
          "R2.0 WHEN a saved card is declined THE SYSTEM SHALL ask for another.",
          "r2.3 WHEN a card expires THE SYSTEM SHALL stop offering it.",
        ],
      ),
    ).toEqual([
      {
        at: "2.1",
        id: "R1.2",
        reasons: [
          "its id R1.2 is not one of requirement 2's: they are R2.1, R2.2 and on",
        ],
      },
      {
        at: "2.2",
        id: "R2.0",
        reasons: [
          "its id R2.0 is not one of requirement 2's: they are R2.1, R2.2 and on",
        ],
      },
      {
        at: "2.3",
        id: "r2.3",
        reasons: ['its id is written "r2.3": write it with a capital R'],
      },
    ]);
  });

  it("is unique: every criterion sharing one is named, with where else it is", () => {
    expect(
      problemsOf(
        [
          "R1.1 WHEN a card is saved THE SYSTEM SHALL keep its token.",
          "R1.1 WHEN a card is saved THE SYSTEM SHALL show its last four digits.",
          "R1.2 WHEN a card is removed THE SYSTEM SHALL forget its token.",
          "r1.1 WHEN a card expires THE SYSTEM SHALL stop offering it.",
        ],
        ["R2.1 WHEN a shopper checks out THE SYSTEM SHALL offer saved cards."],
      ),
    ).toEqual([
      {
        at: "1.1",
        id: "R1.1",
        reasons: [
          "its id R1.1 is also requirement 1's criterion 2 and requirement 1's criterion 4's: each id is used once",
        ],
      },
      {
        at: "1.2",
        id: "R1.1",
        reasons: [
          "its id R1.1 is also requirement 1's criterion 1 and requirement 1's criterion 4's: each id is used once",
        ],
      },
      {
        at: "1.4",
        id: "r1.1",
        reasons: [
          'its id is written "r1.1": write it with a capital R',
          "its id R1.1 is also requirement 1's criterion 1 and requirement 1's criterion 2's: each id is used once",
        ],
      },
    ]);
  });

  it("need not follow the criterion's place, so long as it is unique", () => {
    expect(
      problemsOf([
        "R1.2 WHEN a card is saved THE SYSTEM SHALL keep its token.",
        "R1.1 WHEN a card is removed THE SYSTEM SHALL forget its token.",
        "R1.7 WHEN a card expires THE SYSTEM SHALL stop offering it.",
      ]),
    ).toEqual([]);
  });
});

describe("prose that is not a criterion", () => {
  it("is refused for its missing id and form, both", () => {
    expect(
      problemsOf([
        "Saving a card should be quick and easy.",
        "R1.2 Saved cards are shown at checkout.",
        "R1.3",
      ]),
    ).toEqual([
      {
        at: "1.1",
        id: undefined,
        reasons: ["it has no id: start it with one, such as R1.1", notAForm],
      },
      { at: "1.2", id: "R1.2", reasons: [notAForm] },
      { at: "1.3", id: "R1.3", reasons: [notAForm] },
    ]);
  });
});

describe("every failing criterion", () => {
  it("is reported, in order, not just the first", () => {
    const problems = acceptanceCriteriaProblems(
      requirementsOf(
        [
          "R1.1 WHEN a card is saved THE SYSTEM SHALL keep its token.",
          "Cards are kept safe.",
        ],
        [
          "R2.1 WHEN a shopper checks out THE SYSTEM SHALL offer saved cards.",
          "R2.1 IF a saved card is declined THEN THE SYSTEM SHALL ask for another card.",
          "R2.2 WHILE paying, wait.",
        ],
      ),
    );
    expect(
      problems.map(({ requirement, criterion }) => [requirement, criterion]),
    ).toEqual([
      [1, 2],
      [2, 1],
      [2, 2],
      [2, 3],
    ]);
  });

  it("reads as a line naming it, quoting it (cut short when long) and saying why", () => {
    const [missing, long] = acceptanceCriteriaProblems(
      requirementsOf([
        "Cards are kept safe.",
        `R1.2 WHEN a card is saved THE SYSTEM SHALL ${"keep it ".repeat(30)}SHALL`,
      ]),
    );
    expect(missing && acceptanceCriterionProblemLine(missing)).toBe(
      `- Requirement 1, criterion 1, "Cards are kept safe.": it has no id: start it with one, such as R1.1; ${notAForm}.`,
    );
    const line = long ? acceptanceCriterionProblemLine(long) : "";
    expect(line).toMatch(
      /^- Requirement 1, criterion 2 \(R1\.2\), "R1\.2 WHEN a card is saved THE SYSTEM SHALL keep it keep it .*…": it says SHALL more than once: give each behaviour a criterion of its own\.$/,
    );
    expect(line).not.toContain("keep it SHALL");
  });

  it("is none when every criterion passes", () => {
    expect(
      acceptanceCriteriaProblems(
        requirementsOf(
          [
            "R1.1 WHEN a card is saved THE SYSTEM SHALL keep its token.",
            "R1.2 WHERE the shop takes wallets THE SYSTEM SHALL offer them.",
          ],
          [
            "R2.1 WHILE a payment is in progress THE SYSTEM SHALL keep Pay disabled.",
            "R2.2 IF a saved card is declined THEN THE SYSTEM SHALL ask for another card.",
          ],
        ),
      ),
    ).toEqual([]);
  });
});
