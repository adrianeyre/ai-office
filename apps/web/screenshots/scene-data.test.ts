import {
  floorContextUsageSchema,
  floorTokenUsageSchema,
  noticeSchema,
} from "@ai-office/shared";
import { avatarSchema, lookDistinct } from "@ai-office/shared/avatar";
import { describe, expect, it } from "vitest";

import { dailyCapState } from "../src/scene/above-head.ts";
import { meetingRoom } from "../src/scene/floor-layout.ts";
import {
  aboveHead,
  contextUsage,
  editorAvatar,
  lobbyCast,
  looks,
  meetingRoomView,
  monitors,
  notices,
  reception,
  stops,
  team,
  tokenUsage,
} from "./scene-data.ts";

// The screenshot tests' scenes (e2e/scenes/) are only as good as their
// data: it has to be what AI Office itself would draw from, and show what
// each picture claims to.

describe("the screenshot scenes' data", () => {
  it("seats the Communications Agent at reception, sending, with a failing Connection (FR-96)", () => {
    expect(avatarSchema.parse(lobbyCast.receptionist.avatar)).toEqual(
      lobbyCast.receptionist.avatar,
    );
    expect(
      lookDistinct(lobbyCast.receptionist.avatar, lobbyCast.visitor.avatar),
    ).toBe(true);
    expect(reception.sent).toBeGreaterThan(0);
    expect(reception.failing).not.toEqual([]);
  });

  it("gives every Agent a valid Avatar, unlike every other's on the Floor", () => {
    const avatars = team.map(({ avatar }) => avatarSchema.parse(avatar));
    avatars.forEach((avatar, index) => {
      for (const other of avatars.slice(index + 1)) {
        expect(lookDistinct(avatar, other)).toBe(true);
      }
    });
    expect(avatarSchema.parse(editorAvatar)).toEqual(editorAvatar);
  });

  it("shows every state the Office draws at a desk (FR-62)", () => {
    const all = [...looks.values()];
    expect(all.map(({ animation }) => animation)).toEqual(
      expect.arrayContaining(["type", "wait", "sit"]),
    );
    expect(all.map(({ marker }) => marker)).toEqual(
      expect.arrayContaining(["paused", "capped", undefined]),
    );
    expect(all.some(({ tickets }) => tickets > 1)).toBe(true);
    // A typing Agent's monitor is lit and written on; the rest are dark.
    for (const { id } of team) {
      const typing = looks.get(id)?.animation === "type";
      expect(monitors.get(id)?.working).toBe(typing);
      expect((monitors.get(id)?.lines.length ?? 0) > 0).toBe(typing);
    }
  });

  it("floats a bar and tokens over a busy Agent and tokens alone over an idle one, from what the API sends (FR-62, FR-85)", () => {
    expect(floorContextUsageSchema.parse(contextUsage)).toEqual(contextUsage);
    expect(floorTokenUsageSchema.parse(tokenUsage)).toEqual(tokenUsage);
    expect([...aboveHead.keys()]).toEqual(team.map(({ id }) => id));
    // A bar only over an Agent at work, and never over a reviewer.
    for (const { id, role } of team) {
      const bar = aboveHead.get(id)?.contextUsage !== undefined;
      expect(aboveHead.get(id)?.tokens).toBeDefined();
      if (bar) {
        expect(looks.get(id)?.animation).toBe("type");
        expect(role).not.toBe("reviewer");
      }
    }
    expect(aboveHead.get("ada")?.contextUsage).toBe(0.62);
    expect(looks.get("dieter")?.animation).toBe("sit");
    expect(aboveHead.get("dieter")?.contextUsage).toBeUndefined();
    // Tokens in every colour: below 80% of the daily cap, from 80%, at it.
    expect(
      new Set(
        [...aboveHead.values()].map(({ tokens }) =>
          dailyCapState(tokens?.today ?? 0, tokens?.dailyCap ?? null),
        ),
      ),
    ).toEqual(new Set(["neutral", "warning", "reached"]));
  });

  it("has Notices as the API lists them, counted on the lift's stops", () => {
    for (const notice of notices) {
      expect(noticeSchema.parse(notice)).toEqual(notice);
    }
    for (const { location, actionNotices } of stops) {
      const floorId = location.kind === "floor" ? location.floorId : null;
      expect(actionNotices).toBe(
        notices.filter(
          (notice) => notice.kind === "action" && notice.floorId === floorId,
        ).length,
      );
    }
  });

  it("looks into the meeting room from outside it", () => {
    const [x, , z] = meetingRoomView.target;
    expect(x).toBeGreaterThan(meetingRoom.x[0]);
    expect(x).toBeLessThan(meetingRoom.x[1]);
    expect(z).toBeGreaterThan(meetingRoom.z[0]);
    expect(z).toBeLessThan(meetingRoom.z[1]);
    expect(meetingRoomView.position[2]).toBeGreaterThan(meetingRoom.z[1]);
  });
});
