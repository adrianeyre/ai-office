import { postgresTest } from "@ai-office/db/testing";
import {
  createEventBus,
  databaseEventStore,
  memoryEventStore,
  type EventBus,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub, type FakeGitHub } from "@ai-office/github/testing";
import {
  createSharedMemory,
  databaseStores,
  memoryStores,
  type OfficeStores,
  type SharedMemory,
} from "@ai-office/orchestrator";
import {
  apiErrorSchema,
  createRedactor,
  memoryErrorCodes,
  memoryPath,
  officeMemorySchema,
  repositoryMemorySchema,
  roleMemoryEntrySchema,
  roleMemoryListSchema,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// Memory's API (PRD FR-53 to FR-56, FR-58): the Owner saves the
// office-wide memory, refused when any line looks like a credential,
// accepts, rejects and removes each Floor's Role memory, and reads each
// Floor's repository memory for its bookshelf. Each case runs in memory
// and in Postgres 18.

const officeText = "# Coding standards\n\n- Use pnpm, never npm.\n";
const leakedKey = "sk-ant-api03-theownerpastedakey0123";
// One of the Owner's own credentials, which looks like nothing much.
const ownSecret = "opaque-custom-endpoint-secret-0001";

interface Setup {
  readonly server: FastifyInstance;
  readonly github: FakeGitHub;
  readonly stores: OfficeStores;
  readonly owner: SignedIn;
  readonly memory: SharedMemory;
  readonly coderId: string;
  readonly events: () => Promise<OfficeEvent[]>;
}

async function setUp(stores: OfficeStores, bus: EventBus): Promise<Setup> {
  const fake = createFakeGitHub();
  fake.installRepository("adrianeyre/web-shop");
  const redactor = createRedactor({ secrets: [ownSecret] });
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github: fake,
    redactor,
  });
  const owner = await signIn(server);
  const added = await server.inject({
    method: "POST",
    url: "/api/floors",
    headers: owner.headers,
    payload: { repository: "adrianeyre/web-shop" },
  });
  expect(added.statusCode).toBe(201);
  const coder = (await stores.agents.list("web-shop")).find(
    ({ role }) => role === "coder",
  );
  // The same memory the flows propose to.
  const memory = createSharedMemory({
    store: stores.officeMemory,
    floors: stores.floors,
    events: bus,
    redactor,
  });
  return {
    server,
    github: fake,
    stores,
    owner,
    memory,
    coderId: coder?.id ?? "",
    events: async () => (await bus.eventsAfter(0)).map(({ event }) => event),
  };
}

