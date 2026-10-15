import type { OfficeEvent } from "@ai-office/events";
import type { StreamedEvent } from "@ai-office/events/stream";
import {
  builtInRole,
  randomAvatar,
  type Agent,
  type OfficeMemory,
  type RepositoryMemoryView,
  type RoleMemoryEntry,
} from "@ai-office/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { eventSources, type EventSourceLike } from "./event-stream.ts";
import { floorInspectables } from "./scene/inspectable.ts";
import { InspectorPanel } from "./scene/inspector.tsx";

// A Floor's bookshelf (PRD FR-58, §6.10), against a stubbed server: its
// panel shows the repository's memory, the Floor's Role memory and the
// office-wide memory, with links to edit each, and changes live as memory
// events arrive.

const memoryText = "# Repository memory\n\n- Use pnpm, never npm.";

const agent = (id: string, name: string, role: Agent["role"]): Agent => ({
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
  avatar: randomAvatar(),
  tokenCaps: { daily: null, monthly: null },
  createdAt: "2026-10-08T12:00:00.000Z",
  leavingAt: null,
  contractor: null,
});

const entry = (
  id: number,
  role: RoleMemoryEntry["role"],
  text: string,
  status: RoleMemoryEntry["status"],
): RoleMemoryEntry => ({
  id,
  role,
  text,
  status,
  issue: 4,
  agentId: "ada",
  createdAt: "2026-10-09T09:00:00.000Z",
  decidedBy: status === "proposed" ? null : "owner",
  decidedAt: status === "proposed" ? null : "2026-10-09T10:00:00.000Z",
  reason: null,
});

/** The server's memory, which a test may change. */
let server: {
  repository: RepositoryMemoryView | { status: number };
  roles: RoleMemoryEntry[];
  office: OfficeMemory;
};
let fetched: string[];

interface FakeStream extends Omit<EventSourceLike, "readyState"> {
  readyState: number;
  readonly url: string;
  send(data: unknown): void;
}
let streams: FakeStream[];

const stored = (id: number, event: OfficeEvent): StreamedEvent => ({
  id,
  occurredAt: "2026-10-09T12:00:00.000Z",
  event,
});

beforeEach(() => {
  server = {
    repository: {
      repository: "adrianeyre/web-shop",
      branch: "main",
      content: memoryText,
      truncated: false,
      readError: null,
      proposals: [
        {
          id: 1,
          text: "Run pnpm build before pnpm test.",
          issue: 7,
          agentId: "ada",
          createdAt: "2026-10-09T10:00:00.000Z",
        },
      ],
      pullRequest: 12,
    },
    roles: [
      entry(1, "coder", "Write the failing test first.", "accepted"),
      entry(2, "coder", "Keep each commit to one change.", "proposed"),
      entry(3, "qa", "Run the tests twice.", "accepted"),
      entry(4, "qa", "A rejected lesson.", "rejected"),
    ],
    office: {
      content: "# Coding standards\n\n- Prefer zod.",
      updatedAt: "2026-10-09T08:00:00.000Z",
    },
  };
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      fetched.push(url);
      const json =
        url === "/api/floors/web-shop/repository-memory"
          ? server.repository
          : url === "/api/floors/web-shop/role-memory"
            ? { entries: server.roles }
            : url === "/api/memory/office"
              ? server.office
              : url === "/api/floors/web-shop/agents"
                ? { agents: [agent("ada", "Ada", "coder")] }
                : { status: 404 };
      return Promise.resolve(
        "status" in json
          ? Response.json(
              { error: "not_found", message: "Not here." },
              { status: json.status },
            )
          : Response.json(json),
      );
    }),
  );
  streams = [];
  vi.spyOn(eventSources, "open").mockImplementation((url) => {
    const source: FakeStream = {
      url,
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      close() {
        source.readyState = 2;
      },
      send(data: unknown) {
        source.onmessage?.(
          new MessageEvent("message", { data: JSON.stringify(data) }),
        );
      },
    };
    streams.push(source);
    return source;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const bookshelf = (floorId = "web-shop") => {
  const object = floorInspectables(floorId, []).find(
    ({ kind }) => kind === "bookshelf",
  );
  if (object === undefined) {
    throw new Error("A Floor has a bookshelf.");
  }
  return object;
};

/** Opens the Floor's bookshelf panel, as a click on it in the scene does. */
function openBookshelf(navigate?: (href: string) => void) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <InspectorPanel object={bookshelf()} navigate={navigate} />
    </QueryClientProvider>,
  );
  return screen.getByRole("dialog", { name: "The bookshelf" });
}

