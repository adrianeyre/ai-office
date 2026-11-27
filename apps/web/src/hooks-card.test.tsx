import {
  builtInRoles,
  randomAvatar,
  type LibraryRole,
  type Hook,
  type HookList,
  type HookRun,
} from "@ai-office/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HooksCard } from "./hooks-card.tsx";

// A Floor's Hooks in its admin (Guidelines, Specs and Hooks PRD, FR-118 to
// FR-121; ADR 0016), against a stubbed server: the Owner adds a Hook, edits
// it, turns it off and on, runs one now and deletes one, and sees each
// one's latest runs and a Hook that turned itself off.

const floor = {
  id: "web-shop",
  name: "Web shop",
  repository: "adrianeyre/web-shop",
  githubRepositoryId: 1,
  template: { id: "development", name: "Development" },
  theme: "office" as const,
  defaultBranch: "main",
  setupCommand: "",
  testCommand: "",
  mergePolicy: "send_to_me" as const,
  roundCap: 3,
  ownerOnlyPaths: [],
  changedLinesLimit: null,
  tokenCaps: { daily: null, monthly: null },
  concurrencyLimit: null,
  priority: 0,
  requiredReviewerAgentIds: [],
  planApproval: true,
  mostAgents: 8,
  spinOffFromChat: true,
  hourlyStatusUpdates: true,
  freshStartThreshold: 85,
  gitIdentity: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
};

const agent = (id: string, name: string, role: string) => ({
  id,
  floorId: "web-shop",
  name,
  role,
  stage: role === "manager" ? null : role === "reviewer" ? "review" : "work",
  aiProvider: "Claude",
  model: "claude-opus-5-5",
  modelOverride: null,
  effort: null,
  extraInstructions: "",
  enabled: true,
  avatar: randomAvatar(() => 0.5, []),
  tokenCaps: { daily: null, monthly: null },
  freshStartThreshold: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  leavingAt: null,
  contractor: null,
});

const agents = [
  agent("grace", "Grace", "manager"),
  agent("ada", "Ada", "coder"),
  agent("linus", "Linus", "reviewer"),
];

/** The built-in Roles, as `GET /api/roles` lists them. */
const roles: LibraryRole[] = builtInRoles.map((role) => ({
  ...role,
  skills: [...role.skills],
  agents: 1,
  inStartingTeam: true,
}));

const run = (fields: Partial<HookRun>): HookRun => ({
  id: 1,
  agentId: "linus",
  agentName: "Linus",
  trigger: "pull_request_opened",
  issue: 4,
  pullRequest: 14,
  status: "succeeded",
  startedAt: "2026-11-24T10:00:00.000Z",
  finishedAt: "2026-11-24T10:00:05.000Z",
  error: null,
  result: "Both migrations can be rolled back.",
  commentUrl: "https://github.com/adrianeyre/web-shop/pull/14#issuecomment-1",
  ...fields,
});

const migrationCheck: Hook = {
  id: 1,
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
  createdAt: "2026-11-24T09:00:00.000Z",
  updatedAt: "2026-11-24T09:00:00.000Z",
  runs: [run({})],
};

const skills: HookList["skills"] = [
  {
    name: "migration-check",
    description: "Checks migrations.",
    source: "office",
  },
  { name: "release-notes", description: "Writes notes.", source: "office" },
];

interface Request {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly csrf: string | null;
}

