import {
  builtInRole,
  builtInRoles,
  defaultTeamRoles,
  defaultOwnerProfile,
  lookDistinct,
  noTokens,
  randomAvatar,
  type Agent,
  type AgentContextUsage,
  type Avatar,
  type AiProviderEntry,
  type FloorTokenUsage,
  type FloorWallBoard,
  type Floor,
  type FloorTemplateList,
  type GatewayKey,
  type InstalledRepository,
  type LibraryRole,
  type Role,
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
import { webgl } from "./scene/webgl.ts";
import { location } from "./totp-settings.tsx";

// The Avatar Editor's 3D preview needs WebGL: a stand-in shows what it
// was given.
vi.mock("./scene/avatar-preview.tsx", () => ({
  AvatarPreview: ({ avatar, turn }: { avatar: Avatar; turn: number }) => (
    <div
      data-testid="avatar-preview"
      data-turn={turn.toFixed(4)}
      data-hair={avatar.hairColour}
      data-outfit={avatar.outfit.style}
    />
  ),
}));

// The Floors in Floor Settings (PRD FR-6, FR-7, FR-9), against a stubbed
// server that keeps its Floors in `state`.

const session = {
  csrfToken: "csrf-token-1",
  expiresAt: "2026-10-15T12:00:00.000Z",
};

const floor = (overrides: Partial<Floor> = {}): Floor => ({
  id: "web-shop",
  repository: "adrianeyre/web-shop",
  githubRepositoryId: 101,
  template: { id: "development", name: "Development" },
  theme: "office",
  name: "web-shop",
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
  ...overrides,
});

const repository = (
  fullName: string,
  floorId: string | null = null,
): InstalledRepository => ({
  fullName,
  defaultBranch: "main",
  private: true,
  htmlUrl: `https://github.com/${fullName}`,
  floorId,
});

const agent = (name: string, role: Role, overrides: Partial<Agent> = {}) =>
  ({
    id: `${name.toLowerCase()}-id`,
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
    avatar: randomAvatar(),
    tokenCaps: { daily: null, monthly: null },
    createdAt: "2026-10-08T12:00:00.000Z",
    leavingAt: null,
    contractor: null,
    ...overrides,
  }) satisfies Agent;

/** The built-in Floor Templates, as `GET /api/floor-templates` lists them. */
const floorTemplates: FloorTemplateList = {
  defaultTemplate: "development",
  templates: [
    {
      id: "development",
      name: "Development",
      description:
        "A software team that changes the code, reviews each pull request and tests it.",
      icon: "code",
      theme: "office",
      team: [
        { role: "manager", name: "Manager", stage: null, count: 1 },
        { role: "coder", name: "coder", stage: "work", count: 2 },
        { role: "reviewer", name: "reviewer", stage: "review", count: 1 },
        { role: "qa", name: "QA", stage: "qa", count: 1 },
      ],
      builtIn: true,
      enabled: true,
    },
    {
      id: "blank",
      name: "Blank",
      description:
        "Only a Manager, for a Floor whose team you put together yourself.",
      icon: "square",
      theme: "office",
      team: [{ role: "manager", name: "Manager", stage: null, count: 1 }],
      builtIn: true,
      enabled: true,
    },
    {
      id: "garden-centre",
      name: "Garden centre",
      description: "An imported template, waiting for the Owner's review.",
      icon: "shopping-bag",
      theme: "stockroom",
      team: [{ role: "manager", name: "Manager", stage: null, count: 1 }],
      builtIn: false,
      enabled: false,
    },
  ],
};

/** The AI Providers: Claude and Grok have default Models; Gemini none. */
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
  {
    aiProvider: "ChatGPT",
    agentTool: "Codex",
    defaultModel: null,
    models: [],
    catalogueFetchedAt: null,
  },
  {
    aiProvider: "Grok",
    agentTool: "opencode",
    defaultModel: "grok-4",
    models: ["grok-4", "grok-4-fast"].map((model) => ({
      model,
      displayName: null,
      contextWindow: null,
      accountTypes: ["api_key"],
    })),
    catalogueFetchedAt: "2026-10-09T08:00:00.000Z",
  },
  {
    aiProvider: "Gemini",
    agentTool: "opencode",
    defaultModel: null,
    models: [],
    catalogueFetchedAt: null,
  },
];

