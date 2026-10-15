import { describe, expect, it } from "vitest";

import { randomAvatar, seededRandom } from "./avatar.ts";
import { configurationSchema, type Configuration } from "./configuration.ts";
import { defaultFloorSettings, developmentTemplateRef } from "./floors.ts";
import { defaultGatewayRetrySettings } from "./gateway-retries.ts";
import {
  defaultLoadBalancingSettings,
  defaultUsageThrottlingSettings,
} from "./load-balancing.ts";
import { defaultPromptCacheSettings } from "./prompt-cache.ts";
import { defaultRetentionSettings } from "./retention.ts";
import { builtInRoles } from "./roles.ts";
import { defaultOfficeTokenCaps } from "./token-caps.ts";

// The configuration export's format (PRD FR-65): what it holds is checked
// as a whole before anything is previewed or imported.

const agent = (id: string, role: "manager" | "coder" | "reviewer") => ({
  id,
  name: id,
  role,
  aiProvider: "Claude",
  modelOverride: null,
  effort: null,
  extraInstructions: "",
  enabled: true,
  avatar: randomAvatar(seededRandom(id), []),
  tokenCaps: { daily: null, monthly: null },
  freshStartThreshold: null,
});

const floor = {
  ...defaultFloorSettings,
  name: "web-shop",
  defaultBranch: "main",
  id: "web-shop",
  githubRepositoryId: 1,
  repository: "adrianeyre/web-shop",
  archived: false,
  template: developmentTemplateRef,
  theme: "office" as const,
  agents: [
    agent("max", "manager"),
    agent("ada", "coder"),
    agent("grace", "reviewer"),
  ],
  requiredReviewerAgentIds: ["grace"],
  issueTokenCaps: [],
  skillToggles: [],
  roleMemory: [],
};

const configuration: Configuration = {
  format: "ai-office.configuration",
  version: 1,
  exportedAt: "2026-10-10T09:00:00.000Z",
  office: {
    gitIdentity: null,
    intake: { ownerLogin: "adrianeyre", intervalSeconds: 60 },
    sandboxes: { concurrencyLimit: 3 },
    requestBodies: { store: true },
    loadBalancing: defaultLoadBalancingSettings,
    retries: defaultGatewayRetrySettings,
    usageThrottling: defaultUsageThrottlingSettings,
    promptCache: defaultPromptCacheSettings,
    tokenCaps: defaultOfficeTokenCaps,
    retention: defaultRetentionSettings,
  },
  aiProviders: [{ aiProvider: "Claude", defaultModel: "claude-opus-5-5" }],
  modelPrices: [],
  officeMemory: "",
  skills: [],
  roles: [...builtInRoles],
  floorTemplates: [],
  floors: [floor],
};

const problems = (value: unknown) => {
  const parsed = configurationSchema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map(({ message }) => message);
};

describe("a configuration export", () => {
  it("is read back as written", () => {
    expect(configurationSchema.parse(configuration)).toEqual(configuration);
  });

  it("reads an export made before the Owner's Floor Templates as having none", () => {
    const before = Object.fromEntries(
      Object.entries(configuration).filter(([key]) => key !== "floorTemplates"),
    );
    expect(configurationSchema.parse(before).floorTemplates).toEqual([]);
    const template = {
      id: "my-shop",
      source: "floor",
      origin: null,
      files: [{ path: "template.yaml", content: "name: My shop\n" }],
      enabled: true,
    };
    expect(
      problems({ ...configuration, floorTemplates: [template, template] }),
    ).toEqual(["The Floor Template my-shop is in it twice."]);
    expect(
      problems({
        ...configuration,
        floorTemplates: [{ ...template, source: "built-in" }],
      }),
    ).toHaveLength(1);
  });

  it("reads a Floor exported before hourly Status updates as having them on", () => {
    const before = Object.fromEntries(
      Object.entries(floor).filter(([key]) => key !== "hourlyStatusUpdates"),
    );
    expect(
      configurationSchema.parse({ ...configuration, floors: [before] })
        .floors[0]?.hourlyStatusUpdates,
    ).toBe(true);
  });

  it("carries each Floor's chosen name, and reads older exports' names as they were", () => {
    const renamed = {
      ...configuration,
      floors: [{ ...floor, name: "Storefront" }],
    };
    expect(configurationSchema.parse(renamed).floors[0]?.name).toBe(
      "Storefront",
    );
    // Before names were chosen, a Floor had its repository's name, which
    // may be longer than a chosen name may be: it still reads.
    const long = "a".repeat(100);
    expect(
      configurationSchema.parse({
        ...configuration,
        floors: [{ ...floor, name: long }],
      }).floors[0]?.name,
    ).toBe(long);
  });

  it("is an AI Office export of this version", () => {
    expect(problems({ ...configuration, format: "other" })).toEqual([
      "This is not an AI Office configuration export.",
    ]);
    expect(problems({ ...configuration, version: 2 })).toEqual([
      "This AI Office reads configuration version 1.",
    ]);
  });

  it("holds nothing it does not know, such as a credential", () => {
    expect(
      problems({ ...configuration, aiAccounts: [{ credential: "sk-ant" }] }),
    ).toHaveLength(1);
    expect(
      problems({
        ...configuration,
        floors: [
          {
            ...floor,
            agents: floor.agents.map((one) => ({
              ...one,
              gatewayKey: "aio_gk_x",
            })),
          },
        ],
      }).length,
    ).toBeGreaterThan(0);
  });

  it("gives each Floor one Manager, Agents of their own names and reviewers it has", () => {
    expect(
      problems({
        ...configuration,
        floors: [
          {
            ...floor,
            agents: [
              ...floor.agents,
              { ...agent("bob", "manager"), name: "ada" },
            ],
            requiredReviewerAgentIds: ["ada"],
          },
        ],
      }),
    ).toEqual([
      "web-shop has 2 Managers, not 1.",
      "web-shop has two Agents named ada.",
      "web-shop requires ada, which is not one of its reviewers.",
    ]);
  });

  it("names each Floor, repository, Agent and Skill once", () => {
    expect(
      problems({
        ...configuration,
        floors: [floor, { ...floor, name: "again" }],
      }),
    ).toEqual([
      "The Floor web-shop is in it twice.",
      "The repository 1 is in it twice.",
      "The Agent max is in it twice.",
      "The Agent ada is in it twice.",
      "The Agent grace is in it twice.",
    ]);
  });
});
