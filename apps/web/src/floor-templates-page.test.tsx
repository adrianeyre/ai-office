import {
  builtInRoles,
  defaultTeamRoles,
  type FloorTemplateDetail,
  type LibraryRole,
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
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The Floor Templates page (PRD FR-101), against a stubbed server that
// behaves as the API does: the built-in templates (read-only, duplicated
// to change) and the Owner's own (edited and deleted); an imported one
// showing its full contents and clashes, enabled by a review naming its
// digest; and importing from a file or Git.

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(Response.json(body, { status }));

const library: LibraryRole[] = builtInRoles.map((role) => ({
  ...role,
  skills: [...role.skills],
  agents: 0,
  inStartingTeam: defaultTeamRoles.includes(role.id),
}));

const role = (id: string) => {
  const found = builtInRoles.find((each) => each.id === id);
  if (found === undefined) {
    throw new Error(`No built-in Role ${id}.`);
  }
  return { ...found, skills: [...found.skills] };
};

const development: FloorTemplateDetail = {
  id: "development",
  name: "Development",
  description:
    "A software team that changes the code, reviews each pull request and tests it.",
  icon: "code",
  theme: "office",
  team: [
    { role: "manager", name: "Manager", stage: null, count: 1 },
    { role: "coder", name: "coder", stage: "work", count: 1 },
    { role: "reviewer", name: "reviewer", stage: "review", count: 1 },
    { role: "qa", name: "QA", stage: "qa", count: 1 },
  ],
  builtIn: true,
  enabled: true,
  source: "built-in",
  origin: null,
  reviewedAt: null,
  digest: "d".repeat(64),
  roles: [
    { role: role("coder"), count: 1 },
    { role: role("reviewer"), count: 1 },
    { role: role("qa"), count: 1 },
  ],
  settings: {
    setupCommand: "",
    testCommand: "",
    mergePolicy: "send_to_me",
    roundCap: 3,
    requiredReviewers: ["reviewer"],
  },
  manager: { planningGuidance: "", firstIssue: null },
  labels: [],
  skills: [],
  clashes: [],
  createdAt: null,
  updatedAt: null,
};

const mine: FloorTemplateDetail = {
  ...development,
  id: "my-shop",
  name: "My shop",
  description: "My shop's team, as it works.",
  builtIn: false,
  source: "floor",
  reviewedAt: "2026-10-10T09:00:00.000Z",
  digest: "e".repeat(64),
  createdAt: "2026-10-10T09:00:00.000Z",
  updatedAt: "2026-10-10T09:00:00.000Z",
};

const imported: FloorTemplateDetail = {
  ...development,
  id: "garden-centre",
  name: "Garden centre",
  description: "A garden centre's catalogue and copy.",
  icon: "shopping-bag",
  theme: "stockroom",
  builtIn: false,
  enabled: false,
  source: "file",
  reviewedAt: null,
  digest: "f".repeat(64),
  team: [
    { role: "manager", name: "Manager", stage: null, count: 1 },
    { role: "plantsperson", name: "plantsperson", stage: "work", count: 2 },
  ],
  roles: [
    {
      role: {
        id: "plantsperson",
        name: "plantsperson",
        stage: "work",
        description: "Keeps the plant catalogue.",
        instructions: "- Name every plant by its Latin name.",
        skills: ["plant-care"],
        deskDressing: "product-samples",
        aiProvider: null,
        model: null,
      },
      count: 2,
    },
  ],
  settings: { ...development.settings, requiredReviewers: [] },
  manager: {
    planningGuidance: "Plan by season.",
    firstIssue: { title: "List the plants", body: "Every plant we sell." },
  },
  labels: [{ name: "plant", color: "00aa00", description: "A plant" }],
  skills: [
    {
      name: "plant-care",
      description: "How to describe a plant's care.",
      files: [
        {
          path: "SKILL.md",
          content:
            "---\nname: plant-care\ndescription: How to describe a plant's care.\n---\n\nWater weekly.\n",
        },
      ],
    },
  ],
  clashes: [
    "The Skill library has its own plant-care, which differs from this template's: a Floor added from it keeps the library's.",
  ],
  createdAt: "2026-10-10T09:00:00.000Z",
  updatedAt: "2026-10-10T09:00:00.000Z",
};

const summaryOf = ({
  id,
  name,
  description,
  icon,
  theme,
  team,
  builtIn,
  enabled,
}: FloorTemplateDetail) => ({
  id,
  name,
  description,
  icon,
  theme,
  team,
  builtIn,
  enabled,
});

function stubServer() {
  const templates = [development, mine, imported].map((template) =>
    structuredClone(template),
  );
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      if (url.startsWith("/api/floor-templates") && method !== "GET") {
        sent.push({ method, url, body });
      }
      const id = decodeURIComponent(url.split("/")[3] ?? "");
      const template = templates.find((each) => each.id === id);
      if (url === "/api/floor-templates") {
        return json({
          templates: templates.map(summaryOf),
          defaultTemplate: "development",
        });
      }
      if (url.endsWith("/duplicate") && template !== undefined) {
        const copy = {
          ...structuredClone(template),
          id: `${template.id}-copy`,
          name: `${template.name} copy`,
          builtIn: false,
          source: "duplicate" as const,
        };
        templates.push(copy);
        return json(copy, 201);
      }
      if (url.endsWith("/review") && template !== undefined) {
        if (body?.["digest"] !== template.digest) {
          return json(
            { error: "template_changed", message: "It changed." },
            409,
          );
        }
        Object.assign(template, { enabled: true, reviewedAt: "now" });
        return json(template);
      }
      if (url === "/api/floor-templates/import") {
        templates.push({ ...structuredClone(imported), id: "uploaded" });
        return json({ ...imported, id: "uploaded" }, 201);
      }
      if (url === "/api/floor-templates/import/git") {
        return json(
          {
            error: "import_failed",
            message: "The repository could not be cloned.",
          },
          502,
        );
      }
      if (method === "PATCH" && template !== undefined) {
        // As the API does: each Role copied in from the library.
        const { roles, ...rest } = (body ?? {}) as {
          roles?: { role: string; count: number }[];
        };
        Object.assign(template, rest, { digest: "1".repeat(64) });
        if (roles !== undefined) {
          template.roles = roles.map(({ role: id, count }) => ({
            role: role(id),
            count,
          }));
        }
        return json(template);
      }
      if (method === "DELETE" && template !== undefined) {
        templates.splice(templates.indexOf(template), 1);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (template !== undefined) {
        return json(template);
      }
      if (url === "/api/roles") {
        return json({ roles: library });
      }
      if (url === "/api/session") {
        return json({
          csrfToken: "csrf-token-1",
          expiresAt: "2026-10-15T12:00:00.000Z",
        });
      }
      return json({}, 404);
    }),
  );
  return { sent };
}

