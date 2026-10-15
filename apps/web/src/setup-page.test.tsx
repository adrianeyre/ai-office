import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browser } from "./api.ts";
import { App } from "./app.tsx";
import { brand } from "./brand/brand.ts";
import { createAppRouter } from "./router.tsx";

const password = "Tr0ub4dor&3x-web";

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
}

/** Stubs fetch: `/api/setup` answers `setup`, anything else is healthy. */
function stubServer(setup: () => Response) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    (url) =>
      Promise.resolve(
        url === "/api/setup"
          ? setup()
          : url === "/api/session"
            ? Response.json({
                csrfToken: "csrf-token",
                expiresAt: "2026-10-15T12:00:00.000Z",
              })
            : Response.json({ status: "ok", database: "up" }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const setupCalls = (fetch: ReturnType<typeof stubServer>) =>
  fetch.mock.calls.filter(([url]) => url === "/api/setup");

async function fillIn(first: string, second = first) {
  await userEvent.type(await screen.findByLabelText("Password"), first);
  await userEvent.type(screen.getByLabelText("Confirm password"), second);
  await userEvent.click(screen.getByRole("button", { name: "Set password" }));
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the setup page", () => {
  it("stands alone, without the app's navigation", async () => {
    stubServer(() => new Response(null, { status: 204 }));
    renderAt("/setup");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Welcome to AI Office",
      }),
    ).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });

  it("shows the company logo above the card", async () => {
    stubServer(() => new Response(null, { status: 204 }));
    renderAt("/setup");
    await screen.findByRole("heading", {
      level: 1,
      name: "Welcome to AI Office",
    });
    expect(screen.getByTestId("company-logo").getAttribute("src")).toBe(
      brand.logo,
    );
  });

  it("explains a weak password and sends nothing", async () => {
    const fetch = stubServer(() => new Response(null, { status: 204 }));
    renderAt("/setup");
    await fillIn("onlylowercase");
    expect(
      await screen.findByText(
        "Mix at least three of lower case, upper case, digits and symbols, or use 20 or more characters.",
      ),
    ).toBeDefined();
    expect(setupCalls(fetch)).toEqual([]);
  });

  it("asks for the same password twice", async () => {
    const fetch = stubServer(() => new Response(null, { status: 204 }));
    renderAt("/setup");
    await fillIn(password, `${password}!`);
    expect(
      await screen.findByText("The passwords do not match."),
    ).toBeDefined();
    expect(setupCalls(fetch)).toEqual([]);
  });

  it("sets the password, then goes straight to sign in", async () => {
    const load = vi.spyOn(browser, "load").mockImplementation(() => undefined);
    const fetch = stubServer(() => new Response(null, { status: 204 }));
    renderAt("/setup");
    await fillIn(password);
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith("/login");
    });
    const [[, init]] = setupCalls(fetch) as [[string, RequestInit]];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual({ password });
  });

  it("shows the server's problems", async () => {
    stubServer(() =>
      Response.json(
        { error: "invalid_request", problems: ["Use at least 12 characters."] },
        { status: 400 },
      ),
    );
    renderAt("/setup");
    await fillIn(password);
    expect(
      await screen.findByText("Use at least 12 characters."),
    ).toBeDefined();
  });

  it("asks for the setup token when the server wants one, with its word on where it is, then sends it", async () => {
    const load = vi.spyOn(browser, "load").mockImplementation(() => undefined);
    const where =
      "Setting the password from another machine needs the one-time setup token AI Office wrote to /tmp/ai-office-setup-x/token as it started.";
    const answers = [
      Response.json(
        { error: "setup_token_required", message: where },
        { status: 403 },
      ),
      new Response(null, { status: 204 }),
    ];
    const fetch = stubServer(
      () => answers.shift() ?? new Response(null, { status: 500 }),
    );
    renderAt("/setup");
    expect(screen.queryByLabelText("Setup token")).toBeNull();
    await fillIn(password);
    const token = await screen.findByLabelText("Setup token");
    expect(screen.getByText(where)).toBeDefined();
    expect(load).not.toHaveBeenCalled();
    await userEvent.type(token, "  setup-token-from-the-file  ");
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith("/login");
    });
    const bodies = setupCalls(fetch).map(
      ([, init]) => JSON.parse(init?.body as string) as unknown,
    );
    expect(bodies).toEqual([
      { password },
      { password, token: "setup-token-from-the-file" },
    ]);
  });

  it("says when the setup token is not right", async () => {
    stubServer(() =>
      Response.json(
        { error: "setup_token_required", message: "It is in a file." },
        { status: 403 },
      ),
    );
    renderAt("/setup");
    await fillIn(password);
    await userEvent.type(await screen.findByLabelText("Setup token"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect(
      await screen.findByText("That setup token is not right."),
    ).toBeDefined();
  });

  it("shows the server's word when AI Office is not served at the name the page was opened at", async () => {
    const message =
      "AI Office is not served at that name. Open it at its own address (PUBLIC_URL) to set the password.";
    stubServer(() =>
      Response.json({ error: "wrong_host", message }, { status: 421 }),
    );
    renderAt("/setup");
    await fillIn(password);
    expect(await screen.findByText(message)).toBeDefined();
  });

  it("says when a password already exists", async () => {
    stubServer(() => Response.json({ error: "Not Found" }, { status: 404 }));
    renderAt("/setup");
    await fillIn(password);
    expect(
      await screen.findByText("A password has already been set."),
    ).toBeDefined();
  });
});

describe("the not-found page", () => {
  it("is shown inside the app layout", async () => {
    stubServer(() => new Response(null, { status: 404 }));
    renderAt("/no-such-page");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeDefined();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeDefined();
  });
});
