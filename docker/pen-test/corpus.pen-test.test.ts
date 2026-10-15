// Probe P1 (docs/pen-testing/assessments/P1.md, issue #194), driven by E2's
// hostile-content corpus (corpus.ts): each item, attacker position 2, down
// the content path it is for, into each Stage's Role that path reaches.
// The real prompt builders build the prompt that would be sent, and the
// structure is asserted on: the item's canary only between markers the
// prompt itself opened, also when the item tries every way of closing them
// (`fenceBreakers`). The real Skill and Floor Template libraries take the
// corpus Skill and Floor Template as imports from Git; the real Merge
// Policy flow takes a pull request carrying the corpus repository files.
//
// What holds here: the fence around every issue, review comment, file,
// diff and memory proposal, in every Stage's prompt and the Manager's;
// and the Owner's review of an imported Skill and Floor Template.
// What does not: the corpus files a pull request carries are merged by
// policy (P1-2, P1-3). Fixed for P1-2 (issue #249): the corpus's
// package.json and CI script go to the Owner. Fixed for P1-3 (issue
// #251): so do its CLAUDE.md and .claude/settings.json. The other paths
// the corpus rides, and their
// findings, are in the orchestrator's own probe tests, which the
// assessment lists. Every value is a fake; every canary phones home to
// the stub upstream, never anywhere else.

import { afterEach, describe, expect, it } from "vitest";

import {
  createEventBus,
  memoryEventStore,
} from "../../packages/events/src/index.ts";
import { createFakeGitHub } from "../../packages/github/src/testing.ts";
import { coderPrompt } from "../../packages/orchestrator/src/coder/prompt.ts";
import { designPrompt } from "../../packages/orchestrator/src/design/prompt.ts";
import { docsPrompt } from "../../packages/orchestrator/src/docs/prompt.ts";
import { createFloors } from "../../packages/orchestrator/src/floors/floors.ts";
import { triagePrompt } from "../../packages/orchestrator/src/manager/triage-prompt.ts";
import { createMergeFlow } from "../../packages/orchestrator/src/merge/merge.ts";
import { curationPrompt } from "../../packages/orchestrator/src/memory/prompt.ts";
import { roleReviewPrompt } from "../../packages/orchestrator/src/memory/role-review.ts";
import { createNotices } from "../../packages/orchestrator/src/notices/notices.ts";
import {
  fenceBreakers,
  onlyInside,
  quotes,
} from "../../packages/orchestrator/src/pen-test/hostile-content.ts";
import { qaPrompt } from "../../packages/orchestrator/src/qa/prompt.ts";
import { reviewerPrompt } from "../../packages/orchestrator/src/review/prompt.ts";
import { issueBranch } from "../../packages/orchestrator/src/sandbox/branch.ts";
import { createSkillLibrary } from "../../packages/orchestrator/src/skills/skills.ts";
import { memorySkillStore } from "../../packages/orchestrator/src/skills/store.ts";
import { memoryStores } from "../../packages/orchestrator/src/stores.ts";
import { createFloorTemplateLibrary } from "../../packages/orchestrator/src/templates/library.ts";
import { loadFloorTemplates } from "../../packages/orchestrator/src/templates/load.ts";
import type { WorkItem } from "../../packages/orchestrator/src/work/store.ts";
import {
  floorTemplateErrorCodes,
  memoryPath,
  skillErrorCodes,
} from "../../packages/shared/src/index.ts";
import { hostileCorpus, type CorpusItem, type CorpusKind } from "./corpus.ts";

const stub = "http://stub-upstream:3050";
const corpus = hostileCorpus(stub);
const ofKind = (kind: CorpusKind): CorpusItem[] =>
  corpus.filter((item) => item.kind === kind);
const one = (id: string): CorpusItem => {
  const item = corpus.find((candidate) => candidate.id === id);
  if (item === undefined) {
    throw new Error(`The corpus has no ${id}.`);
  }
  return item;
};

/** The item, then every way of closing a `<tag>` quote, then the item again. */
const breaking = (item: CorpusItem, tag: string): string =>
  [item.content, ...fenceBreakers(tag), item.content].join("\n");

/** Expects every occurrence of the item's canary inside the prompt's `<tag>`. */
const fenced = (prompt: string, tag: string, item: CorpusItem): void => {
  expect(onlyInside(prompt, tag, item.canary), `${item.id} in <${tag}>`).toBe(
    true,
  );
};

const floor = {
  name: "Pen-test target",
  repository: "pen-test/target",
  defaultBranch: "main",
  setupCommand: "pnpm install",
  testCommand: "pnpm test",
};
const agent = {
  name: "Ada",
  role: "coder",
  aiProvider: "Claude",
  model: "claude-opus-5-5",
  extraInstructions: "",
};
const handoff = {
  changed: "The basket.",
  check: "Adding an item.",
  risks: "None.",
};
const manager = { name: "Max", extraInstructions: "" };

