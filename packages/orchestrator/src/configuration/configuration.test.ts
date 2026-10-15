import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  configurationSchema,
  createRedactor,
  type Configuration,
  type ModelPrice,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { createFloors } from "../floors/floors.ts";
import { createOfficeSettings } from "../office/settings.ts";
import { createSkillLibrary } from "../skills/skills.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createFloorTemplateLibrary } from "../templates/library.ts";
import { loadFloorTemplates } from "../templates/load.ts";
import {
  ConfigurationError,
  createConfiguration,
  type ConfigurationService,
  type ModelPriceOverrides,
} from "./configuration.ts";

// Configuration export and import (PRD FR-65): an export of a configured
// Office, imported into an empty one, reproduces its configuration; no
// credential is ever in an export; an import is previewed, adds and
// changes but never removes, and is refused whole when it has problems.
// The Role library travels with it (FR-98, ADR 0003), so a Floor's Agents
// arrive in the Owner's own Roles, and so do the Owner's own Floor
// Templates (FR-101), which wait for review once imported.

/** An AI Account's key, as the server registers it with the redactor. */
const aiAccountKey = "sk-ant-api03-configuration-export-test-0123456789abcdef";

function memoryPrices(): ModelPriceOverrides {
  const prices = new Map<string, ModelPrice>();
  return {
    list: () =>
      Promise.resolve(
        [...prices].map(([model, price]) => ({ model, price: { ...price } })),
      ),
    set(model, price) {
      prices.set(model, { ...price });
      return Promise.resolve();
    },
  };
}

interface Office {
  readonly stores: OfficeStores;
  readonly bus: EventBus;
  readonly prices: ModelPriceOverrides;
  readonly configuration: ConfigurationService;
}

function office(stores: OfficeStores, bus: EventBus): Office {
  const prices = memoryPrices();
  let id = 0;
  return {
    stores,
    bus,
    prices,
    configuration: createConfiguration({
      stores,
      events: bus,
      modelPrices: prices,
      redactor: createRedactor({ secrets: [aiAccountKey] }),
      now: () => new Date("2026-10-10T09:00:00.000Z"),
      newId: () => `imported-skill-${String(++id)}`,
    }),
  };
}

const skillFiles = (name: string, body: string) => [
  {
    path: "SKILL.md",
    content: `---\nname: ${name}\ndescription: ${name} for the tests.\n---\n\n${body}\n`,
  },
  { path: "notes/checklist.md", content: "- one\n- two\n" },
];

