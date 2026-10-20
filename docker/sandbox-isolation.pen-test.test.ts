import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { loadConfig } from "../apps/server/src/config.ts";
import { dockerToolRunner } from "../packages/orchestrator/src/models/agent-tool-client.ts";
import {
  allowedEnvironment,
  proxyEnvironment,
  sandboxRelayProxy,
} from "../packages/orchestrator/src/sandbox/environment.ts";
import { dockerSandbox } from "../packages/orchestrator/src/sandbox/runner.ts";
import { isForbiddenAddress } from "./sandbox-relay/relay.ts";

// Probe S2 (pen-testing, "Sandbox and host isolation"): what a sandbox
// (position 3) can reach on the network. Sandboxes are containers the host's
// Docker starts on SANDBOX_NETWORK (`ai-office-sandboxes` under compose,
// Docker's default bridge outside it), so what they reach is decided by
// docker-compose.yml, the server's listen addresses (`loadConfig`) and, on
// EC2, docs/processes/deploying-to-ec2.md. There is no Docker here, so this
// reads those files and drives `loadConfig` with compose's own
// environment; the run flags each sandbox is started with are probed in
// packages/orchestrator/src/sandbox/docker-run.pen-test.test.ts, and the
// OAuth callback listener in apps/server/src/ai-accounts/. Since S2-1 a
// sandbox is on an internal network with the sandbox relay, and since S2-5
// (ADR 0006) that network is its own, so S2-5 also drives the real
// runners against a stand-in `docker`. See
// docs/pen-testing/assessments/S2.md.

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFile(join(root, path), "utf8");

interface ComposeService {
  image?: string;
  network_mode?: string;
  command?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  extra_hosts?: string[];
  ports?: string[];
  networks?: string[];
}

interface ComposeFile {
  name?: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, { name?: string } | null>;
  networks?: Record<
    string,
    {
      name?: string;
      internal?: boolean;
      driver_opts?: Record<string, string>;
    }
  >;
}

const composeText = await read("docker-compose.yml");
const compose = parse(composeText) as ComposeFile;
const devCompose = parse(await read("docker-compose.dev.yml")) as ComposeFile;
const penTestCompose = parse(
  await read("docker/pen-test/compose.yml"),
) as ComposeFile;
/** Every compose file AI Office ships that starts sandboxes, by path. */
const composeFiles = {
  "docker-compose.yml": compose,
  "docker-compose.dev.yml": devCompose,
  "docker/pen-test/compose.yml": penTestCompose,
};
const ec2 = await read("docs/processes/deploying-to-ec2.md");
const sandboxes = compose.networks?.["sandboxes"];
const { app, postgres, caddy } = compose.services as Record<
  "app" | "postgres" | "caddy",
  ComposeService
>;

