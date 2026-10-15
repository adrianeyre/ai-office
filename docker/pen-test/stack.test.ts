// docker/pen-test/stand-up and teardown (docs/pen-testing/stack.md), with
// the Docker CLI faked and the env files and sandbox work directory in a
// temporary directory: what stand-up generates, refuses and runs, and
// what teardown removes and says it removed.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sandboxNetworkLabel as orchestratorSandboxNetworkLabel } from "../../packages/orchestrator/src/sandbox/docker.ts";
import {
  bindAddressProblem,
  composeEnvironment,
  credentialsDirProblem,
  credentialsPackageFileName,
  firewallRules,
  fixturesFileName,
  generatedSecrets,
  mintCredentialsPackage,
  parseEnv,
  postgresVolume,
  projectName,
  revokeCredentialsPackage,
  sandboxNetwork,
  sandboxNetworkLabel,
  sharedSecrets,
  StackError,
  standUp,
  teardown,
  teardownList,
  withEnv,
  workDirMarker,
  workDirProblem,
  type Docker,
  type StackPaths,
} from "./stack.ts";

const fakeKey = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "fake-pen-test-app-key",
  "-----END RSA PRIVATE KEY-----",
].join("\\n");

let base: string;
let paths: StackPaths;
let home: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pen-test-stack-"));
  home = join(base, "home");
  const repository = join(base, "repository");
  mkdirSync(join(repository, "docker/pen-test"), { recursive: true });
  mkdirSync(home);
  paths = {
    envFile: join(repository, "docker/pen-test/.env"),
    envExample: join(repository, "docker/pen-test/.env.example"),
    realEnv: join(repository, ".env"),
    realEnvExample: join(repository, ".env.example"),
  };
  copyFileSync(join(import.meta.dirname, ".env.example"), paths.envExample);
  copyFileSync(
    join(import.meta.dirname, "../../.env.example"),
    paths.realEnvExample,
  );
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A Docker CLI that records what it is asked, with the stack's state. */
function fakeDocker(state: {
  sandboxes?: string[];
  /** Sandboxes' own networks (S2-5), labelled for the stack's. */
  sandboxNetworks?: string[];
  containers?: string[];
  networks?: string[];
  volumes?: string[];
  /** Volumes `down` leaves behind. */
  keptByDown?: string[];
  /** Volumes even `volume rm` leaves behind. */
  stuck?: string[];
  /** Does what the command would, such as a service writing a file. */
  onRun?: (args: readonly string[], env: NodeJS.ProcessEnv) => void;
}) {
  const runs: string[][] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  let down = false;
  let removed = false;
  const make = (env: NodeJS.ProcessEnv): Docker => {
    environments.push(env);
    return {
      run(args) {
        runs.push([...args]);
        state.onRun?.(args, env);
        if (args.includes("down")) {
          down = true;
        }
        if (args[0] === "volume" && args[1] === "rm") {
          removed = true;
        }
      },
      lines(args) {
        const [kind] = args;
        if (kind === "ps") {
          return args.some((arg) => arg.startsWith("network="))
            ? (state.sandboxes ?? [])
            : down
              ? []
              : (state.containers ?? []);
        }
        if (kind === "network") {
          if (
            args.some((arg) => arg.startsWith(`label=${sandboxNetworkLabel}=`))
          ) {
            return state.sandboxNetworks ?? [];
          }
          return down ? [] : (state.networks ?? []);
        }
        if (kind === "volume") {
          return !down
            ? (state.volumes ?? [])
            : removed
              ? (state.stuck ?? [])
              : (state.keptByDown ?? []);
        }
        return [];
      },
    };
  };
  return { make, runs, environments };
}

const ownerSettings = (extra: Record<string, string> = {}) => {
  copyFileSync(paths.envExample, paths.envFile);
  writeFileSync(
    paths.envFile,
    withEnv(readFileSync(paths.envFile, "utf8"), {
      PEN_TEST_GITHUB_APP_ID: "424242",
      PEN_TEST_GITHUB_APP_PRIVATE_KEY: fakeKey,
      PEN_TEST_TARGET_REPOSITORY: "owner/pen-test-target",
      ...extra,
    }),
  );
};

