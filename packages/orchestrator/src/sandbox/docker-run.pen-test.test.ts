import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dockerToolRunner } from "../models/agent-tool-client.ts";
import {
  sandboxHardening,
  sandboxMemory,
  sandboxPidsLimit,
  sandboxWritablePaths,
} from "./docker.ts";
import { allowListed } from "./environment.ts";
import { dockerSandbox } from "./runner.ts";

// Probe S2 (H2, H3): the `docker run` a sandbox is started with.
//
// AI Office starts containers for Agents two ways:
// - `dockerSandbox` (`runner.ts`), Sandcastle's Docker provider until S2-4
//   and AI Office's own since (`docker.ts`), for each task's sandbox and a
//   Grilling Session's fact-finding;
// - `dockerToolRunner` (`models/agent-tool-client.ts`), its own
//   `docker run`, for the Manager chat's sessions and model calls a
//   subscription serves through Claude Code or Codex.
//
// There is no Docker here, so each test puts a stand-in `docker` first on
// the PATH. It records the arguments it is called with and answers as the
// real CLI would for what is asked (`image inspect`, `ps`, `run -d`), and
// the real provider and runner are driven against it. What the stand-in
// records is the exact `docker run` the live stack would issue.
//
// A container started this way got Docker's defaults for whatever the
// run did not say: its default capability set, no `no-new-privileges`,
// no memory or PID limit, a writable root filesystem (S2-4). Both runs now
// take `sandboxHardening` (`sandbox/docker.ts`). Docker's default seccomp
// and AppArmor profiles do apply, since nothing turns them off.
// See docs/pen-testing/assessments/S2.md.

let bin: string;
let log: string;
/** Where the runs' directories are, as AI Office's work directory. */
let root: string;
let path: string | undefined;