/** Fake values for the secrets compose interpolates; the rest unset. */
const fakeSecrets: Record<string, string> = {
  DATABASE_URL: "postgres://ai_office:fake-pen-test@postgres:3048/ai_office",
  SESSION_SECRET: "fake-pen-test-session-secret-00000000000",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

/** The server's configuration as compose starts the app container. */
const composeConfig = () =>
  loadConfig(
    Object.fromEntries(
      Object.entries(app.environment ?? {}).map(([key, value]) => [
        key,
        value.includes("${") ? fakeSecrets[key] : value,
      ]),
    ),
  );

/** Whether the app container is on the sandboxes' network. */
const appOnSandboxes = () => app.networks?.includes("sandboxes") === true;

const everyInterface = (host: string) =>
  host === "0.0.0.0" || host === "::" || host === "";

describe("S2-1: egress from a sandbox (H2)", () => {
  it("a sandbox can reach nothing beyond the stack: its network has no route out", () => {
    expect(sandboxes?.internal).toBe(true);
  });

  it("regression (S2-1): ai-office-sandboxes is no longer an ordinary bridge network with a route out, and sandboxes' egress goes through the sandbox relay's allow-list", () => {
    expect(sandboxes?.name).toBe("ai-office-sandboxes");
    expect(sandboxes?.internal).not.toBeUndefined();
    expect(sandboxes?.internal).toBe(true);
    // The only proxy a sandbox is given is the relay, set by AI Office
    // over whatever the Docker CLI injects; a repository (or the app's own
    // environment) cannot point a sandbox elsewhere.
    expect(
      Object.values(
        allowedEnvironment({
          HTTPS_PROXY: "http://attacker.example:3128",
          https_proxy: "http://sandbox-relay:3128.attacker.example",
          HTTP_PROXY: "http://attacker.example",
          NO_PROXY: "* ",
        }),
      ),
    ).toEqual([]);
    expect(
      Object.entries(proxyEnvironment("http://sandbox-relay:3047")).filter(
        ([key, value]) =>
          /proxy$/i.test(key) &&
          !/^no_proxy$/i.test(key) &&
          value !== sandboxRelayProxy,
      ),
    ).toEqual([]);
    // The relay: the one way out, to the hosts SANDBOX_EGRESS_HOSTS names.
    const relay = compose.services["sandbox-relay"];
    expect(relay?.networks).toEqual(["default", "sandboxes"]);
    expect(relay?.environment?.["SANDBOX_EGRESS_HOSTS"]).toBe(
      "${SANDBOX_EGRESS_HOSTS:-}",
    );
    expect(composeText).toMatch(/egress/i);
  });

  // Since S2-5 each sandbox joins a network of its own, made internal as
  // ai-office-sandboxes is, which the relay on ai-office-sandboxes joins.
  it("regression (S2-1): sandboxes no longer join Docker's default bridge: they join internal networks beside ai-office-sandboxes, or, under pnpm dev, ai-office-dev-sandboxes, which docker-compose.dev.yml makes internal, with the sandbox relay", () => {
    const config = loadConfig(fakeSecrets);
    expect(config.sandboxes.network).not.toBeUndefined();
    expect(config.sandboxes.network).toBe("ai-office-sandboxes");
    expect(devCompose.networks?.["sandboxes"]).toEqual({
      name: "ai-office-dev-sandboxes",
      internal: true,
      driver_opts: { "com.docker.network.bridge.enable_icc": "false" },
    });
    expect(
      devCompose.services["server"]?.environment?.["SANDBOX_NETWORK"],
    ).toBe("ai-office-dev-sandboxes");
    const relay = devCompose.services["sandbox-relay"];
    expect(relay?.networks).toEqual(["default", "sandboxes"]);
    // It reaches the Gateway's own port on the dev server, and only that.
    expect(relay?.environment?.["RELAY_GATEWAY"]).toBe("server:3047");
    expect(relay?.extra_hosts).toBeUndefined();
  });

  // pnpm dev may run beside a docker-compose.yml stack on one machine: each
  // server finds the relay on its own SANDBOX_NETWORK and sweeps only the
  // sandboxes' networks labelled with it, so the two must never share one.
  it("holds: the development stack's sandbox network, project and volumes are never docker-compose.yml's", () => {
    expect(devCompose.networks?.["sandboxes"]?.name).not.toBe(sandboxes?.name);
    expect(devCompose.name).not.toBe(compose.name);
    expect(
      Object.values(devCompose.volumes ?? {}).filter(
        (volume) => volume?.name !== undefined,
      ),
    ).toEqual([]);
  });

  it("sibling (S2-1): every compose file that starts sandboxes makes their network internal, and puts the sandbox relay on it, from the Node image, read-only and with no capabilities", () => {
    for (const [path, file] of Object.entries(composeFiles)) {
      expect(file.networks?.["sandboxes"]?.internal, path).toBe(true);
      const relay = file.services["sandbox-relay"] as ComposeService & {
        read_only?: boolean;
        cap_drop?: string[];
        security_opt?: string[];
        user?: string;
      };
      expect(relay, path).toBeDefined();
      // The Node image the stack already uses, pinned by digest beside its
      // tag as every image is (I1-4).
      expect(relay.image, path).toMatch(
        /^node:26\.10\.0-slim@sha256:[0-9a-f]{64}$/,
      );
      expect(relay.command, path).toEqual(["node", "/relay/relay.ts"]);
      expect(relay.volumes?.[0], path).toMatch(
        /^(\.\/docker|\.\.)\/sandbox-relay\/relay\.ts:\/relay\/relay\.ts:ro$/,
      );
      expect(relay.networks, path).toEqual(["default", "sandboxes"]);
      expect(relay.user, path).toBe("node");
      expect(relay.read_only, path).toBe(true);
      expect(relay.cap_drop, path).toEqual(["ALL"]);
      expect(relay.security_opt, path).toEqual(["no-new-privileges:true"]);
      // It publishes nothing: only sandboxes reach it.
      expect(relay.ports, path).toBeUndefined();
    }
    expect(
      penTestCompose.services["sandbox-relay"]?.environment?.[
        "SANDBOX_EGRESS_HOSTS"
      ],
    ).toBe("${PEN_TEST_SANDBOX_EGRESS_HOSTS:-}");
  });

  it("sibling (S2-1): sandboxes reach the AI Gateway through the sandbox relay, under compose and outside it, in every document that says where", async () => {
    expect(composeText).toContain("http://sandbox-relay:3047");
    expect(
      penTestCompose.services["app"]?.environment?.["SANDBOX_GATEWAY_URL"],
    ).toBe("http://sandbox-relay:3047");
    for (const path of [
      ".env.example",
      "docs/guide/running.md",
      "docs/guide/issue-pipeline.md",
      "docs/processes/deploying-to-ec2.md",
      "site/index.html",
    ]) {
      const text = await read(path);
      expect(text, path).toContain("http://sandbox-relay:3047");
      expect(text, path).not.toMatch(
        /SANDBOX_GATEWAY_URL=http:\/\/(host\.docker\.internal|172\.17\.0\.1|app):3047/,
      );
    }
  });
});

describe("S2-2: the instance metadata service on the documented EC2 set-up (H2)", () => {
  it("the documented EC2 set-up keeps sandboxes from the instance metadata service (a hop limit of 1, or a block)", () => {
    expect(ec2).toMatch(
      /hop limit[^.\n]*\b1\b|HttpPutResponseHopLimit=1|169\.254\.169\.254/i,
    );
  });

  it("regression (S2-2): it still picks Ubuntu 24.04, IMDSv2 only and an IAM role on the instance, but no longer leaves the hop limit at the AMI's default: it sets 1", () => {
    expect(ec2).toContain("**AMI:** Ubuntu Server 24.04 LTS");
    expect(ec2).toMatch(
      /Metadata version:\*\* \*\*V2 only \(token\s+required\)\*\*, and \*\*Metadata response hop limit:\*\* \*\*1\*\*/,
    );
    expect(ec2).toMatch(/hop limit|HopLimit/i);
    // No hop limit but 1 anywhere in it.
    expect(
      [...ec2.matchAll(/hop[- ]limit[^0-9\n]*(\d+)/gi)].map(
        (match) => match[1],
      ),
    ).toEqual(expect.arrayContaining(["1"]));
    expect(ec2).not.toMatch(/hop[- ]limit[^0-9\n]*\b[2-9]\b(?! hops?)/i);
    // The role is still there, for the host's own backups.
    expect(ec2).toMatch(/give the instance an IAM role that\s+can write to it/);
  });

  it("sibling (S2-2): an instance launched before, or another way, is given the same hop limit, and the document says how to check it", () => {
    expect(ec2).toContain(
      "aws ec2 modify-instance-metadata-options --instance-id <instance-id> \\\n  --http-tokens required --http-put-response-hop-limit 1 --http-endpoint enabled",
    );
    expect(ec2).toContain('"HttpPutResponseHopLimit": 1');
    // The backups use the role from the host, never from a container.
    expect(ec2).toMatch(
      /install the AWS CLI on the\s+instance itself, never in a container/,
    );
  });

  it("sibling (S2-2): whatever hop limit an instance has, a sandbox's network has no route to 169.254.169.254, and the sandbox relay refuses it, by address or by a name that resolves to it", () => {
    for (const [path, file] of Object.entries(composeFiles)) {
      expect(file.networks?.["sandboxes"]?.internal, path).toBe(true);
    }
    for (const address of [
      "169.254.169.254",
      "fd00:ec2::254",
      "::ffff:169.254.169.254",
      "169.254.170.2",
    ]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
    expect(ec2).toContain("169.254.169.254");
  });

  it("holds: IMDSv1 is off in the documented set-up, so a metadata request without a token is refused", () => {
    expect(ec2).toMatch(/V2 only \(token\s+required\)/);
  });
});

describe("S2-3: reach into the stack (H3, H14)", () => {
  it("on the sandboxes' network the app answers only as the AI Gateway", () => {
    for (const [path, file] of Object.entries(composeFiles)) {
      // The sandbox relay is the only container on it. The app is not, so
      // its web app and API (3045) and ChatGPT's sign-in callback (1455),
      // which listen on every interface of its container, are not there.
      const onSandboxes = Object.entries(file.services)
        .filter(([, service]) => service.networks?.includes("sandboxes"))
        .map(([name]) => name);
      expect(onSandboxes, path).toEqual(["sandbox-relay"]);
      // And the relay forwards to the Gateway's port, and to nothing else.
      expect(
        file.services["sandbox-relay"]?.environment?.["RELAY_GATEWAY"],
        path,
      ).toMatch(/^(app|server):3047$/);
    }
    expect(appOnSandboxes()).toBe(false);
  });

  it("regression (S2-3): under compose the app no longer joins ai-office-sandboxes: it still listens on every interface of its container, for Caddy and the published ports, but only the default network reaches them, and the compose file says what is true", () => {
    const config = composeConfig();
    expect(appOnSandboxes()).toBe(false);
    expect(app.networks).toEqual(["default"]);
    expect(everyInterface(config.host)).toBe(true);
    expect(everyInterface(config.oauthCallbackHost)).toBe(true);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3045);
    expect(config.oauthCallbackHost).toBe("0.0.0.0");
    expect(config.gateway.host).toBe("0.0.0.0");
    expect(composeText).not.toContain(
      "where they reach the AI Gateway as app:3047 and nothing else of the\n  # stack",
    );
    expect(composeText).toContain(
      "sandboxes reach\n  # the AI Gateway through it, as sandbox-relay:3047, and nothing else of\n  # the stack",
    );
  });

  it("sibling (S2-3): neither the pen-test stack's app nor the development stack's server or Vite is on its sandboxes' network, and the dev relay reaches only the Gateway's port", () => {
    expect(penTestCompose.services["app"]?.networks).toEqual(["default"]);
    expect(devCompose.services["server"]?.networks).toEqual(["default"]);
    expect(devCompose.services["web"]?.networks).toEqual(["default"]);
    expect(
      devCompose.services["sandbox-relay"]?.environment?.["RELAY_GATEWAY"],
    ).toBe("server:3047");
    // The Gateway's own port is never published.
    expect(JSON.stringify(devCompose.services["server"]?.ports)).not.toContain(
      "3047",
    );
  });

  // Fixed with A1-2 (#213), whose sibling path this was: HOST defaults to
  // loopback. The compose half is fixed by S2-3 (#233), above.
  it("regression (A1-2): outside compose the server no longer listens on every interface by default, so a sandbox on the default bridge does not reach it at the bridge's gateway address", () => {
    const config = loadConfig(fakeSecrets);
    expect(config.host).toBe("127.0.0.1");
    // ChatGPT's callback stays on loopback outside compose.
    expect(config.oauthCallbackHost).toBe("127.0.0.1");
  });

  it("holds: Postgres and Caddy are not on the sandboxes' network", () => {
    expect(postgres.networks ?? ["default"]).not.toContain("sandboxes");
    expect(caddy.networks).toEqual(["default"]);
  });

  it("holds: Postgres publishes no port under compose, and the development Postgres only on the host's loopback", () => {
    expect(postgres.ports).toBeUndefined();
    expect(devCompose.services["postgres"]?.ports).toEqual([
      "127.0.0.1:3048:5432",
    ]);
  });
});

/**
 * Every `docker` call the real runners make to start, as compose's
 * configuration has them, two sandboxes of one Floor and one of another,
 * all running at once, and a Manager chat session beside them. A
 * stand-in `docker`, first on the PATH, records each call and answers
 * that the sandbox relay is `relay0123` (there is no Docker here).
 */
async function startedTogether(): Promise<string[][]> {
  const bin = await mkdtemp(join(tmpdir(), "s2-5-docker-"));
  const log = join(bin, "calls.jsonl");
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "ps") process.stdout.write("relay0123\\n");
`,
  );
  await chmod(join(bin, "docker"), 0o755);
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}:${path ?? ""}`;
  const { network } = composeConfig().sandboxes;
  try {
    const handles: { close(): Promise<void> }[] = [];
    for (const floor of ["floor-a", "floor-a", "floor-b"]) {
      const provider = dockerSandbox({ network })(
        { GH_TOKEN: "ghs_fake_read_only_token_for_probe" },
        "Claude Code",
      ) as unknown as {
        create(options: {
          worktreePath: string;
          hostRepoPath: string;
          mounts: { hostPath: string; sandboxPath: string }[];
          env: Record<string, string>;
        }): Promise<{ close(): Promise<void> }>;
      };
      handles.push(
        await provider.create({
          worktreePath: `/srv/ai-office/runs/${floor}`,
          hostRepoPath: `/srv/ai-office/runs/${floor}`,
          mounts: [
            {
              hostPath: `/srv/ai-office/runs/${floor}`,
              sandboxPath: "/home/agent/workspace",
            },
          ],
          env: {},
        }),
      );
    }
    const said: string[] = [];
    for await (const line of dockerToolRunner({ network })({
      tool: "Claude Code",
      image: "ai-office/sandbox-claude:3",
      args: ["--print"],
      environment: {},
      input: "",
      mounts: [],
      signal: new AbortController().signal,
    })) {
      said.push(line);
    }
    expect(said).toEqual([]);
    for (const handle of handles) {
      await handle.close();
    }
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
  } finally {
    process.env["PATH"] = path;
    await rm(bin, { recursive: true, force: true });
  }
}

