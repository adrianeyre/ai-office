import {
  anyAiProvider,
  builtInRoles,
  defaultCommunicationsAgentAvatar,
  defaultLobbyCast,
  defaultOwnerProfile,
  randomAvatar,
  type CommunicationsAgent,
  type LobbyCast,
  type OwnerProfile,
  type Stage,
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
import { resetLift } from "./scene/lift-store.ts";
import { location } from "./totp-settings.tsx";

// Agent Settings (each Floor's Agents, and the lobby's cast: the
// Communications Agent at reception, and the visitor) and the Owner's
// profile in Admin, against a stubbed server.

const webShop = {
  id: "web-shop",
  name: "Web shop",
  repository: "adrianeyre/web-shop",
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
  createdAt: "2026-10-08T12:00:00.000Z",
  archivedAt: null,
};

const agent = (
  id: string,
  name: string,
  role: string,
  stage: Stage | null,
) => ({
  id,
  floorId: "web-shop",
  name,
  role,
  stage,
  aiProvider: "Claude",
  model: "claude-opus-5-5",
  modelOverride: null,
  effort: null,
  extraInstructions: "",
  freshStartThreshold: null,
  enabled: true,
  avatar: randomAvatar(() => 0.5, []),
  tokenCaps: { daily: 200_000, monthly: null },
  createdAt: "2026-10-08T12:00:00.000Z",
  leavingAt: null,
  contractor: null,
});

function stubServer() {
  const state: {
    cast: LobbyCast;
    profile: OwnerProfile;
    communicationsAgent: CommunicationsAgent;
  } = {
    cast: structuredClone(defaultLobbyCast),
    profile: { ...defaultOwnerProfile },
    communicationsAgent: {
      name: "Grace",
      role: "communications",
      avatar: defaultCommunicationsAgentAvatar,
      aiProvider: "Claude",
      model: "claude-opus-5-5",
      modelOverride: null,
      enabled: true,
      createdAt: "2026-10-08T12:00:00.000Z",
    },
  };
  const puts: { url: string; body: unknown }[] = [];
  const deletes: string[] = [];
  const patches: { url: string; body: unknown }[] = [];
  let floorName = webShop.name;
  const team = [
    agent("ada", "Ada", "coder", "work"),
    agent("rex", "Rex", "reviewer", "review"),
    agent("sam", "Sam", "store-qa", "qa"),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      if (init?.method === "PATCH" && path === "/api/floors/web-shop") {
        const body = JSON.parse(init.body as string) as { name?: string };
        patches.push({ url: path, body });
        floorName = body.name ?? floorName;
        return Promise.resolve(
          Response.json({ ...webShop, name: floorName, ...body }),
        );
      }
      const agentId = /^\/api\/floors\/web-shop\/agents\/(\w+)$/.exec(
        path ?? "",
      )?.[1];
      if (init?.method === "PATCH" && agentId !== undefined) {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        patches.push({ url: path ?? url, body });
        const found =
          team.find(({ id }) => id === agentId) ??
          agent(agentId, agentId, "coder", "work");
        return Promise.resolve(
          Response.json({
            ...found,
            ...body,
            ...(body["aiProvider"] === anyAiProvider ? { model: "" } : {}),
          }),
        );
      }
      if (init?.method === "PATCH" && path === "/api/communications-agent") {
        const body = JSON.parse(init.body as string) as Partial<
          Pick<CommunicationsAgent, "name" | "avatar">
        >;
        patches.push({ url: path, body });
        state.communicationsAgent = { ...state.communicationsAgent, ...body };
        return Promise.resolve(Response.json(state.communicationsAgent));
      }
      if (init?.method === "DELETE") {
        deletes.push(path ?? url);
        return Promise.resolve(
          Response.json({
            added: [],
            removed: [agent("ada", "Ada", "coder", "work")],
            leaving: [],
          }),
        );
      }
      if (init?.method === "PUT") {
        const body: unknown = JSON.parse(init.body as string);
        puts.push({ url: path ?? url, body });
        if (path === "/api/office/profile") {
          state.profile = body as OwnerProfile;
          return Promise.resolve(Response.json(state.profile));
        }
        const role = /^\/api\/office\/lobby-cast\/(\w+)$/.exec(path ?? "")?.[1];
        if (role === "receptionist" || role === "visitor") {
          state.cast = { ...state.cast, [role]: body };
          return Promise.resolve(Response.json(state.cast));
        }
      }
      switch (path) {
        case "/api/session":
          return Promise.resolve(
            Response.json({
              csrfToken: "csrf-token-1",
              expiresAt: "2026-10-15T12:00:00.000Z",
            }),
          );
        case "/api/floors":
          return Promise.resolve(
            Response.json({ floors: [{ ...webShop, name: floorName }] }),
          );
        case "/api/floors/web-shop":
          return Promise.resolve(
            Response.json({ ...webShop, name: floorName }),
          );
        case "/api/floors/web-shop/agents":
          return Promise.resolve(Response.json({ agents: team }));
        case "/api/roles":
          return Promise.resolve(
            Response.json({
              roles: [
                ...builtInRoles.map((role) => ({
                  ...role,
                  agents: 1,
                  inStartingTeam: true,
                })),
                {
                  ...builtInRoles[2],
                  id: "store-qa",
                  name: "store QA",
                  agents: 1,
                  inStartingTeam: true,
                },
              ],
            }),
          );
        case "/api/office/lobby-cast":
          return Promise.resolve(Response.json(state.cast));
        case "/api/communications-agent":
          return Promise.resolve(Response.json(state.communicationsAgent));
        case "/api/office/profile":
          return Promise.resolve(Response.json(state.profile));
        default:
          return Promise.resolve(Response.json({}, { status: 404 }));
      }
    }),
  );
  return { puts, deletes, patches, state };
}