beforeEach(async () => {
  bin = await mkdtemp(join(tmpdir(), "s2-docker-"));
  log = join(bin, "calls.jsonl");
  root = join(bin, "srv", "ai-office");
  await mkdir(join(root, "runs", "sbx-1-skills", "claude"), {
    recursive: true,
  });
  // Each call's arguments as one JSON line; `image inspect` answers that
  // the image sets no user, `ps` that the sandbox relay is `relay0123`
  // (unless S2_NO_RELAY is set), and `network ls` that an AI Office before
  // left `left-behind-1` for the relay network `ai-office-sandboxes-left`.
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "run" && args.includes("-d")) process.stdout.write("0123abcd\\n");
if (args[0] === "ps" && args.includes("label=com.docker.compose.service=sandbox-relay") && !process.env.S2_NO_RELAY) process.stdout.write("relay0123\\n");
if (args[0] === "network" && args[1] === "ls" && args.includes("label=ai-office.sandbox-network=ai-office-sandboxes-left")) process.stdout.write("left-behind-1\\n");
`,
  );
  await chmod(join(bin, "docker"), 0o755);
  path = process.env["PATH"];
  process.env["PATH"] = `${bin}:${path ?? ""}`;
});

afterEach(async () => {
  process.env["PATH"] = path;
  await rm(bin, { recursive: true, force: true });
});

const calls = async (): Promise<string[][]> =>
  (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);

/** The `docker run` a task's sandbox is started with, on `network`. */
async function sandboxRun(network = "ai-office-sandboxes"): Promise<string[]> {
  const workspace = `${root}/runs/sbx-1`;
  const worktree = `${workspace}/.sandcastle/worktrees/ai-office-7-fix`;
  const provider = allowListed(
    dockerSandbox({ network })(
      {
        GH_TOKEN: "ghs_fake_read_only_token_for_probe",
        ANTHROPIC_BASE_URL: "http://app:3047",
      },
      "Claude Code",
      [
        {
          hostPath: `${root}/runs/sbx-1-skills/claude`,
          sandboxPath: "/home/agent/.claude/skills",
          readonly: true,
        },
      ],
    ),
  ) as unknown as {
    create(options: {
      worktreePath: string;
      hostRepoPath: string;
      mounts: { hostPath: string; sandboxPath: string; readonly?: boolean }[];
      env: Record<string, string>;
    }): Promise<{ close(): Promise<void> }>;
  };
  // The mounts Sandcastle's `branch` strategy passes: the worktree, its
  // `.git` file and the clone's `.git` directory (`resolveGitMounts`).
  const handle = await provider.create({
    worktreePath: worktree,
    hostRepoPath: workspace,
    mounts: [
      { hostPath: worktree, sandboxPath: "/home/agent/workspace" },
      { hostPath: `${worktree}/.git`, sandboxPath: `${worktree}/.git` },
      { hostPath: `${workspace}/.git`, sandboxPath: `${workspace}/.git` },
    ],
    // What Sandcastle gathers for the sandbox: the provider's environment,
    // plus anything named in a repository's `.sandcastle/.env` and found in
    // the app's own environment (fake values here).
    env: {
      GH_TOKEN: "ghs_fake_read_only_token_for_probe",
      ANTHROPIC_BASE_URL: "http://app:3047",
      DATABASE_URL: "postgres://fake:fake@postgres:3048/fake",
      SESSION_SECRET: "fake-session-secret-for-probe",
    },
  });
  await handle.close();
  const run = (await calls()).find((args) => args[0] === "run");
  if (run === undefined) {
    throw new Error("No docker run was issued.");
  }
  return run;
}

/** The `docker run` a Manager chat session is started with. */
async function toolRun(): Promise<string[]> {
  const run = dockerToolRunner({ network: "ai-office-sandboxes" });
  const lines = run({
    tool: "Claude Code",
    image: "ai-office/sandbox-claude:6",
    args: ["--print"],
    environment: { ANTHROPIC_BASE_URL: "http://app:3047" },
    input: "",
    mounts: [
      {
        host: `${root}/manager-chat/floor-1/repo`,
        container: "/home/agent/workspace",
        readOnly: true,
      },
      {
        host: `${root}/manager-chat/floor-1/claude`,
        container: "/home/agent/.claude",
        readOnly: false,
      },
    ],
    workdir: "/home/agent/workspace",
    signal: new AbortController().signal,
  });
  // The stand-in runs nothing, so the tool says nothing.
  const said: string[] = [];
  for await (const line of lines) {
    said.push(line);
  }
  expect(said).toEqual([]);
  const found = (await calls()).find((args) => args[0] === "run");
  if (found === undefined) {
    throw new Error("No docker run was issued.");
  }
  return found;
}

/** The value of each `--flag value` or `--flag=value` in `args`. */
const values = (args: readonly string[], flag: string): string[] =>
  args.flatMap((arg, index) =>
    arg === flag
      ? [args[index + 1] ?? ""]
      : arg.startsWith(`${flag}=`)
        ? [arg.slice(flag.length + 1)]
        : [],
  );

const both = [
  ["a task's sandbox (dockerSandbox)", () => sandboxRun()],
  ["a Manager chat session (dockerToolRunner)", toolRun],
] as const;

describe.each(both)("S2: the docker run of %s", (_, start) => {
  describe("what holds", () => {
    it("is not privileged, shares no host namespace and passes no device", async () => {
      const args = await start();
      expect(args).not.toContain("--privileged");
      for (const flag of [
        "--pid",
        "--ipc",
        "--uts",
        "--userns",
        "--cgroupns",
      ]) {
        expect(values(args, flag)).not.toContain("host");
      }
      expect(values(args, "--network")).not.toContain("host");
      expect(values(args, "--device")).toEqual([]);
      expect(values(args, "--cap-add")).toEqual([]);
    });

    it("leaves Docker's default seccomp and AppArmor profiles on", async () => {
      const options = values(await start(), "--security-opt");
      expect(options.filter((option) => option.endsWith("unconfined"))).toEqual(
        [],
      );
    });

    it("never mounts the Docker socket or anything of the host's but its own directories", async () => {
      const args = await start();
      const mounted = [...values(args, "-v"), ...values(args, "--mount")];
      expect(mounted.join("\n")).not.toContain("docker.sock");
      // Since S2-4 its home and /tmp are volumes: anonymous, so nothing of
      // the host's and nothing another sandbox shares, and only those two.
      const volumes = mounted.filter((mount) =>
        mount.startsWith("type=volume,"),
      );
      expect(volumes).toEqual([
        "type=volume,target=/home/agent",
        "type=volume,target=/tmp",
      ]);
      for (const mount of mounted.filter((m) => !volumes.includes(m))) {
        expect(mount).toContain(root);
      }
    });

    // Since S2-5 that network is its own, not the one every sandbox shared.
    it("joins a sandboxes' network of its own, not the host's", async () => {
      const networks = values(await start(), "--network");
      expect(networks).toHaveLength(1);
      expect(networks[0]).toMatch(/^ai-office-sandbox-[0-9a-f-]{36}$/);
      expect(networks).not.toContain("host");
    });
  });

  describe("S2-4: hardening beyond Docker's defaults", () => {
    it("drops every capability the agent tool does not need", async () => {
      expect(values(await start(), "--cap-drop")).toContain("ALL");
    });

    it("sets no-new-privileges", async () => {
      expect(values(await start(), "--security-opt")).toContain(
        "no-new-privileges",
      );
    });

    it("limits its memory and its number of processes", async () => {
      const args = await start();
      expect(values(args, "--memory")).not.toEqual([]);
      expect(values(args, "--pids-limit")).not.toEqual([]);
    });

    it("runs on a read-only root filesystem, writable only where it works", async () => {
      expect(await start()).toContain("--read-only");
    });

    it("regression (S2-4): it no longer starts with Docker's defaults: --cap-drop ALL, no-new-privileges, a memory and a process limit and --read-only are each passed once, and nothing adds back what they take", async () => {
      const args = await start();
      expect(values(args, "--cap-drop")).not.toEqual([]);
      expect(values(args, "--cap-drop")).toEqual(["ALL"]);
      expect(values(args, "--cap-add")).toEqual([]);
      expect(values(args, "--security-opt")).not.toEqual([]);
      expect(values(args, "--security-opt")).toEqual(["no-new-privileges"]);
      expect(values(args, "--memory")).toEqual([sandboxMemory]);
      expect(values(args, "--pids-limit")).toEqual([String(sandboxPidsLimit)]);
      // A limit of 0 or -1 is no limit.
      expect(sandboxPidsLimit).toBeGreaterThan(0);
      expect(sandboxMemory).toMatch(/^[1-9]\d*[kmg]$/);
      expect(args.filter((arg) => arg === "--read-only")).toHaveLength(1);
      expect(args).not.toContain("--read-only=false");
    });

    it("sibling (S2-4): both docker runs take the one sandboxHardening, so they cannot drift apart, and it comes before the image, where Docker reads flags", async () => {
      const args = await start();
      const at = args.indexOf("--cap-drop");
      expect(args.slice(at, at + sandboxHardening.length)).toEqual([
        ...sandboxHardening,
      ]);
      const image = args.findIndex((arg) =>
        arg.startsWith("ai-office/sandbox-"),
      );
      expect(at).toBeGreaterThan(-1);
      expect(at + sandboxHardening.length).toBeLessThanOrEqual(image);
    });

    it("sibling (S2-4): it writes only to its home and /tmp, each an anonymous volume of its own, and to what is mounted for its work", async () => {
      expect(sandboxWritablePaths).toEqual(["/home/agent", "/tmp"]);
      const volumes = values(await start(), "--mount").filter((mount) =>
        mount.startsWith("type=volume,"),
      );
      expect(volumes).toEqual(
        sandboxWritablePaths.map((path) => `type=volume,target=${path}`),
      );
      // No `source=`: a named volume would be shared by every sandbox.
      for (const volume of volumes) {
        expect(volume).not.toContain("source=");
      }
    });
  });

  describe("S2-5: a network of its own", () => {
    /** The calls whose first arguments are `prefix`. */
    const callsOf = async (...prefix: string[]) =>
      (await calls()).filter((args) =>
        prefix.every((word, index) => args[index] === word),
      );

    it("joins a network made for it alone, internal, which the sandbox relay joins as sandbox-relay and nothing else does", async () => {
      const [network] = values(await start(), "--network");
      expect(await callsOf("network", "create")).toEqual([
        [
          "network",
          "create",
          "--internal",
          "--label",
          "ai-office.sandbox-network=ai-office-sandboxes",
          network,
        ],
      ]);
      // Found on ai-office-sandboxes by its compose service.
      expect(await callsOf("ps")).toEqual([
        [
          "ps",
          "--quiet",
          "--filter",
          "network=ai-office-sandboxes",
          "--filter",
          "label=com.docker.compose.service=sandbox-relay",
        ],
      ]);
      expect(await callsOf("network", "connect")).toEqual([
        [
          "network",
          "connect",
          "--alias",
          "sandbox-relay",
          network,
          "relay0123",
        ],
      ]);
      // Only the one container is started on it.
      expect(
        (await callsOf("run")).filter((args) =>
          values(args, "--network").includes(network ?? ""),
        ),
      ).toHaveLength(1);
    });

    it("never shares it with another sandbox, of its own Floor or another's", async () => {
      await start();
      await start();
      const runs = (await callsOf("run")).map((args) =>
        values(args, "--network"),
      );
      expect(runs).toHaveLength(2);
      expect(runs[0]).not.toEqual(runs[1]);
      for (const networks of runs) {
        expect(networks).toHaveLength(1);
        expect(networks).not.toContain("ai-office-sandboxes");
      }
    });

    it("removes its network once it has ended, after the container and its volumes", async () => {
      const args = await start();
      const [network] = values(args, "--network");
      const name = values(args, "--name")[0];
      const ends = (await calls()).filter(
        (call) =>
          call[0] === "rm" ||
          (call[0] === "network" &&
            (call[1] === "disconnect" || call[1] === "rm")),
      );
      expect(ends.slice(-3)).toEqual([
        ["rm", "--force", "--volumes", name],
        ["network", "disconnect", "--force", network, "relay0123"],
        ["network", "rm", network],
      ]);
    });

    it("is never started when the sandbox relay is not running, and makes no network", async () => {
      process.env["S2_NO_RELAY"] = "1";
      try {
        await expect(start()).rejects.toThrow(
          /sandbox relay is not running on the Docker network ai-office-sandboxes/,
        );
      } finally {
        delete process.env["S2_NO_RELAY"];
      }
      expect(await callsOf("run")).toEqual([]);
      expect(await callsOf("network", "create")).toEqual([]);
    });
  });
});

describe("S2: who a task's sandbox runs as, and what it mounts", () => {
  it("runs as AI Office's own user, never root", async () => {
    const args = await sandboxRun();
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    expect(values(args, "--user")).toEqual([`${String(uid)}:${String(gid)}`]);
  });

  it("mounts its own clone's worktree and .git read-write, and its Skills read-only, and nothing of any other run", async () => {
    const mounts = values(await sandboxRun(), "-v");
    expect(mounts).toEqual([
      `${root}/runs/sbx-1/.sandcastle/worktrees/ai-office-7-fix:/home/agent/workspace:z`,
      `${root}/runs/sbx-1/.sandcastle/worktrees/ai-office-7-fix/.git:${root}/runs/sbx-1/.sandcastle/worktrees/ai-office-7-fix/.git:z`,
      `${root}/runs/sbx-1/.git:${root}/runs/sbx-1/.git:z`,
      `${root}/runs/sbx-1-skills/claude:/home/agent/.claude/skills:ro,z`,
    ]);
  });

  it("sibling (S2-4): is removed with its home and /tmp volumes when it closes", async () => {
    await sandboxRun();
    const run = (await calls()).find((args) => args[0] === "run");
    const name = values(run ?? [], "--name")[0];
    expect(name).toMatch(/^sandcastle-/);
    expect((await calls()).filter((args) => args[0] === "rm")).toEqual([
      ["rm", "--force", "--volumes", name],
    ]);
  });

  it("starts with only the allow-listed environment, plus HOME, whatever else Sandcastle gathers", async () => {
    const env = values(await sandboxRun(), "-e")
      .map((pair) => pair.slice(0, pair.indexOf("=")))
      .sort();
    expect(env).toEqual(["ANTHROPIC_BASE_URL", "GH_TOKEN", "HOME"]);
  });
});

describe("S2: a Manager chat session's mounts", () => {
  it("mounts the read-only clone read-only, and the tool's own state read-write", async () => {
    expect(values(await toolRun(), "--mount")).toEqual([
      `type=bind,source=${root}/manager-chat/floor-1/repo,target=/home/agent/workspace,readonly`,
      `type=bind,source=${root}/manager-chat/floor-1/claude,target=/home/agent/.claude`,
      // Its home and /tmp, removed with it (S2-4).
      "type=volume,target=/home/agent",
      "type=volume,target=/tmp",
    ]);
  });

  it("sibling (S2-4): is removed with its volumes when it ends", async () => {
    expect(await toolRun()).toContain("--rm");
  });

  it("passes only the allow-listed environment's names, never the app's", async () => {
    expect(values(await toolRun(), "-e")).toEqual(["ANTHROPIC_BASE_URL"]);
  });
});

describe("S2-5: networks an AI Office before left behind", () => {
  it("are removed before the first sandbox makes its own, so Docker's address pools do not run out", async () => {
    await sandboxRun("ai-office-sandboxes-left");
    const network = (await calls()).filter((args) => args[0] === "network");
    expect(network.slice(0, 4)).toEqual([
      [
        "network",
        "ls",
        "--quiet",
        "--filter",
        "label=ai-office.sandbox-network=ai-office-sandboxes-left",
      ],
      ["network", "disconnect", "--force", "left-behind-1", "relay0123"],
      ["network", "rm", "left-behind-1"],
      expect.arrayContaining(["network", "create", "--internal"]),
    ]);
  });
});
