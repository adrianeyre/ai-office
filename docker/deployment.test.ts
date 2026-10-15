// Checks of the deployment files: docker-compose.yml, the Dockerfile and
// .env.example (PRD §7 Deployment). The static checks run everywhere.
// `docker compose config` needs Docker; bringing the stack up is slow, so
// it also needs AI_OFFICE_COMPOSE_E2E=1. Without Docker they are skipped
// with the reason (or, in CI, fail, so CI never passes by skipping them).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  developmentSecretsInUse,
  environmentKeys,
  loadConfig,
} from "../apps/server/src/config.ts";
import { meetsMinimum } from "./minimum-version.ts";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFile(join(root, path), "utf8");
const run = promisify(execFile);

interface ComposeService {
  image?: string;
  user?: string;
  command?: string[];
  network_mode?: string;
  build?: unknown;
  environment?: Record<string, string>;
  volumes?: string[];
  ports?: string[];
  expose?: string[];
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test: string[] };
  group_add?: string[];
  networks?: string[];
  restart?: string;
  profiles?: string[];
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
  networks?: Record<string, { name?: string; internal?: boolean }>;
}

const composeText = await read("docker-compose.yml");
const compose = parse(composeText) as ComposeFile;
const {
  postgres,
  app,
  caddy,
  "sandbox-dir": sandboxDir,
} = compose.services as {
  postgres: ComposeService;
  app: ComposeService;
  caddy: ComposeService;
  "sandbox-dir": ComposeService;
};
/**
 * What `--profile tls` runs: the stack, the sandbox relay since S2-1 (the
 * sandboxes' only way to the Gateway and the internet), and Caddy.
 */
