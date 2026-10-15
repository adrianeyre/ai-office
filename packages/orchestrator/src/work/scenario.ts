import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createEventBus,
  memoryEventStore,
  type EventBus,
  type EventOfType,
  type OfficeEvent,
} from "@ai-office/events";
import type { CheckRunConclusion, GitHubApp } from "@ai-office/github";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import {
  defaultDecisionModelSettings,
  designerRole,
  initialDefaultModels,
  memoryPath,
  sandboxMemoryDirectory,
  type DecisionModelSettings,
  type DesignResult,
  type GitIdentity,
  type MergePolicy,
  type QaResult,
  type ReviewVerdict,
} from "@ai-office/shared";

import { createAgents } from "../agents/agents.ts";
import type { AgentRecord } from "../agents/store.ts";
import { createCoderFlow } from "../coder/coder.ts";
import {
  createDecisionModel,
  toolCallCheck,
} from "../decision-model/decision-model.ts";
import {
  createFakeDecisionModel,
  type FakeDecisionModel,
} from "../decision-model/fake-decision-model.ts";
import { createDesignFlow } from "../design/design.ts";
import { createDocsFlow } from "../docs/docs.ts";
import { createFloors } from "../floors/floors.ts";
import { withApprovedIssues } from "../intake/approved.ts";
import { createIntake, type IntakeQueue } from "../intake/intake.ts";
import {
  createRepositoryMemory,
  type RepositoryMemory,
} from "../memory/memory.ts";
import { createSharedMemory, type SharedMemory } from "../memory/shared.ts";
import { createMergeFlow } from "../merge/merge.ts";
import { createFakeModel, type FakeModel } from "../models/fake-model.ts";
import { createNotices, type Notices } from "../notices/notices.ts";
import { createOfficeSettings } from "../office/settings.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { createQaFlow } from "../qa/qa.ts";
import { createReviewFlow } from "../review/reviewer.ts";
import type { RoleRecord } from "../roles/store.ts";
import {
  bash,
  createFakeSandbox,
  result,
  say,
  type FakeAgentContext,
} from "../sandbox/fake-sandbox.ts";
import { gitBackedGitHub, gitIn } from "../sandbox/git-backed-github.ts";
import { createSandboxRunner } from "../sandbox/runner.ts";
import type { SkillMount } from "../sandbox/skills.ts";
import { memoryStores, type OfficeStores } from "../stores.ts";
import { createWorkQueue, executeByStage, type WorkQueue } from "./queue.ts";
import { memoryWorkQueueStore, type WorkItem } from "./store.ts";

// For tests: the pipeline end to end (PRD FR-18 to FR-28; §5 scenarios 2
// to 4), as each stage's flow runs it from one work queue. The Owner labels
// an issue; the coder (Claude Code, as a script in a fake sandbox) works it
// and AI Office opens the pull request on a local bare repository standing
// in for GitHub's remote; the Floor's two required reviewers (Claude and
// ChatGPT, through a fake model) review each round; its QA Agent (another
// script in the fake sandbox) checks what they approve, and a docs Agent,
// if the Floor has one, documents it; a designer, if the Floor has one
// (another script), reviews the UI once QA passes, between QA and docs;
// then the Floor's Merge Policy merges
// it or sends it to the Owner, CI finishing on its head while it waits.
// Each flow queues the next stage's work in the same queue. Every Agent
// reads the repository's memory, and those that write a Handoff (or QA's
// report) may propose entries for it. Given office-wide or Role memory,
// every flow has it too: mounted into each sandbox, quoted in each
// reviewer's prompt, and proposed to.

const exec = promisify(execFile);
export const repository = "adrianeyre/web-shop";
export const branch = "ai-office/1-add-a-basket";
const gatewayKey = "aio_gk_thecoderskeyforitssandboxes00000000000000";

/** The basket the coder writes on each of its runs. */
export const takes = [
  "export const basket: string[] = [];\n",
  "export const basket: string[] = [];\n\nexport const add = (sku: string) => basket.push(sku);\n\nexport const size = (): number => basket.length;\n",
  "export const basket: string[] = [];\n\nexport function add(sku: string): void {\n  basket.push(sku);\n}\n",
];

