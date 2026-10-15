import { postgresTest } from "@ai-office/db/testing";
import { createFakeGitHub } from "@ai-office/github/testing";
import {
  BatchError,
  databaseStores,
  memoryStores,
  type Batches,
  type OfficeStores,
  type PlanContent,
} from "@ai-office/orchestrator";
import { batchDetailSchema, batchListSchema } from "@ai-office/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { signIn, testAuth, type SignedIn } from "../test-support.ts";

// A Floor's Batches and the versions of their Plans (PRD FR-25), read
// over the API: newest Batch first, each with its latest Plan and the
// issues whose work has started, and one Batch with every version of its
// Plan. A Plan awaiting approval is edited and approved over it, as the
// whiteboard does (FR-25.3), each answering the Batch with every version;
// the orchestrator's Batches do the work (its own tests cover them), so
// here a stand-in records what it was asked. A signed-in session only.

const servers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const at = new Date("2026-10-09T10:00:00.000Z");

const plan = (coderId: string): PlanContent => ({
  draftedBy: "model",
  summary: "The basket first.",
  items: [
    {
      issue: 1,
      title: "Add a basket",
      dependsOn: [],
      files: ["src/basket.ts"],
      agentId: coderId,
      note: "The others build on it.",
    },
    {
      issue: 2,
      title: "Show the total",
      dependsOn: [1],
      files: ["src/basket.ts"],
      agentId: coderId,
      note: "",
    },
  ],
  overlaps: [{ issues: [1, 2], files: ["src/basket.ts"] }],
  parallel: [[1], [2]],
  leftOut: [{ issue: 3, reason: "it is closed" }],
});

async function setUp(
  stores: OfficeStores,
  plans?: Pick<Batches, "edit" | "approve">,
): Promise<{
  server: FastifyInstance;
  owner: SignedIn;
  managerId: string;
  coderId: string;
}> {
  const github = createFakeGitHub();
  github.installRepository("adrianeyre/web-shop");
  github.installRepository("adrianeyre/blog");
  const server = await buildApp({
    logger: createLogger({ level: "silent", secrets: [] }),
    checkDatabase: () => Promise.resolve(true),
    webDistDir: "/nonexistent",
    auth: await testAuth(),
    stores,
    github,
    ...(plans === undefined ? {} : { plans }),
  });
  servers.push(server);
  const owner = await signIn(server);
  for (const repository of ["adrianeyre/web-shop", "adrianeyre/blog"]) {
    const added = await server.inject({
      method: "POST",
      url: "/api/floors",
      headers: owner.headers,
      payload: { repository },
    });
    expect(added.statusCode).toBe(201);
  }
  const team = await stores.agents.list("web-shop");
  return {
    server,
    owner,
    managerId: team.find(({ role }) => role === "manager")?.id ?? "",
    coderId: team.find(({ role }) => role === "coder")?.id ?? "",
  };
}