function stubServer(
  hooks: Hook[],
  answers: { readonly create?: () => Response } = {},
) {
  let state: Hook[] = hooks;
  const requests: Request[] = [];
  const list = (): HookList => ({ hooks: state, skills, skillsError: null });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        requests.push({
          method,
          url,
          body:
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as unknown)
              : undefined,
          csrf: new Headers(init?.headers).get("x-csrf-token"),
        });
      }
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({
            csrfToken: "csrf-token-1",
            expiresAt: "2026-12-15T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/floors/web-shop/agents") {
        return Promise.resolve(Response.json({ agents }));
      }
      if (url === "/api/roles") {
        return Promise.resolve(Response.json({ roles }));
      }
      if (url === "/api/floors/web-shop/hooks") {
        if (method === "POST") {
          const given = answers.create?.();
          if (given !== undefined) {
            return Promise.resolve(given);
          }
          const body = requests.at(-1)?.body as Partial<Hook>;
          state = [
            ...state,
            {
              ...migrationCheck,
              ...body,
              id: state.length + 1,
              failures: 0,
              runs: [],
            },
          ];
          return Promise.resolve(Response.json(list(), { status: 201 }));
        }
        return Promise.resolve(Response.json(list()));
      }
      const one = /^\/api\/floors\/web-shop\/hooks\/(\d+)(\/run)?$/.exec(url);
      if (one !== null) {
        const id = Number(one[1]);
        if (one[2] === "/run") {
          const started = run({
            id: 9,
            trigger: "run_now",
            issue: null,
            pullRequest: null,
            status: "running",
            finishedAt: null,
            result: null,
            commentUrl: null,
            agentId: "ada",
            agentName: "Ada",
          });
          state = state.map((hook) =>
            hook.id === id ? { ...hook, runs: [started, ...hook.runs] } : hook,
          );
          return Promise.resolve(
            Response.json({ run: started, hooks: list() }, { status: 202 }),
          );
        }
        if (method === "DELETE") {
          state = state.filter((hook) => hook.id !== id);
          return Promise.resolve(Response.json(list()));
        }
        if (method === "PUT") {
          const body = requests.at(-1)?.body as Partial<Hook>;
          state = state.map((hook) =>
            hook.id === id ? { ...hook, ...body, failures: 0 } : hook,
          );
          return Promise.resolve(Response.json(list()));
        }
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  return { requests };
}

const renderCard = (archivedAt: string | null = null) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HooksCard floor={{ ...floor, archivedAt }} />
    </QueryClientProvider>,
  );

