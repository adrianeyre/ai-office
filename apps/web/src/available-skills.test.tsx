import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import {
  AvailableSkillList,
  managerChatHref,
  withSkillCommand,
} from "./available-skills.tsx";
import { createAppRouter } from "./router.tsx";
import { SkillMarkdown } from "./skill-markdown.tsx";

// The Available Skills list (PRD FR-73), against a stubbed server: each
// Skill's name, description and source; its modal with the SKILL.md
// rendered and its supporting files; and running one, from Floor Settings, opening
// the Floor's Manager chat with its command in the box.

const on = { coder: true, qa: true, docs: true, designer: true };

const floorOf = (id: string, name: string) => ({
  id,
  name,
  repository: `adrianeyre/${id}`,
  githubRepositoryId: 1,
  template: { id: "development", name: "Development" },
  theme: "office",
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
  createdAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
});

const skillsOf: Record<string, unknown> = {
  "web-shop": {
    skills: [
      {
        name: "pdf",
        description: "The repository's pdf.",
        source: "repository",
        folder: ".claude/skills/pdf",
        overridesOffice: true,
        roles: on,
      },
    ],
    ignored: [],
    repositoryError: null,
  },
  blog: {
    skills: [
      {
        name: "release-notes",
        description: "Writes release notes.",
        source: "office",
        folder: null,
        overridesOffice: false,
        roles: on,
      },
    ],
    ignored: [],
    repositoryError:
      "The repository's Skills could not be read from GitHub: Not Found",
  },
};

/** A built-in Skill, as the server lists it and opens it. */
const builtIn = (name: string, description: string) => ({
  name,
  description,
  source: "built-in",
  folder: null,
  overridesOffice: false,
});
skillsOf["docs"] = {
  skills: [
    builtIn("grilling", "Interview the Owner."),
    builtIn("pr", "Use when writing a PR body."),
    builtIn("wayfinder", "Chart a loose idea."),
  ].map((skill) => ({ ...skill, roles: on })),
  ignored: [],
  repositoryError: null,
};

const details: Record<string, unknown> = {
  ...Object.fromEntries(
    [
      ["grilling", "Interview the Owner."],
      ["pr", "Use when writing a PR body."],
      ["wayfinder", "Chart a loose idea."],
    ].map(([name = "", description = ""]) => [
      `/api/floors/docs/skills/${name}`,
      {
        ...builtIn(name, description),
        files: [
          {
            path: "SKILL.md",
            content: `---\nname: ${name}\ndescription: ${description}\n---\n\nThe instructions.\n`,
          },
        ],
      },
    ]),
  ),
  "/api/floors/web-shop/skills/pdf": {
    name: "pdf",
    description: "The repository's pdf.",
    source: "repository",
    folder: ".claude/skills/pdf",
    overridesOffice: true,
    files: [
      {
        path: "SKILL.md",
        content:
          "---\nname: pdf\ndescription: The repository's pdf.\n---\n\n# PDFs\n\nSee [the reference](REFERENCE.md).\n",
      },
      { path: "REFERENCE.md", content: "## Fields\n\n- `title`\n" },
    ],
  },
  "/api/floors/blog/skills/release-notes": {
    name: "release-notes",
    description: "Writes release notes.",
    source: "office",
    folder: null,
    overridesOffice: false,
    files: [
      {
        path: "SKILL.md",
        content:
          "---\nname: release-notes\ndescription: Writes release notes.\n---\n\nList the changes.\n",
      },
    ],
  },
};

