import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  ConfigError,
  developmentSecretsInUse,
  loadConfig,
} from "../apps/server/src/config.ts";
import {
  makeWorkDir,
  WorkDirError,
} from "../packages/orchestrator/src/sandbox/work-dir.ts";

// I2 probe (pen-testing, "Infrastructure and delivery"), H21: Agents under
// compose. The `sandbox-dir` service runs as root and runs
// `mkdir -p "$DIR" && chown 1000:1000 "$DIR"` on a host directory
// (AI_OFFICE_SANDBOX_DIR, /tmp/ai-office-sandboxes by default) before the
// app starts, and the app and the host's Docker bind-mount the same path.
// This reads docker-compose.yml, and runs the service's own shell command
// against a world-writable temp directory standing in for /tmp, as another
// local user who got there first. Running the real stack needs Docker and a
// second host account, which this sandbox lacks. See
// docs/pen-testing/assessments/I2.md.
//
// Fixed (I2-4, issue #329): the default is out of /tmp, and the service
// takes only a directory Docker has just made or one of the app's, refusing
// a link or another user's; these now run its own script.

const run = promisify(execFile);
const root = join(import.meta.dirname, "..");

interface ComposeService {
  image?: string;
  user?: string;
  command?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  network_mode?: string;
}

const composeText = await readFile(join(root, "docker-compose.yml"), "utf8");
const compose = parse(composeText) as {
  services: Record<string, ComposeService>;
};
const { "sandbox-dir": sandboxDir, app } = compose.services as Record<
  "sandbox-dir" | "app",
  ComposeService
>;

/** How compose names the work directory: AI_OFFICE_SANDBOX_DIR, or a default. */
const workDirSetting = sandboxDir.environment?.["SANDBOX_WORK_DIR"] ?? "";

/** The default host path, as compose interpolates it with no .env. */
const defaultPath =
  /^\$\{AI_OFFICE_SANDBOX_DIR:-(.+)\}$/.exec(workDirSetting)?.[1] ?? "";

/** The one shell command the `sandbox-dir` service runs. */
const command = (sandboxDir.command ?? []).join("\n");

/** The service's script, as compose hands it to `sh -c` (`$$` is `$`). */
const serviceScript = (sandboxDir.command?.[2] ?? "").replaceAll("$$", "$");

/** This test's own user and group, standing in for the app's. */
const ownIds = {
  APP_UID: String(process.getuid?.() ?? 1000),
  APP_GID: String(process.getgid?.() ?? 1000),
};
/** An app user who is not this test's: whatever this test makes is another's. */
const otherIds = {
  APP_UID: ownIds.APP_UID === "1000" ? "1001" : "1000",
  APP_GID: ownIds.APP_GID === "1000" ? "1001" : "1000",
};

/**
 * Runs the service's own script on `target` (as root runs it in its
 * container, but as this test's user), for an app user of `ids`.
 */
const serviceOn = (target: string, ids: Record<string, string> = ownIds) =>
  run("sh", ["-c", serviceScript], {
    env: { ...process.env, SANDBOX_WORK_DIR: target, ...ids },
  });

describe("I2: the sandbox-dir service, read from compose", () => {
  it("regression (I2-4): it still runs as root on AI_OFFICE_SANDBOX_DIR, but no longer mkdir -p and chown through a link, and no longer defaults under the world-writable /tmp", () => {
    expect(sandboxDir.user).toBe("root");
    expect(command).not.toContain("mkdir -p");
    expect(command).not.toMatch(/chown (?!-h )/);
    expect(command).toContain('chown -h "$$APP_UID:$$APP_GID" "$$dir"');
    expect(sandboxDir.environment?.["APP_UID"]).toBe("1000");
    expect(sandboxDir.environment?.["APP_GID"]).toBe("1000");
    expect(workDirSetting).toBe(
      "${AI_OFFICE_SANDBOX_DIR:-${HOME}/.ai-office/sandboxes}",
    );
    // The default is no longer under /tmp, shared with every local user.
    expect(defaultPath.startsWith("/tmp/")).toBe(false);
  });

  it("holds: the same host path is bind-mounted into the app, read-write", () => {
    const mount = `\${AI_OFFICE_SANDBOX_DIR:-${defaultPath}}:\${AI_OFFICE_SANDBOX_DIR:-${defaultPath}}`;
    expect(app.volumes).toContain(mount);
    // No `:ro`: the app writes clones there, so it is read-write.
    expect(
      app.volumes?.some((v) => v.startsWith(mount) && v.endsWith(":ro")),
    ).not.toBe(true);
  });

  it("I2-4: the sandbox-dir service refuses to operate on a path a non-root user could have created or pointed elsewhere (a symlink-safe, ownership-checked mkdir), or the directory does not sit under a world-writable parent", () => {
    const guarded =
      command.includes("--no-dereference") ||
      command.includes("test -h") ||
      command.includes("readlink") ||
      command.includes("-print0");
    const notInWorldWritableTmp = !defaultPath.startsWith("/tmp/");
    expect(guarded || notInWorldWritableTmp).toBe(true);
    // Both, since the fix: a link is refused, the owner checked, the
    // chown never follows a link, and the default is out of /tmp, in the
    // home directory of whoever runs compose.
    expect(guarded).toBe(true);
    expect(command).toContain('test -h "$$dir"');
    expect(command).toContain('stat -c %u "$$dir"');
    expect(command).toContain("chown -h");
    expect(notInWorldWritableTmp).toBe(true);
    expect(defaultPath).toBe("${HOME}/.ai-office/sandboxes");
  });
});

