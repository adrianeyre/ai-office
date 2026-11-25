import { describe, expect, it } from "vitest";

import { issueSpec, specWithin, type IssueSpec } from "./issue-spec.ts";
import { memoryGrillingStore } from "./store.ts";
import {
  approvedDesign,
  approvedRequirements,
  approvedSpecSession,
  specDraft,
} from "./testing.ts";

// The Spec an issue was filed from, as the Owner approved it in its
// session (Guidelines, Specs and Hooks PRD, FR-116): its criteria and
// design.md come from the session's approved copy, never from the issue's
// text or the repository; and what of it fits a prompt's budget.

const [r11 = "", r12 = ""] =
  approvedRequirements.requirements[0]?.criteria ?? [];
const [r21 = ""] = approvedRequirements.requirements[1]?.criteria ?? [];

describe("the Spec an issue was filed from", () => {
  it("is the approved criteria the issue's draft names, and the approved design.md, by the issue's number", async () => {
    const store = memoryGrillingStore();
    const { id } = await store.create(approvedSpecSession());
    const spec = await issueSpec(store, "web-shop", 13);
    expect(spec).toEqual({
      sessionId: id,
      folder: ".agents/specs/saved-cards",
      task: 2,
      criteria: [r21],
      design: expect.stringContaining("# Design: saved cards") as string,
    });
    expect(spec?.design).toContain(approvedDesign.architecture);
    expect(spec?.design).toContain("## Error handling");
    expect((await issueSpec(store, "web-shop", 12))?.criteria).toEqual([
      r11,
      r12,
    ]);
  });

  it("is none for an issue filed from no Spec, on another Floor, or not filed", async () => {
    const store = memoryGrillingStore();
    await store.create(approvedSpecSession());
    expect(await issueSpec(store, "web-shop", 4)).toBeUndefined();
    expect(await issueSpec(store, "blog", 12)).toBeUndefined();
    // Another session's filed issues are not a Spec's.
    await store.create({
      ...approvedSpecSession({ issues: [20, 21] }),
      skill: "grilling",
      spec: null,
    });
    expect(await issueSpec(store, "web-shop", 20)).toBeUndefined();
    const unfiled = memoryGrillingStore();
    await unfiled.create(
      approvedSpecSession({
        drafts: [specDraft(1, [r11], null), specDraft(2, [r21], null)],
      }),
    );
    expect(await issueSpec(unfiled, "web-shop", 12)).toBeUndefined();
  });

  it("words each criterion as approved, whatever the draft says, and keeps one the Owner wrote with no approved id", async () => {
    const store = memoryGrillingStore();
    await store.create(
      approvedSpecSession({
        drafts: [
          specDraft(
            1,
            [
              "R1.1 WHEN a shopper ticks Save card THE SYSTEM SHALL email them.",
              "The tick box is ticked by default.",
            ],
            12,
          ),
          // A draft the Owner added: it is no task of tasks.md.
          specDraft(3, ["R2.1 changed"], 14),
        ],
      }),
    );
    expect((await issueSpec(store, "web-shop", 12))?.criteria).toEqual([
      r11,
      "The tick box is ticked by default.",
    ]);
    const added = await issueSpec(store, "web-shop", 14);
    expect(added?.task).toBeUndefined();
    expect(added?.criteria).toEqual([r21]);
  });

  it("has no design.md when the Owner skipped the design", async () => {
    const store = memoryGrillingStore();
    await store.create(approvedSpecSession({ designSkipped: true }));
    const spec = await issueSpec(store, "web-shop", 12);
    expect(spec).toBeDefined();
    expect(spec).not.toHaveProperty("design");
  });

  it("is the approved copy even when the session's drafts changed after it", async () => {
    const store = memoryGrillingStore();
    const session = approvedSpecSession();
    const { spec } = session;
    if (spec === null) {
      throw new Error("A /spec session has a Spec.");
    }
    await store.create({
      ...session,
      spec: {
        ...spec,
        drafts: {
          ...spec.drafts,
          design: { ...approvedDesign, architecture: "Keep the card number." },
        },
      },
    });
    const design = (await issueSpec(store, "web-shop", 12))?.design;
    expect(design).toContain(approvedDesign.architecture);
    expect(design).not.toContain("Keep the card number.");
  });
});

describe("the Spec within a prompt's budget", () => {
  const spec: IssueSpec = {
    sessionId: 7,
    folder: ".agents/specs/saved-cards",
    task: 1,
    criteria: [r11, r12],
    design: "# Design\n\nA vault.\n",
  };

  it("is all of it without a budget, or when it fits", () => {
    for (const budget of [undefined, 12_000]) {
      expect(specWithin(spec, budget, true)).toMatchObject({
        criteria: [r11, r12],
        criteriaLeftOut: [],
        design: spec.design,
        designCut: false,
      });
    }
  });

  it("keeps the criteria first, and cuts the design at what is left", () => {
    const budget = r11.length + r12.length + 8;
    const within = specWithin(spec, budget, true);
    expect(within.criteria).toEqual([r11, r12]);
    expect(within.design).toBe("# Design");
    expect(within.designCut).toBe(true);
  });

  it("leaves out the design, then the last criteria, naming them by id, when the criteria fill it", () => {
    const within = specWithin(spec, r11.length + 1, true);
    expect(within).toMatchObject({
      criteria: [r11],
      criteriaLeftOut: ["R1.2"],
      designCut: true,
    });
    expect(within).not.toHaveProperty("design");
  });

  it("has no design for a reviewer", () => {
    const within = specWithin(spec, undefined, false);
    expect(within).not.toHaveProperty("design");
    expect(within.designCut).toBe(false);
  });
});
