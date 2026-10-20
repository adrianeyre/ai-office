import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

import {
  createBindMountSandboxProvider,
  type SandboxProvider,
} from "@ai-hero/sandcastle";

// The `docker run` of every container AI Office starts for an Agent
// (pen-testing S2-4): a task's or a Grilling Session's sandbox, started
// here as a Sandcastle bind-mount provider, and a Manager chat session or a
// subscription's model call, started by `dockerToolRunner`. Both take
// `sandboxHardening`, so the two cannot drift apart. Sandcastle's own
// Docker provider has no way to pass these flags, so AI Office starts the
// container itself, as that provider does otherwise: the same mounts,
// environment, user and working directory, with `docker exec` for each
// command.
//
// Without them a container gets Docker's defaults: its default capability
// set, no `no-new-privileges`, no memory or process limit and a writable
// root filesystem. With them it holds no capability, cannot gain one
// through a setuid binary, has bounded memory and processes, and writes
// only where it works: what is mounted for its work, and its home and
// `/tmp`, each a volume of its own that Docker fills from the image and
// removes with the container.
//
// Each such container also has a Docker network of its own
// (pen-testing S2-5, ADR 0006), `sandboxNetwork`: internal, made just
// before it and removed just after, with the sandbox relay joined to it as
// `sandbox-relay`. So it reaches the AI Gateway and the relay's proxy at
// the same names as on the one network every sandbox used to share, and no
// other sandbox, of its own Floor or another's.

/** The most memory one sandbox may use, as `docker run --memory` takes it. */
export const sandboxMemory = "4g";

/** The most processes and threads one sandbox may run at once. */
export const sandboxPidsLimit = 4096;

/**
 * Where a sandbox writes besides what is mounted for its work: its home
 * (the agent tool's state, package caches, `~/.gitconfig`) and `/tmp`.
 */
export const sandboxWritablePaths = ["/home/agent", "/tmp"] as const;

/** The flags every container AI Office starts for an Agent is run with. */
export const sandboxHardening: readonly string[] = [
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--memory",
  sandboxMemory,
  "--pids-limit",
  String(sandboxPidsLimit),
  "--read-only",
  // Anonymous volumes: Docker copies the image's files there first, so the
  // agent tool installed in the home and the folders made for the Skills
  // are kept, and `docker rm -v` (or `--rm`) removes them.
  ...sandboxWritablePaths.flatMap((target) => [
    "--mount",
    `type=volume,target=${target}`,
  ]),
];

/** The sandbox's home, as the sandbox images make it. */
const sandboxHome = "/home/agent";

/** The most of each stream's output a streamed command's result keeps. */
const maxTailChars = 64 * 1024;

const dockerOutput = (args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
        } else {
          const said = stderr.trim();
          reject(
            new Error(
              `docker ${args[0] ?? ""} failed: ${said === "" ? error.message : said}`,
            ),
          );
        }
      },
    );
  });

/** Runs each `docker` command in turn, now; for when AI Office exits. */
const dockerNow = (...commands: readonly (readonly string[])[]) => {
  for (const args of commands) {
    try {
      execFileSync("docker", args, { stdio: "ignore" });
    } catch {
      // Gone already, or Docker is: nothing more can be done on exit.
    }
  }
};

/** Removes container `name` with its volumes, if it is there. */
export const removeContainer = (name: string): Promise<void> =>
  dockerOutput(["rm", "--force", "--volumes", name]).then(
    () => undefined,
    () => undefined,
  );

/** What to remove should AI Office exit while they run, by container. */
const running = new Map<string, () => void>();

const removeRunning = () => {
  for (const remove of running.values()) {
    remove();
  }
};

/** The compose service of the sandbox relay (`docker/sandbox-relay`). */
const relayService = "sandbox-relay";

/**
 * The label on each sandbox's own network, whose value is the network the
 * sandbox relay is on (`SANDBOX_NETWORK`).
 */
export const sandboxNetworkLabel = "ai-office.sandbox-network";

/** A sandbox's own network. */
export interface SandboxNetwork {
  readonly name: string;
  /** Takes the relay off it and removes it; never fails. */
  remove(): Promise<void>;
  /** The same, at once, for when AI Office exits. */
  removeNow(): void;
}