/** What the QA Agent does in one of its runs. */
export interface QaRun {
  readonly result: QaResult;
  /** Commits a test file first. */
  readonly addsTest?: boolean;
  /** Ends without its report. */
  readonly silent?: boolean;
  /** What a failure reports, if not that adding a sku twice fails. */
  readonly finding?: { readonly summary: string; readonly steps: string };
}

/** What the designer does in one of its runs. */
export interface DesignRun {
  readonly result: DesignResult;
  /** Commits a styling fix of its own first. */
  readonly fixesStyle?: boolean;
  /** Ends without its report. */
  readonly silent?: boolean;
}

export interface ScenarioOptions {
  /** What the coder writes in `src/basket.ts`, run by run. */
  readonly written?: readonly string[];
  /** What QA finds, run by run; the last repeats. Passing by default. */
  readonly qa?: readonly QaRun[];
  /** Whether the Floor keeps its QA Agent (it starts with one). */
  readonly withQa?: boolean;
  /** Whether a docs Agent is added to the Floor (it starts without one). */
  readonly withDocs?: boolean;
  /**
   * A work-Stage Role added to the Role library, whose Agent, Cora, does
   * the Floor's work in place of its starting coder (FR-98).
   */
  readonly workRole?: RoleRecord;
  /**
   * What a designer, added to the Floor (it starts without one), finds run
   * by run; the last repeats. No designer without it.
   */
  readonly design?: readonly DesignRun[];
  /** The Floor's Merge Policy; send to me, the default, otherwise. */
  readonly mergePolicy?: MergePolicy;
  /** Further labels on issue #1, each added by the Owner unless `actor` says. */
  readonly issueLabels?: readonly {
    readonly name: string;
    readonly actor?: string;
  }[];
  /**
   * The checks that finish on the pull request's head while the Merge
   * Policy first waits for CI; none run otherwise.
   */
  readonly ci?: readonly {
    readonly name?: string;
    readonly conclusion: CheckRunConclusion;
  }[];
  /** The checks the default branch requires before a merge. */
  readonly requiredChecks?: readonly string[];
  /** The repository's memory file to start with, if any (FR-53). */
  readonly memory?: string;
  /** What each Agent proposes for the memory in its Handoff or report. */
  readonly proposals?: {
    readonly coder?: readonly string[];
    readonly qa?: readonly string[];
    readonly docs?: readonly string[];
  };
  /**
   * The office-wide memory the Owner saved (FR-54); given it or
   * `roleMemory`, every flow has the office-wide and Role memory.
   */
  readonly officeMemory?: string;
  /** Each Role's memory, as the Owner accepted it (FR-55). */
  readonly roleMemory?: {
    readonly coder?: readonly string[];
    readonly reviewer?: readonly string[];
    readonly qa?: readonly string[];
  };
  /** What each Agent proposes for its Role's memory. */
  readonly roleProposals?: {
    readonly coder?: readonly string[];
    readonly qa?: readonly string[];
    readonly docs?: readonly string[];
  };
  /**
   * The Decision Model's settings (FR-17): off by default. While it is on,
   * `jev` answers for it.
   */
  readonly decisionModel?: DecisionModelSettings;
  /** A command the coder runs with its Bash tool first, each run. */
  readonly coderCommand?: string;
}

/** The memory a sandbox had mounted, as its Agent found it while it worked. */
export interface MountedMemory {
  readonly agent: "coder" | "qa" | "docs";
  readonly mount: SkillMount | undefined;
  /** Each file, with whether its mode lets anyone write it. */
  readonly files: readonly {
    readonly name: string;
    readonly content: string;
    readonly writable: boolean;
  }[];
}

