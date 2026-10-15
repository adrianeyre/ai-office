// `docker/pen-test/stand-up` and `docker/pen-test/teardown`: the pen-test
// stack (docs/pen-testing/stack.md), started and removed. It uses nothing
// but Node and the Docker CLI, so it runs before `pnpm install`.
//
// Stand-up fills docker/pen-test/.env's empty secrets and sandbox work
// directory, refuses a secret the real stack also holds, a bind address
// beyond loopback without the red team's address, and a missing GitHub
// App; then it builds the app's image, starts Postgres and the stub
// upstream, adds the AI Accounts and starts the app.
//
// `docker/pen-test/credentials mint` and `... revoke` (Enablement E4, #190):
// the credentials package, minted by the stack's `credentials` service into
// a directory of its own, 0700, which no sandbox reaches, and revoked at the
// end of the window. Neither ever puts a credential on a command line or
// prints one.
//
// Teardown removes the sandboxes the app started, the stack's containers,
// its networks and its volume, its sandbox work directory, its credentials
// package and its generated secrets, and says what it removed. It keeps the
// image and the Owner's settings in .env.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const projectName = "ai-office-pen-test";
export const sandboxNetwork = "ai-office-pen-test-sandboxes";

/**
 * The label on each sandbox's own network (S2-5, ADR 0006), valued with
 * the network its sandbox relay is on: `sandboxNetworkLabel` in
 * packages/orchestrator/src/sandbox/docker.ts.
 */
export const sandboxNetworkLabel = "ai-office.sandbox-network";
export const postgresVolume = "ai-office-pen-test-postgres-data";
export const image = "ai-office:pen-test";
export const defaultPort = "3145";

const here = import.meta.dirname;
export const repositoryRoot = resolve(here, "../..");

/** The secrets stand-up generates when empty, and teardown empties. */
export const generatedSecrets = {
  // URL-safe: it goes into DATABASE_URL.
  PEN_TEST_POSTGRES_PASSWORD: () => randomBytes(24).toString("hex"),
  PEN_TEST_SESSION_SECRET: () => randomBytes(32).toString("hex"),
  PEN_TEST_ENCRYPTION_KEY: () => randomBytes(32).toString("base64"),
} as const;

/** The variables the Owner sets: the stack's own GitHub App and target. */
export const ownerSettings = [
  "PEN_TEST_GITHUB_APP_ID",
  "PEN_TEST_GITHUB_APP_PRIVATE_KEY",
  "PEN_TEST_TARGET_REPOSITORY",
] as const;

/**
 * Written in the sandbox work directory and the credentials directory, so
 * teardown knows it made them.
 */
export const workDirMarker = ".ai-office-pen-test";

/** The fixture ID listing the seed writes in the sandbox work directory. */
export const fixturesFileName = "pen-test-fixtures.json";

/** The credentials package, in the credentials directory. */
export const credentialsPackageFileName = "credentials-package.json";

// --- Env files ----------------------------------------------------------------

/** An env file's `KEY=value` lines; surrounding quotes are dropped. */
export function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] === undefined) {
      continue;
    }
    const value = (match[2] ?? "").trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    values.set(match[1], quoted?.[2] ?? value);
  }
  return values;
}

/** `text` with each of `values` set: its line replaced, or one added. */
export function withEnv(
  text: string,
  values: Readonly<Record<string, string>>,
): string {
  const lines = text.split("\n");
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (at === -1) {
      if (lines.at(-1) === "") {
        lines.splice(-1, 0, `${key}=${value}`);
      } else {
        lines.push(`${key}=${value}`);
      }
    } else {
      lines[at] = `${key}=${value}`;
    }
  }
  return lines.join("\n");
}

const readEnv = (path: string): Map<string, string> =>
  existsSync(path)
    ? parseEnv(readFileSync(path, "utf8"))
    : new Map<string, string>();

// --- Checks -------------------------------------------------------------------

/**
 * The pen-test secrets whose values the real stack's env files also hold,
 * under any name: none may be shared with the real stack.
 */
