import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readFixture } from "../fixtures.ts";
import { usageWindowsOf, usageWindowsOfBody } from "./usage-windows.ts";

// Usage windows (PRD FR-36), read from the headers an AI Provider sends.

const recorded = await readFixture(
  fileURLToPath(
    new URL(
      "../../fixtures/limits/anthropic-subscription-usage.json",
      import.meta.url,
    ),
  ),
);

describe("usage windows", () => {
  it("are computed from a subscription's recorded headers", () => {
    expect(usageWindowsOf(new Headers(recorded.response.headers))).toEqual({
      five_hour: {
        utilization: 82,
        resetsAt: new Date("2026-10-09T14:00:00.000Z"),
      },
      weekly: {
        utilization: 36.4,
        resetsAt: new Date("2026-10-12T09:00:00.000Z"),
      },
    });
  });

  it("are none for an answer that reports none", () => {
    expect(
      usageWindowsOf(
        new Headers({
          "content-type": "application/json",
          "anthropic-ratelimit-input-tokens-remaining": "100",
        }),
      ),
    ).toEqual({});
  });

  it("leave out a window reported in part, or unreadably", () => {
    expect(
      usageWindowsOf(
        new Headers({
          "anthropic-ratelimit-unified-5h-utilization": "0.5",
          "anthropic-ratelimit-unified-7d-utilization": "lots",
          "anthropic-ratelimit-unified-7d-reset": "1791795600",
        }),
      ),
    ).toEqual({});
  });

  it("goes past 100% when the AI Provider lets it", () => {
    expect(
      usageWindowsOf(
        new Headers({
          "anthropic-ratelimit-unified-5h-utilization": "1.05",
          "anthropic-ratelimit-unified-5h-reset": "1791554400",
        }),
      ).five_hour?.utilization,
    ).toBe(105);
  });
});

const codexRecorded = await readFixture(
  fileURLToPath(
    new URL("../../fixtures/chatgpt/responses-streaming.json", import.meta.url),
  ),
);

describe("a ChatGPT subscription's usage windows", () => {
  const now = new Date("2026-10-11T12:00:20.000Z");

  it("are read from Codex's recorded headers, placed by their length", () => {
    expect(
      usageWindowsOf(new Headers(codexRecorded.response.headers), now),
    ).toEqual({
      // 12,400 seconds on, to the minute.
      five_hour: {
        utilization: 23,
        resetsAt: new Date("2026-10-11T15:27:00.000Z"),
      },
      // 302,000 seconds on, to the minute.
      weekly: {
        utilization: 41,
        resetsAt: new Date("2026-10-14T23:54:00.000Z"),
      },
    });
  });

  it("take a reset time over one counted from now", () => {
    expect(
      usageWindowsOf(
        new Headers({
          "x-codex-primary-used-percent": "7.25",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-at": "1791795600",
          "x-codex-primary-reset-after-seconds": "60",
        }),
        now,
      ),
    ).toEqual({
      five_hour: {
        utilization: 7.3,
        resetsAt: new Date(1_791_795_600_000),
      },
    });
  });

  it("put a weekly primary window where it belongs", () => {
    expect(
      usageWindowsOf(
        new Headers({
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-window-minutes": "10080",
          "x-codex-primary-reset-at": "1791795600",
        }),
        now,
      ),
    ).toEqual({
      weekly: { utilization: 100, resetsAt: new Date(1_791_795_600_000) },
    });
  });

  it("are the primary and secondary windows when their length is not said", () => {
    expect(
      Object.keys(
        usageWindowsOf(
          new Headers({
            "x-codex-primary-used-percent": "1",
            "x-codex-primary-reset-after-seconds": "60",
            "x-codex-secondary-used-percent": "2",
            "x-codex-secondary-reset-after-seconds": "60",
          }),
          now,
        ),
      ),
    ).toEqual(["five_hour", "weekly"]);
  });

  it("leave out a window of another length, or reported in part", () => {
    expect(
      usageWindowsOf(
        new Headers({
          "x-codex-primary-used-percent": "10",
          "x-codex-primary-window-minutes": "1440",
          "x-codex-primary-reset-after-seconds": "60",
          "x-codex-secondary-used-percent": "lots",
          "x-codex-secondary-window-minutes": "10080",
          "x-codex-secondary-reset-after-seconds": "60",
        }),
        now,
      ),
    ).toEqual({});
  });

  it("stay the same while the clock moves within a minute", () => {
    const headers = new Headers({
      "x-codex-primary-used-percent": "5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-after-seconds": "3600",
    });
    const later = new Headers({
      "x-codex-primary-used-percent": "5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-after-seconds": "3590",
    });
    expect(usageWindowsOf(later, new Date(now.getTime() + 10_000))).toEqual(
      usageWindowsOf(headers, now),
    );
  });
});

