import { createVerify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAppKeys } from "./fake-server.ts";
import { appJwt, appJwtLifetimeSeconds } from "./jwt.ts";

const decode = (part: string): unknown =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("the App's JWT", () => {
  const { privateKey, publicKey } = createAppKeys();
  const now = new Date("2026-10-08T12:00:00.000Z");
  const seconds = now.getTime() / 1000;

  it("is RS256, issued by the App, backdated a minute and valid under ten", () => {
    const jwt = appJwt({ appId: "4242", privateKey, now });
    const [header = "", payload = "", signature = ""] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload)).toEqual({
      iat: seconds - 60,
      exp: seconds + appJwtLifetimeSeconds,
      iss: "4242",
    });
    const claims = decode(payload) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
  });

  it("does not verify with another key", () => {
    const jwt = appJwt({ appId: "4242", privateKey, now });
    const [header = "", payload = "", signature = ""] = jwt.split(".");
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(createAppKeys().publicKey, Buffer.from(signature, "base64url")),
    ).toBe(false);
  });
});