export function sharedSecrets(
  penTest: ReadonlyMap<string, string>,
  real: readonly ReadonlyMap<string, string>[],
): string[] {
  const realValues = new Set(
    real.flatMap((env) => [...env.values()].filter((value) => value !== "")),
  );
  return [
    ...Object.keys(generatedSecrets),
    "PEN_TEST_GITHUB_APP_PRIVATE_KEY",
  ].filter((key) => {
    const value = penTest.get(key) ?? "";
    return value !== "" && realValues.has(value);
  });
}

/** Whether `address` is this machine's loopback. */
export const isLoopback = (address: string): boolean =>
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address) ||
  address === "::1" ||
  address === "localhost";

/**
 * Why the app may not be published on `address`, if it may not: never on
 * every interface, and beyond loopback only with the red team's address.
 */
export function bindAddressProblem(
  address: string,
  redTeamAddress: string,
): string | undefined {
  if (address === "" || isLoopback(address)) {
    return undefined;
  }
  if (["0.0.0.0", "::", "[::]"].includes(address)) {
    return `PEN_TEST_BIND_ADDRESS is ${address}, every interface. Publish the stack on one interface's address, and let only the red team's host reach it.`;
  }
  if (redTeamAddress === "") {
    return `PEN_TEST_BIND_ADDRESS is ${address}, beyond loopback: set PEN_TEST_RED_TEAM_ADDRESS to the red team's address, so stand-up can print the firewall rules that admit it alone.`;
  }
  return undefined;
}

/**
 * The firewall rules that admit only `redTeamAddress` to the published
 * `port`. Docker's own rules come before ufw's, so they go in Docker's
 * DOCKER-USER chain, matched on the port as published.
 */
export const firewallRules = (port: string, redTeamAddress: string) => [
  `sudo iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport ${port} --ctdir ORIGINAL -j DROP`,
  `sudo iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport ${port} --ctdir ORIGINAL -s ${redTeamAddress} -j ACCEPT`,
];

/** Whether `inner` is `outer` or inside it. */
const within = (outer: string, inner: string): boolean => {
  const between = relative(resolve(outer), resolve(inner));
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
};

/**
 * Why `path` may not be the sandbox work directory (or, as `setting` says,
 * the credentials directory), if it may not: it is deleted at teardown, so
 * it is absolute, holds neither the home directory nor this repository, is
 * not inside the repository (whose tests would find the clones' files), and
 * is not the real stack's.
 */
export function workDirProblem(
  path: string,
  context: {
    readonly home: string;
    readonly repositoryRoot: string;
    readonly realWorkDir?: string;
  },
  setting = "PEN_TEST_SANDBOX_WORK_DIR",
): string | undefined {
  if (!isAbsolute(path)) {
    return `${setting} must be an absolute path, not "${path}".`;
  }
  if (within(path, context.home) || within(path, context.repositoryRoot)) {
    return `${setting} (${path}) holds the home directory or this repository; teardown deletes it.`;
  }
  if (within(context.repositoryRoot, path)) {
    return `${setting} (${path}) is inside this repository; put it outside.`;
  }
  if (
    context.realWorkDir !== undefined &&
    context.realWorkDir !== "" &&
    resolve(context.realWorkDir) === resolve(path)
  ) {
    return `${setting} (${path}) is the real stack's SANDBOX_WORK_DIR.`;
  }
  return undefined;
}

/**
 * Why `path` may not be the credentials directory, if it may not: as for
 * the work directory, and never inside it or holding it, because the app
 * bind-mounts the work directory's clones into the sandboxes, and no
 * sandbox may ever reach the credentials package.
 */
export function credentialsDirProblem(
  path: string,
  context: {
    readonly home: string;
    readonly repositoryRoot: string;
    readonly workDir: string;
    readonly realWorkDir?: string;
  },
): string | undefined {
  const problem = workDirProblem(path, context, "PEN_TEST_CREDENTIALS_DIR");
  if (problem !== undefined) {
    return problem;
  }
  if (
    context.workDir !== "" &&
    (within(context.workDir, path) || within(path, context.workDir))
  ) {
    return `PEN_TEST_CREDENTIALS_DIR (${path}) and PEN_TEST_SANDBOX_WORK_DIR hold one another: keep the credentials package where no sandbox reaches it.`;
  }
  return undefined;
}