const cases: [string, (stores: OfficeStores) => Promise<void>][] = [
  [
    "lists a Floor's Batches with their latest Plan, Kickoff acknowledgements and Wrap-up, and gives one with every version",
    async (stores) => {
      const { server, owner, managerId, coderId } = await setUp(stores);
      const { batch: first } = await stores.batches.create(
        {
          floorId: "web-shop",
          issues: [1, 2],
          status: "in_progress",
          agentId: managerId,
          createdAt: at,
        },
        plan(coderId),
      );
      await stores.batches.markStarted(first.id, 1, at);
      const later = new Date(at.getTime() + 60_000);
      await stores.batches.addPlan(
        first.id,
        { ...plan(coderId), summary: "Version 2." },
        managerId,
        later,
      );
      const { batch: second } = await stores.batches.create(
        {
          floorId: "web-shop",
          issues: [4],
          status: "awaiting_approval",
          agentId: managerId,
          createdAt: later,
        },
        { ...plan(coderId), items: [], parallel: [], overlaps: [] },
      );
      // The first's Kickoff, and its Wrap-up as it finished.
      await stores.batches.acknowledge(first.id, {
        agentId: coderId,
        planVersion: 1,
        response: "concern",
        concern: "#2 shares the basket with #1.",
        by: "model",
        createdAt: at,
      });
      const wrapUp = {
        planVersion: 2,
        issues: [
          {
            issue: 1,
            title: "Add a basket",
            outcome: "merged" as const,
            pullRequest: {
              number: 9,
              url: "https://github.com/adrianeyre/web-shop/pull/9",
            },
            agentId: coderId,
            rounds: { review: 2, qa: 1 },
            tokens: 120_000,
            estimatedCostUsd: 1.2,
          },
        ],
        leftOut: [],
        totals: {
          merged: 1,
          closed: 0,
          blocked: 0,
          notStarted: 0,
          tokens: 120_000,
          estimatedCostUsd: 1.2,
        },
      };
      const finishedAt = new Date(later.getTime() + 60_000);
      await stores.batches.markFinished(first.id, finishedAt, wrapUp);

      const listed = await server.inject({
        url: "/api/floors/web-shop/batches",
        headers: owner.headers,
      });
      expect(listed.statusCode).toBe(200);
      const { batches } = batchListSchema.parse(listed.json());
      expect(batches.map(({ id, status }) => [id, status])).toEqual([
        [second.id, "awaiting_approval"],
        [first.id, "finished"],
      ]);
      expect(batches[0]).toMatchObject({
        acknowledgements: [],
        finishedAt: null,
        wrapUp: null,
      });
      expect(batches[1]).toEqual({
        id: first.id,
        floorId: "web-shop",
        issues: [1, 2],
        status: "finished",
        agentId: managerId,
        createdAt: at.toISOString(),
        startedAt: at.toISOString(),
        started: [1],
        onePullRequest: false,
        plan: {
          batchId: first.id,
          version: 2,
          agentId: managerId,
          ...plan(coderId),
          summary: "Version 2.",
          editedFrom: null,
          createdAt: later.toISOString(),
        },
        acknowledgements: [
          {
            agentId: coderId,
            planVersion: 1,
            response: "concern",
            concern: "#2 shares the basket with #1.",
            by: "model",
            createdAt: at.toISOString(),
          },
        ],
        finishedAt: finishedAt.toISOString(),
        wrapUp,
      });

      const one = await server.inject({
        url: `/api/floors/web-shop/batches/${String(first.id)}`,
        headers: owner.headers,
      });
      expect(one.statusCode).toBe(200);
      const detail = batchDetailSchema.parse(one.json());
      expect(detail.batch).toEqual(batches[1]);
      expect(
        detail.plans.map(({ version, summary, createdAt }) => [
          version,
          summary,
          createdAt,
        ]),
      ).toEqual([
        [1, "The basket first.", at.toISOString()],
        [2, "Version 2.", later.toISOString()],
      ]);

      // Another Floor's Batches are not this one's.
      const blog = await server.inject({
        url: "/api/floors/blog/batches",
        headers: owner.headers,
      });
      expect(blog.json()).toEqual({ batches: [] });
      const elsewhere = await server.inject({
        url: `/api/floors/blog/batches/${String(first.id)}`,
        headers: owner.headers,
      });
      expect(elsewhere.statusCode).toBe(404);
      expect(elsewhere.json()).toEqual({
        error: "batch_not_found",
        message: "The Floor has no such Batch.",
      });
    },
  ],
  [
    "answers 404 for a Floor or a Batch that does not exist, and 401 without a session",
    async (stores) => {
      const { server, owner } = await setUp(stores);
      for (const url of [
        "/api/floors/web-shop/batches/999",
        "/api/floors/web-shop/batches/first",
        "/api/floors/web-shop/batches/0",
      ]) {
        const response = await server.inject({ url, headers: owner.headers });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: "batch_not_found" });
      }
      const nowhere = await server.inject({
        url: "/api/floors/nowhere/batches",
        headers: owner.headers,
      });
      expect(nowhere.statusCode).toBe(404);
      expect(nowhere.json()).toMatchObject({ error: "floor_not_found" });
      const anonymous = await server.inject({
        url: "/api/floors/web-shop/batches",
      });
      expect(anonymous.statusCode).toBe(401);
    },
  ],
  [
    "edits a Plan awaiting approval and approves it, answering the Batch with every version, or why not",
    async (stores) => {
      const asked: unknown[][] = [];
      let refusal: BatchError | undefined;
      const plans: Pick<Batches, "edit" | "approve"> = {
        async edit(floorId, batchId, edit) {
          asked.push(["edit", floorId, batchId, edit]);
          if (refusal !== undefined) {
            throw refusal;
          }
          const latest = await stores.batches.latestPlan(batchId);
          const batch = await stores.batches.get(batchId);
          if (latest === undefined || batch === undefined) {
            throw new Error("No such Batch.");
          }
          const replanned = await stores.batches.addPlan(
            batchId,
            {
              ...latest,
              summary: "Replanned.",
              items: edit.items.flatMap(({ issue, annotation }) =>
                latest.items
                  .filter((item) => item.issue === issue)
                  .map((item) => ({ ...item, annotation })),
              ),
              editedFrom: latest.version,
            },
            latest.agentId,
            new Date(at.getTime() + 60_000),
          );
          return { batch, plan: replanned };
        },
        async approve(floorId, batchId, version) {
          asked.push(["approve", floorId, batchId, version]);
          if (refusal !== undefined) {
            throw refusal;
          }
          await stores.batches.markInProgress(batchId, at);
          const batch = await stores.batches.get(batchId);
          const plan = await stores.batches.latestPlan(batchId);
          if (batch === undefined || plan === undefined) {
            throw new Error("No such Batch.");
          }
          return { batch, plan, started: [] };
        },
      };
      const { server, owner, managerId, coderId } = await setUp(stores, plans);
      const { batch } = await stores.batches.create(
        {
          floorId: "web-shop",
          issues: [1, 2],
          status: "awaiting_approval",
          agentId: managerId,
          createdAt: at,
        },
        plan(coderId),
      );
      const url = `/api/floors/web-shop/batches/${String(batch.id)}`;
      const edit = {
        version: 1,
        items: [
          { issue: 2, annotation: "  Total first.  " },
          { issue: 1, annotation: "", roles: ["copywriter", "coder"] },
        ],
      };

      const edited = await server.inject({
        method: "POST",
        url: `${url}/plan`,
        headers: owner.headers,
        payload: edit,
      });
      expect(edited.statusCode).toBe(201);
      const detail = batchDetailSchema.parse(edited.json());
      expect(
        detail.plans.map(({ version, editedFrom }) => [version, editedFrom]),
      ).toEqual([
        [1, null],
        [2, 1],
      ]);
      expect(detail.batch.plan.items).toMatchObject([
        { issue: 2, annotation: "Total first." },
        { issue: 1, annotation: "" },
      ]);
      // The edit reached the Batches as the Owner made it, trimmed.
      expect(asked).toEqual([
        [
          "edit",
          "web-shop",
          batch.id,
          {
            version: 1,
            items: [
              { issue: 2, annotation: "Total first." },
              // Its work Roles, in the Owner's order (FR-25 (1)).
              { issue: 1, annotation: "", roles: ["copywriter", "coder"] },
            ],
          },
        ],
      ]);

      const approved = await server.inject({
        method: "POST",
        url: `${url}/approve`,
        headers: owner.headers,
        payload: { version: 2 },
      });
      expect(approved.statusCode).toBe(200);
      expect(batchDetailSchema.parse(approved.json()).batch).toMatchObject({
        status: "in_progress",
        plan: { version: 2 },
      });
      expect(asked.at(-1)).toEqual(["approve", "web-shop", batch.id, 2]);

      // Bodies that do not fit are refused before the Batches are asked.
      const before = asked.length;
      for (const [path, payload] of [
        ["plan", { version: 2, items: [] }],
        ["plan", { version: 2, items: [{ issue: 1 }] }],
        [
          "plan",
          { version: 2, items: [{ issue: 1, annotation: "x".repeat(501) }] },
        ],
        // Every work Role removed.
        [
          "plan",
          { version: 2, items: [{ issue: 1, annotation: "", roles: [] }] },
        ],
        ["approve", {}],
        ["approve", { version: 0 }],
      ] as const) {
        const response = await server.inject({
          method: "POST",
          url: `${url}/${path}`,
          headers: owner.headers,
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: "invalid_request" });
      }
      expect(asked).toHaveLength(before);

      // What the Batches refuse is answered with its status.
      for (const [error, status] of [
        [new BatchError("plan_changed", "The Plan has changed."), 409],
        [
          new BatchError(
            "batch_not_awaiting_approval",
            "It was already approved.",
          ),
          409,
        ],
        [new BatchError("invalid_plan_edit", "#9 is not in the Plan."), 400],
        [
          new BatchError("batch_not_found", "The Floor has no such Batch."),
          404,
        ],
      ] as const) {
        refusal = error;
        for (const [path, payload] of [
          ["plan", edit],
          ["approve", { version: 1 }],
        ] as const) {
          const response = await server.inject({
            method: "POST",
            url: `${url}/${path}`,
            headers: owner.headers,
            payload,
          });
          expect(response.statusCode).toBe(status);
          expect(response.json()).toEqual({
            error: error.code,
            message: error.message,
          });
        }
      }
      refusal = undefined;
      const asking = asked.length;
      for (const where of [
        "/api/floors/web-shop/batches/first/approve",
        "/api/floors/web-shop/batches/0/approve",
      ]) {
        const response = await server.inject({
          method: "POST",
          url: where,
          headers: owner.headers,
          payload: { version: 1 },
        });
        expect(response.statusCode).toBe(404);
      }
      expect(asked).toHaveLength(asking);

      // A signed-in session, with its CSRF token, only.
      const anonymous = await server.inject({
        method: "POST",
        url: `${url}/approve`,
        payload: { version: 2 },
      });
      expect(anonymous.statusCode).toBe(401);
      const { cookie } = owner.headers;
      const forged = await server.inject({
        method: "POST",
        url: `${url}/approve`,
        headers: { cookie },
        payload: { version: 2 },
      });
      expect(forged.statusCode).toBe(403);
      expect(asked).toHaveLength(asking);
    },
  ],
  [
    "without the GitHub App, Plans can be read but not edited or approved",
    async (stores) => {
      const { server, owner, managerId, coderId } = await setUp(stores);
      const { batch } = await stores.batches.create(
        {
          floorId: "web-shop",
          issues: [1, 2],
          status: "awaiting_approval",
          agentId: managerId,
          createdAt: at,
        },
        plan(coderId),
      );
      const response = await server.inject({
        method: "POST",
        url: `/api/floors/web-shop/batches/${String(batch.id)}/approve`,
        headers: owner.headers,
        payload: { version: 1 },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: "github_not_configured",
        message: "Batches need the GitHub App, which is not configured.",
      });
    },
  ],
];

describe("the Batch API, in memory", () => {
  for (const [name, run] of cases) {
    it(name, () => run(memoryStores()));
  }
});

describe("the Batch API, in Postgres 18", () => {
  for (const [name, run] of cases) {
    postgresTest(name, ({ database }) => run(databaseStores(database.db)));
  }
});