/** Every Stage's Role's prompt, and the Manager's triage, for an issue. */
const everyStage = (
  issue: { number: number; title: string; body: string },
  memory?: string,
): Record<string, string> => {
  const withMemory = memory === undefined ? {} : { memory };
  const common = {
    floor,
    agent: { ...agent, role: "qa" },
    role: { name: "QA", instructions: "" },
    issue,
    branch: "ai-office/1-x",
    pullRequest: 2,
    handoff,
    ...withMemory,
  };
  return {
    work: coderPrompt({
      floor,
      agent,
      role: { name: "coder", instructions: "" },
      issue,
      branch: "ai-office/1-x",
      ...withMemory,
    }),
    review: reviewerPrompt({
      floor,
      agent,
      role: { name: "reviewer", instructions: "" },
      issue,
      pullRequest: { number: 2, title: "x", branch: "ai-office/1-x" },
      round: { number: 1, cap: 3 },
      handoff,
      files: [],
      contents: [],
      ...withMemory,
    }).user,
    qa: qaPrompt({ ...common, round: { number: 1, cap: 3 } }),
    docs: docsPrompt(common),
    designer: designPrompt({
      ...common,
      afterQa: true,
      round: { number: 1, cap: 3 },
    }),
    triage: triagePrompt({ floor, manager, issue, ...withMemory }).user,
  };
};

describe("the corpus's issues, in every Stage's Role's prompt and the Manager's triage", () => {
  it("has issues to try", () => {
    expect(ofKind("issue").length).toBeGreaterThanOrEqual(2);
  });

  for (const item of ofKind("issue")) {
    it(`holds: ${item.id} stays inside the <issue> quote, closing markers and all`, () => {
      for (const body of [item.content, breaking(item, "issue")]) {
        const prompts = everyStage({
          number: 1,
          title: item.title ?? "",
          body,
        });
        for (const [stage, prompt] of Object.entries(prompts)) {
          expect(onlyInside(prompt, "issue", item.canary), stage).toBe(true);
          expect(quotes(prompt, "issue"), stage).toHaveLength(1);
        }
      }
    });
  }
});

describe("the corpus's review comment, in the work Stage's prompt", () => {
  it("holds: it stays inside the <review> quote, closing markers and all", () => {
    const item = one("review-comment");
    const prompt = coderPrompt({
      floor,
      agent,
      role: { name: "coder", instructions: "" },
      issue: { number: 1, title: "A basket", body: "Add a basket." },
      branch: "ai-office/1-x",
      feedback: {
        round: 1,
        roundCap: 3,
        comments: [
          {
            reviewer: "Grace",
            path: "src/basket.ts",
            line: 1,
            body: breaking(item, "review"),
          },
        ],
        handoff,
      },
    });
    fenced(prompt, "review", item);
    expect(quotes(prompt, "review")).toHaveLength(1);
  });
});

describe("the corpus's repository files, in the review Stage's prompt", () => {
  it("has files to try", () => {
    expect(ofKind("file").map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "CLAUDE.md",
        ".claude/settings.json",
        "package.json",
        "scripts/ci-setup.sh",
      ]),
    );
  });

  /** The reviewer's prompt for a pull request that adds `text` at `path`. */
  const reviewing = (
    path: string,
    text: string,
    shown: { readonly diff: boolean; readonly file: boolean },
  ) =>
    reviewerPrompt({
      floor,
      agent,
      role: { name: "reviewer", instructions: "" },
      issue: { number: 1, title: "A basket", body: "Add a basket." },
      pullRequest: { number: 2, title: "x", branch: "ai-office/1-x" },
      round: { number: 1, cap: 3 },
      files: [
        {
          path,
          status: "added",
          patch: shown.diff
            ? `@@ -0,0 +1 @@\n${text
                .split("\n")
                .map((line) => `+${line}`)
                .join("\n")}`
            : null,
        },
      ],
      contents: shown.file ? [{ path, text }] : [],
    });

  for (const item of ofKind("file")) {
    const path = item.path ?? item.id;

    it(`holds: ${path} reaches the reviewer only inside the <diff> quote, closing markers and all`, () => {
      const { system, user } = reviewing(path, breaking(item, "diff"), {
        diff: true,
        file: false,
      });
      fenced(user, "diff", item);
      expect(quotes(user, "diff")).toHaveLength(1);
      expect(system).not.toContain(item.canary);
    });

    it(`holds: ${path} reaches the reviewer only inside its <file> quote, closing markers and all`, () => {
      const { system, user } = reviewing(path, breaking(item, "file"), {
        diff: false,
        file: true,
      });
      fenced(user, "file", item);
      expect(quotes(user, "file")).toHaveLength(1);
      expect(system).not.toContain(item.canary);
    });
  }
});