const env = () => parseEnv(readFileSync(paths.envFile, "utf8"));
const quiet = () => undefined;

/** Obviously fake credentials, as the `credentials` service would mint. */
const fakeCredentials = [
  "fake-red-team-password-0123456789",
  "aio_gk_fake-ui-key",
  "aio_gk_fake-gateway-key",
];

/**
 * A Docker CLI whose `credentials mint` writes a fake package as the
 * service does: `mode` 0600 unless told otherwise.
 */
const credentialsDocker = (mode = 0o600) =>
  fakeDocker({
    onRun(args) {
      if (args.at(-2) === "credentials" && args.at(-1) === "mint") {
        const dir = env().get("PEN_TEST_CREDENTIALS_DIR") ?? "";
        writeFileSync(
          join(dir, credentialsPackageFileName),
          JSON.stringify({ credentials: fakeCredentials }),
          { mode },
        );
      }
    },
  });

/** On a stood-up stack, the seed's listing written, mints a fake package. */
const mintFake = (): string => {
  const workDir = env().get("PEN_TEST_SANDBOX_WORK_DIR") ?? "";
  writeFileSync(join(workDir, fixturesFileName), "{}");
  return mintCredentialsPackage({
    paths,
    env: {},
    home,
    docker: credentialsDocker().make,
    commit: () => "0123456789abcdef0123456789abcdef01234567",
    log: quiet,
  });
};

