import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dockerProvider } from "./docker.ts";

// AI Office's own Docker provider (pen-testing S2-4), which starts each
// sandbox with `sandboxHardening` where Sandcastle's could not. There is no
// Docker here, so a stand-in `docker` first on the PATH records each call
// and runs each `docker exec`'s command on this machine, as the container
// would. Which flags the sandbox is started with is probed in
// docker-run.pen-test.test.ts.

let bin: string;
let log: string;
let path: string | undefined;

/** The stand-in's `docker image inspect` answer: the image's user. */
let imageUser = "";

beforeEach(async () => {
  bin = await mkdtemp(join(tmpdir(), "ai-office-docker-"));
  log = join(bin, "calls.jsonl");
  await writeStandIn();
  path = process.env["PATH"];
  process.env["PATH"] = `${bin}:${path ?? ""}`;
});

afterEach(async () => {
  process.env["PATH"] = path;
  imageUser = "";
  await rm(bin, { recursive: true, force: true });
});

async function writeStandIn(
  runFails = false,
  connectFails = false,
): Promise<void> {
  await writeFile(
    join(bin, "docker"),
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "image") process.stdout.write(${JSON.stringify(`${imageUser}\n`)});
if (args[0] === "run") {
  if (${String(runFails)}) { process.stderr.write("no space left on device\\n"); process.exit(125); }
  process.stdout.write("0123abcd\\n");
}
if (args[0] === "ps") process.stdout.write("relay0123\\n");
if (args[0] === "network" && args[1] === "connect" && ${String(connectFails)}) { process.stderr.write("network not found\\n"); process.exit(1); }
if (args[0] === "exec") {
  let at = 1;
  let cwd;
  if (args[at] === "-i") at += 1;
  if (args[at] === "-w") { cwd = args[at + 1]; at += 2; }
  const command = args[at + 3];
  const ran = spawnSync("sh", ["-c", command], { cwd, stdio: "inherit" });
  process.exit(ran.status ?? 1);
}
`,
  );
  await chmod(join(bin, "docker"), 0o755);
}

const calls = async (): Promise<string[][]> =>
  (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);

interface Handle {
  exec(
    command: string,
    options?: { onLine?: (line: string) => void; cwd?: string; stdin?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  copyFileIn(hostPath: string, sandboxPath: string): Promise<void>;
  copyFileOut(sandboxPath: string, hostPath: string): Promise<void>;
  close(): Promise<void>;
}

const start = (
  mounts: { hostPath: string; sandboxPath: string; readonly?: boolean }[] = [],
  network?: string,
): Promise<Handle> =>
  (
    dockerProvider({
      imageName: "ai-office/sandbox-claude:3",
      env: {},
      mounts,
      ...(network === undefined ? {} : { network }),
    }) as unknown as {
      create(options: {
        worktreePath: string;
        hostRepoPath: string;
        mounts: { hostPath: string; sandboxPath: string }[];
        env: Record<string, string>;
      }): Promise<Handle>;
    }
  ).create({
    worktreePath: "/srv/runs/sbx-1",
    hostRepoPath: "/srv/runs/sbx-1",
    mounts: [
      { hostPath: "/srv/runs/sbx-1", sandboxPath: "/home/agent/workspace" },
    ],
    env: { GH_TOKEN: "ghs_fake_read_only_token" },
  });

describe("AI Office's Docker sandbox provider", () => {
  it("streams each line of a command's output as it comes, and keeps it", async () => {
    const handle = await start();
    const lines: string[] = [];
    const result = await handle.exec("printf 'one\\ntwo\\n'; echo oops >&2", {
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(["one", "two"]);
    expect(result).toEqual({
      stdout: "one\ntwo",
      stderr: "oops\n",
      exitCode: 0,
    });
    await handle.close();
  });

  it("passes stdin, the working directory and the exit code through", async () => {
    const handle = await start();
    const result = await handle.exec("cat; pwd; exit 3", {
      stdin: "from the prompt\n",
      cwd: bin,
    });
    expect(result.stdout).toBe(`from the prompt\n${bin}\n`);
    expect(result.exitCode).toBe(3);
    const exec = (await calls()).filter((args) => args[0] === "exec");
    expect(exec[0]?.slice(0, 4)).toEqual(["exec", "-i", "-w", bin]);
    await handle.close();
  });

  it("works in the worktree's mount, as AI Office's own user", async () => {
    const handle = await start();
    const run = (await calls()).find((args) => args[0] === "run") ?? [];
    expect(run.slice(run.indexOf("-w"), run.indexOf("-w") + 2)).toEqual([
      "-w",
      "/home/agent/workspace",
    ]);
    expect(run).toContain(
      `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`,
    );
    await handle.close();
  });

  it("copies files in and out with docker cp", async () => {
    const handle = await start();
    await handle.copyFileIn("/srv/in.jsonl", "/home/agent/in.jsonl");
    await handle.copyFileOut("/home/agent/out.jsonl", "/srv/out.jsonl");
    const name = (await calls()).find((args) => args[0] === "run")?.[3];
    expect((await calls()).filter((args) => args[0] === "cp")).toEqual([
      ["cp", "/srv/in.jsonl", `${String(name)}:/home/agent/in.jsonl`],
      ["cp", `${String(name)}:/home/agent/out.jsonl`, "/srv/out.jsonl"],
    ]);
    await handle.close();
  });

  it("refuses an image that is not built, or runs as another user", async () => {
    imageUser = "4242:4242";
    await writeStandIn();
    await expect(start()).rejects.toThrow(/runs as UID 4242/);
    expect((await calls()).some((args) => args[0] === "run")).toBe(false);
  });

  it("refuses a mount whose host path is missing, rather than let Docker make it as root", async () => {
    await expect(
      start([
        {
          hostPath: join(bin, "missing"),
          sandboxPath: "/home/agent/.claude/skills",
          readonly: true,
        },
      ]),
    ).rejects.toThrow(/does not exist/);
  });

  it("removes what a failed docker run left, with its volumes, and says why it failed", async () => {
    await writeStandIn(true);
    await expect(start()).rejects.toThrow(/no space left on device/);
    const [run, rm] = (await calls()).filter(
      (args) => args[0] === "run" || args[0] === "rm",
    );
    expect(rm).toEqual(["rm", "--force", "--volumes", run?.[3]]);
  });

  it("removes the network it made when the sandbox relay cannot join it, and starts nothing", async () => {
    await writeStandIn(false, true);
    await expect(start([], "ai-office-sandboxes")).rejects.toThrow(
      /network not found/,
    );
    const network = (await calls()).filter((args) => args[0] === "network");
    const made = network.find((args) => args[1] === "create")?.at(-1);
    expect(made).toMatch(/^ai-office-sandbox-/);
    expect(network.at(-1)).toEqual(["network", "rm", made]);
    expect((await calls()).some((args) => args[0] === "run")).toBe(false);
  });
});
