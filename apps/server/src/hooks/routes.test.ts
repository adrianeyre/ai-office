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
  createFloorSkills,
  createHookRunner,
  createNotices,
  databaseStores,
  memoryStores,
  type HookRunner,
  type ModelClient,
  type OfficeStores,
} from "@ai-office/orchestrator";
import {
  apiErrorSchema,
  floorErrorCodes,
  hookErrorCodes,
  hookListSchema,
  startedHookRunSchema,
  type HookInputRequest,
  type SkillFile,
} from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// A Floor's Hooks in its admin (Guidelines, Specs and Hooks PRD, FR-121;
// ADR 0016): the Owner lists, adds, changes, turns off, deletes and runs
// them now, each change an event; nobody else can. The orchestrator's
// scenarios run them on their triggers; here the API is checked, in
// memory and in Postgres 18.

const repository = "adrianeyre/web-shop";
const floorId = "web-shop";

const skillFiles: SkillFile[] = [
  {
    path: "SKILL.md",
    content:
      "---\nname: migration-check\ndescription: Checks migrations.\n---\n\nSay whether each migration can be rolled back.\n",
  },
];

interface Setup {
  readonly server: FastifyInstance;
  readonly owner: SignedIn;
  readonly stores: OfficeStores;
  readonly runner: HookRunner;
  readonly published: OfficeEvent[];
  readonly calls: string[];
  agentId(role: string): Promise<string>;
}

async function setUp(stores: OfficeStores, bus: EventBus): Promise<Setup> {
  const github = createFakeGitHub();
  github.installRepository(repository);
  const now = new Date();
  await stores.skills.add({
    id: "skill-1",
    name: "migration-check",
    description: "Checks migrations.",
    source: "editor",
    origin: null,
    files: skillFiles,
    digest: "a".repeat(64),
    enabled: true,
    reviewedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const calls: string[] = [];
  const models: ModelClient = {
    complete(request) {
      calls.push(request.agentId);
      return Promise.resolve({ text: "All fine.", stopReason: "end_turn" });
    },
    stream: () => Promise.reject(new Error("Hooks do not stream.")),
  };
  const runner = createHookRunner({
    floors: stores.floors,
    agents: stores.agents,
    roles: stores.roles,
    store: stores.hooks,
    events: bus,
    github,
    skills: createFloorSkills({
      floors: stores.floors,
      library: stores.skills,
      toggles: stores.floorSkills,
      reviews: stores.repositorySkillReviews,
      roles: stores.roles,
      events: bus,
      github,
    }),
    models,
    notices: createNotices({ store: stores.notices, events: bus }),
    pushPollMs: 0,
  });
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    events: bus,
    stores,
    github,
    models,
    hookRunner: runner,
  });
  const owner = await signIn(server);
  const added = await server.inject({
    method: "POST",
    url: "/api/floors",
    headers: owner.headers,
    payload: { repository },
  });
  expect(added.statusCode).toBe(201);
  const published: OfficeEvent[] = [];
  bus.subscribe(({ event }) => {
    published.push(event);
  });
  return {
    server,
    owner,
    stores,
    runner,
    published,
    calls,
    async agentId(role) {
      const agent = (await stores.agents.list(floorId)).find(
        (each) => each.role === role,
      );
      return agent?.id ?? "";
    },
  };
}

