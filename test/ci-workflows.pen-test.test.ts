import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// I1 probe (pen-testing, "Infrastructure and delivery"): the GitHub Actions
// workflows (the "Confirm, don't re-test" CI line, and H20's release and
// Pages workflows). The attacker is the supply chain: a dependency that runs
// in a job holding a write token (position 2 against the build). See
// docs/pen-testing/assessments/I1.md.
//
// Fixed (I1-6): release.yml runs semantic-release, and the install before
// it, in a job with a read-only token; the job that writes runs only
// GitHub's own actions and release/publish.ts, which imports nothing but
// Node's own modules (test/release.test.ts).
//
// Fixed (I1-7): pages.yml is contents: read workflow-wide; pages: write
// and id-token: write are the deploy job's alone.

const root = join(import.meta.dirname, "..");
const workflowsDir = join(root, ".github", "workflows");

interface Job {
  permissions?: Record<string, string> | string;
  needs?: string | string[];
  steps?: {
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
  }[];
}
interface Workflow {
  on: unknown;
  permissions?: Record<string, string> | string;
  jobs: Record<string, Job>;
}

const workflows = new Map<string, Workflow>();
for (const file of await readdir(workflowsDir)) {
  if (file.endsWith(".yml") || file.endsWith(".yaml")) {
    workflows.set(
      file,
      parse(await readFile(join(workflowsDir, file), "utf8")) as Workflow,
    );
  }
}

const steps = (workflow: Workflow) =>
  Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
const usesOf = (workflow: Workflow) =>
  steps(workflow)
    .map((step) => step.uses)
    .filter((uses): uses is string => uses !== undefined);

/** An action reference is SHA-pinned when it is `owner/repo@<40 hex>`. */
const shaPinned = (uses: string) => /@[0-9a-f]{40}(\s|$)/.test(uses);

/** On which events a workflow triggers, as a set of top-level keys. */
const triggers = (workflow: Workflow): string[] => {
  const on = workflow.on;
  if (typeof on === "string") {
    return [on];
  }
  if (Array.isArray(on)) {
    return on as string[];
  }
  return Object.keys(on as Record<string, unknown>);
};

describe("Confirm, don't re-test: CI hygiene (HOLDS)", () => {
  it("SHA-pins every action in every workflow", () => {
    for (const [file, workflow] of workflows) {
      for (const uses of usesOf(workflow)) {
        expect(shaPinned(uses), `${file}: ${uses}`).toBe(true);
      }
    }
  });

  it("checks out with persist-credentials: false everywhere", () => {
    for (const [file, workflow] of workflows) {
      for (const step of steps(workflow)) {
        if (step.uses?.includes("actions/checkout")) {
          expect(step.with?.["persist-credentials"], file).toBe(false);
        }
      }
    }
  });

  it("uses no pull_request_target or workflow_run trigger", () => {
    for (const [file, workflow] of workflows) {
      expect(triggers(workflow), file).not.toContain("pull_request_target");
      expect(triggers(workflow), file).not.toContain("workflow_run");
    }
  });

  it("keeps ci.yml at contents: read", () => {
    expect(workflows.get("ci.yml")?.permissions).toEqual({ contents: "read" });
  });
});

describe("I1-6 (H20): release.yml runs dependency code with a write token", () => {
  const release = workflows.get("release.yml");

  it("regression (I1-6): the release job still installs and runs semantic-release, but holds contents: read only, and no GITHUB_TOKEN", () => {
    const job = release?.jobs["release"];
    expect(job?.permissions).toEqual({ contents: "read" });
    const runs = (job?.steps ?? []).map((step) => step.run ?? "");
    // The dependencies are installed and semantic-release runs
    // (release/plan.ts), as before, but beside a read-only token.
    expect(runs.some((run) => run.includes("pnpm install"))).toBe(true);
    expect(runs).toContain("node release/plan.ts");
    expect(JSON.stringify(job)).not.toContain("GITHUB_TOKEN");
  });

  it("regression (I1-6): the top-level permissions are contents: read, and the only write grant is the publish job's contents: write", () => {
    expect(release?.permissions).toEqual({ contents: "read" });
    const grants = Object.fromEntries(
      Object.entries(release?.jobs ?? {}).map(([name, job]) => [
        name,
        job.permissions,
      ]),
    );
    expect(grants).toEqual({
      release: { contents: "read" },
      publish: { contents: "write" },
    });
  });

  it("no job that runs third-party dependency code holds a write token", () => {
    const job = release?.jobs["release"];
    const permissions =
      typeof job?.permissions === "object" ? job.permissions : {};
    const writes = Object.entries(permissions)
      .filter(([, level]) => level === "write")
      .map(([scope]) => scope);
    const runsDependencies = (job?.steps ?? []).some((step) =>
      /pnpm install|semantic-release/.test(step.run ?? ""),
    );
    // The property: a job that installs and runs dependencies holds no
    // write scope.
    expect(runsDependencies && writes.length > 0 ? writes : []).toEqual([]);
  });
});