export interface Scenario {
  readonly root: string;
  readonly remote: string;
  readonly fake: FakeGitHub;
  /** The fake GitHub, knowing what is pushed to `remote`. */
  readonly github: GitHubApp;
  readonly bus: EventBus;
  readonly stores: OfficeStores & ReturnType<typeof memoryStores>;
  readonly notices: Notices;
  readonly model: FakeModel;
  /** Jev, asked only while the Decision Model is on. */
  readonly jev: FakeDecisionModel;
  readonly queue: WorkQueue;
  /** The repository's memory, as every flow reads and proposes to it. */
  readonly memory: RepositoryMemory;
  /** The office-wide and Role memory, kept whether or not flows have it. */
  readonly sharedMemory: SharedMemory;
  /** What each sandbox had mounted as memory, run by run. */
  readonly mountedMemory: MountedMemory[];
  /** Who the Floor's commits are by. */
  readonly gitIdentity: () => Promise<GitIdentity>;
  readonly manager: AgentRecord;
  readonly coder: AgentRecord;
  /** The Floor's starting reviewer, on Claude. */
  readonly grace: AgentRecord;
  /** A second required reviewer, on ChatGPT. */
  readonly quinta: AgentRecord;
  /** The Floor's QA Agent, unless it was removed. */
  readonly qa: AgentRecord | undefined;
  /** The Floor's docs Agent, if one was added. */
  readonly docs: AgentRecord | undefined;
  /** The Floor's designer, if one was added. */
  readonly designer: AgentRecord | undefined;
  /** What the coder was asked, run by run. */
  readonly prompts: string[];
  /** What QA was asked, run by run. */
  readonly qaPrompts: string[];
  /** What the docs Agent was asked, run by run. */
  readonly docsPrompts: string[];
  /** What the designer was asked, run by run. */
  readonly designPrompts: string[];
  /** How many times the Merge Policy waited for CI. */
  readonly ciWaits: () => number;
  readonly work: () => WorkItem[];
  readonly events: () => Promise<OfficeEvent[]>;
  /** The Owner labels issue #1 and intake runs; the pipeline runs to its end. */
  run(): Promise<void>;
  /** Stops the queue and deletes the repositories. */
  close(): Promise<void>;
}

/** A `<memory>` (or `<role-memory>`) block proposing `entries`, or nothing. */
const proposing = (
  entries: readonly string[] | undefined,
  marker: "memory" | "role-memory" = "memory",
): string[] =>
  entries === undefined || entries.length === 0
    ? []
    : [`<${marker}>`, ...entries.map((entry) => `- ${entry}`), `</${marker}>`];

/** What an Agent proposes in its Handoff or report, for either memory. */
interface Proposing {
  readonly memory?: readonly string[] | undefined;
  readonly role?: readonly string[] | undefined;
}

const proposingBoth = (proposed: Proposing | undefined): string[] => [
  ...proposing(proposed?.memory),
  ...proposing(proposed?.role, "role-memory"),
];

/** The memory mounted among `mounts`, read as the Agent finds it. */
async function mountedMemory(
  agent: MountedMemory["agent"],
  mounts: readonly SkillMount[],
): Promise<MountedMemory> {
  const mount = mounts.find(
    ({ sandboxPath }) => sandboxPath === sandboxMemoryDirectory,
  );
  const names =
    mount === undefined ? [] : (await readdir(mount.hostPath)).sort();
  return {
    agent,
    mount,
    files: await Promise.all(
      names.map(async (name) => {
        const path = join(mount?.hostPath ?? "", name);
        return {
          name,
          content: await readFile(path, "utf8"),
          writable: ((await stat(path)).mode & 0o222) !== 0,
        };
      }),
    ),
  };
}

const writeFileIn = async (
  sh: FakeAgentContext["sh"],
  path: string,
  text: string,
): Promise<void> => {
  await sh(
    `mkdir -p "$(dirname ${path})" && printf '%s' '${text.replaceAll("'", "'\\''")}' > ${path}`,
  );
};