const servicesWithTls = [
  "app",
  "caddy",
  "postgres",
  "sandbox-dir",
  "sandbox-relay",
];
/** The sandboxes' work directory, the same path on the host and in the app. */
const sandboxWorkDir = "${AI_OFFICE_SANDBOX_DIR:-${HOME}/.ai-office/sandboxes}";
const caddyfile = await read("docker/caddy/Caddyfile");
/** The Caddyfile's directives, without comments or blank lines. */
const caddyDirectives = caddyfile
  .split("\n")
  .map((line) => line.replace(/#.*$/, "").trim())
  .filter((line) => line !== "");

const envExample = await read(".env.example");
const envExampleKeys = envExample
  .split("\n")
  .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map((line) => line.slice(0, line.indexOf("=")));

/** What compose reads from the shell itself, never from `.env`. */
const fromTheShell = new Set(["HOME"]);

/** The variables docker-compose.yml interpolates, like `${POSTGRES_PASSWORD:?…}`. */
const composeVariables = [
  ...new Set(
    [...composeText.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map(
      (match) => match[1] ?? "",
    ),
  ),
].filter((name) => !fromTheShell.has(name));

describe(".env.example", () => {
  it("lists every variable the server reads", () => {
    expect(envExampleKeys).toEqual(expect.arrayContaining(environmentKeys));
  });

  it("lists every variable docker-compose.yml reads", () => {
    expect(envExampleKeys).toEqual(expect.arrayContaining(composeVariables));
  });

  it("lists nothing that nothing reads", () => {
    const read = new Set([...environmentKeys, ...composeVariables]);
    expect(envExampleKeys.filter((key) => !read.has(key))).toEqual([]);
  });

  it("lists each variable once, with no commented-out assignments", () => {
    expect(new Set(envExampleKeys).size).toBe(envExampleKeys.length);
    for (const line of envExample.split("\n")) {
      if (line === "" || line.startsWith("#")) {
        expect(line).not.toMatch(/^#\s*[A-Z][A-Z0-9_]*=\S/);
      } else {
        expect(line).toMatch(/^[A-Z][A-Z0-9_]*=/);
      }
    }
  });

  it("works for development as copied, with only the sample secrets that the server warns about", () => {
    const values = Object.fromEntries(
      envExample
        .split("\n")
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    const config = loadConfig(
      Object.fromEntries(
        Object.entries(values).filter(([, value]) => value !== ""),
      ),
    );
    expect(developmentSecretsInUse(config)).toEqual([
      "SESSION_SECRET",
      "ENCRYPTION_KEY",
      "POSTGRES_PASSWORD",
    ]);
    expect(config.port).toBe(3046);
    expect(config.gateway.port).toBe(3047);
    expect(config.publicUrl).toBe("http://localhost:3045");
    expect(new URL(config.databaseUrl).port).toBe("3048");
    expect(new URL(config.databaseUrl).password).toBe(
      values["POSTGRES_PASSWORD"],
    );
  });
});

describe("docker-compose.yml", () => {
  it("passes the Compose Specification's schema", async () => {
    const schema = JSON.parse(await read("docker/compose-spec.json")) as object;
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(schema);
    expect(validate(compose), ajv.errorsText(validate.errors)).toBe(true);
  });

  it("runs Postgres 18 with the ai_office database in a named volume", () => {
    expect(postgres.image).toMatch(/^postgres:18(\.|-|$)/);
    expect(postgres.environment?.["POSTGRES_DB"]).toBe("ai_office");
    expect(postgres.volumes).toContain("postgres-data:/var/lib/postgresql");
    expect(compose.volumes).toHaveProperty("postgres-data");
    expect(postgres.healthcheck?.test).toEqual(
      expect.arrayContaining(["pg_isready"]),
    );
    expect(postgres.ports).toBeUndefined();
  });

  it("starts the app once the database is healthy, with a health check on /health", () => {
    expect(app.build).toBe(".");
    expect(app.depends_on).toEqual({
      postgres: { condition: "service_healthy" },
      "sandbox-dir": { condition: "service_completed_successfully" },
    });
    expect(app.healthcheck?.test.join(" ")).toContain(
      "http://127.0.0.1:3045/health",
    );
    expect(app.environment?.["DATABASE_URL"]).toMatch(
      /^postgres:\/\/ai_office:\$\{POSTGRES_PASSWORD:\?[^}]*\}@postgres:3048\/ai_office$/,
    );
  });

  it("gives the app every required setting and the server's port", () => {
    for (const key of ["DATABASE_URL", "SESSION_SECRET", "ENCRYPTION_KEY"]) {
      expect(app.environment).toHaveProperty(key);
    }
    // The keys ENCRYPTION_KEY replaced, while their values are sealed
    // again with it (pen-testing G1-9).
    expect(app.environment?.["RETIRED_ENCRYPTION_KEYS"]).toBe(
      "${RETIRED_ENCRYPTION_KEYS:-}",
    );
    expect(app.environment?.["PORT"]).toBe("3045");
    expect(app.environment?.["HOST"]).toBe("0.0.0.0");
    // Nothing the server would not read.
    expect(
      Object.keys(app.environment ?? {}).filter(
        (key) => !environmentKeys.includes(key),
      ),
    ).toEqual([]);
  });

  it("tells the app where its port is published, so it refuses .env.example's secrets once that is beyond this machine (pen-testing G1-8)", () => {
    expect(app.environment?.["PUBLISHED_ADDRESS"]).toBe(
      "${AI_OFFICE_BIND_ADDRESS:-127.0.0.1}",
    );
    const values = Object.fromEntries(
      envExample
        .split("\n")
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    /** The app's environment as compose gives it from a copied `.env`. */
    const appEnvironment = (env: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(app.environment ?? {}).map(([key, value]) => [
          key,
          value.replaceAll(
            /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*)|:\?[^}]*)?\}/g,
            (_match, name: string, fallback?: string) =>
              env[name] === undefined || env[name] === ""
                ? (fallback ?? "")
                : env[name],
          ),
        ]),
      );
    // As copied: published on the host's loopback, so it runs, warning.
    const local = loadConfig(appEnvironment(values));
    expect(local.host).toBe("0.0.0.0");
    expect(local.publishedAddress).toBe("127.0.0.1");
    expect(developmentSecretsInUse(local)).toHaveLength(3);
    // Published on every interface, it refuses each sample.
    expect(() =>
      loadConfig(
        appEnvironment({ ...values, AI_OFFICE_BIND_ADDRESS: "0.0.0.0" }),
      ),
    ).toThrow(
      /SESSION_SECRET is the public sample[^]*ENCRYPTION_KEY is the public sample[^]*POSTGRES_PASSWORD \(the password in DATABASE_URL\) is the public sample[^]*\(PUBLISHED_ADDRESS\)/,
    );
  });

  it("publishes one entry point, the app (and the AI Gateway's /v1 with it), on 127.0.0.1 unless told otherwise, and ChatGPT's sign-in callback on loopback only", () => {
    expect(app.ports).toEqual([
      "${AI_OFFICE_BIND_ADDRESS:-127.0.0.1}:${AI_OFFICE_PORT:-3045}:3045",
      "127.0.0.1:1455:1455",
    ]);
    // The Gateway's own port is the sandboxes' only: exposed on the
    // compose networks, never published.
    expect(app.environment?.["GATEWAY_PORT"]).toBe("3047");
    expect(app.environment?.["GATEWAY_HOST"]).toBe("0.0.0.0");
    expect(app.expose).toEqual(["3047"]);
    expect(app.ports?.filter((port) => port.includes("3047"))).toEqual([]);
    expect(composeText).not.toContain("AI_OFFICE_GATEWAY_PORT");
  });

  it("puts sandboxes on a network of their own, with no route out, where the Gateway is sandbox-relay:3047 and neither the app nor Postgres is", () => {
    expect(compose.networks?.["sandboxes"]?.name).toBe("ai-office-sandboxes");
    expect(compose.networks?.["sandboxes"]?.internal).toBe(true);
    expect(
      compose.services["sandbox-relay"]?.environment?.["RELAY_GATEWAY"],
    ).toBe("app:3047");
    // Not the app: sandboxes reach the Gateway through the relay (S2-3).
    expect(app.networks).toEqual(["default"]);
    expect(app.environment?.["SANDBOX_NETWORK"]).toBe("ai-office-sandboxes");
    // Compose's own, whatever .env (which is for `pnpm dev`) says: the
    // relay, never the app (S2-3).
    expect(app.environment?.["SANDBOX_GATEWAY_URL"]).toBe(
      "http://sandbox-relay:3047",
    );
    expect(postgres.networks ?? ["default"]).not.toContain("sandboxes");
  });

  it("gives the app the host's Docker socket", () => {
    expect(app.volumes).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(app.group_add).toEqual(["${DOCKER_GID:-0}"]);
  });

  it("mounts the sandboxes' work directory at the same path as on the host, made for the app's node user", () => {
    expect(app.environment?.["SANDBOX_WORK_DIR"]).toBe(sandboxWorkDir);
    expect(app.volumes).toContain(`${sandboxWorkDir}:${sandboxWorkDir}`);
    // Made (if missing) and given to UID 1000 before the app starts.
    expect(sandboxDir.environment?.["SANDBOX_WORK_DIR"]).toBe(sandboxWorkDir);
    expect(sandboxDir.volumes).toEqual([`${sandboxWorkDir}:${sandboxWorkDir}`]);
    expect(sandboxDir.user).toBe("root");
    // Only a directory Docker has just made, or the app's own, never
    // through a link (pen-testing I2-4).
    expect(sandboxDir.command?.join(" ")).toContain(
      'chown -h "$$APP_UID:$$APP_GID" "$$dir"',
    );
    expect(sandboxDir.environment?.["APP_UID"]).toBe("1000");
    expect(sandboxDir.environment?.["APP_GID"]).toBe("1000");
    expect(sandboxDir.network_mode).toBe("none");
  });
});

describe("the tls profile", () => {
  it("adds Caddy, and only with --profile tls", () => {
    expect(caddy.profiles).toEqual(["tls"]);
    expect(caddy.image).toMatch(/^caddy:2(\.|-|$)/);
    // The stack itself runs as before without the profile.
    expect(app.profiles).toBeUndefined();
    expect(postgres.profiles).toBeUndefined();
  });

  it("runs Caddy beside the whole stack, the sandbox relay (pen-testing S2-1) included", () => {
    const withTls = Object.entries(compose.services)
      .filter(
        ([, service]) =>
          service.profiles === undefined || service.profiles.includes("tls"),
      )
      .map(([name]) => name)
      .sort();
    expect(withTls).toEqual(servicesWithTls);
  });

  it("publishes HTTP and HTTPS (HTTP/3 too), leaving the app on 127.0.0.1", () => {
    expect(caddy.ports).toEqual(["80:80", "443:443", "443:443/udp"]);
    expect(app.ports?.[0]).toMatch(
      /^\$\{AI_OFFICE_BIND_ADDRESS:-127\.0\.0\.1\}:/,
    );
  });

  it("serves AI_OFFICE_DOMAIN, proxying everything, the AI Gateway's /v1 included, to the app's one port", () => {
    expect(caddy.environment?.["AI_OFFICE_DOMAIN"]).toBe(
      "${AI_OFFICE_DOMAIN:-localhost}",
    );
    expect(caddyDirectives).toContain("{$AI_OFFICE_DOMAIN} {");
    const proxies = caddyDirectives.filter((line) =>
      line.startsWith("reverse_proxy"),
    );
    // One proxy for every path: no matcher keeps /v1 from the app.
    expect(proxies).toEqual(["reverse_proxy app:3045 {"]);
    expect(
      caddyDirectives.filter((line) =>
        /^(handle|route|respond|abort|@)/.test(line),
      ),
    ).toEqual([]);
    // Responses are flushed at once, so server-sent events stream.
    expect(caddyDirectives).toContain("flush_interval -1");
    // The Gateway's own port is the sandboxes', never proxied.
    expect(caddyfile).not.toMatch(/:3047\b/);
    // Certificates are automatic: no certificate files, no TLS turned off.
    expect(caddyDirectives.filter((line) => /^tls\b/.test(line))).toEqual([]);
    expect(caddyfile).not.toContain("auto_https off");
  });

  it("starts once the app is healthy, reading the Caddyfile read-only", () => {
    expect(caddy.depends_on).toEqual({
      app: { condition: "service_healthy" },
    });
    expect(caddy.volumes).toContain(
      "./docker/caddy/Caddyfile:/etc/caddy/Caddyfile:ro",
    );
    expect(caddy.restart).toBe("unless-stopped");
  });

  it("keeps certificates in named volumes, so a restart does not ask for new ones", () => {
    expect(caddy.volumes).toEqual(
      expect.arrayContaining(["caddy-data:/data", "caddy-config:/config"]),
    );
    expect(compose.volumes).toHaveProperty("caddy-data");
    expect(compose.volumes).toHaveProperty("caddy-config");
  });

  it("proves each request came through Caddy with PROXY_SECRET, which the app and Caddy share (A1-1)", () => {
    expect(caddyDirectives).toContain(
      "header_up X-AI-Office-Proxy {env.PROXY_SECRET}",
    );
    expect(caddy.environment?.["PROXY_SECRET"]).toBe("${PROXY_SECRET:-}");
    expect(app.environment?.["PROXY_SECRET"]).toBe("${PROXY_SECRET:-}");
    expect(app.environment?.["TRUST_PROXY"]).toBe("${TRUST_PROXY:-}");
  });

  it("keeps Caddy off the sandboxes' network", () => {
    expect(caddy.networks).toEqual(["default"]);
  });
});

describe("the Dockerfile", async () => {
  const dockerfile = await read("Dockerfile");
  const rootPackage = JSON.parse(await read("package.json")) as {
    devEngines: {
      runtime: { version: string };
      packageManager: { version: string };
    };
  };
  // Every folder pnpm-workspace.yaml names, as pnpm finds them.
  const workspace = parse(await read("pnpm-workspace.yaml")) as {
    packages: string[];
  };
  const workspacePackages = (
    await Promise.all(
      workspace.packages.map(async (pattern) =>
        pattern.endsWith("/*")
          ? (await readdir(join(root, pattern.slice(0, -2)))).map(
              (name) => `${pattern.slice(0, -2)}/${name}`,
            )
          : [pattern],
      ),
    )
  ).flat();

  it("pins Node and pnpm versions that package.json allows", async () => {
    const node = /^ARG NODE_VERSION=(\S+)$/m.exec(dockerfile)?.[1] ?? "";
    // pnpm is installed from docker/pnpm's lockfile (I1-5).
    const pnpm =
      (
        JSON.parse(await read("docker/pnpm/package.json")) as {
          dependencies: Record<string, string>;
        }
      ).dependencies["pnpm"] ?? "";
    expect(node).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pnpm).toMatch(/^\d+\.\d+\.\d+$/);
    expect(meetsMinimum(node, rootPackage.devEngines.runtime.version)).toBe(
      true,
    );
    expect(
      meetsMinimum(pnpm, rootPackage.devEngines.packageManager.version),
    ).toBe(true);
  });

  it("copies every workspace package's manifest before installing", () => {
    for (const folder of workspacePackages) {
      expect(dockerfile).toContain(`COPY ${folder}/package.json ${folder}/\n`);
    }
  });

  it("copies the sources of the server and every workspace package it uses", async () => {
    const used = new Set<string>();
    const visit = async (folder: string): Promise<void> => {
      used.add(folder);
      const manifest = JSON.parse(await read(`${folder}/package.json`)) as {
        dependencies?: Record<string, string>;
      };
      for (const name of Object.keys(manifest.dependencies ?? {})) {
        if (name.startsWith("@ai-office/")) {
          const dependency = `packages/${name.slice("@ai-office/".length)}`;
          if (!used.has(dependency)) {
            await visit(dependency);
          }
        }
      }
    };
    await visit("apps/server");
    for (const folder of used) {
      expect(dockerfile).toContain(`COPY ${folder}/src ${folder}/src\n`);
    }
    expect(dockerfile).toContain(
      "COPY packages/db/schema.sql packages/db/schema.sql\n",
    );
    // The built-in Floor Templates, which the server loads as it starts.
    expect(dockerfile).toContain("COPY templates templates\n");
    // The pricing table, which the AI Gateway reads as it starts.
    expect(dockerfile).toContain(
      "COPY packages/gateway/pricing.json packages/gateway/pricing.json\n",
    );
    expect(dockerfile).toContain(
      "COPY --from=build /app/apps/web/dist apps/web/dist\n",
    );
  });

  it("has git and the Docker CLI, for Agents' clones and sandboxes", () => {
    const runtime = dockerfile.slice(
      dockerfile.indexOf("FROM manifests AS runtime"),
    );
    expect(runtime).toMatch(/apt-get install[^\n]*\bgit\b/);
    expect(dockerfile).toMatch(/^ARG DOCKER_CLI_VERSION=\d+\.\d+\.\d+$/m);
    expect(dockerfile).toMatch(
      /^FROM docker:\$\{DOCKER_CLI_VERSION\}-cli@sha256:[0-9a-f]{64} AS docker-cli\n/m,
    );
    expect(runtime).toContain(
      "COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker\n",
    );
  });

  it("applies the schema before starting the server, as a user without root", () => {
    expect(dockerfile).toContain("\nUSER node\n");
    expect(dockerfile).toContain(
      'CMD ["sh", "-c", "node packages/db/src/apply-schema-cli.ts && exec node apps/server/src/main.ts"]',
    );
  });
});

