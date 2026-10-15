import type { OfficeEvent } from "@ai-office/events/schema";
import { describe, expect, it } from "vitest";

import { noticeAlert, type NoticeAlertSettings } from "./notice-alerts.ts";

// Which events notify (PRD FR-51): only newly raised action Notices, only
// when the Owner turned notifications on and the browser allows them, and
// with a sound unless the Owner muted it.

const raised = (kind: "action" | "info", floorId?: string): OfficeEvent => ({
  type: "notice.raised",
  version: 1,
  noticeId: "notice-1",
  kind,
  title: "PR #14 awaiting your approval",
  ...(floorId === undefined ? {} : { floorId }),
});

const on: NoticeAlertSettings = { notify: true, sound: true };

describe("noticeAlert", () => {
  it("notifies of an action Notice, with a sound", () => {
    expect(noticeAlert(raised("action", "web-shop"), on, "granted")).toEqual({
      notify: true,
      sound: true,
      noticeId: "notice-1",
      title: "PR #14 awaiting your approval",
      body: "Needs your action on web-shop.",
    });
    expect(noticeAlert(raised("action"), on, "granted")).toMatchObject({
      notify: true,
      body: "Needs your action.",
    });
  });

  it("never notifies of an info Notice", () => {
    expect(noticeAlert(raised("info", "web-shop"), on, "granted")).toEqual({
      notify: false,
    });
  });

  it("notifies without a sound when the sound is muted", () => {
    expect(
      noticeAlert(raised("action"), { notify: true, sound: false }, "granted"),
    ).toMatchObject({ notify: true, sound: false });
  });

  it("does nothing while notifications are off, or the browser refuses them", () => {
    expect(
      noticeAlert(raised("action"), { notify: false, sound: true }, "granted"),
    ).toEqual({ notify: false });
    for (const access of ["default", "denied", "unsupported"] as const) {
      expect(noticeAlert(raised("action"), on, access)).toEqual({
        notify: false,
      });
    }
  });

  it("ignores every other event, a Notice's dismissal and action included", () => {
    const others: OfficeEvent[] = [
      { type: "notice.dismissed", version: 1, noticeId: "notice-1" },
      {
        type: "notice.acted_on",
        version: 1,
        noticeId: "notice-1",
        action: "approve_and_merge",
      },
      {
        type: "cap.reached",
        version: 1,
        level: "office",
        period: "daily",
        used: 10,
        cap: 10,
      },
    ];
    for (const event of others) {
      expect(noticeAlert(event, on, "granted")).toEqual({ notify: false });
    }
  });
});