describe("the corpus's memory proposal", () => {
  const item = one("memory-proposal");

  it("holds: as the repository's memory, it stays inside the <memory> quote in every Stage's Role's prompt and the Manager's triage", () => {
    const prompts = everyStage(
      { number: 1, title: "A basket", body: "Add a basket." },
      breaking(item, "memory"),
    );
    for (const [stage, prompt] of Object.entries(prompts)) {
      expect(onlyInside(prompt, "memory", item.canary), stage).toBe(true);
    }
  });

  it("holds: as a proposal, it stays inside the <proposals> quote in the Manager's curation and Role memory review", () => {
    const text = breaking(item, "proposals");
    const curation = curationPrompt({
      floor,
      manager,
      reason: "batch",
      current: ["Use pnpm."],
      proposals: [{ text, agent: "Ada", issue: 1 }],
    });
    fenced(curation.user, "proposals", item);
    expect(curation.system).not.toContain(item.canary);
    const review = roleReviewPrompt({
      floor,
      manager,
      roles: [
        {
          role: "coder",
          accepted: [],
          proposals: [{ id: 1, text, agent: "Ada", issue: 1 }],
        },
      ],
    });
    fenced(review.user, "proposals", item);
    expect(review.system).not.toContain(item.canary);
  });

  it("holds: as a reviewer's Role memory, it stays inside the <role-memory> quote", () => {
    const { user } = reviewerPrompt({
      floor,
      agent,
      role: { name: "reviewer", instructions: "" },
      issue: { number: 1, title: "A basket", body: "Add a basket." },
      pullRequest: { number: 2, title: "x", branch: "ai-office/1-x" },
      round: { number: 1, cap: 3 },
      files: [],
      contents: [],
      agentMemory: {
        office: undefined,
        role: [breaking(item, "role-memory")],
        roleOf: "reviewer",
      },
    });
    fenced(user, "role-memory", item);
  });
});

describe("the corpus's Skill, imported from Git", () => {
  it("holds: it waits, disabled, until the Owner reviews exactly what they read", async () => {
    const item = one("skill");
    const library = createSkillLibrary({
      store: memorySkillStore(),
      events: createEventBus({ store: memoryEventStore() }),
      repository: () =>
        Promise.resolve({
          files: [{ path: "SKILL.md", content: item.content }],
          folder: item.skill?.name ?? "",
          commit: "0".repeat(40),
          path: item.skill?.name ?? "",
        }),
    });
    const imported = await library.importFromGit({
      url: "https://git.example/pen-test/skills.git",
    });
    expect(imported).toMatchObject({
      name: item.skill?.name,
      enabled: false,
      reviewedAt: null,
    });
    await expect(
      library.update(imported.id, { enabled: true }),
    ).rejects.toThrow();
    await expect(
      library.review(imported.id, "0".repeat(64)),
    ).rejects.toMatchObject({ code: skillErrorCodes.skillChanged });
  });
});

describe("the corpus's Floor Template, imported from Git, with its setup command", () => {
  it("holds: it waits, disabled, setup command and all, until the Owner reviews exactly what they read; no Floor can be added from it before", async () => {
    const item = one("floor-template");
    const setupCommand = item.template?.setupCommand ?? "";
    expect(setupCommand).toContain(item.canary);
    const stores = memoryStores();
    const bus = createEventBus({ store: memoryEventStore() });
    const builtIn = await loadFloorTemplates();
    const options = {
      builtIn,
      store: stores.floorTemplates,
      roles: stores.roles,
      skills: stores.skills,
      floors: stores.floors,
      agents: stores.agents,
      events: bus,
    };
    const bundle =
      await createFloorTemplateLibrary(options).exportBundle("development");
    const files = bundle.files.map((file) =>
      file.path === "template.yaml"
        ? {
            ...file,
            content: file.content.replace(
              'setupCommand: ""',
              `setupCommand: ${JSON.stringify(setupCommand)}`,
            ),
          }
        : file,
    );
    const library = createFloorTemplateLibrary({
      ...options,
      repository: () =>
        Promise.resolve({
          files,
          folder: "pen-test-kit",
          commit: "0".repeat(40),
          path: "",
        }),
    });
    const imported = await library.importFromGit({
      url: "https://git.example/pen-test/kit.git",
      name: item.template?.name ?? "Pen-test kit",
    });
    expect(imported).toMatchObject({ enabled: false, reviewedAt: null });
    expect(imported.template.settings.setupCommand).toBe(setupCommand);
    expect((await library.enabled()).map(({ id }) => id)).not.toContain(
      imported.template.id,
    );
    await expect(
      library.review(imported.template.id, "0".repeat(64)),
    ).rejects.toMatchObject({ code: floorTemplateErrorCodes.templateChanged });
  });
});