const item = async (name: string) =>
  within(await screen.findByRole("list", { name: "Hooks" })).getByRole(
    "listitem",
    { name },
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Hooks card", () => {
  it("lists each Hook: when it runs, who runs which Skill, its limit and its latest runs", async () => {
    stubServer([migrationCheck]);
    renderCard();
    const hook = await item("Migration check");
    expect(within(hook).getByText("On")).toBeDefined();
    expect(
      within(hook).getByText("A pull request is opened, touching **/*.sql"),
    ).toBeDefined();
    expect(
      await within(hook).findByText("Any reviewer runs /migration-check"),
    ).toBeDefined();
    expect(within(hook).getByText("At most 12 runs an hour")).toBeDefined();
    const runs = within(hook).getByRole("list", {
      name: "Latest runs of Migration check",
    });
    expect(within(runs).getByText("Succeeded")).toBeDefined();
    expect(runs.textContent).toContain("Linus on PR #14");
    expect(
      within(runs).getByRole("link", { name: "Answer on GitHub" }),
    ).toHaveProperty(
      "href",
      "https://github.com/adrianeyre/web-shop/pull/14#issuecomment-1",
    );
    expect(runs.textContent).toContain("Both migrations can be rolled back.");
    // Not a Run now Hook: no Run now.
    expect(
      within(hook).queryByRole("button", { name: "Run Migration check now" }),
    ).toBeNull();
  });

  it("says so when there are none", async () => {
    stubServer([]);
    renderCard();
    expect(await screen.findByText(/No Hooks yet/)).toBeDefined();
  });

  it("creates a Hook: its trigger, the filters that trigger takes, who runs it and its Skill", async () => {
    const user = userEvent.setup();
    const { requests } = stubServer([]);
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Add a Hook" }));
    const form = screen.getByRole("form", { name: "New Hook" });
    await user.type(within(form).getByLabelText("Name"), "Schema watch");
    await user.selectOptions(
      within(form).getByLabelText("When"),
      "An issue moves to a Stage",
    );
    await user.selectOptions(within(form).getByLabelText("Stage"), "needs-qa");
    await user.type(
      within(form).getByLabelText("Only for issues labelled"),
      "database",
    );
    await user.type(
      within(form).getByLabelText("Only when a changed file matches"),
      "db/**",
    );
    await user.click(within(form).getByLabelText("The Agent"));
    // The Manager does not run Hooks: it is not offered.
    expect(
      within(within(form).getByLabelText("Agent")).queryByRole("option", {
        name: "Grace",
      }),
    ).toBeNull();
    await user.selectOptions(within(form).getByLabelText("Agent"), "Ada");
    await user.selectOptions(
      within(form).getByLabelText("Skill it runs"),
      "/migration-check",
    );
    const runs = within(form).getByLabelText("At most this many runs an hour");
    await user.clear(runs);
    await user.type(runs, "4");
    await user.click(within(form).getByRole("button", { name: "Add Hook" }));

    expect(requests).toEqual([
      {
        method: "POST",
        url: "/api/floors/web-shop/hooks",
        body: {
          name: "Schema watch",
          trigger: "stage",
          stage: "needs-qa",
          labels: ["database"],
          filePatterns: ["db/**"],
          agentId: "ada",
          role: null,
          skillName: "migration-check",
          runsPerHour: 4,
          enabled: true,
        },
        csrf: "csrf-token-1",
      },
    ]);
    expect(await item("Schema watch")).toBeDefined();
    expect(screen.queryByRole("form", { name: "New Hook" })).toBeNull();
  });

  it("offers only the filters a trigger takes, and shows what the server refused", async () => {
    const user = userEvent.setup();
    stubServer([], {
      create: () =>
        Response.json(
          {
            error: "invalid_request",
            problems: [
              "A Hook on a push names the files it watches, such as **/*.sql.",
            ],
          },
          { status: 400 },
        ),
    });
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Add a Hook" }));
    const form = screen.getByRole("form", { name: "New Hook" });
    await user.selectOptions(
      within(form).getByLabelText("When"),
      "A push to the default branch touches matching files",
    );
    expect(
      within(form).queryByLabelText("Only for issues labelled"),
    ).toBeNull();
    expect(within(form).getByLabelText("Files it watches")).toBeDefined();
    await user.selectOptions(within(form).getByLabelText("When"), "Run now");
    expect(within(form).queryByLabelText("Files it watches")).toBeNull();
    await user.selectOptions(
      within(form).getByLabelText("When"),
      "A push to the default branch touches matching files",
    );
    await user.click(within(form).getByRole("button", { name: "Add Hook" }));
    expect((await within(form).findByRole("alert")).textContent).toContain(
      "A Hook on a push names the files it watches",
    );
  });

  it("edits a Hook, sending the whole of it", async () => {
    const user = userEvent.setup();
    const { requests } = stubServer([migrationCheck]);
    renderCard();
    await user.click(
      within(await item("Migration check")).getByRole("button", {
        name: "Edit Migration check",
      }),
    );
    const form = screen.getByRole("form", { name: "Edit Migration check" });
    const runs = within(form).getByLabelText("At most this many runs an hour");
    await user.clear(runs);
    await user.type(runs, "3");
    const files = within(form).getByLabelText(
      "Only when a changed file matches",
    );
    await user.type(files, "{Enter}migrations/**");
    await user.click(within(form).getByRole("button", { name: "Save Hook" }));
    expect(requests).toEqual([
      {
        method: "PUT",
        url: "/api/floors/web-shop/hooks/1",
        body: {
          name: "Migration check",
          trigger: "pull_request_opened",
          stage: null,
          labels: [],
          filePatterns: ["**/*.sql", "migrations/**"],
          agentId: null,
          role: "reviewer",
          skillName: "migration-check",
          runsPerHour: 3,
          enabled: true,
        },
        csrf: "csrf-token-1",
      },
    ]);
    expect(
      await within(await item("Migration check")).findByText(
        "At most 3 runs an hour",
      ),
    ).toBeDefined();
  });

  it("turns a Hook off and on again", async () => {
    const user = userEvent.setup();
    const { requests } = stubServer([migrationCheck]);
    renderCard();
    await user.click(
      within(await item("Migration check")).getByRole("button", {
        name: "Turn off Migration check",
      }),
    );
    expect(requests.at(-1)).toMatchObject({
      method: "PUT",
      url: "/api/floors/web-shop/hooks/1",
      body: { enabled: false, name: "Migration check", role: "reviewer" },
    });
    expect(
      await within(await item("Migration check")).findByText("Off"),
    ).toBeDefined();
    await user.click(
      within(await item("Migration check")).getByRole("button", {
        name: "Turn on Migration check",
      }),
    );
    expect(requests.at(-1)).toMatchObject({ body: { enabled: true } });
  });

  it("deletes a Hook once the Owner says yes", async () => {
    const user = userEvent.setup();
    const { requests } = stubServer([migrationCheck]);
    renderCard();
    await user.click(
      within(await item("Migration check")).getByRole("button", {
        name: "Delete Migration check",
      }),
    );
    expect(requests).toEqual([]);
    await user.click(
      screen.getByRole("button", { name: "Yes, delete Migration check" }),
    );
    expect(requests).toEqual([
      {
        method: "DELETE",
        url: "/api/floors/web-shop/hooks/1",
        body: undefined,
        csrf: "csrf-token-1",
      },
    ]);
    expect(await screen.findByText(/No Hooks yet/)).toBeDefined();
  });

  it("runs a Run now Hook now, and shows its run", async () => {
    const user = userEvent.setup();
    const { requests } = stubServer([
      {
        ...migrationCheck,
        id: 2,
        name: "Weekly tidy",
        trigger: "run_now",
        filePatterns: [],
        agentId: "ada",
        role: null,
        runs: [],
      },
    ]);
    renderCard();
    const hook = await item("Weekly tidy");
    expect(within(hook).getByText("It has not run yet.")).toBeDefined();
    expect(
      await within(hook).findByText("Ada runs /migration-check"),
    ).toBeDefined();
    await user.click(
      within(hook).getByRole("button", { name: "Run Weekly tidy now" }),
    );
    expect(requests).toEqual([
      {
        method: "POST",
        url: "/api/floors/web-shop/hooks/2/run",
        body: {},
        csrf: "csrf-token-1",
      },
    ]);
    const after = await item("Weekly tidy");
    expect(
      await within(after).findByText(
        "Weekly tidy is running: its run shows below.",
      ),
    ).toBeDefined();
    expect(within(after).getByText("Running")).toBeDefined();
  });

  it("says a Hook turned itself off after three failed runs, and why each failed", async () => {
    stubServer([
      {
        ...migrationCheck,
        enabled: false,
        failures: 3,
        runs: [
          run({
            status: "failed",
            result: null,
            commentUrl: null,
            error:
              "The AI Gateway did not answer Linus's call: the daily Token Cap is reached.",
          }),
        ],
      },
    ]);
    renderCard();
    const hook = await item("Migration check");
    expect(within(hook).getByText("Off")).toBeDefined();
    expect(within(hook).getByRole("status").textContent).toContain(
      "It turned itself off after 3 failed runs in a row",
    );
    expect(within(hook).getByText("Failed")).toBeDefined();
    expect(hook.textContent).toContain("the daily Token Cap is reached");
  });

  it("changes nothing on an archived Floor", async () => {
    stubServer([migrationCheck]);
    renderCard("2026-11-01T00:00:00.000Z");
    const hook = await item("Migration check");
    expect(within(hook).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a Hook" })).toBeNull();
  });
});