function renderAt(path: string) {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <App
      router={router}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  return router;
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rowOf = async (name: string) => {
  const table = await screen.findByRole("table", { name: "Floor Templates" });
  const header = await within(table).findByRole("rowheader", { name });
  const row = header.closest("tr");
  if (row === null) {
    throw new Error(`No row for ${name}.`);
  }
  return within(row);
};

describe("the Floor Templates page", () => {
  it("lists every template with its kind and starting team; only the Owner's can be deleted", async () => {
    stubServer();
    renderAt("/general-settings/templates");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Floor Templates" }),
    ).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Floor Templates" });
    await within(table).findByRole("rowheader", { name: "Garden centre" });
    expect(
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) =>
          [
            within(row).getByRole("rowheader").textContent,
            ...within(row)
              .getAllByRole("cell")
              .slice(0, 2)
              .map((cell) => cell.textContent),
          ].join(" | "),
        ),
    ).toEqual([
      "Development | Built in | Manager, coder, reviewer, QA",
      "My shop | Yours | Manager, coder, reviewer, QA",
      "Garden centre | Waiting for review | Manager, 2 × plantsperson",
    ]);
    const builtIn = await rowOf("Development");
    expect(builtIn.queryByRole("button", { name: "Delete Development" })).toBe(
      null,
    );
    expect(
      builtIn
        .getByRole("link", { name: "Export Development" })
        .getAttribute("href"),
    ).toBe("/api/floor-templates/development/export");
    expect(
      (await rowOf("My shop")).getByRole("button", { name: "Delete My shop" }),
    ).toBeTruthy();
    expect(
      (await rowOf("Garden centre")).getByRole("button", {
        name: "Review Garden centre",
      }),
    ).toBeTruthy();
  });

  it("opens a built-in template read-only, and duplicates it to edit the copy", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const router = renderAt("/general-settings/templates");
    await user.click(
      (await rowOf("Development")).getByRole("button", {
        name: "Open Development",
      }),
    );
    const panel = within(
      await screen.findByRole("region", { name: "Development" }),
    );
    expect(
      panel.getByText(
        "A built-in template is read-only: duplicate it to change the copy.",
      ),
    ).toBeTruthy();
    expect(panel.queryByRole("form")).toBe(null);
    expect(
      panel.getByRole("article", { name: "Role coder" }).textContent,
    ).toContain(role("coder").instructions.slice(0, 40));

    await user.click(
      (await rowOf("Development")).getByRole("button", {
        name: "Duplicate Development",
      }),
    );
    expect(
      await screen.findByText(
        "Made Development copy, a copy of Development. Edit it below.",
      ),
    ).toBeTruthy();
    expect(router.state.location.search).toEqual({
      template: "development-copy",
    });
    expect(
      await screen.findByRole("form", { name: "Edit Development copy" }),
    ).toBeTruthy();
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/floor-templates/development/duplicate",
        body: {},
      },
    ]);
  });

  it("edits one of the Owner's templates, sending only what changed", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    renderAt("/general-settings/templates?template=my-shop");
    const form = within(
      await screen.findByRole("form", { name: "Edit My shop" }),
    );
    const save = form.getByRole<HTMLButtonElement>("button", {
      name: "Save My shop",
    });
    expect(save.disabled).toBe(true);
    const coders = form.getByLabelText("coder count");
    await user.clear(coders);
    await user.type(coders, "3");
    await user.selectOptions(form.getByLabelText("3D theme"), "studio");
    await user.selectOptions(form.getByLabelText("Add a Role"), "designer");
    await user.click(form.getByRole("button", { name: "Add" }));
    await user.click(form.getByRole("button", { name: "Remove QA" }));
    await user.click(save);
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      method: "PATCH",
      url: "/api/floor-templates/my-shop",
      body: {
        theme: "studio",
        roles: [
          { role: "coder", count: 3 },
          { role: "reviewer", count: 1 },
          { role: "designer", count: 1 },
        ],
      },
    });
    expect(await screen.findByText(/^Saved My shop\./)).toBeTruthy();
  });

  it("shows an imported template's full contents and clashes, and enables it once read", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    renderAt("/general-settings/templates");
    await user.click(
      (await rowOf("Garden centre")).getByRole("button", {
        name: "Review Garden centre",
      }),
    );
    const review = within(
      await screen.findByRole("region", { name: "Review Garden centre" }),
    );
    // Every Role's instructions and every Skill's files.
    expect(
      review.getByLabelText("plantsperson's instructions").textContent,
    ).toBe("- Name every plant by its Latin name.");
    expect(
      review.getByRole("article", { name: "Skill plant-care" }).textContent,
    ).toContain("Water weekly.");
    expect(review.getByText("Plan by season.")).toBeTruthy();
    expect(
      review.getByText("Suggested first issue: List the plants"),
    ).toBeTruthy();
    expect(review.getAllByRole("note")[0]?.textContent).toContain(
      "Imported from a file. Its Roles' instructions and its Skills reach models",
    );
    expect(
      review.getByText(
        "The Skill library has its own plant-care, which differs from this template's: a Floor added from it keeps the library's.",
      ),
    ).toBeTruthy();

    await user.click(
      review.getByRole("button", {
        name: "I have read it: enable Garden centre",
      }),
    );
    expect(
      await screen.findByText(
        "Enabled Garden centre: a Floor can now be added from it.",
      ),
    ).toBeTruthy();
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/floor-templates/garden-centre/review",
        body: { digest: "f".repeat(64) },
      },
    ]);
    await waitFor(async () => {
      expect(
        (await rowOf("Garden centre")).getAllByRole("cell")[0]?.textContent,
      ).toBe("Yours");
    });
  });

  it("imports a template from a file, then opens its review; a Git import that fails says why", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    renderAt("/general-settings/templates");
    const fromFile = within(
      await screen.findByRole("form", { name: "Import from a file" }),
    );
    const bundle = {
      format: "ai-office.floor-template",
      version: 1,
      exportedAt: "2026-10-10T09:00:00.000Z",
      id: "garden-centre",
      files: [{ path: "template.yaml", content: "name: Garden centre\n" }],
    };
    await user.upload(
      fromFile.getByLabelText("Exported template file"),
      new File([JSON.stringify(bundle)], "garden-centre.floor-template.json", {
        type: "application/json",
      }),
    );
    await user.type(fromFile.getByLabelText("Name (optional)"), "Nursery");
    await user.click(fromFile.getByRole("button", { name: "Import the file" }));
    expect(
      await screen.findByText(
        "Imported Garden centre. It is disabled until you have read it below and enabled it.",
      ),
    ).toBeTruthy();
    expect(sent[0]).toEqual({
      method: "POST",
      url: "/api/floor-templates/import",
      body: { bundle, name: "Nursery" },
    });

    const fromGit = within(
      screen.getByRole("form", { name: "Import from Git" }),
    );
    await user.type(
      fromGit.getByLabelText("Repository URL"),
      "https://example.com/templates.git",
    );
    await user.type(fromGit.getByLabelText("Folder (optional)"), "garden");
    await user.click(fromGit.getByRole("button", { name: "Import from Git" }));
    expect(
      await screen.findByText("The repository could not be cloned."),
    ).toBeTruthy();
    expect(sent[1]).toEqual({
      method: "POST",
      url: "/api/floor-templates/import/git",
      body: { url: "https://example.com/templates.git", path: "garden" },
    });
  });
});
