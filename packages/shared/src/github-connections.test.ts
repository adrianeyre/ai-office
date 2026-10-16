import { describe, expect, it } from "vitest";

import {
  githubAccessTokenConnectionCreateSchema,
  githubAppConnectionCreateSchema,
  githubConnectionUpdateSchema,
} from "./github-connections.ts";

// What the Owner gives in Floor Settings to add a GitHub App or an access
// token: checked before anything is sealed or kept.

const pem =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
const writer = "github_pat_11AAAAAAA0writer";
const reader = "github_pat_11AAAAAAA0reader";

const problems = (result: {
  success: boolean;
  error?: { issues: { message: string }[] };
}) => result.error?.issues.map(({ message }) => message) ?? [];

describe("adding a GitHub App", () => {
  it("takes its ID and PEM private key, with a name or none", () => {
    expect(
      githubAppConnectionCreateSchema.parse({
        appId: " 123456 ",
        privateKey: `${pem}\n`,
      }),
    ).toEqual({ appId: "123456", privateKey: pem });
    expect(
      githubAppConnectionCreateSchema.parse({
        name: " Acme's App ",
        appId: "1",
        privateKey: pem.replaceAll("\n", "\\n"),
      }),
    ).toEqual({ name: "Acme's App", appId: "1", privateKey: pem });
  });

  it("refuses an ID that is not numeric, a key that is no PEM, and anything else", () => {
    expect(
      problems(
        githubAppConnectionCreateSchema.safeParse({
          appId: "acme",
          privateKey: "not a key",
        }),
      ),
    ).toEqual([
      "The App ID is the App's numeric ID.",
      "The private key is the App's PEM file, as GitHub gave it.",
    ]);
    expect(
      githubAppConnectionCreateSchema.safeParse({
        appId: "1",
        privateKey: pem,
        token: writer,
      }).success,
    ).toBe(false);
  });
});

describe("adding an access token", () => {
  it("takes the token and its read-only partner", () => {
    expect(
      githubAccessTokenConnectionCreateSchema.parse({
        token: ` ${writer} `,
        readOnlyToken: reader,
      }),
    ).toEqual({ token: writer, readOnlyToken: reader });
  });

  it("takes a classic personal access token as either", () => {
    const classic = `ghp_${"aB3".repeat(12)}`;
    expect(
      githubAccessTokenConnectionCreateSchema.parse({
        token: classic,
        readOnlyToken: reader,
      }),
    ).toEqual({ token: classic, readOnlyToken: reader });
    expect(
      githubAccessTokenConnectionCreateSchema.parse({
        token: writer,
        readOnlyToken: classic,
      }),
    ).toEqual({ token: writer, readOnlyToken: classic });
  });

  it("says which token is missing or wrong", () => {
    expect(
      problems(
        githubAccessTokenConnectionCreateSchema.safeParse({
          token: writer,
          readOnlyToken: " ",
        }),
      ),
    ).toEqual([
      "Give a read-only access token too: sandboxes get it, never the access token.",
    ]);
    expect(
      problems(
        githubAccessTokenConnectionCreateSchema.safeParse({ token: writer }),
      ),
    ).toEqual([
      "Give a read-only access token too: sandboxes get it, never the access token.",
    ]);
    expect(
      problems(
        githubAccessTokenConnectionCreateSchema.safeParse({
          token: "",
          readOnlyToken: "short",
        }),
      ),
    ).toEqual([
      "Give the access token.",
      "The read-only access token is not a GitHub access token.",
    ]);
  });

  it("refuses the same token twice, or something that is not a token", () => {
    expect(
      problems(
        githubAccessTokenConnectionCreateSchema.safeParse({
          token: writer,
          readOnlyToken: writer,
        }),
      ),
    ).toEqual([
      "The read-only token must be another token, one that can only read: sandboxes get it.",
    ]);
    expect(
      problems(
        githubAccessTokenConnectionCreateSchema.safeParse({
          token: "short",
          readOnlyToken: reader,
        }),
      ),
    ).toEqual(["That is not a GitHub access token."]);
  });
});

describe("changing a connection", () => {
  it("takes a name, whether it is used, or both, and needs one", () => {
    expect(githubConnectionUpdateSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(githubConnectionUpdateSchema.parse({ name: " Work " })).toEqual({
      name: "Work",
    });
    expect(githubConnectionUpdateSchema.safeParse({}).success).toBe(false);
    expect(githubConnectionUpdateSchema.safeParse({ name: "" }).success).toBe(
      false,
    );
  });
});
