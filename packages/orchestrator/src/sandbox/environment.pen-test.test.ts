import { createGitHubApp } from "@ai-office/github";
import {
  createAppKeys,
  createFakeGitHub,
  serveFakeGitHub,
  type FakeGitHubServer,
} from "@ai-office/github/testing";
import { afterEach, describe, expect, it } from "vitest";

import { agentToolSetup } from "./agent-tools.ts";
import {
  allowedEnvironment,
  refuseAiAccountCredentials,
  sandboxEnvironment,
  sandboxEnvironmentKeys,
  SandboxEnvironmentError,
} from "./environment.ts";

// Probe S2 ("Confirm, don't re-test": the sandbox environment). The PRD
// register reads three controls as sound: the sandbox's environment is an
// allow-list, it refuses values that look like (or are) AI Account
// credentials, and its GH_TOKEN is read-only. This probe tries to get
// round each with the real functions the runner (`runner.ts`), the fact
// finder and the Manager chat call, and the real GitHub App client
// against the fake GitHub, which grants each call only the permission
// GitHub would ask of it. Every value here is a fake. Each control holds;
// these tests keep it holding. See docs/pen-testing/assessments/S2.md.

const fakeGatewayKey = "aio_gk_fakeFakeFakeFakeFake0001";
const gateway = { url: "http://app:3047", key: fakeGatewayKey };
const identity = { name: "Owner", email: "owner@users.noreply.github.com" };

describe("the allow-list", () => {
  it("is exactly the Git identity, the read-only GH_TOKEN and each agent tool's way to the Gateway", () => {
    expect([...sandboxEnvironmentKeys].sort()).toEqual(
      [
        "AI_OFFICE_GATEWAY_KEY",
        "AI_OFFICE_ISSUE",
        "AI_OFFICE_PULL_REQUEST",
        "AI_OFFICE_SESSION",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "GH_TOKEN",
        "GIT_AUTHOR_EMAIL",
        "GIT_AUTHOR_NAME",
        "GIT_COMMITTER_EMAIL",
        "GIT_COMMITTER_NAME",
        // The sandbox relay as the only way out, and the Gateway reached
        // directly, set by AI Office over whatever the Docker CLI injects;
        // allowed only with AI Office's own values.
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "NO_PROXY",
        "no_proxy",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "OPENAI_BASE_URL",
        "OPENCODE_CONFIG_CONTENT",
        // Set to "true" by AI Office: opencode reads no project
        // configuration and none of Claude Code's files (P1-9).
        "OPENCODE_DISABLE_CLAUDE_CODE",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
      ].sort(),
    );
  });

  it("drops what a repository's .sandcastle/.env could name from the app's environment, and anything that changes how the tools run", () => {
    expect(
      allowedEnvironment({
        DATABASE_URL: "postgres://fake",
        SESSION_SECRET: "fake",
        ENCRYPTION_KEY: "fake",
        GITHUB_APP_PRIVATE_KEY: "fake",
        DOCKER_HOST: "unix:///fake.sock",
        NODE_OPTIONS: "--fake",
        LD_PRELOAD: "/fake.so",
        PATH: "/fake",
        HTTPS_PROXY: "http://fake",
        http_proxy: "http://sandbox-relay:3128.evil.example",
        NO_PROXY: "*; curl evil.example",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0",
        GIT_CONFIG_GLOBAL: "/fake",
        GH_TOKEN: "ghs_fakefakefake",
      }),
    ).toEqual({ GH_TOKEN: "ghs_fakefakefake" });
  });

  it("matches key names exactly: no case or whitespace variant slips through", () => {
    expect(
      allowedEnvironment({
        gh_token: "x",
        "GH_TOKEN ": "x",
        "ANTHROPIC_BASE_URL\n": "x",
        anthropic_auth_token: "x",
      }),
    ).toEqual({});
  });
});