/** Where the sandbox work directory goes when none is set. */
export const defaultWorkDir = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string =>
  join(
    env["XDG_STATE_HOME"] ?? join(home, ".local", "state"),
    "ai-office-pen-test",
    "sandboxes",
  );

/** Where the credentials directory goes when none is set. */
export const defaultCredentialsDir = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string =>
  join(
    env["XDG_STATE_HOME"] ?? join(home, ".local", "state"),
    "ai-office-pen-test",
    "credentials",
  );

/** Why the Owner's settings are not ready, one line each. */
export function ownerSettingProblems(
  penTest: ReadonlyMap<string, string>,
  real: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  for (const key of ownerSettings) {
    if ((penTest.get(key) ?? "") === "") {
      problems.push(`${key} is empty.`);
    }
  }
  const appId = penTest.get("PEN_TEST_GITHUB_APP_ID") ?? "";
  if (appId !== "" && !/^\d+$/.test(appId)) {
    problems.push("PEN_TEST_GITHUB_APP_ID must be the App's numeric ID.");
  }
  if (appId !== "" && appId === real.get("GITHUB_APP_ID")) {
    problems.push(
      "PEN_TEST_GITHUB_APP_ID is the real Office's GitHub App: the pen-test stack has an App of its own.",
    );
  }
  const repository = penTest.get("PEN_TEST_TARGET_REPOSITORY") ?? "";
  if (repository !== "" && !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    problems.push("PEN_TEST_TARGET_REPOSITORY must be owner/name.");
  }
  return problems;
}

// --- Docker -------------------------------------------------------------------

/** The Docker CLI, as stand-up and teardown use it. */
export interface Docker {
  /** Runs `docker <args>`, its output shown; throws if it fails. */
  run(args: readonly string[]): void;
  /** Runs `docker <args>` and gives its output's non-empty lines. */
  lines(args: readonly string[]): string[];
}

export function dockerCli(env: NodeJS.ProcessEnv): Docker {
  /** `docker <args>`, its failure said plainly. */
  const docker = <T>(args: readonly string[], call: () => T): T => {
    try {
      return call();
    } catch (error) {
      const { code, status } = error as { code?: string; status?: number };
      throw new StackError(
        code === "ENOENT"
          ? "The Docker CLI (docker) is not on the PATH."
          : `docker ${args.join(" ")} failed${status === undefined ? "" : ` (exit ${String(status)})`}.`,
      );
    }
  };
  return {
    run(args) {
      docker(args, () =>
        execFileSync("docker", args, { env, stdio: "inherit" }),
      );
    },
    lines(args) {
      return docker(args, () =>
        execFileSync("docker", args, {
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
        }),
      )
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    },
  };
}

/** `docker compose` for the pen-test stack, every profile included. */
export const compose = (envFile?: string): string[] => [
  "compose",
  "--project-name",
  projectName,
  "--file",
  join(here, "compose.yml"),
  ...(envFile === undefined ? [] : ["--env-file", envFile]),
  "--profile",
  "setup",
];

/**
 * The environment `docker compose` runs in: this one without any
 * PEN_TEST_ variable (so the env file decides), plus `extra`.
 */
export function composeEnvironment(
  env: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([key]) => !key.startsWith("PEN_TEST_")),
    ),
    ...extra,
  };
}

// --- Stand-up -----------------------------------------------------------------

export interface StackPaths {
  /** docker/pen-test/.env */
  readonly envFile: string;
  /** docker/pen-test/.env.example */
  readonly envExample: string;
  /** The real stack's .env, at the repository's root. */
  readonly realEnv: string;
  /** The root .env.example, whose sample secrets are public. */
  readonly realEnvExample: string;
}

export const stackPaths: StackPaths = {
  envFile: join(here, ".env"),
  envExample: join(here, ".env.example"),
  realEnv: join(repositoryRoot, ".env"),
  realEnvExample: join(repositoryRoot, ".env.example"),
};