/** Configures an Office the way the Owner would, in every area. */
async function configure(source: Office): Promise<void> {
  const { stores, bus } = source;
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  github.installRepository("adrianeyre/docs");
  const floors = createFloors({ store: stores.floors, github, events: bus });
  await floors.add("adrianeyre/web-shop");
  await floors.add("adrianeyre/blog");
  await floors.add("adrianeyre/docs");

  const settings = createOfficeSettings({
    store: stores.office,
    floors: stores.floors,
    events: bus,
  });
  await settings.setGitIdentity({
    name: "Adrian Eyre",
    email: "adrian@company.example",
  });
  await settings.setIntakeSettings({
    ownerLogin: "adrianeyre",
    intervalSeconds: 120,
  });
  await settings.setSandboxSettings({ concurrencyLimit: 5 });
  await settings.setRequestBodiesSettings({ store: false });
  await settings.setLoadBalancingSettings({
    strategy: "least_used",
    sessionWindowMinutes: 120,
  });
  await settings.setRetrySettings({
    attempts: 4,
    delayMs: 250,
    multiplier: 1.5,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownSeconds: 90,
  });
  await settings.setUsageThrottlingSettings({
    fiveHourPacing: true,
    weeklyPacing: false,
  });
  await settings.setPromptCacheSettings({ ttl: "1h" });
  await settings.setRetentionSettings({
    requestBodiesDays: 3,
    requestMetadataDays: 60,
    activityDays: 730,
    connectionDeliveriesDays: 45,
  });
  const at = new Date("2026-10-09T12:00:00.000Z");
  await stores.tokenCaps.setOfficeCaps(
    { daily: 2_000_000, monthly: 40_000_000 },
    at,
  );
  await stores.aiProviders.setDefaultModel("ChatGPT", "gpt-5.5", at);
  await source.prices.set("claude-opus-5-5", {
    input: 4,
    output: 20,
    cacheWrite: 5,
    cacheRead: 0.4,
  });
  await stores.officeMemory.setOffice(
    "# Standards\n\nUse pnpm. Prefer small pull requests.",
    at,
  );

  // Skills: one the Owner wrote, one uploaded and reviewed, one waiting.
  const library = createSkillLibrary({ store: stores.skills, events: bus });
  await library.add({
    source: "editor",
    files: skillFiles("release-notes", "Write the release notes."),
  });
  const uploaded = await library.add({
    source: "upload",
    files: skillFiles("triage-bugs", "Triage the bug."),
  });
  await library.review(uploaded.id, uploaded.digest);
  await library.add({
    source: "upload",
    files: skillFiles("unreviewed", "Not read yet."),
  });

  // web-shop: its settings, a second coder, edited Agents, caps, toggles
  // and Role memory.
  const team = await stores.agents.list("web-shop");
  const coder = team.find(({ role }) => role === "coder");
  const reviewer = team.find(({ role }) => role === "reviewer");
  if (coder === undefined || reviewer === undefined) {
    throw new Error("A new Floor has a coder and a reviewer.");
  }
  // Names no new Floor's team is given (`agentNames`), so neither is
  // ever taken on web-shop already.
  expect(
    await stores.agents.update({
      ...coder,
      name: "Ada Lovelace",
      effort: "high",
      extraInstructions: "Keep functions small.",
      tokenCaps: { daily: 300_000, monthly: null },
      freshStartThreshold: 70,
    }),
  ).toBe("updated");
  expect(
    await stores.agents.create({
      ...coder,
      id: "web-shop-coder-2",
      name: "Linus Torvalds",
      aiProvider: "ChatGPT",
      modelOverride: "gpt-5.5-codex",
      effort: "medium",
      enabled: false,
      createdAt: new Date("2026-10-09T13:00:00.000Z"),
    }),
  ).toBe("created");
  await floors.updateSettings("web-shop", {
    // The Owner renamed it (FR-7); its id stays.
    name: "Storefront",
    setupCommand: "pnpm install",
    testCommand: "pnpm test",
    mergePolicy: "auto_merge",
    roundCap: 4,
    tokenCaps: { daily: 1_000_000, monthly: null },
    concurrencyLimit: 2,
    priority: 3,
    planApproval: false,
    freshStartThreshold: 90,
    gitIdentity: { name: "Web Shop", email: "shop@company.example" },
    requiredReviewerAgentIds: [reviewer.id],
  });
  await stores.tokenCaps.setIssueCaps(
    "web-shop",
    4,
    { daily: 50_000, monthly: 400_000 },
    at,
  );
  await stores.floorSkills.set(
    "web-shop",
    { skillName: "release-notes", role: "qa", enabled: false },
    at,
  );
  await stores.floorSkills.set(
    "web-shop",
    { skillName: "triage-bugs", role: "coder", enabled: true },
    at,
  );
  const proposed = await stores.officeMemory.propose([
    {
      floorId: "web-shop",
      role: "coder",
      text: "Run the linter before committing.",
      issue: 4,
      agentId: coder.id,
      createdAt: at,
    },
    {
      floorId: "web-shop",
      role: "qa",
      text: "Check prices in pence.",
      issue: 5,
      agentId: coder.id,
      createdAt: at,
    },
  ]);
  for (const entry of proposed) {
    await stores.officeMemory.change(entry.id, "proposed", {
      status: "accepted",
      decidedBy: "owner",
      decidedAt: at,
      reason: null,
    });
  }
  // A proposal still waiting is no part of the configuration.
  await stores.officeMemory.propose([
    {
      floorId: "web-shop",
      role: "coder",
      text: "Waiting for a decision.",
      issue: 6,
      agentId: coder.id,
      createdAt: at,
    },
  ]);
  // The docs Floor is archived.
  await floors.archive("docs");
}

/**
 * Adds a Floor from the Online store Floor Template (FR-97), whose Roles
 * and Skills join the libraries, and makes a Role of the Owner's own.
 */
