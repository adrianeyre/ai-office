import type { RecurringGoal } from "@ai-office/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecurringGoalsCard } from "./recurring-goals-card.tsx";

// A Floor's Recurring Goals in its admin (Scorecards PRD, FR-136, FR-141;
// ADR 0018), against a stubbed server: the Owner adds one, changes it,
// turns it off and on, runs one now and deletes one, and sees each one's
// last and next run, and one that turned itself off. The card is in the
// Floor admin, which is the Owner's alone.

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

const weeklyGaps: RecurringGoal = {
  id: 1,
  floorId: "web-shop",
  name: "Weekly test gaps",
  words: "Find modules without tests and file an issue for each.",
  schedule: { frequency: "weekly", days: [1], time: "09:00" },
  tokenCap: 200_000,
  enabled: true,
  failures: 0,
  createdAt: "2026-11-20T09:00:00.000Z",
  nextRunAt: "2026-11-30T09:00:00.000Z",
  lastRun: {
    id: 4,
    startedAt: "2026-11-23T09:00:00.000Z",
    finishedAt: "2026-11-23T09:03:00.000Z",
    outcome: "planned",
    reason: "",
    batchId: 7,
    issues: [21, 22],
    tokens: 48_000,
  },
};

interface Request {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly csrf: string | null;
}