describe("I2-4: another local user got to the path first", () => {
  let base: string;
  const made: string[] = [];

  const scratch = async (): Promise<string> => {
    // 0o1777: world-writable and sticky, as /tmp is.
    const dir = await mkdtemp(join(tmpdir(), "i2-tmp-"));
    made.push(dir);
    return dir;
  };

  beforeEach(async () => {
    base = await scratch();
  });

  afterAll(async () => {
    await Promise.all(
      made.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  // The service's own script, run as this test's user. The app's user is
  // another (`otherIds`), so what this test makes is "another local
  // user's", as the attacker's would be.
  const mkdirStep = (target: string) => serviceOn(target, otherIds);

  it("regression (I2-4): a directory another user pre-created is refused, not adopted, and nothing is chowned", async () => {
    const target = join(base, "ai-office-sandboxes");
    // The attacker gets there first and leaves something behind.
    await mkdir(target);
    await writeFile(join(target, "planted"), "the attacker was here");

    const refused = await mkdirStep(target).then(
      () => undefined,
      (error: unknown) => error as { stderr: string },
    );

    // The stand-up fails, saying why; the app (which waits for it) never
    // starts on the attacker's directory.
    expect(refused?.stderr).toMatch(/belongs to UID \d+, so it is not taken/);
    expect((await stat(target)).uid).toBe(process.getuid?.());
    const planted = await readFile(join(target, "planted"), "utf8");
    expect(planted).toBe("the attacker was here");
  });

  it("regression (I2-4): a symlink left at the path is refused, not followed, so nothing lands on the attacker's chosen target", async () => {
    const elsewhere = join(base, "elsewhere");
    await mkdir(elsewhere);
    const target = join(base, "ai-office-sandboxes");
    // The attacker points the path at a directory of their choosing, even
    // one the app's own user owns.
    await symlink(elsewhere, target);

    for (const ids of [otherIds, ownIds]) {
      await expect(serviceOn(target, ids)).rejects.toMatchObject({
        stderr: expect.stringContaining("is a symbolic link") as string,
      });
    }
    expect(await readdir(elsewhere)).toEqual([]);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });

  it("I2-4: a pre-created or symlinked path is refused rather than adopted", async () => {
    const target = join(base, "ai-office-sandboxes");
    const elsewhere = join(base, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, target);
    // The property: the stand-up fails loudly when the path is not a
    // fresh directory it owns. mkdir -p does the opposite.
    await expect(mkdirStep(target)).rejects.toBeTruthy();
  });

  it("holds since I2-4: a path that is not there is made and given to the app's user, and the app's own directory from before is taken as it is", async () => {
    const target = join(base, "ai-office-sandboxes");
    await serviceOn(target);
    expect((await lstat(target)).isDirectory()).toBe(true);
    expect(String((await stat(target)).uid)).toBe(ownIds.APP_UID);
    await writeFile(join(target, "a-clone"), "kept");
    await serviceOn(target);
    expect(await readdir(target)).toEqual(["a-clone"]);
  });

  it("holds since I2-4: something that is not a directory, or a root directory with something in it (as a link to one would mount), is refused", async () => {
    const file = join(base, "ai-office-sandboxes");
    await writeFile(file, "");
    await expect(serviceOn(file)).rejects.toMatchObject({
      stderr: expect.stringContaining("is not a directory") as string,
    });
    // Docker mounts what a link points at, so the script sees, say, /etc.
    await expect(serviceOn("/etc")).rejects.toMatchObject({
      stderr: expect.stringContaining("is root's and not empty") as string,
    });
  });

  // The same flaw in the app itself: under `pnpm dev` it makes the work
  // directory in /tmp, as its own user, with `mkdir -p`.
  it("holds since I2-4: the app's own making of the work directory refuses a link or another user's directory too", async () => {
    const target = join(base, "ai-office-sandboxes");
    const elsewhere = join(base, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, target);
    await expect(makeWorkDir(target)).rejects.toThrow(WorkDirError);
    expect(await readdir(elsewhere)).toEqual([]);
  });
});

describe("I2: `.env.example` set for development, re-assessed with G1-8", () => {
  const envExample = (() => {
    const text = readFileSync(join(root, ".env.example"), "utf8");
    return Object.fromEntries(
      text
        .split("\n")
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
  })();

  it("regression (G1-8): a copied .env still yields the public secrets, DOCKER_GID=0 and AI_OFFICE_DOMAIN=localhost, but compose published beyond loopback no longer starts with them", () => {
    // The secrets are G1-8's (apps/server/src/config.pen-test.test.ts); not
    // re-filed here. This records the two compose-only defaults alongside.
    expect(envExample["SESSION_SECRET"]).toBe(
      "development-only-session-secret-change-me",
    );
    expect(envExample["ENCRYPTION_KEY"]).toBe(
      "ZGV2LW9ubHktYWktb2ZmaWNlLWVuY3J5cHRpb24ta3k=",
    );
    expect(envExample["POSTGRES_PASSWORD"]).toBe("devpassword");
    expect(envExample["DOCKER_GID"]).toBe("0");
    expect(envExample["AI_OFFICE_DOMAIN"]).toBe("localhost");
    // Compose hands the app AI_OFFICE_BIND_ADDRESS as PUBLISHED_ADDRESS.
    // On the host's loopback the samples still run; opened beyond it, the
    // server refuses them (G1-8, issue #283).
    expect(app.environment?.["PUBLISHED_ADDRESS"]).toBe(
      "${AI_OFFICE_BIND_ADDRESS:-127.0.0.1}",
    );
    const served = (address: string) => ({
      ...envExample,
      HOST: "0.0.0.0",
      PUBLISHED_ADDRESS: address,
    });
    expect(developmentSecretsInUse(loadConfig(served("127.0.0.1")))).toEqual([
      "SESSION_SECRET",
      "ENCRYPTION_KEY",
      "POSTGRES_PASSWORD",
    ]);
    const refused = (() => {
      try {
        loadConfig(served("0.0.0.0"));
      } catch (error) {
        if (error instanceof ConfigError) {
          return error.problems;
        }
        throw error;
      }
      return [];
    })();
    expect(refused).toHaveLength(3);
    for (const problem of refused) {
      expect(problem).toMatch(/is the public sample/);
      expect(problem).toContain("(PUBLISHED_ADDRESS)");
    }
  });

  it("holds: AI_OFFICE_DOMAIN=localhost keeps the tls profile on localhost's own CA, not beyond this machine", () => {
    // Compose defaults it to localhost too, so `--profile tls` without a
    // domain serves localhost with Caddy's local CA: no exposure beyond
    // the host, and the .env.example comment says to set a real domain.
    expect(compose.services["caddy"]?.environment?.["AI_OFFICE_DOMAIN"]).toBe(
      "${AI_OFFICE_DOMAIN:-localhost}",
    );
  });

  it("holds: DOCKER_GID=0 adds the container's process to the root group, which is no wider than the Docker socket it already holds", () => {
    // group_add defaults to 0; on Docker Desktop the socket is reachable so
    // (default) and on Linux the Owner is told to set the docker group. The
    // socket is already root on the host (the S-series), so gid 0 widens no
    // trust boundary. Recorded, not re-filed.
    expect(app.volumes).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(composeText).toContain("${DOCKER_GID:-0}");
  });
});

describe("I2-5: the clones' permissions on the host", () => {
  const made: string[] = [];

  afterAll(async () => {
    await Promise.all(
      made.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  const scratch = async (): Promise<string> => {
    const base = await mkdtemp(join(tmpdir(), "i2-clones-"));
    made.push(base);
    return base;
  };

  // Fixed: the app makes it with `makeWorkDir` (runner.ts, fact-finding.ts
  // and chat-sessions.ts, and the server for the root as it starts), 0700
  // whatever the umask, and the sandbox-dir service leaves it 0700.
  it("regression (I2-5): the work directory the app creates is no longer traversable or readable by other local users (not 0755)", async () => {
    const workDir = join(await scratch(), "ai-office-sandboxes", "runs");
    await makeWorkDir(workDir);
    const mode = (await stat(workDir)).mode & 0o777;
    // Group and other can no longer enter or read it.
    expect(mode & 0o055).toBe(0);
  });

  it("I2-5: the sandboxes' work directory is private to its owner (no group or other access)", async () => {
    const workDir = join(await scratch(), "ai-office-sandboxes", "runs");
    await makeWorkDir(workDir);
    const mode = (await stat(workDir)).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it("holds since I2-5: the root above it, and a directory made before the fix, are private too, so no clone beneath is reachable", async () => {
    const root = join(await scratch(), "ai-office-sandboxes");
    await makeWorkDir(join(root, "runs"));
    expect((await stat(root)).mode & 0o077).toBe(0);
    // As 0755 from before the fix, with a clone in it.
    const before = join(await scratch(), "ai-office-sandboxes");
    await mkdir(join(before, "runs", "a-clone"), { recursive: true });
    await chmod(before, 0o755);
    await makeWorkDir(before);
    expect((await stat(before)).mode & 0o777).toBe(0o700);
  });

  it("holds since I2-5: the sandbox-dir service leaves the directory private to the app's user, whether it made it or found it", async () => {
    expect(command).toContain('chmod 0700 "$$dir"');
    const fresh = join(await scratch(), "ai-office-sandboxes");
    await serviceOn(fresh);
    expect((await stat(fresh)).mode & 0o777).toBe(0o700);
    await chmod(fresh, 0o755);
    await serviceOn(fresh);
    expect((await stat(fresh)).mode & 0o777).toBe(0o700);
  });
});