const send = (
  { server, owner }: Setup,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
) =>
  server.inject({
    method,
    url,
    headers: owner.headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const migrationCheck: HookInputRequest = {
  name: "Migration check",
  trigger: "pull_request_opened",
  filePatterns: ["**/*.sql"],
  role: "reviewer",
  skillName: "migration-check",
};

const errorOf = (body: string) => apiErrorSchema.parse(JSON.parse(body));

async function run(setup: Setup): Promise<void> {
  // Empty at first, with the Skills a Hook can run.
  const empty = await send(setup, "GET", `/api/floors/${floorId}/hooks`);
  expect(empty.statusCode).toBe(200);
  const first = hookListSchema.parse(empty.json());
  expect(first.hooks).toEqual([]);
  expect(first.skills.map(({ name }) => name)).toContain("migration-check");
  expect(first.skills.map(({ name }) => name)).not.toContain("grilling");

  // Creating.
  const created = await send(
    setup,
    "POST",
    `/api/floors/${floorId}/hooks`,
    migrationCheck,
  );
  expect(created.statusCode).toBe(201);
  const [hook] = hookListSchema.parse(created.json()).hooks;
  expect(hook).toMatchObject({
    name: "Migration check",
    trigger: "pull_request_opened",
    stage: null,
    labels: [],
    filePatterns: ["**/*.sql"],
    agentId: null,
    role: "reviewer",
    skillName: "migration-check",
    runsPerHour: 12,
    enabled: true,
    failures: 0,
    runs: [],
  });
  if (hook === undefined) {
    throw new Error("The Hook was created.");
  }
  const url = `/api/floors/${floorId}/hooks/${String(hook.id)}`;

  // Editing: the whole of it.
  const edited = await send(setup, "PUT", url, {
    ...migrationCheck,
    name: "Schema check",
    trigger: "stage",
    stage: "needs-review",
    labels: ["database"],
    runsPerHour: 3,
  });
  expect(edited.statusCode).toBe(200);
  expect(hookListSchema.parse(edited.json()).hooks[0]).toMatchObject({
    name: "Schema check",
    trigger: "stage",
    stage: "needs-review",
    labels: ["database"],
    runsPerHour: 3,
  });

  // Disabling.
  const disabled = await send(setup, "PUT", url, {
    ...migrationCheck,
    name: "Schema check",
    trigger: "stage",
    stage: "needs-review",
    labels: ["database"],
    runsPerHour: 3,
    enabled: false,
  });
  expect(disabled.statusCode).toBe(200);
  expect(hookListSchema.parse(disabled.json()).hooks[0]?.enabled).toBe(false);

  // Each change is an event in the Activity Feed.
  expect(
    setup.published
      .filter(({ type }) => type.startsWith("hook."))
      .map((event) =>
        event.type === "hook.changed"
          ? `${event.type} ${event.fields.join(",")}`
          : event.type,
      ),
  ).toEqual([
    "hook.added",
    "hook.changed name,trigger,stage,labels,runsPerHour",
    "hook.changed enabled",
  ]);

  // Run now: only a Run now Hook that is on.
  const notRunNow = await send(setup, "POST", `${url}/run`);
  expect(notRunNow.statusCode).toBe(409);
  expect(errorOf(notRunNow.body).error).toBe(hookErrorCodes.hookNotRunNow);
  const coder = await setup.agentId("coder");
  const runNowHook = await send(setup, "POST", `/api/floors/${floorId}/hooks`, {
    name: "Tidy",
    trigger: "run_now",
    agentId: coder,
    skillName: "migration-check",
    runsPerHour: 1,
  });
  expect(runNowHook.statusCode).toBe(201);
  const tidy = hookListSchema
    .parse(runNowHook.json())
    .hooks.find(({ name }) => name === "Tidy");
  const tidyUrl = `/api/floors/${floorId}/hooks/${String(tidy?.id)}`;
  const ran = await send(setup, "POST", `${tidyUrl}/run`);
  expect(ran.statusCode).toBe(202);
  expect(startedHookRunSchema.parse(ran.json()).run).toMatchObject({
    agentId: coder,
    trigger: "run_now",
    status: "running",
  });
  await setup.runner.idle();
  expect(setup.calls).toEqual([coder]);
  const afterRun = hookListSchema.parse(
    (await send(setup, "GET", `/api/floors/${floorId}/hooks`)).json(),
  );
  expect(
    afterRun.hooks.find(({ name }) => name === "Tidy")?.runs[0],
  ).toMatchObject({ status: "succeeded", result: "All fine." });
  // Its one run this hour is made.
  const limited = await send(setup, "POST", `${tidyUrl}/run`);
  expect(limited.statusCode).toBe(429);
  expect(errorOf(limited.body).error).toBe(hookErrorCodes.hookRateLimited);

  // Deleting.
  const deleted = await send(setup, "DELETE", url);
  expect(deleted.statusCode).toBe(200);
  expect(
    hookListSchema.parse(deleted.json()).hooks.map(({ name }) => name),
  ).toEqual(["Tidy"]);
  const again = await send(setup, "DELETE", url);
  expect(again.statusCode).toBe(404);
  expect(errorOf(again.body).error).toBe(hookErrorCodes.hookNotFound);
  expect(setup.published.at(-1)).toMatchObject({
    type: "hook.removed",
    hookId: hook.id,
  });
}

async function refusals(setup: Setup): Promise<void> {
  const hooksUrl = `/api/floors/${floorId}/hooks`;
  // A body the schema refuses: each problem named.
  const invalid = await send(setup, "POST", hooksUrl, {
    ...migrationCheck,
    trigger: "push",
    filePatterns: [],
    labels: ["db"],
  });
  expect(invalid.statusCode).toBe(400);
  expect(errorOf(invalid.body)).toEqual({
    error: "invalid_request",
    problems: [
      '"A push to the default branch touches matching files" is not narrowed by label.',
      "A Hook on a push names the files it watches, such as **/*.sql.",
    ],
  });
  // No shell command is taken: the body is strict.
  const shell = await send(setup, "POST", hooksUrl, {
    ...migrationCheck,
    command: "rm -rf /",
  });
  expect(shell.statusCode).toBe(400);
  // An Agent, Role or Skill the Floor does not have.
  for (const body of [
    { ...migrationCheck, role: null, agentId: "nobody" },
    {
      ...migrationCheck,
      role: null,
      agentId: await setup.agentId("manager"),
    },
    { ...migrationCheck, role: "astronaut" },
    { ...migrationCheck, skillName: "no-such-skill" },
  ]) {
    const refused = await send(setup, "POST", hooksUrl, body);
    expect(refused.statusCode).toBe(400);
    expect(errorOf(refused.body).error).toBe(hookErrorCodes.hookInvalid);
  }
  // A name taken, whatever its case.
  expect((await send(setup, "POST", hooksUrl, migrationCheck)).statusCode).toBe(
    201,
  );
  const taken = await send(setup, "POST", hooksUrl, {
    ...migrationCheck,
    name: "MIGRATION CHECK",
  });
  expect(taken.statusCode).toBe(409);
  expect(errorOf(taken.body).error).toBe(hookErrorCodes.hookNameTaken);
  // An unknown Hook, an id that is no id, an unknown Floor.
  expect(
    (await send(setup, "PUT", `${hooksUrl}/999`, migrationCheck)).statusCode,
  ).toBe(404);
  expect((await send(setup, "DELETE", `${hooksUrl}/abc`)).statusCode).toBe(404);
  expect((await send(setup, "POST", `${hooksUrl}/0/run`)).statusCode).toBe(404);
  const noFloor = await send(setup, "GET", "/api/floors/no-such-floor/hooks");
  expect(noFloor.statusCode).toBe(404);
  expect(errorOf(noFloor.body).error).toBe(floorErrorCodes.floorNotFound);
  // Only the Owner: without a session, nothing.
  for (const [method, url] of [
    ["GET", hooksUrl],
    ["POST", hooksUrl],
    ["PUT", `${hooksUrl}/1`],
    ["DELETE", `${hooksUrl}/1`],
    ["POST", `${hooksUrl}/1/run`],
  ] as const) {
    const response = await setup.server.inject({
      method,
      url,
      payload: migrationCheck,
    });
    expect(response.statusCode).toBe(401);
  }
  expect((await setup.stores.hooks.list(floorId)).length).toBe(1);
  // An archived Floor's Hooks do not change.
  await setup.stores.floors.archive(floorId, new Date());
  const archived = await send(setup, "POST", hooksUrl, {
    ...migrationCheck,
    name: "Another",
  });
  expect(archived.statusCode).toBe(409);
  expect(errorOf(archived.body).error).toBe(floorErrorCodes.floorArchived);
}

describe("the Hooks API, with Hooks in memory", () => {
  const fresh = () => {
    const stores = memoryStores();
    return setUp(stores, createEventBus({ store: memoryEventStore() }));
  };

  it("creates, edits, disables, runs now and deletes a Hook, each an event", async () => {
    await run(await fresh());
  });

  it("refuses what is not a Hook, what the Floor does not have, a name taken, and anyone but the Owner", async () => {
    await refusals(await fresh());
  });
});

describe("the Hooks API, with Hooks in Postgres 18", () => {
  postgresTest(
    "creates, edits, disables, runs now and deletes a Hook, each an event",
    async ({ database }) => {
      await run(
        await setUp(
          databaseStores(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    },
  );

  postgresTest(
    "refuses what is not a Hook, what the Floor does not have, a name taken, and anyone but the Owner",
    async ({ database }) => {
      await refusals(
        await setUp(
          databaseStores(database.db),
          createEventBus({ store: databaseEventStore(database.db) }),
        ),
      );
    },
  );
});