/** Thrown with what to do, rather than a stack trace. */
export class StackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackError";
  }
}

/** Where the app is published, and the address it is reached at. */
export function address(values: ReadonlyMap<string, string>): {
  readonly port: string;
  readonly url: string;
} {
  const bindAddress = values.get("PEN_TEST_BIND_ADDRESS") ?? "";
  const port =
    (values.get("PEN_TEST_PORT") ?? "") === ""
      ? defaultPort
      : (values.get("PEN_TEST_PORT") ?? defaultPort);
  const host = bindAddress === "" ? "127.0.0.1" : bindAddress;
  return {
    port,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
  };
}

/**
 * The settings left empty in `values` that this machine decides: the user
 * and group the app runs as, the Docker socket's group, and the address the
 * app is reached at.
 */
export function machineSettings(
  values: ReadonlyMap<string, string>,
): Record<string, string> {
  const fromMachine: Record<string, string> = {};
  const unset = (key: string) => (values.get(key) ?? "") === "";
  if (unset("PEN_TEST_UID")) {
    fromMachine["PEN_TEST_UID"] = String(process.getuid?.() ?? 1000);
  }
  if (unset("PEN_TEST_GID")) {
    fromMachine["PEN_TEST_GID"] = String(process.getgid?.() ?? 1000);
  }
  if (unset("PEN_TEST_DOCKER_GID")) {
    // On Linux the socket's group is the host's; Docker Desktop's socket
    // is root's inside a container, so 0 suits it, as in the real stack.
    const socket = "/var/run/docker.sock";
    fromMachine["PEN_TEST_DOCKER_GID"] =
      process.platform === "linux" && existsSync(socket)
        ? String(statSync(socket).gid)
        : "0";
  }
  if (unset("PEN_TEST_PUBLIC_URL")) {
    const { port, url } = address(values);
    fromMachine["PEN_TEST_PUBLIC_URL"] =
      (values.get("PEN_TEST_BIND_ADDRESS") ?? "") === ""
        ? `http://localhost:${port}`
        : url;
  }
  return fromMachine;
}

