// Static checks of the pen-test stack (docs/pen-testing/stack.md):
// docker/pen-test/compose.yml against the real stack's docker-compose.yml
// (and the development Postgres's docker-compose.dev.yml), and its
// .env.example. A separate project name, volume and networks; no secret,
// and no variable, shared with the real stack; the app on loopback
// unless told otherwise; the stub upstream as the AI Accounts' endpoint.
// `docker compose config` needs Docker: without it, it is skipped with
// the reason (or, in CI, fails).
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { environmentKeys } from "../../apps/server/src/config.ts";
import {
  generatedSecrets,
  image,
  ownerSettings,
  postgresVolume,
  projectName,
  sandboxNetwork,
} from "./stack.ts";
import { stubAccounts, stubUpstreamUrl } from "./stub-accounts.ts";

const root = join(import.meta.dirname, "../..");
const read = (path: string) => readFile(join(root, path), "utf8");

interface ComposeService {
  image?: string;
  build?: unknown;
  user?: string;
  entrypoint?: string[];
  command?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  ports?: string[];
  expose?: string[];
  depends_on?: Record<string, { condition: string }>;
  networks?: string[];
  profiles?: string[];
  pull_policy?: string;
  read_only?: boolean;
}

interface ComposeFile {
  name?: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, { name?: string; external?: boolean } | null>;
  networks?: Record<
    string,
    { name?: string; external?: boolean; internal?: boolean } | null
  >;
}

const penTestText = await read("docker/pen-test/compose.yml");
const penTest = parse(penTestText) as ComposeFile;
const realText = await read("docker-compose.yml");
const real = parse(realText) as ComposeFile;
const development = parse(await read("docker-compose.dev.yml")) as ComposeFile;
const service = (name: string): ComposeService => {
  const found = penTest.services[name];
  if (found === undefined) {
    throw new Error(`compose.yml has no ${name} service`);
  }
  return found;
};
const app = service("app");
const postgres = service("postgres");
const stub = service("stub-upstream");
const aiAccounts = service("ai-accounts");
const seedService = service("seed");
const credentialsService = service("credentials");

