import { describe, expect, it } from "vitest";

import { healthResponseSchema } from "./index.ts";

describe("healthResponseSchema", () => {
  it("accepts the healthy and unhealthy bodies", () => {
    expect(
      healthResponseSchema.parse({ status: "ok", database: "up" }),
    ).toEqual({ status: "ok", database: "up" });
    expect(
      healthResponseSchema.safeParse({
        status: "unavailable",
        database: "down",
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(
      healthResponseSchema.safeParse({ status: "fine", database: "up" })
        .success,
    ).toBe(false);
  });
});