const lines = (output: string): string[] =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** The sandbox relay's container on `relayNetwork`, as compose started it. */
async function findRelay(relayNetwork: string): Promise<string> {
  const [relay] = lines(
    await dockerOutput([
      "ps",
      "--quiet",
      "--filter",
      `network=${relayNetwork}`,
      "--filter",
      `label=com.docker.compose.service=${relayService}`,
    ]),
  );
  if (relay === undefined) {
    throw new Error(
      `The sandbox relay is not running on the Docker network ${relayNetwork}: start it with the stack under compose, or with 'pnpm dev'.`,
    );
  }
  return relay;
}

const removeNetwork = async (network: string, relay: string) => {
  await dockerOutput([
    "network",
    "disconnect",
    "--force",
    network,
    relay,
  ]).catch(() => undefined);
  await dockerOutput(["network", "rm", network]).catch(() => undefined);
};

/** Each relay network's sweep, made once per AI Office process. */
const swept = new Map<string, Promise<void>>();

/**
 * Removes the networks an AI Office before this one left for
 * `relayNetwork`'s sandboxes, as one that crashed would, before this one
 * makes any: else Docker's address pools would run out.
 */
function sweep(relayNetwork: string, relay: string): Promise<void> {
  let done = swept.get(relayNetwork);
  if (done === undefined) {
    done = dockerOutput([
      "network",
      "ls",
      "--quiet",
      "--filter",
      `label=${sandboxNetworkLabel}=${relayNetwork}`,
    ])
      .then(async (output) => {
        for (const network of lines(output)) {
          await removeNetwork(network, relay);
        }
      })
      .catch(() => undefined);
    swept.set(relayNetwork, done);
  }
  return done;
}

/**
 * A network of its own for one sandbox (pen-testing S2-5): internal, so
 * it has no route out, labelled with `relayNetwork`, and with the sandbox
 * relay found on `relayNetwork` joined to it as `sandbox-relay`. Nothing
 * else joins it but the one sandbox.
 */
export async function sandboxNetwork(
  relayNetwork: string,
): Promise<SandboxNetwork> {
  const relay = await findRelay(relayNetwork);
  await sweep(relayNetwork, relay);
  const name = `ai-office-sandbox-${randomUUID()}`;
  await dockerOutput([
    "network",
    "create",
    "--internal",
    "--label",
    `${sandboxNetworkLabel}=${relayNetwork}`,
    name,
  ]);
  try {
    await dockerOutput([
      "network",
      "connect",
      "--alias",
      relayService,
      name,
      relay,
    ]);
  } catch (error) {
    await dockerOutput(["network", "rm", name]).catch(() => undefined);
    throw error;
  }
  return {
    name,
    remove: () => removeNetwork(name, relay),
    removeNow: () => {
      dockerNow(
        ["network", "disconnect", "--force", name, relay],
        ["network", "rm", name],
      );
    },
  };
}

/** Refuses an image whose user is not the one the sandbox runs as. */
async function checkImageUser(image: string, uid: number): Promise<void> {
  let user: string;
  try {
    user = (
      await dockerOutput([
        "image",
        "inspect",
        image,
        "--format",
        "{{.Config.User}}",
      ])
    ).trim();
  } catch {
    throw new Error(
      `Image '${image}' not found locally. Build it with 'pnpm sandbox:build'.`,
    );
  }
  const imageUid = Number.parseInt(user.split(":")[0] ?? "", 10);
  if (!Number.isNaN(imageUid) && imageUid !== uid) {
    throw new Error(
      `Image '${image}' runs as UID ${String(imageUid)}, but AI Office runs as ${String(uid)}. Build it again with 'pnpm sandbox:build'.`,
    );
  }
}

const tail = (text: string): string =>
  text.length <= maxTailChars ? text : text.slice(-maxTailChars);

/**
 * A Sandcastle bind-mount provider whose sandboxes are Docker containers
 * from `imageName`, run as AI Office's own user with `sandboxHardening`,
 * given `env` and `mounts` besides what Sandcastle mounts and passes. Given
 * `network`, the network the sandbox relay is on, each is attached to a
 * network of its own that the relay joins (`sandboxNetwork`).
 */