/** Each coder run commits the next of `written` and hands it on. */
const coding = async (
  { print, sh }: FakeAgentContext,
  run: number,
  written: readonly string[],
  proposed?: Proposing,
): Promise<void> => {
  await writeFileIn(
    sh,
    "src/basket.ts",
    written[run - 1] ?? written.at(-1) ?? "",
  );
  await sh(
    `git add -A && git commit --quiet -m "feat: a basket, take ${String(run)}"`,
  );
  print(
    say(
      [
        "Done.",
        "<handoff>",
        `Changed: The basket, take ${String(run)}.`,
        "Check: src/basket.ts adds what it is given.",
        `Risks: Take ${String(run)} has no tests yet.`,
        ...proposingBoth(proposed),
        "</handoff>",
      ].join("\n"),
    ),
  );
  print(result({ input: 1000, output: 200 }));
};

/** Each QA run checks, perhaps adds a test, and reports. */
const checking = async (
  { print, sh }: FakeAgentContext,
  run: number,
  { result: found, addsTest = false, silent = false, finding }: QaRun,
  proposed?: Proposing,
): Promise<void> => {
  if (addsTest) {
    await writeFileIn(
      sh,
      `test/basket-${String(run)}.test.ts`,
      'import { basket } from "../src/basket";\n',
    );
    await sh(
      `git add -A && git commit --quiet -m "test: the basket, QA round ${String(run)}"`,
    );
  }
  if (silent) {
    print(say("Checked."));
    print(result({ input: 800, output: 100 }));
    return;
  }
  print(
    say(
      [
        "Checked.",
        "<qa-report>",
        `Result: ${found}`,
        found === "pass"
          ? `Summary: pnpm test passes, QA round ${String(run)}.`
          : `Summary: ${finding?.summary ?? "Adding the same sku twice fails"}, QA round ${String(run)}.`,
        found === "pass"
          ? "Steps: none"
          : `Steps:\n${finding?.steps ?? "1. add('a')\n2. add('a')\n3. The basket has two"}`,
        ...proposingBoth(proposed),
        "</qa-report>",
      ].join("\n"),
    ),
  );
  print(result({ input: 800, output: 100 }));
};

/**
 * Each designer run perhaps commits a styling fix, and reports: changes
 * ask for the basket's button on the style guide's palette.
 */
const designing = async (
  { print, sh }: FakeAgentContext,
  run: number,
  { result: found, fixesStyle = false, silent = false }: DesignRun,
): Promise<void> => {
  if (fixesStyle) {
    await writeFileIn(
      sh,
      "src/basket.css",
      `.basket { gap: 8px; } /* design round ${String(run)} */\n`,
    );
    await sh(
      `git add -A && git commit --quiet -m "style: the basket's spacing, design round ${String(run)}"`,
    );
  }
  if (silent) {
    print(say("Looked."));
    print(result({ input: 900, output: 100 }));
    return;
  }
  print(
    say(
      [
        "Looked at the screenshots.",
        "<design-review>",
        `Result: ${found}`,
        found === "pass"
          ? `Summary: The basket follows docs/style-guide.md at 1280 and 390 px, design round ${String(run)}.`
          : `Summary: The basket's button is off the style guide's palette, design round ${String(run)}.`,
        found === "pass"
          ? "Findings: none"
          : "Findings:\n1. Basket, 1280 px: the Add button is #ff0000; the style guide's primary is #1d4ed8. Use the Button component's primary variant.",
        "</design-review>",
      ].join("\n"),
    ),
  );
  print(result({ input: 900, output: 150 }));
};

/** Each docs run documents the basket in the README and hands it on. */
const documenting = async (
  { print, sh }: FakeAgentContext,
  proposed?: Proposing,
): Promise<void> => {
  await writeFileIn(
    sh,
    "README.md",
    "# Web shop\n\nShoppers add skus to the basket with `add(sku)`.\n",
  );
  await sh(`git add -A && git commit --quiet -m "docs: the basket"`);
  print(
    say(
      [
        "Documented.",
        "<handoff>",
        "Changed: The README says how to add to the basket.",
        "Check: The README's example.",
        "Risks: None.",
        ...proposingBoth(proposed),
        "</handoff>",
      ].join("\n"),
    ),
  );
  print(result({ input: 300, output: 50 }));
};

