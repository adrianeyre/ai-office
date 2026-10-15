import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import type { InspectTarget } from "./scene/inspectable.ts";

// The Office's address (PRD FR-58, §7): `?floor=…&inspect=…` names an
// inspectable object for the Office view to open, and follows what opens
// and closes there. The view is a stand-in that shows what it was given.
vi.mock("./scene/office-view.tsx", () => ({
  OfficeView: ({
    inspect,
    onInspect,
  }: {
    inspect?: InspectTarget | undefined;
    onInspect?: ((target: InspectTarget | undefined) => void) | undefined;
  }) => (
    <div data-testid="office" data-inspect={JSON.stringify(inspect ?? null)}>
      <button
        onClick={() => {
          onInspect?.({
            kind: "bookshelf",
            id: "blog",
            location: { kind: "floor", floorId: "blog" },
          });
        }}
      >
        Open the bookshelf
      </button>
      <button
        onClick={() => {
          onInspect?.({
            kind: "notice-board",
            id: "office",
            location: { kind: "lobby" },
          });
        }}
      >
        Open the Notice Board
      </button>
      <button
        onClick={() => {
          onInspect?.(undefined);
        }}
      >
        Close it
      </button>
    </div>
  ),
}));

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

const given = async () =>
  JSON.parse(
    (await screen.findByTestId("office")).dataset["inspect"] ?? "null",
  ) as unknown;

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        url === "/api/session"
          ? Response.json({
              csrfToken: "csrf-token",
              expiresAt: "2026-10-15T12:00:00.000Z",
            })
          : Response.json({ status: "ok", database: "up" }),
      ),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Office's address", () => {
  it("names an object on a Floor for the Office to open", async () => {
    renderAt("/?floor=web-shop&inspect=monitor:ada");
    expect(await given()).toEqual({
      kind: "monitor",
      id: "ada",
      location: { kind: "floor", floorId: "web-shop" },
    });
  });

  it("names the lobby's Notice Board without a Floor", async () => {
    renderAt("/?inspect=notice-board:office");
    expect(await given()).toEqual({
      kind: "notice-board",
      id: "office",
      location: { kind: "lobby" },
    });
  });

  it("names nothing when it names no object", async () => {
    renderAt("/?floor=web-shop&inspect=desk:ada");
    expect(await given()).toBeNull();
  });

  it("follows what opens and closes in the Office, without adding to history", async () => {
    const user = userEvent.setup();
    const router = renderAt("/");
    expect(await given()).toBeNull();
    const length = router.history.length;

    await user.click(
      screen.getByRole("button", { name: "Open the bookshelf" }),
    );
    await waitFor(() => {
      expect(router.state.location.searchStr).toBe(
        "?floor=blog&inspect=bookshelf%3Ablog",
      );
    });
    expect(await given()).toEqual({
      kind: "bookshelf",
      id: "blog",
      location: { kind: "floor", floorId: "blog" },
    });

    await user.click(
      screen.getByRole("button", { name: "Open the Notice Board" }),
    );
    await waitFor(() => {
      expect(router.state.location.searchStr).toBe(
        "?inspect=notice-board%3Aoffice",
      );
    });

    await user.click(screen.getByRole("button", { name: "Close it" }));
    await waitFor(() => {
      expect(router.state.location.searchStr).toBe("");
    });
    expect(router.history.length).toBe(length);
  });
});
