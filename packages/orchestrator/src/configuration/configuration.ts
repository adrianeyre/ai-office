import { randomUUID } from "node:crypto";

import type { EventBus } from "@ai-office/events";
import {
  agentAiProviders,
  aiProviders,
  configurationErrorCodes,
  configurationFormat,
  configurationVersion,
  createRedactor,
  defaultGitIdentity,
  defaultOfficeTokenCaps,
  describeSkill,
  effortsOf,
  looksLikeSecret,
  managerRole,
  maxRoleMemoryEntries,
  secretLikeLines,
  skillFilesInOrder,
  type Configuration,
  type ConfigurationAgent,
  type ConfigurationArea,
  type ConfigurationChange,
  type ConfigurationFloor,
  type ConfigurationOffice,
  type ConfigurationPreview,
  type ConfigurationRole,
  type FloorSettings,
  type FloorTemplate,
  type ModelPrice,
  type Redactor,
} from "@ai-office/shared";

import { agentCreatedEvent } from "../agents/agents.ts";
import type { AgentRecord } from "../agents/store.ts";
import type { FloorRecord } from "../floors/store.ts";
import { createSharedMemory } from "../memory/shared.ts";
import { createOfficeSettings } from "../office/settings.ts";
import { stageIn } from "../roles/roles.ts";
import type { RoleRecord } from "../roles/store.ts";
import { skillDigest } from "../skills/skills.ts";
import {
  FloorTemplateError,
  floorTemplateDigest,
  floorTemplateFromFiles,
} from "../templates/files.ts";
import { skillOnFor } from "../skills/toggles.ts";
import type { OfficeStores } from "../stores.ts";

// Configuration export and import (PRD FR-65): everything the Owner has
// configured, as one JSON document without a credential, and back again.
// The office's settings, AI Providers' default Models, the Owner's Model
// prices, the office-wide memory, the Skill library, the Role library
// (FR-98), the Owner's own Floor Templates (FR-101), and every Floor with its settings and Merge Policy, Agents,
// issues' Token Caps, Skill settings and accepted Role memory. An Agent's
// Role is checked against the Role library here and the document's, never
// a fixed list (ADR 0003), and a review Stage Role is what makes an Agent
// a reviewer. AI Accounts, Gateway Keys, the
// password and TOTP are credentials, or hold them, and never leave; an
// imported Agent gets a Gateway Key of its own through `agent.created`.
//
// An import is previewed before it is applied: each thing it adds or
// changes, and each problem that stops it (nothing is applied while there
// is one). It adds and changes, and never removes: what is here and not in
// the document stays. Imported Skills wait for the Owner's review before
// they are enabled (FR-76), whatever the document says, and so do imported
// Floor Templates (FR-101). Every change is
// an event, as when the Owner makes it in the admin, so the rest of AI
// Office follows it at once.

/** Why an import was refused; `problems` are its preview's. */
export class ConfigurationError extends Error {
  readonly code = configurationErrorCodes.configurationConflicts;
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super("The configuration was not imported: it has problems.");
    this.name = "ConfigurationError";
    this.problems = problems;
  }
}

/** The Owner's own Model prices (FR-43), which the AI Gateway keeps. */
export interface ModelPriceOverrides {
  list(): Promise<readonly { model: string; price: ModelPrice }[]>;
  /** Sets one, recording that it changed. */
  set(model: string, price: ModelPrice): Promise<void>;
}

export interface ConfigurationService {
  /** Everything configured, without a credential. */
  export(): Promise<Configuration>;
  /** What importing `configuration` would add and change, and what stops it. */
  preview(configuration: Configuration): Promise<ConfigurationPreview>;
  /**
   * Imports `configuration`, answering what changed. Throws a
   * `ConfigurationError`, changing nothing, when its preview has problems.
   */
  import(configuration: Configuration): Promise<ConfigurationPreview>;
}

export interface ConfigurationOptions {
  readonly stores: OfficeStores;
  readonly events: EventBus;
  readonly modelPrices: ModelPriceOverrides;
  /** Knows the Owner's own secrets, which never leave in an export. */
  readonly redactor?: Redactor;
  /**
   * The built-in Floor Templates, whose ids and names an imported
   * template of the Owner's cannot take; none when absent.
   */
  readonly builtInTemplates?: readonly Pick<FloorTemplate, "id" | "name">[];
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** `value` as JSON with its keys in order, so two values compare as equal. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );

/** The keys of `next` whose values differ in `current`. */
const differing = <Shape extends object>(
  current: Shape,
  next: Shape,
): string[] =>
  (Object.keys(next) as (keyof Shape & string)[]).filter(
    (key) => stable(current[key]) !== stable(next[key]),
  );

