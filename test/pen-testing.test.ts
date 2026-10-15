// Every pen-test probe test file holding an `it.fails`, a property that
// should hold but doesn't, is referenced by some assessment under
// docs/pen-testing/assessments/ (docs/pen-testing/README.md, "The
// cross-reference test"; the pen-testing PRD's Findings workflow).
import {
  glob,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const probeTests = [
  "**/*.pen-test.test.ts",
  "**/*.pen-test.integration.test.ts",
];
const assessments = "docs/pen-testing/assessments/**/*.md";
/** Never searched: dependencies and what tools write. Glob skips dot directories. */
const ignored = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test-results",
  "playwright-report",
]);
const expectedFailure = /\b(?:it|test)\.(?:\w+\.)*fails\b/;

const files = async (root: string, patterns: string | string[]) => {
  const found: string[] = [];
  for await (const path of glob(patterns, {
    cwd: root,
    exclude: (name) => ignored.has(basename(name)),
  })) {
    found.push(path.split(sep).join("/"));
  }
  return found.sort();
};

/** Probe test files holding an `it.fails` that no assessment names, by path from `root`. */
const unreferencedProbeTests = async (root: string) => {
  const assessmentText = (
    await Promise.all(
      (await files(root, assessments)).map((path) =>
        readFile(join(root, path), "utf8"),
      ),
    )
  ).join("\n");
  const unreferenced: string[] = [];
  for (const path of await files(root, probeTests)) {
    const source = await readFile(join(root, path), "utf8");
    if (expectedFailure.test(source) && !assessmentText.includes(path)) {
      unreferenced.push(path);
    }
  }
  return unreferenced;
};

describe("the pen-test cross-reference", () => {
  it("finds every probe test holding an it.fails referenced by an assessment", async () => {
    expect(
      await unreferencedProbeTests(join(import.meta.dirname, "..")),
    ).toEqual([]);
  });
});

describe("unreferencedProbeTests", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pen-testing-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };

  const failing = 'it.fails("refuses a planted core.fsmonitor", () => {});\n';
  const passing = 'it("runs core.fsmonitor today", () => {});\n';

  it("names a probe test holding an it.fails that no assessment references", async () => {
    await write("packages/orchestrator/src/git/host.pen-test.test.ts", failing);
    await write(
      "packages/gateway/src/caps.pen-test.integration.test.ts",
      `test.fails("bills the Agent's own issue", () => {});\n`,
    );
    await write("docs/pen-testing/assessments/S1.md", "# S1\n\nNo tests.\n");

    expect(await unreferencedProbeTests(root)).toEqual([
      "packages/gateway/src/caps.pen-test.integration.test.ts",
      "packages/orchestrator/src/git/host.pen-test.test.ts",
    ]);
  });

  it("accepts one referenced by its path from the root, or by a relative link containing it", async () => {
    await write("packages/orchestrator/src/git/host.pen-test.test.ts", failing);
    await write("apps/server/src/auth/login.pen-test.test.ts", failing);
    await write(
      "docs/pen-testing/assessments/S1.md",
      "Probe test: `packages/orchestrator/src/git/host.pen-test.test.ts`.\n",
    );
    await write(
      "docs/pen-testing/assessments/nested/A1.md",
      "[login](../../../../apps/server/src/auth/login.pen-test.test.ts)\n",
    );

    expect(await unreferencedProbeTests(root)).toEqual([]);
  });

  it("does not take a file's name alone, or a reference outside the assessments, as a reference", async () => {
    await write("packages/orchestrator/src/git/host.pen-test.test.ts", failing);
    await write(
      "docs/pen-testing/assessments/S1.md",
      "See host.pen-test.test.ts.\n",
    );
    await write(
      "docs/pen-testing/README.md",
      "packages/orchestrator/src/git/host.pen-test.test.ts\n",
    );

    expect(await unreferencedProbeTests(root)).toEqual([
      "packages/orchestrator/src/git/host.pen-test.test.ts",
    ]);
  });

  it("needs no reference for a probe test with no it.fails, such as one whose fix has landed", async () => {
    await write("packages/orchestrator/src/git/host.pen-test.test.ts", passing);

    expect(await unreferencedProbeTests(root)).toEqual([]);
  });

  it("counts it.fails behind a modifier, but not other tests' names", async () => {
    await write(
      "packages/a/src/concurrent.pen-test.test.ts",
      'it.concurrent.fails("x", () => {});\n',
    );
    await write(
      "packages/a/src/named.pen-test.test.ts",
      'it("explains why submit.fails is not a test", () => {});\n',
    );

    expect(await unreferencedProbeTests(root)).toEqual([
      "packages/a/src/concurrent.pen-test.test.ts",
    ]);
  });

  it("ignores other tests, dependencies, build output and dot directories", async () => {
    await write("packages/a/src/plain.test.ts", failing);
    await write("node_modules/x/src/y.pen-test.test.ts", failing);
    await write("packages/a/node_modules/x/y.pen-test.test.ts", failing);
    await write("apps/web/dist/y.pen-test.test.ts", failing);
    await write(".sandcastle/worktrees/x/y.pen-test.test.ts", failing);

    expect(await unreferencedProbeTests(root)).toEqual([]);
  });
});
