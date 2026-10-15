import {
  createEventBus,
  memoryEventStore,
  type EventBus,
  type EventOfType,
} from "@ai-office/events";
import { noticeErrorCodes } from "@ai-office/shared";
import { describe, expect, it, vi } from "vitest";

import { createNotices, type Notices } from "../notices/notices.ts";
import { memoryNoticeStore } from "../notices/store.ts";
import {
  createNoAccountLeftNotices,
  openAiAccountsAction,
} from "./no-account-left.ts";

// "No AI Account left" (PRD FR-39, FR-49): an action Notice raised when an
// AI Provider's last AI Account is held back, closed once one serves again.

const limit = (
  fields: Partial<EventOfType<"ai_account.limit_changed">> = {},
): EventOfType<"ai_account.limit_changed"> => ({
  type: "ai_account.limit_changed",
  version: 1,
  aiAccountId: "00000000-0000-4000-8000-000000000002",
  name: "Team",
  aiProvider: "Claude",
  reason: "rate_limited",
  until: "2026-10-09T13:00:00.000Z",
  providerAvailable: false,
  ...fields,
});

function setUp(): {
  bus: EventBus;
  notices: Notices;
  available: Set<string>;
} {
  const bus = createEventBus({ store: memoryEventStore() });
  const notices = createNotices({ store: memoryNoticeStore(), events: bus });
  const available = new Set<string>();
  createNoAccountLeftNotices({
    notices,
    events: bus,
    providerAvailable: (aiProvider) =>
      Promise.resolve(available.has(aiProvider)),
  });
  return { bus, notices, available };
}

/** Lets the subscriber run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("no-account-left Notices", () => {
  it("tells the Owner once when an AI Provider has no account left, and closes when one serves again", async () => {
    const { bus, notices, available } = setUp();
    await bus.publish(limit());
    await bus.publish(
      limit({ name: "Work", reason: "overloaded", aiAccountId: "work" }),
    );

    await vi.waitFor(async () => {
      expect(await notices.open()).toHaveLength(1);
    });
    await settle();
    const [notice] = await notices.open();
    expect(await notices.open()).toHaveLength(1);
    expect(notice).toMatchObject({
      kind: "action",
      title: "No Claude AI Account left: Team was the last",
      floorId: null,
      actions: [
        {
          id: openAiAccountsAction,
          label: "Open AI Accounts",
          href: "/ai-settings?aiProvider=Claude",
        },
      ],
    });

    // Taking the action while nothing serves leaves the Notice.
    await expect(
      notices.act(notice?.id ?? "", openAiAccountsAction),
    ).rejects.toMatchObject({ code: noticeErrorCodes.actionFailed });
    expect(await notices.open()).toHaveLength(1);

    // A limit reset: the Notice is closed as acted on.
    available.add("Claude");
    await bus.publish(
      limit({ reason: null, until: null, providerAvailable: true }),
    );
    await vi.waitFor(async () => {
      expect(await notices.open()).toEqual([]);
    });
    expect(await notices.get(notice?.id ?? "")).toMatchObject({
      actedOn: openAiAccountsAction,
    });
  });

  it("raises nothing while another account of the AI Provider serves", async () => {
    const { bus, notices } = setUp();
    await bus.publish(limit({ providerAvailable: true }));
    await settle();
    expect(await notices.open()).toEqual([]);
  });

  it("keeps one Notice per AI Provider", async () => {
    const { bus, notices, available } = setUp();
    await bus.publish(limit());
    await bus.publish(limit({ aiProvider: "Grok", name: "xAI" }));
    await vi.waitFor(async () => {
      expect(await notices.open()).toHaveLength(2);
    });
    available.add("Grok");
    await bus.publish(
      limit({
        aiProvider: "Grok",
        name: "xAI",
        reason: null,
        until: null,
        providerAvailable: true,
      }),
    );
    await vi.waitFor(async () => {
      expect((await notices.open()).map(({ title }) => title)).toEqual([
        "No Claude AI Account left: Team was the last",
      ]);
    });
  });

  it("lets the Owner take the action once they have added or resumed an account", async () => {
    const { bus, notices, available } = setUp();
    await bus.publish(limit());
    await vi.waitFor(async () => {
      expect(await notices.open()).toHaveLength(1);
    });
    available.add("Claude");
    const [notice] = await notices.open();
    await expect(
      notices.act(notice?.id ?? "", openAiAccountsAction),
    ).resolves.toMatchObject({ actedOn: openAiAccountsAction });
  });
});
