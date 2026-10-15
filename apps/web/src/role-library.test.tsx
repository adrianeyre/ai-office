import {
  builtInRoles,
  defaultTeamRoles,
  roleIdOf,
  type AiProviderEntry,
  type LibraryRole,
  type SkillSummary,
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

// The Role library page (PRD FR-98, FR-65), against a stubbed server that
// behaves as the API does: the Roles with their Stage and Agents; making,
// duplicating, editing (which says how many Agents it reaches) and
// deleting one no Agent fills.

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(Response.json(body, { status }));

const aiProviderEntries: AiProviderEntry[] = [
  {
    aiProvider: "Claude",
    agentTool: "Claude Code",
    defaultModel: "claude-opus-5-5",
    models: ["claude-opus-5-5", "claude-sonnet-5-5"].map((model) => ({
      model,
      displayName: null,
      contextWindow: null,
      accountTypes: ["api_key"],
    })),
    catalogueFetchedAt: "2026-10-09T08:00:00.000Z",
  },
];

const skill = (name: string): SkillSummary => ({
  id: `skill-${name}`,
  name,
  description: `What ${name} does.`,
  source: "editor",
  origin: null,
  digest: "a".repeat(64),
  enabled: true,
  reviewedAt: "2026-10-09T12:00:00.000Z",
  createdAt: "2026-10-09T12:00:00.000Z",
  updatedAt: "2026-10-09T12:00:00.000Z",
  files: [{ path: "SKILL.md", bytes: 80 }],
});

/** The built-in Roles, with `agents` Agents each (none if absent). */
const library = (agents: Record<string, number> = {}): LibraryRole[] =>
  builtInRoles.map((role) => ({
    ...role,
    skills: [...role.skills],
    agents: agents[role.id] ?? 0,
    inStartingTeam: defaultTeamRoles.includes(role.id),
  }));

function stubServer(initial: LibraryRole[]) {
  const roles = structuredClone(initial);
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      if (url.startsWith("/api/roles") && method !== "GET") {
        sent.push({ method, url, body });
      }
      const id = decodeURIComponent(url.split("/")[3] ?? "");
      const role = roles.find((each) => each.id === id);
      if (url === "/api/roles" && method === "POST") {
        const made = {
          ...(body as Omit<LibraryRole, "id" | "agents" | "inStartingTeam">),
          id: roleIdOf(String(body?.["name"])),
          agents: 0,
          inStartingTeam: false,
        };
        roles.push(made);
        return json(made, 201);
      }
      if (url.endsWith("/duplicate") && role !== undefined) {
        const copy = {
          ...role,
          id: `${role.id}-copy`,
          name: `${role.name} copy`,
          agents: 0,
          inStartingTeam: false,
        };
        roles.push(copy);
        return json(copy, 201);
      }
      if (method === "PATCH" && role !== undefined) {
        Object.assign(role, body);
        return json(role);
      }
      if (method === "DELETE" && role !== undefined) {
        roles.splice(roles.indexOf(role), 1);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "/api/roles") {
        return json({ roles });
      }
      if (url === "/api/skills") {
        return json({ skills: [skill("brand-voice"), skill("seo-audit")] });
      }
      if (url === "/api/ai-providers") {
        return json({ aiProviders: aiProviderEntries });
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

describe("the Role library page", () => {
  it("lists the Roles with their Stage and how many Agents fill each", async () => {
    stubServer(library({ coder: 3, reviewer: 2, qa: 2 }));
    renderAt("/general-settings/roles");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Role library" }),
    ).toBeTruthy();
    const table = await screen.findByRole("table", { name: "Roles" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole("cell")
          .slice(0, 3)
          .map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["Work", builtInRoles[0]?.description, "3"],
      ["Review", builtInRoles[1]?.description, "2"],
      ["QA", builtInRoles[2]?.description, "2"],
      ["Docs", builtInRoles[3]?.description, "0"],
      ["Work", builtInRoles[4]?.description, "0"],
    ]);
    // A Role in use, or one every new Floor starts with, stays.
    const coder = screen.getByRole("button", { name: "Delete coder" });
    expect((coder as HTMLButtonElement).disabled).toBe(true);
    expect(
      document.getElementById(coder.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("A Floor Template starts Floors with a coder Agent, so it stays.");
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Delete designer",
      }).disabled,
    ).toBe(false);
  });

  it("makes a Role, opens it, and edits it, saying how many Agents the change reaches", async () => {
    const { sent } = stubServer(library({ coder: 1 }));
    const user = userEvent.setup();
    const router = renderAt("/general-settings/roles");
    await user.click(await screen.findByRole("button", { name: "New Role" }));
    const form = within(screen.getByRole("form", { name: "New Role" }));
    await user.type(form.getByLabelText("Name"), "copywriter");
    await user.type(
      form.getByLabelText("Routing description"),
      "Writes the product copy.",
    );
    await user.type(
      form.getByLabelText("Instructions"),
      "- Write in the brand's voice.",
    );
    await user.click(form.getByLabelText("brand-voice"));
    await user.selectOptions(form.getByLabelText("Desk dressing"), "books");
    await user.selectOptions(
      form.getByLabelText("Suggested AI Provider"),
      "Claude",
    );
    await user.selectOptions(
      form.getByLabelText("Suggested Model"),
      "claude-sonnet-5-5",
    );
    await user.click(form.getByRole("button", { name: "Make Role" }));

    expect(
      await screen.findByText(
        "Made copywriter. Add an Agent in it from a Floor's admin.",
      ),
    ).toBeTruthy();
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/roles",
        body: {
          name: "copywriter",
          stage: "work",
          description: "Writes the product copy.",
          instructions: "- Write in the brand's voice.",
          skills: ["brand-voice"],
          deskDressing: "books",
          aiProvider: "Claude",
          model: "claude-sonnet-5-5",
        },
      },
    ]);
    // Its form is open, at its own address.
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ role: "copywriter" });
    });
    const edit = within(
      await screen.findByRole("form", { name: "Edit copywriter" }),
    );
    expect(edit.getByRole("status").textContent).toBe(
      "No Agent fills this Role: a change reaches no one yet.",
    );

    // The coder's form says whom a change reaches, and keeps its Stage.
    await user.click(screen.getByRole("button", { name: "Open coder" }));
    const coder = within(
      await screen.findByRole("form", { name: "Edit coder" }),
    );
    expect(coder.getByRole("status").textContent).toBe(
      "1 Agent fills this Role. A change reaches it from its next task; its own extra instructions still apply on top.",
    );
    expect(coder.getByLabelText<HTMLSelectElement>("Stage").disabled).toBe(
      true,
    );
    const save = coder.getByRole("button", { name: "Save coder" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    const instructions = coder.getByLabelText("Instructions");
    await user.clear(instructions);
    await user.type(instructions, "- Change as few files as you can.");
    await user.click(save);
    expect(
      await screen.findByText(
        "Saved coder. 1 Agent with it uses the change from their next task.",
      ),
    ).toBeTruthy();
    // Only what changed is sent.
    expect(sent.at(-1)).toEqual({
      method: "PATCH",
      url: "/api/roles/coder",
      body: { instructions: "- Change as few files as you can." },
    });
  });

  it("duplicates a Role and opens the copy; deletes one no Agent fills after asking", async () => {
    const { sent } = stubServer(library());
    const user = userEvent.setup();
    renderAt("/general-settings/roles");
    await user.click(
      await screen.findByRole("button", { name: "Duplicate reviewer" }),
    );
    expect(
      await screen.findByText(
        "Made reviewer copy, a copy of reviewer. Edit it below.",
      ),
    ).toBeTruthy();
    const copy = within(
      await screen.findByRole("form", { name: "Edit reviewer copy" }),
    );
    // No Agent fills the copy, so its Stage can change.
    expect(copy.getByLabelText<HTMLSelectElement>("Stage").disabled).toBe(
      false,
    );

    await user.click(screen.getByRole("button", { name: "Delete designer" }));
    expect(
      screen.getByText(
        "Delete designer? Its Role memory on every Floor goes with it.",
      ),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Yes, delete designer" }),
    );
    expect(await screen.findByText("Deleted designer.")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("rowheader", { name: "designer" })).toBeNull();
    });
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "POST /api/roles/reviewer/duplicate",
      "DELETE /api/roles/designer",
    ]);
  });
});