describe("I1-6 siblings: every workflow, the publish job, and what passes between jobs", () => {
  /** A job's scopes: its own, or else its workflow's. */
  const scopes = (workflow: Workflow, job: Job): Record<string, string> => {
    const permissions = job.permissions ?? workflow.permissions ?? {};
    return typeof permissions === "object" ? permissions : {};
  };
  /**
   * Whether a step runs code from outside this repository and GitHub: a
   * package manager, semantic-release, or an action not GitHub's own.
   */
  const runsThirdPartyCode = (step: NonNullable<Job["steps"]>[number]) =>
    /\bp?npm\b|\bnpx\b|semantic-release|release\/plan\.ts/.test(
      step.run ?? "",
    ) ||
    (step.uses !== undefined && !step.uses.startsWith("actions/"));

  it("no job in any workflow that runs third-party code holds a write scope", () => {
    const offending: string[] = [];
    for (const [file, workflow] of workflows) {
      for (const [name, job] of Object.entries(workflow.jobs)) {
        const writes = Object.entries(scopes(workflow, job))
          .filter(([, level]) => level === "write")
          .map(([scope]) => scope);
        if (writes.length > 0 && (job.steps ?? []).some(runsThirdPartyCode)) {
          offending.push(`${file} ${name}: ${writes.join(", ")}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  it("the publish job runs only GitHub's own actions and release/publish.ts, with its token in the environment", () => {
    const job = workflows.get("release.yml")?.jobs["publish"];
    expect(job?.needs).toBe("release");
    const steps = job?.steps ?? [];
    expect(
      steps
        .map((step) => step.uses)
        .filter((uses) => uses !== undefined)
        .every((uses) => uses.startsWith("actions/")),
    ).toBe(true);
    expect(
      steps.map((step) => step.run).filter((run) => run !== undefined),
    ).toEqual(["node release/publish.ts"]);
    const publish = steps.find(
      (step) => step.run === "node release/publish.ts",
    );
    expect(publish?.env).toMatchObject({
      GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
    });
  });

  it("no workflow writes an expression into a script, so what the release job hands on cannot become a command", () => {
    // The plan comes from a job that ran dependency code: it reaches
    // release/publish.ts through its environment, never `${{ … }}` in `run:`.
    for (const [file, workflow] of workflows) {
      for (const step of steps(workflow)) {
        expect(step.run ?? "", file).not.toContain("${{");
      }
    }
  });
});

describe("I1-7 (H20): pages.yml grants deploy scopes to the build job", () => {
  const pages = workflows.get("pages.yml");

  it("regression (I1-7): pages: write and id-token: write are no longer top-level; only the deploy job holds them", () => {
    expect(pages?.permissions).toEqual({ contents: "read" });
    // The build job reads the repository and the Pages settings, and only
    // runs `node site/build.ts` and uploads an artifact.
    expect(pages?.jobs["build"]?.permissions).toEqual({
      contents: "read",
      pages: "read",
    });
    expect(pages?.jobs["deploy"]?.permissions).toEqual({
      pages: "write",
      "id-token": "write",
    });
  });

  it("the Pages build job holds no pages or id-token write scope it does not use", () => {
    // The property: pages: write and id-token: write are granted only to
    // the deploy job, not workflow-wide where the build job has them.
    const top = typeof pages?.permissions === "object" ? pages.permissions : {};
    expect(top["pages"]).not.toBe("write");
    expect(top["id-token"]).not.toBe("write");
  });
});

describe("I1-7 siblings: write scopes are a job's own, in every workflow", () => {
  it("no workflow grants a write scope workflow-wide", () => {
    for (const [file, workflow] of workflows) {
      const top =
        typeof workflow.permissions === "object" ? workflow.permissions : {};
      expect(workflow.permissions, file).toBeDefined();
      expect(
        Object.entries(top).filter(([, level]) => level === "write"),
        file,
      ).toEqual([]);
    }
  });

  it("every job that holds a write scope says so itself, and the Pages build job holds none", () => {
    const writers: string[] = [];
    for (const [file, workflow] of workflows) {
      for (const [name, job] of Object.entries(workflow.jobs)) {
        const own = typeof job.permissions === "object" ? job.permissions : {};
        if (Object.values(own).includes("write")) {
          writers.push(`${file} ${name}`);
        }
      }
    }
    expect(writers.sort()).toEqual(["pages.yml deploy", "release.yml publish"]);
  });
});