export async function scenario(
  options: ScenarioOptions = {},
): Promise<Scenario> {
  const written = options.written ?? takes;
  const qaRuns = options.qa ?? [{ result: "pass" }];
  const root = await mkdtemp(join(tmpdir(), "ai-office-scenario-"));
  const remote = join(root, "web-shop.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  await exec("git", ["init", "--quiet", "-b", "main", seed]);
  await writeFile(join(seed, "README.md"), "# Web shop\n");
  if (options.memory !== undefined) {
    await mkdir(join(seed, ".agents"));
    await writeFile(join(seed, memoryPath), options.memory);
  }
  await gitIn(seed, "add", "-A");
  await gitIn(seed, "commit", "--quiet", "-m", "chore: start");
  await gitIn(seed, "push", "--quiet", remote, "main");

  const fake = createFakeGitHub();
  fake.installRepository(repository);
  const github = gitBackedGitHub(fake, remote);
  const bus = createEventBus({ store: memoryEventStore() });
  const stores = memoryStores();
  await createFloors({ store: stores.floors, github, events: bus }).add(
    repository,
  );
  const defaultModels = () =>
    Promise.resolve({ ...initialDefaultModels, ChatGPT: "gpt-5.5" });
  const agents = createAgents({
    store: stores.agents,
    floors: stores.floors,
    events: bus,
    defaultModels,
    roles: stores.roles,
  });
  const quinta = await agents.add("web-shop", {
    role: "reviewer",
    name: "Quinta",
    aiProvider: "ChatGPT",
  });
  const team = await stores.agents.list("web-shop");
  const grace = team.find(
    ({ role, id }) => role === "reviewer" && id !== quinta.id,
  );
  const startingCoder = team.find(({ role }) => role === "coder");
  const starting = team.find(({ role }) => role === "qa");
  const manager = team.find(({ role }) => role === "manager");
  if (
    grace === undefined ||
    startingCoder === undefined ||
    starting === undefined ||
    manager === undefined
  ) {
    throw new Error(
      "A new Floor has a Manager, a coder, a reviewer and a QA Agent.",
    );
  }
  let coder = startingCoder;
  if (options.workRole !== undefined) {
    await stores.roles.create(options.workRole, new Date());
    coder = await agents.add("web-shop", {
      role: options.workRole.id,
      name: "Cora",
    });
    stores.agents.agents.delete(startingCoder.id);
  }
  const qa = options.withQa === false ? undefined : starting;
  if (qa === undefined) {
    stores.agents.agents.delete(starting.id);
  }
  const docs =
    options.withDocs === true
      ? await agents.add("web-shop", { role: "docs", name: "Dora" })
      : undefined;
  const designRuns = options.design ?? [];
  const designer =
    options.design === undefined
      ? undefined
      : await agents.add("web-shop", { role: designerRole, name: "Dee" });
  // The Round Cap is the default, 3.
  await stores.floors.update("web-shop", {
    testCommand: "pnpm test",
    requiredReviewerAgentIds: [grace.id, quinta.id],
  });

  const office = createOfficeSettings({
    store: stores.office,
    floors: stores.floors,
    events: bus,
  });
  const pipeline = createPipeline({ github, events: bus });
  const notices = createNotices({ store: stores.notices, events: bus });
  const prompts: string[] = [];
  const qaPrompts: string[] = [];
  const docsPrompts: string[] = [];
  const designPrompts: string[] = [];
  const memory = createRepositoryMemory({
    github,
    store: stores.memory,
    events: bus,
  });
  const sharedMemory = createSharedMemory({
    store: stores.officeMemory,
    floors: stores.floors,
    events: bus,
  });
  if (options.officeMemory !== undefined) {
    await sharedMemory.setOffice(options.officeMemory);
  }
  for (const [role, entries] of Object.entries(options.roleMemory ?? {})) {
    const agent = team.find((candidate) => candidate.role === role);
    for (const entry of entries) {
      const [proposed] = await sharedMemory.propose({
        floorId: "web-shop",
        issue: 1,
        agentId: agent?.id ?? coder.id,
        role: agent?.role ?? "coder",
        entries: [entry],
      });
      await sharedMemory.decide("web-shop", proposed?.id ?? 0, "accept", {
        by: "owner",
      });
    }
  }
  const shared =
    options.officeMemory === undefined && options.roleMemory === undefined
      ? {}
      : { sharedMemory };
  const mounted: MountedMemory[] = [];
  let mounts: readonly SkillMount[] = [];
  const sandbox = await createFakeSandbox(async (context) => {
    if (context.prompt.includes("a designer Agent in AI Office")) {
      designPrompts.push(context.prompt);
      const run = designPrompts.length;
      await designing(
        context,
        run,
        designRuns[run - 1] ?? designRuns.at(-1) ?? { result: "pass" },
      );
      return;
    }
    if (context.prompt.includes("a docs Agent in AI Office")) {
      docsPrompts.push(context.prompt);
      mounted.push(await mountedMemory("docs", mounts));
      await documenting(context, {
        memory: options.proposals?.docs,
        role: options.roleProposals?.docs,
      });
      return;
    }
    if (context.prompt.includes("a QA Agent in AI Office")) {
      qaPrompts.push(context.prompt);
      mounted.push(await mountedMemory("qa", mounts));
      const run = qaPrompts.length;
      await checking(
        context,
        run,
        qaRuns[run - 1] ??
          qaRuns.at(-1) ?? {
            result: "pass",
          },
        { memory: options.proposals?.qa, role: options.roleProposals?.qa },
      );
      return;
    }
    prompts.push(context.prompt);
    mounted.push(await mountedMemory("coder", mounts));
    if (options.coderCommand !== undefined) {
      context.print(bash(options.coderCommand));
    }
    await coding(context, prompts.length, written, {
      memory: options.proposals?.coder,
      role: options.roleProposals?.coder,
    });
  });
  // The Decision Model, asked with the Manager's Gateway Key while it is on.
  const jev = createFakeDecisionModel();
  const decisionModel = createDecisionModel({
    settings: () =>
      Promise.resolve(options.decisionModel ?? defaultDecisionModelSettings),
    client: jev,
    agents: stores.agents,
  });
  const runner = createSandboxRunner({
    github,
    events: bus,
    toolCallCheck: toolCallCheck(decisionModel),
    sandbox: (environment, _tool, given) => {
      mounts = given;
      return sandbox.provider(environment);
    },
    gateway: () =>
      Promise.resolve({ url: "http://gateway:4000", key: gatewayKey }),
    workDir: join(root, "work"),
    cloneUrl: () => remote,
  });
  const model = createFakeModel();
  const holder: { queue?: WorkQueue } = {};
  const next: IntakeQueue = {
    enqueue: (work) => holder.queue?.enqueue(work) ?? Promise.resolve(),
  };
  // Every Stage works the text of the issue the Owner approved (P1-5).
  const stageGitHub = withApprovedIssues(
    github,
    async () => (await office.intakeSettings()).ownerLogin,
  );
  const sandboxFlow = {
    floors: stores.floors,
    agents: stores.agents,
    github: stageGitHub,
    pipeline,
    notices,
    events: bus,
    runner,
    gitIdentity: (floorId: string) => office.floorGitIdentity(floorId),
    scratchDir: root,
    pushUrl: () => remote,
    queue: next,
    reviews: stores.reviews,
    memory,
    roles: stores.roles,
    ...shared,
  };
  // The Merge Policy waits for CI on its own clock: each wait passes at
  // once, and the checks given finish during the first.
  let clock = Date.now();
  let ciWaits = 0;
  const mergeFlow = createMergeFlow({
    floors: stores.floors,
    agents: stores.agents,
    github,
    notices,
    events: bus,
    reviews: stores.reviews,
    batches: stores.batches,
    pipeline,
    queue: next,
    ownerLogin: async () => (await office.intakeSettings()).ownerLogin,
    now: () => new Date(clock),
    sleep: (ms) => {
      clock += ms;
      ciWaits += 1;
      if (ciWaits === 1) {
        for (const { name, conclusion } of options.ci ?? []) {
          fake.finishCI(repository, branch, {
            conclusion,
            ...(name === undefined ? {} : { name }),
          });
        }
      }
      return Promise.resolve();
    },
  });
  if (options.requiredChecks !== undefined) {
    fake.requireChecks(repository, "main", options.requiredChecks);
  }
  if (options.mergePolicy !== undefined) {
    await stores.floors.update("web-shop", {
      mergePolicy: options.mergePolicy,
    });
  }
  const store = memoryWorkQueueStore(stores.floors);
  const queue = createWorkQueue({
    store,
    agents: stores.agents,
    events: bus,
    limit: () => Promise.resolve(3),
    execute: executeByStage(
      {
        "needs-work": createCoderFlow(sandboxFlow),
        "needs-review": createReviewFlow({
          floors: stores.floors,
          agents: stores.agents,
          github: stageGitHub,
          pipeline,
          notices,
          events: bus,
          models: model,
          defaultModels,
          decisionModel,
          reviews: stores.reviews,
          queue: next,
          memory,
          roles: stores.roles,
          ...shared,
        }),
        "needs-qa": createQaFlow(sandboxFlow),
        "needs-docs": createDocsFlow(sandboxFlow),
        "ready-to-merge": mergeFlow.execute,
      },
      // A designer's work at needs-qa, after QA's.
      { [designerRole]: createDesignFlow(sandboxFlow) },
    ),
  });
  holder.queue = queue;
  const intake = createIntake({
    floors: stores.floors,
    github,
    pipeline,
    queue,
    events: bus,
    settings: () => office.intakeSettings(),
  });
  await queue.start();
  return {
    root,
    remote,
    fake,
    github,
    bus,
    stores,
    notices,
    model,
    jev,
    queue,
    memory,
    sharedMemory,
    mountedMemory: mounted,
    gitIdentity: () => office.floorGitIdentity("web-shop"),
    manager,
    coder,
    grace,
    quinta,
    qa,
    docs,
    designer,
    prompts,
    qaPrompts,
    docsPrompts,
    designPrompts,
    ciWaits: () => ciWaits,
    work: () => [...store.items.values()],
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
    async run() {
      fake.createIssue(repository, {
        title: "Add a basket!",
        body: "Shoppers need a basket they can add to.",
        labels: ["ai-office"],
      });
      for (const { name, actor } of options.issueLabels ?? []) {
        fake.setLabel(repository, 1, name, {
          ...(actor === undefined ? {} : { actor }),
        });
      }
      const { pickedUp } = await intake.poll();
      if (pickedUp.length !== 1) {
        throw new Error("Intake picks up issue #1.");
      }
      await queue.idle();
    },
    async close() {
      await queue.stop();
      mergeFlow.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const answer = (verdict: ReviewVerdict): string => JSON.stringify(verdict);

/** A reviewer's answer approving, with `nits`. */
export const approve = (nits: readonly string[] = []): string =>
  answer({
    verdict: "approve",
    summary: "It does what the issue asks.",
    comments: nits.map((body) => ({
      severity: "nit",
      path: "src/basket.ts",
      line: 1,
      body,
    })),
  });

/** A reviewer's answer with one blocking comment. */
export const requestChanges = (body: string): string =>
  answer({
    verdict: "changes_requested",
    summary: "Shoppers cannot add to the basket yet.",
    comments: [{ severity: "blocking", path: "src/basket.ts", line: 1, body }],
  });

export const ofType = <Type extends OfficeEvent["type"]>(
  events: readonly OfficeEvent[],
  type: Type,
): EventOfType<Type>[] =>
  events.filter((event): event is EventOfType<Type> => event.type === type);

/** An issue's (or pull request's) labels, sorted. */
export const labelsOf = async (current: Scenario, number: number) =>
  [
    ...(await current.fake.repository(repository).getIssue(number)).labels,
  ].sort();

/** Each piece of work's stage and how it ended, oldest first. */
export const workDone = (current: Scenario): string[] =>
  current.work().map(({ stage, status }) => `${stage} ${status}`);
