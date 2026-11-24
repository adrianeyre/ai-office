import type {
  FloorGuideline,
  FloorGuidelineList,
  GuidelineProposal,
} from "@ai-office/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GuidelinesCard } from "./guidelines-card.tsx";

// A Floor's Guidelines in its admin (Guidelines, Specs and Hooks PRD,
// FR-103, FR-111; ADR 0014), against a stubbed server, in each of its
// states: none, approved, awaiting approval (with its difference from the
// approved version, Approve and Dismiss) and invalid.

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

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

const techApproved = {
  contentHash: hashA,
  approval: "owner_push" as const,
  content: "Use pnpm.\n",
  current: true,
};

const migrationsApproved = {
  contentHash: hashA,
  approval: "owner_merge" as const,
  content: "One migration per change.\nKeep them small.\n",
  current: false,
};

const migrationsAwaiting = {
  contentHash: hashB,
  status: "awaiting" as const,
  content: "One migration per change.\nNever edit a merged one.\n",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
};

const tech: FloorGuideline = {
  name: "tech",
  path: ".agents/guidelines/tech.md",
  inclusion: "always",
  fileMatchPatterns: [],
  description: "The stack",
  approved: techApproved,
  awaiting: null,
  error: null,
};

const migrations: FloorGuideline = {
  name: "migrations",
  path: ".agents/guidelines/migrations.md",
  inclusion: "fileMatch",
  fileMatchPatterns: ["packages/db/**"],
  description: "How migrations are written",
  approved: migrationsApproved,
  awaiting: migrationsAwaiting,
  error: null,
};

const deploy: FloorGuideline = {
  name: "deploy",
  path: ".agents/guidelines/deploy.md",
  inclusion: null,
  fileMatchPatterns: [],
  description: null,
  approved: null,
  awaiting: null,
  error: {
    refusal: "holds_secret",
    reason:
      "Line 3 looks like it holds a credential, which a Guideline never does: take it out.",
    secretLines: [3],
  },
};

const listOf = (guidelines: FloorGuideline[]): FloorGuidelineList => ({
  guidelines,
  awaitingCount: guidelines.filter(
    ({ awaiting }) => awaiting?.status === "awaiting",
  ).length,
});

