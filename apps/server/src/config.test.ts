import { describe, expect, it } from "vitest";

import {
  ConfigError,
  developmentSecrets,
  developmentSecretsInUse,
  environmentKeys,
  loadConfig,
  retiredGitHubVariables,
  secretValues,
} from "./config.ts";

const validEnv = {
  DATABASE_URL: "postgres://ai_office:db-pass-0f3a9c@localhost:3048/ai_office",
  SESSION_SECRET: "session-secret-6b1d0e9f4c2a8b7e5d3f1a0c9e8b7d6a",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} as const;

const proxySecret = "proxy-secret-3c9e1a7b5d2f8e0a4c6b9d1f3e5a7c";

const problemsFor = (env: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return [...error.problems];
    }
    throw error;
  }
  throw new Error("expected a ConfigError");
};

describe("developmentSecretsInUse", () => {
  it("names the sample secrets from .env.example, and nothing else", () => {
    expect(developmentSecretsInUse(loadConfig(validEnv))).toEqual([]);
    expect(
      developmentSecretsInUse(
        loadConfig({ ...validEnv, ...developmentSecrets }),
      ),
    ).toEqual(["SESSION_SECRET", "ENCRYPTION_KEY"]);
    expect(
      developmentSecretsInUse(
        loadConfig({
          ...validEnv,
          DATABASE_URL: `postgres://ai_office:${developmentSecrets.POSTGRES_PASSWORD}@postgres:3048/ai_office`,
        }),
      ),
    ).toEqual(["POSTGRES_PASSWORD"]);
  });
});

