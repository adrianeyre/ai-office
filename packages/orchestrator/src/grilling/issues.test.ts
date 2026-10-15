import {
  createEventBus,
  memoryEventStore,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import type { GrillingIssues } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  batchCommand,
  createGrillingIssues,
  draftIssues,
  grillingIssuesInstructions,
  issueBody,
  parseGrillingIssues,
} from "./issues.ts";
import type { GrillingSessionRecord } from "./session.ts";

// A Grilling Session's issues (PRD FR-81): the Manager's draft as plain
// code keeps it, the issue bodies, and the filer, against the fake GitHub.

const at = new Date("2026-10-10T12:00:00.000Z");
const repository = "adrianeyre/web-shop";

const session: GrillingSessionRecord = {
  id: 4,
  floorId: "web-shop",
  topic: "Gift cards",
  skill: "grilling",
  status: "ended",
  round: 2,
  awaitingConfirmation: false,
  questions: [],
  decisions: [],
  terms: [],
  facts: [],
  outline: [{ heading: "Requirements", text: "Shoppers buy gift cards." }],
  adrs: [],
  processes: [],
  documents: null,
  issues: null,
  sources: [],
  startedAt: at,
  updatedAt: at,
  pausedAt: null,
  endedAt: at,
};

const draft = (id: number, title: string, blockedBy: number[] = []) => ({
  id,
  title,
  whatToBuild: `Build ${title.toLowerCase()}.`,
  acceptanceCriteria: [`${title} works`],
  blockedBy,
  prdSections: [],
  adrs: [],
  filed: null,
});

describe("drafting the issues", () => {
  it("asks for vertical slices, saying what the session lets them cite", () => {
    const asked = grillingIssuesInstructions(session).join("\n");
    expect(asked).toContain(
      "The Grilling Session has ended. Now draft the GitHub issues",
    );
    expect(asked).toContain("- Each issue is a vertical slice");
    expect(asked).toContain('from: "Requirements".');
    expect(asked).toContain(
      "- `adrs`: the session wrote no ADRs, so leave it empty.",
    );
  });

  it("keeps the draft: earlier blockers only, and only the session's own citations", () => {
    const parsed = parseGrillingIssues(
      JSON.stringify({
        issues: [
          {
            title: "Sell a card",
            whatToBuild: "A shopper buys a gift card.",
            acceptanceCriteria: ["A card can be bought"],
            blockedBy: [1, 2],
            prdSections: ["REQUIREMENTS", "Requirements", "Refunds"],
            adrs: ["Cards never expire"],
          },
          {
            title: "Spend a card",
            whatToBuild: "A shopper pays with a gift card.",
            acceptanceCriteria: ["A card pays for an order"],
            blockedBy: [1, 1, 2],
          },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(draftIssues(parsed.value, session, at)).toEqual({
      drafts: [
        {
          id: 1,
          title: "Sell a card",
          whatToBuild: "A shopper buys a gift card.",
          acceptanceCriteria: ["A card can be bought"],
          blockedBy: [],
          prdSections: ["Requirements"],
          adrs: [],
          filed: null,
        },
        {
          id: 2,
          title: "Spend a card",
          whatToBuild: "A shopper pays with a gift card.",
          acceptanceCriteria: ["A card pays for an order"],
          blockedBy: [1],
          prdSections: [],
          adrs: [],
          filed: null,
        },
      ],
      draftedAt: at.toISOString(),
      approvedAt: null,
      problem: null,
    });
    expect(parseGrillingIssues('{"issues": []}')).toMatchObject({ ok: false });
  });

  it("writes the Batch command for the issues filed", () => {
    expect(batchCommand([7, 5, 6])).toBe("complete issues 5 to 7");
    expect(batchCommand([9, 5, 7])).toBe("complete issues 5, 7 and 9");
    expect(batchCommand([5])).toBe("complete issue 5");
  });
});

describe("filing the issues", () => {
  it("writes each body without documents to cite", () => {
    expect(
      issueBody(
        { ...draft(1, "Sell a card"), prdSections: ["Requirements"] },
        { session, manager: "Noam", blockedBy: [] },
      ),
    ).toBe(
      [
        "## Context",
        "",
        "Drafted by Noam, the Floor's Manager, from the Grilling Session 4 on Gift cards, and approved by the Owner.",
        "",
        "## What to build",
        "",
        "Build sell a card.",
        "",
        "## Acceptance criteria",
        "",
        "- [ ] Sell a card works",
        "",
        "## Blocked by",
        "",
        "None: it can start at once.",
        "",
        "## Cites",
        "",
        "- PRD: § Requirements",
        "",
      ].join("\n"),
    );
  });

  it("files the drafts in dependency order, records each as it goes, and refuses drafts in a cycle", async () => {
    const github = createFakeGitHub();
    github.installRepository(repository);
    const events = createEventBus({ store: memoryEventStore() });
    const published: OfficeEvent[] = [];
    events.subscribe(({ event }) => {
      published.push(event);
    });
    const filer = createGrillingIssues({ github, events, now: () => at });
    const recorded: GrillingIssues[] = [];
    const issues: GrillingIssues = {
      drafts: [draft(1, "Spend a card", [2]), draft(2, "Sell a card")],
      draftedAt: at.toISOString(),
      approvedAt: null,
      problem: null,
    };
    const filed = await filer.file({
      floor: { id: "web-shop", repository },
      manager: { id: "noam", name: "Noam" },
      session: { ...session, issues },
      record: (current) => {
        recorded.push(current);
        return Promise.resolve();
      },
    });
    expect(filed).toMatchObject({
      approvedAt: at.toISOString(),
      problem: null,
      drafts: [
        { id: 1, filed: { number: 2 } },
        { id: 2, filed: { number: 1 } },
      ],
    });
    // Each issue was kept as soon as it was filed, then the whole.
    expect(
      recorded.map(({ drafts }) =>
        drafts.map(({ filed: issue }) => issue?.number),
      ),
    ).toEqual([
      [undefined, 1],
      [2, 1],
      [2, 1],
    ]);
    expect(
      published.flatMap((event) =>
        event.type === "grilling.issue_filed"
          ? [[event.issue, event.blockedBy]]
          : [],
      ),
    ).toEqual([
      [1, []],
      [2, [1]],
    ]);
    // The label exists, as intake makes it.
    expect(github.labels(repository).map(({ name }) => name)).toContain(
      "ai-office",
    );

    await expect(
      filer.file({
        floor: { id: "web-shop", repository },
        manager: { id: "noam", name: "Noam" },
        session: {
          ...session,
          issues: {
            ...issues,
            drafts: [draft(1, "A", [2]), draft(2, "B", [1])],
          },
        },
        record: () => Promise.resolve(),
      }),
    ).rejects.toThrow(
      "The Grilling Session 4 on Gift cards has no issues that can be filed.",
    );
  });
});