const cases: [string, (setup: Setup) => Promise<void>][] = [
  [
    "the Owner saves the office-wide memory; one with a line that looks like a credential is refused, naming the line, and nothing is kept",
    async ({ server, owner, events }) => {
      const empty = await server.inject({
        method: "GET",
        url: "/api/memory/office",
        headers: owner.headers,
      });
      expect(officeMemorySchema.parse(empty.json())).toEqual({
        content: "",
        updatedAt: null,
      });

      const saved = await server.inject({
        method: "PUT",
        url: "/api/memory/office",
        headers: owner.headers,
        payload: { content: officeText },
      });
      expect(saved.statusCode).toBe(200);
      expect(officeMemorySchema.parse(saved.json()).content).toBe(officeText);

      for (const [leak, line] of [
        [`- Deploy with ${leakedKey}.`, 4],
        [`- The proxy takes ${ownSecret}.`, 4],
      ] as const) {
        const refused = await server.inject({
          method: "PUT",
          url: "/api/memory/office",
          headers: owner.headers,
          payload: { content: `${officeText}${leak}\n` },
        });
        expect(refused.statusCode).toBe(422);
        expect(apiErrorSchema.parse(refused.json())).toEqual({
          error: memoryErrorCodes.memoryHoldsSecret,
          message:
            "The office-wide memory was not saved: something in it looks like a credential, and memory never holds one.",
          problems: [
            `Line ${String(line)} looks like a credential: take the secret out.`,
          ],
        });
        expect(refused.body).not.toContain(leakedKey);
        expect(refused.body).not.toContain(ownSecret);
      }

      const tooLong = await server.inject({
        method: "PUT",
        url: "/api/memory/office",
        headers: owner.headers,
        payload: { content: "a".repeat(12_001) },
      });
      expect(tooLong.statusCode).toBe(400);

      const kept = await server.inject({
        method: "GET",
        url: "/api/memory/office",
        headers: owner.headers,
      });
      expect(officeMemorySchema.parse(kept.json()).content).toBe(officeText);
      expect(
        (await events()).filter(({ type }) => type === "memory.office_changed"),
      ).toEqual([
        {
          type: "memory.office_changed",
          version: 1,
          added: 2,
          removed: 0,
          characters: officeText.length,
        },
      ]);
    },
  ],
  [
    "the Owner lists a Floor's Role memory, and accepts, rejects and removes its entries",
    async ({ server, owner, memory, coderId, events }) => {
      const [first, second, third] = await memory.propose({
        floorId: "web-shop",
        issue: 4,
        agentId: coderId,
        role: "coder",
        entries: [
          "Write the failing test first, then the fix.",
          "Keep each commit to one change.",
          "Issue #4 needed a new table.",
        ],
      });
      const url = (id: number | undefined, action = "") =>
        `/api/floors/web-shop/role-memory/${String(id)}${action}`;

      const listed = await server.inject({
        method: "GET",
        url: "/api/floors/web-shop/role-memory",
        headers: owner.headers,
      });
      expect(
        roleMemoryListSchema
          .parse(listed.json())
          .entries.map(({ text, status, role, issue, agentId }) => ({
            text,
            status,
            role,
            issue,
            agentId,
          })),
      ).toEqual([
        {
          text: "Write the failing test first, then the fix.",
          status: "proposed",
          role: "coder",
          issue: 4,
          agentId: coderId,
        },
        {
          text: "Keep each commit to one change.",
          status: "proposed",
          role: "coder",
          issue: 4,
          agentId: coderId,
        },
        {
          text: "Issue #4 needed a new table.",
          status: "proposed",
          role: "coder",
          issue: 4,
          agentId: coderId,
        },
      ]);

      const accepted = await server.inject({
        method: "POST",
        url: url(first?.id, "/accept"),
        headers: owner.headers,
      });
      expect(accepted.statusCode).toBe(200);
      expect(roleMemoryEntrySchema.parse(accepted.json())).toMatchObject({
        status: "accepted",
        decidedBy: "owner",
      });
      const rejected = await server.inject({
        method: "POST",
        url: url(third?.id, "/reject"),
        headers: owner.headers,
        payload: { reason: "Only about one issue." },
      });
      expect(roleMemoryEntrySchema.parse(rejected.json())).toMatchObject({
        status: "rejected",
        reason: "Only about one issue.",
      });
      const rejectedBare = await server.inject({
        method: "POST",
        url: url(second?.id, "/reject"),
        headers: owner.headers,
      });
      expect(rejectedBare.statusCode).toBe(200);

      const again = await server.inject({
        method: "POST",
        url: url(first?.id, "/accept"),
        headers: owner.headers,
      });
      expect(again.statusCode).toBe(409);
      expect(apiErrorSchema.parse(again.json()).error).toBe(
        memoryErrorCodes.roleMemoryDecided,
      );
      const removeRejected = await server.inject({
        method: "DELETE",
        url: url(third?.id),
        headers: owner.headers,
      });
      expect(removeRejected.statusCode).toBe(409);
      for (const [method, path] of [
        ["POST", url(999, "/accept")],
        ["POST", url(undefined, "/accept")],
        ["DELETE", "/api/floors/web-shop/role-memory/0"],
      ] as const) {
        const missing = await server.inject({
          method,
          url: path,
          headers: owner.headers,
        });
        expect(missing.statusCode).toBe(404);
      }
      const noFloor = await server.inject({
        method: "GET",
        url: "/api/floors/no-such-floor/role-memory",
        headers: owner.headers,
      });
      expect(noFloor.statusCode).toBe(404);

      const removed = await server.inject({
        method: "DELETE",
        url: url(first?.id),
        headers: owner.headers,
      });
      expect(roleMemoryEntrySchema.parse(removed.json()).status).toBe(
        "removed",
      );
      const after = await server.inject({
        method: "GET",
        url: "/api/floors/web-shop/role-memory",
        headers: owner.headers,
      });
      expect(roleMemoryListSchema.parse(after.json()).entries).toEqual([]);

      expect(
        (await events()).flatMap((event) =>
          event.type === "memory.role_changed"
            ? [{ change: event.change, by: event.by, entryId: event.entryId }]
            : [],
        ),
      ).toEqual([
        { change: "accepted", by: "owner", entryId: first?.id },
        { change: "rejected", by: "owner", entryId: third?.id },
        { change: "rejected", by: "owner", entryId: second?.id },
        { change: "removed", by: "owner", entryId: first?.id },
      ]);
    },
  ],
  [
    "lists what the Manager recommends as waiting for the Owner, who alone accepts it (ADR 0005)",
    async ({ server, owner, memory, coderId }) => {
      const [first, second] = await memory.propose({
        floorId: "web-shop",
        issue: 4,
        agentId: coderId,
        role: "coder",
        entries: [
          "Write the failing test first, then the fix.",
          "Keep each commit to one change.",
        ],
      });
      for (const entry of [first, second]) {
        await memory.decide(
          "web-shop",
          entry?.id ?? 0,
          "accept",
          { by: "manager", agentId: "max" },
          "It holds for every coder here.",
        );
      }
      const list = async () =>
        roleMemoryListSchema
          .parse(
            (
              await server.inject({
                method: "GET",
                url: "/api/floors/web-shop/role-memory",
                headers: owner.headers,
              })
            ).json(),
          )
          .entries.map(({ text, status, decidedBy, reason }) => ({
            text,
            status,
            decidedBy,
            reason,
          }));
      expect(await list()).toEqual([
        {
          text: "Write the failing test first, then the fix.",
          status: "recommended",
          decidedBy: "manager",
          reason: "It holds for every coder here.",
        },
        {
          text: "Keep each commit to one change.",
          status: "recommended",
          decidedBy: "manager",
          reason: "It holds for every coder here.",
        },
      ]);
      expect((await memory.forAgent("web-shop", "coder")).role).toEqual([]);

      const accepted = await server.inject({
        method: "POST",
        url: `/api/floors/web-shop/role-memory/${String(first?.id)}/accept`,
        headers: owner.headers,
      });
      expect(roleMemoryEntrySchema.parse(accepted.json())).toMatchObject({
        status: "accepted",
        decidedBy: "owner",
      });
      const rejected = await server.inject({
        method: "POST",
        url: `/api/floors/web-shop/role-memory/${String(second?.id)}/reject`,
        headers: owner.headers,
      });
      expect(roleMemoryEntrySchema.parse(rejected.json()).status).toBe(
        "rejected",
      );
      expect((await memory.forAgent("web-shop", "coder")).role).toEqual([
        "Write the failing test first, then the fix.",
      ]);
    },
  ],
  [
    "a Floor's bookshelf reads its repository memory from the default branch, redacted, with the proposals waiting for the Manager",
    async ({ server, owner, github, stores }) => {
      const read = async () => {
        const response = await server.inject({
          method: "GET",
          url: "/api/floors/web-shop/repository-memory",
          headers: owner.headers,
        });
        expect(response.statusCode).toBe(200);
        return repositoryMemorySchema.parse(response.json());
      };
      expect(await read()).toEqual({
        repository: "adrianeyre/web-shop",
        branch: "main",
        content: null,
        truncated: false,
        readError: null,
        proposals: [],
        pullRequest: null,
      });

      github.pushCommit("adrianeyre/web-shop", "main", {
        files: {
          [memoryPath]: `# Repository memory\n\n- Use pnpm.\n- Deploy with ${leakedKey}.\n- Or ${ownSecret}.\n`,
        },
      });
      await stores.memory.propose([
        {
          floorId: "web-shop",
          issue: 7,
          agentId: "ada",
          text: "Run pnpm build first.",
          createdAt: new Date("2026-10-09T10:00:00.000Z"),
        },
      ]);
      const shown = await read();
      expect(shown.content).toBe(
        "# Repository memory\n\n- Use pnpm.\n- Deploy with [REDACTED].\n- Or [REDACTED].",
      );
      expect(shown.proposals).toEqual([
        {
          id: expect.any(Number) as number,
          text: "Run pnpm build first.",
          issue: 7,
          agentId: "ada",
          createdAt: "2026-10-09T10:00:00.000Z",
        },
      ]);
      const body = JSON.stringify(shown);
      expect(body).not.toContain(leakedKey);
      expect(body).not.toContain(ownSecret);

      const noFloor = await server.inject({
        method: "GET",
        url: "/api/floors/no-such-floor/repository-memory",
        headers: owner.headers,
      });
      expect(noFloor.statusCode).toBe(404);
      const signedOut = await server.inject({
        method: "GET",
        url: "/api/floors/web-shop/repository-memory",
      });
      expect(signedOut.statusCode).toBe(401);
    },
  ],
  [
    "needs a signed-in session, and the session's CSRF token to change anything",
    async ({ server, owner }) => {
      const signedOut = await server.inject({
        method: "GET",
        url: "/api/memory/office",
      });
      expect(signedOut.statusCode).toBe(401);
      const forged = await server.inject({
        method: "PUT",
        url: "/api/memory/office",
        headers: { cookie: owner.cookie },
        payload: { content: officeText },
      });
      expect(forged.statusCode).toBe(403);
    },
  ],
];