async function configureRoles(source: Office): Promise<void> {
  const { stores, bus } = source;
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/shop-theme");
  const floors = createFloors({
    store: stores.floors,
    github,
    events: bus,
    agents: stores.agents,
    roles: stores.roles,
    skills: stores.skills,
    templates: await loadFloorTemplates(),
    defaultModels: () => stores.aiProviders.defaultModels(),
  });
  // Its brand reviewer suggests ChatGPT.
  for (const [aiProvider, model] of [
    ["Claude", "claude-opus-5-5"],
    ["ChatGPT", "gpt-5.5"],
  ] as const) {
    await stores.aiProviders.setDefaultModel(
      aiProvider,
      model,
      new Date("2026-10-09T12:00:00.000Z"),
    );
  }
  await floors.add("adrianeyre/shop-theme", "online-store");
  const at = new Date("2026-10-09T12:00:00.000Z");
  const reviewer = await stores.roles.get("reviewer");
  if (reviewer === undefined) {
    throw new Error("The library has the reviewer.");
  }
  expect(
    await stores.roles.create(
      {
        ...reviewer,
        id: "legal-reviewer",
        name: "legal reviewer",
        description: "Reviews the terms and the returns policy.",
        instructions: "Check every claim against the terms.",
        skills: ["product-data"],
      },
      at,
    ),
  ).toBe(true);
  expect(
    await stores.roles.update(
      { ...reviewer, instructions: "Review it as a shopper would." },
      at,
    ),
  ).toBe(true);
  const [brandReviewer] = (await stores.agents.list("shop-theme")).filter(
    ({ role }) => role === "brand-reviewer",
  );
  if (brandReviewer === undefined) {
    throw new Error("Online store starts with a brand reviewer.");
  }
  expect(
    await stores.agents.create({
      ...brandReviewer,
      id: "shop-theme-legal-reviewer",
      name: "Ruth Ginsburg",
      role: "legal-reviewer",
      createdAt: new Date("2026-10-09T13:00:00.000Z"),
    }),
  ).toBe("created");
  await floors.updateSettings("shop-theme", {
    requiredReviewerAgentIds: [brandReviewer.id, "shop-theme-legal-reviewer"],
  });
  await stores.officeMemory.propose([
    {
      floorId: "shop-theme",
      role: "merchandiser",
      text: "Prices are in pence.",
      issue: 2,
      agentId: brandReviewer.id,
      createdAt: at,
    },
  ]);
  for (const entry of await stores.officeMemory.entries("shop-theme", [
    "proposed",
  ])) {
    await stores.officeMemory.change(entry.id, "proposed", {
      status: "accepted",
      decidedBy: "owner",
      decidedAt: at,
      reason: null,
    });
  }
}

/** An export as a file holds it: JSON, read back and checked. */
const asFile = (configuration: Configuration): Configuration =>
  configurationSchema.parse(JSON.parse(JSON.stringify(configuration)));

const withoutTime = (configuration: Configuration) => ({
  ...configuration,
  exportedAt: "",
});

/** Each imported Skill is reviewed and enabled as it was, as the Owner would. */
async function reviewImportedSkills(
  target: Office,
  exported: Configuration,
): Promise<void> {
  const library = createSkillLibrary({
    store: target.stores.skills,
    events: target.bus,
  });
  for (const skill of await library.list()) {
    if (exported.skills.find(({ name }) => name === skill.name)?.enabled) {
      await library.review(skill.id, skill.digest);
    }
  }
}

type Case = [
  name: string,
  run: (source: Office, target: Office) => Promise<void>,
];