describe("stand-up", () => {
  it("makes .env from .env.example, generates the secrets and the work directory, then asks for the GitHub App", () => {
    expect(() => {
      standUp({ paths, env: {}, home, log: quiet });
    }).toThrow(StackError);
    const values = env();
    for (const key of Object.keys(generatedSecrets)) {
      expect(values.get(key)).toMatch(/^\S{32,}$/);
    }
    expect(values.get("PEN_TEST_SANDBOX_WORK_DIR")).toBe(
      join(home, ".local/state/ai-office-pen-test/sandboxes"),
    );
    expect(values.get("PEN_TEST_CREDENTIALS_DIR")).toBe(
      join(home, ".local/state/ai-office-pen-test/credentials"),
    );
    try {
      standUp({ paths, env: {}, home, log: quiet });
    } catch (error) {
      expect((error as Error).message).toContain(
        "PEN_TEST_GITHUB_APP_ID is empty.",
      );
      expect((error as Error).message).toContain(
        "PEN_TEST_TARGET_REPOSITORY is empty.",
      );
    }
    // Generated once: the second run kept them.
    expect(env().get("PEN_TEST_SESSION_SECRET")).toBe(
      values.get("PEN_TEST_SESSION_SECRET"),
    );
  });

  it("generates new secrets each time, never .env.example's or the real stack's", () => {
    const seen = new Set<string>();
    for (let round = 0; round < 3; round++) {
      ownerSettings();
      const docker = fakeDocker({});
      standUp({ paths, env: {}, home, docker: docker.make, log: quiet });
      for (const key of Object.keys(generatedSecrets)) {
        const value = env().get(key) ?? "";
        expect(seen.has(value)).toBe(false);
        seen.add(value);
      }
      expect(
        sharedSecrets(env(), [
          parseEnv(readFileSync(paths.realEnvExample, "utf8")),
        ]),
      ).toEqual([]);
    }
  });

  it("builds, starts Postgres and the stub upstream, adds the AI Accounts, starts the app and the sandbox relay, then seeds", () => {
    ownerSettings();
    const docker = fakeDocker({});
    const lines: string[] = [];
    standUp({
      paths,
      env: { PATH: "/usr/bin", PEN_TEST_SESSION_SECRET: "from-the-shell" },
      home,
      docker: docker.make,
      log: (line) => lines.push(line),
    });
    const tails = docker.runs.map((args) =>
      args.slice(args.indexOf("setup") + 1).join(" "),
    );
    expect(tails).toEqual([
      "build app",
      "up --detach --wait postgres stub-upstream",
      "run --rm ai-accounts",
      "up --detach --wait app sandbox-relay",
      "run --rm seed",
    ]);
    for (const args of docker.runs) {
      expect(args.slice(0, 3)).toEqual([
        "compose",
        "--project-name",
        projectName,
      ]);
      expect(args).toContain(paths.envFile);
    }
    // The env file decides: a PEN_TEST_ variable in the shell is dropped.
    const [environment] = docker.environments;
    expect(environment?.["PEN_TEST_SESSION_SECRET"]).toBeUndefined();
    expect(environment?.["PATH"]).toBe("/usr/bin");
    expect(environment?.["PEN_TEST_PUBLIC_URL"]).toBe("http://localhost:3145");
    const workDir = env().get("PEN_TEST_SANDBOX_WORK_DIR") ?? "";
    expect(existsSync(join(workDir, workDirMarker))).toBe(true);
    expect(lines).toContain(
      "The pen-test stack is up at http://127.0.0.1:3145.",
    );
  });

  it("refuses a secret the real stack also holds, and the real stack's GitHub App", () => {
    ownerSettings({
      PEN_TEST_SESSION_SECRET: "the-real-stacks-session-secret-0123456789",
    });
    writeFileSync(
      paths.realEnv,
      "SESSION_SECRET=the-real-stacks-session-secret-0123456789\nGITHUB_APP_ID=424242\n",
    );
    const docker = fakeDocker({});
    expect(() => {
      standUp({ paths, env: {}, home, docker: docker.make, log: quiet });
    }).toThrow(
      /PEN_TEST_GITHUB_APP_ID is the real Office's GitHub App[\s\S]*PEN_TEST_SESSION_SECRET is also in the real stack's \.env/,
    );
    expect(docker.runs).toEqual([]);
  });

  it("refuses a credentials directory the sandboxes would reach", () => {
    ownerSettings({
      PEN_TEST_SANDBOX_WORK_DIR: join(base, "state/sandboxes"),
      PEN_TEST_CREDENTIALS_DIR: join(base, "state/sandboxes/credentials"),
    });
    const docker = fakeDocker({});
    expect(() => {
      standUp({ paths, env: {}, home, docker: docker.make, log: quiet });
    }).toThrow(/PEN_TEST_CREDENTIALS_DIR .* hold one another/);
    expect(docker.runs).toEqual([]);
  });

  it("refuses every interface, and beyond loopback without the red team's address", () => {
    ownerSettings({ PEN_TEST_BIND_ADDRESS: "0.0.0.0" });
    const docker = fakeDocker({});
    expect(() => {
      standUp({ paths, env: {}, home, docker: docker.make, log: quiet });
    }).toThrow(/every interface/);
    ownerSettings({ PEN_TEST_BIND_ADDRESS: "10.0.0.5" });
    expect(() => {
      standUp({ paths, env: {}, home, docker: docker.make, log: quiet });
    }).toThrow(/PEN_TEST_RED_TEAM_ADDRESS/);
    expect(docker.runs).toEqual([]);

    ownerSettings({
      PEN_TEST_BIND_ADDRESS: "10.0.0.5",
      PEN_TEST_RED_TEAM_ADDRESS: "10.0.0.9",
    });
    const lines: string[] = [];
    standUp({
      paths,
      env: {},
      home,
      docker: docker.make,
      log: (line) => lines.push(line),
    });
    for (const rule of firewallRules("3145", "10.0.0.9")) {
      expect(lines).toContain(`      ${rule}`);
    }
  });
});