function stubServer() {
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      fetched.push(url);
      const skills = /^\/api\/floors\/([^/]+)\/skills$/.exec(url)?.[1];
      if (url === "/api/floors") {
        return Promise.resolve(
          Response.json({
            floors: [floorOf("web-shop", "Web shop"), floorOf("blog", "Blog")],
          }),
        );
      }
      if (skills !== undefined && skillsOf[skills] !== undefined) {
        return Promise.resolve(Response.json(skillsOf[skills]));
      }
      if (details[url] !== undefined) {
        return Promise.resolve(Response.json(details[url]));
      }
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({
            csrfToken: "csrf",
            expiresAt: "2026-10-15T12:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  return fetched;
}

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a Floor's Available Skills", () => {
  it("lists each Skill's name, description and source, and opens it in a modal with its files", async () => {
    const user = userEvent.setup();
    stubServer();
    const onRun = vi.fn();
    render(
      <QueryClientProvider client={client()}>
        <AvailableSkillList floorId="web-shop" onRun={onRun} />
      </QueryClientProvider>,
    );
    const pdf = await screen.findByRole("listitem", { name: "pdf" });
    expect(pdf.textContent).toBe("pdfRepositoryThe repository's pdf.");

    await user.click(within(pdf).getByRole("button", { name: "Open pdf" }));
    const modal = within(await screen.findByRole("dialog", { name: "pdf" }));
    expect((await modal.findByText(/From the repository/)).textContent).toBe(
      "From the repository, .claude/skills/pdf, in place of the office Skill of its name.",
    );
    const rendered = modal.getByRole("region", { name: "SKILL.md, rendered" });
    expect(
      within(rendered).getByRole("heading", { name: "PDFs" }),
    ).toBeTruthy();
    // Links open outside AI Office.
    expect(
      within(rendered)
        .getByRole("link", { name: "the reference" })
        .getAttribute("target"),
    ).toBe("_blank");
    expect(
      within(modal.getByRole("list", { name: "Supporting files" }))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["REFERENCE.md"]);

    // A supporting Markdown file, rendered in the modal.
    await user.click(modal.getByRole("button", { name: "REFERENCE.md" }));
    const reference = modal.getByRole("region", {
      name: "REFERENCE.md, rendered",
    });
    expect(
      within(reference).getByRole("heading", { name: "Fields" }).tagName,
    ).toBe("H4");
    expect(
      modal
        .getByRole("button", { name: "REFERENCE.md" })
        .getAttribute("aria-current"),
    ).toBe("true");

    await user.click(modal.getByRole("button", { name: "Run /pdf" }));
    expect(onRun).toHaveBeenCalledWith("pdf");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says what running each built-in Skill does, and credits Matt Pocock for those adapted from his", async () => {
    const user = userEvent.setup();
    stubServer();
    render(
      <QueryClientProvider client={client()}>
        <AvailableSkillList floorId="docs" onRun={vi.fn()} />
      </QueryClientProvider>,
    );
    const whereFrom = async (name: string) => {
      await user.click(
        within(await screen.findByRole("listitem", { name })).getByRole(
          "button",
          { name: `Open ${name}` },
        ),
      );
      const modal = within(await screen.findByRole("dialog", { name }));
      const { textContent: text } = await modal.findByText(
        /^Built into AI Office/,
      );
      const credit = modal.queryByRole("link", {
        name: "Matt Pocock’s skills",
      });
      await user.keyboard("{Escape}");
      return { text, credit: credit?.getAttribute("href") ?? null };
    };
    expect(
      within(
        await screen.findByRole("listitem", { name: "wayfinder" }),
      ).getByText("Built in"),
    ).toBeTruthy();
    expect(await whereFrom("grilling")).toEqual({
      text: "Built into AI Office, on every Floor. Running it starts a Grilling Session with the Manager.",
      credit: null,
    });
    expect(await whereFrom("wayfinder")).toEqual({
      text: "Built into AI Office, on every Floor. Running it starts a Grilling Session with the Manager. Adapted from Matt Pocock’s skills, MIT.",
      credit: "https://github.com/mattpocock/skills",
    });
    expect(await whereFrom("pr")).toEqual({
      text: "Built into AI Office, on every Floor. Running it loads its instructions into the Manager chat; an office or repository Skill of its name takes its place. Adapted from Matt Pocock’s skills, MIT.",
      credit: "https://github.com/mattpocock/skills",
    });
  });

  it("says there are none, and why the repository's could not be read", async () => {
    stubServer();
    render(
      <QueryClientProvider client={client()}>
        <AvailableSkillList floorId="blog" onRun={vi.fn()} />
      </QueryClientProvider>,
    );
    expect((await screen.findByRole("note")).textContent).toMatch(
      /could not be read from GitHub/,
    );
    expect(
      screen.getByRole("listitem", { name: "release-notes" }).textContent,
    ).toBe("release-notesOfficeWrites release notes.");
  });
});

describe("Floor Settings' Available Skills", () => {
  it("shows the chosen Floor's Skills, and running one opens its Manager chat with the command", async () => {
    const user = userEvent.setup();
    const fetched = stubServer();
    const history = createMemoryHistory({
      initialEntries: ["/floor-settings"],
    });
    render(<App router={createAppRouter(history)} queryClient={client()} />);
    const cardElement = (
      await screen.findByRole("heading", { name: "Available Skills" })
    ).closest<HTMLElement>("[data-slot=card]");
    if (cardElement === null) {
      throw new Error("Available Skills is not in a card.");
    }
    const card = within(cardElement);
    expect(await card.findByRole("listitem", { name: "pdf" })).toBeTruthy();

    await user.selectOptions(card.getByLabelText("Floor"), "blog");
    expect(
      await card.findByRole("listitem", { name: "release-notes" }),
    ).toBeTruthy();
    expect(card.queryByRole("listitem", { name: "pdf" })).toBeNull();

    await user.click(card.getByRole("button", { name: "Open release-notes" }));
    const modal = within(
      await screen.findByRole("dialog", { name: "release-notes" }),
    );
    expect(await modal.findByText("List the changes.")).toBeTruthy();
    expect(modal.getByText("None.")).toBeTruthy();
    await user.click(modal.getByRole("button", { name: "Run /release-notes" }));
    expect(
      (
        await screen.findByLabelText<HTMLTextAreaElement>(/^Message /, {
          selector: "textarea",
        })
      ).value,
    ).toBe("/release-notes ");
    expect(history.location.pathname).toBe("/floors/blog/manager");
    expect(fetched).toContain("/api/floors/blog/skills/release-notes");
  });
});

describe("the run command", () => {
  it("puts /name first, in place of a Skill's command already there, keeping the rest as its arguments", () => {
    expect(withSkillCommand("", "pdf")).toBe("/pdf ");
    expect(withSkillCommand("the invoice", "pdf")).toBe("/pdf the invoice");
    expect(withSkillCommand("  /grilling the basket", "pdf")).toBe(
      "/pdf the basket",
    );
    expect(withSkillCommand("/grilling", "pdf")).toBe("/pdf ");
  });

  it("opens the Manager chat with the Skill named", () => {
    expect(managerChatHref("web-shop")).toBe("/floors/web-shop/manager");
    expect(managerChatHref("web-shop", "pdf")).toBe(
      "/floors/web-shop/manager?skill=pdf",
    );
  });
});

describe("a Skill's Markdown", () => {
  it("shows HTML written in it as text, and fetches no image", () => {
    const { container } = render(
      <SkillMarkdown
        label="SKILL.md, rendered"
        text={
          "# Title\n\n<script>alert(1)</script>\n\n<b>bold?</b>\n\n![logo](https://example.com/logo.png)\n\n[bad](javascript:alert(1))\n"
        }
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("(image: logo)");
    expect(
      screen.getByText("bad").closest("a")?.getAttribute("href") ?? "",
    ).not.toMatch(/javascript/i);
  });
});
