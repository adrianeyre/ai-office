import { describe, expect, it } from "vitest";

import {
  defaultPromptCacheKeepAliveSettings,
  keepAliveLeadMs,
  promptCacheKeepAliveSettingsSchema,
} from "./prompt-cache-keep-alive.ts";

// Prompt-cache keep-alive's settings (PRD FR-39).

describe("prompt-cache keep-alive's settings", () => {
  it("are off by default, with half an hour's idle time and 60 an hour", () => {
    expect(defaultPromptCacheKeepAliveSettings).toEqual({
      enabled: false,
      idleMinutes: 30,
      maxPerAccountPerHour: 60,
    });
    expect(
      promptCacheKeepAliveSettingsSchema.safeParse(
        defaultPromptCacheKeepAliveSettings,
      ).success,
    ).toBe(true);
  });

  it("bound the idle time and each account's keep-alives", () => {
    const parse = (change: Record<string, unknown>) =>
      promptCacheKeepAliveSettingsSchema.safeParse({
        ...defaultPromptCacheKeepAliveSettings,
        ...change,
      });
    for (const accepted of [
      { idleMinutes: 5 },
      { idleMinutes: 480 },
      { maxPerAccountPerHour: 1 },
      { maxPerAccountPerHour: 600 },
    ]) {
      expect(parse(accepted).success).toBe(true);
    }
    for (const [change, message] of [
      [{ idleMinutes: 4 }, "Keep sessions warm for at least 5 minutes."],
      [
        { idleMinutes: 481 },
        "Keep sessions warm for at most 480 minutes (8 hours).",
      ],
      [{ idleMinutes: 7.5 }, "The idle time is a whole number."],
      [
        { maxPerAccountPerHour: 0 },
        "Allow each AI Account at least 1 keep-alive an hour.",
      ],
      [
        { maxPerAccountPerHour: 601 },
        "Allow each AI Account at most 600 keep-alives an hour.",
      ],
      [{ enabled: "yes" }, "Say whether keep-alive is on."],
    ] as const) {
      const parsed = parse(change);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe(message);
    }
    expect(parse({ ttl: "5m" }).success).toBe(false);
  });

  it("are sent a minute before a cache would expire", () => {
    expect(keepAliveLeadMs).toBe(60_000);
  });
});