const cases: Case[] = [
  [
    "the Owner's own Floor Templates are in it, and an imported one waits for review",
    async (source, target) => {
      const builtIn = await loadFloorTemplates();
      const libraryOf = (office: Office) =>
        createFloorTemplateLibrary({
          builtIn,
          store: office.stores.floorTemplates,
          roles: office.stores.roles,
          skills: office.stores.skills,
          events: office.bus,
        });
      const configurationOf = (office: Office) =>
        createConfiguration({
          stores: office.stores,
          events: office.bus,
          modelPrices: office.prices,
          builtInTemplates: builtIn,
        });
      const here = libraryOf(source);
      await here.duplicate("development", "Small team");
      const edited = await here.update("small-team", {
        roles: [
          { role: "coder", count: 2 },
          { role: "reviewer", count: 1 },
        ],
      });

      const exported = asFile(await configurationOf(source).export());
      expect(exported.floorTemplates).toEqual([
        {
          id: "small-team",
          source: "duplicate",
          origin: null,
          files: expect.any(Array) as unknown,
          enabled: true,
        },
      ]);
      const preview = await configurationOf(target).preview(exported);
      expect(preview.problems).toEqual([]);
      expect(
        preview.changes.filter(({ area }) => area === "floor_template"),
      ).toEqual([
        {
          area: "floor_template",
          subject: "small-team",
          action: "add",
          fields: [],
          note: "It waits for your review before a Floor can be added from it.",
        },
      ]);
      await configurationOf(target).import(exported);
      const there = libraryOf(target);
      const imported = await there.get("small-team");
      expect(imported).toMatchObject({
        source: "duplicate",
        enabled: false,
        digest: edited.digest,
      });
      expect(imported.template).toEqual(edited.template);
      expect(
        (await target.bus.eventsAfter(0))
          .map(({ event }) => event)
          .filter(({ type }) => type.startsWith("floor_template.")),
      ).toEqual([
        {
          type: "floor_template.added",
          version: 1,
          templateId: "small-team",
          name: "Small team",
          source: "duplicate",
          duplicatedFrom: null,
          floorId: null,
          enabled: false,
        },
      ]);
      // Reviewed there, the same document changes nothing.
      await there.review("small-team", imported.digest);
      expect(
        (await configurationOf(target).preview(exported)).changes.filter(
          ({ area }) => area === "floor_template",
        ),
      ).toEqual([]);

      // Changed here, it replaces the one there, which waits again.
      await here.update("small-team", { theme: "studio" });
      const changed = asFile(await configurationOf(source).export());
      await configurationOf(target).import(changed);
      expect(await there.get("small-team")).toMatchObject({
        enabled: false,
        template: { theme: "studio" },
      });

      // One called as a built-in one is, or as another here is, is refused.
      const clashing = {
        ...changed,
        floorTemplates: [
          {
            ...changed.floorTemplates[0],
            id: "small-team-2",
          },
        ],
      } as Configuration;
      expect(
        (await configurationOf(target).preview(clashing)).problems,
      ).toEqual([
        "The Floor Template small-team-2 is called Small team, as small-team here is.",
      ]);
      const builtInId = {
        ...changed,
        floorTemplates: [{ ...changed.floorTemplates[0], id: "blank" }],
      } as Configuration;
      expect(
        (await configurationOf(target).preview(builtInId)).problems,
      ).toEqual([
        "The Floor Template blank is a built-in one here, which an import does not change.",
      ]);
    },
  ],
  [
    "an export imported into an empty Office reproduces its configuration",
    async (source, target) => {
      await configure(source);
      const exported = asFile(await source.configuration.export());
      // Every area is in it.
      const floor = (id: string) =>
        exported.floors.find((other) => other.id === id);
      expect(
        exported.floors
          .map(({ id, archived }) => [id, archived])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ["blog", false],
        ["docs", true],
        ["web-shop", false],
      ]);
      expect(exported.office.promptCache).toEqual({ ttl: "1h" });
      expect(exported.office.retention).toEqual({
        requestBodiesDays: 3,
        requestMetadataDays: 60,
        activityDays: 730,
        connectionDeliveriesDays: 45,
      });
      expect(floor("web-shop")?.agents).toHaveLength(5);
      // Fresh Start thresholds (FR-86): the Floor's, and an Agent's own.
      expect(floor("web-shop")?.freshStartThreshold).toBe(90);
      expect(
        floor("web-shop")?.agents.find(({ name }) => name === "Ada Lovelace")
          ?.freshStartThreshold,
      ).toBe(70);
      expect(floor("web-shop")?.roleMemory).toHaveLength(2);
      expect(floor("web-shop")?.skillToggles).toHaveLength(2);
      expect(
        exported.skills.map(({ name, enabled }) => [name, enabled]),
      ).toEqual([
        ["release-notes", true],
        ["triage-bugs", true],
        ["unreviewed", false],
      ]);

      const preview = await target.configuration.preview(exported);
      expect(preview.problems).toEqual([]);
      expect(
        preview.changes.filter(({ area }) => area === "floor"),
      ).toContainEqual(
        expect.objectContaining({ subject: "web-shop", action: "add" }),
      );
      // A preview changes nothing.
      expect(
        await target.stores.floors.list({ includeArchived: true }),
      ).toEqual([]);

      const applied = await target.configuration.import(exported);
      expect(applied).toEqual(preview);

      // Imported Skills wait for review (FR-76); everything else is as it was.
      const imported = asFile(await target.configuration.export());
      expect(imported.skills.map(({ enabled }) => enabled)).toEqual([
        false,
        false,
        false,
      ]);
      expect(withoutTime(imported)).toEqual({
        ...withoutTime(exported),
        skills: exported.skills.map((skill) => ({ ...skill, enabled: false })),
      });
      await reviewImportedSkills(target, exported);
      expect(withoutTime(asFile(await target.configuration.export()))).toEqual(
        withoutTime(exported),
      );

      // Importing it again changes nothing.
      expect(await target.configuration.preview(exported)).toEqual({
        changes: [],
        problems: [],
      });
    },
  ],
  [
    "no credential is ever in an export",
    async (source) => {
      await configure(source);
      // The Owner pasted an AI Account's key into an Agent's instructions.
      const [agent] = await source.stores.agents.list("blog");
      if (agent === undefined) {
        throw new Error("blog has a team.");
      }
      await source.stores.agents.update({
        ...agent,
        extraInstructions: `Call the API with ${aiAccountKey} if stuck.`,
      });
      const text = JSON.stringify(await source.configuration.export());
      expect(text).not.toContain(aiAccountKey);
      expect(text).toContain("[REDACTED]");
      // And no field that could hold one.
      expect(text).not.toMatch(
        /"(credential|password|passwordHash|secret|totp\w*|token|accessToken|refreshToken|key|keyHash|apiKey)"\s*:/i,
      );
    },
  ],
  [
    "adds and changes what is here, never removing what the document lacks",
    async (source, target) => {
      await configure(source);
      const exported = asFile(await source.configuration.export());
      await target.configuration.import(exported);
      // The Owner changes things here: a Floor, an Agent, a setting.
      const changed: Configuration = {
        ...exported,
        office: {
          ...exported.office,
          sandboxes: { concurrencyLimit: 7 },
          promptCache: { ttl: "5m" },
        },
        floors: exported.floors.map((floor) =>
          floor.id === "blog"
            ? {
                ...floor,
                roundCap: 5,
                agents: floor.agents.map((agent) =>
                  agent.role === "coder"
                    ? { ...agent, extraInstructions: "Write tests first." }
                    : agent,
                ),
              }
            : floor,
        ),
      };
      // …and one Floor is left out of the document.
      const without = {
        ...changed,
        floors: changed.floors.filter(({ id }) => id !== "web-shop"),
      };
      const preview = await target.configuration.preview(without);
      expect(preview.problems).toEqual([]);
      expect(
        preview.changes.map(({ area, subject, action, fields }) => [
          area,
          subject,
          action,
          fields,
        ]),
      ).toEqual([
        ["office", "sandboxes", "change", ["concurrencyLimit"]],
        ["office", "promptCache", "change", ["ttl"]],
        [
          "agent",
          expect.stringMatching(/^blog: /) as unknown as string,
          "change",
          ["extraInstructions"],
        ],
        ["floor", "blog", "change", ["roundCap"]],
      ]);
      await target.configuration.import(without);
      const after = asFile(await target.configuration.export());
      expect(after.office.sandboxes.concurrencyLimit).toBe(7);
      expect(after.office.promptCache).toEqual({ ttl: "5m" });
      expect(after.floors.find(({ id }) => id === "blog")?.roundCap).toBe(5);
      expect(after.floors.map(({ id }) => id)).toContain("web-shop");
      const events = (await target.bus.eventsAfter(0)).map(
        ({ event }) => event,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "config.changed",
          scope: "floor",
          floorId: "blog",
          keys: ["roundCap"],
        }),
      );
    },
  ],
  [
    "carries each Floor's chosen name, and an import renames a Floor here",
    async (source, target) => {
      await configure(source);
      const exported = asFile(await source.configuration.export());
      expect(
        exported.floors
          .map(({ id, name }) => [id, name])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ["blog", "blog"],
        ["docs", "docs"],
        ["web-shop", "Storefront"],
      ]);
      await target.configuration.import(exported);
      expect((await target.stores.floors.get("web-shop"))?.name).toBe(
        "Storefront",
      );
      const renamed: Configuration = {
        ...exported,
        floors: exported.floors.map((floor) =>
          floor.id === "blog" ? { ...floor, name: "Journal" } : floor,
        ),
      };
      const preview = await target.configuration.preview(renamed);
      expect(
        preview.changes.map(({ area, subject, fields }) => [
          area,
          subject,
          fields,
        ]),
      ).toEqual([["floor", "blog", ["name"]]]);
      await target.configuration.import(renamed);
      expect((await target.stores.floors.get("blog"))?.name).toBe("Journal");
      const events = (await target.bus.eventsAfter(0)).map(
        ({ event }) => event,
      );
      expect(events).toContainEqual({
        type: "floor.renamed",
        version: 1,
        floorId: "blog",
        name: "Journal",
        previousName: "blog",
      });
    },
  ],
  [
    "refuses an import with problems whole, saying what they are",
    async (source, target) => {
      await configure(source);
      const exported = asFile(await source.configuration.export());
      await target.configuration.import(exported);
      const before = await target.configuration.export();
      const shop = exported.floors.find(({ id }) => id === "web-shop");
      if (shop === undefined) {
        throw new Error("The export has web-shop.");
      }
      const conflicting: Configuration = {
        ...exported,
        office: { ...exported.office, sandboxes: { concurrencyLimit: 9 } },
        officeMemory: "Deploy with ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        floors: [
          // The same repository as another Floor.
          {
            ...shop,
            id: "shop-again",
            agents: [],
            requiredReviewerAgentIds: [],
          },
          ...exported.floors.map((floor) =>
            floor.id === "blog"
              ? {
                  ...floor,
                  agents: floor.agents.map((agent) =>
                    agent.role === "qa"
                      ? { ...agent, role: "docs" as const }
                      : agent,
                  ),
                }
              : floor,
          ),
        ],
      };
      const preview = await target.configuration.preview(conflicting);
      expect(preview.problems).toEqual([
        "Line 1 of the office-wide memory looks like a credential, which memory never holds.",
        "adrianeyre/web-shop is the Floor web-shop here, not shop-again.",
        expect.stringMatching(
          /^blog: .+ is a qa here, not a docs/,
        ) as unknown as string,
      ]);
      const error = await target.configuration.import(conflicting).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).problems).toEqual(preview.problems);
      // Nothing changed, not even what had no problem.
      expect(withoutTime(await target.configuration.export())).toEqual(
        withoutTime(before),
      );
    },
  ],
  [
    "tells the rest of AI Office of each Floor and Agent it adds",
    async (source, target) => {
      await configure(source);
      await target.configuration.import(
        asFile(await source.configuration.export()),
      );
      const events: OfficeEvent[] = (await target.bus.eventsAfter(0)).map(
        ({ event }) => event,
      );
      const types = events.map(({ type }) => type);
      expect(types.filter((type) => type === "floor.created")).toHaveLength(3);
      // Each Agent gets its own Gateway Key through agent.created.
      expect(types.filter((type) => type === "agent.created")).toHaveLength(13);
      expect(types).toContain("floor.archived");
      expect(events.at(-1)).toEqual({
        type: "config.changed",
        version: 1,
        scope: "office",
        keys: ["configuration.imported"],
      });
    },
  ],
];

