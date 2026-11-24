import { newGrillingSpec, type GrillingIssueDraft } from "@ai-office/shared";

import type { NewGrillingSession } from "./store.ts";

// For tests: a `/spec` session whose Spec the Owner approved, phase by
// phase, and whose tasks were filed as issues (Guidelines, Specs and Hooks
// PRD, FR-113 to FR-116).

const at = new Date("2026-11-24T12:00:00.000Z");

export const approvedRequirements = {
  introduction: "Shoppers save a card to pay faster next time.",
  requirements: [
    {
      title: "Save a card",
      story: "As a shopper, I want to save my card, so that I pay faster.",
      criteria: [
        "R1.1 WHEN a shopper ticks Save card THE SYSTEM SHALL keep the card's token.",
        "R1.2 IF the card is declined THEN THE SYSTEM SHALL not keep it.",
      ],
    },
    {
      title: "Remove a card",
      story: "As a shopper, I want to remove a saved card.",
      criteria: [
        "R2.1 WHEN a shopper removes a saved card THE SYSTEM SHALL stop offering it at checkout.",
      ],
    },
  ],
};

export const approvedDesign = {
  overview: "Cards are kept as the payment provider's tokens.",
  architecture: "A `vault` module beside the basket.",
  data: "A `saved_cards` table: shopper, token, last four digits.",
  errorHandling: "A declined card is never saved.",
  testing: "One property test per criterion.",
};

export const approvedTasks = [
  {
    title: "Keep a saved card",
    description: "The vault, and the Save card tick box.",
    meets: ["R1.1", "R1.2"],
    dependsOn: [],
  },
  {
    title: "Remove a saved card",
    description: "The Remove button.",
    meets: ["R2.1"],
    dependsOn: [1],
  },
];

/** A draft as the confirmed task makes it, filed as `filed`. */
const draftOf = (
  id: number,
  criteria: readonly string[],
  filed: number | null,
): GrillingIssueDraft => ({
  id,
  title: approvedTasks[id - 1]?.title ?? `Draft ${String(id)}`,
  whatToBuild: approvedTasks[id - 1]?.description ?? "Added by the Owner.",
  acceptanceCriteria: [...criteria],
  blockedBy: id === 2 ? [1] : [],
  prdSections: [],
  adrs: [],
  filed:
    filed === null
      ? null
      : {
          number: filed,
          url: `https://github.com/adrianeyre/web-shop/issues/${String(filed)}`,
        },
});

/**
 * A session on `floorId`: the Spec "saved cards" with its requirements,
 * design (unless `designSkipped`) and tasks approved, its two tasks filed
 * as issues `issues` (the first, the second).
 */
export function approvedSpecSession(
  options: {
    readonly floorId?: string;
    readonly issues?: readonly [number, number];
    readonly designSkipped?: boolean;
    readonly drafts?: readonly GrillingIssueDraft[];
  } = {},
): NewGrillingSession {
  const [first, second] = options.issues ?? [12, 13];
  const designSkipped = options.designSkipped === true;
  const design = designSkipped ? null : approvedDesign;
  const documents = {
    requirements: approvedRequirements,
    design,
    tasks: approvedTasks,
  };
  return {
    floorId: options.floorId ?? "web-shop",
    topic: "saved cards",
    skill: "spec",
    status: "ended",
    round: 3,
    awaitingConfirmation: false,
    questions: [],
    decisions: [],
    terms: [],
    facts: [],
    outline: [],
    adrs: [],
    processes: [],
    documents: null,
    issues: {
      drafts:
        options.drafts === undefined
          ? [
              draftOf(
                1,
                approvedRequirements.requirements[0]?.criteria ?? [],
                first,
              ),
              draftOf(
                2,
                approvedRequirements.requirements[1]?.criteria ?? [],
                second,
              ),
            ]
          : [...options.drafts],
      draftedAt: at.toISOString(),
      approvedAt: at.toISOString(),
      problem: null,
    },
    sources: [],
    guidelines: [],
    spec: {
      ...newGrillingSpec("saved-cards"),
      phase: "tasks",
      drafts: documents,
      approved: documents,
      designSkipped,
      confirmedAt: {
        requirements: at.toISOString(),
        design: at.toISOString(),
        tasks: at.toISOString(),
      },
    },
    startedAt: at,
    updatedAt: at,
    pausedAt: null,
    endedAt: at,
  };
}

/** A draft, for a test that edits a session's drafts. */
export const specDraft = draftOf;
