import { describe, expect, it } from "vitest";

import {
  eventStreamQuerySchema,
  eventStreamUrl,
  lastEventIdSchema,
} from "./stream.ts";

describe("eventStreamUrl", () => {
  it("is the bare path without a filter", () => {
    expect(eventStreamUrl()).toBe("/api/events/stream");
    expect(eventStreamUrl({ types: [] })).toBe("/api/events/stream");
  });

  it("carries the filter and where to resume, and parses back to them", () => {
    const url = eventStreamUrl(
      {
        floorId: "web-shop",
        agentId: "ada",
        issue: 4,
        types: ["handoff", "cap.warning"],
      },
      12,
    );
    expect(url).toBe(
      "/api/events/stream?floorId=web-shop&agentId=ada&issue=4&type=handoff%2Ccap.warning&lastEventId=12",
    );
    const query = Object.fromEntries(new URL(url, "http://x").searchParams);
    expect(eventStreamQuerySchema.parse(query)).toEqual({
      floorId: "web-shop",
      agentId: "ada",
      issue: 4,
      type: ["handoff", "cap.warning"],
      lastEventId: 12,
    });
  });
});

describe("the stream's query", () => {
  it("refuses unknown types and fields", () => {
    expect(eventStreamQuerySchema.safeParse({ type: "x.y" }).success).toBe(
      false,
    );
    expect(eventStreamQuerySchema.safeParse({ colour: "red" }).success).toBe(
      false,
    );
  });

  it("takes a Last-Event-ID of digits only", () => {
    expect(lastEventIdSchema.parse("42")).toBe(42);
    expect(lastEventIdSchema.safeParse("4 2").success).toBe(false);
    expect(lastEventIdSchema.safeParse("-1").success).toBe(false);
  });
});