describe("the checks", () => {
  it("bind addresses: loopback, or one interface with the red team's address", () => {
    expect(bindAddressProblem("", "")).toBeUndefined();
    expect(bindAddressProblem("127.0.0.1", "")).toBeUndefined();
    expect(bindAddressProblem("::1", "")).toBeUndefined();
    expect(bindAddressProblem("0.0.0.0", "10.0.0.9")).toMatch(
      /every interface/,
    );
    expect(bindAddressProblem("::", "10.0.0.9")).toMatch(/every interface/);
    expect(bindAddressProblem("10.0.0.5", "")).toMatch(/RED_TEAM/);
    expect(bindAddressProblem("10.0.0.5", "10.0.0.9")).toBeUndefined();
  });

  it("the firewall rules drop the port for all but the red team, the accept first", () => {
    const [drop, accept] = firewallRules("3145", "10.0.0.9");
    expect(drop).toMatch(/DOCKER-USER .*--ctorigdstport 3145 .*-j DROP$/);
    expect(accept).toMatch(
      /DOCKER-USER .*--ctorigdstport 3145 .*-s 10\.0\.0\.9 -j ACCEPT$/,
    );
    // Each is inserted at the top, so the accept, inserted last, comes first.
    expect(accept).toContain("-I DOCKER-USER");
  });

  it("work directories: absolute, outside the repository, holding neither it nor home, not the real stack's", () => {
    const context = {
      home: "/home/owner",
      repositoryRoot: "/home/owner/ai-office",
      realWorkDir: "/srv/ai-office-sandboxes",
    };
    expect(
      workDirProblem("/home/owner/.local/state/x", context),
    ).toBeUndefined();
    expect(workDirProblem("relative/dir", context)).toMatch(/absolute/);
    expect(workDirProblem("/", context)).toMatch(/holds the home directory/);
    expect(workDirProblem("/home", context)).toMatch(
      /holds the home directory/,
    );
    expect(workDirProblem("/home/owner", context)).toMatch(/holds/);
    expect(workDirProblem("/home/owner/ai-office/work", context)).toMatch(
      /inside this repository/,
    );
    expect(workDirProblem("/srv/ai-office-sandboxes/", context)).toMatch(
      /real stack's/,
    );
  });

  it("credentials directories: as work directories, and never inside the sandbox work directory or holding it", () => {
    const context = {
      home: "/home/owner",
      repositoryRoot: "/home/owner/ai-office",
      workDir: "/state/pen-test/sandboxes",
    };
    expect(
      credentialsDirProblem("/state/pen-test/credentials", context),
    ).toBeUndefined();
    expect(credentialsDirProblem("credentials", context)).toMatch(
      /PEN_TEST_CREDENTIALS_DIR must be an absolute path/,
    );
    expect(
      credentialsDirProblem("/home/owner/ai-office/credentials", context),
    ).toMatch(/inside this repository/);
    expect(
      credentialsDirProblem("/state/pen-test/sandboxes/credentials", context),
    ).toMatch(/hold one another/);
    expect(credentialsDirProblem("/state/pen-test", context)).toMatch(
      /hold one another/,
    );
  });

  it("shared secrets are found under any name", () => {
    const penTest = new Map([
      ["PEN_TEST_ENCRYPTION_KEY", "c2FtZQ=="],
      ["PEN_TEST_SESSION_SECRET", "own"],
    ]);
    expect(
      sharedSecrets(penTest, [new Map([["ANYTHING", "c2FtZQ=="]])]),
    ).toEqual(["PEN_TEST_ENCRYPTION_KEY"]);
  });

  it("the env file is read and written line by line", () => {
    const text = '# comment\nA=1\nB="two"\nC=\n';
    expect([...parseEnv(text)]).toEqual([
      ["A", "1"],
      ["B", "two"],
      ["C", ""],
    ]);
    expect(withEnv(text, { C: "3", D: "4" })).toBe(
      '# comment\nA=1\nB="two"\nC=3\nD=4\n',
    );
  });

  it("compose's environment drops the shell's PEN_TEST_ variables", () => {
    expect(
      composeEnvironment(
        { HOME: "/h", PEN_TEST_PORT: "1" },
        { PEN_TEST_UID: "5" },
      ),
    ).toEqual({ HOME: "/h", PEN_TEST_UID: "5" });
  });
});

