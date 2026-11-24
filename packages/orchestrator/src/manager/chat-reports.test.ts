import { createEventBus, memoryEventStore } from "@ai-office/events";
import type { WrapUp } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import type { BatchRecord } from "../batches/store.ts";
import { createChatReports } from "./chat-reports.ts";
import type { ChatMessageRecord } from "./store.ts";

// The Manager's Wrap-up post in its chat (PRD FR-24): with the results,
// where a chat request's Batch's merged work departs from the design of
// the Spec its issues were filed from, and how to bring the Spec up to
// date (Guidelines, Specs and Hooks PRD, FR-117).

const wrapUp: WrapUp = {
  planVersion: 1,
  issues: [
    {
      issue: 12,
      title: "Save a card at checkout",
      outcome: "merged",
      pullRequest: {
        number: 31,
        url: "https://github.com/adrianeyre/web-shop/pull/31",
      },
      agentId: "ada",
      rounds: { review: 1, qa: 1 },
      tokens: 12_000,
      estimatedCostUsd: 0.12,
    },
  ],
  leftOut: [],
  totals: {
    merged: 1,
    closed: 0,
    blocked: 0,
    notStarted: 0,
    tokens: 12_000,
    estimatedCostUsd: 0.12,
  },
  designChecks: [
    {
      folder: ".agents/specs/checkout-with-saved-cards",
      sessionId: 1,
      pullRequests: [31],
      departures: [
        "Data: the design keeps cards in a saved_cards table; src/db/schema.ts keeps them as a JSON column on users.",
      ],
      problem: null,
    },
  ],
};

const batch: BatchRecord = {
  id: 4,
  floorId: "web-shop",
  issues: [12],
  status: "finished",
  agentId: "grace",
  createdAt: new Date("2026-11-24T10:00:00.000Z"),
  chatMessageId: 9,
  onePullRequest: false,
  startedAt: new Date("2026-11-24T10:00:00.000Z"),
  finishedAt: new Date("2026-11-24T12:00:00.000Z"),
  wrapUp,
};

describe("the Manager's Wrap-up post in its chat", () => {
  it("says where the merged work departs from its Spec's design, and how to amend the Spec", async () => {
    const posted: { floorId: string; text: string; replyTo: number }[] = [];
    const reports = createChatReports({
      events: createEventBus({ store: memoryEventStore() }),
      batches: {
        get: (id) => Promise.resolve(id === batch.id ? batch : undefined),
        list: () => Promise.resolve([batch]),
        latestPlan: () => Promise.resolve(undefined),
      },
      chat: {
        postProgress: (floorId, text, replyTo) => {
          posted.push({ floorId, text, replyTo });
          const kept: ChatMessageRecord = {
            id: 10,
            floorId,
            kind: "reply",
            text,
            command: null,
            replyTo,
            agentId: "grace",
            model: null,
            skill: null,
            grilling: null,
            compaction: null,
            tools: [],
            attachments: [],
            createdAt: new Date("2026-11-24T12:00:00.000Z"),
          };
          return Promise.resolve(kept);
        },
      },
    });
    await reports.handle({
      type: "batch.finished",
      version: 1,
      floorId: "web-shop",
      batchId: 4,
      agentId: "grace",
      agentIds: ["ada"],
      issues: [12],
      merged: 1,
      closed: 0,
      blocked: 0,
      notStarted: 0,
      tokens: 12_000,
    });
    expect(posted).toEqual([
      {
        floorId: "web-shop",
        replyTo: 9,
        text: [
          "Batch 4 wrapped up: 1 of 1 issue merged; 12k tokens; departs from the Spec's design in 1 place.",
          "",
          "- #12 Save a card at checkout: merged (pull request #31)",
          "",
          "The merged work (pull request #31) departs from the design of the Spec in `.agents/specs/checkout-with-saved-cards/`:",
          "- Data: the design keeps cards in a saved_cards table; src/db/schema.ts keeps them as a JSON column on users.",
          'To bring the Spec up to date, say "/spec amend checkout-with-saved-cards".',
        ].join("\n"),
      },
    ]);
  });
});