describe("loadConfig", () => {
  it("reads a valid environment and fills in the defaults", () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({
      databaseUrl: validEnv.DATABASE_URL,
      sessionSecret: validEnv.SESSION_SECRET,
      port: 3046,
      host: "127.0.0.1",
      publicUrl: "http://localhost:3045",
      logLevel: "info",
    });
    expect(config.encryptionKey).toEqual(Buffer.alloc(32, 7));
    expect(config.webDistDir).toMatch(/apps[/\\]web[/\\]dist$/);
    expect(config.githubApiUrl).toBe("https://api.github.com");
    expect(config.trustProxy).toBeUndefined();
    expect(config.gateway).toEqual({ port: 3047, host: "127.0.0.1" });
    // Agents do not work issues until sandboxes can reach the Gateway.
    expect(config.sandboxes.gatewayUrl).toBeUndefined();
    expect(config.sandboxes.workDir).toMatch(/ai-office-sandboxes$/);
    // Never Docker's default bridge, which has a route out (S2-1).
    expect(config.sandboxes.network).toBe("ai-office-sandboxes");
  });

  it("uses the sandbox relay for a SANDBOX_GATEWAY_URL sandboxes cannot reach, keeping what was given for the warning", () => {
    // An older .env.example's: a sandbox's network cannot even look it up.
    expect(
      loadConfig({
        ...validEnv,
        SANDBOX_GATEWAY_URL: "http://host.docker.internal:3047",
      }).sandboxes,
    ).toMatchObject({
      gatewayUrl: "http://sandbox-relay:3047",
      givenGatewayUrl: "http://host.docker.internal:3047",
    });
    expect(
      loadConfig({
        ...validEnv,
        SANDBOX_GATEWAY_URL: "http://sandbox-relay:3047/",
      }).sandboxes,
    ).not.toHaveProperty("givenGatewayUrl");
  });

  it("reads where sandboxes work and how they reach the AI Gateway", () => {
    expect(
      loadConfig({
        ...validEnv,
        SANDBOX_WORK_DIR: "/srv/ai-office/sandboxes",
        SANDBOX_GATEWAY_URL: "http://sandbox-relay:3047",
        SANDBOX_NETWORK: "ai-office-closed",
      }).sandboxes,
    ).toEqual({
      workDir: "/srv/ai-office/sandboxes",
      gatewayUrl: "http://sandbox-relay:3047",
      network: "ai-office-closed",
    });
    expect(() =>
      loadConfig({ ...validEnv, SANDBOX_GATEWAY_URL: "host:3047" }),
    ).toThrow(/SANDBOX_GATEWAY_URL must be an http:\/\/ or https:\/\/ URL/);
    expect(() =>
      loadConfig({ ...validEnv, SANDBOX_NETWORK: "--network host" }),
    ).toThrow(/SANDBOX_NETWORK must be a Docker network's name/);
  });

  it.each([
    ["1", 1],
    ["2", 2],
    ["127.0.0.1", ["127.0.0.1"]],
    ["172.16.0.0/12, ::1, fd00::/8", ["172.16.0.0/12", "::1", "fd00::/8"]],
  ])("reads TRUST_PROXY=%j, with PROXY_SECRET", (value, trustProxy) => {
    const config = loadConfig({
      ...validEnv,
      TRUST_PROXY: value,
      PROXY_SECRET: proxySecret,
    });
    expect(config.trustProxy).toEqual(trustProxy);
    expect(config.proxySecret).toBe(proxySecret);
  });

  it("refuses TRUST_PROXY without PROXY_SECRET, and the other way round", () => {
    const problem =
      "TRUST_PROXY and PROXY_SECRET must be set together, or neither: X-Forwarded-For is believed only from a proxy that sends PROXY_SECRET";
    expect(problemsFor({ ...validEnv, TRUST_PROXY: "1" })).toEqual([problem]);
    expect(problemsFor({ ...validEnv, PROXY_SECRET: proxySecret })).toEqual([
      problem,
    ]);
  });

  it("reads the optional values", () => {
    const config = loadConfig({
      ...validEnv,
      PORT: "8080",
      HOST: "127.0.0.1",
      PUBLIC_URL: "https://office.example.com",
      LOG_LEVEL: "debug",
      WEB_DIST_DIR: "/srv/web",
      GATEWAY_PORT: "4100",
      GATEWAY_HOST: "0.0.0.0",
      GATEWAY_FIXTURES_DIR: "/tmp/fixtures",
    });
    expect(config).toMatchObject({
      port: 8080,
      host: "127.0.0.1",
      publicUrl: "https://office.example.com",
      logLevel: "debug",
      webDistDir: "/srv/web",
      gateway: { port: 4100, host: "0.0.0.0", fixturesDir: "/tmp/fixtures" },
    });
  });

  it("takes no AI Account from the environment: they are added in Admin", () => {
    const config = loadConfig({
      ...validEnv,
      ANTHROPIC_API_KEY: "sk-ant-api03-configtestkey-000000000000",
    });
    expect(config.gateway).toEqual({ port: 3047, host: "127.0.0.1" });
    expect(JSON.stringify(config)).not.toContain("configtestkey");
    expect(environmentKeys).not.toContain("ANTHROPIC_API_KEY");
  });

  it("refuses a GATEWAY_PORT that is the same as PORT", () => {
    expect(problemsFor({ ...validEnv, PORT: "3047" })).toEqual([
      "GATEWAY_PORT must differ from PORT",
    ]);
  });

  it("stops start-up with a message naming ENCRYPTION_KEY when it is missing", () => {
    const env: Record<string, string> = { ...validEnv };
    delete env["ENCRYPTION_KEY"];
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/ENCRYPTION_KEY is required/);
  });

  it("treats an empty value as missing", () => {
    expect(problemsFor({ ...validEnv, ENCRYPTION_KEY: "" })).toEqual([
      "ENCRYPTION_KEY is required",
    ]);
  });

  it("names every missing required value at once", () => {
    expect(problemsFor({})).toEqual([
      "DATABASE_URL is required",
      "SESSION_SECRET is required",
      "ENCRYPTION_KEY is required",
    ]);
  });

  it.each([
    ["DATABASE_URL", "mysql://root:hunter2@localhost/db", /postgres:\/\//],
    ["DATABASE_URL", "not a url hunter2", /postgres:\/\//],
    ["SESSION_SECRET", "short-hunter2", /at least 32 characters/],
    [
      "ENCRYPTION_KEY",
      Buffer.alloc(16, 1).toString("base64"),
      /32 random bytes/,
    ],
    ["ENCRYPTION_KEY", "hunter2".repeat(10), /32 random bytes/],
    ["PORT", "eighty", /port number/],
    ["PORT", "70000", /port number/],
    ["PUBLIC_URL", "ftp://office.example.com", /http:\/\/ or https:\/\//],
    ["LOG_LEVEL", "loud", /one of/],
    ["TRUST_PROXY", "true", /hop count/],
    ["TRUST_PROXY", "0", /hop count/],
    ["TRUST_PROXY", "10.0.0.0/33", /hop count/],
    ["TRUST_PROXY", "proxy.hunter2.example", /hop count/],
    ["PROXY_SECRET", "short-hunter2", /at least 32 characters/],
    ["GITHUB_API_URL", "ftp://hunter2.example.com", /http:\/\/ or https:\/\//],
    ["GATEWAY_PORT", "gateway-hunter2", /port number/],
  ])(
    "refuses a malformed %s, naming it but not its value",
    (key, value, why) => {
      const env: Record<string, string> = { ...validEnv, [key]: value };
      let message = "";
      try {
        loadConfig(env);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(key);
      expect(message).toMatch(why);
      expect(message).not.toContain(value);
    },
  );

  it("reads another GitHub API, for GitHub Enterprise Server", () => {
    const config = loadConfig({
      ...validEnv,
      GITHUB_API_URL: "https://github.example.com/api/v3",
    });
    expect(config.githubApiUrl).toBe("https://github.example.com/api/v3");
  });

  it("names the GitHub variables it no longer reads, but not their values, and still starts: GitHub is set up in Floor Settings", () => {
    const env = {
      ...validEnv,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIE-hunter2\n-----END RSA PRIVATE KEY-----",
      GITHUB_ACCESS_TOKEN_2: "github_pat_11AAAAAAA0hunter2",
      GITHUB_READ_ONLY_ACCESS_TOKEN: "",
      // GitHub Actions' own token is not AI Office's.
      GITHUB_TOKEN: "ghs_actions",
    };
    expect(() => loadConfig(env)).not.toThrow();
    expect(retiredGitHubVariables(env)).toEqual([
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_ACCESS_TOKEN_2",
    ]);
  });
});

describe("secretValues", () => {
  it("includes each secret and the database password", () => {
    const values = secretValues(loadConfig(validEnv));
    expect(values).toEqual(
      expect.arrayContaining([
        validEnv.DATABASE_URL,
        validEnv.SESSION_SECRET,
        validEnv.ENCRYPTION_KEY,
        "db-pass-0f3a9c",
      ]),
    );
  });

  it("includes PROXY_SECRET when it is set", () => {
    expect(
      secretValues(
        loadConfig({
          ...validEnv,
          TRUST_PROXY: "1",
          PROXY_SECRET: proxySecret,
        }),
      ),
    ).toContain(proxySecret);
  });
});