/** One of the panel's three kinds of memory, by its heading. */
const shelf = (name: string) =>
  within(screen.getByRole("region", { name }) satisfies HTMLElement);

const links = (element: HTMLElement) =>
  within(element)
    .queryAllByRole("link")
    .map((link) => [link.textContent, link.getAttribute("href")]);

describe("a Floor's bookshelf", () => {
  it("shows the repository's memory, the Role memory and the office-wide memory, with links to edit each", async () => {
    const navigate = vi.fn();
    const panel = openBookshelf(navigate);
    expect(panel.dataset["kind"]).toBe("bookshelf");
    expect(
      within(panel)
        .getAllByRole("heading", { level: 3 })
        .map(({ textContent }) => textContent),
    ).toEqual(["The repository's memory", "Role memory", "Office-wide memory"]);

    // The repository's memory, as written, with the proposals waiting.
    const repository = shelf("The repository's memory");
    expect(
      (await repository.findByLabelText("The repository's memory, as written"))
        .textContent,
    ).toBe(memoryText);
    expect(repository.getByText(/on main/)).toBeTruthy();
    const proposals = repository.getByRole("list", {
      name: "Proposed repository memory",
    });
    await waitFor(() => {
      expect(proposals.textContent).toBe(
        "Run pnpm build before pnpm test. (Ada, on #7)",
      );
    });
    expect(
      links(screen.getByRole("region", { name: "The repository's memory" })),
    ).toEqual([
      [
        "Edit the repository's memory on GitHub",
        "https://github.com/adrianeyre/web-shop/edit/main/.agents/MEMORY.md",
      ],
      [
        "The Manager's memory pull request #12",
        "https://github.com/adrianeyre/web-shop/pull/12",
      ],
    ]);

    // Each Role's accepted entries, and how many proposals wait.
    const roles = shelf("Role memory");
    expect(
      (await roles.findByRole("list", { name: "coder memory" })).textContent,
    ).toBe("Write the failing test first.");
    expect(roles.getByRole("list", { name: "QA memory" }).textContent).toBe(
      "Run the tests twice.",
    );
    expect(roles.queryByText(/A rejected lesson/)).toBeNull();
    expect(roles.queryByText(/Keep each commit/)).toBeNull();
    expect(
      roles.getByText("1 proposal waits for the Manager or you."),
    ).toBeTruthy();

    // The office-wide memory, as written.
    const office = shelf("Office-wide memory");
    expect(
      (await office.findByLabelText("The office-wide memory, as written"))
        .textContent,
    ).toBe("# Coding standards\n\n- Prefer zod.");

    // The Role and office-wide memory are edited in AI Office, opened
    // without a reload; the repository's on GitHub, in a new tab.
    expect(links(panel).slice(2)).toEqual([
      ["Edit the Role memory", "/agent-settings?floor=web-shop#role-memory"],
      ["Edit the office-wide memory", "/general-settings#office-wide-memory"],
    ]);
    const user = userEvent.setup();
    await user.click(roles.getByRole("link", { name: "Edit the Role memory" }));
    expect(navigate).toHaveBeenLastCalledWith(
      "/agent-settings?floor=web-shop#role-memory",
    );
    await user.click(
      office.getByRole("link", { name: "Edit the office-wide memory" }),
    );
    expect(navigate).toHaveBeenLastCalledWith(
      "/general-settings#office-wide-memory",
    );
    expect(
      repository
        .getByRole("link", { name: "Edit the repository's memory on GitHub" })
        .getAttribute("target"),
    ).toBe("_blank");
  });

  it("links to create the repository's memory when it has none, and says when there is none of the others", async () => {
    server.repository = {
      repository: "adrianeyre/web-shop",
      branch: "release/2",
      content: null,
      truncated: false,
      readError: null,
      proposals: [],
      pullRequest: null,
    };
    server.roles = [];
    server.office = { content: "", updatedAt: null };
    openBookshelf();
    const repository = shelf("The repository's memory");
    expect(
      await repository.findByText("The repository keeps no memory yet."),
    ).toBeTruthy();
    expect(
      links(screen.getByRole("region", { name: "The repository's memory" })),
    ).toEqual([
      [
        "Edit the repository's memory on GitHub",
        "https://github.com/adrianeyre/web-shop/new/release/2?filename=.agents%2FMEMORY.md",
      ],
    ]);
    expect(
      await shelf("Role memory").findByText("No Role has memory yet."),
    ).toBeTruthy();
    expect(
      await shelf("Office-wide memory").findByText(
        "There is no office-wide memory yet.",
      ),
    ).toBeTruthy();
  });

  it("says why the repository's memory could not be read, and still links to edit the rest", async () => {
    server.repository = {
      repository: "adrianeyre/web-shop",
      branch: "main",
      content: null,
      truncated: false,
      readError:
        "The GitHub App is not set up, so the repository's memory cannot be read.",
      proposals: [],
      pullRequest: null,
    };
    const panel = openBookshelf();
    const repository = shelf("The repository's memory");
    expect((await repository.findByRole("alert")).textContent).toBe(
      "The GitHub App is not set up, so the repository's memory cannot be read.",
    );
    expect(repository.queryByText(/keeps no memory/)).toBeNull();
    expect(links(panel)).toEqual([
      ["Edit the Role memory", "/agent-settings?floor=web-shop#role-memory"],
      ["Edit the office-wide memory", "/general-settings#office-wide-memory"],
    ]);
  });

  it("says when only part of a long memory is shown", async () => {
    server.repository = {
      ...(server.repository as RepositoryMemoryView),
      truncated: true,
    };
    openBookshelf();
    expect(
      await shelf("The repository's memory").findByText(
        "Only the first 12,000 characters are shown, as Agents read them.",
      ),
    ).toBeTruthy();
  });

  it("changes live as the memory's events arrive, for this Floor or the whole Office", async () => {
    openBookshelf();
    const repository = shelf("The repository's memory");
    await repository.findByLabelText("The repository's memory, as written");
    await shelf("Role memory").findByRole("list", { name: "coder memory" });
    await shelf("Office-wide memory").findByLabelText(
      "The office-wide memory, as written",
    );
    const stream = streams.at(-1);
    // One stream, for the memory's events alone, from every Floor.
    expect(stream?.url).toBe(
      "/api/events/stream?type=memory.curated%2Cmemory.office_changed%2Cmemory.proposed%2Cmemory.role_changed%2Cmemory.role_proposed",
    );

    server.repository = {
      ...(server.repository as RepositoryMemoryView),
      content: "# Repository memory\n\n- Curated.",
    };
    server.roles = [entry(5, "reviewer", "Read the tests first.", "accepted")];
    server.office = {
      content: "- Prefer valibot.",
      updatedAt: "2026-10-09T12:00:00.000Z",
    };
    // Another Floor's memory changes nothing here.
    act(() => {
      stream?.send(
        stored(1, {
          type: "memory.role_changed",
          version: 1,
          floorId: "blog",
          role: "reviewer",
          entryId: 9,
          text: "Elsewhere.",
          change: "accepted",
          by: "owner",
        }),
      );
    });
    act(() => {
      stream?.send(
        stored(2, {
          type: "memory.curated",
          version: 1,
          floorId: "web-shop",
          agentId: "grace",
          reason: "weekly",
          curatedBy: "model",
          entries: 1,
          added: 1,
          removed: 1,
          proposals: 1,
          pullRequest: 13,
          url: "https://github.com/adrianeyre/web-shop/pull/13",
        }),
      );
    });
    await waitFor(() => {
      expect(
        repository.getByLabelText("The repository's memory, as written")
          .textContent,
      ).toBe("# Repository memory\n\n- Curated.");
    });
    expect(
      shelf("Role memory").getByRole("list", { name: "coder memory" }),
    ).toBeTruthy();

    act(() => {
      stream?.send(
        stored(3, {
          type: "memory.role_changed",
          version: 1,
          floorId: "web-shop",
          role: "reviewer",
          entryId: 5,
          text: "Read the tests first.",
          change: "accepted",
          by: "owner",
        }),
      );
      stream?.send(
        stored(4, {
          type: "memory.office_changed",
          version: 1,
          added: 1,
          removed: 3,
          characters: 17,
        }),
      );
    });
    expect(
      (
        await shelf("Role memory").findByRole("list", {
          name: "reviewer memory",
        })
      ).textContent,
    ).toBe("Read the tests first.");
    await waitFor(() => {
      expect(
        shelf("Office-wide memory").getByLabelText(
          "The office-wide memory, as written",
        ).textContent,
      ).toBe("- Prefer valibot.");
    });
    // Each was read again only for its own event.
    expect(
      fetched.filter((url) => url === "/api/floors/web-shop/role-memory"),
    ).toHaveLength(2);
  });
});
