import {
  builtInRole,
  randomAvatar,
  type BatchDetail,
  type GrillingSession,
  type Plan,
} from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { eventSources, type EventSourceLike } from "./event-stream.ts";
import { createAppRouter } from "./router.tsx";

// A Floor's whiteboard (PRD FR-25.3, FR-58), against a stubbed server: its
// Batches' Plans, current and past, each version browsable; the latest
// version of a Plan awaiting approval edited (moved, dropped, annotated),
// saved for the Manager to replan, then approved. Opened from a Notice's
// link, on the Batch it names. An issue's work Roles, which take turns on
// its branch (FR-25 (1)), reordered or removed before approving. The
// Kickoff's acknowledgements, concerns marked, and a finished Batch's
// Wrap-up (FR-25.2, FR-25.6). A running Grilling Session's live outline
// and settled decisions (FR-80).

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
  mergePolicy: "send_to_me",
  roundCap: 3,
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
  createdAt: "2026-10-08T12:00:00.000Z",
  archivedAt: null,
};

const agent = (id: string, name: string, role: string) => ({
  id,
  floorId: "web-shop",
  name,
  role,
  stage: builtInRole(role)?.stage ?? null,
  aiProvider: "Claude",
  model: "claude-opus-5-5",
  modelOverride: null,
  effort: null,
  extraInstructions: "",
  freshStartThreshold: null,
  enabled: true,
  status: "idle",
  avatar: randomAvatar(),
  tokenCaps: { daily: null, monthly: null },
  createdAt: "2026-10-08T12:00:00.000Z",
  leavingAt: null,
  contractor: null,
});

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 9, 10, minute)).toISOString();

const item = (
  issue: number,
  title: string,
  overrides: Partial<Plan["items"][number]> = {},
): Plan["items"][number] => ({
  issue,
  title,
  dependsOn: [],
  files: [],
  agentId: "ada",
  note: "",
  ...overrides,
});

const plan = (
  batchId: number,
  version: number,
  overrides: Partial<Plan> = {},
): Plan => ({
  batchId,
  version,
  draftedBy: "model",
  agentId: "grace",
  summary: "The basket first.",
  items: [],
  overlaps: [],
  parallel: [],
  leftOut: [],
  editedFrom: null,
  createdAt: at(version),
  ...overrides,
});

const firstPlan = plan(2, 1, {
  items: [
    item(1, "Add a basket", { files: ["src/basket.ts"], note: "First." }),
    item(2, "Show the total", { dependsOn: [1], agentId: "alan" }),
    item(3, "Tidy the footer"),
  ],
  parallel: [[1, 3], [2]],
});