/** The variables a compose file interpolates, like `${FOO:-…}`. */
const variablesIn = (text: string) => [
  ...new Set(
    [...text.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((match) => match[1]),
  ),
];
const penTestVariables = variablesIn(penTestText);

/** The names Docker gives a file's volumes and networks. */
const dockerNames = (
  file: ComposeFile,
  kind: "volumes" | "networks",
  project: string,
): string[] => {
  const declared = Object.entries(file[kind] ?? {}).map(
    ([key, value]) => value?.name ?? `${project}_${key}`,
  );
  return kind === "networks" ? [...declared, `${project}_default`] : declared;
};

const envExampleText = await read("docker/pen-test/.env.example");
const envExample = envExampleText
  .split("\n")
  .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map((line) => ({
    key: line.slice(0, line.indexOf("=")),
    value: line.slice(line.indexOf("=") + 1),
  }));
const stackText = await read("docker/pen-test/stack.ts");

describe("the pen-test stack's compose file", () => {
  it("passes the Compose Specification's schema", async () => {
    const schema = JSON.parse(await read("docker/compose-spec.json")) as object;
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(schema);
    expect(validate(penTest), ajv.errorsText(validate.errors)).toBe(true);
  });

  it("has a project name of its own", () => {
    expect(penTest.name).toBe(projectName);
    expect(penTest.name).not.toBe(real.name);
    expect(penTest.name).not.toBe(development.name);
  });

  it("keeps Postgres's data in a volume of its own, which no other stack names", () => {
    expect(postgres.image).toMatch(/^postgres:18(\.|-|$)/);
    expect(postgres.volumes).toEqual(["postgres-data:/var/lib/postgresql"]);
    expect(penTest.volumes?.["postgres-data"]?.name).toBe(postgresVolume);
    const ours = dockerNames(penTest, "volumes", projectName);
    expect(ours).toEqual([postgresVolume]);
    for (const [other, project] of [
      [real, "ai-office"],
      [development, "ai-office-dev"],
    ] as const) {
      const theirs = dockerNames(other, "volumes", project);
      expect(ours.filter((name) => theirs.includes(name))).toEqual([]);
    }
    // Teardown removes them, so none is another stack's.
    for (const value of Object.values(penTest.volumes ?? {})) {
      expect(value?.external).toBeUndefined();
    }
    expect(postgres.ports).toBeUndefined();
  });

  it("puts sandboxes on a network of its own, with no route out, which Postgres and the stub upstream are not on", () => {
    expect(penTest.networks?.["sandboxes"]?.name).toBe(sandboxNetwork);
    expect(penTest.networks?.["sandboxes"]).toMatchObject({ internal: true });
    expect(app.environment?.["SANDBOX_NETWORK"]).toBe(sandboxNetwork);
    // As in the real stack, through the sandbox relay.
    expect(app.environment?.["SANDBOX_GATEWAY_URL"]).toBe(
      "http://sandbox-relay:3047",
    );
    expect(service("sandbox-relay").environment?.["RELAY_GATEWAY"]).toBe(
      "app:3047",
    );
    expect(app.networks).toEqual(["default"]);
    for (const other of [app, postgres, stub, aiAccounts]) {
      expect(other.networks ?? ["default"]).not.toContain("sandboxes");
    }
    const ours = dockerNames(penTest, "networks", projectName);
    const theirs = dockerNames(real, "networks", "ai-office");
    expect(ours.filter((name) => theirs.includes(name))).toEqual([]);
    expect(ours).not.toContain("ai-office-sandboxes");
  });

  it("has a sandbox work directory of its own, at the same path in the app as on the host", () => {
    expect(app.environment?.["SANDBOX_WORK_DIR"]).toBe(
      "${PEN_TEST_SANDBOX_WORK_DIR:?run docker/pen-test/stand-up}",
    );
    expect(app.volumes).toContain(
      "${PEN_TEST_SANDBOX_WORK_DIR:?run docker/pen-test/stand-up}:${PEN_TEST_SANDBOX_WORK_DIR:?run docker/pen-test/stand-up}",
    );
    expect(realText).not.toContain("PEN_TEST_SANDBOX_WORK_DIR");
  });

  it("builds the app as an image of its own, never the Owner's ai-office:local", () => {
    expect(app.build).toBe("../..");
    expect(app.image).toBe(image);
    expect(real.services["app"]?.image).not.toBe(image);
    expect(aiAccounts.image).toBe(image);
    expect(aiAccounts.pull_policy).toBe("never");
  });
});

describe("no secret shared with the real stack", () => {
  it("reads only PEN_TEST_ variables, so none of the real stack's is ever read", () => {
    expect(penTestVariables.length).toBeGreaterThan(0);
    for (const variable of penTestVariables) {
      expect(variable).toMatch(/^PEN_TEST_/);
    }
    const realVariables = variablesIn(realText);
    expect(
      penTestVariables.filter((name) => realVariables.includes(name)),
    ).toEqual([]);
  });

  it("takes every secret from its own variable, required, with no default", () => {
    const secrets = {
      SESSION_SECRET: "PEN_TEST_SESSION_SECRET",
      ENCRYPTION_KEY: "PEN_TEST_ENCRYPTION_KEY",
    };
    for (const [key, variable] of Object.entries(secrets)) {
      expect(app.environment?.[key]).toMatch(
        new RegExp(`^\\$\\{${variable}:\\?[^}]*\\}$`),
      );
    }
    // The GitHub App is the seed's to add to the database (ADR 0011): the
    // app reads none from its environment.
    const githubApp = {
      GITHUB_APP_ID: "PEN_TEST_GITHUB_APP_ID",
      GITHUB_APP_PRIVATE_KEY: "PEN_TEST_GITHUB_APP_PRIVATE_KEY",
    };
    for (const [key, variable] of Object.entries(githubApp)) {
      expect(app.environment?.[key]).toBeUndefined();
      expect(seedService.environment?.[key]).toMatch(
        new RegExp(`^\\$\\{${variable}:\\?[^}]*\\}$`),
      );
    }
    for (const environment of [app.environment, aiAccounts.environment]) {
      expect(environment?.["DATABASE_URL"]).toMatch(
        /^postgres:\/\/ai_office:\$\{PEN_TEST_POSTGRES_PASSWORD:\?[^}]*\}@postgres:3048\/ai_office$/,
      );
    }
    expect(aiAccounts.environment?.["ENCRYPTION_KEY"]).toBe(
      app.environment?.["ENCRYPTION_KEY"],
    );
    expect(postgres.environment?.["POSTGRES_PASSWORD"]).toMatch(
      /^\$\{PEN_TEST_POSTGRES_PASSWORD:\?[^}]*\}$/,
    );
  });

  it("holds none of the root .env.example's values, nor any other secret", async () => {
    // The root .env.example is set for development: besides its sample
    // secrets it sets these addresses, names and paths, which hold no
    // secret and which the pen-test stack may share (127.0.0.1, the
    // sandbox relay's name). Every other value, a new one too, is checked.
    const notSecret = new Set([
      "AI_OFFICE_BIND_ADDRESS",
      "AI_OFFICE_DOMAIN",
      "AI_OFFICE_SANDBOX_DIR",
      "HOST",
      "PUBLIC_URL",
      "GATEWAY_HOST",
      "OAUTH_CALLBACK_HOST",
      "SANDBOX_GATEWAY_URL",
      "SANDBOX_NETWORK",
      "SANDBOX_EGRESS_HOSTS",
      "GITHUB_API_URL",
    ]);
    const rootExample = (await read(".env.example"))
      .split("\n")
      .filter((line) => /^[A-Z][A-Z0-9_]*=./.test(line))
      .map((line) => ({
        key: line.slice(0, line.indexOf("=")),
        value: line.slice(line.indexOf("=") + 1),
      }))
      .filter(({ key }) => !notSecret.has(key));
    expect(rootExample.map(({ key }) => key)).toEqual(
      expect.arrayContaining([
        "SESSION_SECRET",
        "ENCRYPTION_KEY",
        "POSTGRES_PASSWORD",
        "DATABASE_URL",
      ]),
    );
    for (const { value } of rootExample.filter(
      ({ value }) => value.length >= 8,
    )) {
      expect(penTestText).not.toContain(value);
    }
    expect(penTestText).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });

  it("has an .env.example with every value empty, and an .env that git ignores", async () => {
    expect(envExample.length).toBeGreaterThan(0);
    for (const { key, value } of envExample) {
      expect({ key, value }).toEqual({ key, value: "" });
    }
    const gitignore = (await read(".gitignore")).split("\n");
    // `.env` at any depth, `.env.example` at any depth kept.
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("!.env.example");
  });

  it("names in .env.example every variable compose and stand-up read, and nothing else", () => {
    const keys = envExample.map(({ key }) => key);
    expect(new Set(keys).size).toBe(keys.length);
    const readByStack = [
      ...new Set(
        [...stackText.matchAll(/"(PEN_TEST_[A-Z0-9_]+)"/g)].map(
          (match) => match[1],
        ),
      ),
    ];
    const read = new Set([...penTestVariables, ...readByStack]);
    expect([...read].sort()).toEqual([...keys].sort());
    for (const key of [...Object.keys(generatedSecrets), ...ownerSettings]) {
      expect(keys).toContain(key);
    }
  });

  it("gives the app nothing the server would not read", () => {
    expect(
      Object.keys(app.environment ?? {}).filter(
        (key) => !environmentKeys.includes(key),
      ),
    ).toEqual([]);
  });
});

