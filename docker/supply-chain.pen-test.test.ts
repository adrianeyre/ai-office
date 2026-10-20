import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// I1 probe (pen-testing, "Infrastructure and delivery"): images and the
// supply chain (H15), and the deployment's published ports (bullet 1). It
// reads the files; running anything needs Docker, which this sandbox lacks.
// See docs/pen-testing/assessments/I1.md.
//
// Fixed (I1-4): every image the stack pulls is pinned by digest beside its
// tag, in the compose files, every Dockerfile's FROM and the images the
// tests run, so a re-pointed tag serves nothing new.
//
// Fixed (I1-5): the sandbox images install gh from one release checked
// against its SHA-256, and pnpm and their agent tool with `npm ci` from a
// lockfile that pins each package's SHA-512; the app image installs pnpm
// the same way. Nothing is piped into a shell, and nothing is `latest`.

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFile(join(root, path), "utf8");

interface ComposeFile {
  services: Record<
    string,
    {
      image?: string;
      ports?: string[];
      expose?: string[];
      build?: unknown;
      pull_policy?: string;
    }
  >;
}

const composeText = await read("docker-compose.yml");
const compose = parse(composeText) as ComposeFile;

/**
 * The images a compose file has Docker pull: every service's but those it
 * builds itself (`ai-office:local`, `ai-office:pen-test`), whose content is
 * their Dockerfile's, pinned there.
 */
const pulledImages = (file: ComposeFile): string[] =>
  Object.values(file.services)
    .filter(
      (service) =>
        service.build === undefined && service.pull_policy !== "never",
    )
    .map((service) => service.image)
    .filter((image): image is string => image !== undefined);

/** Every `FROM <image>` base image across the stack's Dockerfiles. */
const dockerfiles = [
  "Dockerfile",
  "docker/sandbox-claude/Dockerfile",
  "docker/sandbox-codex/Dockerfile",
  "docker/sandbox-opencode/Dockerfile",
  "docker/dev/Dockerfile",
];
const baseImages = (
  await Promise.all(
    dockerfiles.map(async (path) => {
      const text = await read(path);
      return [...text.matchAll(/^FROM\s+(\S+)/gm)].map((match) => ({
        path,
        text,
        image: match[1] ?? "",
      }));
    }),
  )
)
  .flat()
  // Keep registry references (node:…); drop internal build-stage names
  // (`FROM base`, `FROM manifests AS …`).
  .filter((base) => base.image.includes(":"));

/** A reference is pinned by digest when it carries `@sha256:…`. */
const byDigest = (reference: string) => /@sha256:[0-9a-f]{64}$/.test(reference);

describe("I1-4 (H15): images are pinned by tag, not digest", () => {
  it("regression (I1-4): the compose images are no longer bare tags, so a re-pointed tag serves nothing new", () => {
    const composeImages = pulledImages(compose);
    expect(composeImages).not.toContain("postgres:18-alpine");
    expect(composeImages).not.toContain("caddy:2-alpine");
    expect(composeImages).toContain(
      "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873",
    );
    expect(composeImages).toContain(
      "caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f",
    );
    expect(composeImages.filter((image) => !byDigest(image))).toEqual([]);
  });

  it("regression (I1-4): every Dockerfile base image carries a digest beside its tag or build ARG", () => {
    // `node:${NODE_VERSION}-slim` / `-bookworm` and the Docker CLI's image:
    // the ARG names the release, the digest is what is pulled.
    expect(baseImages.length).toBeGreaterThan(0);
    for (const { path, image } of baseImages) {
      expect(image, path).toMatch(
        /^(node:\$\{NODE_VERSION\}-(slim|bookworm)|docker:\$\{DOCKER_CLI_VERSION\}-cli)@sha256:[0-9a-f]{64}$/,
      );
      expect(byDigest(image), path).toBe(true);
    }
  });

  it("every image the stack runs is pinned by digest, so a re-pointed tag cannot serve new code", () => {
    // The app's own image (`ai-office:local`) is built, not pulled: its
    // content is the Dockerfile's, whose base images are below.
    const composeImages = pulledImages(compose);
    const references = [
      ...composeImages,
      ...baseImages.map((base) => base.image),
    ];
    expect(references.every(byDigest)).toBe(true);
  });
});

