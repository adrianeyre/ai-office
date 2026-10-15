import { createEventBus, memoryEventStore } from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { describe, expect, it } from "vitest";

import { createAgents } from "../agents/agents.ts";
import { createFloors } from "../floors/floors.ts";
import { createFakeModel } from "../models/fake-model.ts";
import { createNotices } from "../notices/notices.ts";
import { memoryStores } from "../stores.ts";
import { createTriage } from "./triage.ts";

// A Contractor's one-off Role in the Manager's triage (PRD FR-23, ADR
// 0004): it is one of the Floor's work Roles while its Contractor stays,
// but only a Batch's Plan gives it work. A label or the Model never does,
// so a Floor whose own team has one work Role still never asks which.

const repository = "adrianeyre/web-shop";

async function setUp() {
  const stores = memoryStores();
  const github = createFakeGitHub();
  github.installRepository(repository);
  const events = createEventBus({ store: memoryEventStore() });
  await createFloors({ store: stores.floors, github, events }).add(repository);
  const agents = createAgents({
    store: stores.agents,
    floors: stores.floors,
    events,
    roles: stores.roles,
  });
  const contractor = await agents.addContractor("web-shop", {
    oneOff: {
      name: "Migration writer",
      description: "Writes migrations.",
    },
    kind: "work",
    batchId: null,
  });
  const model = createFakeModel();
  const triage = createTriage({
    floors: stores.floors,
    agents: stores.agents,
    github,
    models: model,
    notices: createNotices({ store: stores.notices, events }),
    events,
    store: stores.triage,
    roles: stores.roles,
  });
  const floor = await stores.floors.get("web-shop");
  if (floor === undefined) {
    throw new Error("The Floor was not added.");
  }
  const manager = (await stores.agents.list("web-shop")).find(
    ({ role }) => role === "manager",
  );
  return { github, model, triage, floor, contractor, manager };
}

const clear = JSON.stringify({
  clear: true,
  priority: "normal",
  reason: "It has acceptance criteria.",
  questions: [],
});

describe("a Contractor's one-off Role in triage", () => {
  it("is one of the Floor's work Roles, marked as a one-off", async () => {
    const { triage, floor, contractor } = await setUp();
    expect(await triage.workRoles(floor)).toEqual([
      expect.objectContaining({ id: "coder" }),
      {
        id: contractor.role,
        name: "Migration writer",
        description: "Writes migrations.",
        oneOff: true,
      },
    ]);
  });

  it("is never chosen for an issue of the Owner's: the Floor's one work Role is, without asking", async () => {
    const { github, model, triage, floor, manager } = await setUp();
    model.answer(manager?.id ?? "", clear);
    const issue = github.createIssue(repository, {
      title: "The orders page",
      body: "- [ ] It lists the orders",
    });
    expect((await triage.check(floor, issue)).proceed).toBe(true);
    expect(await triage.role("web-shop", issue.number)).toBe("coder");
    // The Model was not asked to choose a Role.
    expect(model.requests[0]?.system).not.toContain("Migration writer");
  });

  it("is given an issue by a Batch's Plan", async () => {
    const { github, model, triage, floor, contractor, manager } = await setUp();
    model.answer(manager?.id ?? "", clear);
    const issue = github.createIssue(repository, {
      title: "Add the status column",
      body: "- [ ] The orders table has a status column",
    });
    expect(
      (await triage.check(floor, issue, { planned: [contractor.role] }))
        .proceed,
    ).toBe(true);
    expect(await triage.role("web-shop", issue.number)).toBe(contractor.role);
  });
});
