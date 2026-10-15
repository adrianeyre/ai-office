import { postgresTest } from "@ai-office/db/testing";
import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  createRedactor,
  floorErrorCodes,
  maxShownMemoryLength,
  memoryPath,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import { FloorError } from "../floors/errors.ts";
import { createFloors } from "../floors/floors.ts";
import { databaseStores, memoryStores, type OfficeStores } from "../stores.ts";
import { createRepositoryMemoryShelf } from "./bookshelf.ts";

// A Floor's repository memory as its bookshelf shows it (PRD FR-53,
// FR-58): read from the default branch and redacted, as Agents read it,
// with the proposals waiting for the Manager and its latest pull request.
// Each case runs in memory and in Postgres 18.

const repository = "adrianeyre/web-shop";
const anthropicKey = "sk-ant-api03-pastedintomemory-Qw3Er4Ty5Ui6Op7As8Df9";
const memory = "# Repository memory\n\n- Use pnpm, never npm.\n";

async function setUp(stores: OfficeStores, files: Record<string, string> = {}) {
  const github = createFakeGitHub();
  github.installRepository(repository);
  github.pushCommit(repository, "main", { files });
  await createFloors({
    store: stores.floors,
    github,
    events: createEventBus({ store: memoryEventStore() }),
  }).add(repository);
  const shelf = createRepositoryMemoryShelf({
    floors: stores.floors,
    store: stores.memory,
    github,
    redactor: createRedactor(),
  });
  return { github, stores, shelf };
}

type SetUp = (files?: Record<string, string>) => ReturnType<typeof setUp>;

const cases: [string, (setUp: SetUp) => Promise<void>][] = [
  [
    "is the memory on the default branch, redacted, with the proposals waiting and the Manager's latest pull request",
    async (setUp) => {
      const { shelf, stores } = await setUp({
        [memoryPath]: `${memory}- Deploy with ${anthropicKey}.\n`,
      });
      await stores.memory.propose([
        {
          floorId: "web-shop",
          issue: 4,
          agentId: "ada",
          text: "Run pnpm build before pnpm test.",
          createdAt: new Date("2026-10-09T10:00:00.000Z"),
        },
      ]);
      await stores.memory.recordCuration(
        {
          floorId: "web-shop",
          reason: "weekly",
          batchId: null,
          curatedBy: "model",
          agentId: "grace",
          summary: "Merged two entries.",
          entries: 1,
          pullRequest: 12,
          createdAt: new Date("2026-10-08T10:00:00.000Z"),
        },
        [],
      );
      const shown = await shelf.show("web-shop");
      expect(shown).toEqual({
        repository,
        branch: "main",
        content:
          "# Repository memory\n\n- Use pnpm, never npm.\n- Deploy with [REDACTED].",
        truncated: false,
        readError: null,
        proposals: [
          {
            id: expect.any(Number) as number,
            text: "Run pnpm build before pnpm test.",
            issue: 4,
            agentId: "ada",
            createdAt: "2026-10-09T10:00:00.000Z",
          },
        ],
        pullRequest: 12,
      });
      expect(JSON.stringify(shown)).not.toContain("sk-ant-");
    },
  ],

  [
    "is none when the repository keeps no memory, and no curation has opened a pull request",
    async (setUp) => {
      const { shelf } = await setUp();
      expect(await shelf.show("web-shop")).toEqual({
        repository,
        branch: "main",
        content: null,
        truncated: false,
        readError: null,
        proposals: [],
        pullRequest: null,
      });
    },
  ],

  [
    "says why when it cannot be read: no GitHub App, or GitHub refused",
    async (setUp) => {
      const { stores } = await setUp({ [memoryPath]: memory });
      const withoutApp = createRepositoryMemoryShelf({
        floors: stores.floors,
        store: stores.memory,
      });
      expect(await withoutApp.show("web-shop")).toMatchObject({
        content: null,
        readError:
          "The GitHub App is not set up, so the repository's memory cannot be read.",
      });
      // An App no longer installed on the repository.
      const elsewhere = createFakeGitHub();
      const refused = createRepositoryMemoryShelf({
        floors: stores.floors,
        store: stores.memory,
        github: elsewhere,
      });
      const shown = await refused.show("web-shop");
      expect(shown.content).toBeNull();
      expect(shown.readError).toMatch(
        /^The repository's memory could not be read from GitHub: /,
      );
    },
  ],

  [
    "cuts a long memory where an Agent's prompt does, saying so",
    async (setUp) => {
      const long = "- An entry that goes on.\n".repeat(600);
      const { shelf } = await setUp({ [memoryPath]: long });
      const shown = await shelf.show("web-shop");
      expect(shown.truncated).toBe(true);
      expect(shown.content).toBe(long.trim().slice(0, maxShownMemoryLength));
    },
  ],

  [
    "is refused for a Floor that does not exist",
    async (setUp) => {
      const { shelf } = await setUp();
      const error: unknown = await shelf
        .show("no-such-floor")
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(FloorError);
      expect((error as FloorError).code).toBe(floorErrorCodes.floorNotFound);
    },
  ],
];

describe("the bookshelf's repository memory, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const stores = memoryStores();
      await run((files) => setUp(stores, files));
    });
  }
});

describe("the bookshelf's repository memory, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const stores = databaseStores(database.db);
      await run((files) => setUp(stores, files));
    });
  }
});