export function dockerProvider(options: {
  readonly imageName: string;
  readonly env: Record<string, string>;
  readonly mounts?: readonly {
    readonly hostPath: string;
    readonly sandboxPath: string;
    readonly readonly?: boolean;
  }[];
  readonly network?: string;
}): SandboxProvider {
  return createBindMountSandboxProvider({
    name: "docker",
    env: options.env,
    sandboxHomedir: sandboxHome,
    create: async (create) => {
      const name = `sandcastle-${randomUUID()}`;
      const worktreePath =
        create.mounts.find(({ hostPath }) => hostPath === create.worktreePath)
          ?.sandboxPath ?? `${sandboxHome}/workspace`;
      const mounts = [...create.mounts, ...(options.mounts ?? [])];
      for (const { hostPath } of options.mounts ?? []) {
        // Docker would make a missing one, as root.
        if (!existsSync(hostPath)) {
          throw new Error(`Mount hostPath does not exist: ${hostPath}`);
        }
      }
      const uid = process.getuid?.() ?? 1000;
      const gid = process.getgid?.() ?? 1000;
      await checkImageUser(options.imageName, uid);
      const own =
        options.network === undefined
          ? undefined
          : await sandboxNetwork(options.network);
      running.set(name, () => {
        dockerNow(["rm", "--force", "--volumes", name]);
        own?.removeNow();
      });
      if (running.size === 1) {
        process.on("exit", removeRunning);
      }
      const forget = () => {
        running.delete(name);
        if (running.size === 0) {
          process.removeListener("exit", removeRunning);
        }
      };
      // The container, with its volumes, then its network.
      const remove = async () => {
        forget();
        await removeContainer(name);
        await own?.remove();
      };
      try {
        await dockerOutput([
          "run",
          "-d",
          "--name",
          name,
          ...Object.entries({ ...create.env, HOME: sandboxHome }).flatMap(
            ([key, value]) => ["-e", `${key}=${value}`],
          ),
          // `z`: a shared SELinux label, a no-op where there is no SELinux.
          ...mounts.flatMap(({ hostPath, sandboxPath, readonly }) => [
            "-v",
            `${hostPath}:${sandboxPath}:${readonly === true ? "ro," : ""}z`,
          ]),
          "-w",
          worktreePath,
          "--user",
          `${String(uid)}:${String(gid)}`,
          ...(own === undefined ? [] : ["--network", own.name]),
          ...sandboxHardening,
          options.imageName,
        ]);
      } catch (error) {
        await remove();
        throw error;
      }
      return {
        worktreePath,
        exec: (command, execOptions) =>
          new Promise((resolve, reject) => {
            const child = spawn(
              "docker",
              [
                "exec",
                ...(execOptions?.stdin === undefined ? [] : ["-i"]),
                ...(execOptions?.cwd === undefined
                  ? []
                  : ["-w", execOptions.cwd]),
                name,
                "sh",
                "-c",
                execOptions?.sudo === true ? `sudo ${command}` : command,
              ],
              // Without `stdin`, it is closed at once.
              { stdio: ["pipe", "pipe", "pipe"] },
            );
            // A command that exits before reading it all is not an error.
            child.stdin.on("error", () => undefined);
            child.stdin.end(execOptions?.stdin);
            child.on("error", (error) => {
              reject(new Error(`docker exec failed: ${error.message}`));
            });
            let stdout = "";
            let stderr = "";
            child.stderr.on("data", (chunk: Buffer) => {
              stderr = tail(stderr + chunk.toString());
            });
            const onLine = execOptions?.onLine;
            if (onLine === undefined) {
              child.stdout.on("data", (chunk: Buffer) => {
                stdout += chunk.toString();
              });
            } else {
              // Each line as it comes, which Sandcastle's idle timeout and
              // the live view depend on.
              createInterface({ input: child.stdout }).on("line", (line) => {
                stdout = tail(stdout === "" ? line : `${stdout}\n${line}`);
                onLine(line);
              });
            }
            child.on("close", (code) => {
              resolve({ stdout, stderr, exitCode: code ?? 0 });
            });
          }),
        copyFileIn: async (hostPath, sandboxPath) => {
          await dockerOutput(["cp", hostPath, `${name}:${sandboxPath}`]);
        },
        copyFileOut: async (sandboxPath, hostPath) => {
          await dockerOutput(["cp", `${name}:${sandboxPath}`, hostPath]);
        },
        // Its home and `/tmp` volumes go with it, then its network.
        close: remove,
      };
    },
  });
}