/** The Floor's Batches, as the stub server keeps them. */
function initialBatches(): BatchDetail[] {
  const pastPlan = plan(1, 1, {
    summary: "An older Batch.",
    items: [item(7, "Old work")],
    parallel: [[7]],
  });
  const finishedPlan = plan(3, 1, {
    summary: "A finished Batch.",
    items: [item(8, "Add a search box"), item(9, "Show prices in euros")],
    parallel: [[8, 9]],
  });
  return [
    {
      batch: {
        id: 3,
        floorId: "web-shop",
        issues: [8, 9],
        status: "finished",
        onePullRequest: false,
        agentId: "grace",
        createdAt: at(0),
        startedAt: at(0),
        started: [8, 9],
        plan: finishedPlan,
        acknowledgements: [],
        finishedAt: at(50),
        wrapUp: {
          planVersion: 1,
          issues: [
            {
              issue: 8,
              title: "Add a search box",
              outcome: "merged",
              pullRequest: {
                number: 12,
                url: "https://github.com/adrianeyre/web-shop/pull/12",
              },
              agentId: "ada",
              rounds: { review: 2, qa: 1 },
              tokens: 120_500,
              estimatedCostUsd: 1.234,
            },
            {
              issue: 9,
              title: "Show prices in euros",
              outcome: "blocked",
              pullRequest: {
                number: 13,
                url: "https://github.com/adrianeyre/web-shop/pull/13",
              },
              agentId: "alan",
              rounds: { review: 3, qa: 0 },
              tokens: 90_000,
              estimatedCostUsd: 0.9,
            },
          ],
          leftOut: [],
          totals: {
            merged: 1,
            closed: 0,
            blocked: 1,
            notStarted: 0,
            tokens: 210_500,
            estimatedCostUsd: 2.134,
          },
        },
      },
      plans: [finishedPlan],
    },
    {
      batch: {
        id: 2,
        floorId: "web-shop",
        issues: [1, 2, 3],
        status: "awaiting_approval",
        onePullRequest: false,
        agentId: "grace",
        createdAt: at(1),
        startedAt: null,
        started: [],
        plan: firstPlan,
        acknowledgements: [
          {
            agentId: "ada",
            planVersion: 1,
            response: "ok",
            concern: null,
            by: "model",
            createdAt: at(1),
          },
          {
            agentId: "alan",
            planVersion: 1,
            response: "concern",
            concern: "#2 needs the basket's total from #1's API.",
            by: "model",
            createdAt: at(1),
          },
        ],
        finishedAt: null,
        wrapUp: null,
      },
      plans: [firstPlan],
    },
    {
      batch: {
        id: 1,
        floorId: "web-shop",
        issues: [7],
        status: "in_progress",
        onePullRequest: true,
        agentId: "grace",
        createdAt: at(0),
        startedAt: at(0),
        started: [7],
        plan: pastPlan,
        acknowledgements: [],
        finishedAt: null,
        wrapUp: null,
      },
      plans: [pastPlan],
    },
  ];
}

/** A store's work Role, as the Role library serves it. */
const storeRole = (id: string, name: string) => ({
  id,
  name,
  stage: "work",
  description: `${name}'s work.`,
  instructions: "",
  skills: [],
  deskDressing: "books",
  aiProvider: "Claude",
  model: null,
  inStartingTeam: false,
});

/** A store's Batch: "add the autumn range", the merchandiser then the copywriter. */
function storeBatches(): BatchDetail[] {
  const autumn = plan(2, 1, {
    summary: "The coats, then their copy.",
    items: [
      item(4, "Add the autumn range", {
        agentId: "mia",
        roles: ["merchandiser", "copywriter"],
      }),
      item(5, "Rewrite the About page", {
        agentId: "cole",
        roles: ["copywriter"],
      }),
    ],
    parallel: [[4, 5]],
  });
  return [
    {
      batch: {
        id: 2,
        floorId: "web-shop",
        issues: [4, 5],
        status: "awaiting_approval",
        onePullRequest: false,
        agentId: "grace",
        createdAt: at(1),
        startedAt: null,
        started: [],
        plan: autumn,
        acknowledgements: [],
        finishedAt: null,
        wrapUp: null,
      },
      plans: [autumn],
    },
  ];
}

let posted: { url: string; body: unknown; csrf: string | null }[];