function stubServer(
  guidelines: FloorGuideline[],
  answers: {
    readonly approve?: () => Response;
    readonly dismiss?: () => Response;
    readonly open?: () => Response;
    readonly reject?: () => Response;
  } = {},
  proposals: GuidelineProposal[] = [],
) {
  let state = listOf(guidelines);
  let waiting = proposals;
  const posts: { url: string; body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/floors/web-shop/guidelines") {
        return Promise.resolve(Response.json(state));
      }
      if (url === "/api/floors/web-shop/guideline-proposals") {
        return Promise.resolve(Response.json({ proposals: waiting }));
      }
      const settled =
        /^\/api\/floors\/web-shop\/guideline-proposals\/(\d+)\/(open|reject)$/.exec(
          url,
        );
      if (settled !== null && init?.method === "POST") {
        posts.push({
          url,
          body: JSON.parse(init.body as string) as unknown,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        const answer = settled[2] === "open" ? answers.open : answers.reject;
        const given = answer?.();
        if (given !== undefined) {
          return Promise.resolve(given);
        }
        waiting = waiting.filter(({ id }) => String(id) !== settled[1]);
        return Promise.resolve(
          Response.json(
            settled[2] === "open"
              ? {
                  pullRequest: {
                    number: 12,
                    url: "https://github.com/adrianeyre/web-shop/pull/12",
                  },
                  proposals: waiting,
                }
              : { proposals: waiting },
          ),
        );
      }
      const action =
        /^\/api\/floors\/web-shop\/guidelines\/([^/]+)\/(approve|dismiss)$/.exec(
          url,
        );
      if (action !== null && init?.method === "POST") {
        posts.push({
          url,
          body: JSON.parse(init.body as string) as unknown,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        const answer =
          action[2] === "approve" ? answers.approve : answers.dismiss;
        return Promise.resolve(answer?.() ?? Response.json(state));
      }
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({
            csrfToken: "csrf-token-1",
            expiresAt: "2026-10-15T12:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  return {
    posts,
    set(next: FloorGuideline[]) {
      state = listOf(next);
    },
  };
}

const renderCard = (archivedAt: string | null = null) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <GuidelinesCard floor={{ ...floor, archivedAt }} />
    </QueryClientProvider>,
  );

const item = async (name: string) =>
  within(await screen.findByRole("list", { name: "Guidelines" })).getByRole(
    "listitem",
    { name },
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("a Floor's Guidelines in its admin", () => {
  it("says when the Floor has none", async () => {
    stubServer([]);
    renderCard();
    expect(
      (await screen.findByText(/This Floor has no Guidelines/)).textContent,
    ).toBe(
      "This Floor has no Guidelines. Add Markdown files to .agents/guidelines/ on main to give its Agents rules.",
    );
    expect(screen.queryByRole("list", { name: "Guidelines" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("lists an approved Guideline with its inclusion, description and the version Agents get", async () => {
    stubServer([
      tech,
      {
        ...migrations,
        awaiting: null,
        approved: { ...migrationsApproved, current: true },
      },
    ]);
    renderCard();
    const approved = await item("tech");
    expect(within(approved).getByText("Always")).toBeDefined();
    expect(approved.textContent).toContain("The stack");
    expect(approved.textContent).toContain(
      ".agents/guidelines/tech.md on main",
    );
    expect(approved.textContent).toContain(
      "Agents get version aaaaaaa, pushed by you.",
    );
    expect(within(approved).queryByRole("button")).toBeNull();
    const fileMatch = await item("migrations");
    expect(within(fileMatch).getByText("File match")).toBeDefined();
    expect(within(fileMatch).getByText("packages/db/**")).toBeDefined();
    expect(fileMatch.textContent).toContain(
      "Agents get version aaaaaaa, in a pull request you merged.",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a version awaiting approval as its difference from the approved one, and approves exactly it", async () => {
    const server = stubServer([tech, migrations]);
    renderCard();
    expect((await screen.findByRole("status")).textContent).toBe(
      "1 Guideline awaits your approval.",
    );
    const awaiting = await item("migrations");
    expect(within(awaiting).getByText("Awaiting approval")).toBeDefined();
    expect(awaiting.textContent).toContain(
      "Agents get version aaaaaaa, in a pull request you merged, until you approve the one on the default branch.",
    );
    expect(awaiting.textContent).toContain(
      "A change awaits your approval (commit 0123456):",
    );
    const changes = within(awaiting).getByLabelText("Changes to migrations");
    expect(
      [...changes.children].map((line) => [line.tagName, line.textContent]),
    ).toEqual([
      ["SPAN", "  One migration per change."],
      ["DEL", "- Keep them small."],
      ["INS", "+ Never edit a merged one."],
    ]);

    server.set([
      tech,
      {
        ...migrations,
        approved: {
          contentHash: hashB,
          approval: "owner_admin",
          content: migrationsAwaiting.content,
          current: true,
        },
        awaiting: null,
      },
    ]);
    await userEvent.click(
      within(awaiting).getByRole("button", { name: "Approve migrations" }),
    );
    expect(server.posts).toEqual([
      {
        url: "/api/floors/web-shop/guidelines/migrations/approve",
        body: { contentHash: hashB },
        csrf: "csrf-token-1",
      },
    ]);
    await vi.waitFor(async () => {
      expect((await item("migrations")).textContent).toContain(
        "Agents get version bbbbbbb, approved by you here.",
      );
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: /migrations/ })).toBeNull();
  });

  it("shows a new Guideline awaiting approval whole, and dismisses it", async () => {
    const fresh: FloorGuideline = {
      ...migrations,
      approved: null,
      awaiting: { ...migrationsAwaiting, commitSha: null },
    };
    const server = stubServer([fresh]);
    renderCard();
    const awaiting = await item("migrations");
    expect(awaiting.textContent).toContain(
      "No version approved: Agents get nothing from it.",
    );
    expect(awaiting.textContent).toContain(
      "A new Guideline awaits your approval:",
    );
    expect(
      [
        ...within(awaiting).getByLabelText("Changes to migrations").children,
      ].map((line) => line.textContent),
    ).toEqual(["+ One migration per change.", "+ Never edit a merged one."]);

    server.set([
      {
        ...fresh,
        awaiting: {
          ...migrationsAwaiting,
          commitSha: null,
          status: "dismissed",
        },
      },
    ]);
    await userEvent.click(
      within(awaiting).getByRole("button", { name: "Dismiss migrations" }),
    );
    expect(server.posts.map(({ url, body }) => [url, body])).toEqual([
      [
        "/api/floors/web-shop/guidelines/migrations/dismiss",
        { contentHash: hashB },
      ],
    ]);
    await vi.waitFor(async () => {
      expect((await item("migrations")).textContent).toContain(
        "You dismissed this version: Agents get nothing from it.",
      );
    });
    // It can still be approved; it is no longer counted as waiting.
    expect(
      screen.getByRole("button", { name: "Approve migrations" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Dismiss migrations" }),
    ).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says why a version that changed meanwhile was refused, and shows it as it is now", async () => {
    const changedAgain: FloorGuideline = {
      ...migrations,
      awaiting: {
        ...migrationsAwaiting,
        contentHash: "c".repeat(64),
        content: "One migration per change.\nAsk first.\n",
      },
    };
    const server = stubServer([migrations], {
      approve: () => {
        server.set([changedAgain]);
        return Response.json(
          {
            error: "guideline_changed",
            message:
              'Guideline "migrations" on Web shop has changed since: look at its version now.',
          },
          { status: 409 },
        );
      },
    });
    renderCard();
    await userEvent.click(
      within(await item("migrations")).getByRole("button", {
        name: "Approve migrations",
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      'Guideline "migrations" on Web shop has changed since: look at its version now.',
    );
    await vi.waitFor(async () => {
      expect(
        within(await item("migrations")).getByLabelText("Changes to migrations")
          .textContent,
      ).toContain("+ Ask first.");
    });
  });

  it("names why an invalid Guideline reaches no Agent, never what a line holds", async () => {
    stubServer([
      deploy,
      {
        ...tech,
        approved: { ...techApproved, current: false },
        error: {
          refusal: "invalid",
          reason: "inclusion is always, fileMatch or manual.",
          secretLines: [],
        },
      },
    ]);
    renderCard();
    const invalid = await item("deploy");
    expect(within(invalid).getByText("Invalid")).toBeDefined();
    expect(invalid.textContent).toContain(
      "It breaks the rules, so this version reaches no Agent: Line 3 looks like it holds a credential, which a Guideline never does: take it out.",
    );
    expect(invalid.textContent).toContain(
      "No version approved: Agents get nothing from it.",
    );
    expect(within(invalid).queryByRole("button")).toBeNull();
    // Agents keep the version approved before it broke.
    expect((await item("tech")).textContent).toContain(
      "Agents get version aaaaaaa, pushed by you, until you approve the one on the default branch.",
    );
  });

  it("changes nothing on an archived Floor", async () => {
    stubServer([migrations]);
    renderCard("2026-10-05T00:00:00.000Z");
    const awaiting = await item("migrations");
    for (const button of within(awaiting).getAllByRole<HTMLButtonElement>(
      "button",
    )) {
      expect(button.disabled).toBe(true);
    }
  });

  it("is the card the Notice links to, by #guidelines", async () => {
    stubServer([migrations]);
    window.history.replaceState(
      null,
      "",
      "/floor-settings/web-shop#guidelines",
    );
    const scrolled = vi.fn();
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(scrolled);
    renderCard();
    const card = (
      await screen.findByRole("heading", { name: "Guidelines" })
    ).closest("#guidelines");
    expect(card).not.toBeNull();
    expect(scrolled).toHaveBeenCalled();
    scrollIntoView.mockRestore();
  });
});

const proposal = (
  id: number,
  name: string,
  content: string,
  agentName: string | null = "Ada",
): GuidelineProposal => ({
  id,
  name,
  path: `.agents/guidelines/${name}.md`,
  content,
  contentHash: "e".repeat(64),
  agentId: "ada",
  agentName,
  issue: 4,
  proposedAt: "2026-11-24T10:00:00.000Z",
});

const proposedItem = async (name: string) =>
  within(
    await screen.findByRole("list", { name: "Proposed Guidelines" }),
  ).getByRole("listitem", { name });

describe("the Guidelines Agents proposed, in the Floor's admin", () => {
  it("shows none while none wait", async () => {
    stubServer([tech]);
    renderCard();
    await item("tech");
    expect(
      screen.queryByRole("list", { name: "Proposed Guidelines" }),
    ).toBeNull();
    expect(screen.queryByText("Proposed by Agents")).toBeNull();
  });

  it("shows a change as its difference from the version Agents get, and a new one whole, each by its Agent and issue", async () => {
    stubServer([tech], {}, [
      proposal(1, "tech", "Use pnpm.\nNo default exports.\n"),
      proposal(2, "accessibility", "Every image has alt text.\n", null),
    ]);
    renderCard();
    const change = await proposedItem("tech, proposed on #4");
    expect(within(change).getByText("Change")).toBeDefined();
    expect(change.textContent).toContain(
      "Proposed by Ada on #4, for .agents/guidelines/tech.md, against the version Agents get:",
    );
    const lines = within(change).getByLabelText("Proposed tech");
    expect(lines.querySelector("ins")?.textContent).toBe(
      "+ No default exports.",
    );
    expect(lines.querySelector("del")).toBeNull();

    const added = await proposedItem("accessibility, proposed on #4");
    expect(within(added).getByText("New Guideline")).toBeDefined();
    expect(added.textContent).toContain(
      "Proposed by an Agent no longer on this Floor on #4, for .agents/guidelines/accessibility.md.",
    );
    expect(
      within(added).getByLabelText("Proposed accessibility").textContent,
    ).toBe("+ Every image has alt text.");
  });

  it("opens one as a pull request, linking it, and rejects another", async () => {
    const server = stubServer([tech], {}, [
      proposal(1, "tech", "Use pnpm.\nNo default exports.\n"),
      proposal(2, "accessibility", "Every image has alt text.\n"),
    ]);
    renderCard();
    const user = userEvent.setup();
    await user.click(
      within(await proposedItem("tech, proposed on #4")).getByRole("button", {
        name: "Open tech as pull request",
      }),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe(
      "Opened PR #12 for tech. No Agent gets it until you merge it.",
    );
    expect(
      within(status).getByRole("link", { name: "PR #12" }).getAttribute("href"),
    ).toBe("https://github.com/adrianeyre/web-shop/pull/12");
    expect(
      screen.queryByRole("listitem", { name: "tech, proposed on #4" }),
    ).toBeNull();

    await user.click(
      within(await proposedItem("accessibility, proposed on #4")).getByRole(
        "button",
        { name: "Reject accessibility" },
      ),
    );
    await vi.waitFor(() => {
      expect(
        screen.queryByRole("list", { name: "Proposed Guidelines" }),
      ).toBeNull();
    });
    expect(server.posts).toEqual([
      {
        url: "/api/floors/web-shop/guideline-proposals/1/open",
        body: {},
        csrf: "csrf-token-1",
      },
      {
        url: "/api/floors/web-shop/guideline-proposals/2/reject",
        body: {},
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("says why one could not be opened", async () => {
    stubServer(
      [tech],
      {
        open: () =>
          Response.json(
            {
              error: "guideline_proposal_unchanged",
              message:
                "main already has .agents/guidelines/tech.md as proposed: reject the proposal instead.",
            },
            { status: 409 },
          ),
      },
      [proposal(1, "tech", "Use pnpm.\n")],
    );
    renderCard();
    await userEvent.setup().click(
      within(await proposedItem("tech, proposed on #4")).getByRole("button", {
        name: "Open tech as pull request",
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "main already has .agents/guidelines/tech.md as proposed: reject the proposal instead.",
    );
    expect(await proposedItem("tech, proposed on #4")).toBeDefined();
  });

  it("settles nothing on an archived Floor", async () => {
    stubServer([tech], {}, [proposal(1, "tech", "Use pnpm.\n")]);
    renderCard("2026-11-01T00:00:00.000Z");
    const proposed = await proposedItem("tech, proposed on #4");
    for (const name of ["Open tech as pull request", "Reject tech"]) {
      expect(
        within(proposed).getByRole("button", { name }).hasAttribute("disabled"),
      ).toBe(true);
    }
  });
});
