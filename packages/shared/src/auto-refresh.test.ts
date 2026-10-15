import { describe, expect, it } from "vitest";

import {
  autoRefreshBufferMs,
  autoRefreshSettingsSchema,
  defaultAutoRefreshSettings,
} from "./auto-refresh.ts";

// Auto-refresh's settings (PRD FR-39).

describe("auto-refresh's settings", () => {
  it("are off by default, and only say whether it is on", () => {
    expect(defaultAutoRefreshSettings).toEqual({ enabled: false });
    expect(autoRefreshSettingsSchema.safeParse({ enabled: true }).success).toBe(
      true,
    );
    for (const settings of [
      {},
      { enabled: "yes" },
      { enabled: true, bufferSeconds: 60 },
    ]) {
      expect(autoRefreshSettingsSchema.safeParse(settings).success).toBe(false);
    }
  });

  it("wait a minute after a window's reset", () => {
    expect(autoRefreshBufferMs).toBe(60_000);
  });
});
