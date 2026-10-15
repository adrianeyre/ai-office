import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
} from "@ai-hero/sandcastle";
import { describe, expect, it } from "vitest";

import { issueBranch } from "./branch.ts";
import {
  allowListed,
  codexModelEnvironment,
  gatewayModelEnvironment,
  modelEnvironmentKeys,
  refuseAiAccountCredentials,
  sandboxEnvironment,
  sandboxEnvironmentKeys,
  SandboxEnvironmentError,
  proxyEnvironment,
} from "./environment.ts";

const identity = { name: "adrianeyre", email: "adrian@example.com" };
const gatewayKey = "aio_gk_agentkeyforthesandbox0000000000000000000";
const gateway = { url: "http://app:4000", key: gatewayKey };

// AI Account credentials of every shape AI Office knows (PRD FR-35).
const aiAccountCredentials: Record<string, string> = {
  "an Anthropic API key": "sk-ant-api03-AbCdEf0123456789-xyz",
  "an Anthropic subscription token": "sk-ant-oat01-AbCdEf0123456789-xyz",
  "an OpenAI key": "sk-proj-AbCdEf0123456789AbCdEf01",
  "an xAI key": "xai-AbCdEf0123456789AbCdEf0123",
  "a Google API key": "AIzaSyA-0123456789abcdefghijklmnopqrstu",
  "a Google OAuth token": "ya29.a0AbCdEf0123456789AbCdEf",
  "an AWS access key": "AKIAABCDEFGHIJKLMNOP",
  "a ChatGPT OAuth token (a JWT)":
    "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlMDEyMzQ1",
};