describe("office-wide and Role memory's API, in memory", () => {
  for (const [name, run] of cases) {
    it(name, async () => {
      const setup = await setUp(
        memoryStores(),
        createEventBus({ store: memoryEventStore() }),
      );
      try {
        await run(setup);
      } finally {
        await setup.server.close();
      }
    });
  }
});

describe("office-wide and Role memory's API, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, async ({ database }) => {
      const setup = await setUp(
        databaseStores(database.db),
        createEventBus({ store: databaseEventStore(database.db) }),
      );
      try {
        await run(setup);
      } finally {
        await setup.server.close();
      }
    });
  }
});

describe("a Floor's repository memory without the GitHub App", () => {
  it("is not read, saying why", async () => {
    const stores = memoryStores();
    const bus = createEventBus({ store: memoryEventStore() });
    // The Floor was added while the App was set up.
    const before = await setUp(stores, bus);
    await before.server.close();
    const server = await buildApp({
      logger: createLogger({ level: "silent", secrets: [] }),
      checkDatabase: () => Promise.resolve(true),
      webDistDir: "/nonexistent",
      auth: await testAuth(),
      events: bus,
      stores,
    });
    try {
      const owner = await signIn(server);
      const response = await server.inject({
        method: "GET",
        url: "/api/floors/web-shop/repository-memory",
        headers: owner.headers,
      });
      expect(response.statusCode).toBe(200);
      expect(repositoryMemorySchema.parse(response.json())).toMatchObject({
        content: null,
        readError:
          "The GitHub App is not set up, so the repository's memory cannot be read.",
      });
    } finally {
      await server.close();
    }
  });
});