/** The Floor settings a document holds (FR-7), as a Floor record has them. */
const settingsOf = (floor: FloorSettings): FloorSettings => ({
  name: floor.name,
  defaultBranch: floor.defaultBranch,
  setupCommand: floor.setupCommand,
  testCommand: floor.testCommand,
  mergePolicy: floor.mergePolicy,
  roundCap: floor.roundCap,
  tokenCaps: floor.tokenCaps,
  concurrencyLimit: floor.concurrencyLimit,
  priority: floor.priority,
  requiredReviewerAgentIds: floor.requiredReviewerAgentIds,
  planApproval: floor.planApproval,
  mostAgents: floor.mostAgents,
  spinOffFromChat: floor.spinOffFromChat,
  hourlyStatusUpdates: floor.hourlyStatusUpdates,
  freshStartThreshold: floor.freshStartThreshold,
  gitIdentity: floor.gitIdentity,
});

/** An Agent as a document has it. */
const agentOf = (agent: AgentRecord): ConfigurationAgent => ({
  id: agent.id,
  name: agent.name,
  role: agent.role,
  aiProvider: agent.aiProvider,
  modelOverride: agent.modelOverride,
  effort: agent.effort,
  extraInstructions: agent.extraInstructions,
  enabled: agent.enabled,
  avatar: agent.avatar,
  tokenCaps: agent.tokenCaps,
  freshStartThreshold: agent.freshStartThreshold,
});

/** A library Role as a document has it. */
const roleOf = (role: RoleRecord): ConfigurationRole => ({
  id: role.id,
  name: role.name,
  stage: role.stage,
  description: role.description,
  instructions: role.instructions,
  skills: [...role.skills],
  deskDressing: role.deskDressing,
  aiProvider: role.aiProvider,
  model: role.model,
});

/** One thing an import does, and what the preview says of it. */
interface Step {
  readonly change: ConfigurationChange;
  /** Absent for what another step does, such as a new Floor's Agents. */
  readonly apply?: () => Promise<void>;
}

