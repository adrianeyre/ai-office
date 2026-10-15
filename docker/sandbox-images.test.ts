// Checks of the sandbox images, one per agent tool (PRD FR-16, FR-19):
// their Dockerfiles, the build script, and hadolint's verdict on each.
// Building them and running each tool's `--version` as `agent` needs
// Docker and the network, so it also needs AI_OFFICE_SANDBOX_IMAGE_E2E=1.
// Without what they need, checks are skipped with the reason (or, in CI,
// fail).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  claudeSandboxImage,
  codexSandboxImage,
  opencodeSandboxImage,
} from "../packages/orchestrator/src/sandbox/images.ts";
import { meetsMinimum } from "./minimum-version.ts";
import {
  buildArguments,
  imagesFor,
  imagesToBuild,
  sandboxImageNames,
  sandboxImageSpecs,
  sandboxImageTag,
  type SandboxImageName,
} from "./sandbox-build.ts";

const root = join(import.meta.dirname, "..");
const run = promisify(execFile);
const rootPackage = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
) as {
  devEngines: {
    runtime: { version: string };
    packageManager: { version: string };
  };
};

interface Image {
  readonly name: SandboxImageName;
  readonly tag: string;
  readonly dockerfilePath: string;
  readonly dockerfile: string;
  /** What it installs from npm, at exact versions (package.json). */
  readonly manifest: ToolManifest;
  /** The SHA-512 of each package it installs (package-lock.json). */
  readonly lockfile: ToolLockfile;
  /** The files it is built from, as they are hashed for its version. */
  readonly sources: string;
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
}

interface ToolManifest {
  dependencies: Record<string, string>;
  allowScripts?: Record<string, boolean>;
}

interface ToolLockfile {
  packages: Record<
    string,
    { version?: string; resolved?: string; integrity?: string }
  >;
}

const images: Image[] = await Promise.all(
  sandboxImageNames.map(async (name) => {
    const dockerfilePath = join(
      sandboxImageSpecs[name].directory,
      "Dockerfile",
    );
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const directory = sandboxImageSpecs[name].directory;
    const manifestText = await readFile(
      join(directory, "package.json"),
      "utf8",
    );
    const lockfileText = await readFile(
      join(directory, "package-lock.json"),
      "utf8",
    );
    const manifest = JSON.parse(manifestText) as ToolManifest;
    return {
      name,
      tag: sandboxImageTag(name),
      dockerfilePath,
      dockerfile,
      manifest,
      lockfile: JSON.parse(lockfileText) as ToolLockfile,
      sources: [dockerfile, manifestText, lockfileText].join("\0"),
      nodeVersion: /^ARG NODE_VERSION=(\S+)$/m.exec(dockerfile)?.[1] ?? "",
      pnpmVersion: manifest.dependencies["pnpm"] ?? "",
    };
  }),
);
const image = (name: SandboxImageName): Image => {
  const found = images.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`There is no ${name} sandbox image.`);
  }
  return found;
};

/**
 * Each image version, with the SHA-256 of the files it was built from: its
 * Dockerfile, package.json and package-lock.json. Changing any of them
 * means a new version in packages/orchestrator/src/sandbox/images.ts, and
 * its hash here, so no server runs sandboxes from a stale image with the
 * same tag.
 */
const dockerfileVersions: Record<string, string> = {
  "ai-office/sandbox-claude:6":
    "6c57c9887854d5160b7a28722d91b15bd2f3e92f5cdd9d8af5913cea8cea79fd",
  "ai-office/sandbox-codex:6":
    "687f8097544c3f3db91b83900d803373ca0c9484cb91a1b1237114f5d4cfa21e",
  "ai-office/sandbox-opencode:6":
    "8736b3de3d22685663fdc7da775af7c069671906d546f4b4a0ded2ca9056fb7a",
};

const skipOrFail = (
  name: string,
  test: () => Promise<void>,
  reason: string | undefined,
) => {
  if (reason === undefined) {
    it(name, test);
  } else if (process.env["CI"]) {
    it(name, () => {
      throw new Error(`${reason}. CI must run this check.`);
    });
  } else {
    // Every reporter shows this; only the verbose one shows skip notes.
    console.warn(`${reason}, so "${name}" is skipped.`);
    it.skip(`${name} [${reason}]`, test);
  }
};

const firstLine = (error: unknown): string =>
  error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);

describe("the sandbox images", () => {
  it("are tagged as the orchestrator runs each agent tool", () => {
    expect(sandboxImageTag("claude")).toBe(claudeSandboxImage);
    expect(sandboxImageTag("codex")).toBe(codexSandboxImage);
    expect(sandboxImageTag("opencode")).toBe(opencodeSandboxImage);
  });
});