const gatewayKey = (
  agentId: string,
  overrides: Partial<GatewayKey> = {},
): GatewayKey => ({
  id: `${agentId}-key`,
  kind: "agent",
  name: agentId,
  agentId,
  floorId: "web-shop",
  hint: "aio_gk_Ab12",
  createdAt: "2026-10-08T12:00:00.000Z",
  lastUsedAt: "2026-10-09T09:30:00.000Z",
  revokedAt: null,
  profile: defaultOwnerProfile,
  access: "proxy",
  enabled: true,
  ...overrides,
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly csrf: string | null;
}

function stubServer(
  options: {
    floors?: Floor[];
    repositories?: InstalledRepository[] | Response;
    agents?: Agent[];
    gatewayKeys?: GatewayKey[];
    /** Each Agent's caps in force and use; the office's, unused, if absent. */
    agentCaps?: Record<string, FloorTokenUsage["agents"][number]["caps"]>;
    issues?: FloorTokenUsage["issues"];
    /** The Floor's issues in progress; none if absent. */
    wallBoard?: Pick<FloorWallBoard, "issues" | "agents">;
    /** The office-wide sandbox limit; 3 if absent. */
    sandboxLimit?: number;
    /** The Agents in the middle of a task: removing one leaves it leaving. */
    busy?: string[];
    /** The office Role library; the built-in Roles if absent. */
    roles?: LibraryRole[];
    /** The Agents with a session going, and their Context Usage. */
    contextUsage?: AgentContextUsage[];
  } = {},
) {
  const state = {
    floors: options.floors ?? [],
    repositories: options.repositories ?? [],
    agents: options.agents ?? [],
    gatewayKeys: options.gatewayKeys ?? [],
    issues: options.issues ?? [],
  };
  let added = 0;
  /** A new Agent in `role`, as the API copies it from the Role's first. */
  const copy = (role: Role, name?: string): Agent => {
    added += 1;
    const first = state.agents.find((agent) => agent.role === role);
    const made = agent(name ?? `New ${String(added)}`, role, {
      ...(first === undefined
        ? {}
        : {
            aiProvider: first.aiProvider,
            model: first.model,
            modelOverride: first.modelOverride,
          }),
    });
    state.agents.push(made);
    return made;
  };
  /** Removes an Agent as the API does: at once, or once its task ends. */
  const remove = (removed: Agent) => {
    if (options.busy?.includes(removed.id) === true) {
      removed.leavingAt = "2026-10-09T12:00:00.000Z";
      return { added: [], removed: [], leaving: [removed] };
    }
    state.agents = state.agents.filter(({ id }) => id !== removed.id);
    return { added: [], removed: [removed], leaving: [] };
  };
  const calls: Call[] = [];
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({
      url,
      method,
      body,
      csrf: new Headers(init?.headers).get("x-csrf-token"),
    });
    const reply = (): Response => {
      if (url === "/api/session") {
        return Response.json(session);
      }
      if (url === "/api/floors" && method === "GET") {
        return Response.json({
          floors: state.floors.filter(({ archivedAt }) => archivedAt === null),
        });
      }
      if (url === "/api/floor-templates") {
        return Response.json(floorTemplates);
      }
      if (url === "/api/floors" && method === "POST") {
        const { repository: fullName, template = "development" } = body as {
          repository: string;
          template?: string;
        };
        const chosen = floorTemplates.templates.find(
          ({ id }) => id === template,
        );
        const added = floor({
          id: fullName.split("/")[1] ?? "",
          name: fullName.split("/")[1] ?? "",
          repository: fullName,
          template: { id: template, name: chosen?.name ?? template },
        });
        state.floors.push(added);
        if (Array.isArray(state.repositories)) {
          state.repositories = state.repositories.map((repo) =>
            repo.fullName === fullName ? { ...repo, floorId: added.id } : repo,
          );
        }
        return Response.json(added, { status: 201 });
      }
      if (url === "/api/github/repositories") {
        return Array.isArray(state.repositories)
          ? Response.json({ repositories: state.repositories })
          : state.repositories.clone();
      }
      if (url === "/api/gateway-keys") {
        return Response.json({ keys: state.gatewayKeys });
      }
      const rotate =
        /^\/api\/floors\/([^/]+)\/agents\/([^/]+)\/gateway-key\/rotate$/.exec(
          url,
        );
      if (rotate !== null && method === "POST") {
        const agentId = rotate[2] ?? "";
        const rotated = gatewayKey(agentId, {
          id: `${agentId}-key-2`,
          hint: "aio_gk_New1",
          lastUsedAt: null,
        });
        state.gatewayKeys = [
          ...state.gatewayKeys.filter((key) => key.agentId !== agentId),
          rotated,
        ];
        return Response.json(rotated);
      }
      if (/^\/api\/floors\/[^/]+\/context-usage$/.test(url)) {
        return Response.json({ agents: options.contextUsage ?? [] });
      }
      const usage = /^\/api\/floors\/([^/]+)\/token-usage$/.exec(url);
      if (usage !== null) {
        const unused = {
          daily: { ...noTokens },
          monthly: { ...noTokens },
        };
        return Response.json({
          floorId: usage[1] ?? "",
          caps: { daily: null, monthly: null },
          agentDefaults: {
            daily: { level: "office", cap: 5_000_000 },
            monthly: { level: "office", cap: 100_000_000 },
          },
          usage: unused,
          agents: state.agents.map((agent) => ({
            agentId: agent.id,
            usage: unused,
            caps: options.agentCaps?.[agent.id] ?? {
              daily: { level: "office", cap: 5_000_000, used: 0 },
              monthly: { level: "office", cap: 100_000_000, used: 0 },
            },
          })),
          issues: state.issues,
        } satisfies FloorTokenUsage);
      }
      const issueCaps =
        /^\/api\/floors\/([^/]+)\/issues\/(\d+)\/token-caps$/.exec(url);
      if (issueCaps !== null && method === "PUT") {
        const caps = body as { daily: number | null; monthly: number | null };
        const issue = Number(issueCaps[2]);
        state.issues = [
          ...state.issues.filter((entry) => entry.issue !== issue),
          ...(caps.daily === null && caps.monthly === null
            ? []
            : [
                {
                  issue,
                  caps,
                  usage: {
                    daily: { ...noTokens },
                    monthly: { ...noTokens },
                  },
                },
              ]),
        ];
        return Response.json(caps);
      }
      if (url === "/api/ai-providers") {
        return Response.json({ aiProviders: aiProviderEntries });
      }
      if (url === "/api/roles") {
        return Response.json({
          roles:
            options.roles ??
            builtInRoles.map((role) => ({
              ...role,
              agents: state.agents.filter((each) => each.role === role.id)
                .length,
              inStartingTeam: defaultTeamRoles.includes(role.id),
            })),
        });
      }
      if (url === "/api/office/sandboxes") {
        return Response.json({ concurrencyLimit: options.sandboxLimit ?? 3 });
      }
      const board = /^\/api\/floors\/([^/]+)\/wall-board$/.exec(url);
      if (board !== null) {
        return Response.json({
          floorId: board[1] ?? "",
          roundCap: 3,
          qaRoundCap: 3,
          queues: [],
          issues: options.wallBoard?.issues ?? [],
          agents: options.wallBoard?.agents ?? [],
        } satisfies FloorWallBoard);
      }
      const teamSize = /^\/api\/floors\/([^/]+)\/team\/([a-z]+)$/.exec(url);
      if (teamSize !== null && method === "PUT") {
        const role = teamSize[2] ?? "";
        const { count } = body as { count: number };
        const staying = state.agents.filter(
          (agent) => agent.role === role && agent.leavingAt === null,
        );
        const change = {
          added: [] as Agent[],
          removed: [] as Agent[],
          leaving: [] as Agent[],
        };
        for (let size = staying.length; size < count; size += 1) {
          change.added.push(copy(role));
        }
        for (const leaver of staying
          .reverse()
          .slice(0, staying.length - count)) {
          const { removed, leaving } = remove(leaver);
          change.removed.push(...removed);
          change.leaving.push(...leaving);
        }
        return Response.json(change);
      }
      // "Keep on the team" (ADR 0004): no longer a Contractor.
      const keep = /^\/api\/floors\/([^/]+)\/agents\/([^/]+)\/keep$/.exec(url);
      const kept = state.agents.find(({ id }) => id === keep?.[2]);
      if (kept !== undefined && method === "POST") {
        Object.assign(kept, { contractor: null });
        return Response.json(kept);
      }
      const edit = /^\/api\/floors\/([^/]+)\/agents\/([^/]+)$/.exec(url);
      const editing = state.agents.find(({ id }) => id === edit?.[2]);
      if (editing !== undefined && method === "DELETE") {
        if (editing.role === "manager") {
          return Response.json(
            {
              error: "manager_not_removable",
              message:
                "web-shop's Manager cannot be removed: a Floor has exactly one.",
            },
            { status: 409 },
          );
        }
        return Response.json(remove(editing));
      }
      if (editing !== undefined && method === "PATCH") {
        const changes = body as Partial<Agent>;
        if (
          changes.name !== undefined &&
          state.agents.some(
            ({ id, name }) => id !== editing.id && name === changes.name,
          )
        ) {
          return Response.json(
            {
              error: "agent_name_taken",
              message: `An Agent on web-shop is already called ${changes.name}.`,
            },
            { status: 409 },
          );
        }
        // As the API does: a new AI Provider starts from its defaults.
        const aiProvider = changes.aiProvider ?? editing.aiProvider;
        const moved = aiProvider !== editing.aiProvider;
        Object.assign(editing, {
          ...(moved ? { modelOverride: null, effort: null } : {}),
          ...changes,
        });
        Object.assign(editing, {
          model:
            editing.modelOverride ??
            aiProviderEntries.find((entry) => entry.aiProvider === aiProvider)
              ?.defaultModel,
        });
        return Response.json(editing);
      }
      const team = /^\/api\/floors\/([^/]+)\/agents$/.exec(url);
      if (team !== null && method === "POST") {
        const { role, name } = body as { role: Role; name?: string };
        return Response.json(copy(role, name), { status: 201 });
      }
      if (team !== null) {
        return Response.json({
          agents: state.agents.filter(({ floorId }) => floorId === team[1]),
        });
      }
      const match = /^\/api\/floors\/([^/]+)(\/archive)?$/.exec(url);
      const found = state.floors.find(({ id }) => id === match?.[1]);
      if (match !== null && found !== undefined) {
        if (match[2] !== undefined) {
          Object.assign(found, { archivedAt: "2026-10-09T08:00:00.000Z" });
        } else if (method === "PATCH") {
          const { name } = body as { name?: string };
          const namesake = state.floors.find(
            (other) =>
              other !== found &&
              other.archivedAt === null &&
              other.name.toLowerCase() === name?.toLowerCase(),
          );
          if (namesake !== undefined) {
            return Response.json(
              {
                error: "floor_name_taken",
                message: `Another Floor is called "${namesake.name}". Choose another name.`,
              },
              { status: 409 },
            );
          }
          Object.assign(found, body);
        }
        return Response.json(found);
      }
      if (url === "/api/totp") {
        return Response.json({ enabled: false, recoveryCodesLeft: 0 });
      }
      if (url === "/health") {
        return Response.json({ status: "ok", database: "up" });
      }
      return Response.json(
        { error: "floor_not_found", message: `There is no Floor here.` },
        { status: 404 },
      );
    };
    return Promise.resolve(reply());
  });
  vi.stubGlobal("fetch", fetch);
  return { state, calls };
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

/** The card under the heading `name`. */
async function card(name: string) {
  const heading = await screen.findByRole("heading", { name });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error(`The ${name} heading is not in a card.`);
  }
  return within(element);
}

const changes = (calls: Call[]) =>
  calls.filter(({ method }) => method !== "GET");

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Floors in Floor Settings", () => {
  it("adds a Floor from a repository the App is installed on", async () => {
    const { calls } = stubServer({
      floors: [
        floor({ id: "blog", name: "blog", repository: "adrianeyre/blog" }),
      ],
      repositories: [
        repository("adrianeyre/blog", "blog"),
        repository("adrianeyre/web-shop"),
      ],
    });
    renderAt("/floor-settings");
    const floors = await card("Floors");
    expect(await floors.findByRole("link", { name: "blog" })).toBeDefined();
    const repositories = await floors.findByRole("list", {
      name: "Repositories the App is installed on",
    });
    expect(
      within(repositories)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "adrianeyre/blogAlready a Floor",
      "adrianeyre/web-shopAdd Floor",
    ]);

    const add = floors.getByRole("button", {
      name: "Add adrianeyre/web-shop as a Floor",
    });
    await vi.waitFor(() => {
      expect((add as HTMLButtonElement).disabled).toBe(false);
    });
    await userEvent.click(add);

    const link = await floors.findByRole("link", { name: "web-shop" });
    expect(link.getAttribute("href")).toBe("/floor-settings/web-shop");
    // From Development, which the picker starts on.
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors",
        method: "POST",
        body: { repository: "adrianeyre/web-shop", template: "development" },
        csrf: "csrf-token-1",
      },
    ]);
    await vi.waitFor(() => {
      expect(
        within(repositories)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        "adrianeyre/blogAlready a Floor",
        "adrianeyre/web-shopAlready a Floor",
      ]);
    });
  });

  it("picks the Floor Template a new Floor starts from, showing each one's starting team (PRD FR-97)", async () => {
    const { calls } = stubServer({
      floors: [
        floor({ id: "blog", name: "blog", repository: "adrianeyre/blog" }),
      ],
      repositories: [
        repository("adrianeyre/blog", "blog"),
        repository("adrianeyre/web-shop"),
      ],
    });
    renderAt("/floor-settings");
    const floors = await card("Floors");
    // Each Floor says which template it started from.
    // Beside the way to its Manager chat and its Remove Floor button.
    expect(
      (await floors.findByRole("link", { name: "blog" })).closest("li")
        ?.textContent,
    ).toBe(
      "blog adrianeyre/blog · started from DevelopmentChat with the Manager of blogRemove Floor",
    );
    expect(
      floors
        .getByRole("link", { name: "Chat with the Manager of blog" })
        .getAttribute("href"),
    ).toBe("/floors/blog/manager");

    const picker = await floors.findByRole("group", { name: "Floor Template" });
    const development = await within(picker).findByRole("radio", {
      name: "Development",
    });
    const blank = within(picker).getByRole("radio", { name: "Blank" });
    // One imported and not yet reviewed is not offered (PRD FR-101).
    expect(
      within(picker)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("value")),
    ).toEqual(["development", "blank"]);
    expect((development as HTMLInputElement).checked).toBe(true);
    expect((blank as HTMLInputElement).checked).toBe(false);
    // Its description and starting team describe each choice.
    expect(development.getAttribute("aria-describedby")).not.toBeNull();
    expect(
      within(picker).getByText(
        "Starting team: Manager, 2 × coder, reviewer, QA",
      ),
    ).toBeDefined();
    expect(within(picker).getByText("Starting team: Manager")).toBeDefined();
    expect(
      within(picker).getByText(
        "Only a Manager, for a Floor whose team you put together yourself.",
      ),
    ).toBeDefined();

    await userEvent.click(blank);
    expect((blank as HTMLInputElement).checked).toBe(true);
    const add = floors.getByRole("button", {
      name: "Add adrianeyre/web-shop as a Floor",
    });
    await vi.waitFor(() => {
      expect((add as HTMLButtonElement).disabled).toBe(false);
    });
    await userEvent.click(add);
    const link = await floors.findByRole("link", { name: "web-shop" });
    expect(link.closest("li")?.textContent).toBe(
      "web-shop adrianeyre/web-shop · started from BlankChat with the Manager of web-shopRemove Floor",
    );
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors",
        method: "POST",
        body: { repository: "adrianeyre/web-shop", template: "blank" },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("says when the GitHub App is not configured", async () => {
    stubServer({
      repositories: Response.json(
        {
          error: "github_not_configured",
          message:
            "GitHub is not set up: add a GitHub App or an access token in Floor Settings.",
        },
        { status: 503 },
      ),
    });
    renderAt("/floor-settings");
    const floors = await card("Floors");
    expect((await floors.findByRole("alert")).textContent).toBe(
      "GitHub is not set up: add a GitHub App or an access token in Floor Settings.",
    );
    expect(floors.getByText("No Floors yet.")).toBeDefined();
  });
});