/** The value after each `flag` in `args`. */
const after = (args: readonly string[], flag: string) =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));

describe("S2-5: one sandbox reaching another", () => {
  /**
   * Whether every sandbox shares one bridge on which containers reach each
   * other: Docker's default unless inter-container traffic is turned off.
   */
  const sandboxesSeeEachOther = () =>
    sandboxes?.driver_opts?.["com.docker.network.bridge.enable_icc"] !==
      "false" && composeConfig().sandboxes.network === sandboxes?.name;

  it("a sandbox cannot reach another sandbox, of its own Floor or another's", async () => {
    expect(sandboxesSeeEachOther()).toBe(false);
    const calls = await startedTogether();
    const runs = calls.filter((args) => args[0] === "run");
    expect(runs).toHaveLength(4);
    const networks = runs.map((args) => after(args, "--network"));
    // Each on one network, and no two on the same one.
    for (const own of networks) {
      expect(own).toHaveLength(1);
    }
    const names = networks.flat();
    expect(new Set(names).size).toBe(4);
    expect(names).not.toContain(sandboxes?.name);
    for (const name of names) {
      // Made for it, internal, with only the sandbox relay joined to it
      // besides, as sandbox-relay: so each still reaches the AI Gateway.
      expect(
        calls.filter(
          (args) =>
            args[0] === "network" &&
            args[1] === "create" &&
            args.at(-1) === name,
        ),
      ).toEqual([
        [
          "network",
          "create",
          "--internal",
          "--label",
          `ai-office.sandbox-network=${String(sandboxes?.name)}`,
          name,
        ],
      ]);
      expect(
        calls.filter(
          (args) =>
            args[0] === "network" &&
            args[1] === "connect" &&
            args.includes(name),
        ),
      ).toEqual([
        ["network", "connect", "--alias", "sandbox-relay", name, "relay0123"],
      ]);
    }
  });

  it("regression (S2-5): sandboxes no longer all join the one ai-office-sandboxes network with inter-container traffic on: only the sandbox relay is on it, with inter-container traffic off, in every compose file, and each sandbox has a network of its own", async () => {
    expect(sandboxesSeeEachOther()).toBe(false);
    expect(sandboxes?.driver_opts).not.toBeUndefined();
    for (const [path, file] of Object.entries(composeFiles)) {
      expect(
        file.networks?.["sandboxes"]?.driver_opts?.[
          "com.docker.network.bridge.enable_icc"
        ],
        path,
      ).toBe("false");
      expect(
        Object.entries(file.services)
          .filter(([, service]) => service.networks?.includes("sandboxes"))
          .map(([name]) => name),
        path,
      ).toEqual(["sandbox-relay"]);
    }
    const runs = (await startedTogether()).filter((args) => args[0] === "run");
    for (const run of runs) {
      expect(after(run, "--network")).not.toContain("ai-office-sandboxes");
    }
  });
});