function stubServer(goals: RecurringGoal[]) {
  let state = goals;
  const requests: Request[] = [];
  const list = () => ({ recurringGoals: state, timeZone: "Europe/London" });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      if (method !== "GET") {
        requests.push({
          method,
          url,
          body,
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
      const goalsUrl = "/api/floors/web-shop/recurring-goals";
      if (url === goalsUrl) {
        if (method === "POST") {
          state = [
            ...state,
            {
              ...weeklyGaps,
              ...(body as Partial<RecurringGoal>),
              id: state.length + 1,
              lastRun: null,
            },
          ];
          return Promise.resolve(Response.json(list(), { status: 201 }));
        }
        return Promise.resolve(Response.json(list()));
      }
      const one =
        /^\/api\/floors\/web-shop\/recurring-goals\/(\d+)(\/run)?$/.exec(url);
      if (one !== null) {
        const id = Number(one[1]);
        if (one[2] === "/run") {
          state = state.map((goal) =>
            goal.id === id
              ? {
                  ...goal,
                  lastRun: {
                    id: 9,
                    startedAt: "2026-11-27T10:00:00.000Z",
                    finishedAt: null,
                    outcome: "running",
                    reason: "",
                    batchId: null,
                    issues: [],
                    tokens: 0,
                  },
                }
              : goal,
          );
          return Promise.resolve(Response.json(list(), { status: 202 }));
        }
        if (method === "DELETE") {
          state = state.filter((goal) => goal.id !== id);
          return Promise.resolve(Response.json(list()));
        }
        if (method === "PATCH") {
          state = state.map((goal) =>
            goal.id === id
              ? {
                  ...goal,
                  ...(body as Partial<RecurringGoal>),
                  failures: body["enabled"] === true ? 0 : goal.failures,
                  nextRunAt: body["enabled"] === false ? null : goal.nextRunAt,
                }
              : goal,
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
      <RecurringGoalsCard floor={{ ...floor, archivedAt }} />
    </QueryClientProvider>,
  );

const item = async (name: string) =>
  within(
    await screen.findByRole("list", { name: "Recurring Goals" }),
  ).getByRole("listitem", { name });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Recurring Goals card", () => {
  it("lists each Recurring Goal: its words, when it comes round in the Office's time zone, its next run and its last, linking its Plan", async () => {
    stubServer([weeklyGaps]);
    renderCard();
    const goal = await item("Weekly test gaps");
    expect(within(goal).getByText("On")).toBeDefined();
    expect(
      within(goal).getByText(
        "Find modules without tests and file an issue for each.",
      ),
    ).toBeDefined();
    expect(
      within(goal).getByText("Mondays at 09:00 (Europe/London)"),
    ).toBeDefined();
    expect(goal.textContent).toContain("Mon 30 Nov, 09:00");
    expect(goal.textContent).toContain(
      "Mon 23 Nov, 09:00: filed #21, #22, and proposed a Plan.",
    );
    expect(
      within(goal).getByRole("link", { name: "Open its Plan" }),
    ).toHaveProperty(
      "href",
      expect.stringMatching(/\/floors\/web-shop\/whiteboard\?batch=7$/),
    );
    expect(goal.textContent).toContain("200,000 tokens a run");
  });

  it("adds one, weekly on chosen days, with its Token Cap, and refuses one with no day before sending it", async () => {
    const { requests } = stubServer([]);
    renderCard();
    expect(await screen.findByText("No Recurring Goals yet.")).toBeDefined();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Add a Recurring Goal" }),
    );
    const form = within(
      screen.getByRole("form", { name: "Add a Recurring Goal" }),
    );
    await user.type(form.getByLabelText("Name"), "Weekly test gaps");
    await user.type(
      form.getByLabelText("Goal"),
      "Find modules without tests and file an issue for each.",
    );
    // Monday is chosen at first: with none, it is refused.
    await user.click(form.getByLabelText("Monday"));
    await user.click(form.getByRole("button", { name: "Add Recurring Goal" }));
    expect((await form.findByRole("alert")).textContent).toContain(
      "Choose at least one day for a weekly Recurring Goal.",
    );
    expect(requests).toEqual([]);
    await user.click(form.getByLabelText("Monday"));
    await user.click(form.getByLabelText("Thursday"));
    await user.clear(form.getByLabelText("At"));
    await user.type(form.getByLabelText("At"), "08:30");
    await user.type(form.getByLabelText("Token Cap a run"), "150000");
    await user.click(form.getByRole("button", { name: "Add Recurring Goal" }));
    expect(await item("Weekly test gaps")).toBeDefined();
    expect(requests).toEqual([
      {
        method: "POST",
        url: "/api/floors/web-shop/recurring-goals",
        body: {
          name: "Weekly test gaps",
          words: "Find modules without tests and file an issue for each.",
          schedule: { frequency: "weekly", days: [1, 4], time: "08:30" },
          tokenCap: 150_000,
          enabled: true,
        },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("changes one to daily at the office's Token Cap, turns it off and on, runs it now and deletes it", async () => {
    const { requests } = stubServer([weeklyGaps]);
    renderCard();
    const user = userEvent.setup();
    await user.click(
      within(await item("Weekly test gaps")).getByRole("button", {
        name: "Edit Weekly test gaps",
      }),
    );
    const form = within(
      screen.getByRole("form", { name: "Edit Weekly test gaps" }),
    );
    await user.selectOptions(form.getByLabelText("Comes round"), "daily");
    await user.clear(form.getByLabelText("Token Cap a run"));
    await user.click(
      form.getByRole("button", { name: "Save Weekly test gaps" }),
    );
    let goal = await item("Weekly test gaps");
    await user.click(
      within(goal).getByRole("button", { name: "Turn off Weekly test gaps" }),
    );
    goal = await item("Weekly test gaps");
    expect(await within(goal).findByText("Off")).toBeDefined();
    expect(goal.textContent).toContain("None while it is off");
    await user.click(
      within(goal).getByRole("button", { name: "Run Weekly test gaps now" }),
    );
    expect(
      (await within(await item("Weekly test gaps")).findByRole("status"))
        .textContent,
    ).toContain("Weekly test gaps is running");
    await user.click(
      within(await item("Weekly test gaps")).getByRole("button", {
        name: "Delete Weekly test gaps",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Yes, delete Weekly test gaps" }),
    );
    expect(await screen.findByText("No Recurring Goals yet.")).toBeDefined();
    expect(
      requests.map(({ method, url, body }) => [method, url, body]),
    ).toEqual([
      [
        "PATCH",
        "/api/floors/web-shop/recurring-goals/1",
        {
          name: "Weekly test gaps",
          words: "Find modules without tests and file an issue for each.",
          schedule: { frequency: "daily", days: [], time: "09:00" },
          tokenCap: null,
        },
      ],
      ["PATCH", "/api/floors/web-shop/recurring-goals/1", { enabled: false }],
      ["POST", "/api/floors/web-shop/recurring-goals/1/run", {}],
      ["DELETE", "/api/floors/web-shop/recurring-goals/1", {}],
    ]);
  });

  it("says when one turned itself off after three failed runs, and why its last run failed", async () => {
    stubServer([
      {
        ...weeklyGaps,
        enabled: false,
        failures: 3,
        nextRunAt: null,
        lastRun: {
          id: 6,
          startedAt: "2026-11-23T09:00:00.000Z",
          finishedAt: "2026-11-23T09:01:00.000Z",
          outcome: "failed",
          reason: "it reached its per-run Token Cap of 200,000 tokens",
          batchId: null,
          issues: [],
          tokens: 201_000,
        },
      },
    ]);
    renderCard();
    const goal = await item("Weekly test gaps");
    expect(goal.textContent).toContain(
      "failed, as it reached its per-run Token Cap of 200,000 tokens.",
    );
    expect(within(goal).getByRole("status").textContent).toContain(
      "It turned itself off after 3 failed runs in a row",
    );
  });

  it("is read only on an archived Floor", async () => {
    stubServer([weeklyGaps]);
    renderCard("2026-11-01T00:00:00.000Z");
    const goal = await item("Weekly test gaps");
    expect(within(goal).queryByRole("button")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add a Recurring Goal" }),
    ).toBeNull();
  });
});