// --- With Docker -------------------------------------------------------------

// The Docker CLI's compose plugin, or the standalone `docker-compose`.
const composeCommand = await (async (): Promise<string[] | string> => {
  const reasons: string[] = [];
  for (const command of [["docker", "compose"], ["docker-compose"]]) {
    const [file = "", ...args] = command;
    try {
      await run(file, [...args, "version"], { timeout: 20_000 });
      return command;
    } catch (error) {
      reasons.push(
        error instanceof Error
          ? (error.message.split("\n")[0] ?? "")
          : String(error),
      );
    }
  }
  return `Docker Compose is not available (${reasons.join("; ")})`;
})();
const dockerReason =
  typeof composeCommand === "string" ? composeCommand : undefined;
// Bringing the stack up also needs a running Docker daemon; `compose ls`
// asks it. Only checked when the end-to-end test is asked for.
const e2eReason =
  process.env["AI_OFFICE_COMPOSE_E2E"] !== "1"
    ? "AI_OFFICE_COMPOSE_E2E is not 1 (bringing the stack up builds the image and takes minutes)"
    : (dockerReason ??
      (await runCompose(["ls"], { timeout: 20_000 }).then(
        () => undefined,
        (error: unknown) =>
          `The Docker daemon is not reachable (${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)})`,
      )));