describe.each(images)("the $name sandbox image's Dockerfile", (current) => {
  const { dockerfile, nodeVersion, pnpmVersion, sources, tag } = current;

  it("pins Node and pnpm versions that package.json allows", () => {
    expect(nodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pnpmVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      meetsMinimum(nodeVersion, rootPackage.devEngines.runtime.version),
    ).toBe(true);
    expect(
      meetsMinimum(pnpmVersion, rootPackage.devEngines.packageManager.version),
    ).toBe(true);
    // The base image is pinned by digest too, so a re-pointed tag changes
    // nothing (I1-4).
    expect(dockerfile).toMatch(
      /^FROM node:\$\{NODE_VERSION\}-bookworm@sha256:[0-9a-f]{64}\n/m,
    );
  });

  it("installs git, gh and pnpm", () => {
    expect(dockerfile).toMatch(
      /apt-get install[^\n]*\\\n(?:\s+\S+ \\\n)*\s+git \\/,
    );
    // gh: one release, its SHA-256 checked before it is unpacked (I1-5).
    expect(dockerfile).toMatch(/^ARG GH_VERSION=\d+\.\d+\.\d+$/m);
    expect(dockerfile).toMatch(/^ARG GH_SHA256_AMD64=[0-9a-f]{64}$/m);
    expect(dockerfile).toMatch(/^ARG GH_SHA256_ARM64=[0-9a-f]{64}$/m);
    expect(dockerfile).toContain(
      `printf '%s  %s\\n' "\${sha256}" /tmp/gh.tar.gz > /tmp/gh.tar.gz.sha256 \\\n  && sha256sum --check --strict /tmp/gh.tar.gz.sha256 \\\n`,
    );
    expect(dockerfile.indexOf("sha256sum --check")).toBeLessThan(
      dockerfile.indexOf("tar -xzf /tmp/gh.tar.gz"),
    );
    // pnpm, from the lockfile, with the agent tool.
    expect(pnpmVersion).toBe(
      current.lockfile.packages["node_modules/pnpm"]?.version,
    );
  });

  it("installs from npm only what package-lock.json pins, each package checked against its SHA-512", () => {
    expect(dockerfile).toContain(
      "COPY package.json package-lock.json /opt/agent-tools/\n",
    );
    expect(dockerfile).toContain(
      "RUN npm ci --prefix /opt/agent-tools --omit=dev --no-audit --no-fund",
    );
    expect(dockerfile).toContain(
      'ENV PATH="/opt/agent-tools/node_modules/.bin:${PATH}"\n',
    );
    expect(dockerfile).not.toMatch(/npm install --global/);
    // Exact versions only, and every package in the lockfile from the
    // registry with its integrity.
    for (const [name, version] of Object.entries(
      current.manifest.dependencies,
    )) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(
        current.lockfile.packages[`node_modules/${name}`]?.version,
        name,
      ).toBe(version);
    }
    const locked = Object.entries(current.lockfile.packages).filter(
      ([path]) => path !== "",
    );
    expect(locked.length).toBeGreaterThan(0);
    for (const [path, entry] of locked) {
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, path).toMatch(/^sha512-/);
    }
  });

  it("runs no shell construct POSIX sh lacks, so hadolint's ShellCheck faults none (SC3011)", () => {
    // hadolint's ShellCheck read the here-string (`<<<`) that checked gh's
    // SHA-256 as POSIX sh, SHELL notwithstanding: SC3011.
    const runs = dockerfile
      .replace(/\\\n/g, " ")
      .split("\n")
      .filter((line) => line.startsWith("RUN "));
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run).not.toContain("<<<");
    }
  });

  it("runs as a non-root agent user with the UID and GID it is built with", () => {
    expect(dockerfile).toContain("ARG AGENT_UID=1000\n");
    expect(dockerfile).toContain("ARG AGENT_GID=1000\n");
    expect(dockerfile).toContain('--uid "${AGENT_UID}" --gid "${AGENT_GID}"');
    expect(dockerfile).toContain("--login agent node");
    const users = [...dockerfile.matchAll(/^USER (.+)$/gm)].map(
      (match) => match[1],
    );
    expect(users).toEqual(["${AGENT_UID}:${AGENT_GID}"]);
    // Sandcastle mounts the worktree here.
    expect(dockerfile).toContain("WORKDIR /home/agent/workspace\n");
  });

  it("holds no credential, and names none", () => {
    expect(dockerfile).not.toMatch(/^ENV .*(KEY|TOKEN|SECRET)/m);
    expect(dockerfile).not.toMatch(/^ARG .*(KEY|TOKEN|SECRET)/m);
    expect(dockerfile).not.toContain("aio_gk_");
  });

  it("reaches the internet only through the sandbox relay's HTTPS proxy, and the relay itself directly (S2-1)", () => {
    expect(dockerfile).toContain(
      "ENV HTTPS_PROXY=http://sandbox-relay:3128 \\\n  https_proxy=http://sandbox-relay:3128 \\\n  NO_PROXY=sandbox-relay \\\n  no_proxy=sandbox-relay\n",
    );
    // No plain-HTTP proxy: the relay relays HTTPS only.
    expect(dockerfile).not.toMatch(/HTTP_PROXY|http_proxy/);
  });

  it("has a new image version whenever it changes", () => {
    const hash = createHash("sha256").update(sources).digest("hex");
    expect(
      dockerfileVersions[tag],
      `Record ${tag}'s hash in dockerfileVersions`,
    ).toBeDefined();
    expect(
      hash,
      `The Dockerfile, package.json or package-lock.json changed: give ${tag} a new version, and record ${hash} for it`,
    ).toBe(dockerfileVersions[tag]);
  });
});