describe("a sandbox's environment", () => {
  it("holds the Git identity, the GitHub token and the way to the AI Gateway only", () => {
    expect(
      sandboxEnvironment({
        identity,
        githubToken: "ghs_readonly",
        model: gatewayModelEnvironment(gateway, {
          issue: 4,
          pullRequest: 7,
          session: "sbx-1",
        }),
      }),
    ).toEqual({
      GIT_AUTHOR_NAME: "adrianeyre",
      GIT_AUTHOR_EMAIL: "adrian@example.com",
      GIT_COMMITTER_NAME: "adrianeyre",
      GIT_COMMITTER_EMAIL: "adrian@example.com",
      GH_TOKEN: "ghs_readonly",
      ...proxyEnvironment("http://app:4000"),
      ANTHROPIC_BASE_URL: "http://app:4000",
      ANTHROPIC_AUTH_TOKEN: gatewayKey,
      // Claude Code sends these on every model call (FR-37, FR-42).
      ANTHROPIC_CUSTOM_HEADERS:
        "x-ai-office-issue: 4\nx-ai-office-pull-request: 7\nx-ai-office-session: sbx-1",
    });
  });

  it("names only the issue until it has a pull request", () => {
    expect(
      gatewayModelEnvironment(gateway, { issue: 12 }).ANTHROPIC_CUSTOM_HEADERS,
    ).toBe("x-ai-office-issue: 12");
  });

  it("holds no Git identity and names no issue for a read-only sandbox finding facts (FR-79)", () => {
    expect(
      sandboxEnvironment({
        githubToken: "ghs_readonly",
        model: gatewayModelEnvironment(gateway, { session: "sbx-2" }),
      }),
    ).toEqual({
      GH_TOKEN: "ghs_readonly",
      ...proxyEnvironment("http://app:4000"),
      ANTHROPIC_BASE_URL: "http://app:4000",
      ANTHROPIC_AUTH_TOKEN: gatewayKey,
      ANTHROPIC_CUSTOM_HEADERS: "x-ai-office-session: sbx-2",
    });
    expect(
      codexModelEnvironment(gateway, { session: "sbx-2" }),
    ).not.toHaveProperty("AI_OFFICE_ISSUE");
  });

  it("has no key for an AI Account's credential", () => {
    expect(modelEnvironmentKeys).toEqual([
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_CUSTOM_HEADERS",
    ]);
    for (const key of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "XAI_API_KEY",
      "GEMINI_API_KEY",
    ]) {
      expect(sandboxEnvironmentKeys).not.toContain(key);
    }
  });

  it.each(Object.entries(aiAccountCredentials))(
    "takes only a Gateway Key, never %s",
    (_kind, credential) => {
      const refusal = (() => {
        try {
          gatewayModelEnvironment(
            { url: "http://app:4000", key: credential },
            { issue: 4 },
          );
        } catch (error) {
          return error;
        }
        return undefined;
      })();
      expect(refusal).toBeInstanceOf(SandboxEnvironmentError);
      expect((refusal as SandboxEnvironmentError).key).toBe(
        "ANTHROPIC_AUTH_TOKEN",
      );
      // The refusal never carries the credential.
      expect((refusal as Error).message).not.toContain(credential);
    },
  );

  // Every way a value reaches a sandbox: the Git identity, the GitHub
  // token and the model environment's three keys.
  const placements: [
    string,
    (credential: string) => Parameters<typeof sandboxEnvironment>[0],
  ][] = [
    [
      "GIT_AUTHOR_NAME",
      (credential) => ({
        identity: { ...identity, name: credential },
        githubToken: "ghs_readonly",
        model: gatewayModelEnvironment(gateway, { issue: 4 }),
      }),
    ],
    [
      "GIT_AUTHOR_EMAIL",
      (credential) => ({
        identity: { ...identity, email: `${credential}@example.com` },
        githubToken: "ghs_readonly",
        model: gatewayModelEnvironment(gateway, { issue: 4 }),
      }),
    ],
    [
      "GH_TOKEN",
      (credential) => ({
        identity,
        githubToken: credential,
        model: gatewayModelEnvironment(gateway, { issue: 4 }),
      }),
    ],
    [
      "ANTHROPIC_BASE_URL",
      (credential) => ({
        identity,
        githubToken: "ghs_readonly",
        model: {
          ...gatewayModelEnvironment(gateway, { issue: 4 }),
          ANTHROPIC_BASE_URL: `http://app:4000/?key=${credential}`,
        },
      }),
    ],
    [
      "ANTHROPIC_AUTH_TOKEN",
      (credential) => ({
        identity,
        githubToken: "ghs_readonly",
        model: {
          ...gatewayModelEnvironment(gateway, { issue: 4 }),
          ANTHROPIC_AUTH_TOKEN: credential,
        },
      }),
    ],
    [
      "ANTHROPIC_CUSTOM_HEADERS",
      (credential) => ({
        identity,
        githubToken: "ghs_readonly",
        model: {
          ...gatewayModelEnvironment(gateway, { issue: 4 }),
          ANTHROPIC_CUSTOM_HEADERS: `x-api-key: ${credential}`,
        },
      }),
    ],
  ];

  it.each(
    placements.flatMap(([key, place]) =>
      Object.entries(aiAccountCredentials).map(
        ([kind, credential]) => [kind, key, place(credential)] as const,
      ),
    ),
  )("is refused when it holds %s under %s", (_kind, key, options) => {
    expect(() => sandboxEnvironment(options)).toThrow(
      expect.objectContaining({ name: "SandboxEnvironmentError", key }),
    );
  });

  it("is refused when it holds one of the Owner's AI Account credentials, whatever its shape, under any key", async () => {
    // A custom endpoint's key need not look like any known credential.
    const owners = ["opaque-custom-endpoint-secret-0001"];
    const isAiAccountCredential = (value: string) =>
      Promise.resolve(owners.some((credential) => value.includes(credential)));
    for (const [key, place] of placements) {
      const environment = sandboxEnvironment(place("a-harmless-value"));
      await expect(
        refuseAiAccountCredentials(environment, isAiAccountCredential),
      ).resolves.toBeUndefined();
      const holding = {
        ...environment,
        [key]: `${environment[key] ?? ""}${owners[0] ?? ""}`,
      };
      await expect(
        refuseAiAccountCredentials(holding, isAiAccountCredential),
      ).rejects.toMatchObject({ name: "SandboxEnvironmentError", key });
    }
  });

  it("is all a wrapped provider starts a sandbox with", async () => {
    const started: Record<string, string>[] = [];
    const provider = allowListed(
      createBindMountSandboxProvider({
        name: "docker",
        env: { GH_TOKEN: "ghs_readonly", DOCKER_HOST: "unix:///var/run/x" },
        create: (options: BindMountCreateOptions) => {
          started.push(options.env);
          return Promise.resolve({} as BindMountSandboxHandle);
        },
      }),
    );
    expect(provider.env).toEqual({ GH_TOKEN: "ghs_readonly" });
    // What Sandcastle gathered, as the wrapped provider is given it.
    const create = (
      provider as unknown as {
        create: (options: BindMountCreateOptions) => Promise<unknown>;
      }
    ).create;
    await create({
      worktreePath: "/work",
      hostRepoPath: "/repo",
      mounts: [],
      env: {
        GH_TOKEN: "ghs_readonly",
        GIT_AUTHOR_NAME: "adrianeyre",
        DATABASE_URL: "postgres://secret",
        SESSION_SECRET: "secret",
        PATH: "/usr/bin",
      },
    });
    expect(started).toEqual([
      { GH_TOKEN: "ghs_readonly", GIT_AUTHOR_NAME: "adrianeyre" },
    ]);
  });

  it("never starts a sandbox whose environment holds an AI Provider's credential, under any key", async () => {
    const started: Record<string, string>[] = [];
    const provider = allowListed(
      createBindMountSandboxProvider({
        name: "docker",
        env: {},
        create: (options: BindMountCreateOptions) => {
          started.push(options.env);
          return Promise.resolve({} as BindMountSandboxHandle);
        },
      }),
    );
    const create = (
      provider as unknown as {
        create: (options: BindMountCreateOptions) => Promise<unknown>;
      }
    ).create;
    for (const credential of Object.values(aiAccountCredentials)) {
      await expect(
        create({
          worktreePath: "/work",
          hostRepoPath: "/repo",
          mounts: [],
          env: { GH_TOKEN: "ghs_readonly", GIT_COMMITTER_NAME: credential },
        }),
      ).rejects.toMatchObject({ key: "GIT_COMMITTER_NAME" });
    }
    expect(started).toEqual([]);
    // Nor is a provider made with one in its own environment.
    expect(() =>
      allowListed(
        createBindMountSandboxProvider({
          name: "docker",
          env: {
            ANTHROPIC_AUTH_TOKEN:
              aiAccountCredentials["an Anthropic API key"] ?? "",
          },
          create: () => Promise.resolve({} as BindMountSandboxHandle),
        }),
      ),
    ).toThrow(SandboxEnvironmentError);
  });

  it("refuses providers that are not bind-mount ones", () => {
    expect(() => allowListed({ name: "vercel", env: {} })).toThrow(
      "bind-mount providers such as Docker, not vercel",
    );
  });
});

describe("an issue's branch", () => {
  it("is ai-office/<issue>-<slug>", () => {
    expect(issueBranch(4, "Add a basket!")).toBe("ai-office/4-add-a-basket");
    expect(issueBranch(12, "  Café: crème brûlée / v2  ")).toBe(
      "ai-office/12-cafe-creme-brulee-v2",
    );
    expect(issueBranch(7, "!!!")).toBe("ai-office/7");
    expect(
      issueBranch(9, "A very long title that goes on and on well past forty"),
    ).toBe("ai-office/9-a-very-long-title-that-goes-on-and-on-we");
  });
});