describe("teardown", () => {
  it("lists what it removes: sandboxes, containers, networks, the volume, the work directory, the credentials package and the secrets", () => {
    expect(
      teardownList(
        "/state/ai-office-pen-test/sandboxes",
        "/state/ai-office-pen-test/credentials",
      ),
    ).toContain(
      "its credentials package and its directory, /state/ai-office-pen-test/credentials",
    );
    expect(teardownList("/state/ai-office-pen-test/sandboxes")).toEqual([
      `every sandbox container, on a network of its own or on the ${sandboxNetwork} network, and those networks of their own`,
      `the stack's containers (project ${projectName})`,
      `its networks, ${projectName}_default and ${sandboxNetwork}`,
      `its database volume, ${postgresVolume}`,
      "its sandbox work directory, /state/ai-office-pen-test/sandboxes",
      "its credentials package (no credentials directory is set)",
      "its generated secrets in docker/pen-test/.env (PEN_TEST_POSTGRES_PASSWORD, PEN_TEST_SESSION_SECRET, PEN_TEST_ENCRYPTION_KEY)",
    ]);
  });

  it("removes them all, down with its volumes, and says what it removed", () => {
    ownerSettings();
    standUp({ paths, env: {}, home, docker: fakeDocker({}).make, log: quiet });
    const workDir = env().get("PEN_TEST_SANDBOX_WORK_DIR") ?? "";
    writeFileSync(join(workDir, "clone-file"), "an Agent's work");
    const packageFile = mintFake();
    const credentialsDir = env().get("PEN_TEST_CREDENTIALS_DIR") ?? "";
    const docker = fakeDocker({
      sandboxes: ["sandbox1"],
      containers: ["c1", "c2", "c3"],
      networks: [`${projectName}_default`, sandboxNetwork],
      volumes: [postgresVolume],
    });
    const lines: string[] = [];
    const removed = teardown({
      paths,
      env: {},
      home,
      docker: docker.make,
      log: (line) => lines.push(line),
    });

    expect(docker.runs[0]).toEqual(["rm", "--force", "--volumes", "sandbox1"]);
    expect(docker.runs[1]?.slice(-3)).toEqual([
      "down",
      "--volumes",
      "--remove-orphans",
    ]);
    expect(docker.runs[1]).toContain(projectName);
    expect(docker.runs).toHaveLength(2);
    expect(removed).toEqual([
      "1 sandbox container(s): sandbox1",
      "3 container(s) of the stack: c1, c2, c3",
      `network(s): ${projectName}_default, ${sandboxNetwork}`,
      `volume(s): ${postgresVolume}`,
      `the sandbox work directory ${workDir}`,
      `the credentials directory ${credentialsDir}`,
      `the generated secrets in ${paths.envFile}: PEN_TEST_POSTGRES_PASSWORD, PEN_TEST_SESSION_SECRET, PEN_TEST_ENCRYPTION_KEY`,
    ]);
    expect(existsSync(workDir)).toBe(false);
    // The credentials package is destroyed with its directory.
    expect(existsSync(packageFile)).toBe(false);
    expect(existsSync(credentialsDir)).toBe(false);
    for (const key of Object.keys(generatedSecrets)) {
      expect(env().get(key)).toBe("");
    }
    // The Owner's settings stay.
    expect(env().get("PEN_TEST_GITHUB_APP_ID")).toBe("424242");
    expect(lines).toContain("Removed:");
    for (const item of removed) {
      expect(lines).toContain(`  - ${item}`);
    }
  });

  it("counts the sandbox relay as the stack's, not as a sandbox, though it is on the sandboxes network", () => {
    ownerSettings();
    standUp({ paths, env: {}, home, docker: fakeDocker({}).make, log: quiet });
    const docker = fakeDocker({
      sandboxes: ["sandbox1", "relay1"],
      containers: ["c1", "relay1"],
      networks: [`${projectName}_default`, sandboxNetwork],
      volumes: [postgresVolume],
    });
    const removed = teardown({
      paths,
      env: {},
      home,
      docker: docker.make,
      log: quiet,
    });
    expect(docker.runs[0]).toEqual(["rm", "--force", "--volumes", "sandbox1"]);
    expect(removed.slice(0, 2)).toEqual([
      "1 sandbox container(s): sandbox1",
      "2 container(s) of the stack: c1, relay1",
    ]);
  });

  it("sibling (S2-5): removes the sandboxes on networks of their own, and those networks once down has taken the relay off them", () => {
    ownerSettings();
    standUp({ paths, env: {}, home, docker: fakeDocker({}).make, log: quiet });
    const docker = fakeDocker({
      sandboxes: ["sandbox1", "sandbox2", "relay1"],
      sandboxNetworks: ["ai-office-sandbox-1", "ai-office-sandbox-2"],
      containers: ["c1", "relay1"],
      networks: [`${projectName}_default`, sandboxNetwork],
      volumes: [postgresVolume],
    });
    const removed = teardown({
      paths,
      env: {},
      home,
      docker: docker.make,
      log: quiet,
    });
    expect(sandboxNetworkLabel).toBe(orchestratorSandboxNetworkLabel);
    expect(docker.runs[0]).toEqual([
      "rm",
      "--force",
      "--volumes",
      "sandbox1",
      "sandbox2",
    ]);
    expect(docker.runs[1]).toContain("down");
    expect(docker.runs[2]).toEqual([
      "network",
      "rm",
      "ai-office-sandbox-1",
      "ai-office-sandbox-2",
    ]);
    expect(removed).toContain(
      "sandbox network(s): ai-office-sandbox-1, ai-office-sandbox-2",
    );
  });

  it("removes by name a volume down left behind, and fails if one is still there", () => {
    ownerSettings();
    const left = fakeDocker({
      volumes: [postgresVolume],
      keptByDown: [postgresVolume],
    });
    teardown({ paths, env: {}, home, docker: left.make, log: quiet });
    expect(left.runs).toContainEqual([
      "volume",
      "rm",
      "--force",
      postgresVolume,
    ]);

    const stuck = fakeDocker({
      volumes: [postgresVolume],
      keptByDown: [postgresVolume],
      stuck: [postgresVolume],
    });
    expect(() =>
      teardown({ paths, env: {}, home, docker: stuck.make, log: quiet }),
    ).toThrow(/still there: ai-office-pen-test-postgres-data/);
  });

  it("deletes no directory stand-up did not make", () => {
    const other = join(base, "someone-elses");
    mkdirSync(other);
    writeFileSync(join(other, "keep"), "keep");
    ownerSettings({ PEN_TEST_SANDBOX_WORK_DIR: other });
    expect(() =>
      teardown({
        paths,
        env: {},
        home,
        docker: fakeDocker({}).make,
        log: quiet,
      }),
    ).toThrow(new RegExp(`has no ${workDirMarker.replace(".", "\\.")}`));
    expect(existsSync(join(other, "keep"))).toBe(true);
  });

  it("says when there was nothing to remove", () => {
    const removed = teardown({
      paths,
      env: {},
      home,
      docker: fakeDocker({}).make,
      log: quiet,
    });
    expect(removed).toEqual([
      `no volume: ${postgresVolume} was already gone`,
      "no sandbox work directory: none is set",
      "no credentials directory: none is set",
    ]);
  });

  it("takes the stack down without its env file, the values compose needs only placeholders", () => {
    const docker = fakeDocker({});
    teardown({
      paths,
      env: { PEN_TEST_ENCRYPTION_KEY: "from-the-shell" },
      home,
      docker: docker.make,
      log: quiet,
    });
    expect(docker.runs[0]).not.toContain("--env-file");
    expect(docker.environments[0]?.["PEN_TEST_ENCRYPTION_KEY"]).toBe("0");
  });
});