describe("reach", () => {
  it("publishes only the app, on 127.0.0.1 unless told otherwise, on a port the real stack does not use", () => {
    expect(app.ports).toEqual([
      "${PEN_TEST_BIND_ADDRESS:-127.0.0.1}:${PEN_TEST_PORT:-3145}:3045",
    ]);
    for (const [name, other] of Object.entries(penTest.services)) {
      if (name !== "app") {
        expect({ name, ports: other.ports }).toEqual({
          name,
          ports: undefined,
        });
      }
    }
    // The AI Gateway and the sign-in callback stay inside.
    expect(app.ports?.join(" ")).not.toMatch(/:(3047|1455)\b/);
    expect(app.expose).toEqual(["3047"]);
    expect(real.services["app"]?.ports?.[0]).toMatch(/:-3045\}:3045$/);
  });
});

describe("the stub upstream", () => {
  it("runs stub-upstream.ts, read-only, from the pinned Node image, on 3050", () => {
    // The app image's Node, by the same digest (I1-4).
    expect(stub.image).toBe(
      "node:26.10.0-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33",
    );
    expect(stub.command).toEqual(["node", "/stub/stub-upstream.ts"]);
    expect(stub.volumes).toEqual([
      "./stub-upstream.ts:/stub/stub-upstream.ts:ro",
    ]);
    expect(stub.read_only).toBe(true);
    expect(stub.user).toBe("node");
    expect(stub.environment?.["STUB_UPSTREAM_PORT"]).toBe("3050");
    expect(new URL(stubUpstreamUrl).hostname).toBe("stub-upstream");
    expect(new URL(stubUpstreamUrl).port).toBe("3050");
  });

  it("is the endpoint of every AI Account the stack adds", () => {
    expect(aiAccounts.environment?.["STUB_UPSTREAM_URL"]).toBe(stubUpstreamUrl);
    for (const { request } of stubAccounts(stubUpstreamUrl, () => "x")) {
      expect(request.endpointUrl?.startsWith(`${stubUpstreamUrl}/`)).toBe(true);
    }
  });

  it("is added as the AI Accounts after the schema is applied, before the app starts, once", () => {
    expect(aiAccounts.profiles).toEqual(["setup"]);
    expect(aiAccounts.command?.join(" ")).toMatch(
      /node packages\/db\/src\/apply-schema-cli\.ts && node docker\/pen-test\/add-ai-accounts\.ts$/,
    );
    expect(aiAccounts.volumes).toEqual([
      "./add-ai-accounts.ts:/app/docker/pen-test/add-ai-accounts.ts:ro",
      "./stub-accounts.ts:/app/docker/pen-test/stub-accounts.ts:ro",
    ]);
    expect(aiAccounts.depends_on).toEqual({
      postgres: { condition: "service_healthy" },
      "stub-upstream": { condition: "service_healthy" },
    });
    expect(app.depends_on).toHaveProperty("stub-upstream");
  });

  it("seeds the fixtures in the setup profile, pointed at the stub, reading only PEN_TEST_ variables", () => {
    // The seed (E2, #188) is a one-off `setup` service, like ai-accounts.
    expect(seedService.profiles).toEqual(["setup"]);
    expect(seedService.pull_policy).toBe("never");
    expect(seedService.command).toEqual([
      "node",
      "docker/pen-test/seed-cli.ts",
    ]);
    // It holds no AI Account credential: its AI Accounts point at the stub.
    expect(seedService.environment?.["STUB_UPSTREAM_URL"]).toBe(
      stubUpstreamUrl,
    );
    // Every variable its environment interpolates is a PEN_TEST_ one.
    for (const value of Object.values(seedService.environment ?? {})) {
      for (const [, variable] of value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)) {
        expect(variable).toMatch(/^PEN_TEST_/);
      }
    }
    // It writes the fixture ID listing into the sandbox work directory, so it
    // lands at the same path on the host.
    expect(seedService.environment?.["FIXTURES_FILE"]).toContain(
      "${PEN_TEST_SANDBOX_WORK_DIR",
    );
    expect(seedService.volumes).toContain(
      "${PEN_TEST_SANDBOX_WORK_DIR:?run docker/pen-test/stand-up}:${PEN_TEST_SANDBOX_WORK_DIR:?run docker/pen-test/stand-up}",
    );
    expect(seedService.depends_on).toEqual({
      postgres: { condition: "service_healthy" },
      "stub-upstream": { condition: "service_healthy" },
    });
  });

  it("lets nothing else in the stack hold an AI Account credential", () => {
    for (const [name, other] of Object.entries(penTest.services)) {
      const keys = Object.keys(other.environment ?? {});
      expect({
        name,
        keys: keys.filter((key) =>
          /API_KEY|AUTH_TOKEN|OPENAI|ANTHROPIC/.test(key),
        ),
      }).toEqual({ name, keys: [] });
    }
  });
});

