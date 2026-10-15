import { chatRequestFence, type ChatRequest } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import type { AgentRecord } from "../agents/store.ts";
import {
  contractorRoom,
  heldText,
  parseChatRequest,
  readRequestStart,
  staff,
  type LibraryWorkRole,
  type ResolvedRole,
} from "./requests.ts";

// The Manager's chat requests in plain code (PRD FR-10, FR-24, ADR 0004):
// reading the Model's decision, and who works a request's issues, within
// the Floor's "most Agents" and the sandbox limits.

const coder: LibraryWorkRole = {
  id: "coder",
  name: "coder",
  description: "Changes the code.",
};
const copywriter: LibraryWorkRole = {
  id: "copywriter",
  name: "copywriter",
  description: "Writes the copy.",
};
const writer = {
  name: "Migration writer",
  description: "Writes migrations.",
  instructions: "Write the migration.",
};

const agent = (
  id: string,
  role: string,
  overrides: Partial<AgentRecord> = {},
): AgentRecord => ({
  id,
  floorId: "web-shop",
  name: id,
  role,
  stage: role === "reviewer" ? "review" : role === "qa" ? "qa" : "work",
  aiProvider: "Claude",
  modelOverride: null,
  effort: null,
  extraInstructions: "",
  enabled: true,
  avatar: {} as AgentRecord["avatar"],
  tokenCaps: { daily: null, monthly: null },
  freshStartThreshold: null,
  createdAt: new Date(0),
  leavingAt: null,
  contractor: null,
  ...overrides,
});

const block = (value: unknown) =>
  `${chatRequestFence}\n${JSON.stringify(value)}\n\`\`\``;

const issue = (role: string, dependsOn: number[] = []) => ({
  title: "A page",
  body: "Build it.",
  acceptanceCriteria: ["It shows."],
  dependsOn,
  files: [],
  role,
});

describe("reading the start of the Manager's reply", () => {
  it("holds back a start that could open a decision, and lets any other go", () => {
    expect(readRequestStart("")).toBeUndefined();
    expect(readRequestStart("  ``")).toBeUndefined();
    expect(readRequestStart("```req")).toBeUndefined();
    expect(readRequestStart(chatRequestFence)).toBeUndefined();
    expect(readRequestStart(`${chatRequestFence}\n{`)).toBe(true);
    expect(readRequestStart("```ts\nconst a = 1;")).toBe(false);
    expect(readRequestStart("```requests\n")).toBe(false);
    expect(readRequestStart("Batch 3 is half done.")).toBe(false);
  });
});

describe("reading the Manager's decision", () => {
  it("reads a clarifying question and research as they are", () => {
    expect(
      parseChatRequest(
        block({ decision: "clarify", question: "Which page?" }),
        [coder],
      ),
    ).toEqual({
      ok: true,
      value: { decision: "clarify", question: "Which page?" },
    });
    const research: ChatRequest = {
      decision: "research",
      message: "Reading first.",
      role: writer,
      questions: ["Where is the total?"],
    };
    expect(parseChatRequest(block(research), [])).toEqual({
      ok: true,
      value: research,
    });
  });

  it("gives each issue its Role: a library work Role's, by name or id, or a one-off one", () => {
    const parsed = parseChatRequest(
      block({
        decision: "batch",
        message: "Two things.",
        roles: [writer],
        issues: [issue("migration writer"), issue("Coder", [1])],
      }),
      [coder],
    );
    expect(
      parsed.ok && parsed.value.decision === "batch" && parsed.value.resolved,
    ).toEqual([
      { kind: "one-off", role: writer },
      { kind: "library", role: coder },
    ]);
  });

  it("says what is wrong, in a sentence the Model can act on", () => {
    const problem = (value: unknown, library = [coder]) => {
      const parsed = parseChatRequest(block(value), library);
      return parsed.ok ? undefined : parsed.problem;
    };
    expect(problem({ decision: "merge" })).toContain(
      'decision is "batch", "research" or "clarify".',
    );
    expect(
      problem({
        decision: "batch",
        message: "x",
        roles: [],
        issues: [issue("janitor")],
      }),
    ).toBe(
      'Issue 1\'s role "janitor" is neither one of the work Roles listed nor one of your one-off Roles.',
    );
    expect(
      problem({
        decision: "batch",
        message: "x",
        roles: [],
        issues: [issue("coder", [1])],
      }),
    ).toBe("Issue 1 may depend only on issues before it in your list.");
    expect(
      problem({
        decision: "batch",
        message: "x",
        roles: [writer, { ...writer, name: "migration WRITER" }],
        issues: [issue("coder")],
      }),
    ).toBe("Name each one-off Role once.");
    expect(
      problem({ decision: "batch", message: "x", roles: [], issues: [] }),
    ).toContain("File at least one issue.");
    expect(problem("no block at all")).toBeDefined();
  });
});