describe("the AI-Account-credential refusal", () => {
  const shaped: [string, string][] = [
    ["an Anthropic key", `sk-ant-api03-${"f".repeat(40)}`],
    ["an OpenAI key", `sk-proj-${"f".repeat(40)}`],
    ["an xAI key", `xai-${"f".repeat(80)}`],
    ["a Google API key", `AIza${"f".repeat(35)}`],
    ["a JWT", `eyJ${"f".repeat(20)}.eyJ${"f".repeat(40)}.${"f".repeat(30)}`],
  ];

  it.each(shaped)(
    "refuses %s under an allowed key, even inside a longer value",
    (_, value) => {
      expect(() =>
        sandboxEnvironment({
          identity,
          githubToken: `prefix ${value} suffix`,
          model: {},
        }),
      ).toThrow(SandboxEnvironmentError);
    },
  );

  it("refuses one of the Owner's credentials whatever its shape, under any key", async () => {
    const stored = "fake-opaque-ai-account-credential";
    const environment = sandboxEnvironment({
      identity: { name: stored, email: "owner@users.noreply.github.com" },
      githubToken: "ghs_fakefakefake",
      model: {},
    });
    await expect(
      refuseAiAccountCredentials(environment, (value) =>
        Promise.resolve(value.includes(stored)),
      ),
    ).rejects.toMatchObject({ key: "GIT_AUTHOR_NAME" });
  });

  it("gives every agent tool the Gateway Key only, and refuses anything else in its place", () => {
    for (const aiProvider of ["Claude", "ChatGPT", "Grok"]) {
      const agent = { aiProvider, model: "fake-model", effort: null };
      expect(() =>
        agentToolSetup(agent, gateway, { issue: 7, session: "sbx-1" }),
      ).not.toThrow();
      for (const key of [
        `sk-ant-api03-${"f".repeat(40)}`,
        "fake-anything-but-a-gateway-key",
        `${fakeGatewayKey}\nX-Other: 1`,
      ]) {
        expect(() =>
          agentToolSetup(agent, { ...gateway, key }, { issue: 7 }),
        ).toThrow(SandboxEnvironmentError);
      }
    }
  });
});

describe("the sandbox's GH_TOKEN", () => {
  const servers: FakeGitHubServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function readOnly() {
    const keys = createAppKeys();
    const fake = createFakeGitHub();
    fake.installRepository("adrianeyre/web-shop");
    fake.installRepository("adrianeyre/blog");
    fake.createIssue("adrianeyre/web-shop", { title: "Fix the basket" });
    const server = await serveFakeGitHub(fake, {
      appId: "4242",
      publicKey: keys.publicKey,
    });
    servers.push(server);
    const app = createGitHubApp({
      appId: "4242",
      privateKey: keys.privateKey,
      baseUrl: server.url,
    });
    const { token } = await app
      .repository("adrianeyre/web-shop")
      .readOnlyToken();
    /** A call to GitHub's API with the sandbox's token, as `gh api` makes it. */
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${server.url}${path}`, {
        method,
        headers: {
          authorization: `token ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { server, call };
  }

  it("is minted for the Floor's repository alone, with read permissions only", async () => {
    const { server } = await readOnly();
    const minted = server.mintedTokens.at(-1);
    expect(minted?.repositories).toEqual(["web-shop"]);
    expect(Object.values(minted?.permissions ?? { all: "write" })).toEqual(
      expect.arrayContaining(["read"]),
    );
    expect(Object.values(minted?.permissions ?? {})).not.toContain("write");
  });

  it("reads the issue, but can neither comment, open an issue or pull request, nor push a ref", async () => {
    const { call } = await readOnly();
    const repo = "/repos/adrianeyre/web-shop";
    expect((await call("GET", `${repo}/issues/1/comments`)).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", `${repo}/issues/1/comments`, { body: "fake" }],
      ["POST", `${repo}/issues`, { title: "fake" }],
      ["POST", `${repo}/pulls`, { title: "fake", head: "a", base: "main" }],
      [
        "POST",
        `${repo}/git/refs`,
        { ref: "refs/heads/fake", sha: "0".repeat(40) },
      ],
    ] as const) {
      expect((await call(method, path, body)).status).toBe(403);
    }
  });

  it("reads nothing of another repository in the same installation", async () => {
    const { call } = await readOnly();
    expect(
      (await call("GET", "/repos/adrianeyre/blog/issues/1/comments")).status,
    ).toBeGreaterThanOrEqual(403);
  });
});