describe("each agent tool's install", () => {
  it.each(images)(
    "installs $name's agent tool from npm at the exact version package.json names, running only the install scripts it allows",
    ({ name, dockerfile, manifest }) => {
      const { npmPackage } = sandboxImageSpecs[name];
      expect(Object.keys(manifest.dependencies).sort()).toEqual(
        [npmPackage, "pnpm"].sort(),
      );
      // Install scripts run only where named, for one version each: a new
      // version's must be allowed again.
      for (const [entry, allowed] of Object.entries(
        manifest.allowScripts ?? {},
      )) {
        if (allowed) {
          expect(entry).toMatch(/@\d+\.\d+\.\d+$/);
          expect(entry).toBe(
            `${npmPackage}@${manifest.dependencies[npmPackage] ?? ""}`,
          );
        }
      }
      expect(manifest.allowScripts?.["pnpm"]).toBe(false);
      // No version picked at build time, and no installer fetched.
      expect(dockerfile).not.toMatch(/^ARG \w+_VERSION=(latest|stable)$/m);
      expect(dockerfile).not.toContain("install.sh");
    },
  );

  it("never lets Claude Code or opencode update themselves in a sandbox", () => {
    expect(image("claude").dockerfile).toContain("ENV DISABLE_AUTOUPDATER=1\n");
    expect(image("opencode").dockerfile).toContain(
      "ENV OPENCODE_DISABLE_AUTOUPDATE=1\n",
    );
  });

  it("runs each agent tool as agent once it is installed", () => {
    for (const { name, dockerfile } of images) {
      const command = {
        claude: "claude",
        codex: "codex",
        opencode: "opencode",
      }[name];
      expect(
        dockerfile.indexOf(`&& ${command} --version`),
        name,
      ).toBeGreaterThan(dockerfile.indexOf("USER "));
    }
  });
});

describe("pnpm sandbox:build", () => {
  it("tags each image as the orchestrator runs it, for the running user", () => {
    for (const name of sandboxImageNames) {
      expect(buildArguments(name, {}, { uid: 1017, gid: 1019 })).toEqual([
        "build",
        "--tag",
        sandboxImageTag(name),
        "--build-arg",
        "AGENT_UID=1017",
        "--build-arg",
        "AGENT_GID=1019",
        sandboxImageSpecs[name].directory,
      ]);
    }
  });

  it("takes the IDs from the environment, and never a tool's version", () => {
    // The versions the old CLAUDE_CODE_VERSION, CODEX_VERSION and
    // OPENCODE_VERSION picked (`latest` by default) are the lockfile's now.
    const env = {
      AGENT_UID: "1000",
      AGENT_GID: "1000",
      CLAUDE_CODE_VERSION: "latest",
      CODEX_VERSION: "latest",
      OPENCODE_VERSION: "latest",
    };
    expect(buildArguments("claude", env, { uid: 1017, gid: 1019 })).toEqual([
      "build",
      "--tag",
      claudeSandboxImage,
      "--build-arg",
      "AGENT_UID=1000",
      "--build-arg",
      "AGENT_GID=1000",
      join(import.meta.dirname, "sandbox-claude"),
    ]);
    for (const name of sandboxImageNames) {
      expect(buildArguments(name, env).join(" ")).not.toMatch(/_VERSION=/);
    }
    expect(() => buildArguments("claude", { AGENT_UID: "node" })).toThrow(
      "AGENT_UID must be a numeric ID",
    );
  });

  it("never gives the agent user root's IDs", () => {
    expect(buildArguments("codex", {}, { uid: 0, gid: 0 })).toContain(
      "AGENT_UID=1000",
    );
  });

  it("builds every image, or only those named", () => {
    expect(imagesToBuild([])).toEqual(["claude", "codex", "opencode"]);
    expect(imagesToBuild(["opencode"])).toEqual(["opencode"]);
    expect(() => imagesToBuild(["copilot"])).toThrow(
      'There is no sandbox image "copilot"',
    );
  });

  it("with --missing, builds only the images whose tag is not built yet", () => {
    // An older version's tag does not count: its new tag is built.
    const built = new Set([
      sandboxImageTag("codex"),
      "ai-office/sandbox-claude:1",
    ]);
    const isBuilt = (tag: string) => built.has(tag);
    expect(imagesFor(["--missing"], isBuilt)).toEqual(["claude", "opencode"]);
    expect(imagesFor(["--missing", "codex"], isBuilt)).toEqual([]);
    expect(imagesFor(["codex"], isBuilt)).toEqual(["codex"]);
  });
});