describe("I1-4 siblings: the development and pen-test stacks, and the images the tests run", () => {
  const otherStacks = ["docker-compose.dev.yml", "docker/pen-test/compose.yml"];

  /** Each `export const …Image = "…"` the test harnesses pull. */
  const testImages = async (): Promise<string[]> => {
    const sources = await Promise.all(
      [
        "packages/db/src/testing/docker.ts",
        "packages/communications/src/mailpit.ts",
        "docker/sandbox-images.test.ts",
      ].map(read),
    );
    return sources.flatMap((source) =>
      [...source.matchAll(/(?:export )?const \w+Image =\s*"([^"]+)"/g)].map(
        (match) => match[1] ?? "",
      ),
    );
  };

  it("the development and pen-test stacks pin every image they pull by digest", async () => {
    for (const path of otherStacks) {
      const images = pulledImages(parse(await read(path)) as ComposeFile);
      expect(images.length, path).toBeGreaterThan(0);
      expect(
        images.filter((image) => !byDigest(image)),
        path,
      ).toEqual([]);
    }
  });

  it("the images the tests run (Postgres, Mailpit, hadolint) are pinned by digest", async () => {
    const images = await testImages();
    expect(images).toHaveLength(3);
    expect(images.filter((image) => !byDigest(image))).toEqual([]);
  });

  it("each tag has one digest everywhere, so no copy is left behind when a pin moves", async () => {
    const references = [
      ...pulledImages(compose),
      ...(
        await Promise.all(
          otherStacks.map(async (path) =>
            pulledImages(parse(await read(path)) as ComposeFile),
          ),
        )
      ).flat(),
      // A Dockerfile's ARGs filled in with their defaults.
      ...baseImages.map(({ text, image }) =>
        image.replace(
          /\$\{(\w+)\}/g,
          (_, name: string) =>
            new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(text)?.[1] ?? name,
        ),
      ),
      ...(await testImages()),
    ];
    const digests = new Map<string, Set<string>>();
    for (const reference of references) {
      const [tag = "", digest = ""] = reference.split("@");
      digests.set(tag, (digests.get(tag) ?? new Set()).add(digest));
    }
    expect(digests.get("node:26.10.0-slim")?.size).toBe(1);
    expect(digests.get("postgres:18.6-alpine")?.size).toBe(1);
    for (const [tag, set] of digests) {
      expect([...set], tag).toHaveLength(1);
    }
  });
});

