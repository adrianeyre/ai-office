import { describe, expect, it } from "vitest";

import {
  eventTypes,
  matchesFilter,
  officeEventSchema,
  subjectOf,
  type OfficeEvent,
} from "./schema.ts";
import { exampleEvents } from "./test-support.ts";

describe("officeEventSchema", () => {
  it("covers Floor, Agent, Contractor, issue, Manager decision, Batch, Status update, memory, sandbox, Grilling Session fact-finding, documents and issues, repository, branch, pull request, review, QA, design review, Handoff, model call, Notice, cap, AI Account, config, Connection, Google sign-in, Skill, Role, Floor Template, sign-in and Gateway Key events", () => {
    const families = new Set(eventTypes.map((type) => type.split(".")[0]));
    expect([...families].sort()).toEqual(
      [
        "agent",
        "ai_account",
        "batch",
        "branch",
        "cap",
        "config",
        "connection",
        "contractor",
        "design",
        "floor",
        "floor_template",
        "gateway_key",
        "google",
        "grilling",
        "handoff",
        "issue",
        "manager",
        "memory",
        "model_call",
        "notice",
        "pull_request",
        "qa",
        "repository",
        "review",
        "role",
        "sandbox",
        "sign_in",
        "signed_out",
        "skill",
        "status_update",
      ].sort(),
    );
    expect(Object.keys(exampleEvents).sort()).toEqual([...eventTypes].sort());
  });

  it.each(Object.values(exampleEvents))("parses a $type event", (event) => {
    expect(officeEventSchema.parse(event)).toEqual(event);
  });

  it("refuses an unknown type, another version, or an unknown field", () => {
    const base = exampleEvents["floor.archived"];
    expect(
      officeEventSchema.safeParse({ ...base, type: "floor.flooded" }).success,
    ).toBe(false);
    expect(officeEventSchema.safeParse({ ...base, version: 2 }).success).toBe(
      false,
    );
    expect(
      officeEventSchema.safeParse({ ...base, password: "hunter2" }).success,
    ).toBe(false);
  });

  it("refuses a malformed field", () => {
    expect(
      officeEventSchema.safeParse({
        ...exampleEvents["agent.fresh_start"],
        contextUsage: 1.5,
      }).success,
    ).toBe(false);
    expect(
      officeEventSchema.safeParse({
        ...exampleEvents["floor.created"],
        repository: "not a repository",
      }).success,
    ).toBe(false);
  });
});

describe("Floor Templates in events", () => {
  it("still reads a floor.created from before Floor Templates, without one", () => {
    const { template, ...before } = exampleEvents["floor.created"];
    expect(template).toEqual({ id: "development", name: "Development" });
    expect(officeEventSchema.safeParse(before).success).toBe(true);
  });

  it("names the template a role.created came from, or none", () => {
    const made = exampleEvents["role.created"];
    expect(officeEventSchema.safeParse(made).success).toBe(true);
    expect(
      officeEventSchema.safeParse({
        ...made,
        template: { id: "online-store", name: "Online store" },
      }).success,
    ).toBe(true);
    expect(
      officeEventSchema.safeParse({
        ...made,
        template: { id: "Online store", name: "Online store" },
      }).success,
    ).toBe(false);
  });
});

describe("subjectOf", () => {
  it("finds the Floor, every Agent and the issue", () => {
    expect(subjectOf(exampleEvents.handoff)).toEqual({
      floorId: "web-shop",
      agentIds: ["ada", "grace"],
      issue: 4,
    });
    expect(subjectOf(exampleEvents["sign_in.failed"])).toEqual({
      floorId: null,
      agentIds: [],
      issue: null,
    });
  });
});

describe("matchesFilter", () => {
  const handoff: OfficeEvent = exampleEvents.handoff;

  it("matches everything without a filter", () => {
    expect(matchesFilter(handoff)).toBe(true);
    expect(matchesFilter(handoff, { types: [] })).toBe(true);
  });

  it("narrows by Floor, Agent, issue and type together", () => {
    expect(matchesFilter(handoff, { floorId: "web-shop" })).toBe(true);
    expect(matchesFilter(handoff, { floorId: "blog" })).toBe(false);
    expect(matchesFilter(handoff, { agentId: "grace" })).toBe(true);
    expect(matchesFilter(handoff, { agentId: "linus" })).toBe(false);
    expect(matchesFilter(handoff, { issue: 4 })).toBe(true);
    expect(matchesFilter(handoff, { issue: 5 })).toBe(false);
    expect(matchesFilter(handoff, { types: ["handoff", "cap.warning"] })).toBe(
      true,
    );
    expect(matchesFilter(handoff, { types: ["cap.warning"] })).toBe(false);
    expect(
      matchesFilter(handoff, { floorId: "web-shop", issue: 4, agentId: "x" }),
    ).toBe(false);
  });
});