function stubServer(initial: BatchDetail[] = initialBatches()) {
  let batches = initial;
  posted = [];
  const replace = (detail: BatchDetail) => {
    batches = batches.map((other) =>
      other.batch.id === detail.batch.id ? detail : other,
    );
    return detail;
  };
  const respond = (url: string, init?: RequestInit): Response => {
    if (init?.method === "POST") {
      const body = JSON.parse(
        typeof init.body === "string" ? init.body : "{}",
      ) as {
        version: number;
        items?: { issue: number; annotation: string; roles?: string[] }[];
      };
      posted.push({
        url,
        body,
        csrf: new Headers(init.headers).get("x-csrf-token"),
      });
      const detail = batches.find(({ batch }) => batch.id === 2);
      if (detail === undefined) {
        throw new Error("No Batch 2.");
      }
      if (url.endsWith("/plan") && body.items !== undefined) {
        // The Manager keeps the Owner's order and annotations.
        const kept = body.items;
        const next = plan(2, detail.batch.plan.version + 1, {
          summary: "Replanned in your order.",
          items: kept.map(({ issue, annotation, roles }) => ({
            ...(detail.batch.plan.items.find(
              (planned) => planned.issue === issue,
            ) ?? item(issue, "?")),
            dependsOn: [],
            ...(annotation === "" ? {} : { annotation }),
            // And the Owner's work Roles, in their order.
            ...(roles === undefined ? {} : { roles }),
          })),
          parallel: [kept.map(({ issue }) => issue)],
          leftOut: detail.batch.plan.items
            .filter(({ issue }) => !kept.some((one) => one.issue === issue))
            .map(({ issue }) => ({
              issue,
              reason: "you dropped it from the Plan",
            })),
          editedFrom: detail.batch.plan.version,
        });
        return Response.json(
          replace({
            batch: { ...detail.batch, plan: next },
            plans: [...detail.plans, next],
          }),
          { status: 201 },
        );
      }
      if (body.version !== detail.batch.plan.version) {
        return Response.json(
          {
            error: "plan_changed",
            message: "The Plan has changed: read it again first.",
          },
          { status: 409 },
        );
      }
      return Response.json(
        replace({
          ...detail,
          batch: {
            ...detail.batch,
            status: "in_progress",
            startedAt: at(30),
            started: detail.batch.plan.parallel[0] ?? [],
          },
        }),
      );
    }
    const one = /^\/api\/floors\/web-shop\/batches\/(\d+)$/.exec(url);
    if (one !== null) {
      const found = batches.find(({ batch }) => batch.id === Number(one[1]));
      return found === undefined
        ? Response.json({ error: "batch_not_found" }, { status: 404 })
        : Response.json(found);
    }
    if (url === "/api/floors/web-shop/batches") {
      return Response.json({ batches: batches.map(({ batch }) => batch) });
    }
    if (url === "/api/floors/web-shop/agents") {
      return Response.json({
        agents: [
          agent("grace", "Grace", "manager"),
          agent("ada", "Ada", "coder"),
          agent("alan", "Alan", "coder"),
          agent("mia", "Mia", "merchandiser"),
          agent("cole", "Cole", "copywriter"),
        ],
      });
    }
    if (url === "/api/floors/web-shop") {
      return Response.json(floor);
    }
    if (url === "/api/roles") {
      return Response.json({
        roles: [
          {
            ...storeRole("merchandiser", "Merchandiser"),
            agents: 1,
          },
          { ...storeRole("copywriter", "Copywriter"), agents: 1 },
        ],
      });
    }
    if (url === "/api/session") {
      return Response.json({
        csrfToken: "csrf-token-1",
        expiresAt: "2026-10-15T12:00:00.000Z",
      });
    }
    return Response.json({}, { status: 404 });
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) =>
      Promise.resolve(respond(url, init)),
    ),
  );
}

let streams: string[];
let router: ReturnType<typeof createAppRouter>;

function renderPage(path: string) {
  router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <App
      router={router}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
}

const planIssues = () =>
  within(screen.getByRole("list", { name: "The Plan's issues, in order" }))
    .getAllByRole("listitem")
    .map((entry) => entry.textContent);

/**
 * The Grilling Session's paper takes its colours from the theme, and
 * nothing on it sets a fixed palette colour without its own pair: a fixed
 * background with inherited text (or fixed text on the inherited
 * background) is what turned the questions, answers and decisions
 * invisible in dark mode. jsdom does not compute Tailwind's colours, so
 * this reads the classes the browser would apply.
 */
const expectThemeAware = (board: HTMLElement) => {
  expect(board.className).toContain("bg-tone-success");
  expect(board.className).toContain("text-tone-success-foreground");
  const palette =
    "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d+";
  const fixedBackground = new RegExp(
    `^bg-(?:white|black|${palette})(?:/\\d+)?$`,
  );
  const fixedText = new RegExp(`^text-(?:white|black|${palette})$`);
  for (const element of [board, ...board.querySelectorAll("*")]) {
    const classes = (element.getAttribute("class") ?? "").split(/\s+/);
    const background = classes.some((name) => fixedBackground.test(name));
    const text = classes.some((name) => fixedText.test(name));
    expect(
      background === text,
      `${element.tagName} "${element.textContent}": ${classes.join(" ")}`,
    ).toBe(true);
  }
};

