import { connect } from "@ai-office/db";
import { postgresTest, type PostgresServer } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  floorErrorCodes,
  floorTemplateBundleSchema,
  floorTemplateErrorCodes,
  managerInstructionsOf,
  seededRandom,
  type FloorTemplate,
} from "@ai-office/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgents } from "../agents/agents.ts";
import { FloorError } from "../floors/errors.ts";
import { createFloors, type Floors } from "../floors/floors.ts";
import { skillDigest } from "../skills/skills.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { FloorTemplateLibraryError } from "./errors.ts";
import {
  createFloorTemplateLibrary,
  type FloorTemplateLibrary,
} from "./library.ts";
import { loadFloorTemplates } from "./load.ts";
import {
  cornerShopFiles,
  cornerShopNeighbours,
  templateFolder,
  type TemplateFolder,
} from "./testing.ts";

// The Owner's own Floor Templates (PRD FR-101): duplicated and edited,
// saved from a Floor, exported to a file and imported from one. An
// exported template round-trips into another office with its Roles and
// Skills; an imported one is disabled until the Owner reviews its full
// contents; a built-in one cannot be edited in place. Every case runs in
// memory and in Postgres 18.

const start = new Date("2026-10-10T09:00:00.000Z");

/** One AI Office: its stores, its templates and its Floors. */
interface Office {
  readonly stores: OfficeStores;
  readonly library: FloorTemplateLibrary;
  /** Floors added from the built-in templates and the enabled ones. */
  readonly floors: Floors;
  /** Every event so far. */
  readonly events: () => Promise<OfficeEvent[]>;
}

interface Setup {
  readonly here: Office;
  /** Another AI Office, with nothing in it yet. */
  readonly there: () => Promise<Office>;
}

function officeOn(
  stores: OfficeStores,
  bus: EventBus,
  builtIn: readonly FloorTemplate[],
): Office {
  const github = createFakeGitHub();
  for (const repository of [
    "adrianeyre/web-shop",
    "adrianeyre/blog",
    "adrianeyre/corner-shop",
  ]) {
    github.installRepository(repository);
  }
  const library = createFloorTemplateLibrary({
    builtIn,
    store: stores.floorTemplates,
    roles: stores.roles,
    skills: stores.skills,
    floors: stores.floors,
    agents: stores.agents,
    events: bus,
    now: () => start,
  });
  return {
    stores,
    library,
    floors: createFloors({
      store: stores.floors,
      github,
      events: bus,
      agents: stores.agents,
      roles: stores.roles,
      skills: stores.skills,
      templates: () => library.enabled(),
      now: () => start,
      random: seededRandom("team"),
    }),
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
  };
}

const refusal = async <Failure extends Error>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => Failure,
): Promise<Failure> => {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(type);
  return error as Failure;
};

const templateEvents = (events: readonly OfficeEvent[]) =>
  events.filter(
    (
      event,
    ): event is Extract<
      OfficeEvent,
      {
        type:
          | "floor_template.added"
          | "floor_template.changed"
          | "floor_template.removed";
      }
    > => event.type.startsWith("floor_template."),
  );

/** A Floor's team: each Agent's Role, oldest first. */
const rolesOf = async (stores: OfficeStores, floorId: string) =>
  (await stores.agents.list(floorId)).map(({ role }) => role);

type Case = [name: string, run: (setup: Setup) => Promise<void>];