export function createConfiguration(
  options: ConfigurationOptions,
): ConfigurationService {
  const { stores, events } = options;
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const settings = createOfficeSettings({
    store: stores.office,
    floors: stores.floors,
    events,
    now,
  });
  const sharedMemory = createSharedMemory({
    store: stores.officeMemory,
    floors: stores.floors,
    events,
    redactor,
    now,
  });

  const officeOf = async (): Promise<ConfigurationOffice> => {
    const gitIdentity = await settings.gitIdentity();
    return {
      gitIdentity: gitIdentity.isDefault
        ? null
        : { name: gitIdentity.name, email: gitIdentity.email },
      intake: await settings.intakeSettings(),
      sandboxes: await settings.sandboxSettings(),
      requestBodies: await settings.requestBodiesSettings(),
      loadBalancing: await settings.loadBalancingSettings(),
      retries: await settings.retrySettings(),
      usageThrottling: await settings.usageThrottlingSettings(),
      promptCache: await settings.promptCacheSettings(),
      tokenCaps: {
        ...defaultOfficeTokenCaps,
        ...(await stores.tokenCaps.officeCaps()),
      },
      retention: await settings.retentionSettings(),
    };
  };

  const floorOf = async (floor: FloorRecord): Promise<ConfigurationFloor> => ({
    id: floor.id,
    githubRepositoryId: floor.githubRepositoryId,
    repository: floor.repository,
    ...settingsOf(floor),
    archived: floor.archivedAt !== null,
    template: { ...floor.template },
    theme: floor.theme,
    // A Contractor is there for one Batch (ADR 0004), so it is not exported.
    agents: (await stores.agents.list(floor.id))
      .filter(({ contractor }) => contractor === null)
      .map(agentOf),
    issueTokenCaps: (await stores.tokenCaps.issueCaps(floor.id))
      .map(({ issue, caps }) => ({ issue, caps }))
      .sort((a, b) => a.issue - b.issue),
    skillToggles: (await stores.floorSkills.list(floor.id))
      .map(({ skillName, role, enabled }) => ({ skillName, role, enabled }))
      .sort(
        (a, b) =>
          a.skillName.localeCompare(b.skillName) ||
          a.role.localeCompare(b.role),
      ),
    roleMemory: (await stores.officeMemory.entries(floor.id, ["accepted"])).map(
      ({ role, text, issue, agentId }) => ({ role, text, issue, agentId }),
    ),
  });

  const exportConfiguration = async (): Promise<Configuration> => {
    const configuration: Configuration = {
      format: configurationFormat,
      version: configurationVersion,
      exportedAt: now().toISOString(),
      office: await officeOf(),
      aiProviders: Object.entries(await stores.aiProviders.defaultModels())
        .flatMap(([aiProvider, defaultModel]) =>
          defaultModel === undefined ? [] : [{ aiProvider, defaultModel }],
        )
        .sort((a, b) => a.aiProvider.localeCompare(b.aiProvider)),
      modelPrices: [...(await options.modelPrices.list())]
        .map(({ model, price }) => ({ model, price }))
        .sort((a, b) => a.model.localeCompare(b.model)),
      officeMemory: (await stores.officeMemory.office())?.content ?? "",
      skills: (await stores.skills.list()).map((skill) => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        origin: skill.origin,
        files: skill.files.map(({ path, content }) => ({ path, content })),
        enabled: skill.enabled,
      })),
      roles: (await stores.roles.list()).map(roleOf),
      floorTemplates: (await stores.floorTemplates.list()).map((template) => ({
        id: template.id,
        source: template.source,
        origin: template.origin,
        files: template.files.map(({ path, content }) => ({
          path,
          content,
        })),
        enabled: template.reviewedAt !== null,
      })),
      floors: await Promise.all(
        (await stores.floors.list({ includeArchived: true })).map(floorOf),
      ),
    };
    // Nothing in it is a credential by design; anything the Owner typed
    // that looks like one is redacted all the same (FR-5).
    return redactor.redact(configuration);
  };

  const changed = (
    scope: "office" | "floor" | "agent",
    keys: readonly string[],
    subject: { floorId?: string; agentId?: string } = {},
  ) =>
    events.publish({
      type: "config.changed",
      version: 1,
      scope,
      ...subject,
      keys: [...keys],
    });

  /** Every step an import takes, in order, and what stops it. */
  const plan = async (
    configuration: Configuration,
  ): Promise<{ steps: Step[]; problems: string[] }> => {
    const steps: Step[] = [];
    const problems: string[] = [];
    const step = (
      area: ConfigurationArea,
      subject: string,
      action: "add" | "change",
      fields: readonly string[],
      apply?: () => Promise<unknown>,
      note: string | null = null,
    ) => {
      steps.push({
        change: { area, subject, action, fields: [...fields], note },
        ...(apply === undefined
          ? {}
          : {
              apply: async () => {
                await apply();
              },
            }),
      });
    };
    let created = 0;
    /** Increasing times, so what is added keeps the document's order. */
    const nextCreatedAt = () => new Date(now().getTime() + created++);

    // The office's settings, a group at a time.
    const office = await officeOf();
    const next = configuration.office;
    const groups: {
      readonly [Key in keyof ConfigurationOffice]: () => Promise<unknown>;
    } = {
      gitIdentity: () =>
        settings.setGitIdentity(next.gitIdentity ?? defaultGitIdentity),
      intake: () => settings.setIntakeSettings(next.intake),
      sandboxes: () => settings.setSandboxSettings(next.sandboxes),
      requestBodies: () =>
        settings.setRequestBodiesSettings(next.requestBodies),
      loadBalancing: () =>
        settings.setLoadBalancingSettings(next.loadBalancing),
      retries: () => settings.setRetrySettings(next.retries),
      usageThrottling: () =>
        settings.setUsageThrottlingSettings(next.usageThrottling),
      promptCache: () => settings.setPromptCacheSettings(next.promptCache),
      tokenCaps: async () => {
        await stores.tokenCaps.setOfficeCaps(next.tokenCaps, now());
        await changed(
          "office",
          differing(office.tokenCaps, next.tokenCaps).map(
            (period) => `tokenCaps.${period}`,
          ),
        );
      },
      retention: () => settings.setRetentionSettings(next.retention),
    };
    for (const key of Object.keys(groups) as (keyof ConfigurationOffice)[]) {
      const current: unknown = office[key];
      const wanted: unknown = next[key];
      const fields =
        typeof current === "object" &&
        current !== null &&
        typeof wanted === "object" &&
        wanted !== null
          ? differing(current, wanted)
          : stable(current) === stable(wanted)
            ? []
            : [key];
      if (fields.length > 0) {
        step("office", key, "change", fields, groups[key]);
      }
    }

    // AI Providers' default Models (FR-15). The model catalogue may not
    // list them yet; an Agent keeps a Model the catalogue left too.
    const defaults = await stores.aiProviders.defaultModels();
    for (const { aiProvider, defaultModel } of configuration.aiProviders) {
      if (!aiProviders.some((known) => known === aiProvider)) {
        problems.push(`AI Office has no AI Provider ${aiProvider}.`);
        continue;
      }
      const current = defaults[aiProvider];
      if (current !== defaultModel) {
        step(
          "ai_provider",
          aiProvider,
          current === undefined ? "add" : "change",
          ["defaultModel"],
          async () => {
            await stores.aiProviders.setDefaultModel(
              aiProvider,
              defaultModel,
              now(),
            );
            await changed("office", [`aiProviders.${aiProvider}.defaultModel`]);
          },
        );
      }
    }
    const modelsOf = { ...defaults };
    for (const { aiProvider, defaultModel } of configuration.aiProviders) {
      modelsOf[aiProvider] = defaultModel;
    }

    // The Owner's Model prices (FR-43).
    const prices = new Map(
      (await options.modelPrices.list()).map(({ model, price }) => [
        model,
        price,
      ]),
    );
    for (const { model, price } of configuration.modelPrices) {
      const current = prices.get(model);
      const fields = current === undefined ? [] : differing(current, price);
      if (current === undefined || fields.length > 0) {
        step(
          "model_price",
          model,
          current === undefined ? "add" : "change",
          fields,
          () => options.modelPrices.set(model, price),
        );
      }
    }

    // The office-wide memory (FR-54), which never holds a credential.
    const memory = (await stores.officeMemory.office())?.content ?? "";
    if (memory !== configuration.officeMemory) {
      const lines = secretLikeLines(configuration.officeMemory, redactor);
      for (const line of lines) {
        problems.push(
          `Line ${String(line)} of the office-wide memory looks like a credential, which memory never holds.`,
        );
      }
      step("office_memory", "office-wide memory", "change", ["content"], () =>
        sharedMemory.setOffice(configuration.officeMemory),
      );
    }

    // The Skill library (FR-72). What arrives waits for review (FR-76).
    const library = await stores.skills.list();
    const review = "It waits for your review before it is enabled.";
    for (const skill of configuration.skills) {
      const described = describeSkill(skill.files);
      if (
        described.name !== skill.name ||
        described.description !== skill.description
      ) {
        problems.push(
          `The Skill ${skill.name}'s name and description are not its SKILL.md's.`,
        );
        continue;
      }
      if ((skill.source === "git") !== (skill.origin !== null)) {
        problems.push(
          `The Skill ${skill.name} says it came from Git without saying where, or the other way round.`,
        );
        continue;
      }
      const files = skillFilesInOrder(skill.files);
      const digest = skillDigest(files);
      const record = () => {
        const at = now();
        return {
          id: newId(),
          name: skill.name,
          description: skill.description,
          source: skill.source,
          origin: skill.origin,
          files,
          digest,
          enabled: false,
          reviewedAt: null,
          createdAt: at,
          updatedAt: at,
        };
      };
      const add = async () => {
        const added = record();
        await stores.skills.add(added);
        await events.publish({
          type: "skill.added",
          version: 1,
          skillId: added.id,
          name: added.name,
          source: added.source,
          enabled: false,
        });
      };
      const here = library.find(({ name }) => name === skill.name);
      if (here === undefined) {
        step("skill", skill.name, "add", [], add, review);
      } else if (
        here.digest !== digest ||
        stable(here.origin) !== stable(skill.origin) ||
        here.source !== skill.source
      ) {
        // New contents need a new review: the Skill is replaced.
        step(
          "skill",
          skill.name,
          "change",
          here.digest === digest ? ["source"] : ["files"],
          async () => {
            await stores.skills.remove(here.id);
            await events.publish({
              type: "skill.removed",
              version: 1,
              skillId: here.id,
              name: here.name,
            });
            await add();
          },
          review,
        );
      } else if (here.enabled && !skill.enabled) {
        step("skill", skill.name, "change", ["enabled"], async () => {
          await stores.skills.update(here.id, {
            enabled: false,
            updatedAt: now(),
          });
          await events.publish({
            type: "skill.changed",
            version: 1,
            skillId: here.id,
            name: here.name,
            change: "disabled",
          });
        });
      }
    }

    // The Role library (FR-98), before the Floors whose Agents fill its
    // Roles. A Role's instructions reach models (ADR 0003), so the preview
    // says so of each it adds or rewrites.
    const rolesHere = await stores.roles.list();
    const filling = await stores.agents.countByRole();
    const skillNames = new Set([
      ...library.map(({ name }) => name),
      ...configuration.skills.map(({ name }) => name),
    ]);
    const instructionsNote =
      "Its instructions reach every Agent in it: read them in the document before you import it.";
    for (const role of configuration.roles) {
      const named = rolesHere.find(
        ({ id, name }) =>
          id !== role.id && name.toLowerCase() === role.name.toLowerCase(),
      );
      if (named !== undefined) {
        problems.push(
          `The Role ${role.name} is ${named.id} here, not ${role.id}.`,
        );
        continue;
      }
      if (
        role.aiProvider !== null &&
        !aiProviders.some((known) => known === role.aiProvider)
      ) {
        problems.push(
          `The Role ${role.name} suggests ${role.aiProvider}, which is no AI Provider here.`,
        );
        continue;
      }
      const missing = role.skills.filter((skill) => !skillNames.has(skill));
      if (missing.length > 0) {
        problems.push(
          `The Role ${role.name} gives its Agents ${missing.join(", ")}, which neither the Skill library here nor the document has.`,
        );
        continue;
      }
      const here = rolesHere.find(({ id }) => id === role.id);
      if (here === undefined) {
        step(
          "role",
          role.id,
          "add",
          [],
          async () => {
            if (!(await stores.roles.create(role, now()))) {
              throw new Error(`The Role ${role.id} was not added.`);
            }
            await events.publish({
              type: "role.created",
              version: 1,
              roleId: role.id,
              name: role.name,
              stage: role.stage,
              duplicatedFrom: null,
            });
          },
          instructionsNote,
        );
        continue;
      }
      const fields = differing(roleOf(here), role);
      if (fields.length === 0) {
        continue;
      }
      const agents = filling.get(role.id) ?? 0;
      if (fields.includes("stage") && agents > 0) {
        problems.push(
          `The Role ${here.name} is in the ${here.stage} Stage here, not ${role.stage}, and ${String(agents)} ${agents === 1 ? "Agent fills" : "Agents fill"} it: a Role's Stage changes only while no Agent fills it.`,
        );
        continue;
      }
      step(
        "role",
        role.id,
        "change",
        fields,
        async () => {
          if (!(await stores.roles.update(role, now()))) {
            throw new Error(`The Role ${role.id} was not changed.`);
          }
          await events.publish({
            type: "role.changed",
            version: 1,
            roleId: role.id,
            name: role.name,
            keys: fields,
            agents,
          });
        },
        fields.includes("instructions") ? instructionsNote : null,
      );
    }
    /** The Role library as the import leaves it. */
    const libraryAfter: readonly Pick<RoleRecord, "id" | "stage">[] = [
      ...rolesHere.filter(
        ({ id }) => !configuration.roles.some((role) => role.id === id),
      ),
      ...configuration.roles,
    ];
    const isLibraryRole = (role: string) =>
      libraryAfter.some(({ id }) => id === role);

    // The Owner's own Floor Templates (FR-101). Each holds Role
    // instructions and Skills, so what arrives waits for review, whatever
    // the document says (as Skills do).
    const builtInTemplates = options.builtInTemplates ?? [];
    const templatesHere = await stores.floorTemplates.list();
    const templateReview =
      "It waits for your review before a Floor can be added from it.";
    for (const wanted of configuration.floorTemplates) {
      let name: string;
      try {
        ({ name } = floorTemplateFromFiles(wanted.id, wanted.files));
      } catch (error) {
        if (!(error instanceof FloorTemplateError)) {
          throw error;
        }
        problems.push(`The Floor Template ${wanted.id}: ${error.message}`);
        continue;
      }
      if (builtInTemplates.some(({ id }) => id === wanted.id)) {
        problems.push(
          `The Floor Template ${wanted.id} is a built-in one here, which an import does not change.`,
        );
        continue;
      }
      const namesake = [...builtInTemplates, ...templatesHere].find(
        (other) =>
          other.id !== wanted.id &&
          other.name.toLowerCase() === name.toLowerCase(),
      );
      if (namesake !== undefined) {
        problems.push(
          `The Floor Template ${wanted.id} is called ${name}, as ${namesake.id} here is.`,
        );
        continue;
      }
      if ((wanted.source === "git") !== (wanted.origin !== null)) {
        problems.push(
          `The Floor Template ${wanted.id} says it came from Git without saying where, or the other way round.`,
        );
        continue;
      }
      const files = wanted.files.map(({ path, content }) => ({
        path,
        content,
      }));
      const digest = floorTemplateDigest(files);
      const here = templatesHere.find(({ id }) => id === wanted.id);
      if (here === undefined) {
        step(
          "floor_template",
          wanted.id,
          "add",
          [],
          async () => {
            const at = now();
            const added = await stores.floorTemplates.add({
              id: wanted.id,
              name,
              source: wanted.source,
              origin: wanted.origin,
              files,
              digest,
              reviewedAt: null,
              createdAt: at,
              updatedAt: at,
            });
            if (added !== "added") {
              throw new Error(
                `The Floor Template ${wanted.id} was not added: ${added}.`,
              );
            }
            await events.publish({
              type: "floor_template.added",
              version: 1,
              templateId: wanted.id,
              name,
              source: wanted.source,
              duplicatedFrom: null,
              floorId: null,
              enabled: false,
            });
          },
          templateReview,
        );
        continue;
      }
      const fields = [
        ...(here.digest === digest ? [] : ["files"]),
        ...(here.source === wanted.source &&
        stable(here.origin) === stable(wanted.origin)
          ? []
          : ["source"]),
      ];
      if (fields.length > 0) {
        // New contents need a new review.
        step(
          "floor_template",
          wanted.id,
          "change",
          fields,
          async () => {
            const updated = await stores.floorTemplates.update(wanted.id, {
              name,
              source: wanted.source,
              origin: wanted.origin,
              files,
              digest,
              reviewedAt: null,
              updatedAt: now(),
            });
            if (updated === undefined || typeof updated === "string") {
              throw new Error(
                `The Floor Template ${wanted.id} was not changed: ${updated ?? "gone"}.`,
              );
            }
            await events.publish({
              type: "floor_template.changed",
              version: 1,
              templateId: wanted.id,
              name,
              change: "replaced",
              keys: fields,
            });
          },
          templateReview,
        );
      }
    }

    // The Floors, each with its team and what hangs off it.
    const floors = await stores.floors.list({ includeArchived: true });
    const agentsHere = new Map<string, AgentRecord>();
    for (const floor of floors) {
      for (const agent of await stores.agents.list(floor.id)) {
        agentsHere.set(agent.id, agent);
      }
    }
    for (const floor of configuration.floors) {
      const here = floors.find(({ id }) => id === floor.id);
      const repositoryHere = floors.find(
        ({ githubRepositoryId }) =>
          githubRepositoryId === floor.githubRepositoryId,
      );
      if (repositoryHere !== undefined && repositoryHere.id !== floor.id) {
        problems.push(
          `${floor.repository} is the Floor ${repositoryHere.id} here, not ${floor.id}.`,
        );
        continue;
      }
      if (here !== undefined && repositoryHere === undefined) {
        problems.push(
          `The Floor ${floor.id} is another repository here, ${here.repository}.`,
        );
        continue;
      }
      for (const agent of floor.agents) {
        if (agent.role !== managerRole && !isLibraryRole(agent.role)) {
          problems.push(
            `${floor.id}: ${agent.name}'s Role ${agent.role} is in neither the Role library here nor the document.`,
          );
        }
        if (!agentAiProviders.some((known) => known === agent.aiProvider)) {
          problems.push(
            `${floor.id}: ${agent.name} uses ${agent.aiProvider}, which is no AI Provider here.`,
          );
        } else if (
          agent.effort !== null &&
          !effortsOf(agent.aiProvider).includes(agent.effort)
        ) {
          problems.push(
            `${floor.id}: ${agent.name}'s effort ${agent.effort} is not one ${agent.aiProvider} takes.`,
          );
        }
      }
      // A required reviewer is an Agent in a review Stage Role (FR-27).
      for (const id of floor.requiredReviewerAgentIds) {
        const reviewer = floor.agents.find((agent) => agent.id === id);
        if (
          reviewer !== undefined &&
          isLibraryRole(reviewer.role) &&
          stageIn(libraryAfter, reviewer.role) !== "review"
        ) {
          problems.push(
            `${floor.id} requires ${reviewer.name}, whose Role ${reviewer.role} is not in the review Stage.`,
          );
        }
      }
      if (here?.archivedAt != null) {
        if (!floor.archived) {
          problems.push(
            `The Floor ${floor.id} is archived here, and an import does not bring a Floor back.`,
          );
        }
        // An archived Floor's settings no longer change (FR-9).
        continue;
      }
      const team = here === undefined ? [] : await stores.agents.list(floor.id);
      const subject = (agent: { readonly name: string }) =>
        `${floor.id}: ${agent.name}`;
      const record = (agent: ConfigurationAgent): AgentRecord => ({
        ...agent,
        stage: stageIn(libraryAfter, agent.role),
        floorId: floor.id,
        createdAt: nextCreatedAt(),
        leavingAt: null,
        contractor: null,
      });
      const agentCreated = (agent: AgentRecord) => {
        const event = agentCreatedEvent(agent, modelsOf);
        // An AI Provider without a default Model yet still names one.
        return events.publish({
          ...event,
          model: event.model === "" ? "(no default Model)" : event.model,
        });
      };

      if (here === undefined) {
        for (const agent of floor.agents) {
          if (agentsHere.has(agent.id)) {
            problems.push(
              `The Agent ${agent.id} (${agent.name}) is on another Floor here.`,
            );
          }
        }
        const archived = floor.archived ? " It arrives archived." : "";
        step(
          "floor",
          floor.id,
          "add",
          [],
          async () => {
            const team = floor.agents.map(record);
            const result = await stores.floors.create(
              {
                id: floor.id,
                githubRepositoryId: floor.githubRepositoryId,
                repository: floor.repository,
                ...settingsOf(floor),
                template: { ...floor.template },
                theme: floor.theme,
                createdAt: nextCreatedAt(),
                archivedAt: null,
              },
              team,
            );
            if (result !== "created") {
              throw new Error(
                `The Floor ${floor.id} was not added: ${result}.`,
              );
            }
            await events.publish({
              type: "floor.created",
              version: 1,
              floorId: floor.id,
              name: floor.name,
              repository: floor.repository,
              template: { ...floor.template },
            });
            for (const agent of team) {
              await agentCreated(agent);
            }
          },
          `${floor.repository}, with ${String(floor.agents.length)} Agents.${archived}`,
        );
        for (const agent of floor.agents) {
          step("agent", subject(agent), "add", []);
        }
      } else {
        for (const agent of floor.agents) {
          const current = team.find(({ id }) => id === agent.id);
          if (current === undefined) {
            if (agentsHere.has(agent.id)) {
              problems.push(
                `The Agent ${agent.id} (${agent.name}) is on another Floor here.`,
              );
            } else if (team.some(({ name }) => name === agent.name)) {
              problems.push(
                `${floor.id} has another Agent named ${agent.name} here.`,
              );
            } else if (agent.role === managerRole) {
              problems.push(
                `${floor.id} has its Manager here already, not ${agent.name}.`,
              );
            } else {
              step("agent", subject(agent), "add", [], async () => {
                const added = record(agent);
                const result = await stores.agents.create(added);
                if (result !== "created") {
                  throw new Error(
                    `${subject(agent)} was not added: ${result}.`,
                  );
                }
                await agentCreated(added);
              });
            }
            continue;
          }
          if (current.role !== agent.role) {
            problems.push(
              `${subject(current)} is a ${current.role} here, not a ${agent.role}: an Agent's Role does not change.`,
            );
            continue;
          }
          if (
            agent.name !== current.name &&
            team.some(({ id, name }) => id !== agent.id && name === agent.name)
          ) {
            problems.push(
              `${floor.id} has another Agent named ${agent.name} here.`,
            );
            continue;
          }
          const fields = differing(agentOf(current), agent);
          if (fields.length > 0) {
            step("agent", subject(current), "change", fields, async () => {
              await stores.agents.update({ ...current, ...agent });
              await changed("agent", fields, {
                floorId: floor.id,
                agentId: agent.id,
              });
            });
          }
        }
        // Its settings once its Agents are in, as they name its reviewers.
        const fields = differing(settingsOf(here), settingsOf(floor));
        if (fields.length > 0) {
          step("floor", floor.id, "change", fields, async () => {
            await stores.floors.update(floor.id, settingsOf(floor));
            await changed("floor", fields, { floorId: floor.id });
            if (here.name !== floor.name) {
              await events.publish({
                type: "floor.renamed",
                version: 1,
                floorId: floor.id,
                name: floor.name,
                previousName: here.name,
              });
            }
          });
        }
      }

      // Issues' Token Caps (FR-32).
      const caps =
        here === undefined ? [] : await stores.tokenCaps.issueCaps(floor.id);
      for (const { issue, caps: wanted } of floor.issueTokenCaps) {
        const current = caps.find((other) => other.issue === issue)?.caps;
        const fields =
          current === undefined
            ? (["daily", "monthly"] as const).filter(
                (period) => wanted[period] !== null,
              )
            : differing(current, wanted);
        if (fields.length > 0) {
          step(
            "issue_token_caps",
            `${floor.id}#${String(issue)}`,
            current === undefined ? "add" : "change",
            fields,
            async () => {
              await stores.tokenCaps.setIssueCaps(
                floor.id,
                issue,
                wanted,
                now(),
              );
              await changed(
                "floor",
                fields.map(
                  (period) => `issues.${String(issue)}.tokenCaps.${period}`,
                ),
                { floorId: floor.id },
              );
            },
          );
        }
      }

      // Skills turned on or off for a Role (FR-75).
      const toggles =
        here === undefined ? [] : await stores.floorSkills.list(floor.id);
      for (const toggle of floor.skillToggles) {
        const set = toggles.some(
          ({ skillName, role }) =>
            skillName === toggle.skillName && role === toggle.role,
        );
        if (
          set &&
          skillOnFor(toggles, toggle.skillName, toggle.role) === toggle.enabled
        ) {
          continue;
        }
        step(
          "skill_toggle",
          `${floor.id}: ${toggle.skillName} for ${toggle.role}`,
          set ? "change" : "add",
          ["enabled"],
          async () => {
            await stores.floorSkills.set(floor.id, toggle, now());
            await changed(
              "floor",
              [`skills.${toggle.skillName}.${toggle.role}`],
              { floorId: floor.id },
            );
          },
        );
      }

      // Each Role's accepted memory (FR-55), never a credential (FR-56).
      const accepted =
        here === undefined
          ? []
          : await stores.officeMemory.entries(floor.id, ["accepted"]);
      const adding = floor.roleMemory.filter(
        (entry) =>
          !accepted.some(
            ({ role, text }) => role === entry.role && text === entry.text,
          ),
      );
      for (const role of new Set(adding.map((entry) => entry.role))) {
        if (!isLibraryRole(role)) {
          problems.push(
            `${floor.id} has ${role} memory, a Role in neither the Role library here nor the document.`,
          );
        }
      }
      for (const entry of adding) {
        if (looksLikeSecret(entry.text, redactor)) {
          problems.push(
            `An entry of ${floor.id}'s ${entry.role} memory looks like a credential, which memory never holds.`,
          );
        }
      }
      for (const role of new Set(adding.map((entry) => entry.role))) {
        const total =
          accepted.filter((entry) => entry.role === role).length +
          adding.filter((entry) => entry.role === role).length;
        if (total > maxRoleMemoryEntries) {
          problems.push(
            `${floor.id}'s ${role} memory would hold ${String(total)} entries, more than ${String(maxRoleMemoryEntries)}.`,
          );
        }
      }
      if (adding.length > 0) {
        step(
          "role_memory",
          floor.id,
          "add",
          [...new Set(adding.map((entry) => entry.role))],
          async () => {
            const at = now();
            const proposed = await stores.officeMemory.propose(
              adding.map((entry) => ({
                ...entry,
                floorId: floor.id,
                createdAt: at,
              })),
            );
            for (const entry of proposed) {
              await stores.officeMemory.change(entry.id, "proposed", {
                status: "accepted",
                decidedBy: "owner",
                decidedAt: at,
                reason: null,
              });
              await events.publish({
                type: "memory.role_changed",
                version: 1,
                floorId: floor.id,
                role: entry.role,
                entryId: entry.id,
                text: entry.text,
                change: "accepted",
                by: "owner",
              });
            }
          },
          `${String(adding.length)} entries, accepted.`,
        );
      }

      // Archived there: archived here too (FR-9).
      if (floor.archived) {
        step("floor", floor.id, "change", ["archived"], async () => {
          await stores.floors.archive(floor.id, now());
          await events.publish({
            type: "floor.archived",
            version: 1,
            floorId: floor.id,
          });
        });
      }
    }
    return { steps, problems };
  };

  const previewOf = ({
    steps,
    problems,
  }: {
    steps: readonly Step[];
    problems: readonly string[];
  }): ConfigurationPreview => ({
    changes: steps.map(({ change }) => change),
    problems: [...problems],
  });

  // One import at a time, each planned against what is here as it starts.
  let importing: Promise<unknown> = Promise.resolve();

  return {
    export: exportConfiguration,

    async preview(configuration) {
      return previewOf(await plan(configuration));
    },

    import(configuration) {
      const done = importing.then(async () => {
        const planned = await plan(configuration);
        if (planned.problems.length > 0) {
          throw new ConfigurationError(planned.problems);
        }
        for (const { apply } of planned.steps) {
          await apply?.();
        }
        if (planned.steps.length > 0) {
          await changed("office", ["configuration.imported"]);
        }
        return previewOf(planned);
      });
      importing = done.catch(() => undefined);
      return done;
    },
  };
}