export function standUp(
  options: {
    readonly paths?: StackPaths;
    readonly env?: NodeJS.ProcessEnv;
    readonly home?: string;
    readonly docker?: (env: NodeJS.ProcessEnv) => Docker;
    readonly log?: (line: string) => void;
  } = {},
): void {
  const paths = options.paths ?? stackPaths;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const log = options.log ?? console.log;

  if (!existsSync(paths.envFile)) {
    copyFileSync(paths.envExample, paths.envFile);
    log(`Made ${paths.envFile} from .env.example.`);
  }
  let text = readFileSync(paths.envFile, "utf8");
  let values = parseEnv(text);
  const real = readEnv(paths.realEnv);
  const realExample = readEnv(paths.realEnvExample);

  // The generated settings first, so the Owner fills in only their own.
  const generated: Record<string, string> = {};
  for (const [key, make] of Object.entries(generatedSecrets)) {
    if ((values.get(key) ?? "") === "") {
      generated[key] = make();
    }
  }
  if ((values.get("PEN_TEST_SANDBOX_WORK_DIR") ?? "") === "") {
    generated["PEN_TEST_SANDBOX_WORK_DIR"] = defaultWorkDir(env, home);
  }
  if ((values.get("PEN_TEST_CREDENTIALS_DIR") ?? "") === "") {
    generated["PEN_TEST_CREDENTIALS_DIR"] = defaultCredentialsDir(env, home);
  }
  if (Object.keys(generated).length > 0) {
    text = withEnv(text, generated);
    writeFileSync(paths.envFile, text, { mode: 0o600 });
    values = parseEnv(text);
    log(`Wrote new ${Object.keys(generated).join(", ")} to ${paths.envFile}.`);
  }

  const problems = [
    ...ownerSettingProblems(values, real),
    ...sharedSecrets(values, [real, realExample]).map(
      (key) =>
        `${key} is also in the real stack's .env or the root .env.example: empty it and stand-up generates a new one.`,
    ),
  ];
  const workDir = values.get("PEN_TEST_SANDBOX_WORK_DIR") ?? "";
  const dirContext = {
    home,
    repositoryRoot: resolve(paths.realEnv, ".."),
    ...(real.has("SANDBOX_WORK_DIR")
      ? { realWorkDir: real.get("SANDBOX_WORK_DIR") ?? "" }
      : {}),
  };
  const workDirIssue = workDirProblem(workDir, dirContext);
  const credentialsDirIssue = credentialsDirProblem(
    values.get("PEN_TEST_CREDENTIALS_DIR") ?? "",
    { ...dirContext, workDir },
  );
  const bindAddress = values.get("PEN_TEST_BIND_ADDRESS") ?? "";
  const redTeam = values.get("PEN_TEST_RED_TEAM_ADDRESS") ?? "";
  const bindIssue = bindAddressProblem(bindAddress, redTeam);
  for (const issue of [workDirIssue, credentialsDirIssue, bindIssue]) {
    if (issue !== undefined) {
      problems.push(issue);
    }
  }
  if (problems.length > 0) {
    throw new StackError(
      `The pen-test stack cannot stand up. In ${paths.envFile}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
  }

  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(workDir, workDirMarker),
    "The pen-test stack's sandbox work directory: docker/pen-test/teardown deletes it.\n",
  );

  const { port, url } = address(values);
  const fromMachine = machineSettings(values);

  const docker = (options.docker ?? dockerCli)(
    composeEnvironment(env, fromMachine),
  );
  const stack = compose(paths.envFile);
  docker.run([...stack, "build", "app"]);
  docker.run([
    ...stack,
    "up",
    "--detach",
    "--wait",
    "postgres",
    "stub-upstream",
  ]);
  docker.run([...stack, "run", "--rm", "ai-accounts"]);
  // The app, and the sandbox relay: the sandboxes' one way to the AI Gateway
  // and out (pen-testing S2-1).
  docker.run([...stack, "up", "--detach", "--wait", "app", "sandbox-relay"]);
  // The fixtures and the hostile-content corpus (E2, #188), once the app is up.
  docker.run([...stack, "run", "--rm", "seed"]);

  const fixturesFile = join(workDir, fixturesFileName);

  log("");
  log(`The pen-test stack is up at ${url}.`);
  log(
    "  - Open it and set the Owner password on the setup screen, before anyone else can.",
  );
  log(
    `  - Target repository: ${values.get("PEN_TEST_TARGET_REPOSITORY") ?? ""}. Install the stack's GitHub App on it alone.`,
  );
  log(
    `  - The stub upstream's log: docker compose --project-name ${projectName} logs stub-upstream`,
  );
  log(
    `  - The fixture ID listing for the credentials package (#190): ${fixturesFile}`,
  );
  log(
    "  - Once the Owner password is set, mint the red team's credentials package with docker/pen-test/credentials mint.",
  );
  if (bindAddress !== "" && !isLoopback(bindAddress)) {
    log(
      `  - Published on ${bindAddress}: admit only ${redTeam}, before the window opens:`,
    );
    for (const rule of firewallRules(port, redTeam)) {
      log(`      ${rule}`);
    }
  }
  log("  - Tear it down with docker/pen-test/teardown.");
}

// --- The credentials package --------------------------------------------------

/** This repository's commit checked out: the pinned commit stand-up built. */
export const checkedOutCommit = (): string =>
  execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

/** The credentials directory, and the work directory it must stay out of. */
function credentialsPlaces(paths: StackPaths, home: string) {
  const values = readEnv(paths.envFile);
  const workDir = values.get("PEN_TEST_SANDBOX_WORK_DIR") ?? "";
  const credentialsDir = values.get("PEN_TEST_CREDENTIALS_DIR") ?? "";
  if (workDir === "" || credentialsDir === "") {
    throw new StackError(
      "The pen-test stack is not stood up: run docker/pen-test/stand-up first.",
    );
  }
  const real = readEnv(paths.realEnv);
  const problem = credentialsDirProblem(credentialsDir, {
    home,
    repositoryRoot: resolve(paths.realEnv, ".."),
    workDir,
    ...(real.has("SANDBOX_WORK_DIR")
      ? { realWorkDir: real.get("SANDBOX_WORK_DIR") ?? "" }
      : {}),
  });
  if (problem !== undefined) {
    throw new StackError(problem);
  }
  return {
    values,
    workDir,
    credentialsDir,
    packageFile: join(credentialsDir, credentialsPackageFileName),
  };
}

interface CredentialsOptions {
  readonly paths?: StackPaths;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly docker?: (env: NodeJS.ProcessEnv) => Docker;
  readonly log?: (line: string) => void;
}

/**
 * `docker/pen-test/credentials mint`: has the stack's `credentials` service
 * mint the red team's credentials and write the package, 0600, into the
 * credentials directory (0700); gives the package's path. Nothing it runs
 * has a credential on its command line, and it prints none.
 */
export function mintCredentialsPackage(
  options: CredentialsOptions & { readonly commit?: () => string } = {},
): string {
  const paths = options.paths ?? stackPaths;
  const home = options.home ?? homedir();
  const log = options.log ?? console.log;
  const { values, workDir, credentialsDir, packageFile } = credentialsPlaces(
    paths,
    home,
  );
  if (!existsSync(join(workDir, fixturesFileName))) {
    throw new StackError(
      `There is no fixture ID listing at ${join(workDir, fixturesFileName)}: docker/pen-test/stand-up seeds the stack and writes it.`,
    );
  }
  if (existsSync(packageFile)) {
    throw new StackError(
      `${packageFile} is already there: hand it over, or revoke its credentials with docker/pen-test/credentials revoke.`,
    );
  }
  mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
  chmodSync(credentialsDir, 0o700);
  writeFileSync(
    join(credentialsDir, workDirMarker),
    "The pen-test stack's credentials directory: docker/pen-test/teardown deletes it.\n",
  );

  // The pinned commit reaches the container through the environment, by
  // name: `--env PINNED_COMMIT` carries no value on the command line.
  const docker = (options.docker ?? dockerCli)(
    composeEnvironment(options.env ?? process.env, {
      ...machineSettings(values),
      PINNED_COMMIT: (options.commit ?? checkedOutCommit)(),
    }),
  );
  docker.run([
    ...compose(paths.envFile),
    "run",
    "--rm",
    "--env",
    "PINNED_COMMIT",
    "credentials",
    "mint",
  ]);

  if (!existsSync(packageFile)) {
    throw new StackError(`The credentials package was not written.`);
  }
  if ((statSync(packageFile).mode & 0o777) !== 0o600) {
    rmSync(packageFile, { force: true });
    throw new StackError(
      `The credentials package was not 0600, so it was deleted: revoke its credentials with docker/pen-test/credentials revoke.`,
    );
  }

  log("");
  log(`The credentials package is at ${packageFile} (0600).`);
  log(
    "  - Hand it over out of band, as a file: never in an issue, a commit, a pull request, a chat, an email or a Notice, and never pasted.",
  );
  log(
    "  - At the end of the window, revoke its credentials with docker/pen-test/credentials revoke.",
  );
  log("  - Teardown destroys it with its directory.");
  return packageFile;
}

/**
 * `docker/pen-test/credentials revoke`: has the stack's `credentials`
 * service revoke the package's credentials, then deletes the host's copy of
 * the package.
 */
export function revokeCredentialsPackage(
  options: CredentialsOptions = {},
): void {
  const paths = options.paths ?? stackPaths;
  const home = options.home ?? homedir();
  const log = options.log ?? console.log;
  const { values, workDir, packageFile } = credentialsPlaces(paths, home);
  if (!existsSync(workDir)) {
    throw new StackError(
      `${workDir} is gone, so the stack has been torn down: its credentials went with its database volume.`,
    );
  }
  const docker = (options.docker ?? dockerCli)(
    composeEnvironment(options.env ?? process.env, machineSettings(values)),
  );
  docker.run([
    ...compose(paths.envFile),
    "run",
    "--rm",
    "credentials",
    "revoke",
  ]);
  if (existsSync(packageFile)) {
    rmSync(packageFile, { force: true });
    log(`Deleted the host's copy of the credentials package, ${packageFile}.`);
  }
  log(
    "The credentials in the copy handed over no longer work: ask the red team to delete it.",
  );
}

// --- Teardown -----------------------------------------------------------------

/** What teardown removes, in order, before it has looked. */
export const teardownList = (
  workDir: string,
  credentialsDir = "",
): string[] => [
  `every sandbox container, on a network of its own or on the ${sandboxNetwork} network, and those networks of their own`,
  `the stack's containers (project ${projectName})`,
  `its networks, ${projectName}_default and ${sandboxNetwork}`,
  `its database volume, ${postgresVolume}`,
  workDir === ""
    ? "its sandbox work directory (none is set)"
    : `its sandbox work directory, ${workDir}`,
  credentialsDir === ""
    ? "its credentials package (no credentials directory is set)"
    : `its credentials package and its directory, ${credentialsDir}`,
  `its generated secrets in docker/pen-test/.env (${Object.keys(generatedSecrets).join(", ")})`,
];

const projectLabel = `label=com.docker.compose.project=${projectName}`;

/**
 * Deletes `dir`, only if the stack made it (it holds `workDirMarker`) and
 * `problem` is undefined; says what it did.
 */
function removeMadeDirectory(
  what: string,
  dir: string,
  problem: string | undefined,
): string {
  if (dir === "") {
    return `no ${what}: none is set`;
  }
  if (!existsSync(dir)) {
    return `no ${what}: ${dir} was already gone`;
  }
  if (problem !== undefined) {
    throw new StackError(`${problem} It was not deleted.`);
  }
  if (!existsSync(join(dir, workDirMarker))) {
    throw new StackError(
      `${dir} has no ${workDirMarker}, so the stack did not make it: it was not deleted.`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
  return `the ${what} ${dir}`;
}

/** Removes the pen-test stack; gives what it removed, one line each. */
export function teardown(
  options: {
    readonly paths?: StackPaths;
    readonly env?: NodeJS.ProcessEnv;
    readonly home?: string;
    readonly docker?: (env: NodeJS.ProcessEnv) => Docker;
    readonly log?: (line: string) => void;
  } = {},
): string[] {
  const paths = options.paths ?? stackPaths;
  const home = options.home ?? homedir();
  const log = options.log ?? console.log;
  const values = readEnv(paths.envFile);
  const workDir = values.get("PEN_TEST_SANDBOX_WORK_DIR") ?? "";
  const credentialsDir = values.get("PEN_TEST_CREDENTIALS_DIR") ?? "";

  log("Tearing down the pen-test stack: removing");
  for (const item of teardownList(workDir, credentialsDir)) {
    log(`  - ${item}`);
  }

  // Compose interpolates the whole file even to take it down; the values
  // do not matter then, so the env file is not needed.
  const placeholders = Object.fromEntries(
    [
      ...Object.keys(generatedSecrets),
      "PEN_TEST_GITHUB_APP_ID",
      "PEN_TEST_GITHUB_APP_PRIVATE_KEY",
      "PEN_TEST_SANDBOX_WORK_DIR",
      "PEN_TEST_CREDENTIALS_DIR",
    ].map((key) => [key, key.endsWith("_DIR") ? "/unused" : "0"]),
  );
  const docker = (options.docker ?? dockerCli)(
    composeEnvironment(options.env ?? process.env, placeholders),
  );
  const removed: string[] = [];

  const containers = docker.lines([
    "ps",
    "--all",
    "--quiet",
    "--filter",
    projectLabel,
  ]);
  // The sandboxes the app started through the host's Docker are not the
  // stack's containers. Each is on a network of its own (S2-5), labelled
  // for the stack's sandboxes network, which the sandbox relay joins; one
  // started before that is on the stack's sandboxes network itself. The
  // relay is the stack's. Each sandbox's home and /tmp are anonymous
  // volumes (S2-4), removed with it.
  const sandboxNetworks = docker.lines([
    "network",
    "ls",
    "--format",
    "{{.Name}}",
    "--filter",
    `label=${sandboxNetworkLabel}=${sandboxNetwork}`,
  ]);
  const sandboxes = docker
    .lines([
      "ps",
      "--all",
      "--quiet",
      ...[sandboxNetwork, ...sandboxNetworks].flatMap((network) => [
        "--filter",
        `network=${network}`,
      ]),
    ])
    .filter((id) => !containers.includes(id));
  if (sandboxes.length > 0) {
    docker.run(["rm", "--force", "--volumes", ...sandboxes]);
    removed.push(
      `${String(sandboxes.length)} sandbox container(s): ${sandboxes.join(", ")}`,
    );
  }

  const named = (kind: "network" | "volume") =>
    docker.lines([
      kind,
      "ls",
      "--format",
      "{{.Name}}",
      "--filter",
      projectLabel,
    ]);
  const networksBefore = named("network");
  const volumesBefore = named("volume");
  docker.run([...compose(), "down", "--volumes", "--remove-orphans"]);
  if (containers.length > 0) {
    removed.push(
      `${String(containers.length)} container(s) of the stack: ${containers.join(", ")}`,
    );
  }
  if (networksBefore.length > 0) {
    removed.push(`network(s): ${networksBefore.join(", ")}`);
  }
  // `down` took the relay off them, and their sandboxes are gone.
  if (sandboxNetworks.length > 0) {
    docker.run(["network", "rm", ...sandboxNetworks]);
    removed.push(`sandbox network(s): ${sandboxNetworks.join(", ")}`);
  }

  // Anything `down` left behind is removed by name; then no volume may
  // remain.
  const networksLeft = named("network");
  if (networksLeft.length > 0) {
    docker.run(["network", "rm", ...networksLeft]);
  }
  const volumesLeft = named("volume");
  if (volumesLeft.length > 0) {
    docker.run(["volume", "rm", "--force", ...volumesLeft]);
  }
  const remaining = named("volume");
  if (remaining.length > 0) {
    throw new StackError(
      `These volumes are still there: ${remaining.join(", ")}. Remove them with docker volume rm.`,
    );
  }
  removed.push(
    volumesBefore.length > 0
      ? `volume(s): ${volumesBefore.join(", ")}`
      : `no volume: ${postgresVolume} was already gone`,
  );

  const repositoryRoot = resolve(paths.realEnv, "..");
  removed.push(
    removeMadeDirectory(
      "sandbox work directory",
      workDir,
      workDirProblem(workDir, { home, repositoryRoot }),
    ),
    // The package goes with its directory: whatever was not revoked is
    // worthless once the volume has gone, and no copy stays on the host.
    removeMadeDirectory(
      "credentials directory",
      credentialsDir,
      credentialsDirProblem(credentialsDir, { home, repositoryRoot, workDir }),
    ),
  );

  if (existsSync(paths.envFile)) {
    const emptied = Object.fromEntries(
      Object.keys(generatedSecrets).map((key) => [key, ""]),
    );
    writeFileSync(
      paths.envFile,
      withEnv(readFileSync(paths.envFile, "utf8"), emptied),
      { mode: 0o600 },
    );
    removed.push(
      `the generated secrets in ${paths.envFile}: ${Object.keys(generatedSecrets).join(", ")}`,
    );
  }

  log("");
  log("Removed:");
  for (const item of removed) {
    log(`  - ${item}`);
  }
  log(
    `Kept: the image ${image}, and ${paths.envFile} with the GitHub App's settings.`,
  );
  return removed;
}

if (import.meta.main) {
  const [command, action] = process.argv.slice(2);
  try {
    if (command === "stand-up") {
      standUp();
    } else if (command === "teardown") {
      teardown();
    } else if (command === "credentials" && action === "mint") {
      mintCredentialsPackage();
    } else if (command === "credentials" && action === "revoke") {
      revokeCredentialsPackage();
    } else {
      throw new StackError(
        "Run docker/pen-test/stand-up, docker/pen-test/credentials mint, docker/pen-test/credentials revoke or docker/pen-test/teardown.",
      );
    }
  } catch (error) {
    console.error(error instanceof StackError ? error.message : error);
    process.exitCode = 1;
  }
}