// hadolint, installed, or else its image (pinned by digest) on Docker.
const hadolintImage =
  "hadolint/hadolint:v2.15.1@sha256:32dac94127fd60b7b7e3fbfc65e1383b9b5e25c9bfd7b8536de7a539fe68a12d";
const hadolint = await (async (): Promise<
  { command: string; args: (path: string) => string[] } | string
> => {
  const reasons: string[] = [];
  try {
    await run("hadolint", ["--version"], { timeout: 20_000 });
    return { command: "hadolint", args: (path) => [path] };
  } catch (error) {
    reasons.push(`hadolint is not installed (${firstLine(error)})`);
  }
  try {
    await run("docker", ["info"], { timeout: 20_000 });
    return {
      command: "docker",
      args: () => ["run", "--rm", "-i", hadolintImage],
    };
  } catch (error) {
    reasons.push(`Docker is not available (${firstLine(error)})`);
  }
  return reasons.join("; ");
})();

describe.each(images)("hadolint, on the $name image", (current) => {
  skipOrFail(
    "finds nothing to fault in the Dockerfile",
    async () => {
      if (typeof hadolint === "string") {
        return;
      }
      const lint = run(
        hadolint.command,
        hadolint.args(current.dockerfilePath),
        {
          timeout: 120_000,
        },
      );
      if (hadolint.command === "docker") {
        lint.child.stdin?.end(current.dockerfile);
      }
      const { stdout } = await lint.catch((error: unknown) => {
        throw new Error(
          `hadolint found problems:\n${String((error as { stdout?: unknown }).stdout ?? error)}`,
        );
      });
      expect(stdout).toBe("");
    },
    typeof hadolint === "string" ? hadolint : undefined,
  );
});

// --- With Docker -------------------------------------------------------------

const imageReason =
  process.env["AI_OFFICE_SANDBOX_IMAGE_E2E"] !== "1"
    ? "AI_OFFICE_SANDBOX_IMAGE_E2E is not 1 (building the images downloads each agent tool and takes minutes)"
    : await run("docker", ["info"], { timeout: 20_000 }).then(
        () => undefined,
        (error: unknown) => `Docker is not available (${firstLine(error)})`,
      );

/** Each image's agent tool, as `--version` runs it. */
const toolCommands: Record<SandboxImageName, string> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
};

describe.each(images)("with Docker, the $name image", (current) => {
  const optIn = (name: string, test: () => Promise<void>) => {
    if (imageReason === undefined) {
      it(name, test, 1_200_000);
    } else {
      console.warn(`${imageReason}, so "${name}" is skipped.`);
      it.skip(`${name} [${imageReason}]`, test);
    }
  };

  optIn(
    `builds, and runs ${toolCommands[current.name]} --version as agent`,
    async () => {
      await run("docker", buildArguments(current.name, process.env), {
        timeout: 1_200_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      const { stdout } = await run(
        "docker",
        [
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          current.tag,
          "-c",
          `whoami && ${toolCommands[current.name]} --version && git --version && gh --version | head -n 1 && pnpm --version && node --version`,
        ],
        { timeout: 120_000 },
      );
      const [user, tool, git, gh, pnpm, node] = stdout.trim().split("\n");
      expect(user).toBe("agent");
      expect(tool).toMatch(/\d+\.\d+\.\d+/);
      expect(git).toMatch(/^git version /);
      expect(gh).toMatch(/^gh version /);
      expect(pnpm).toBe(current.pnpmVersion);
      expect(node).toBe(`v${current.nodeVersion}`);
    },
  );
});