describe("a Floor's own settings page", () => {
  it("shows the Floor's settings, and saves only what changed", async () => {
    const { calls } = stubServer({ floors: [floor()] });
    renderAt("/floor-settings/web-shop");
    expect(
      await screen.findByRole("heading", { level: 1, name: "web-shop" }),
    ).toBeDefined();
    // The template it started from (PRD FR-97).
    expect(
      screen.getByText(/It started from the Development Floor Template\./),
    ).toBeDefined();
    const settings = await card("Settings");
    expect(
      settings.getByLabelText<HTMLSelectElement>("Merge Policy").value,
    ).toBe("send_to_me");
    expect(settings.getByLabelText<HTMLInputElement>("Round Cap").value).toBe(
      "3",
    );
    expect(
      settings.getByLabelText<HTMLInputElement>(
        "Work waits for me to approve each Plan",
      ).checked,
    ).toBe(true);
    const save = settings.getByRole("button", { name: "Save settings" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await userEvent.selectOptions(
      settings.getByLabelText("Merge Policy"),
      "auto_merge",
    );
    const roundCap = settings.getByLabelText("Round Cap");
    await userEvent.clear(roundCap);
    await userEvent.type(roundCap, "5");
    const priority = settings.getByLabelText("Priority");
    await userEvent.clear(priority);
    await userEvent.type(priority, "7");
    await userEvent.type(settings.getByLabelText("Daily Token Cap"), "2000000");
    await userEvent.type(settings.getByLabelText("Test command"), "pnpm test");
    await userEvent.click(
      settings.getByLabelText("Work waits for me to approve each Plan"),
    );
    await userEvent.click(save);

    expect((await settings.findByRole("status")).textContent).toBe("Saved.");
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors/web-shop",
        method: "PATCH",
        body: {
          testCommand: "pnpm test",
          mergePolicy: "auto_merge",
          planApproval: false,
          roundCap: 5,
          priority: 7,
          tokenCaps: { daily: 2_000_000, monthly: null },
        },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("sets the Floor's most Agents, or no limit, whether the Manager spins work off from chat, and hourly Status updates", async () => {
    // FR-10, FR-24, ADR 0004, FR-23a.
    const { calls } = stubServer({ floors: [floor()] });
    renderAt("/floor-settings/web-shop");
    const settings = await card("Settings");
    const most = settings.getByLabelText<HTMLInputElement>("Most Agents");
    expect(most.value).toBe("8");
    expect(most.disabled).toBe(false);
    const spinOff = settings.getByLabelText<HTMLInputElement>(
      "Manager spins off work from chat",
    );
    expect(spinOff.checked).toBe(true);
    const hourly = settings.getByLabelText<HTMLInputElement>(
      "Hourly Status updates while Agents work",
    );
    expect(hourly.checked).toBe(true);

    // Out of bounds is refused before it is sent.
    await userEvent.clear(most);
    await userEvent.type(most, "0");
    const save = settings.getByRole("button", { name: "Save settings" });
    await userEvent.click(save);
    expect((await settings.findByRole("alert")).textContent).toContain(
      "Most Agents is at least 1.",
    );
    await userEvent.clear(most);
    await userEvent.type(most, "12");
    await userEvent.click(spinOff);
    await userEvent.click(hourly);
    await userEvent.click(save);
    expect((await settings.findByRole("status")).textContent).toBe("Saved.");

    await userEvent.click(settings.getByLabelText("No limit"));
    expect(
      settings.getByLabelText<HTMLInputElement>("Most Agents").disabled,
    ).toBe(true);
    await userEvent.click(save);
    await vi.waitFor(() => {
      expect(changes(calls)).toHaveLength(2);
    });
    expect(changes(calls).map(({ body }) => body)).toEqual([
      { mostAgents: 12, spinOffFromChat: false, hourlyStatusUpdates: false },
      { mostAgents: null },
    ]);
  });

  it("sets the Floor's own Git identity, and clears it", async () => {
    const { calls } = stubServer({ floors: [floor()] });
    renderAt("/floor-settings/web-shop");
    const settings = await card("Settings");
    await userEvent.type(
      settings.getByLabelText("Commit author name"),
      "Web Shop Owner",
    );
    // One without the other is refused before it is sent.
    await userEvent.click(
      settings.getByRole("button", { name: "Save settings" }),
    );
    expect((await settings.findByRole("alert")).textContent).toBe(
      "Give the commit author an email address.",
    );
    await userEvent.type(
      settings.getByLabelText("Commit author email"),
      "owner@web-shop.example",
    );
    await userEvent.click(
      settings.getByRole("button", { name: "Save settings" }),
    );
    expect((await settings.findByRole("status")).textContent).toBe("Saved.");

    await userEvent.clear(settings.getByLabelText("Commit author name"));
    await userEvent.clear(settings.getByLabelText("Commit author email"));
    await userEvent.click(
      settings.getByRole("button", { name: "Save settings" }),
    );
    await vi.waitFor(() => {
      expect(changes(calls)).toHaveLength(2);
    });
    expect(changes(calls).map(({ body }) => body)).toEqual([
      {
        gitIdentity: {
          name: "Web Shop Owner",
          email: "owner@web-shop.example",
        },
      },
      { gitIdentity: null },
    ]);
  });

  it("refuses settings out of bounds before sending them", async () => {
    const { calls } = stubServer({ floors: [floor()] });
    renderAt("/floor-settings/web-shop");
    const settings = await card("Settings");
    const roundCap = settings.getByLabelText("Round Cap");
    await userEvent.clear(roundCap);
    await userEvent.type(roundCap, "0");
    await userEvent.type(settings.getByLabelText("Concurrency limit"), "0");
    const priority = settings.getByLabelText("Priority");
    await userEvent.clear(priority);
    await userEvent.type(priority, "11");
    await userEvent.click(
      settings.getByRole("button", { name: "Save settings" }),
    );
    expect(
      within(await settings.findByRole("alert"))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "The Round Cap is at least 1.",
      "The concurrency limit is at least 1.",
      "The priority is at most 10.",
    ]);
    expect(changes(calls)).toEqual([]);
  });

  it("removes a Floor from Floor Settings' Floors in use, after asking", async () => {
    const { calls, state } = stubServer({ floors: [floor()] });
    renderAt("/floor-settings");
    const floors = await card("Floors");
    await userEvent.click(
      await floors.findByRole("button", { name: "Remove Floor web-shop" }),
    );
    expect(changes(calls)).toEqual([]);
    await userEvent.click(
      floors.getByRole("button", { name: "Remove web-shop" }),
    );
    expect(await floors.findByText("No Floors yet.")).toBeDefined();
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors/web-shop/archive",
        method: "POST",
        body: {},
        csrf: "csrf-token-1",
      },
    ]);
    expect(state.floors[0]?.archivedAt).not.toBeNull();
  });

  it("renames a Floor in Floors in use, keeping its repository and address (PRD FR-7)", async () => {
    const user = userEvent.setup();
    const { calls, state } = stubServer({
      floors: [
        floor(),
        floor({
          id: "blog",
          repository: "adrianeyre/blog",
          githubRepositoryId: 102,
          name: "Blog",
        }),
      ],
    });
    renderAt("/floor-settings");
    const floors = await card("Floors");
    await user.click(
      await floors.findByRole("button", { name: "Rename web-shop" }),
    );
    const input = floors.getByRole("textbox", {
      name: "New name for web-shop",
    });
    expect(input.getAttribute("maxlength")).toBe("60");
    // Cancel leaves it as it was.
    await user.clear(input);
    await user.type(input, "Abandoned");
    await user.click(floors.getByRole("button", { name: "Cancel" }));
    expect(changes(calls)).toEqual([]);
    expect(floors.getByRole("link", { name: "web-shop" })).toBeDefined();

    // A name another Floor has, whatever its case, is refused, saying why.
    await user.click(floors.getByRole("button", { name: "Rename web-shop" }));
    const again = floors.getByRole("textbox", {
      name: "New name for web-shop",
    });
    await user.clear(again);
    await user.type(again, "BLOG");
    await user.click(floors.getByRole("button", { name: "Save" }));
    expect((await floors.findByRole("alert")).textContent).toBe(
      'Another Floor is called "Blog". Choose another name.',
    );
    expect(again.getAttribute("aria-invalid")).toBe("true");
    // An empty name is refused before it is sent.
    await user.clear(again);
    await user.click(floors.getByRole("button", { name: "Save" }));
    expect((await floors.findByRole("alert")).textContent).toBe(
      "Give the Floor a name.",
    );

    await user.type(again, "  Storefront ");
    await user.click(floors.getByRole("button", { name: "Save" }));
    const renamed = await floors.findByRole("link", { name: "Storefront" });
    // Its address keeps its id; its repository is still shown beside it.
    expect(renamed.getAttribute("href")).toBe("/floor-settings/web-shop");
    expect(renamed.closest("li")?.textContent).toContain("adrianeyre/web-shop");
    expect(
      floors.getByRole("link", { name: "Chat with the Manager of Storefront" }),
    ).toBeDefined();
    expect(changes(calls).filter(({ method }) => method === "PATCH")).toEqual([
      {
        url: "/api/floors/web-shop",
        method: "PATCH",
        body: { name: "BLOG" },
        csrf: "csrf-token-1",
      },
      {
        url: "/api/floors/web-shop",
        method: "PATCH",
        body: { name: "Storefront" },
        csrf: "csrf-token-1",
      },
    ]);
    expect(state.floors[0]?.name).toBe("Storefront");
    // Focus is back on the Rename button.
    await waitFor(() => {
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Rename Storefront",
      );
    });
  });

  it("archives the Floor after asking, then goes back to Floor Settings", async () => {
    const { calls, state } = stubServer({ floors: [floor()] });
    const router = renderAt("/floor-settings/web-shop");
    const archive = await card("Archive");
    await userEvent.click(
      archive.getByRole("button", { name: "Archive Floor" }),
    );
    expect(changes(calls)).toEqual([]);
    await userEvent.click(
      archive.getByRole("button", { name: "Archive web-shop" }),
    );

    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe("/floor-settings");
    });
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors/web-shop/archive",
        method: "POST",
        body: {},
        csrf: "csrf-token-1",
      },
    ]);
    expect(state.floors[0]?.archivedAt).not.toBeNull();
    const floors = await card("Floors");
    expect(await floors.findByText("No Floors yet.")).toBeDefined();
  });

  it("shows an archived Floor read-only", async () => {
    stubServer({
      floors: [floor({ archivedAt: "2026-10-09T08:00:00.000Z" })],
    });
    renderAt("/floor-settings/web-shop");
    expect((await screen.findByRole("note")).textContent).toContain(
      "This Floor is archived",
    );
    const settings = await card("Settings");
    // Inside a disabled fieldset, so it cannot be changed.
    expect(settings.getByLabelText("Name").matches(":disabled")).toBe(true);
    expect(
      settings.queryByRole("button", { name: "Save settings" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "Archive" })).toBeNull();
  });

  it("lists the Floor's Agents, with their Gateway Keys", async () => {
    stubServer({
      gatewayKeys: [
        gatewayKey("ada-id", { lastUsedAt: null }),
        gatewayKey("linus-id"),
      ],
      floors: [floor({ requiredReviewerAgentIds: ["grace-id"] })],
      contextUsage: [
        {
          agentId: "ada-id",
          floorId: "web-shop",
          issue: null,
          model: "claude-opus-5-5",
          inputTokens: 30_000,
          contextWindow: 200_000,
          contextUsage: 0.15,
          updatedAt: "2026-10-09T09:30:00.000Z",
        },
        {
          agentId: "linus-id",
          floorId: "web-shop",
          issue: 4,
          model: "claude-opus-5-5",
          inputTokens: 172_000,
          contextWindow: 200_000,
          contextUsage: 0.86,
          updatedAt: "2026-10-09T09:30:00.000Z",
        },
      ],
      agentCaps: {
        "ada-id": {
          daily: { level: "agent", cap: 10_000, used: 1_234 },
          monthly: { level: "floor", cap: 90_000_000, used: 56_789 },
        },
      },
      agents: [
        agent("Ada", "manager"),
        agent("Linus", "coder"),
        agent("Grace", "reviewer"),
        agent("Radia", "qa", {
          aiProvider: "Gemini",
          model: "gemini-pro",
          modelOverride: "gemini-pro",
          enabled: false,
        }),
      ],
    });
    renderAt("/agent-settings?floor=web-shop");
    const agents = await card("Agents");
    const table = await agents.findByRole("table", {
      name: "Agents on web-shop",
    });
    await within(table).findByText("1,234 of 10,000");
    await within(table).findByText("86%");
    expect(
      within(table)
        .getAllByRole("row")
        .map((row) =>
          [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
        ),
    ).toEqual([
      [
        "Name",
        "Role",
        "AI Provider",
        "Model",
        "Status",
        "Context Usage",
        "Current issue",
        "Tokens today",
        "Tokens this month",
        "Gateway Key",
        "Actions",
      ],
      [
        "Ada",
        "Manager",
        "Claude",
        "claude-opus-5-5(default)",
        "Idle",
        "15%",
        "None",
        "1,234 of 10,000the Agent's own cap",
        "56,789 of 90,000,000the Floor's cap",
        "aio_gk_Ab12… · Never usedRotate",
        "EditAvatarRemoveThe Manager cannot be removed: every Floor has exactly one.",
      ],
      [
        "Linus",
        "Coder",
        "Claude",
        "claude-opus-5-5(default)",
        "Idle",
        "86%",
        "None",
        "0 of 5,000,000the office's cap",
        "0 of 100,000,000the office's cap",
        `aio_gk_Ab12… · Last used ${new Date("2026-10-09T09:30:00.000Z").toLocaleString()}Rotate`,
        "EditAvatarRemove",
      ],
      [
        "Grace",
        "Reviewerrequired reviewer",
        "Claude",
        "claude-opus-5-5(default)",
        "Idle",
        "—",
        "None",
        "0 of 5,000,000the office's cap",
        "0 of 100,000,000the office's cap",
        "None yetRotate",
        "EditAvatarRemove",
      ],
      [
        "Radia",
        "QA",
        "Gemini",
        "gemini-pro",
        "Idle · paused",
        "—",
        "None",
        "0 of 5,000,000the office's cap",
        "0 of 100,000,000the office's cap",
        "None yetRotate",
        "EditAvatarRemove",
      ],
    ]);
    // Coloured by band: green below 60%, red from 85%.
    expect(
      within(table)
        .getAllByTestId("context-usage")
        .map((cell) => cell.firstElementChild?.getAttribute("data-band")),
    ).toEqual(["green", "red", "none", "none"]);
    // No editor until one is asked for.
    expect(agents.queryByRole("form", { name: /^Edit / })).toBeNull();
  });

  it("rotates an Agent's Gateway Key", async () => {
    const { calls } = stubServer({
      floors: [floor()],
      agents: [agent("Ada", "manager")],
      gatewayKeys: [gatewayKey("ada-id")],
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const agents = await card("Agents");
    await agents.findByText(/aio_gk_Ab12/);
    await user.click(
      agents.getByRole("button", { name: "Rotate Ada's Gateway Key" }),
    );
    expect(await agents.findByText("aio_gk_New1…")).toBeTruthy();
    expect(agents.getByRole("row", { name: /Ada/ }).textContent).toContain(
      "Never used",
    );
    expect(calls).toContainEqual({
      url: "/api/floors/web-shop/agents/ada-id/gateway-key/rotate",
      method: "POST",
      body: {},
      csrf: session.csrfToken,
    });
  });

  it("sets the Floor's Fresh Start threshold, and an Agent's own over it (PRD FR-86)", async () => {
    const { calls } = stubServer({
      floors: [floor()],
      agents: [agent("Ada", "manager"), agent("Linus", "coder")],
    });
    const user = userEvent.setup();
    renderAt("/floor-settings/web-shop");
    const settings = await card("Settings");
    const floorWide = settings.getByLabelText<HTMLInputElement>(
      "Fresh Start threshold (%)",
    );
    expect(floorWide.value).toBe("85");
    await user.clear(floorWide);
    await user.type(floorWide, "80");
    await user.click(settings.getByRole("button", { name: "Save settings" }));
    expect((await settings.findByRole("status")).textContent).toBe("Saved.");

    // The Agents are in Agent Settings, a link away.
    await user.click(
      screen.getByRole("link", { name: /^Open .+'s Agent Settings$/ }),
    );
    const agents = await card("Agents");
    await user.click(await agents.findByRole("button", { name: "Edit Linus" }));
    const form = within(agents.getByRole("form", { name: "Edit Linus" }));
    const own = form.getByLabelText<HTMLInputElement>(
      "Fresh Start threshold (%)",
    );
    // Empty: the Floor's.
    expect(own.value).toBe("");
    await user.type(own, "70");
    await user.click(form.getByRole("button", { name: "Save Linus" }));
    await form.findByRole("status");

    expect(changes(calls)).toEqual([
      {
        url: "/api/floors/web-shop",
        method: "PATCH",
        body: { freshStartThreshold: 80 },
        csrf: session.csrfToken,
      },
      {
        url: "/api/floors/web-shop/agents/linus-id",
        method: "PATCH",
        body: { freshStartThreshold: 70 },
        csrf: session.csrfToken,
      },
    ]);
  });

  it("edits an Agent's AI Provider, Model, effort, instructions and status", async () => {
    const { calls } = stubServer({
      floors: [floor()],
      agents: [
        agent("Ada", "manager"),
        agent("Linus", "coder", {
          avatar: { ...randomAvatar(), presentation: "female" },
        }),
      ],
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const agents = await card("Agents");
    await user.click(await agents.findByRole("button", { name: "Edit Linus" }));
    const form = within(agents.getByRole("form", { name: "Edit Linus" }));
    // Pronouns follow the Avatar's presentation (FR-14).
    expect(
      form.getByText(/Changes apply from her next task; work she has started/),
    ).toBeTruthy();
    expect(
      form.getByText("While paused, no new work goes to her."),
    ).toBeTruthy();

    // Gemini and the rest have no default Model, so cannot be chosen yet;
    // any AI Provider always can.
    const provider = form.getByLabelText<HTMLSelectElement>("AI Provider");
    expect(
      [...provider.options].map((option) => [option.text, option.disabled]),
    ).toEqual([
      ["Any AI Provider", false],
      ["Claude", false],
      ["ChatGPT (no default Model yet)", true],
      ["Grok", false],
      ["Gemini (no default Model yet)", true],
      ["OpenRouter (no default Model yet)", true],
      ["DeepSeek (no default Model yet)", true],
      ["Z.ai (no default Model yet)", true],
      ["Minimax (no default Model yet)", true],
      ["Kimi (no default Model yet)", true],
      ["Qwen (no default Model yet)", true],
      ["Ollama (no default Model yet)", true],
      ["Anthropic-compatible (no default Model yet)", true],
      ["OpenAI-compatible (no default Model yet)", true],
    ]);
    // It says why, and where to choose one.
    expect(provider.getAttribute("aria-describedby")).not.toBeNull();
    expect(
      form.getByText(/An AI Provider is offered once it has a default Model/),
    ).toBeTruthy();
    expect(
      form.getByRole("link", { name: "AI Settings" }).getAttribute("href"),
    ).toBe("/ai-settings");
    const model = form.getByLabelText<HTMLSelectElement>("Model");
    await user.selectOptions(model, "claude-sonnet-5-5");
    await user.selectOptions(form.getByLabelText("Effort"), "high");

    // Grok: its own Models, and no effort.
    await user.selectOptions(provider, "Grok");
    expect([...model.options].map((option) => option.text)).toEqual([
      "Default (grok-4)",
      "grok-4",
      "grok-4-fast",
    ]);
    expect(model.value).toBe("");
    const effort = form.getByLabelText<HTMLSelectElement>("Effort");
    expect(effort.disabled).toBe(true);
    expect(
      form.getByText("Grok's agent tool takes no effort level."),
    ).toBeTruthy();
    await user.selectOptions(model, "grok-4-fast");
    await user.type(
      form.getByLabelText("Extra instructions"),
      "Keep diffs small.",
    );
    await user.selectOptions(form.getByLabelText("Status"), "paused");
    await user.click(form.getByRole("button", { name: "Save Linus" }));

    expect((await form.findByRole("status")).textContent).toBe(
      "Saved. Linus uses the changes from her next task.",
    );
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors/web-shop/agents/linus-id",
        method: "PATCH",
        body: {
          aiProvider: "Grok",
          modelOverride: "grok-4-fast",
          extraInstructions: "Keep diffs small.",
          enabled: false,
        },
        csrf: session.csrfToken,
      },
    ]);
    const row = agents.getByRole("row", { name: /Linus/ });
    await within(row).findByText("Grok");
    expect(row.textContent).toContain("grok-4-fast");
    expect(row.textContent).toContain("Idle · paused");
  });

  it("opens an Agent's editor from the address, as its card links to its config (PRD FR-63)", async () => {
    stubServer({
      floors: [floor()],
      agents: [agent("Ada", "manager"), agent("Linus", "coder")],
    });
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    // The old address, under Admin, keeps the Agent as it sends it on.
    renderAt("/admin/floors/web-shop?agent=linus-id");
    const agents = await card("Agents");
    expect(
      await agents.findByRole("form", { name: "Edit Linus" }),
    ).toBeTruthy();
    expect(
      agents
        .getByRole("button", { name: "Edit Linus" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(agents.queryByRole("form", { name: "Edit Ada" })).toBeNull();
    // Brought into view, below the table.
    await waitFor(() => {
      expect(scrolled).toHaveBeenCalled();
    });
    cleanup();

    // An Agent not on the Floor opens nothing.
    renderAt("/floor-settings/web-shop?agent=nobody");
    const others = await card("Agents");
    await others.findByRole("button", { name: "Edit Linus" });
    expect(others.queryByRole("form", { name: /^Edit / })).toBeNull();
  });

  it("says why an Agent's changes were refused, and closes the editor", async () => {
    stubServer({
      floors: [floor()],
      agents: [
        agent("Ada", "manager", {
          avatar: { ...randomAvatar(), presentation: "androgynous" },
        }),
        agent("Linus", "coder"),
      ],
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const agents = await card("Agents");
    await user.click(await agents.findByRole("button", { name: "Edit Ada" }));
    const form = within(agents.getByRole("form", { name: "Edit Ada" }));
    expect(
      form.getByText("While paused, no new work goes to them."),
    ).toBeTruthy();
    const name = form.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Linus");
    await user.click(form.getByRole("button", { name: "Save Ada" }));
    expect((await form.findByRole("alert")).textContent).toBe(
      "An Agent on web-shop is already called Linus.",
    );
    await user.clear(name);
    await user.click(form.getByRole("button", { name: "Save Ada" }));
    expect((await form.findByRole("alert")).textContent).toBe(
      "Name the Agent.",
    );

    await user.click(form.getByRole("button", { name: "Close" }));
    expect(agents.queryByRole("form", { name: /^Edit / })).toBeNull();
  });

  it("sets an Agent's own Token Caps, showing its use against the cap in force", async () => {
    const { calls } = stubServer({
      floors: [floor()],
      agents: [agent("Ada", "manager"), agent("Linus", "coder")],
      agentCaps: {
        "linus-id": {
          daily: { level: "floor", cap: 800_000, used: 1_234 },
          monthly: { level: "office", cap: 100_000_000, used: 56_789 },
        },
      },
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const agents = await card("Agents");
    await user.click(await agents.findByRole("button", { name: "Edit Linus" }));
    const form = within(agents.getByRole("form", { name: "Edit Linus" }));
    expect(
      await form.findByText(
        "Used today: 1,234 of 800,000, the Floor's cap. Empty uses the Floor's or the office's.",
      ),
    ).toBeTruthy();
    expect(
      form.getByText(
        "Used this month: 56,789 of 100,000,000, the office's cap. Empty uses the Floor's or the office's.",
      ),
    ).toBeTruthy();
    await user.type(form.getByLabelText("Daily Token Cap"), "250000");
    await user.click(form.getByRole("button", { name: "Save Linus" }));
    await form.findByRole("status");
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors/web-shop/agents/linus-id",
        method: "PATCH",
        body: { tokenCaps: { daily: 250_000, monthly: null } },
        csrf: session.csrfToken,
      },
    ]);

    // Not a whole number of tokens: refused before sending.
    await user.type(form.getByLabelText("Monthly Token Cap"), "0");
    await user.click(form.getByRole("button", { name: "Save Linus" }));
    expect((await form.findByRole("alert")).textContent).toBe(
      "A Token Cap must be more than 0 tokens.",
    );
    expect(changes(calls)).toHaveLength(1);
  });

  it("sets and removes an issue's Token Caps in the Floor's token usage", async () => {
    const { calls } = stubServer({
      floors: [floor()],
      agents: [agent("Ada", "manager")],
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const usage = await card("Token usage");
    expect(
      await usage.findByText(
        "Each Agent here may use 5,000,000 (the office's) a day and 100,000,000 (the office's) a month, unless it has its own cap.",
      ),
    ).toBeTruthy();
    const form = within(usage.getByRole("form", { name: "Issue Token Caps" }));
    await user.type(form.getByLabelText("Issue"), "7");
    await user.type(form.getByLabelText("Issue daily cap"), "50000");
    await user.click(form.getByRole("button", { name: "Save issue caps" }));
    expect((await form.findByRole("status")).textContent).toBe(
      "Saved #7's caps.",
    );
    const row = await usage.findByRole("row", { name: /#7/ });
    expect(row.textContent).toBe("#70 of 50,0000 (no cap)");
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors/web-shop/issues/7/token-caps",
        method: "PUT",
        body: { daily: 50_000, monthly: null },
        csrf: session.csrfToken,
      },
    ]);

    await user.type(form.getByLabelText("Issue"), "7");
    await user.click(form.getByRole("button", { name: "Save issue caps" }));
    expect((await form.findByRole("status")).textContent).toBe(
      "#7 has no caps of its own now.",
    );
    await vi.waitFor(() => {
      expect(usage.queryByRole("row", { name: /#7/ })).toBeNull();
    });

    await user.click(form.getByRole("button", { name: "Save issue caps" }));
    expect((await form.findByRole("alert")).textContent).toBe(
      "Name the issue by its number.",
    );
  });

  it("offers no editor on an archived Floor: Agent Settings lists only Floors in use", async () => {
    stubServer({
      floors: [floor({ archivedAt: "2026-10-09T08:00:00.000Z" })],
      agents: [agent("Ada", "manager")],
    });
    renderAt("/agent-settings?floor=web-shop");
    expect((await screen.findByRole("alert")).textContent).toBe(
      'There is no Floor "web-shop".',
    );
    expect(screen.queryByRole("button", { name: "Edit Ada" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Add an Agent" })).toBeNull();
  });

  it("shows each Agent's status and current issue, from the Floor's wall board (PRD FR-12)", async () => {
    stubServer({
      floors: [floor()],
      agents: [
        agent("Ada", "manager"),
        agent("Linus", "coder"),
        agent("Grace", "reviewer"),
      ],
      wallBoard: {
        issues: [
          {
            issue: 7,
            url: "https://github.com/adrianeyre/web-shop/issues/7",
            stage: "needs-work",
            status: "working",
            agentIds: ["linus-id"],
            pullRequest: null,
            reviewRounds: 0,
            qaRounds: 0,
          },
        ],
        agents: [
          {
            agentId: "linus-id",
            waiting: 2,
            awaitingReview: [],
            capped: false,
          },
        ],
      },
    });
    renderAt("/agent-settings?floor=web-shop");
    const agents = await card("Agents");
    const linus = await agents.findByRole("row", { name: /Linus/ });
    await waitFor(() => {
      expect(within(linus).getByTestId("agent-status").textContent).toBe(
        "Working · 2 tasks wait",
      );
    });
    const issue = within(linus).getByRole("link", { name: /#7/ });
    expect(issue.getAttribute("href")).toBe(
      "https://github.com/adrianeyre/web-shop/issues/7",
    );
    expect(linus.textContent).toContain("#7WorkWorking");
    const grace = agents.getByRole("row", { name: /Grace/ });
    expect(within(grace).getByTestId("agent-status").textContent).toBe("Idle");
    expect(grace.textContent).toContain("None");
  });

  it("adds an Agent in a Role, copied from its first, then opens its editor (§5 scenario 7)", async () => {
    const { calls } = stubServer({
      floors: [floor()],
      agents: [agent("Ada", "manager"), agent("Linus", "coder")],
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const agents = await card("Agents");
    const form = within(
      await agents.findByRole("form", { name: "Add an Agent" }),
    );
    // Any Role but the Manager's.
    expect(
      form
        .getAllByRole("option")
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(["coder", "reviewer", "qa", "docs", "designer"]);
    await user.type(form.getByLabelText("Name"), "Hopper");
    await user.click(form.getByRole("button", { name: "Add Agent" }));

    expect(
      await agents.findByRole("form", { name: "Edit Hopper" }),
    ).toBeTruthy();
    expect(
      agents.getByText(
        "Added Hopper, a coder Agent. Choose its AI Provider and Model below.",
      ),
    ).toBeTruthy();
    expect(agents.getByRole("row", { name: /Hopper/ }).textContent).toContain(
      "Coder",
    );
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors/web-shop/agents",
        method: "POST",
        body: { role: "coder", name: "Hopper" },
        csrf: "csrf-token-1",
      },
    ]);

    // Without a name, the API picks one.
    await user.selectOptions(form.getByLabelText("Role"), "designer");
    await user.click(form.getByRole("button", { name: "Add Agent" }));
    await agents.findByRole("form", { name: "Edit New 2" });
    expect(changes(calls).at(-1)?.body).toEqual({ role: "designer" });
  });

  it("offers every Role in the library, the Owner's own too, in Add Agent and the Team card (PRD FR-98)", async () => {
    const copywriter: LibraryRole = {
      id: "copywriter",
      name: "copywriter",
      stage: "work",
      description: "Writes the product copy.",
      instructions: "- Write in the brand's voice.",
      skills: [],
      deskDressing: "books",
      aiProvider: "Claude",
      model: null,
      agents: 1,
      inStartingTeam: false,
    };
    const library = builtInRoles
      .filter(({ id }) => id !== "designer")
      .map((role) => ({
        ...role,
        agents: 0,
        inStartingTeam: defaultTeamRoles.includes(role.id),
      }));
    const { calls } = stubServer({
      floors: [floor()],
      agents: [
        agent("Ada", "manager"),
        agent("Linus", "coder"),
        agent("Cora", "copywriter", { stage: "work" }),
      ],
      roles: [...library, copywriter],
      sandboxLimit: 1,
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const agents = await card("Agents");
    expect(
      (await agents.findByRole("row", { name: /Cora/ })).textContent,
    ).toContain("Copywriter");
    const form = within(
      await agents.findByRole("form", { name: "Add an Agent" }),
    );
    // The library's Roles, in its order; a deleted one is not offered.
    await waitFor(() => {
      expect(
        form
          .getAllByRole("option")
          .map((option) => [
            (option as HTMLOptionElement).value,
            option.textContent,
          ]),
      ).toEqual([
        ["coder", "Coder"],
        ["reviewer", "Reviewer"],
        ["qa", "QA"],
        ["docs", "Docs"],
        ["copywriter", "Copywriter"],
      ]);
    });
    await user.selectOptions(form.getByLabelText("Role"), "copywriter");
    await user.type(form.getByLabelText("Name"), "Cass");
    await user.click(form.getByRole("button", { name: "Add Agent" }));
    expect(
      await agents.findByText(
        "Added Cass, a copywriter Agent. Choose its AI Provider and Model below.",
      ),
    ).toBeTruthy();
    expect(changes(calls).at(-1)).toMatchObject({
      url: "/api/floors/web-shop/agents",
      body: { role: "copywriter", name: "Cass" },
    });

    // The Team card counts it, and its work-Stage Agents run in sandboxes.
    const team = await card("Team");
    await waitFor(() => {
      expect(team.getByLabelText<HTMLInputElement>("Copywriter").value).toBe(
        "2",
      );
    });
    expect(team.queryByLabelText("Designer")).toBeNull();
    expect((await team.findByRole("status")).textContent).toContain(
      "web-shop would have 3 sandbox Agents (in the work, QA and docs Stages), but at most 1 sandbox runs at once",
    );
  });

  it("removes an Agent after asking; a busy one leaves once its task ends; never the Manager", async () => {
    const { calls } = stubServer({
      floors: [floor()],
      agents: [
        agent("Ada", "manager"),
        agent("Linus", "coder"),
        agent("Grace", "qa"),
      ],
      busy: ["grace-id"],
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const agents = await card("Agents");

    const manager = await agents.findByRole("button", { name: "Remove Ada" });
    expect((manager as HTMLButtonElement).disabled).toBe(true);
    expect(
      document.getElementById(manager.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("The Manager cannot be removed: every Floor has exactly one.");

    await user.click(agents.getByRole("button", { name: "Remove Linus" }));
    // Nothing is sent until the Owner confirms.
    expect(changes(calls)).toEqual([]);
    await user.click(agents.getByRole("button", { name: "Cancel" }));
    await user.click(agents.getByRole("button", { name: "Remove Linus" }));
    await user.click(agents.getByRole("button", { name: "Remove Linus" }));
    expect(await agents.findByText("Linus was removed.")).toBeTruthy();
    await waitFor(() => {
      expect(agents.queryByRole("row", { name: /Linus/ })).toBeNull();
    });

    await user.click(agents.getByRole("button", { name: "Remove Grace" }));
    await user.click(agents.getByRole("button", { name: "Remove Grace" }));
    expect(
      await agents.findByText(
        "Grace is in the middle of a task, and leaves once it ends.",
      ),
    ).toBeTruthy();
    const grace = agents.getByRole("row", { name: /Grace/ });
    await waitFor(() => {
      expect(within(grace).getByTestId("agent-status").textContent).toBe(
        "Idle · leaving once its task ends",
      );
    });
    // Leaving already: nothing more to remove.
    expect(within(grace).queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(changes(calls)).toEqual(
      ["linus-id", "grace-id"].map((id) => ({
        url: `/api/floors/web-shop/agents/${id}`,
        method: "DELETE",
        body: undefined,
        csrf: "csrf-token-1",
      })),
    );
  });

  it("sets a Role's team size, and warns when sandbox Agents outnumber the concurrency limit (PRD FR-10)", async () => {
    const { calls } = stubServer({
      floors: [floor()],
      agents: [
        agent("Ada", "manager"),
        agent("Linus", "coder"),
        agent("Grace", "reviewer"),
        agent("Radia", "qa"),
      ],
      sandboxLimit: 3,
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const team = await card("Team");
    const coders = await team.findByLabelText<HTMLInputElement>("Coder");
    expect(
      ["Manager", "Coder", "Reviewer", "QA", "Docs", "Designer"].map(
        (role) => team.getByLabelText<HTMLInputElement>(role).value,
      ),
    ).toEqual(["1", "1", "1", "1", "0", "0"]);
    // The Manager is fixed at 1.
    expect(team.getByLabelText<HTMLInputElement>("Manager").readOnly).toBe(
      true,
    );
    // Two sandbox Agents, three sandboxes: no warning.
    expect(team.queryByRole("status")).toBeNull();

    await user.clear(coders);
    await user.type(coders, "3");
    // Four sandbox Agents, three sandboxes: warned before saving.
    expect((await team.findByRole("status")).textContent).toContain(
      "web-shop would have 4 sandbox Agents (in the work, QA and docs Stages), but at most 3 sandboxes run at once under the office's concurrency limit. The rest wait their turn.",
    );
    await user.click(team.getByRole("button", { name: "Save team" }));

    expect(
      await team.findByText(
        "Added New 1 and New 2, copied from the first coder.",
      ),
    ).toBeTruthy();
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors/web-shop/team/coder",
        method: "PUT",
        body: { count: 3 },
        csrf: "csrf-token-1",
      },
    ]);
    const agents = await card("Agents");
    await agents.findByRole("row", { name: /New 2/ });
    await waitFor(() => {
      expect(team.getByLabelText<HTMLInputElement>("Coder").value).toBe("3");
    });
    // Still more than can run at once.
    expect(
      team.getByText(/Not every sandbox Agent can work at once/),
    ).toBeTruthy();

    // Down to 1 again.
    const after = team.getByLabelText("Coder");
    await user.clear(after);
    await user.type(after, "1");
    expect(team.queryByText(/Not every sandbox Agent/)).toBeNull();
    await user.click(team.getByRole("button", { name: "Save team" }));
    expect(await team.findByText("Removed New 2 and New 1.")).toBeTruthy();
  });

  it("lets a Role have more than 10 Agents, within the Floor's most Agents (PRD FR-10)", async () => {
    const { calls } = stubServer({
      floors: [floor({ mostAgents: 13 })],
      agents: [
        agent("Ada", "manager"),
        agent("Linus", "coder"),
        agent("Grace", "reviewer"),
        agent("Radia", "qa"),
      ],
      sandboxLimit: 50,
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const team = await card("Team");
    const coders = await team.findByLabelText<HTMLInputElement>("Coder");
    // The reviewer and the QA Agent leave room for 11 coders.
    expect(coders.max).toBe("11");
    await user.clear(coders);
    await user.type(coders, "12");
    await user.click(team.getByRole("button", { name: "Save team" }));
    expect((await team.findByRole("alert")).textContent).toContain(
      "web-shop may have at most 13 Agents besides its Manager, and these numbers make 14",
    );
    expect(changes(calls)).toEqual([]);

    await user.clear(coders);
    await user.type(coders, "11");
    await user.click(team.getByRole("button", { name: "Save team" }));
    await team.findByText(/^Added New 1/);
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors/web-shop/team/coder",
        method: "PUT",
        body: { count: 11 },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("has no limit on a Role with the Floor's most Agents off", async () => {
    stubServer({
      floors: [floor({ mostAgents: null })],
      agents: [agent("Ada", "manager"), agent("Linus", "coder")],
    });
    renderAt("/agent-settings?floor=web-shop");
    const team = await card("Team");
    expect((await team.findByLabelText<HTMLInputElement>("Coder")).max).toBe(
      "1000",
    );
    expect(
      team.getByText(/This Floor has no limit on its Agents\./),
    ).toBeTruthy();
  });

  it("marks a Contractor and keeps it on the team (ADR 0004)", async () => {
    const { calls } = stubServer({
      floors: [floor()],
      agents: [
        agent("Ada", "manager"),
        agent("Linus", "coder"),
        agent("Migration writer", "contractor-1a2b3c4d5e", {
          id: "migration-writer",
          stage: "work",
          contractor: {
            kind: "work",
            batchId: 4,
            oneOffRole: {
              name: "Migration writer",
              description: "Writes database migrations.",
            },
          },
        }),
        agent("Coder 2", "coder", {
          contractor: { kind: "work", batchId: 4, oneOffRole: null },
          leavingAt: "2026-10-09T09:00:00.000Z",
        }),
      ],
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const agents = await card("Agents");
    const row = await agents.findByRole("row", { name: /Migration writer/ });
    expect(within(row).getByText("Contractor, Batch 4")).toBeTruthy();
    // A leaving Contractor cannot be kept; an ordinary Agent is not one.
    expect(
      agents.queryByRole("button", { name: "Keep Coder 2 on the team" }),
    ).toBeNull();
    expect(
      agents.queryByRole("button", { name: "Keep Linus on the team" }),
    ).toBeNull();

    await user.click(
      within(row).getByRole("button", {
        name: "Keep Migration writer on the team",
      }),
    );
    expect(
      await agents.findByText(
        "Migration writer is on the team now, and stays.",
      ),
    ).toBeTruthy();
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors/web-shop/agents/migration-writer/keep",
        method: "POST",
        body: {},
        csrf: "csrf-token-1",
      },
    ]);
    await waitFor(() => {
      expect(within(row).queryByText("Contractor, Batch 4")).toBeNull();
    });
  });

  it("warns against the Floor's own concurrency limit when it is lower", async () => {
    stubServer({
      floors: [floor({ concurrencyLimit: 1 })],
      agents: [
        agent("Ada", "manager"),
        agent("Linus", "coder"),
        agent("Radia", "qa"),
      ],
      sandboxLimit: 3,
    });
    renderAt("/agent-settings?floor=web-shop");
    const team = await card("Team");
    expect((await team.findByRole("status")).textContent).toContain(
      "web-shop would have 2 sandbox Agents (in the work, QA and docs Stages), but at most 1 sandbox runs at once under this Floor's concurrency limit.",
    );
  });

  it("chooses the Floor's required reviewers among its review-Stage Agents (PRD FR-27)", async () => {
    const { calls } = stubServer({
      floors: [floor({ requiredReviewerAgentIds: ["grace-id"] })],
      agents: [
        agent("Ada", "manager"),
        agent("Grace", "reviewer"),
        agent("Rex", "reviewer", { aiProvider: "Grok", model: "grok-4" }),
        agent("Bea", "brand-reviewer", { stage: "review" }),
        agent("Cora", "copywriter", { stage: "work" }),
      ],
    });
    const user = userEvent.setup();
    renderAt("/floor-settings/web-shop");
    const settings = await card("Settings");
    const grace = await settings.findByLabelText<HTMLInputElement>(
      "Grace (Claude claude-opus-5-5)",
    );
    const rex = settings.getByLabelText<HTMLInputElement>("Rex (Grok grok-4)");
    expect([grace.checked, rex.checked]).toEqual([true, false]);
    // Any review-Stage Agent, whatever its Role is called; never another.
    expect(
      settings.getByLabelText<HTMLInputElement>("Bea (Claude claude-opus-5-5)")
        .checked,
    ).toBe(false);
    expect(settings.queryByLabelText(/^Cora /)).toBeNull();

    await user.click(rex);
    await user.click(settings.getByRole("button", { name: "Save settings" }));
    expect((await settings.findByRole("status")).textContent).toBe("Saved.");
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors/web-shop",
        method: "PATCH",
        body: { requiredReviewerAgentIds: ["grace-id", "rex-id"] },
        csrf: "csrf-token-1",
      },
    ]);

    // None is refused before it is sent.
    await user.click(settings.getByLabelText("Grace (Claude claude-opus-5-5)"));
    await user.click(settings.getByLabelText("Rex (Grok grok-4)"));
    await user.click(settings.getByRole("button", { name: "Save settings" }));
    expect((await settings.findByRole("alert")).textContent).toBe(
      "Choose at least one required reviewer.",
    );
    expect(changes(calls)).toHaveLength(1);
  });

  /** A man with short black hair, a navy hoodie and a cactus. */
  const plainAvatar: Avatar = {
    version: 1,
    presentation: "male",
    bodyShape: "average",
    face: "oval",
    hairstyle: "short",
    hairColour: "#1c1c1c",
    skinTone: "#8d5524",
    facialHair: "none",
    glasses: "none",
    accessories: [],
    outfit: {
      style: "hoodie",
      primaryColour: "#1f3a5f",
      secondaryColour: "#2b2b2b",
    },
    deskMascot: "cactus",
    deskItems: [],
  };

  it("edits every part of an Agent's Avatar, and saves the Avatar alone", async () => {
    const { calls, state } = stubServer({
      floors: [floor()],
      agents: [
        agent("Ada", "manager"),
        agent("Linus", "coder", { avatar: plainAvatar }),
      ],
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const agents = await card("Agents");
    await user.click(
      await agents.findByRole("button", { name: "Open Linus's Avatar Editor" }),
    );
    const form = within(agents.getByRole("form", { name: "Linus's Avatar" }));
    expect(
      form.getByText(
        /How Linus looks in the Office\. It never changes how he works/,
      ),
    ).toBeTruthy();
    // jsdom has no WebGL.
    expect(
      form.getByText(
        "This browser cannot show the preview: it has no WebGL 2.",
      ),
    ).toBeTruthy();
    const save = form.getByRole<HTMLButtonElement>("button", {
      name: "Save Linus's Avatar",
    });
    expect(save.disabled).toBe(true);

    // Every option of FR-13.
    const options = (label: string) =>
      [...form.getByLabelText<HTMLSelectElement>(label).options].map(
        ({ text }) => text,
      );
    const choices = (group: string) =>
      within(form.getByRole("group", { name: group }))
        .getAllByRole("radio")
        .map(
          (radio) =>
            radio.getAttribute("aria-label") ??
            radio.parentElement?.textContent,
        );
    expect(choices("Sex")).toEqual([
      "Male (he)",
      "Female (she)",
      "Androgynous (they)",
    ]);
    expect(options("Body shape")).toEqual([
      "Slim",
      "Average",
      "Broad",
      "Curvy",
    ]);
    expect(options("Face")).toEqual([
      "Oval",
      "Round",
      "Square",
      "Heart",
      "Long",
    ]);
    expect(options("Hairstyle")).toHaveLength(10);
    expect(options("Facial hair")).toEqual([
      "None",
      "Stubble",
      "Moustache",
      "Beard",
      "Goatee",
    ]);
    expect(options("Glasses")).toEqual(["None", "Round", "Square", "Cat-eye"]);
    expect(options("Outfit")).toEqual([
      "Hoodie",
      "Shirt",
      "Blazer",
      "T-shirt",
      "Sweater",
      "Dress",
      "Overalls",
    ]);
    expect(options("Desk mascot")).toEqual([
      "Cactus",
      "Rubber duck",
      "Robot",
      "Cat",
      "Bonsai",
      "Dinosaur",
    ]);
    expect(choices("Hair colour")).toHaveLength(10);
    expect(choices("Skin tone")).toHaveLength(8);
    expect(choices("Outfit colour")).toHaveLength(10);
    expect(choices("Outfit's second colour")).toHaveLength(10);
    expect(
      within(form.getByRole("group", { name: "Accessories" }))
        .getAllByRole("checkbox")
        .map((box) => box.parentElement?.textContent),
    ).toEqual(["Headphones", "Earrings", "Watch", "Scarf", "Cap"]);
    // Each colour is named, and the Avatar's own is the one chosen.
    const black = within(
      form.getByRole("group", { name: "Hair colour" }),
    ).getByRole<HTMLInputElement>("radio", { name: "Black" });
    expect(black.checked).toBe(true);

    await user.click(form.getByRole("radio", { name: "Female (she)" }));
    expect(form.getByText(/It never changes how she works/)).toBeTruthy();
    await user.selectOptions(form.getByLabelText("Body shape"), "curvy");
    await user.selectOptions(form.getByLabelText("Face"), "heart");
    await user.selectOptions(form.getByLabelText("Hairstyle"), "ponytail");
    await user.click(
      within(form.getByRole("group", { name: "Hair colour" })).getByRole(
        "radio",
        {
          name: "Blue",
        },
      ),
    );
    await user.click(
      within(form.getByRole("group", { name: "Skin tone" })).getByRole(
        "radio",
        {
          name: "Fair",
        },
      ),
    );
    await user.selectOptions(form.getByLabelText("Facial hair"), "stubble");
    await user.selectOptions(form.getByLabelText("Glasses"), "cat-eye");
    const accessories = within(
      form.getByRole("group", { name: "Accessories" }),
    );
    await user.click(accessories.getByRole("checkbox", { name: "Cap" }));
    await user.click(accessories.getByRole("checkbox", { name: "Headphones" }));
    await user.selectOptions(form.getByLabelText("Outfit"), "overalls");
    await user.click(
      within(form.getByRole("group", { name: "Outfit colour" })).getByRole(
        "radio",
        { name: "Mustard" },
      ),
    );
    await user.click(
      within(
        form.getByRole("group", { name: "Outfit's second colour" }),
      ).getByRole("radio", { name: "Cream" }),
    );
    await user.selectOptions(form.getByLabelText("Desk mascot"), "rubber-duck");
    // Thirty things for the desk, up to five of them, in the order chosen.
    const onDesk = within(form.getByRole("group", { name: "On the desk" }));
    const items = onDesk.getAllByRole<HTMLInputElement>("checkbox");
    expect(items).toHaveLength(30);
    expect(
      items.slice(0, 4).map((box) => box.parentElement?.textContent),
    ).toEqual(["Laptop", "Pen", "Pencil", "Paper"]);
    for (const name of [
      "Coffee mug",
      "Laptop",
      "Ruler",
      "Pen",
      "Paper",
      "Globe",
    ]) {
      await user.click(onDesk.getByRole("checkbox", { name }));
    }
    await user.click(onDesk.getByRole("checkbox", { name: "Pen" }));
    await user.click(onDesk.getByRole("checkbox", { name: "Desk lamp" }));
    expect(onDesk.getByText(/5 of 5/)).toBeTruthy();
    // Full, the rest cannot be ticked.
    expect(
      onDesk.getByRole<HTMLInputElement>("checkbox", { name: "Apple" })
        .disabled,
    ).toBe(true);
    expect(save.disabled).toBe(false);
    await user.click(save);

    const avatar: Avatar = {
      version: 1,
      presentation: "female",
      bodyShape: "curvy",
      face: "heart",
      hairstyle: "ponytail",
      hairColour: "#2e6fd8",
      skinTone: "#ffdbac",
      facialHair: "stubble",
      glasses: "cat-eye",
      // In the kit's order, whatever order they were ticked in.
      accessories: ["headphones", "cap"],
      outfit: {
        style: "overalls",
        primaryColour: "#d98e04",
        secondaryColour: "#e8e4da",
      },
      deskMascot: "rubber-duck",
      deskItems: ["coffee-mug", "laptop", "ruler", "paper", "desk-lamp"],
    };
    expect((await form.findByRole("status")).textContent).toBe(
      "Saved. The Office shows Linus's new look; it never changes how she works.",
    );
    expect(changes(calls)).toEqual([
      {
        url: "/api/floors/web-shop/agents/linus-id",
        method: "PATCH",
        body: { avatar },
        csrf: session.csrfToken,
      },
    ]);
    expect(state.agents.find(({ id }) => id === "linus-id")?.avatar).toEqual(
      avatar,
    );
    expect(save.disabled).toBe(true);

    // The Agent editor speaks of her as she now, too (FR-14).
    await user.click(agents.getByRole("button", { name: "Edit Linus" }));
    expect(
      await within(agents.getByRole("form", { name: "Edit Linus" })).findByText(
        "While paused, no new work goes to her.",
      ),
    ).toBeTruthy();
  });

  it("randomises an Avatar unlike the Floor's others, and resets it to the saved one", async () => {
    const others = [
      agent("Ada", "manager"),
      agent("Grace", "reviewer"),
      agent("Radia", "qa"),
    ];
    const { calls } = stubServer({
      floors: [floor()],
      agents: [...others, agent("Linus", "coder", { avatar: plainAvatar })],
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const agents = await card("Agents");
    await user.click(
      await agents.findByRole("button", { name: "Open Linus's Avatar Editor" }),
    );
    const form = within(agents.getByRole("form", { name: "Linus's Avatar" }));
    const reset = form.getByRole<HTMLButtonElement>("button", {
      name: "Reset",
    });
    expect(reset.disabled).toBe(true);

    await user.click(form.getByRole("button", { name: "Randomise" }));
    expect(reset.disabled).toBe(false);
    await user.click(reset);
    expect(reset.disabled).toBe(true);
    expect(
      within(
        form.getByRole("group", { name: "Hair colour" }),
      ).getByRole<HTMLInputElement>("radio", { name: "Black" }).checked,
    ).toBe(true);
    expect(form.getByLabelText<HTMLSelectElement>("Outfit").value).toBe(
      "hoodie",
    );

    for (let round = 0; round < 5; round += 1) {
      await user.click(form.getByRole("button", { name: "Randomise" }));
      await user.click(
        form.getByRole("button", { name: "Save Linus's Avatar" }),
      );
      await form.findByRole("status");
    }
    const saved = changes(calls).map(
      ({ body }) => (body as { avatar: Avatar }).avatar,
    );
    expect(saved).toHaveLength(5);
    for (const [index, avatar] of saved.entries()) {
      // Unlike every other Agent on the Floor, and unlike the look before.
      for (const other of [
        ...others.map((each) => each.avatar),
        saved[index - 1] ?? plainAvatar,
      ]) {
        expect(lookDistinct(avatar, other)).toBe(true);
      }
    }
  });

  it("shows the draft in a preview that turns, live, before it is saved", async () => {
    vi.spyOn(webgl, "available").mockReturnValue(true);
    stubServer({
      floors: [floor()],
      agents: [agent("Linus", "coder", { avatar: plainAvatar })],
    });
    const user = userEvent.setup();
    renderAt("/agent-settings?floor=web-shop");
    const agents = await card("Agents");
    await user.click(
      await agents.findByRole("button", { name: "Open Linus's Avatar Editor" }),
    );
    const form = within(agents.getByRole("form", { name: "Linus's Avatar" }));
    expect(
      form.getByRole("img", {
        name: "A preview of Linus's Avatar, as it stands now",
      }),
    ).toBeTruthy();
    const preview = await form.findByTestId("avatar-preview");
    expect(preview.dataset).toMatchObject({
      turn: "0.0000",
      hair: "#1c1c1c",
      outfit: "hoodie",
    });

    await user.click(
      within(form.getByRole("group", { name: "Hair colour" })).getByRole(
        "radio",
        {
          name: "Pink",
        },
      ),
    );
    await user.selectOptions(form.getByLabelText("Outfit"), "blazer");
    expect(preview.dataset).toMatchObject({
      hair: "#d64f8f",
      outfit: "blazer",
    });

    // A press turns it 30°, from the keyboard too.
    await user.click(
      form.getByRole("button", { name: "Turn the preview right" }),
    );
    expect(preview.dataset["turn"]).toBe((Math.PI / 6).toFixed(4));
    form.getByRole("button", { name: "Turn the preview left" }).focus();
    await user.keyboard("{Enter}{Enter}");
    expect(preview.dataset["turn"]).toBe((-Math.PI / 6).toFixed(4));
  });

  it("says when there is no such Floor", async () => {
    stubServer();
    renderAt("/floor-settings/nowhere");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "There is no Floor here.",
    );
  });
});