cases.push(
  [
    "carries the Role library, so a Floor's Agents arrive in the Owner's own Roles, on a Floor of its template and theme",
    async (source, target) => {
      await configureRoles(source);
      const exported = asFile(await source.configuration.export());
      const role = (id: string) =>
        exported.roles.find((each) => each.id === id);
      expect(role("merchandiser")?.stage).toBe("work");
      expect(role("legal-reviewer")).toEqual(
        expect.objectContaining({
          name: "legal reviewer",
          stage: "review",
          skills: ["product-data"],
        }),
      );
      expect(role("reviewer")?.instructions).toBe(
        "Review it as a shopper would.",
      );
      const shop = exported.floors.find(({ id }) => id === "shop-theme");
      expect(shop?.template).toEqual({
        id: "online-store",
        name: "Online store",
      });
      expect(shop?.theme).toBe("stockroom");

      const preview = await target.configuration.preview(exported);
      expect(preview.problems).toEqual([]);
      const roleChanges = preview.changes.filter(({ area }) => area === "role");
      expect(roleChanges).toContainEqual(
        expect.objectContaining({
          subject: "legal-reviewer",
          action: "add",
          note: expect.stringMatching(/instructions/) as unknown as string,
        }),
      );
      expect(roleChanges).toContainEqual(
        expect.objectContaining({
          subject: "reviewer",
          action: "change",
          fields: ["instructions"],
        }),
      );
      // The Roles before the Floors whose Agents fill them.
      const areas = preview.changes.map(({ area }) => area);
      expect(areas.lastIndexOf("role")).toBeLessThan(areas.indexOf("floor"));

      await target.configuration.import(exported);
      expect(await target.stores.roles.get("legal-reviewer")).toEqual(
        expect.objectContaining({ stage: "review", name: "legal reviewer" }),
      );
      const team = await target.stores.agents.list("shop-theme");
      expect(
        team.find(({ id }) => id === "shop-theme-legal-reviewer")?.stage,
      ).toBe("review");
      expect(team.find(({ role }) => role === "merchandiser")?.stage).toBe(
        "work",
      );
      const floor = await target.stores.floors.get("shop-theme");
      expect(floor?.template).toEqual({
        id: "online-store",
        name: "Online store",
      });
      expect(floor?.theme).toBe("stockroom");
      const events = (await target.bus.eventsAfter(0)).map(
        ({ event }) => event,
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "role.created",
          roleId: "legal-reviewer",
          stage: "review",
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "role.changed",
          roleId: "reviewer",
          keys: ["instructions"],
        }),
      );

      await reviewImportedSkills(target, exported);
      expect(withoutTime(asFile(await target.configuration.export()))).toEqual(
        withoutTime(exported),
      );
      expect(await target.configuration.preview(exported)).toEqual({
        changes: [],
        problems: [],
      });
    },
  ],
  [
    "checks each Agent's Role against the Role library, never a fixed list",
    async (source, target) => {
      await configureRoles(source);
      const exported = asFile(await source.configuration.export());
      await target.configuration.import(exported);
      const before = await target.configuration.export();
      const shop = exported.floors.find(({ id }) => id === "shop-theme");
      if (shop === undefined) {
        throw new Error("The export has shop-theme.");
      }
      const merchandiser = shop.agents.find(
        ({ role }) => role === "merchandiser",
      );
      if (merchandiser === undefined) {
        throw new Error("shop-theme has a merchandiser.");
      }
      const conflicting: Configuration = {
        ...exported,
        roles: [
          // The library has a merchandiser Agent in the work Stage.
          ...exported.roles.map((role) =>
            role.id === "merchandiser"
              ? { ...role, stage: "docs" as const }
              : role,
          ),
          // Another Role here has its name.
          ...exported.roles
            .filter(({ id }) => id === "coder")
            .map((coder) => ({ ...coder, id: "programmer", name: "Coder" })),
        ],
        floors: [
          {
            ...shop,
            agents: [
              ...shop.agents,
              // A Role in neither library.
              {
                ...merchandiser,
                id: "shop-theme-florist",
                name: "Flora Florist",
                role: "florist",
              },
            ],
            requiredReviewerAgentIds: [
              ...shop.requiredReviewerAgentIds,
              merchandiser.id,
            ],
          },
        ],
      };
      const preview = await target.configuration.preview(conflicting);
      expect(preview.problems).toEqual([
        "The Role merchandiser is in the work Stage here, not docs, and 1 Agent fills it: a Role's Stage changes only while no Agent fills it.",
        "The Role Coder is coder here, not programmer.",
        "shop-theme: Flora Florist's Role florist is in neither the Role library here nor the document.",
        `shop-theme requires ${merchandiser.name}, whose Role merchandiser is not in the review Stage.`,
      ]);
      await expect(
        target.configuration.import(conflicting),
      ).rejects.toBeInstanceOf(ConfigurationError);
      expect(withoutTime(await target.configuration.export())).toEqual(
        withoutTime(before),
      );
    },
  ],
);

describe("configuration export and import, in memory", () => {
  for (const [name, run] of cases) {
    it(name, () =>
      run(
        office(memoryStores(), createEventBus({ store: memoryEventStore() })),
        office(memoryStores(), createEventBus({ store: memoryEventStore() })),
      ),
    );
  }
});

describe("configuration export and import, into Postgres 18", () => {
  // Exported from an Office in memory, imported into an empty database.
  for (const [name, run] of cases) {
    postgresTest(name, ({ database }) =>
      run(
        office(memoryStores(), createEventBus({ store: memoryEventStore() })),
        office(
          databaseStores(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      ),
    );
  }
});