const cases: Case[] = [
  [
    "export then import round-trips a template saved from a Floor, with its Roles and Skills",
    async ({ here, there }) => {
      // A Floor from Corner shop, then a Role of the Owner's own on it.
      const floor = await here.floors.add(
        "adrianeyre/corner-shop",
        "corner-shop",
      );
      expect(
        await here.stores.roles.create(
          {
            id: "proofreader",
            name: "proofreader",
            stage: "docs",
            description: "Reads every page for typing mistakes.",
            instructions: "- Read slowly.\n- Keep the house style.",
            skills: ["price-check"],
            deskDressing: "books",
            aiProvider: null,
            model: null,
          },
          start,
        ),
      ).toBe(true);
      await createAgents({
        store: here.stores.agents,
        floors: here.stores.floors,
        events: createEventBus({ store: memoryEventStore() }),
        roles: here.stores.roles,
        random: seededRandom("more"),
      }).addToTeam(floor.id, "proofreader");

      const saved = await here.library.saveFloor({
        floorId: floor.id,
        name: "My shop",
        description: "My shop's team, as it works.",
      });
      // Its team, settings, Manager's instructions, labels and theme are
      // the Floor's; its icon and labels its own template's.
      expect(saved).toMatchObject({
        builtIn: false,
        source: "floor",
        enabled: true,
        reviewedAt: start,
      });
      const { template } = saved;
      expect(template).toMatchObject({
        id: "my-shop",
        name: "My shop",
        icon: "shopping-bag",
        theme: "stockroom",
        settings: {
          setupCommand: "pnpm install",
          testCommand: "pnpm theme-check",
          mergePolicy: "auto_merge",
          roundCap: 2,
          requiredReviewers: ["brand-reviewer"],
        },
        labels: [
          { name: "product", color: "c2e0c6", description: "A product's data" },
        ],
      });
      expect(template.roles.map(({ role, count }) => [role.id, count])).toEqual(
        [
          ["merchandiser", 2],
          ["brand-reviewer", 1],
          ["proofreader", 1],
        ],
      );
      expect(template.manager).toEqual({
        planningGuidance: managerInstructionsOf({
          planningGuidance:
            "Plan catalogue changes before the copy that describes them.",
          firstIssue: {
            title: "Check every product has a price",
            body: "List the products without a price, and add one to each.",
          },
        }),
        firstIssue: null,
      });
      expect(template.skills.map(({ name }) => name)).toEqual(["price-check"]);
      expect(templateEvents(await here.events())).toEqual([
        {
          type: "floor_template.added",
          version: 1,
          templateId: "my-shop",
          name: "My shop",
          source: "floor",
          duplicatedFrom: null,
          floorId: floor.id,
          enabled: true,
        },
      ]);

      // Exported to a file, which travels as JSON…
      const file: unknown = JSON.parse(
        JSON.stringify(await here.library.exportBundle("my-shop")),
      );
      const bundle = floorTemplateBundleSchema.parse(file);
      expect(bundle.files.map(({ path }) => path)).toEqual([
        "template.yaml",
        "roles/merchandiser.md",
        "roles/brand-reviewer.md",
        "roles/proofreader.md",
        "skills/price-check/SKILL.md",
      ]);

      // …and imported into another office: the same template, Roles,
      // Skills and all, waiting for review.
      const office = await there();
      const imported = await office.library.importBundle(bundle);
      expect(imported).toMatchObject({
        builtIn: false,
        source: "file",
        enabled: false,
        reviewedAt: null,
        digest: saved.digest,
      });
      expect(imported.template).toEqual(template);
      expect(await office.library.clashes(imported.template)).toEqual([]);

      const reviewed = await office.library.review("my-shop", imported.digest);
      expect(reviewed.enabled).toBe(true);
      const added = await office.floors.add("adrianeyre/web-shop", "my-shop");
      expect(added.template).toEqual({ id: "my-shop", name: "My shop" });
      expect(added.theme).toBe("stockroom");
      expect(added).toMatchObject({
        mergePolicy: "auto_merge",
        roundCap: 2,
        setupCommand: "pnpm install",
        testCommand: "pnpm theme-check",
      });
      expect(await rolesOf(office.stores, added.id)).toEqual([
        "manager",
        "merchandiser",
        "merchandiser",
        "brand-reviewer",
        "proofreader",
      ]);
      // Its Roles and Skills joined that office's libraries as they were here.
      const proofreader = (await office.stores.roles.list()).find(
        ({ id }) => id === "proofreader",
      );
      expect(proofreader).toEqual(
        (await here.stores.roles.list()).find(({ id }) => id === "proofreader"),
      );
      const [skill] = await office.stores.skills.list();
      const [skillHere] = await here.stores.skills.list();
      expect(skill).toMatchObject({
        name: "price-check",
        source: "template",
        enabled: true,
        digest: skillHere?.digest,
      });
      // Exported again from there, it is the same file.
      expect((await office.library.exportBundle("my-shop")).files).toEqual(
        bundle.files,
      );
    },
  ],
  [
    "an imported template is disabled until the Owner reviews its full contents",
    async ({ here }) => {
      const { library, floors } = here;
      const bundle = await library.exportBundle("corner-shop");

      // Its name is a built-in template's: the clash is reported.
      const clash = await refusal(
        library.importBundle(bundle),
        FloorTemplateLibraryError,
      );
      expect(clash.code).toBe(floorTemplateErrorCodes.templateNameTaken);
      expect(clash.message).toBe(
        'Another Floor Template is called "Corner shop": give this one another name.',
      );

      const imported = await library.importBundle(bundle, "Imported shop");
      expect(imported).toMatchObject({
        source: "file",
        enabled: false,
        reviewedAt: null,
      });
      // Its id was the built-in one's, so it has another.
      const id = imported.template.id;
      expect(id).toBe("corner-shop-2");
      expect(imported.template.name).toBe("Imported shop");

      // No Floor can be added from it yet, nor from a copy of it.
      expect((await library.enabled()).map(({ id: each }) => each)).toEqual([
        "development",
        "blank",
        "corner-shop",
      ]);
      const notYet = await refusal(
        floors.add("adrianeyre/web-shop", id),
        FloorError,
      );
      expect(notYet.code).toBe(floorErrorCodes.templateNotFound);
      const copy = await library.duplicate(id);
      expect(copy).toMatchObject({ source: "duplicate", enabled: false });
      expect(copy.template.name).toBe("Imported shop copy");

      // A review must name the contents the Owner read.
      const stale = await refusal(
        library.review(id, "0".repeat(64)),
        FloorTemplateLibraryError,
      );
      expect(stale.code).toBe(floorTemplateErrorCodes.templateChanged);
      const edited = await library.update(id, {
        description: "The shop, imported.",
      });
      expect(edited.enabled).toBe(false);
      expect(edited.digest).not.toBe(imported.digest);
      const changed = await refusal(
        library.review(id, imported.digest),
        FloorTemplateLibraryError,
      );
      expect(changed.code).toBe(floorTemplateErrorCodes.templateChanged);
      expect((await library.get(id)).enabled).toBe(false);

      const reviewed = await library.review(id, edited.digest);
      expect(reviewed).toMatchObject({ enabled: true, reviewedAt: start });
      const floor = await floors.add("adrianeyre/web-shop", id);
      expect(floor.template).toEqual({ id, name: "Imported shop" });
      expect(await rolesOf(here.stores, floor.id)).toEqual([
        "manager",
        "merchandiser",
        "merchandiser",
        "brand-reviewer",
      ]);

      expect(templateEvents(await here.events())).toEqual([
        {
          type: "floor_template.added",
          version: 1,
          templateId: id,
          name: "Imported shop",
          source: "file",
          duplicatedFrom: null,
          floorId: null,
          enabled: false,
        },
        {
          type: "floor_template.added",
          version: 1,
          templateId: "imported-shop-copy",
          name: "Imported shop copy",
          source: "duplicate",
          duplicatedFrom: { id, name: "Imported shop" },
          floorId: null,
          enabled: false,
        },
        {
          type: "floor_template.changed",
          version: 1,
          templateId: id,
          name: "Imported shop",
          change: "edited",
          keys: ["description"],
        },
        {
          type: "floor_template.changed",
          version: 1,
          templateId: id,
          name: "Imported shop",
          change: "reviewed",
          keys: [],
        },
      ]);
    },
  ],
  [
    "a built-in template cannot be edited in place; it is duplicated and the copy edited",
    async ({ here }) => {
      const { library, floors, stores } = here;
      const development = await library.get("development");
      expect(development).toMatchObject({
        builtIn: true,
        source: "built-in",
        enabled: true,
      });

      for (const attempt of [
        library.update("development", { roles: [{ role: "coder", count: 2 }] }),
        library.update("development", { name: "Software" }),
        library.remove("development"),
        library.review("development", development.digest),
      ]) {
        const error = await refusal(attempt, FloorTemplateLibraryError);
        expect(error.code).toBe(floorTemplateErrorCodes.templateBuiltIn);
        expect(error.message).toBe(
          "Development is a built-in Floor Template, so it is read-only: duplicate it, then change the copy.",
        );
      }
      expect(await library.get("development")).toEqual(development);
      expect(templateEvents(await here.events())).toEqual([]);

      const copy = await library.duplicate("development");
      expect(copy).toMatchObject({
        builtIn: false,
        source: "duplicate",
        enabled: true,
      });
      expect(copy.template).toEqual({
        ...development.template,
        id: "development-copy",
        name: "Development copy",
      });
      const edited = await library.update("development-copy", {
        roles: [
          { role: "coder", count: 2 },
          { role: "reviewer", count: 1 },
          { role: "qa", count: 1 },
        ],
        settings: { ...development.template.settings, roundCap: 5 },
        theme: "studio",
      });
      expect(edited.template.roles.map(({ count }) => count)).toEqual([
        2, 1, 1,
      ]);
      expect((await library.duplicate("development")).template.name).toBe(
        "Development copy 2",
      );

      const floor = await floors.add("adrianeyre/blog", "development-copy");
      expect(floor).toMatchObject({ roundCap: 5, theme: "studio" });
      expect(await rolesOf(stores, floor.id)).toEqual([
        "manager",
        "coder",
        "coder",
        "reviewer",
        "qa",
      ]);
      // Development itself is as it was.
      const plain = await floors.add("adrianeyre/web-shop");
      expect(plain).toMatchObject({ roundCap: 3, theme: "office" });
      expect(await rolesOf(stores, plain.id)).toEqual([
        "manager",
        "coder",
        "reviewer",
        "qa",
      ]);

      // Removed, the copy is gone; the Floor from it keeps everything.
      await library.remove("development-copy");
      expect((await library.list()).map(({ template }) => template.id)).toEqual(
        ["development", "blank", "corner-shop", "development-copy-2"],
      );
      expect((await stores.floors.get(floor.id))?.template).toEqual({
        id: "development-copy",
        name: "Development copy",
      });
      expect(await rolesOf(stores, floor.id)).toHaveLength(5);

      expect(
        templateEvents(await here.events()).map((event) =>
          event.type === "floor_template.changed"
            ? [event.type, event.templateId, event.keys]
            : [event.type, event.templateId],
        ),
      ).toEqual([
        ["floor_template.added", "development-copy"],
        [
          "floor_template.changed",
          "development-copy",
          ["theme", "roles", "settings"],
        ],
        ["floor_template.added", "development-copy-2"],
        ["floor_template.removed", "development-copy"],
      ]);
    },
  ],
  [
    "reports where an imported template's Roles and Skills clash with the libraries'",
    async ({ here }) => {
      const { library, stores } = here;
      const bundle = await library.exportBundle("corner-shop");
      // The library has its own merchandiser, a copywriter under another
      // id, and its own price-check Skill.
      for (const role of [
        {
          id: "merchandiser",
          name: "merchandiser",
          instructions: "- Our own way.",
        },
        { id: "copy-writer", name: "copywriter", instructions: "" },
      ]) {
        await stores.roles.create(
          {
            ...role,
            stage: "work",
            description: "The Owner's own.",
            skills: [],
            deskDressing: "monitor",
            aiProvider: null,
            model: null,
          },
          start,
        );
      }
      const files = [
        {
          path: "SKILL.md",
          content:
            "---\nname: price-check\ndescription: Our own price check.\n---\n\nCheck.\n",
        },
      ];
      await stores.skills.add({
        id: "own-price-check",
        name: "price-check",
        description: "Our own price check.",
        source: "editor",
        origin: null,
        files,
        digest: skillDigest(files),
        enabled: true,
        reviewedAt: start,
        createdAt: start,
        updatedAt: start,
      });

      const imported = await library.importBundle(bundle, "Imported shop");
      expect(await library.clashes(imported.template)).toEqual([
        "The Role library has its own merchandiser (merchandiser), which differs from this template's: a Floor added from it gets the library's.",
        "The Role library's copywriter (copy-writer) has the name of this template's Role copywriter: rename one of them before adding a Floor from it.",
        "The Skill library has its own price-check, which differs from this template's: a Floor added from it keeps the library's.",
      ]);
      // A Role to put in a template is the library's, or its own.
      const missing = await refusal(
        library.update(imported.template.id, {
          roles: [{ role: "florist", count: 1 }],
        }),
        FloorTemplateLibraryError,
      );
      expect(missing.code).toBe(floorTemplateErrorCodes.roleNotFound);
      // A template that does not hold together is refused, naming why.
      const invalid = await refusal(
        library.update(imported.template.id, {
          roles: [{ role: "merchandiser", count: 1 }],
        }),
        FloorTemplateLibraryError,
      );
      expect(invalid.code).toBe(floorTemplateErrorCodes.invalidTemplate);
      expect(invalid.problems).toEqual([
        'template.yaml: settings.requiredReviewers.0: "brand-reviewer" is a required reviewer, so the template starts at least one Agent in it.',
      ]);
    },
  ],
];

