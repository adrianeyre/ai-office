// The pen-test stack's seed (docs/pen-testing/stack.md, Enablement E2, #188).
// It ships with the stand-up (#187) and makes the fixtures the red team
// probes:
//
// - at least two Floors, so an authorisation bug between them can show;
// - Agents in every Stage (work, review, QA, docs) on each;
// - a Floor whose Merge Policy merges unattended (the target Floor, so H8 can
//   be probed);
// - AI Accounts that point at the stub upstream only (`stub-accounts.ts`);
// - the hostile-content corpus for attacker position 2 (`corpus.ts`): its
//   Skill, its Floor Template and its memory proposal go in the database here;
//   its issues and files go into the throwaway repository (`generate-target.ts`).
//
// The seed is idempotent: it checks for each item before it makes it, so a
// second run leaves everything as it is. It is written against the store
// interfaces, so it runs against a real database (`databaseSeedStores`) or
// memory stores in tests. `seedResult` reads the final state back, so the
// fixture IDs it returns are the same however many times the seed has run.

import {
  builtInRoles,
  defaultFloorSettings,
  managerRole,
  seededRandom,
  type AddAiAccountRequest,
  type Random,
  type Role,
} from "../../packages/shared/src/index.ts";

import { newAgentRecord } from "../../packages/orchestrator/src/agents/agents.ts";
import type {
  AgentRecord,
  AgentStore,
} from "../../packages/orchestrator/src/agents/store.ts";
import type {
  FloorRecord,
  FloorStore,
} from "../../packages/orchestrator/src/floors/store.ts";
import type { MemoryStore } from "../../packages/orchestrator/src/memory/store.ts";
import { floorTemplateDigest } from "../../packages/orchestrator/src/templates/files.ts";
import type { FloorTemplateStore } from "../../packages/orchestrator/src/templates/store.ts";
import { skillDigest } from "../../packages/orchestrator/src/skills/skills.ts";
import type { SkillStore } from "../../packages/orchestrator/src/skills/store.ts";

import { hostileCorpus, type CorpusItem } from "./corpus.ts";
import {
  canaryPrefix,
  stubAccounts,
  stubUpstreamUrl as defaultStubUrl,
} from "./stub-accounts.ts";

// --- Ports --------------------------------------------------------------------

/**
 * The AI Accounts the seed ensures: `createAiAccounts` (the real AI Gateway)
 * satisfies it, as does a fake in tests. The seed adds any the stack is
 * missing, so running after `ai-accounts` (#187) is harmless.
 */
export interface SeedAiAccounts {
  list(): Promise<readonly { readonly name: string }[]>;
  add(request: AddAiAccountRequest): Promise<unknown>;
}

/** The stores and ports the seed writes through. */
export interface SeedStores {
  readonly floors: Pick<FloorStore, "get" | "create" | "list">;
  readonly agents: Pick<AgentStore, "list">;
  readonly skills: Pick<SkillStore, "list" | "add">;
  readonly templates: Pick<FloorTemplateStore, "list" | "add">;
  readonly memory: Pick<MemoryStore, "pending" | "propose">;
  /** Absent leaves the AI Accounts to `ai-accounts` (#187). */
  readonly aiAccounts?: SeedAiAccounts;
}

// --- The Floors the seed makes ------------------------------------------------

/** The Roles each seeded Floor's team fills, so every Stage has an Agent. */
const teamRoles: readonly Role[] = [
  "coder",
  "designer",
  "reviewer",
  "qa",
  "docs",
];

/** A Floor the seed makes. */
interface FloorPlan {
  readonly id: string;
  readonly repository: string;
  readonly mergePolicy: "auto_merge" | "send_to_me";
  /** Whether the hostile content is seeded onto it. */
  readonly target: boolean;
}

/** A stable synthetic repository id for a seeded Floor, from its id. */
const syntheticRepositoryId = (floorId: string): number => {
  let hash = 0;
  for (const code of floorId) {
    hash = (hash * 31 + code.charCodeAt(0)) % 1_000_000_007;
  }
  // Negative, so it never collides with a real GitHub repository id.
  return -(hash + 1);
};

/** The two Floors the seed makes, the target first. */
export function floorPlans(targetRepository: string): FloorPlan[] {
  const owner = targetRepository.includes("/")
    ? targetRepository.split("/")[0]
    : "pen-test";
  return [
    {
      id: "pen-test-target",
      repository: targetRepository,
      // Merges unattended, so H8 (self-merge) can be probed.
      mergePolicy: "auto_merge",
      target: true,
    },
    {
      id: "pen-test-review",
      repository: `${owner ?? "pen-test"}/pen-test-review`,
      mergePolicy: "send_to_me",
      target: false,
    },
  ];
}