function runCompose(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer?: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  const [file = "", ...prefix] =
    typeof composeCommand === "string" ? [] : composeCommand;
  return run(file, [...prefix, ...args], { ...options, encoding: "utf8" });
}

const withDocker = (
  name: string,
  test: () => Promise<void>,
  reason: string | undefined,
  { optional = false } = {},
) => {
  if (reason === undefined) {
    it(name, test);
  } else if (process.env["CI"] && !optional) {
    it(name, () => {
      throw new Error(`${reason}. CI must run this check.`);
    });
  } else {
    // Every reporter shows this; only the verbose one shows skip notes.
    console.warn(`${reason}, so "${name}" is skipped.`);
    it.skip(`${name} [${reason}]`, test);
  }
};

// Caddy, to parse the Caddyfile: a `caddy` on the PATH, or the image the
// tls profile runs, through a running Docker daemon.
const caddyCommand = await (async (): Promise<string[] | string> => {
  try {
    await run("caddy", ["version"], { timeout: 20_000 });
    return ["caddy"];
  } catch {
    // Not installed; try Docker.
  }
  try {
    await run("docker", ["info"], { timeout: 20_000 });
    return [
      "docker",
      "run",
      "--rm",
      "--env",
      "AI_OFFICE_DOMAIN",
      "--volume",
      `${join(root, "docker/caddy/Caddyfile")}:/etc/caddy/Caddyfile:ro`,
      caddy.image ?? "caddy:2-alpine",
      "caddy",
    ];
  } catch (error) {
    return `Neither caddy nor a running Docker daemon is available (${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)})`;
  }
})();