describe("the whiteboard", () => {
  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
    streams = [];
    vi.spyOn(eventSources, "open").mockImplementation((url) => {
      streams.push(url);
      const source: EventSourceLike = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        close: () => undefined,
      };
      return source;
    });
    stubServer();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens on the Batch a Notice names; the Owner moves, drops and annotates its issues, saves them to be replanned, then approves", async () => {
    const user = userEvent.setup();
    renderPage("/floors/web-shop/whiteboard?batch=2");

    expect(
      await screen.findByRole("heading", {
        name: "Batch 2: Awaiting approval",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("Version 1, drafted, 9 Oct 2026, 10:01."),
    ).toBeTruthy();
    await waitFor(() => {
      expect(planIssues()[0]).toContain("Ada");
    });
    expect(planIssues().map((text) => text.slice(0, 15))).toEqual([
      "#1 Add a basket",
      "#2 Show the tot",
      "#3 Tidy the foo",
    ]);
    expect(planIssues()[1]).toContain("Alan, after #1");
    expect(screen.getByRole("link", { name: "#1" }).getAttribute("href")).toBe(
      "https://github.com/adrianeyre/web-shop/issues/1",
    );
    // Its events keep it live.
    expect(streams.some((url) => url.includes("batch.approved"))).toBe(true);

    // Moving #3 to the top, dropping #2 and writing a note on #1.
    const approve = screen.getByRole("button", { name: "Approve Plan" });
    expect(approve).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Move #1 up" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.click(screen.getByRole("button", { name: "Move #3 up" }));
    await user.click(screen.getByRole("button", { name: "Move #3 up" }));
    await user.click(screen.getByRole("button", { name: "Drop #2" }));
    expect(
      screen
        .getByRole("button", { name: "Keep #2" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await user.type(
      screen.getByLabelText("Your note on #1"),
      "  Keep it small.  ",
    );
    expect(planIssues().map((text) => text.slice(0, 3))).toEqual([
      "#3 ",
      "#1 ",
      "#2 ",
    ]);
    // Edits must be saved (or undone) before the Plan is approved.
    expect(approve).toHaveProperty("disabled", true);
    expect(
      screen.getByText("Save or undo your edits before approving."),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Save edits and replan" }),
    );
    expect(
      await screen.findByText(
        "Version 2, replanned after your edits to version 1, 9 Oct 2026, 10:02.",
      ),
    ).toBeTruthy();
    expect(posted).toEqual([
      {
        url: "/api/floors/web-shop/batches/2/plan",
        body: {
          version: 1,
          items: [
            { issue: 3, annotation: "" },
            { issue: 1, annotation: "Keep it small." },
          ],
        },
        csrf: "csrf-token-1",
      },
    ]);
    expect(planIssues().map((text) => text.slice(0, 3))).toEqual([
      "#3 ",
      "#1 ",
    ]);
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Your note on #1").value,
    ).toBe("Keep it small.");
    expect(
      screen.getByText("#2 is left out: you dropped it from the Plan."),
    ).toBeTruthy();
    expect(
      screen.getByText("Approving starts work on #3 and #1."),
    ).toBeTruthy();

    // Approving version 2: the work starts, and the Plan can only be read.
    await user.click(screen.getByRole("button", { name: "Approve Plan" }));
    expect(
      await screen.findByRole("heading", { name: "Batch 2: In progress" }),
    ).toBeTruthy();
    expect(posted.at(-1)).toEqual({
      url: "/api/floors/web-shop/batches/2/approve",
      body: { version: 2 },
      csrf: "csrf-token-1",
    });
    expect(screen.queryByRole("button", { name: "Approve Plan" })).toBeNull();
    expect(planIssues()).toEqual([
      expect.stringContaining("#3 Tidy the footer (started)"),
      expect.stringContaining("Your note: Keep it small."),
    ]);

    // Every version stays browsable.
    await user.selectOptions(screen.getByLabelText("Version"), "1");
    expect(
      screen.getByText("Version 1, drafted, 9 Oct 2026, 10:01."),
    ).toBeTruthy();
    expect(planIssues()).toHaveLength(3);
  });

  it("shows the Kickoff's acknowledgements, concerns marked, and a finished Batch's Wrap-up: each issue's outcome, pull request, rounds, tokens and cost", async () => {
    const user = userEvent.setup();
    renderPage("/floors/web-shop/whiteboard?batch=2");
    await screen.findByRole("heading", { name: "Batch 2: Awaiting approval" });
    // The Kickoff fills in live, with the rest of the Batch.
    expect(streams.some((url) => url.includes("batch.acknowledged"))).toBe(
      true,
    );
    expect(streams.some((url) => url.includes("batch.finished"))).toBe(true);
    expect(
      screen.getByRole("heading", { name: "Kickoff: 1 concern" }),
    ).toBeTruthy();
    const acknowledgements = within(
      screen.getByRole("list", { name: "Acknowledgements" }),
    ).getAllByRole("listitem");
    await waitFor(() => {
      expect(acknowledgements.map((entry) => entry.textContent)).toEqual([
        "Ada: OK",
        "Alan: #2 needs the basket's total from #1's API.",
      ]);
    });
    expect(
      acknowledgements.map((entry) => entry.getAttribute("data-response")),
    ).toEqual(["ok", "concern"]);
    expect(screen.queryByRole("region", { name: "Wrap-up" })).toBeNull();

    await user.click(
      within(
        screen.getByRole("navigation", { name: "Batches on this whiteboard" }),
      ).getByRole("button", { name: "Batch 3: Finished" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Batch 3: Finished" }),
    ).toBeTruthy();
    const wrapUp = screen.getByRole("region", { name: "Wrap-up" });
    expect(
      within(wrapUp).getByRole("heading", { name: "Wrap-up: 1 of 2 merged" }),
    ).toBeTruthy();
    expect(wrapUp.textContent).toContain(
      "Finished 9 Oct 2026, 10:50, on version 1 of the Plan. 210,500 tokens, about $2.13 (estimated).",
    );
    const cells = () =>
      within(wrapUp)
        .getAllByRole("row")
        .slice(1)
        .map((row) =>
          [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
        );
    await waitFor(() => {
      expect(cells()).toEqual([
        [
          "#8 Add a search boxAda",
          "Merged",
          "PR #12",
          "2 review, 1 QA",
          "120,500",
          "$1.23",
        ],
        [
          "#9 Show prices in eurosAlan",
          "Blocked",
          "PR #13",
          "3 review, 0 QA",
          "90,000",
          "$0.90",
        ],
      ]);
    });
    expect(
      within(wrapUp).getByRole("link", { name: "PR #13" }).getAttribute("href"),
    ).toBe("https://github.com/adrianeyre/web-shop/pull/13");
    expect(
      within(within(wrapUp).getByRole("list", { name: "Blocked" }))
        .getAllByRole("listitem")
        .map((entry) => entry.textContent),
    ).toEqual(["#9 is blocked: it waits for you at needs-human."]);
    expect(screen.queryByRole("region", { name: "Kickoff" })).toBeNull();
  });

  it("browses past Batches, read only, and says when a Plan changed under the Owner", async () => {
    const user = userEvent.setup();
    renderPage("/floors/web-shop/whiteboard");

    // It opens on the Batch awaiting approval.
    expect(
      await screen.findByRole("heading", {
        name: "Batch 2: Awaiting approval",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("One pull request")).toBeNull();
    const picker = screen.getByRole("navigation", {
      name: "Batches on this whiteboard",
    });
    await user.click(
      within(picker).getByRole("button", { name: "Batch 1: In progress" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Batch 1: In progress" }),
    ).toBeTruthy();
    expect(screen.getByText("An older Batch.")).toBeTruthy();
    // Handed over "in one PR": it says so, and names its branch.
    expect(
      screen.getByText("One pull request").parentElement?.textContent,
    ).toBe(
      "One pull request Its issues are worked one after another on one branch, ai-office/batch-1, and merge together once every one is ready to merge.",
    );
    expect(planIssues()).toEqual([
      expect.stringContaining("#7 Old work (started)"),
    ]);
    expect(screen.queryByRole("button", { name: /^Move/ })).toBeNull();
    expect(router.state.location.search).toEqual({ batch: 1 });

    // Back on Batch 2, approving a version that is no longer the latest
    // is refused, saying why.
    await user.click(
      within(picker).getByRole("button", {
        name: "Batch 2: Awaiting approval",
      }),
    );
    await screen.findByRole("heading", { name: "Batch 2: Awaiting approval" });
    // Someone else replanned meanwhile.
    await fetch("/api/floors/web-shop/batches/2/plan", {
      method: "POST",
      body: JSON.stringify({
        version: 1,
        items: [{ issue: 2, annotation: "" }],
      }),
    });
    await user.click(screen.getByRole("button", { name: "Approve Plan" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The Plan has changed: read it again first.",
    );
    // The whiteboard reads the Plan again: version 2.
    expect(
      await screen.findByText(
        "Version 2, replanned after your edits to version 1, 9 Oct 2026, 10:02.",
      ),
    ).toBeTruthy();
  });

  it("reorders an issue's work Roles, saved for the Manager to replan in that order before approving; the last Role cannot be removed", async () => {
    stubServer(storeBatches());
    const user = userEvent.setup();
    renderPage("/floors/web-shop/whiteboard?batch=2");
    await screen.findByRole("heading", { name: "Batch 2: Awaiting approval" });

    const rolesOn = (issue: string) =>
      within(
        screen.getByRole("list", { name: `Work Roles on ${issue}, in turn` }),
      )
        .getAllByRole("listitem")
        .map((entry) => entry.textContent);
    await waitFor(() => {
      expect(rolesOn("#4")).toEqual(["Merchandiser", "Copywriter"]);
    });
    // One Role is listed, with nothing to reorder.
    expect(
      screen.queryByRole("list", { name: "Work Roles on #5, in turn" }),
    ).toBeNull();
    expect(screen.getByText("Work Role: Copywriter")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Move the Copywriter up on #4" }),
    );
    expect(rolesOn("#4")).toEqual(["Copywriter", "Merchandiser"]);
    expect(screen.getByRole("button", { name: "Approve Plan" })).toHaveProperty(
      "disabled",
      true,
    );
    // Removing one leaves the other, which cannot be removed too.
    await user.click(
      screen.getByRole("button", { name: "Remove the Merchandiser on #4" }),
    );
    expect(
      screen.getByRole("button", { name: "Remove the Copywriter on #4" }),
    ).toHaveProperty("disabled", true);
    await user.click(
      screen.getByRole("button", { name: "Keep the Merchandiser on #4" }),
    );
    // Undone, the edits are none; the reorder again, then saved.
    await user.click(
      screen.getByRole("button", { name: "Move the Merchandiser up on #4" }),
    );
    expect(screen.getByRole("button", { name: "Approve Plan" })).toHaveProperty(
      "disabled",
      false,
    );
    await user.click(
      screen.getByRole("button", { name: "Move the Copywriter up on #4" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save edits and replan" }),
    );
    expect(
      await screen.findByText(
        "Version 2, replanned after your edits to version 1, 9 Oct 2026, 10:02.",
      ),
    ).toBeTruthy();
    expect(posted).toEqual([
      {
        url: "/api/floors/web-shop/batches/2/plan",
        body: {
          version: 1,
          items: [
            {
              issue: 4,
              annotation: "",
              roles: ["copywriter", "merchandiser"],
            },
            { issue: 5, annotation: "", roles: ["copywriter"] },
          ],
        },
        csrf: "csrf-token-1",
      },
    ]);
    expect(rolesOn("#4")).toEqual(["Copywriter", "Merchandiser"]);

    // Approved, the Plan reads its Roles in their new order.
    await user.click(screen.getByRole("button", { name: "Approve Plan" }));
    await screen.findByRole("heading", { name: "Batch 2: In progress" });
    expect(posted.at(-1)?.body).toEqual({ version: 2 });
    expect(
      screen.getByText("Work Roles, in turn: Copywriter, then Merchandiser"),
    ).toBeTruthy();
  });

  it("shows the running Grilling Session's live outline and the decisions settled so far, and follows its documents as they are written", async () => {
    const session = (
      overrides: Partial<GrillingSession> = {},
    ): GrillingSession => ({
      id: 3,
      floorId: "web-shop",
      topic: "CSV export",
      skill: "grilling",
      status: "active",
      round: 2,
      awaitingConfirmation: false,
      openQuestions: 1,
      decisionCount: 1,
      startedAt: at(0),
      updatedAt: at(5),
      pausedAt: null,
      endedAt: null,
      questions: [],
      decisions: [
        {
          number: 1,
          text: "An export holds orders only.",
          questions: [1],
          round: 1,
          settledAt: at(5),
        },
      ],
      terms: [],
      facts: [],
      outline: [
        { heading: "Problem", text: "Orders are copied by hand." },
        { heading: "Requirements", text: "A CSV of the shop's orders." },
      ],
      adrs: [],
      processes: [],
      documents: {
        branch: "ai-office/grilling-3",
        files: ["docs/product-requirements-document/csv-export.md"],
        commit: "0123456789abcdef0123456789abcdef01234567",
        writtenAt: at(5),
        pullRequest: null,
        problem: null,
      },
      issues: null,
      sources: [],
      ...overrides,
    });
    let current = session();
    // The Batches' server, with the Floor's Grilling Sessions too.
    const batchesServer = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (url === "/api/floors/web-shop/grilling-sessions") {
        return Promise.resolve(
          Response.json({
            sessions: [
              { ...current, questions: undefined },
              {
                ...session({ id: 2, topic: "Refunds", status: "ended" }),
                questions: undefined,
              },
            ],
          }),
        );
      }
      if (url === "/api/floors/web-shop/grilling-sessions/3") {
        return Promise.resolve(
          Response.json({ session: current, messages: [] }),
        );
      }
      return batchesServer(url, init);
    });
    const sources: { url: string; source: EventSourceLike }[] = [];
    vi.spyOn(eventSources, "open").mockImplementation((url) => {
      streams.push(url);
      const source: EventSourceLike = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        close: () => undefined,
      };
      sources.push({ url, source });
      return source;
    });
    renderPage("/floors/web-shop/whiteboard");

    const board = await screen.findByRole("region", {
      name: "Grilling Session on the whiteboard",
    });
    expectThemeAware(board);
    expect(
      within(board).getByRole("heading", {
        level: 2,
        name: "Grilling Session 3: CSV export",
      }),
    ).toBeTruthy();
    expect(
      within(board)
        .getAllByRole("heading", { level: 4 })
        .map(({ textContent }) => textContent),
    ).toEqual(["Problem", "Requirements"]);
    expect(within(board).getByText("A CSV of the shop's orders.")).toBeTruthy();
    expect(
      within(board)
        .getAllByRole("listitem")
        .map(({ textContent }) => textContent),
    ).toEqual(["An export holds orders only."]);
    expect(board.textContent).toContain(
      "Kept on ai-office/grilling-3: docs/product-requirements-document/csv-export.md.",
    );
    // The Plans are still there, below it.
    expect(
      await screen.findByRole("heading", {
        name: "Batch 2: Awaiting approval",
      }),
    ).toBeTruthy();

    // A turn settles a decision and rewrites a section: its documents'
    // event brings the whiteboard up to date.
    current = session({
      outline: [
        { heading: "Problem", text: "Orders are copied by hand, weekly." },
        { heading: "Requirements", text: "A CSV of the shop's orders." },
      ],
      decisions: [
        ...session().decisions,
        {
          number: 2,
          text: "Exports are built at once.",
          questions: [2],
          round: 2,
          settledAt: at(6),
        },
      ],
    });
    const stream = sources.find(({ url }) =>
      url.includes("grilling.documents_written"),
    );
    expect(stream).toBeDefined();
    stream?.source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          id: 41,
          occurredAt: at(6),
          event: {
            type: "grilling.documents_written",
            version: 1,
            floorId: "web-shop",
            agentId: "grace",
            sessionId: 3,
            branch: "ai-office/grilling-3",
            sha: "1123456789abcdef0123456789abcdef01234567",
            files: 1,
          },
        }),
      }),
    );
    await waitFor(() => {
      expect(
        within(board)
          .getAllByRole("listitem")
          .map(({ textContent }) => textContent),
      ).toEqual(["An export holds orders only.", "Exports are built at once."]);
    });
    expect(
      within(board).getByText("Orders are copied by hand, weekly."),
    ).toBeTruthy();
  });
  it("shows the running session's current round, each question with its status, and follows the session as it changes (FR-83)", async () => {
    const question = (
      number: number,
      round: number | null,
      status: "open" | "answered" | "withdrawn",
    ) => ({
      number,
      round,
      text: `Question ${String(number)}?`,
      recommended: "Yes.",
      dependsOn: [],
      status,
      answer: status === "answered" ? "Yes." : null,
      acceptedRecommended: status === "answered",
      answeredAt: status === "answered" ? at(5) : null,
    });
    let current: GrillingSession = {
      id: 3,
      floorId: "web-shop",
      topic: "CSV export",
      skill: "grilling",
      status: "active",
      round: 2,
      awaitingConfirmation: false,
      openQuestions: 1,
      decisionCount: 0,
      startedAt: at(0),
      updatedAt: at(5),
      pausedAt: null,
      endedAt: null,
      questions: [
        question(1, 1, "answered"),
        question(2, 2, "answered"),
        question(3, 2, "open"),
        question(4, 2, "withdrawn"),
        question(5, null, "open"),
      ],
      decisions: [],
      terms: [],
      facts: [],
      outline: [],
      adrs: [],
      processes: [],
      documents: null,
      issues: null,
      sources: [],
    };
    const batchesServer = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (url === "/api/floors/web-shop/grilling-sessions") {
        return Promise.resolve(
          Response.json({ sessions: [{ ...current, questions: undefined }] }),
        );
      }
      if (url === "/api/floors/web-shop/grilling-sessions/3") {
        return Promise.resolve(
          Response.json({ session: current, messages: [] }),
        );
      }
      return batchesServer(url, init);
    });
    const sources: { url: string; source: EventSourceLike }[] = [];
    vi.spyOn(eventSources, "open").mockImplementation((url) => {
      streams.push(url);
      const source: EventSourceLike = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onerror: null,
        close: () => undefined,
      };
      sources.push({ url, source });
      return source;
    });
    renderPage("/floors/web-shop/whiteboard");

    const board = await screen.findByRole("region", {
      name: "Grilling Session on the whiteboard",
    });
    const round = () => {
      const heading = within(board).getByRole("heading", {
        name: /questions$/,
      });
      return [
        heading.textContent,
        ...[...(heading.parentElement?.querySelectorAll("li") ?? [])].map(
          ({ textContent }) => textContent,
        ),
      ];
    };
    // Round 2's questions only: not round 1's, nor one still waiting.
    expect(round()).toEqual([
      "Round 2's questions",
      "2.Question 2? Answered",
      "3.Question 3? Open",
      "4.Question 4? Withdrawn",
    ]);
    expectThemeAware(board);

    // Round 3 is asked: the session's event brings the whiteboard up to date.
    current = {
      ...current,
      round: 3,
      questions: [...current.questions.slice(0, 4), question(5, 3, "open")].map(
        (each) => (each.number === 3 ? question(3, 2, "answered") : each),
      ),
    };
    const stream = sources.find(({ url }) =>
      url.includes("grilling.session_changed"),
    );
    expect(stream).toBeDefined();
    stream?.source.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          id: 42,
          occurredAt: at(6),
          event: {
            type: "grilling.session_changed",
            version: 1,
            floorId: "web-shop",
            agentId: "grace",
            sessionId: 3,
            change: "round",
            status: "active",
            round: 3,
            openQuestions: 1,
            decisions: 2,
          },
        }),
      }),
    );
    await waitFor(() => {
      expect(round()).toEqual(["Round 3's questions", "5.Question 5? Open"]);
    });
  });
});