describe("the credentials package's service", () => {
  it("mints and revokes in the setup profile, as the user who stood the stack up", () => {
    expect(credentialsService.profiles).toEqual(["setup"]);
    expect(credentialsService.image).toBe(image);
    expect(credentialsService.pull_policy).toBe("never");
    expect(credentialsService.user).toBe(
      "${PEN_TEST_UID:-1000}:${PEN_TEST_GID:-1000}",
    );
    expect(credentialsService.entrypoint).toEqual([
      "node",
      "docker/pen-test/credentials-cli.ts",
    ]);
    expect(credentialsService.command).toEqual(["mint"]);
    expect(credentialsService.depends_on).toEqual({
      postgres: { condition: "service_healthy" },
    });
    expect(credentialsService.ports).toBeUndefined();
    expect(credentialsService.networks).toEqual(["default"]);
  });

  it("is given the database and where to write, and none of the stack's other secrets", () => {
    expect(Object.keys(credentialsService.environment ?? {}).sort()).toEqual([
      "DATABASE_URL",
      "FIXTURES_FILE",
      "PACKAGE_FILE",
      "PUBLIC_URL",
    ]);
    const text = JSON.stringify(credentialsService);
    for (const secret of [
      "ENCRYPTION_KEY",
      "SESSION_SECRET",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
    ]) {
      expect(text).not.toContain(secret);
    }
    for (const value of Object.values(credentialsService.environment ?? {})) {
      for (const [, variable] of value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)) {
        expect(variable).toMatch(/^PEN_TEST_/);
      }
    }
  });

  it("alone mounts the credentials directory, so neither the app nor a sandbox reaches the package", () => {
    expect(credentialsService.environment?.["PACKAGE_FILE"]).toBe(
      "/credentials/credentials-package.json",
    );
    expect(credentialsService.volumes).toEqual([
      "./credentials.ts:/app/docker/pen-test/credentials.ts:ro",
      "./credentials-cli.ts:/app/docker/pen-test/credentials-cli.ts:ro",
      "${PEN_TEST_CREDENTIALS_DIR:?run docker/pen-test/stand-up}:/credentials",
      // The seed's fixture ID listing, read-only.
      "${PEN_TEST_SANDBOX_WORK_DIR:?run docker/pen-test/stand-up}:/work:ro",
    ]);
    expect(credentialsService.environment?.["FIXTURES_FILE"]).toBe(
      "/work/pen-test-fixtures.json",
    );
    for (const [name, other] of Object.entries(penTest.services)) {
      if (name !== "credentials") {
        expect(JSON.stringify(other.volumes ?? []), name).not.toContain(
          "PEN_TEST_CREDENTIALS_DIR",
        );
      }
    }
    expect(realText).not.toContain("PEN_TEST_CREDENTIALS_DIR");
  });
});

