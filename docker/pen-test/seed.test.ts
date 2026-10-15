// The pen-test seed (seed.ts, Enablement E2, #188): against memory stores and
// against a real database, it makes at least two Floors, Agents in every
// Stage, a Floor whose Merge Policy merges unattended, the AI Accounts at the
// stub, and the corpus's Skill, Floor Template and memory proposal; and a
// second run changes nothing (idempotent).

import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AddAiAccountRequest } from "../../packages/shared/src/index.ts";
import { postgresTest } from "../../packages/db/src/testing/postgres.ts";
import { memoryFloorStore } from "../../packages/orchestrator/src/floors/store.ts";
import { memoryMemoryStore } from "../../packages/orchestrator/src/memory/store.ts";
import { memorySkillStore } from "../../packages/orchestrator/src/skills/store.ts";
import { memoryFloorTemplateStore } from "../../packages/orchestrator/src/templates/store.ts";

import { corpusCanary } from "./corpus.ts";
import {
  corpusSkillId,
  corpusTemplateId,
  seed,
  type SeedAiAccounts,
  type SeedStores,
} from "./seed.ts";
import { databaseSeedStores } from "./seed-stores.ts";

const targetRepository = "acme/pen-test-target";
const stub = "http://stub-upstream:3050";

/** A fake AI Accounts port, backed by an array. */
function fakeAiAccounts(): SeedAiAccounts & {
  readonly added: AddAiAccountRequest[];
} {
  const added: AddAiAccountRequest[] = [];
  return {
    added,
    list: () => Promise.resolve(added.map(({ name }) => ({ name }))),
    add: (request) => {
      added.push(request);
      return Promise.resolve(undefined);
    },
  };
}

function memoryStores(aiAccounts?: SeedAiAccounts): SeedStores {
  const floors = memoryFloorStore();
  return {
    floors,
    agents: floors.agentStore,
    skills: memorySkillStore(),
    templates: memoryFloorTemplateStore(),
    memory: memoryMemoryStore(),
    ...(aiAccounts === undefined ? {} : { aiAccounts }),
  };
}

describe("the pen-test seed, against memory stores", () => {
  it("makes at least two Floors, one of which merges unattended", async () => {
    const result = await seed({
      stores: memoryStores(),
      targetRepository,
      stubUpstreamUrl: stub,
    });
    expect(result.floors.length).toBeGreaterThanOrEqual(2);
    expect(
      result.floors.some((floor) => floor.mergePolicy === "auto_merge"),
    ).toBe(true);
    // The target Floor works the throwaway repository.
    expect(result.floors[0]?.repository).toBe(targetRepository);
  });

  it("gives each Floor an Agent in every Stage", async () => {
    const result = await seed({
      stores: memoryStores(),
      targetRepository,
      stubUpstreamUrl: stub,
    });
    for (const floor of result.floors) {
      const stages = new Set(
        floor.agents.map((agent) => agent.stage).filter((stage) => stage),
      );
      for (const stage of ["work", "review", "qa", "docs"]) {
        expect(stages, `${floor.id} has a ${stage} Agent`).toContain(stage);
      }
      // And exactly one Manager (stage null).
      expect(
        floor.agents.filter((agent) => agent.role === "manager"),
      ).toHaveLength(1);
    }
  });

  it("ensures the AI Accounts that point at the stub upstream only", async () => {
    const accounts = fakeAiAccounts();
    const result = await seed({
      stores: memoryStores(accounts),
      targetRepository,
      stubUpstreamUrl: stub,
    });
    expect(result.aiAccounts).toEqual([
      "Claude (pen-test stub)",
      "Grok (pen-test stub)",
      "Gemini (pen-test stub)",
      "OpenAI-compatible (pen-test stub)",
    ]);
    // Every account's endpoint is under the stub upstream.
    for (const request of accounts.added) {
      expect(request.endpointUrl?.startsWith(stub)).toBe(true);
    }
  });

  it("seeds the corpus's Skill, Floor Template and memory proposal", async () => {
    const stores = memoryStores();
    await seed({ stores, targetRepository, stubUpstreamUrl: stub });

    const [skill] = await stores.skills.list();
    expect(skill?.id).toBe(corpusSkillId);
    // An imported Skill waits unreviewed and disabled (FR-76).
    expect(skill?.enabled).toBe(false);
    expect(skill?.reviewedAt).toBeNull();

    const [template] = await stores.templates.list();
    expect(template?.id).toBe(corpusTemplateId);
    expect(template?.source).toBe("git");
    expect(template?.reviewedAt).toBeNull();

    const pending = await stores.memory.pending("pen-test-target");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.text).toContain(corpusCanary("memory-proposal"));
  });

  it("exposes the whole corpus, with a canary and hypothesis on every item", async () => {
    const result = await seed({
      stores: memoryStores(),
      targetRepository,
      stubUpstreamUrl: stub,
    });
    expect(result.corpus.length).toBeGreaterThanOrEqual(8);
    for (const item of result.corpus) {
      expect(item.canary).toBe(corpusCanary(item.id));
      expect(["H8", "H9", "H10", "H13"]).toContain(item.hypothesis);
    }
  });

  it("is idempotent: a second run changes nothing", async () => {
    const accounts = fakeAiAccounts();
    const stores = memoryStores(accounts);
    const first = await seed({
      stores,
      targetRepository,
      stubUpstreamUrl: stub,
    });
    const second = await seed({
      stores,
      targetRepository,
      stubUpstreamUrl: stub,
    });

    expect(second.floors).toEqual(first.floors);
    expect((await stores.skills.list()).length).toBe(1);
    expect((await stores.templates.list()).length).toBe(1);
    expect(await stores.memory.pending("pen-test-target")).toHaveLength(1);
    expect(accounts.added).toHaveLength(4);
  });
});

describe("the pen-test seed, against a database", () => {
  const encryptionKey = randomBytes(32).toString("base64");

  postgresTest(
    "produces every item, and a second run changes nothing",
    async ({ database }) => {
      const stores = databaseSeedStores(database.db, encryptionKey);
      const first = await seed({
        stores,
        targetRepository,
        stubUpstreamUrl: stub,
      });

      // Two Floors, one unattended, Agents in every Stage.
      expect(first.floors.length).toBeGreaterThanOrEqual(2);
      expect(
        first.floors.some((floor) => floor.mergePolicy === "auto_merge"),
      ).toBe(true);
      for (const floor of first.floors) {
        const stages = new Set(
          floor.agents.map((agent) => agent.stage).filter((stage) => stage),
        );
        for (const stage of ["work", "review", "qa", "docs"]) {
          expect(stages).toContain(stage);
        }
      }

      // The four stub AI Accounts, the Skill, the Floor Template, the memory
      // proposal.
      expect(first.aiAccounts).toHaveLength(4);
      expect(first.skill.id).toBe(corpusSkillId);
      expect(first.template.id).toBe(corpusTemplateId);
      expect(first.memoryProposal.id).toBeGreaterThan(0);

      // Idempotent: the same Floors and Agents, and no duplicate rows.
      const second = await seed({
        stores,
        targetRepository,
        stubUpstreamUrl: stub,
      });
      expect(second.floors).toEqual(first.floors);
      expect(await stores.floors.list()).toHaveLength(2);
      expect((await stores.skills.list()).length).toBe(1);
      expect((await stores.templates.list()).length).toBe(1);
      expect(await stores.memory.pending("pen-test-target")).toHaveLength(1);
      expect(second.aiAccounts).toHaveLength(4);
    },
  );
});
