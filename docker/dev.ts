// `pnpm dev`: AI Office for development, every service in Docker
// (docker-compose.dev.yml), in the foreground until Ctrl+C. It copies
// .env.example to .env if there is no .env, builds any sandbox image not
// built yet (docker/sandbox-build.ts), makes the sandboxes' work directory,
// and starts the stack as the user running it, with the group that owns
// Docker's socket, so the server can start Agents' sandboxes.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, posix, win32 } from "node:path";

const root = join(import.meta.dirname, "..");

/** The workspace packages whose node_modules docker-compose.dev.yml mounts. */
export const workspaceNodeModules = [
  "node_modules",
  "apps/server/node_modules",
  "apps/web/node_modules",
  "packages/communications/node_modules",
  "packages/db/node_modules",
  "packages/events/node_modules",
  "packages/gateway/node_modules",
  "packages/github/node_modules",
  "packages/orchestrator/node_modules",
  "packages/shared/node_modules",
  "e2e/node_modules",
] as const;

/**
 * Where the sandboxes' work directory is on Windows when
 * AI_OFFICE_DEV_SANDBOX_DIR is not set: in Docker Desktop's Linux VM, as
 * docs/guide/running.md has it for docker-compose.yml. A Windows folder,
 * shared into the VM, will not do: it is root's there, and cannot be given
 * to the server's user, so the server refuses it.
 */
export const windowsSandboxDir = "/home/ai-office/dev-sandboxes";

/** Whether `path` is a Windows one, such as C:\Users\me or \\server\share. */
export const isWindowsPath = (path: string): boolean =>
  /^(?:[A-Za-z]:|\\)/.test(path);

/**
 * The variables docker-compose.dev.yml takes from `pnpm dev`: the user
 * and group the server and Vite run as, the group that owns Docker's
 * socket, the sandboxes' work directory, the HTTPS proxy's directory and
 * the public address, https://ai-office.localhost with the HTTPS port unless
 * it is 443. A value already set wins. The sandbox directory is at the same
 * path in the server's container as for the Docker daemon, which
 * bind-mounts it into the sandboxes: ~/.ai-office/dev-sandboxes, or on
 * Windows windowsSandboxDir.
 */
export function devEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  user: { readonly uid: number; readonly gid: number },
  dockerSocketGid: number | undefined,
  home: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  const { join } = platform === "win32" ? win32 : posix;
  // Root has no business owning an Agent's files: the images' default, as
  // docker/sandbox-build.ts has it.
  const uid = user.uid > 0 ? user.uid : 1000;
  const gid = user.gid > 0 ? user.gid : 1000;
  const value = (name: string, fallback: string) => {
    const set = env[name];
    return set === undefined || set === "" ? fallback : set;
  };
  return {
    AI_OFFICE_DEV_UID: value("AI_OFFICE_DEV_UID", String(uid)),
    AI_OFFICE_DEV_GID: value("AI_OFFICE_DEV_GID", String(gid)),
    // Docker Desktop's socket is root's, inside its VM.
    AI_OFFICE_DEV_DOCKER_GID: value(
      "AI_OFFICE_DEV_DOCKER_GID",
      String(dockerSocketGid ?? 0),
    ),
    AI_OFFICE_DEV_SANDBOX_DIR: value(
      "AI_OFFICE_DEV_SANDBOX_DIR",
      platform === "win32"
        ? windowsSandboxDir
        : join(home, ".ai-office", "dev-sandboxes"),
    ),
    AI_OFFICE_DEV_CADDY_DIR: value(
      "AI_OFFICE_DEV_CADDY_DIR",
      join(home, ".ai-office", "dev-caddy"),
    ),
    AI_OFFICE_DEV_PUBLIC_URL: value(
      "AI_OFFICE_DEV_PUBLIC_URL",
      new URL(
        `https://ai-office.localhost:${value("AI_OFFICE_DEV_HTTPS_PORT", "443")}`,
      ).origin,
    ),
  };
}

/** Runs `command`, resolving with its exit code; Ctrl+C is left to it. */
const run = (command: string, args: readonly string[], env = process.env) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 130));
    });
  });

if (import.meta.main) {
  // Ctrl+C reaches compose too, which stops the stack; wait for it.
  process.on("SIGINT", () => undefined);
  process.on("SIGTERM", () => undefined);

  const envFile = join(root, ".env");
  if (!existsSync(envFile)) {
    copyFileSync(join(root, ".env.example"), envFile);
    console.log(
      "Copied .env.example to .env, which works as is for development.",
    );
  }
  process.loadEnvFile(envFile);

  let dockerSocketGid: number | undefined;
  try {
    dockerSocketGid = statSync("/var/run/docker.sock").gid;
  } catch {
    dockerSocketGid = undefined;
  }
  const dev = devEnvironment(
    process.env,
    userInfo(),
    dockerSocketGid,
    homedir(),
    process.platform,
  );
  const env = { ...process.env, ...dev };
  const compose = ["compose", "--file", "docker-compose.dev.yml"];
  const sandboxes = dev["AI_OFFICE_DEV_SANDBOX_DIR"] ?? "";

  // Made here, as this user: Docker would make them as root. On Windows,
  // the sandbox directory is in Docker Desktop's VM, so sandbox-dir makes
  // it there, as root, and gives it to the server's user.
  const windows = process.platform === "win32";
  if (windows && isWindowsPath(sandboxes)) {
    console.error(
      `AI_OFFICE_DEV_SANDBOX_DIR is ${sandboxes}, a Windows folder, which Docker Desktop shares into its VM as root's, so the server cannot take it for Agents' clones. Set a Linux-style path, a directory in Docker Desktop's VM, or leave it empty for ${windowsSandboxDir}.`,
    );
    process.exit(1);
  }
  if (!windows) {
    mkdirSync(sandboxes, { recursive: true, mode: 0o700 });
  }
  for (const path of workspaceNodeModules) {
    mkdirSync(join(root, path), { recursive: true });
  }
  const caddyDir = dev["AI_OFFICE_DEV_CADDY_DIR"] ?? "";
  mkdirSync(caddyDir, { recursive: true, mode: 0o700 });
  console.log(
    `AI Office will be at ${dev["AI_OFFICE_DEV_PUBLIC_URL"] ?? ""}. Its certificate is from Caddy's local CA: trust ${join(caddyDir, "caddy", "pki", "authorities", "local", "root.crt")} (made on the first run) in your browser once.`,
  );

  const steps: [string, string[], NodeJS.ProcessEnv][] = [
    // For the user the server runs as, which the sandboxes run as too.
    [
      "node",
      ["docker/sandbox-build.ts", "--missing"],
      {
        AGENT_UID: dev["AI_OFFICE_DEV_UID"],
        AGENT_GID: dev["AI_OFFICE_DEV_GID"],
        ...env,
      },
    ],
    ...(windows
      ? [
          [
            "docker",
            [...compose, "run", "--rm", "sandbox-dir"],
            env,
          ] satisfies [string, string[], NodeJS.ProcessEnv],
        ]
      : []),
    ["docker", [...compose, "up", "--build", "--remove-orphans"], env],
  ];
  for (const [command, args, stepEnv] of steps) {
    const code = await run(command, args, stepEnv);
    if (code !== 0) {
      process.exit(code);
    }
  }
}
