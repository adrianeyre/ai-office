import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The office's Git identity in Admin (PRD FR-68), against a stubbed server.

const defaultIdentity = {
  name: "adrianeyre",
  email: "21265837+adrianeyre@users.noreply.github.com",
  isDefault: true,
};

function stubServer() {
  const state = { identity: defaultIdentity };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/git-identity" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as {
          name: string;
          email: string;
        };
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.identity = { ...body, isDefault: false };
        return Promise.resolve(Response.json(state.identity));
      }
      if (url === "/api/office/git-identity") {
        return Promise.resolve(Response.json(state.identity));
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
  return { puts };
}

async function card() {
  render(
    <App
      router={createAppRouter(
        createMemoryHistory({ initialEntries: ["/general-settings"] }),
      )}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  const heading = await screen.findByRole("heading", { name: "Git identity" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Git identity heading is not in a card.");
  }
  return within(element);
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

describe("the Git identity in Admin", () => {
  it("shows the default, the Owner's noreply identity", async () => {
    stubServer();
    const identity = await card();
    expect(
      (await identity.findByLabelText<HTMLInputElement>("Name")).value,
    ).toBe("adrianeyre");
    expect(identity.getByLabelText<HTMLInputElement>("Email").value).toBe(
      "21265837+adrianeyre@users.noreply.github.com",
    );
    expect(identity.getByText(/This is the default/)).toBeDefined();
  });

  it("saves another identity", async () => {
    const { puts } = stubServer();
    const identity = await card();
    const name = await identity.findByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Adrian Eyre");
    const email = identity.getByLabelText("Email");
    await userEvent.clear(email);
    await userEvent.type(email, "adrian@company.example");
    const save = identity.getByRole("button", { name: "Save Git identity" });
    await vi.waitFor(() => {
      expect((save as HTMLButtonElement).disabled).toBe(false);
    });
    await userEvent.click(save);

    expect((await identity.findByRole("status")).textContent).toBe("Saved.");
    expect(puts).toEqual([
      {
        body: { name: "Adrian Eyre", email: "adrian@company.example" },
        csrf: "csrf-token-1",
      },
    ]);
    expect(identity.queryByText(/This is the default/)).toBeNull();
  });

  it("refuses an identity Git could not use, without sending it", async () => {
    const { puts } = stubServer();
    const identity = await card();
    const name = await identity.findByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Adrian <Eyre>");
    const email = identity.getByLabelText("Email");
    await userEvent.clear(email);
    await userEvent.type(email, "nowhere");
    await vi.waitFor(() => {
      expect(
        identity.getByRole<HTMLButtonElement>("button", {
          name: "Save Git identity",
        }).disabled,
      ).toBe(false);
    });
    await userEvent.click(
      identity.getByRole("button", { name: "Save Git identity" }),
    );
    expect(
      within(await identity.findByRole("alert"))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "A Git name cannot contain <, > or a line break.",
      "Give the commit author an email address.",
    ]);
    expect(puts).toEqual([]);
  });
});