// Since origin/main's "Agents under compose" (merged into the pen-testing
// fixes), the app itself starts Agents' sandboxes under compose, through
// the host's Docker socket, and `.env.example` is set for development, so
// `pnpm dev` reads its values as they are. Both are paths to the
// sandboxes S2-1, S2-3 and S2-5 closed; these keep them closed.
describe("S2-1, S2-3, S2-5 · the sandboxes the app starts under compose, and .env.example as pnpm dev reads it", () => {
  /** `.env.example`'s set values, as `pnpm dev` reads them. */
  const envExampleValues = async () =>
    Object.fromEntries(
      (await read(".env.example"))
        .split("\n")
        .filter((line) => /^[A-Z][A-Z0-9_]*=./.test(line))
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );

  it("under compose the app starts the sandboxes on the host's Docker, and compose itself names the sandbox relay for them, whatever .env says, with the app off their network", () => {
    // The app starts them: the host's Docker socket, and their clones at
    // the same path as on the host.
    expect(app.volumes).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(app.environment?.["SANDBOX_WORK_DIR"]).toBe(
      "${AI_OFFICE_SANDBOX_DIR:-${HOME}/.ai-office/sandboxes}",
    );
    // Set by compose, not from .env, so no .env can point sandboxes at the
    // app or put them on Docker's default bridge.
    expect(app.environment?.["SANDBOX_GATEWAY_URL"]).toBe(
      "http://sandbox-relay:3047",
    );
    expect(app.environment?.["SANDBOX_NETWORK"]).toBe("ai-office-sandboxes");
    const { sandboxes: configured } = composeConfig();
    expect(configured.gatewayUrl).toBe("http://sandbox-relay:3047");
    expect(configured.network).toBe(sandboxes?.name);
    expect(appOnSandboxes()).toBe(false);
    // The one-shot service that makes the work directory reaches nothing.
    const sandboxDir = compose.services["sandbox-dir"];
    expect(sandboxDir?.network_mode).toBe("none");
    expect(sandboxDir?.networks).toBeUndefined();
  });

  it("the sandboxes the app starts with compose's configuration each have a network of their own, which only the relay joins", async () => {
    // startedTogether drives both real runners with composeConfig(), as
    // the app under compose now runs them.
    const calls = await startedTogether();
    const runs = calls.filter((args) => args[0] === "run");
    expect(runs).toHaveLength(4);
    for (const run of runs) {
      const [own] = after(run, "--network");
      expect(own).toMatch(/^ai-office-sandbox-[0-9a-f-]{36}$/);
      expect(
        calls.filter(
          (args) =>
            args[0] === "network" &&
            args[1] === "connect" &&
            args.includes(own ?? ""),
        ),
      ).toEqual([
        ["network", "connect", "--alias", "sandbox-relay", own, "relay0123"],
      ]);
    }
  });

  it(".env.example, set for development, names the relay and its closed network, never Docker's default bridge or the Gateway's own address, and keeps the server on loopback", async () => {
    const values = await envExampleValues();
    expect(values["SANDBOX_NETWORK"]).not.toBe("bridge");
    const config = loadConfig({ ...values, ...fakeSecrets });
    expect(config.sandboxes.network).toBe("ai-office-sandboxes");
    expect(config.sandboxes.network).toBe(sandboxes?.name);
    expect(config.sandboxes.gatewayUrl).toBe("http://sandbox-relay:3047");
    // Outside compose the server is on loopback (A1-2), so a container's
    // route to the host's address does not reach it.
    expect(config.host).toBe("127.0.0.1");
    expect(config.oauthCallbackHost).toBe("127.0.0.1");
    expect(everyInterface(config.gateway.host)).toBe(false);
  });
});