describe("the room a Floor has for Contractors", () => {
  const team = [
    agent("manager", "manager", { stage: null }),
    agent("ada", "coder"),
    agent("rex", "reviewer"),
    agent("quinn", "qa"),
    agent("leaving", "coder", { leavingAt: new Date(0) }),
  ];

  it('counts every staying Agent but the Manager towards "most Agents", and work Agents towards the sandboxes', () => {
    expect(
      contractorRoom({ mostAgents: 8, concurrencyLimit: null }, team, 3),
    ).toEqual({ agents: 5, sandboxes: 2 });
    // The Floor's own lower sandbox limit, and no limit on Agents.
    expect(
      contractorRoom({ mostAgents: null, concurrencyLimit: 1 }, team, 3),
    ).toEqual({ agents: Number.POSITIVE_INFINITY, sandboxes: 0 });
    expect(
      contractorRoom({ mostAgents: 2, concurrencyLimit: 10 }, team, 3),
    ).toEqual({ agents: 0, sandboxes: 2 });
  });
});

describe("who works a request's issues", () => {
  const oneOff: ResolvedRole = { kind: "one-off", role: writer };
  const coders: ResolvedRole = { kind: "library", role: coder };
  const copy: ResolvedRole = { kind: "library", role: copywriter };
  const team = [agent("ada", "coder")];
  const roomy = { agents: 10, sandboxes: 10 };

  it("adds a Contractor for a Role no Agent on the Floor fills, and none where the Floor's own suffice", () => {
    const staffing = staff({
      issues: [
        { dependsOn: [], role: oneOff },
        { dependsOn: [1], role: coders },
        { dependsOn: [1], role: copy },
      ],
      team,
      busy: new Set(),
      room: roomy,
      fallback: coder,
    });
    expect(staffing.contractors).toEqual([
      { role: oneOff, issues: [0] },
      { role: copy, issues: [2] },
    ]);
    expect(staffing.held).toEqual(new Map());
    expect(staffing.rerouted).toEqual(new Map());
  });

  it("adds Contractors where a Role's ready work outnumbers its free Agents", () => {
    const issues = [
      { dependsOn: [], role: coders },
      { dependsOn: [], role: coders },
      { dependsOn: [], role: coders },
      { dependsOn: [1], role: coders },
    ];
    expect(
      staff({ issues, team, busy: new Set(), room: roomy, fallback: coder })
        .contractors,
    ).toHaveLength(2);
    // A busy coder is not free.
    expect(
      staff({
        issues,
        team,
        busy: new Set(["ada"]),
        room: roomy,
        fallback: coder,
      }).contractors,
    ).toHaveLength(3);
  });

  it("stays within both limits, saying which held the rest back, and gives a one-off Role's work to the Floor's own when none fits", () => {
    const issues = [
      { dependsOn: [], role: oneOff },
      { dependsOn: [], role: coders },
      { dependsOn: [], role: coders },
    ];
    const bySandboxes = staff({
      issues,
      team,
      busy: new Set(),
      room: { agents: 5, sandboxes: 1 },
      fallback: coder,
    });
    // The Role the Floor lacks comes first.
    expect(bySandboxes.contractors).toEqual([{ role: oneOff, issues: [0] }]);
    expect(bySandboxes.held).toEqual(new Map([["sandboxes", 1]]));
    const byAgents = staff({
      issues,
      team,
      busy: new Set(),
      room: { agents: 0, sandboxes: 5 },
      fallback: coder,
    });
    expect(byAgents.contractors).toEqual([]);
    expect(byAgents.held).toEqual(new Map([["most_agents", 2]]));
    expect(byAgents.rerouted).toEqual(new Map([[0, coder]]));
  });

  it("never counts a Contractor in a one-off Role as one of a library Role's Agents", () => {
    const staffing = staff({
      issues: [{ dependsOn: [], role: coders }],
      team: [
        agent("writer", "contractor-1a2b3c4d5e", {
          contractor: { kind: "work", batchId: 1, oneOffRole: true },
        }),
      ],
      busy: new Set(),
      room: roomy,
      fallback: null,
    });
    expect(staffing.contractors).toEqual([{ role: coders, issues: [0] }]);
  });
});

describe("what the chat says of a limit", () => {
  it("names the limit that held Contractors back, and links to where it is raised", () => {
    expect(
      heldText(
        new Map([
          ["sandboxes", 2],
          ["most_agents", 1],
        ]),
        { id: "web-shop", mostAgents: 6, concurrencyLimit: 2 },
        3,
        "https://office.example/",
      ),
    ).toEqual([
      "The sandbox limit (2 at once, this Floor's) held back 2 more Contractors: more Agents than sandboxes would only wait. Raise it in Floor Settings: https://office.example/floor-settings/web-shop",
      'The Floor\'s "most Agents" (6) held back 1 more Contractor. Raise it in Floor Settings: https://office.example/floor-settings/web-shop',
    ]);
  });
});
