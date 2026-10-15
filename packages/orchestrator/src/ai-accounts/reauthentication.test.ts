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
  createReauthenticationNotices,
  reauthenticateAction,
} from "./reauthentication.ts";

// "AI Account needs re-authentication" (PRD FR-36, FR-49): an action Notice
// raised when an OAuth account's refresh is refused, with an action that
// opens its sign-in, closed once it has signed in again.

const accountId = "00000000-0000-4000-8000-000000000001";

const health = (
  fields: Partial<EventOfType<"ai_account.token_health">> = {},
): EventOfType<"ai_account.token_health"> => ({
  type: "ai_account.token_health",
  version: 1,
  aiAccountId: accountId,
  name: "Claude Max",
  health: "expiring",
  expiresAt: "2026-10-09T20:00:00.000Z",
  reauthenticationNeeded: true,
  ...fields,
});

function setUp(): {
  bus: EventBus;
  notices: Notices;
  needing: Set<string>;
} {
  const bus = createEventBus({ store: memoryEventStore() });
  const notices = createNotices({ store: memoryNoticeStore(), events: bus });
  const needing = new Set<string>();
  createReauthenticationNotices({
    notices,
    events: bus,
    needsReauthentication: (id) => Promise.resolve(needing.has(id)),
  });
  return { bus, notices, needing };
}

describe("re-authentication Notices", () => {
  it("asks the Owner to re-authenticate once, and closes when the account has signed in again", async () => {
    const { bus, notices, needing } = setUp();
    needing.add(accountId);
    await bus.publish(health());
    await bus.publish(health({ health: "expired" }));

    await vi.waitFor(async () => {
      expect(await notices.open()).toHaveLength(1);
    });
    const [notice] = await notices.open();
    expect(notice).toMatchObject({
      kind: "action",
      title: "Re-authentication needed: Claude Max",
      floorId: null,
      actions: [
        {
          id: reauthenticateAction,
          label: "Re-authenticate",
          href: `/ai-settings?reauthenticate=${accountId}`,
        },
      ],
    });

    // Taking the action before signing in again leaves the Notice.
    await expect(
      notices.act(notice?.id ?? "", reauthenticateAction),
    ).rejects.toMatchObject({ code: noticeErrorCodes.actionFailed });
    expect(await notices.open()).toHaveLength(1);

    // Signed in again: the Notice is closed as acted on.
    needing.delete(accountId);
    await bus.publish(
      health({ health: "valid", reauthenticationNeeded: false }),
    );
    await vi.waitFor(async () => {
      expect(await notices.open()).toEqual([]);
    });
    expect(await notices.get(notice?.id ?? "")).toMatchObject({
      actedOn: reauthenticateAction,
    });
  });

  it("raises nothing for a token that is only expiring or expired", async () => {
    const { bus, notices } = setUp();
    await bus.publish(health({ reauthenticationNeeded: false }));
    await bus.publish(
      health({ health: "expired", reauthenticationNeeded: false }),
    );
    await bus.publish(
      health({ health: "valid", reauthenticationNeeded: false }),
    );
    // Let the subscriber run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await notices.open()).toEqual([]);
  });

  it("lets the Owner close it by hand once the account is gone", async () => {
    const { bus, notices, needing } = setUp();
    needing.add(accountId);
    await bus.publish(health());
    await vi.waitFor(async () => {
      expect(await notices.open()).toHaveLength(1);
    });
    needing.delete(accountId);
    const [notice] = await notices.open();
    await expect(
      notices.act(notice?.id ?? "", reauthenticateAction),
    ).resolves.toMatchObject({ actedOn: reauthenticateAction });
  });
});
