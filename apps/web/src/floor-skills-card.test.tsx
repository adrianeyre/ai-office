import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FloorSkillsCard } from "./floor-skills-card.tsx";

// A Floor's Skills in its admin (PRD FR-72, FR-75), against a stubbed
// server: each Skill's source, a switch per Role, and the repository's
// Skills waiting for the Owner's review (FR-76, P1-10).

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

const on = { coder: true, qa: true, docs: true, designer: true };

function stubServer() {
  const state = {
    skills: [
      {
        name: "pdf",
        description: "The repository's pdf.",
        source: "repository",
        folder: ".claude/skills/pdf",
        overridesOffice: true,
        roles: { ...on },
      },
      {
        name: "release-notes",
        description: "Writes release notes.",
        source: "office",
        folder: null,
        overridesOffice: false,
        roles: { ...on, docs: false },
      },
    ],
    awaitingReview: [
      {
        name: "deploy",
        description: "How to deploy.",
        folder: ".agents/skills/deploy",
        digest: "d".repeat(64),
        overridesOffice: false,
        changed: false,
      },
    ] as unknown[],
    ignored: [
      { folder: ".claude/skills/broken", problems: ["No frontmatter."] },
    ],
    repositoryError: null,
  };
  const puts: { url: string; body: unknown; csrf: string | null }[] = [];
  const reviews: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const toggle =
        /^\/api\/floors\/web-shop\/skills\/([^/]+)\/roles\/([^/]+)$/.exec(url);
      if (toggle !== null && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as { enabled: boolean };
        puts.push({
          url,
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        const skill = state.skills.find(({ name }) => name === toggle[1]);
        if (skill !== undefined) {
          skill.roles = { ...skill.roles, [toggle[2] ?? ""]: body.enabled };
        }
        return Promise.resolve(
          Response.json({ name: toggle[1], role: toggle[2], ...body }),
        );
      }
      if (url === "/api/floors/web-shop/skills") {
        return Promise.resolve(Response.json(state));
      }
      if (
        url ===
        "/api/floors/web-shop/repository-skills?folder=.agents%2Fskills%2Fdeploy"
      ) {
        return Promise.resolve(
          Response.json({
            name: "deploy",
            description: "How to deploy.",
            folder: ".agents/skills/deploy",
            digest: "d".repeat(64),
            files: [
              {
                path: "SKILL.md",
                content:
                  "---\nname: deploy\ndescription: How to deploy.\n---\n\nRun deploy.sh.\n",
              },
              { path: "deploy.sh", content: "pnpm build\n" },
            ],
          }),
        );
      }
      if (
        url === "/api/floors/web-shop/repository-skills/review" &&
        init?.method === "POST"
      ) {
        reviews.push({
          body: JSON.parse(init.body as string) as unknown,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.awaitingReview = [];
        return Promise.resolve(Response.json({}));
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
  return { puts, reviews };
}

const checkbox = (name: string) =>
  screen.getByRole<HTMLInputElement>("checkbox", { name });

const renderCard = (archivedAt: string | null = null) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <FloorSkillsCard floor={{ ...floor, archivedAt }} />
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a Floor's Skills in its admin", () => {
  it("lists each Skill with where it comes from, on or off for each Role", async () => {
    stubServer();
    renderCard();
    const pdf = await screen.findByRole("rowheader", { name: /pdf/ });
    expect(pdf.textContent).toContain(
      "Repository, .claude/skills/pdf (overrides the office Skill)",
    );
    expect(
      screen.getByRole("rowheader", { name: /release-notes/ }).textContent,
    ).toContain("Office library");
    expect(checkbox("release-notes for docs Agents").checked).toBe(false);
    expect(checkbox("release-notes for QA Agents").checked).toBe(true);
    expect(
      screen.getByText(".claude/skills/broken").closest("li")?.textContent,
    ).toContain("No frontmatter.");
  });

  it("turns a Skill off for one Role", async () => {
    const { puts } = stubServer();
    renderCard();
    const box = await screen.findByRole("checkbox", {
      name: "pdf for QA Agents",
    });
    await userEvent.click(box);
    expect(puts).toEqual([
      {
        url: "/api/floors/web-shop/skills/pdf/roles/qa",
        body: { enabled: false },
        csrf: "csrf-token-1",
      },
    ]);
    await vi.waitFor(() => {
      expect(checkbox("pdf for QA Agents").checked).toBe(false);
    });
    expect(checkbox("pdf for coder Agents").checked).toBe(true);
  });

  it("shows a repository Skill waiting for review, its files as they are, and reviews exactly those (P1-10)", async () => {
    const { reviews } = stubServer();
    renderCard();
    const waiting = await screen.findByRole("region", {
      name: "Repository Skills waiting for your review",
    });
    expect(waiting.textContent).toContain("Never reviewed, so it is not used.");
    // Not in the table of Skills in use.
    expect(screen.queryByRole("rowheader", { name: /deploy/ })).toBeNull();
    await userEvent.click(
      within(waiting).getByRole("button", { name: "Read deploy to review it" }),
    );
    expect(
      (await within(waiting).findByLabelText(".agents/skills/deploy/deploy.sh"))
        .textContent,
    ).toBe("pnpm build\n");
    await userEvent.click(
      within(waiting).getByRole("button", {
        name: "I have read every file: use deploy on this Floor",
      }),
    );
    expect(reviews).toEqual([
      {
        body: { folder: ".agents/skills/deploy", digest: "d".repeat(64) },
        csrf: "csrf-token-1",
      },
    ]);
    await vi.waitFor(() => {
      expect(
        screen.queryByRole("region", {
          name: "Repository Skills waiting for your review",
        }),
      ).toBeNull();
    });
  });

  it("changes nothing on an archived Floor", async () => {
    stubServer();
    renderCard("2026-10-05T00:00:00.000Z");
    const table = await screen.findByRole("table");
    for (const box of within(table).getAllByRole<HTMLInputElement>(
      "checkbox",
    )) {
      expect(box.disabled).toBe(true);
    }
  });
});