const composeEnv = () => ({
  POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
  SESSION_SECRET: randomBytes(32).toString("hex"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
});

describe("with Docker", () => {
  withDocker(
    "docker compose config validates the file",
    async () => {
      await runCompose(["config", "--quiet"], {
        cwd: root,
        env: { ...process.env, ...composeEnv() },
        timeout: 60_000,
      });
    },
    dockerReason,
  );

  withDocker(
    "docker compose --profile tls config validates the file, with Caddy",
    async () => {
      const { stdout } = await runCompose(
        ["--profile", "tls", "config", "--format", "json"],
        {
          cwd: root,
          env: {
            ...process.env,
            ...composeEnv(),
            AI_OFFICE_DOMAIN: "ai-office.example.com",
          },
          timeout: 60_000,
        },
      );
      const resolved = JSON.parse(stdout) as ComposeFile;
      expect(Object.keys(resolved.services).sort()).toEqual(servicesWithTls);
      expect(
        resolved.services["caddy"]?.environment?.["AI_OFFICE_DOMAIN"],
      ).toBe("ai-office.example.com");
    },
    dockerReason,
  );

  withDocker(
    "Caddy reads the Caddyfile, for a domain and for localhost",
    async () => {
      if (typeof caddyCommand === "string") {
        throw new Error(caddyCommand);
      }
      const [file = "", ...prefix] = caddyCommand;
      const config =
        prefix.length === 0 ? "docker/caddy/Caddyfile" : "/etc/caddy/Caddyfile";
      for (const domain of ["ai-office.example.com", "localhost"]) {
        const { stdout } = await run(
          file,
          [...prefix, "adapt", "--config", config, "--adapter", "caddyfile"],
          {
            cwd: root,
            env: { ...process.env, AI_OFFICE_DOMAIN: domain },
            timeout: 120_000,
            encoding: "utf8",
          },
        );
        expect(stdout).toContain(`"host":["${domain}"]`);
        expect(stdout).toContain(`"dial":"app:3045"`);
        expect(stdout).toContain(`"flush_interval":-1`);
      }
    },
    typeof caddyCommand === "string" ? caddyCommand : undefined,
    // It may pull Caddy's image; the static checks above run everywhere.
    { optional: true },
  );

  // Builds the image and runs the real stack under its own project name,
  // so it never touches the Owner's own `ai-office` stack or its volume.
  withDocker(
    "docker compose up gives a healthy app and database, and keeps data across a restart",
    async () => {
      const project = `ai-office-e2e-${randomBytes(4).toString("hex")}`;
      const freePort = () =>
        new Promise<number>((resolve) => {
          const probe = createServer().listen(0, "127.0.0.1", () => {
            const { port: free } = probe.address() as AddressInfo;
            probe.close(() => {
              resolve(free);
            });
          });
        });
      const port = await freePort();
      const env = {
        ...process.env,
        ...composeEnv(),
        AI_OFFICE_PORT: String(port),
        // Clear of the Owner's own stack's sandboxes.
        AI_OFFICE_SANDBOX_DIR: join(tmpdir(), `${project}-sandboxes`),
      };
      const compose = (...args: string[]) =>
        runCompose(["--project-name", project, ...args], {
          cwd: root,
          env,
          timeout: 900_000,
          maxBuffer: 64 * 1024 * 1024,
        });
      const sql = async (query: string) =>
        (
          await compose(
            "exec",
            "-T",
            "postgres",
            "psql",
            "--username=ai_office",
            "--dbname=ai_office",
            "--tuples-only",
            "--no-align",
            "--command",
            query,
          )
        ).stdout.trim();

      try {
        await compose(
          "up",
          "--build",
          "--detach",
          "--wait",
          "--wait-timeout",
          "600",
        );
        const health = await fetch(`http://127.0.0.1:${String(port)}/health`);
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({ status: "ok", database: "up" });
        const page = await fetch(`http://127.0.0.1:${String(port)}/notices`);
        expect(await page.text()).toContain('<div id="root">');
        // The AI Gateway, on the same port: a key is required.
        const gateway = await fetch(
          `http://127.0.0.1:${String(port)}/v1/messages`,
          { method: "POST", body: "{}" },
        );
        expect(gateway.status).toBe(401);
        // git and the Docker CLI, for Agents' clones and sandboxes.
        await compose("exec", "-T", "app", "git", "--version");
        await compose("exec", "-T", "app", "docker", "--version");
        // The schema was applied on start.
        expect(
          await sql("SELECT value FROM schema_meta WHERE key = 'application'"),
        ).toBe("ai-office");

        await sql(
          "INSERT INTO schema_meta (key, value) VALUES ('compose-e2e', 'kept')",
        );
        await compose("down");
        await compose("up", "--detach", "--wait", "--wait-timeout", "300");

        expect(
          await sql("SELECT value FROM schema_meta WHERE key = 'compose-e2e'"),
        ).toBe("kept");
        const again = await fetch(`http://127.0.0.1:${String(port)}/health`);
        expect(again.status).toBe(200);
      } finally {
        await compose("down", "--volumes", "--remove-orphans");
      }
    },
    e2eReason,
    // Opt-in, so CI (which does not opt in) skips it rather than failing.
    { optional: true },
  );
});
