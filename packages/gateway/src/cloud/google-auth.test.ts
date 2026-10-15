import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createGoogleTokenCache,
  GoogleAuthError,
  googleTokenUrl,
  serviceAccountAssertion,
} from "./google-auth.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const key = {
  type: "service_account" as const,
  client_email: "ai-office@project.iam.gserviceaccount.com",
  private_key: privateKey,
  private_key_id: "kid-1",
};
const now = new Date("2026-10-10T09:00:00Z");

const decode = (part: string | undefined): unknown =>
  JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));

describe("serviceAccountAssertion", () => {
  it("is a JWT for Google's token endpoint, signed with the key", () => {
    const [header, claims, signature] = serviceAccountAssertion(key, now).split(
      ".",
    );
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-1" });
    expect(decode(claims)).toEqual({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: googleTokenUrl,
      iat: now.getTime() / 1000,
      exp: now.getTime() / 1000 + 3600,
    });
    expect(
      createVerify("RSA-SHA256")
        .update(`${header ?? ""}.${claims ?? ""}`)
        .verify(publicKey, Buffer.from(signature ?? "", "base64url")),
    ).toBe(true);
  });

  it("refuses a key that cannot sign, without quoting it", () => {
    expect(() =>
      serviceAccountAssertion(
        { ...key, private_key: "-----BEGIN PRIVATE KEY-----\nnot a key\n" },
        now,
      ),
    ).toThrow(GoogleAuthError);
  });
});

describe("createGoogleTokenCache", () => {
  const answering = (answers: (() => Response)[]) => {
    const calls: { url: string; body: string }[] = [];
    const fetch = (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ?? "" });
      const answer = answers.shift();
      return answer === undefined
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(answer());
    };
    return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
  };
  const token =
    (value: string, expiresIn = 3600) =>
    () =>
      Response.json({ access_token: value, expires_in: expiresIn });

  it("keeps a token until five minutes before it expires", async () => {
    let at = now.getTime();
    const told: string[] = [];
    const { calls, fetch } = answering([token("t1"), token("t2")]);
    const cache = createGoogleTokenCache({
      fetch,
      now: () => new Date(at),
      onToken: (value) => told.push(value),
    });
    expect(await cache.token("a", key)).toBe("t1");
    at += 54 * 60 * 1000;
    expect(await cache.token("a", key)).toBe("t1");
    at += 2 * 60 * 1000;
    expect(await cache.token("a", key)).toBe("t2");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(googleTokenUrl);
    expect(new URLSearchParams(calls[0]?.body).get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    expect(told).toEqual(["t1", "t2"]);
  });

  it("asks once for requests that want a token together, and again after a refusal", async () => {
    const { calls, fetch } = answering([
      () =>
        Response.json(
          { error: "invalid_grant", error_description: "secret detail" },
          { status: 400 },
        ),
      token("t2"),
    ]);
    const cache = createGoogleTokenCache({ fetch, now: () => now });
    const refused = await Promise.allSettled([
      cache.token("a", key),
      cache.token("a", key),
    ]);
    expect(refused.map(({ status }) => status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(calls).toHaveLength(1);
    const [first] = refused;
    expect(first.status === "rejected" && String(first.reason)).toBe(
      "GoogleAuthError: Google refused the service account's sign-in (400: invalid_grant).",
    );
    expect(await cache.token("a", key)).toBe("t2");
    expect(calls).toHaveLength(2);
  });

  it("keeps each account's token apart, and forgets a deleted one's", async () => {
    const { calls, fetch } = answering([token("a1"), token("b1"), token("a2")]);
    const cache = createGoogleTokenCache({ fetch, now: () => now });
    expect(await cache.token("a", key)).toBe("a1");
    expect(await cache.token("b", key)).toBe("b1");
    cache.forget("a");
    expect(await cache.token("a", key)).toBe("a2");
    expect(calls).toHaveLength(3);
  });

  it("says when Google cannot be reached", async () => {
    const { fetch } = answering([]);
    const cache = createGoogleTokenCache({ fetch, now: () => now });
    await expect(cache.token("a", key)).rejects.toThrow(
      "Google's token endpoint could not be reached.",
    );
  });
});