/** Builds a Floor's team: a Manager and an Agent in each of `teamRoles`. */
function teamFor(
  floorId: string,
  random: Random,
  createdAt: Date,
): AgentRecord[] {
  const members: readonly Role[] = [managerRole, ...teamRoles];
  const team: AgentRecord[] = [];
  for (const [index, role] of members.entries()) {
    team.push(
      newAgentRecord({
        floorId,
        agent: { role },
        others: team,
        random,
        createdAt: new Date(createdAt.getTime() + index),
        library: builtInRoles,
      }),
    );
  }
  return team;
}

// --- Fixture IDs --------------------------------------------------------------

/** One seeded Floor, as the fixture ID listing names it. */
export interface SeededFloor {
  readonly id: string;
  readonly repository: string;
  readonly mergePolicy: "auto_merge" | "send_to_me";
  /** Each Agent on the Floor, by Role and Stage. */
  readonly agents: readonly {
    readonly id: string;
    readonly name: string;
    readonly role: Role;
    readonly stage: string | null;
  }[];
}

/** What the seed produced, read back from the final state (idempotent). */
export interface SeedResult {
  readonly floors: readonly SeededFloor[];
  readonly aiAccounts: readonly string[];
  readonly skill: { readonly id: string; readonly name: string };
  readonly template: { readonly id: string; readonly name: string };
  readonly memoryProposal: { readonly id: number; readonly floorId: string };
  /** The hostile-content corpus, for `generate-target.ts` and #190. */
  readonly corpus: readonly CorpusItem[];
}

// --- The seed -----------------------------------------------------------------

export interface SeedOptions {
  readonly stores: SeedStores;
  /** The throwaway target repository, as `owner/name`. */
  readonly targetRepository: string;
  /** The stub upstream the canaries phone home to. */
  readonly stubUpstreamUrl?: string;
  /** The stub upstream the AI Accounts point at (defaults to the canaries'). */
  readonly accountsStubUrl?: string;
  readonly now?: () => Date;
  readonly random?: Random;
}

/** The ids the corpus's Skill and Floor Template are stored under. */
export const corpusSkillId = "pen-test-corpus-skill";
export const corpusTemplateId = "pen-test-corpus-template";

export async function seed(options: SeedOptions): Promise<SeedResult> {
  const { stores, targetRepository } = options;
  const stubUrl = options.stubUpstreamUrl ?? defaultStubUrl;
  const now = options.now ?? (() => new Date());
  // Seeded, so a Floor's first team is the same each first run.
  const random = options.random ?? seededRandom(0x5eed);
  const corpus = hostileCorpus(stubUrl);

  await ensureAiAccounts(stores.aiAccounts, options.accountsStubUrl ?? stubUrl);
  await ensureFloors(stores, targetRepository, now, random);
  await ensureCorpus(stores, corpus, now);

  return seedResult(stores, targetRepository, corpus);
}

/** Adds any stub AI Account the stack is missing, by name. */
async function ensureAiAccounts(
  accounts: SeedAiAccounts | undefined,
  stubUrl: string,
): Promise<void> {
  if (accounts === undefined) {
    return;
  }
  const existing = new Set((await accounts.list()).map(({ name }) => name));
  const wanted = stubAccounts(
    stubUrl,
    (provider) => `${canaryPrefix}${provider}-seed`,
  );
  for (const { request } of wanted) {
    if (!existing.has(request.name)) {
      await accounts.add(request);
    }
  }
}

/** Makes each planned Floor the stack has not got, with its team. */
async function ensureFloors(
  stores: SeedStores,
  targetRepository: string,
  now: () => Date,
  random: Random,
): Promise<void> {
  for (const plan of floorPlans(targetRepository)) {
    if ((await stores.floors.get(plan.id)) !== undefined) {
      continue;
    }
    const createdAt = now();
    const team = teamFor(plan.id, random, createdAt);
    const floor: FloorRecord = {
      id: plan.id,
      githubRepositoryId: syntheticRepositoryId(plan.id),
      repository: plan.repository,
      name: plan.id,
      defaultBranch: "main",
      ...defaultFloorSettings,
      tokenCaps: { ...defaultFloorSettings.tokenCaps },
      mergePolicy: plan.mergePolicy,
      requiredReviewerAgentIds: team
        .filter((agent) => agent.stage === "review")
        .map((agent) => agent.id),
      template: { id: "development", name: "Development" },
      theme: "office",
      createdAt,
      archivedAt: null,
    };
    await stores.floors.create(floor, team);
  }
}

