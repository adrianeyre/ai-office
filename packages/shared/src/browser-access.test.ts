import { describe, expect, it } from "vitest";

import {
  browserAccessAllows,
  browserOriginSchema,
  keyBrowserAccessSchema,
  maxBrowserOrigins,
  noBrowserAccess,
} from "./browser-access.ts";
import {
  gatewayKeySchema,
  gatewayKeyUpdateRequestSchema,
} from "./gateway-keys.ts";

const origin = (value: unknown) => browserOriginSchema.safeParse(value);

const origins = (list: unknown) =>
  keyBrowserAccessSchema.safeParse({ mode: "origins", origins: list });

describe("a key's Browser access", () => {
  it("is off until the Owner sets it, for keys listed before it too", () => {
    expect(noBrowserAccess).toEqual({ mode: "off" });
    const listed = gatewayKeySchema.parse({
      id: "k1",
      kind: "owner_tool",
      name: "CV checker",
      agentId: null,
      floorId: null,
      hint: "aio_gk_AbCd",
      createdAt: "2026-11-21T10:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(listed.browserAccess).toEqual({ mode: "off" });
  });

  it("is off, origins or any", () => {
    expect(keyBrowserAccessSchema.parse({ mode: "off" })).toEqual({
      mode: "off",
    });
    expect(keyBrowserAccessSchema.parse({ mode: "any" })).toEqual({
      mode: "any",
    });
    expect(origins(["http://localhost:4870"]).data).toEqual({
      mode: "origins",
      origins: ["http://localhost:4870"],
    });
    for (const value of [
      { mode: "all" },
      { mode: "any", origins: ["https://x.example"] },
      { mode: "off", origins: [] },
      { mode: "origins" },
      "any",
      null,
    ]) {
      expect(keyBrowserAccessSchema.safeParse(value).success).toBe(false);
    }
  });

  it("allows a page on an origin listed, or on any for any, and none while off", () => {
    const listed = { mode: "origins", origins: ["https://cv.example.com"] };
    expect(
      browserAccessAllows(
        listed as { mode: "origins"; origins: string[] },
        "https://cv.example.com",
      ),
    ).toBe(true);
    expect(
      browserAccessAllows(
        listed as { mode: "origins"; origins: string[] },
        "https://attacker.example",
      ),
    ).toBe(false);
    expect(browserAccessAllows({ mode: "any" }, "https://x.example")).toBe(
      true,
    );
    expect(browserAccessAllows({ mode: "off" }, "https://x.example")).toBe(
      false,
    );
    expect(browserAccessAllows(undefined, "https://x.example")).toBe(false);
  });

  it("is set with a key's other settings", () => {
    expect(
      gatewayKeyUpdateRequestSchema.parse({ browserAccess: { mode: "any" } }),
    ).toEqual({ browserAccess: { mode: "any" } });
    expect(
      gatewayKeyUpdateRequestSchema.safeParse({
        browserAccess: { mode: "origins", origins: ["https://*.github.io"] },
      }).success,
    ).toBe(false);
  });
});

describe("a Browser access origin", () => {
  it("take an https origin on any host, with or without a port", () => {
    expect(origin("https://cv.example.github.io").data).toBe(
      "https://cv.example.github.io",
    );
    expect(origin("https://tools.example:8443").data).toBe(
      "https://tools.example:8443",
    );
  });

  it("take plain http only for this machine", () => {
    expect(origin("http://localhost:4870").data).toBe("http://localhost:4870");
    expect(origin("http://127.0.0.1:4870").data).toBe("http://127.0.0.1:4870");
    expect(origin("http://[::1]:4870").data).toBe("http://[::1]:4870");
    for (const value of [
      "http://example.com",
      "http://192.168.1.10:4870",
      "http://localhost.example.com",
    ]) {
      expect(origin(value).success, value).toBe(false);
    }
  });

  it("are given back as a browser sends them: trimmed, lowercased, without a default port", () => {
    expect(origin("  HTTPS://CV.Example.COM  ").data).toBe(
      "https://cv.example.com",
    );
    expect(origin("https://cv.example.com:443").data).toBe(
      "https://cv.example.com",
    );
    expect(origin("http://localhost:80").data).toBe("http://localhost");
  });

  it("refuse a path, a trailing slash, a query, a fragment and credentials", () => {
    for (const value of [
      "https://cv.example.com/",
      "https://cv.example.com/checker",
      "https://cv.example.com?x=1",
      "https://cv.example.com#top",
      "https://owner:secret@cv.example.com",
    ]) {
      expect(origin(value).success, value).toBe(false);
    }
  });

  it("refuse wildcards, the null origin and other schemes", () => {
    for (const value of [
      "*",
      "https://*.github.io",
      "null",
      "NULL",
      "file://",
      "ftp://files.example.com",
      "chrome-extension://abcdefghijklmnop",
      "cv.example.com",
      "",
      42,
    ]) {
      expect(origin(value).success, String(value)).toBe(false);
    }
    expect(origin("https://*.github.io").error?.issues[0]?.message).toContain(
      "wildcard",
    );
  });

  it("is kept once, in the order given", () => {
    expect(
      origins([
        "http://localhost:4870",
        "https://cv.example.com",
        "HTTPS://cv.example.com:443",
        "http://localhost:4870",
      ]).data,
    ).toEqual({
      mode: "origins",
      origins: ["http://localhost:4870", "https://cv.example.com"],
    });
  });

  it(`list at most ${String(maxBrowserOrigins)}`, () => {
    const many = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `https://site${String(index)}.example`,
      );
    expect(origins(many(maxBrowserOrigins)).success).toBe(true);
    expect(origins(many(maxBrowserOrigins + 1)).success).toBe(false);
    // Repeats count once.
    expect(
      origins([...many(maxBrowserOrigins), "https://site0.example"]).success,
    ).toBe(true);
    // And at least one.
    expect(origins([]).success).toBe(false);
  });

  it("refuse anything but a list of origins", () => {
    expect(origins("https://x.example").success).toBe(false);
    expect(origins(undefined).success).toBe(false);
  });
});