describe("I1-5 (H15): the sandbox images install over the network at build time", () => {
  const sandboxDockerfiles = [
    "docker/sandbox-claude/Dockerfile",
    "docker/sandbox-codex/Dockerfile",
    "docker/sandbox-opencode/Dockerfile",
  ];

  it("regression (I1-5): the Claude sandbox no longer installs Claude Code by `curl | bash`, but from npm at the version its lockfile pins", async () => {
    const dockerfile = await read("docker/sandbox-claude/Dockerfile");
    expect(dockerfile).not.toMatch(/claude\.ai\/install\.sh/);
    expect(dockerfile).not.toMatch(/\|\s*(ba)?sh\b/);
    expect(dockerfile).not.toMatch(/CLAUDE_CODE_VERSION/);
    const lockfile = JSON.parse(
      await read("docker/sandbox-claude/package-lock.json"),
    ) as { packages: Record<string, { version?: string; integrity?: string }> };
    const claudeCode =
      lockfile.packages["node_modules/@anthropic-ai/claude-code"];
    expect(claudeCode?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(claudeCode?.integrity).toMatch(/^sha512-/);
  });

  it("regression (I1-5): no sandbox image installs gh, pnpm or an agent tool at a moving version any more", async () => {
    // gh was the `stable` channel of an apt source whose key was fetched at
    // build time; pnpm, Codex and opencode were `npm install --global`, the
    // last two at `latest`. Now gh is one release checked against its
    // SHA-256, and the rest are `npm ci` from a lockfile.
    for (const path of sandboxDockerfiles) {
      const dockerfile = await read(path);
      expect(dockerfile, path).not.toMatch(/cli\.github\.com\/packages/);
      expect(dockerfile, path).not.toMatch(/apt-get install[^\n]*\bgh\b/);
      expect(dockerfile, path).not.toMatch(/npm\s+install\s+--global/);
      expect(dockerfile, path).not.toMatch(/@\$\{\w+_VERSION\}/);
      expect(dockerfile, path).not.toMatch(/^ARG \w+=(latest|stable)$/m);
      expect(dockerfile, path).toMatch(/sha256sum --check --strict/);
      expect(dockerfile, path).toContain(
        "RUN npm ci --prefix /opt/agent-tools",
      );
    }
  });

  it("the sandbox images install nothing by piping a fetched script into a shell", async () => {
    const piped: string[] = [];
    const checked: string[] = [];
    for (const entry of await readdir(join(root, "docker"), {
      withFileTypes: true,
    })) {
      // Each image is a directory; `sandbox-build.ts` and the tests beside
      // them are not.
      if (!entry.isDirectory() || !entry.name.startsWith("sandbox-")) {
        continue;
      }
      const dir = entry.name;
      // The sandbox relay is no image of its own: it runs from the Node
      // image, which the compose files pin by digest (S2-1, I1-4).
      if (dir === "sandbox-relay") {
        continue;
      }
      checked.push(dir);
      const dockerfile = await read(join("docker", dir, "Dockerfile"));
      if (/curl[^\n]*\|\s*(ba)?sh/.test(dockerfile)) {
        piped.push(dir);
      }
    }
    expect(checked).toEqual([
      "sandbox-claude",
      "sandbox-codex",
      "sandbox-opencode",
    ]);
    // The property: no image runs `curl … | bash`.
    expect(piped).toEqual([]);
  });
});

describe("I1-5 siblings: every npm install in an image is from a lockfile, and nothing updates itself", () => {
  /** Every package-lock.json an image installs from. */
  const lockfiles = [
    "docker/sandbox-claude/package-lock.json",
    "docker/sandbox-codex/package-lock.json",
    "docker/sandbox-opencode/package-lock.json",
    "docker/pnpm/package-lock.json",
  ];

  it("the app image installs pnpm from a lockfile too, not from the registry at whatever it answers", async () => {
    const dockerfile = await read("Dockerfile");
    expect(dockerfile).not.toMatch(/npm\s+install\s+--global/);
    expect(dockerfile).toContain(
      "COPY docker/pnpm/package.json docker/pnpm/package-lock.json /opt/pnpm/\n",
    );
    expect(dockerfile).toContain("RUN npm ci --prefix /opt/pnpm");
  });

  it("every package any image installs from npm is pinned to an exact version and its SHA-512", async () => {
    for (const path of lockfiles) {
      const manifest = JSON.parse(
        await read(path.replace("package-lock.json", "package.json")),
      ) as { dependencies: Record<string, string> };
      for (const [name, version] of Object.entries(manifest.dependencies)) {
        expect(version, `${path}: ${name}`).toMatch(/^\d+\.\d+\.\d+$/);
      }
      const lockfile = JSON.parse(await read(path)) as {
        packages: Record<string, { resolved?: string; integrity?: string }>;
      };
      for (const [name, entry] of Object.entries(lockfile.packages)) {
        if (name === "") {
          continue;
        }
        expect(entry.resolved, `${path}: ${name}`).toMatch(
          /^https:\/\/registry\.npmjs\.org\//,
        );
        expect(entry.integrity, `${path}: ${name}`).toMatch(/^sha512-/);
      }
    }
  });

  it("no Dockerfile pipes anything fetched into a shell, nor installs from npm outside a lockfile", async () => {
    for (const path of dockerfiles) {
      // Its instructions, not the comments that say how to move a pin.
      const dockerfile = (await read(path))
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      expect(dockerfile, path).not.toMatch(/\|\s*(ba)?sh\b/);
      expect(dockerfile, path).not.toMatch(/\bnpx\b|\bnpm\s+(i|install)\b/);
    }
  });

  it("Claude Code and opencode never update themselves in a sandbox", async () => {
    expect(await read("docker/sandbox-claude/Dockerfile")).toContain(
      "ENV DISABLE_AUTOUPDATER=1",
    );
    expect(await read("docker/sandbox-opencode/Dockerfile")).toContain(
      "ENV OPENCODE_DISABLE_AUTOUPDATE=1",
    );
  });
});

describe("bullet 1: the deployment's published ports (HOLDS)", () => {
  it("binds the app, the OAuth callback and the Gateway to the host's loopback only", () => {
    const appPorts = compose.services["app"]?.ports ?? [];
    // The app's own port defaults to 127.0.0.1, and 1455 is loopback. The
    // Gateway is reached at /v1 on the app's port (main's one entry
    // point); its own port, 3047, is not published at all.
    expect(appPorts).toContain("127.0.0.1:1455:1455");
    expect(appPorts.some((port) => port.includes("3047"))).toBe(false);
    expect(compose.services["app"]?.expose).toEqual(["3047"]);
    expect(
      appPorts.every((port) => /^(127\.0\.0\.1|\$\{AI_OFFICE_BIND)/.test(port)),
    ).toBe(true);
    // Postgres publishes no port from the production compose file.
    expect(compose.services["postgres"]?.ports).toBeUndefined();
  });

  it("publishes only Caddy's 80 and 443 to the network, under the tls profile", () => {
    expect(compose.services["caddy"]?.ports).toEqual([
      "80:80",
      "443:443",
      "443:443/udp",
    ]);
  });
});