// --- With Docker -------------------------------------------------------------

const run = promisify(execFile);
const dockerReason = await run("docker", ["compose", "version"], {
  timeout: 20_000,
}).then(
  () => undefined,
  (error: unknown) =>
    `Docker Compose is not available (${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)})`,
);

/**
 * What `docker compose config` is given in place of the stand-up's .env:
 * a stand-in for every variable the file requires (`${NAME:?…}`), the
 * Owner's target repository (the seed's, E2) among them.
 */
const configEnvironment: Record<string, string> = {
  PEN_TEST_POSTGRES_PASSWORD: "0",
  PEN_TEST_SESSION_SECRET: "0",
  PEN_TEST_ENCRYPTION_KEY: "0",
  PEN_TEST_GITHUB_APP_ID: "0",
  PEN_TEST_GITHUB_APP_PRIVATE_KEY: "0",
  PEN_TEST_TARGET_REPOSITORY: "owner/pen-test-target",
  PEN_TEST_SANDBOX_WORK_DIR: "/tmp/pen-test-config",
  PEN_TEST_CREDENTIALS_DIR: "/tmp/pen-test-config-credentials",
};

describe("docker compose config's stand-ins", () => {
  it("set every variable the compose file requires, and nothing else", () => {
    const required = [
      ...new Set(
        [...penTestText.matchAll(/\$\{([A-Z_][A-Z0-9_]*):\?/g)].map(
          (match) => match[1] ?? "",
        ),
      ),
    ].sort();
    expect(required).toContain("PEN_TEST_TARGET_REPOSITORY");
    expect(Object.keys(configEnvironment).sort()).toEqual(required);
  });
});

describe("with Docker", () => {
  const name = "docker compose config validates the pen-test stack";
  const test = async () => {
    await run(
      "docker",
      [
        "compose",
        "--file",
        join(root, "docker/pen-test/compose.yml"),
        "--profile",
        "setup",
        "config",
        "--quiet",
      ],
      {
        env: { ...process.env, ...configEnvironment },
        timeout: 60_000,
      },
    );
  };
  if (dockerReason === undefined) {
    it(name, test);
  } else if (process.env["CI"]) {
    it(name, () => {
      throw new Error(`${dockerReason}. CI must run this check.`);
    });
  } else {
    console.warn(`${dockerReason}, so "${name}" is skipped.`);
    it.skip(`${name} [${dockerReason}]`, test);
  }
});