describe("the credentials package", () => {
  const standUpFake = () => {
    ownerSettings();
    standUp({ paths, env: {}, home, docker: fakeDocker({}).make, log: quiet });
    const workDir = env().get("PEN_TEST_SANDBOX_WORK_DIR") ?? "";
    writeFileSync(join(workDir, fixturesFileName), "{}");
  };

  it("has the credentials service mint it into a 0700 directory of its own, with no credential on any command line or in what it says", () => {
    standUpFake();
    const docker = credentialsDocker();
    const lines: string[] = [];
    const packageFile = mintCredentialsPackage({
      paths,
      env: { PATH: "/usr/bin", PINNED_COMMIT: "from-the-shell" },
      home,
      docker: docker.make,
      commit: () => "0123456789abcdef0123456789abcdef01234567",
      log: (line) => lines.push(line),
    });
    const credentialsDir = env().get("PEN_TEST_CREDENTIALS_DIR") ?? "";
    expect(packageFile).toBe(join(credentialsDir, credentialsPackageFileName));
    expect(statSync(credentialsDir).mode & 0o777).toBe(0o700);
    expect(statSync(packageFile).mode & 0o777).toBe(0o600);
    expect(existsSync(join(credentialsDir, workDirMarker))).toBe(true);

    const [args] = docker.runs;
    expect(docker.runs).toHaveLength(1);
    expect(args?.slice(0, 3)).toEqual([
      "compose",
      "--project-name",
      projectName,
    ]);
    expect(args?.slice(args.indexOf("setup") + 1)).toEqual([
      "run",
      "--rm",
      "--env",
      "PINNED_COMMIT",
      "credentials",
      "mint",
    ]);
    // The commit goes by the environment, never with a value on the line.
    expect(docker.environments[0]?.["PINNED_COMMIT"]).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(args?.some((arg) => arg.includes("="))).toBe(false);

    const everything = [...(args ?? []), ...lines].join("\n");
    for (const credential of fakeCredentials) {
      expect(everything).not.toContain(credential);
    }
    expect(lines).toContain(
      `The credentials package is at ${packageFile} (0600).`,
    );
    expect(lines.join("\n")).toMatch(/out of band/);
  });

  it("refuses before stand-up, before the seed's listing, and over a package already there", () => {
    const docker = credentialsDocker();
    const mint = () =>
      mintCredentialsPackage({
        paths,
        env: {},
        home,
        docker: docker.make,
        commit: () => "0",
        log: quiet,
      });
    expect(mint).toThrow(/run docker\/pen-test\/stand-up first/);

    ownerSettings();
    standUp({ paths, env: {}, home, docker: fakeDocker({}).make, log: quiet });
    expect(mint).toThrow(/no fixture ID listing/);

    const workDir = env().get("PEN_TEST_SANDBOX_WORK_DIR") ?? "";
    writeFileSync(join(workDir, fixturesFileName), "{}");
    mint();
    expect(mint).toThrow(/already there: hand it over, or revoke/);
    expect(docker.runs).toHaveLength(1);
  });

  it("deletes a package the service wrote with any mode but 0600", () => {
    standUpFake();
    const docker = credentialsDocker(0o644);
    expect(() =>
      mintCredentialsPackage({
        paths,
        env: {},
        home,
        docker: docker.make,
        commit: () => "0",
        log: quiet,
      }),
    ).toThrow(/not 0600, so it was deleted/);
    const credentialsDir = env().get("PEN_TEST_CREDENTIALS_DIR") ?? "";
    expect(existsSync(join(credentialsDir, credentialsPackageFileName))).toBe(
      false,
    );
  });

  it("revokes its credentials through the service, then deletes the host's copy", () => {
    standUpFake();
    const packageFile = mintFake();
    const docker = fakeDocker({});
    const lines: string[] = [];
    revokeCredentialsPackage({
      paths,
      env: {},
      home,
      docker: docker.make,
      log: (line) => lines.push(line),
    });
    expect(docker.runs).toHaveLength(1);
    expect(docker.runs[0]?.slice(-4)).toEqual([
      "run",
      "--rm",
      "credentials",
      "revoke",
    ]);
    expect(existsSync(packageFile)).toBe(false);
    expect(lines).toContain(
      `Deleted the host's copy of the credentials package, ${packageFile}.`,
    );
    for (const credential of fakeCredentials) {
      expect(lines.join("\n")).not.toContain(credential);
    }
  });

  it("says there is nothing to revoke once the stack is torn down", () => {
    standUpFake();
    teardown({ paths, env: {}, home, docker: fakeDocker({}).make, log: quiet });
    const docker = fakeDocker({});
    expect(() => {
      revokeCredentialsPackage({
        paths,
        env: {},
        home,
        docker: docker.make,
        log: quiet,
      });
    }).toThrow(/torn down: its credentials went with its database volume/);
    expect(docker.runs).toEqual([]);
  });
});