describe("usage windows from a subscription's usage endpoint", () => {
  it("are read from its five-hour and seven-day windows, in percent", () => {
    expect(
      usageWindowsOfBody({
        five_hour: { utilization: 12.34, resets_at: "2026-10-09T14:00:00Z" },
        seven_day: {
          utilization: 40,
          resets_at: "2026-10-12T09:00:00.000+00:00",
        },
        seven_day_opus: null,
      }),
    ).toEqual({
      five_hour: {
        utilization: 12.3,
        resetsAt: new Date("2026-10-09T14:00:00.000Z"),
      },
      weekly: {
        utilization: 40,
        resetsAt: new Date("2026-10-12T09:00:00.000Z"),
      },
    });
  });

  it("are read from its limits when the flat windows are missing", () => {
    expect(
      usageWindowsOfBody({
        limits: [
          {
            kind: "weekly_scoped",
            percent: 90,
            resets_at: "2026-10-11T00:00:00Z",
          },
          { kind: "session", percent: 5, resets_at: "2026-10-09T14:00:00Z" },
          {
            kind: "weekly_all",
            percent: 60,
            resets_at: "2026-10-12T09:00:00Z",
          },
        ],
      }),
    ).toEqual({
      five_hour: {
        utilization: 5,
        resetsAt: new Date("2026-10-09T14:00:00.000Z"),
      },
      weekly: {
        utilization: 60,
        resetsAt: new Date("2026-10-12T09:00:00.000Z"),
      },
    });
  });

  it("are read from a ChatGPT subscription's rate limit, placed by length", () => {
    const at = new Date("2026-10-09T12:00:00.000Z");
    expect(
      usageWindowsOfBody(
        {
          plan_type: "plus",
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 23,
              limit_window_seconds: 18_000,
              reset_after_seconds: 3_600,
              reset_at: 1_791_550_800,
            },
            secondary_window: {
              used_percent: 41.26,
              limit_window_seconds: 604_800,
              reset_after_seconds: 7_230,
            },
          },
        },
        at,
      ),
    ).toEqual({
      five_hour: {
        utilization: 23,
        resetsAt: new Date(1_791_550_800 * 1000),
      },
      // Counted from now, to the minute.
      weekly: {
        utilization: 41.3,
        resetsAt: new Date("2026-10-09T14:01:00.000Z"),
      },
    });
    // A Pro plan's weekly primary, and a window of neither length.
    expect(
      usageWindowsOfBody(
        {
          rate_limit: {
            primary_window: {
              used_percent: 5,
              limit_window_seconds: 604_800,
              reset_after_seconds: 60,
            },
            secondary_window: {
              used_percent: 9,
              limit_window_seconds: 3_600,
              reset_after_seconds: 60,
            },
          },
        },
        at,
      ),
    ).toEqual({
      weekly: {
        utilization: 5,
        resetsAt: new Date("2026-10-09T12:01:00.000Z"),
      },
    });
    expect(usageWindowsOfBody({ rate_limit: null }, at)).toEqual({});
    expect(
      usageWindowsOfBody(
        { rate_limit: { primary_window: { used_percent: "5" } } },
        at,
      ),
    ).toEqual({});
  });

  it("read a window with no reset time as one not running", () => {
    // What Claude's usage endpoint answers before a request starts the
    // five-hour window.
    const notRunning = {
      five_hour: { utilization: 0, resetsAt: null },
      weekly: {
        utilization: 3,
        resetsAt: new Date("2026-10-22T16:00:00.000Z"),
      },
    };
    expect(
      usageWindowsOfBody({
        five_hour: { utilization: 0.0, resets_at: null },
        seven_day: { utilization: 3, resets_at: "2026-10-22T16:00:00Z" },
      }),
    ).toEqual(notRunning);
    expect(
      usageWindowsOfBody({
        limits: [
          { kind: "session", percent: 0, resets_at: null },
          { kind: "weekly_all", percent: 3, resets_at: "2026-10-22T16:00:00Z" },
        ],
      }),
    ).toEqual(notRunning);
  });

  it("leave out anything malformed", () => {
    expect(
      usageWindowsOfBody({
        five_hour: { utilization: 0 },
        seven_day: { utilization: "40", resets_at: "2026-10-12T09:00:00Z" },
      }),
    ).toEqual({});
    expect(usageWindowsOfBody("nope")).toEqual({});
    expect(usageWindowsOfBody(null)).toEqual({});
  });
});