function renderAt(path: string) {
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
}

beforeEach(() => {
  resetLift();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Agent Settings", () => {
  it("shows the lobby's cast where the lift is, the lobby, and renames the Communications Agent at reception", async () => {
    const { puts, patches } = stubServer();
    renderAt("/agent-settings");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Agent Settings" }),
    ).toBeDefined();
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Floor" }).value,
    ).toBe("lobby");
    expect(
      await screen.findByRole("heading", {
        name: "Grace, the Communications Agent",
      }),
    ).toBeDefined();
    // A tab each for the lobby's cast, the receptionist's open first.
    const cast = within(
      screen.getByRole("tablist", { name: "The lobby's cast" }),
    );
    expect(cast.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Grace",
      "Victor",
    ]);
    expect(
      cast.getByRole("tab", { name: "Grace" }).getAttribute("aria-selected"),
    ).toBe("true");
    await userEvent.click(cast.getByRole("tab", { name: "Victor" }));
    expect(
      screen.getByRole("heading", { name: "Victor, the visitor" }),
    ).toBeDefined();
    await userEvent.click(cast.getByRole("tab", { name: "Grace" }));
    // The rest of it is in the Connections admin.
    expect(
      screen
        .getByRole("link", { name: "the Connections admin" })
        .getAttribute("href"),
    ).toBe("/general-settings/connections");

    const form = within(
      screen.getByRole("form", { name: "The Communications Agent's name" }),
    );
    const name = form.getByRole("textbox", { name: "Name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Iris");
    await userEvent.click(form.getByRole("button", { name: "Save name" }));
    expect(
      await screen.findByRole("heading", {
        name: "Iris, the Communications Agent",
      }),
    ).toBeDefined();
    expect(patches).toEqual([
      { url: "/api/communications-agent", body: { name: "Iris" } },
    ]);
    expect(puts).toEqual([]);
  });

  it("changes the Communications Agent's Avatar, as the reception desk shows it", async () => {
    const { patches } = stubServer();
    renderAt("/agent-settings?floor=lobby");
    const avatar = within(
      await screen.findByRole("form", { name: "Grace's Avatar" }),
    );
    await userEvent.click(
      within(avatar.getByRole("group", { name: "Sex" })).getByRole("radio", {
        name: "Androgynous (they)",
      }),
    );
    await userEvent.click(
      avatar.getByRole("button", { name: "Save Grace's Avatar" }),
    );
    expect(await avatar.findByRole("status")).toBeDefined();
    expect(patches).toEqual([
      {
        url: "/api/communications-agent",
        body: {
          avatar: {
            ...defaultCommunicationsAgentAvatar,
            presentation: "androgynous",
          },
        },
      },
    ]);
  });

  it("changes the lobby visitor's sex in their Avatar", async () => {
    const { puts } = stubServer();
    renderAt("/agent-settings?floor=lobby");
    await userEvent.click(await screen.findByRole("tab", { name: "Victor" }));
    const avatar = within(
      await screen.findByRole("form", { name: "Victor's Avatar" }),
    );
    await userEvent.click(
      within(avatar.getByRole("group", { name: "Sex" })).getByRole("radio", {
        name: "Female (she)",
      }),
    );
    await userEvent.click(
      avatar.getByRole("button", { name: "Save Victor's Avatar" }),
    );
    expect(await avatar.findByRole("status")).toBeDefined();
    expect(puts).toEqual([
      {
        url: "/api/office/lobby-cast/visitor",
        body: {
          ...defaultLobbyCast.visitor,
          avatar: {
            ...defaultLobbyCast.visitor.avatar,
            presentation: "female",
          },
        },
      },
    ]);
  });

  it("shows every Agent on a Floor in a tab of its own, with tabs for its settings and Avatar", async () => {
    stubServer();
    renderAt("/agent-settings?floor=web-shop");
    const agents = within(
      await screen.findByRole("tablist", { name: "Agents on Web shop" }),
    );
    const names = agents.getAllByRole("tab").map((tab) => tab.textContent);
    expect(names).toHaveLength(3);
    expect(names.slice(0, 2)).toEqual(["Ada", "Rex"]);
    expect(await screen.findByRole("heading", { name: "Ada" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Rex" })).toBeNull();
    // Each Agent's Role, picked out beside its name, as the Role library
    // names it.
    const roles: (string | null)[] = [];
    for (const name of names) {
      await userEvent.click(agents.getByRole("tab", { name }));
      expect(screen.getByText(/Token Caps: 200,000 a day/)).toBeDefined();
      await waitFor(() => {
        expect(
          document.querySelector("[data-agent-role]")?.textContent,
        ).not.toBe("");
      });
      roles.push(
        document.querySelector("[data-agent-role]")?.textContent ?? null,
      );
    }
    expect(roles).toEqual(["Coder", "Reviewer", "Store QA"]);

    // The settings tab is open first; no button opens either.
    await userEvent.click(agents.getByRole("tab", { name: "Ada" }));
    expect(screen.queryByRole("button", { name: /^Edit Ada's/ })).toBeNull();
    const ada = within(
      screen.getByRole("tablist", { name: "Ada's settings and Avatar" }),
    );
    expect(
      ada.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("form", { name: "Edit Ada" })).toBeDefined();
    expect(
      screen.getByRole("spinbutton", { name: "Daily Token Cap" }),
    ).toBeDefined();
    await userEvent.click(ada.getByRole("tab", { name: "Avatar" }));
    expect(screen.getByRole("form", { name: "Ada's Avatar" })).toBeDefined();
    expect(screen.queryByRole("form", { name: "Edit Ada" })).toBeNull();
  });

  it("opens the tab of the Agent the address names", async () => {
    stubServer();
    renderAt("/agent-settings?floor=web-shop&agent=rex");
    expect(
      (await screen.findByRole("tab", { name: "Rex" })).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
  });

  it("goes to another Floor when one is chosen", async () => {
    stubServer();
    renderAt("/agent-settings?floor=lobby");
    await screen.findByRole("heading", {
      name: "Grace, the Communications Agent",
    });
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Floor" }),
      "web-shop",
    );
    expect(await screen.findByRole("heading", { name: "Ada" })).toBeDefined();
  });
});

describe("an Agent's settings in Agent Settings", () => {
  const editorOf = async (name: string) => {
    await userEvent.click(await screen.findByRole("tab", { name }));
    const card = within(
      (await screen.findByRole("heading", { name })).closest<HTMLElement>(
        "[data-slot=card]",
      ) ?? document.body,
    );
    return within(card.getByRole("form", { name: `Edit ${name}` }));
  };

  it("has every one of an Agent's settings", async () => {
    stubServer();
    renderAt("/agent-settings?floor=web-shop");
    const ada = await editorOf("Ada");
    for (const name of ["Name", "Extra instructions"]) {
      expect(ada.getByRole("textbox", { name })).toBeDefined();
    }
    for (const name of ["Status", "AI Provider", "Model", "Effort"]) {
      expect(ada.getByRole("combobox", { name })).toBeDefined();
    }
    for (const name of [
      "Daily Token Cap",
      "Monthly Token Cap",
      "Fresh Start threshold (%)",
    ]) {
      expect(ada.getByRole("spinbutton", { name })).toBeDefined();
    }
    // Only a reviewer can be a required reviewer.
    expect(
      ada.queryByRole("checkbox", { name: "Required reviewer" }),
    ).toBeNull();
    const rex = await editorOf("Rex");
    expect(
      rex.getByRole("checkbox", { name: "Required reviewer" }),
    ).toBeDefined();
  });

  it("puts an Agent on any AI Provider, with whichever one's default Model and effort", async () => {
    const { patches } = stubServer();
    renderAt("/agent-settings?floor=web-shop");
    const ada = await editorOf("Ada");
    const provider = ada.getByRole("combobox", { name: "AI Provider" });
    expect(
      within(provider).getByRole("option", { name: anyAiProvider }),
    ).toBeDefined();
    await userEvent.selectOptions(provider, anyAiProvider);
    expect(ada.getByRole("combobox", { name: "Model" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(ada.getByRole("combobox", { name: "Effort" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(ada.getByText(/uses whichever is available/)).toBeDefined();
    await userEvent.click(ada.getByRole("button", { name: "Save Ada" }));
    expect(await ada.findByRole("status")).toHaveProperty(
      "textContent",
      expect.stringMatching(/^Saved\./),
    );
    expect(patches).toEqual([
      {
        url: "/api/floors/web-shop/agents/ada",
        body: { aiProvider: anyAiProvider },
      },
    ]);
  });

  it("makes a reviewer one every round of the Review Loop needs", async () => {
    const { patches } = stubServer();
    renderAt("/agent-settings?floor=web-shop");
    const rex = await editorOf("Rex");
    const required = rex.getByRole("checkbox", { name: "Required reviewer" });
    await waitFor(() => {
      expect(required).toHaveProperty("disabled", false);
    });
    await userEvent.click(required);
    await userEvent.click(rex.getByRole("button", { name: "Save Rex" }));
    expect(await rex.findByRole("status")).toHaveProperty(
      "textContent",
      expect.stringMatching(/^Saved\./),
    );
    // Its own settings are as they were: only the Floor's change.
    expect(patches).toEqual([
      {
        url: "/api/floors/web-shop",
        body: { requiredReviewerAgentIds: ["rex"] },
      },
    ]);
  });
});

describe("removing an Agent in Agent Settings", () => {
  it("asks first, then removes it; never the Manager", async () => {
    const { deletes } = stubServer();
    renderAt("/agent-settings?floor=web-shop");
    const ada = within(
      (
        await screen.findByRole("heading", { name: "Ada" })
      ).closest<HTMLElement>("[data-slot=card]") ?? document.body,
    );
    await userEvent.click(ada.getByRole("button", { name: "Remove Ada" }));
    await userEvent.click(ada.getByRole("button", { name: "Remove Ada" }));
    expect(await ada.findByRole("status")).toHaveProperty(
      "textContent",
      "Ada was removed.",
    );
    expect(deletes).toEqual(["/api/floors/web-shop/agents/ada"]);
  });
});

describe("renaming a Floor in Agent Settings", () => {
  it("renames the Floor, not its repository", async () => {
    const { patches } = stubServer();
    renderAt("/agent-settings?floor=web-shop");
    const form = within(
      await screen.findByRole("form", { name: "The Floor's name" }),
    );
    expect(form.getByText("adrianeyre/web-shop")).toBeDefined();
    const name = form.getByRole("textbox", { name: "Floor name" });
    await userEvent.clear(name);
    await userEvent.type(name, "The shop");
    await userEvent.click(form.getByRole("button", { name: "Rename Floor" }));
    expect(await form.findByRole("status")).toHaveProperty(
      "textContent",
      "Renamed.",
    );
    expect(patches).toEqual([
      { url: "/api/floors/web-shop", body: { name: "The shop" } },
    ]);
  });
});