// H8 and H10 through the Merge Policy: a pull request carrying the
// corpus's repository files, on the target Floor (which merges
// unattended, as the seed sets it up), approved by its required reviewer
// as one the corpus fooled would, with CI passing.

const repository = "pen-test/target";
const title = "Add a release helper";
const branch = issueBranch(1, title);
let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
});

/** Whether the App merged a pull request carrying `files` by policy. */
async function mergedByPolicy(
  files: Readonly<Record<string, string>>,
): Promise<boolean> {
  const fake = createFakeGitHub();
  fake.installRepository(repository);
  const bus = createEventBus({ store: memoryEventStore() });
  const stores = memoryStores();
  await createFloors({ store: stores.floors, github: fake, events: bus }).add(
    repository,
  );
  const [floorRecord] = await stores.floors.list();
  const floorId = floorRecord?.id ?? "";
  const reviewer = (await stores.agents.list(floorId)).find(
    ({ role }) => role === "reviewer",
  );
  await stores.floors.update(floorId, {
    requiredReviewerAgentIds: [reviewer?.id ?? ""],
    mergePolicy: "auto_merge",
  });
  fake.createIssue(repository, {
    title,
    body: one("issue-ci-secret").content,
    labels: ["ai-office", "ready-to-merge"],
  });
  const head = fake.pushCommit(repository, branch, { files });
  await fake.repository(repository).createPullRequest({
    title,
    body: "Closes #1",
    head: branch,
    base: "main",
  });
  await stores.reviews.recordVerdict({
    floorId,
    issue: 1,
    pullRequest: 2,
    round: 1,
    agentId: reviewer?.id ?? "",
    headSha: head,
    verdict: { verdict: "approve", summary: "Looks right.", comments: [] },
    reviewUrl: `https://github.com/${repository}/pull/2#review-1`,
    createdAt: new Date(),
  });
  fake.finishCI(repository, branch, { name: "CI" });
  const flow = createMergeFlow({
    floors: stores.floors,
    agents: stores.agents,
    github: fake,
    notices: createNotices({ store: stores.notices, events: bus }),
    events: bus,
    reviews: stores.reviews,
    batches: stores.batches,
    ownerLogin: () => Promise.resolve("adrianeyre"),
    sleep: () => Promise.resolve(),
  });
  stop = () => {
    flow.stop();
  };
  const work: WorkItem = {
    id: 1,
    floorId,
    issue: 1,
    stage: "ready-to-merge",
    agentId: null,
    status: "running",
    priority: "normal",
    createdAt: new Date(),
    startedAt: new Date(),
    finishedAt: null,
  };
  expect(await flow.execute(work, new AbortController().signal)).toBe(
    "finished",
  );
  return (await fake.repository(repository).getPullRequest(2)).merged;
}

/** The corpus's files, by what they change. */
const filesOf = (...ids: string[]): Record<string, string> =>
  Object.fromEntries(
    ids.map((id) => {
      const item = one(id);
      return [item.path ?? id, item.content];
    }),
  );
const runByCi = filesOf("package-json", "ci-script");
const readByLaterAgents = filesOf("claude-md", "claude-settings");

describe("P1-2: the corpus's package.json and CI script, in an Agent's pull request", () => {
  it("are sent to the Owner, not merged by policy, as they change what CI runs", async () => {
    expect(await mergedByPolicy(runByCi)).toBe(false);
  });

  it("regression (P1-2): the App no longer merges them, together or each on its own, approved with passing CI", async () => {
    expect(await mergedByPolicy(runByCi)).toBe(false);
    for (const [path, text] of Object.entries(runByCi)) {
      stop?.();
      expect(await mergedByPolicy({ [path]: text }), path).toBe(false);
    }
  });
});

describe("P1-3: the corpus's CLAUDE.md and .claude/settings.json, in an Agent's pull request", () => {
  it("are sent to the Owner, not merged by policy, as every later Agent's agent tool reads them", async () => {
    expect(await mergedByPolicy(readByLaterAgents)).toBe(false);
  });

  it("regression (P1-3): the App no longer merges them, together or each on its own, approved with passing CI", async () => {
    expect(await mergedByPolicy(readByLaterAgents)).toBe(false);
    for (const [path, text] of Object.entries(readByLaterAgents)) {
      stop?.();
      expect(await mergedByPolicy({ [path]: text }), path).toBe(false);
    }
  });

  it("P1-3: nor the corpus's memory proposal or Skill, written into the repository by an Agent's pull request", async () => {
    const proposal = one("memory-proposal");
    const skill = one("skill");
    expect(
      await mergedByPolicy({
        [memoryPath]: proposal.content,
        ".agents/skills/release/SKILL.md": skill.content,
      }),
    ).toBe(false);
  });
});