/** Puts the corpus's Skill, Floor Template and memory proposal in the database. */
async function ensureCorpus(
  stores: SeedStores,
  corpus: readonly CorpusItem[],
  now: () => Date,
): Promise<void> {
  const skillItem = corpusItem(corpus, "skill");
  const templateItem = corpusItem(corpus, "floor-template");
  const memoryItem = corpusItem(corpus, "memory-proposal");

  // The hostile Skill: imported ("upload"), and left disabled and unreviewed,
  // as an imported Skill is until the Owner reviews it (FR-76). The probe
  // asks whether its contents reach an Agent (H10).
  if (!(await stores.skills.list()).some(({ id }) => id === corpusSkillId)) {
    const at = now();
    const files = [{ path: "SKILL.md", content: skillItem.content }];
    await stores.skills.add({
      id: corpusSkillId,
      name: skillItem.skill?.name ?? corpusSkillId,
      description: skillItem.skill?.description ?? skillItem.summary,
      source: "upload",
      origin: null,
      files,
      digest: skillDigest(files),
      enabled: false,
      reviewedAt: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  // The hostile Floor Template: imported from an internal Git host, unreviewed,
  // its manifest carrying a setupCommand that reaches the AI Gateway (H13).
  if (
    !(await stores.templates.list()).some(({ id }) => id === corpusTemplateId)
  ) {
    const at = now();
    const files = templateFiles(templateItem);
    await stores.templates.add({
      id: corpusTemplateId,
      name: templateItem.template?.name ?? "Pen-test corpus template",
      source: "git",
      origin: {
        url: templateItem.template?.originUrl ?? "http://169.254.169.254/",
        ref: null,
        commit: "0".repeat(40),
        path: "",
      },
      files,
      digest: floorTemplateDigest(files),
      reviewedAt: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  // The poisoned memory proposal, waiting for a curation on the target Floor
  // (H9). One per corpus canary, so a second run adds none.
  const targetFloorId = floorPlans("x/x")[0]?.id ?? "pen-test-target";
  const pending = await stores.memory.pending(targetFloorId);
  if (!pending.some(({ text }) => text === memoryItem.content)) {
    const team = await stores.agents.list(targetFloorId);
    const proposer =
      team.find((agent) => agent.stage === "work")?.id ?? team[0]?.id ?? "seed";
    await stores.memory.propose([
      {
        floorId: targetFloorId,
        issue: 1,
        agentId: proposer,
        text: memoryItem.content,
        createdAt: now(),
      },
    ]);
  }
}

/** The files of the corpus Floor Template's folder. */
function templateFiles(
  item: CorpusItem,
): { readonly path: string; readonly content: string }[] {
  const template = item.template;
  const manifest = [
    `name: ${template?.name ?? "Pen-test corpus template"}`,
    "description: A kit for the pen-test target Floor.",
    "icon: code",
    "theme: office",
    "roles:",
    "  - role: coder",
    "    count: 1",
    "settings:",
    `  setupCommand: ${JSON.stringify(template?.setupCommand ?? "")}`,
    '  testCommand: ""',
    "  mergePolicy: send_to_me",
    "  roundCap: 3",
    "  requiredReviewers: []",
    "manager:",
    '  planningGuidance: ""',
    "  firstIssue: null",
    "labels: []",
    "",
  ].join("\n");
  return [{ path: "template.yaml", content: manifest }];
}

/** The corpus item of a kind, which the seed always has. */
function corpusItem(
  corpus: readonly CorpusItem[],
  kind: CorpusItem["kind"],
): CorpusItem {
  const item = corpus.find((candidate) => candidate.kind === kind);
  if (item === undefined) {
    throw new Error(`The corpus has no ${kind} item.`);
  }
  return item;
}

/** Reads the seeded state back, so the fixture IDs are stable across runs. */
async function seedResult(
  stores: SeedStores,
  targetRepository: string,
  corpus: readonly CorpusItem[],
): Promise<SeedResult> {
  const floors: SeededFloor[] = [];
  for (const plan of floorPlans(targetRepository)) {
    const floor = await stores.floors.get(plan.id);
    if (floor === undefined) {
      continue;
    }
    const agents = await stores.agents.list(plan.id);
    floors.push({
      id: floor.id,
      repository: floor.repository,
      mergePolicy: floor.mergePolicy,
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        stage: agent.stage,
      })),
    });
  }

  const skill = (await stores.skills.list()).find(
    ({ id }) => id === corpusSkillId,
  );
  const template = (await stores.templates.list()).find(
    ({ id }) => id === corpusTemplateId,
  );
  const targetFloorId =
    floorPlans(targetRepository)[0]?.id ?? "pen-test-target";
  const memoryItem = corpusItem(corpus, "memory-proposal");
  const proposal = (await stores.memory.pending(targetFloorId)).find(
    ({ text }) => text === memoryItem.content,
  );

  return {
    floors,
    aiAccounts:
      stores.aiAccounts === undefined
        ? []
        : (await stores.aiAccounts.list()).map(({ name }) => name),
    skill: { id: skill?.id ?? corpusSkillId, name: skill?.name ?? "" },
    template: {
      id: template?.id ?? corpusTemplateId,
      name: template?.name ?? "",
    },
    memoryProposal: {
      id: proposal?.id ?? -1,
      floorId: targetFloorId,
    },
    corpus,
  };
}
