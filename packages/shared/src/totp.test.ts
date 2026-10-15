import { describe, expect, it } from "vitest";

import {
  isTotpCode,
  loginResponseSchema,
  normaliseCode,
  totpCodeRequestSchema,
} from "./index.ts";

describe("codes", () => {
  it("tells a TOTP code from a recovery code", () => {
    expect(isTotpCode("123456")).toBe(true);
    expect(isTotpCode("123 456")).toBe(true);
    expect(isTotpCode("12345")).toBe(false);
    expect(isTotpCode("abcd-efgh-jkmn-pqrs")).toBe(false);
  });

  it("normalises spaces, dashes and case away", () => {
    expect(normaliseCode(" ABCD-efgh jkmn-PQRS ")).toBe("abcdefghjkmnpqrs");
  });

  it("takes a trimmed, non-empty code", () => {
    expect(totpCodeRequestSchema.parse({ code: " 123456 " })).toEqual({
      code: "123456",
    });
    expect(totpCodeRequestSchema.safeParse({ code: "  " }).success).toBe(false);
  });
});

describe("loginResponseSchema", () => {
  it("is a session, or a request for the second factor", () => {
    expect(
      loginResponseSchema.parse({
        csrfToken: "t",
        expiresAt: "2026-10-15T12:00:00.000Z",
      }),
    ).toHaveProperty("csrfToken");
    expect(loginResponseSchema.parse({ secondFactor: "totp" })).toEqual({
      secondFactor: "totp",
    });
  });
});