describe("the Owner's own Floor Templates", () => {
  let folder: TemplateFolder;
  let builtIn: readonly FloorTemplate[];
  beforeEach(async () => {
    folder = await templateFolder({ only: cornerShopNeighbours });
    await folder.write(cornerShopFiles);
    builtIn = await loadFloorTemplates(folder.root);
  });
  afterEach(() => folder.remove());

  describe("kept in memory", () => {
    const memoryOffice = () =>
      officeOn(
        memoryStores(),
        createEventBus({ store: memoryEventStore() }),
        builtIn,
      );
    for (const [name, run] of cases) {
      it(name, () =>
        run({
          here: memoryOffice(),
          there: () => Promise.resolve(memoryOffice()),
        }),
      );
    }
  });

  describe("kept in Postgres 18", () => {
    for (const [name, run] of cases) {
      postgresTest(name, async ({ database, postgresServer }) => {
        const opened: { close: () => Promise<void>; url: string }[] = [];
        const server = postgresServer as PostgresServer;
        try {
          await run({
            here: officeOn(
              databaseStores(database.db),
              createEventBus({ store: databaseEventStore(database.db) }),
              builtIn,
            ),
            there: async () => {
              const url = await server.createDatabase();
              const connection = connect(url);
              opened.push({ close: () => connection.close(), url });
              return officeOn(
                databaseStores(connection.db),
                createEventBus({ store: databaseEventStore(connection.db) }),
                builtIn,
              );
            },
          });
        } finally {
          for (const { close, url } of opened) {
            await close();
            await server.dropDatabase(url);
          }
        }
      });
    }
  });
});
