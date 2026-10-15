import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browser } from "./api.ts";
import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";

const session = {
  csrfToken: "csrf-token-1",
  expiresAt: "2026-10-15T12:00:00.000Z",
};

/** Where the names of what still signs in wait for the login page. */
const stillSignInKey = "ai-office:still-sign-in";

const signedOutEverywhere = {
  sessionsEnded: 2,
  stillSignIn: {
    passwords: [
      { id: "first", name: "Owner" },
      { id: "sam", name: "Sam" },
    ],
    apiKeys: [{ id: "laptop-key", name: "My laptop" }],
  },
};

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

type Handler = (init?: RequestInit) => Response;

/** Stubs fetch with a handler per URL; anything else is a healthy server. */
function stubServer(handlers: Record<string, Handler>) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    (url, init) =>
      Promise.resolve(
        handlers[url]?.(init) ??
          Response.json({ status: "ok", database: "up" }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const callsTo = (fetch: ReturnType<typeof stubServer>, url: string) =>
  fetch.mock.calls.filter(([called]) => called === url);

const spyOnLoad = () =>
  vi.spyOn(browser, "load").mockImplementation(() => undefined);
let load: ReturnType<typeof spyOnLoad>;

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  load = spyOnLoad();
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function signInWith(password: string) {
  await userEvent.type(await screen.findByLabelText("Password"), password);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("the login page", () => {
  it("stands alone, without the app's navigation", async () => {
    stubServer({});
    renderAt("/login");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
  });

  it("says how long a session lasts, and how long it may go unused (A1-8)", async () => {
    stubServer({});
    renderAt("/login");
    expect(
      await screen.findByText(
        "You stay signed in for 7 days from signing in, or 24 hours unused.",
      ),
    ).toBeDefined();
  });

  it("signs in, then loads the app", async () => {
    const fetch = stubServer({ "/api/login": () => Response.json(session) });
    renderAt("/login");
    await signInWith("Tr0ub4dor&3x");
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith("/");
    });
    const [[, init]] = callsTo(fetch, "/api/login") as [[string, RequestInit]];
    expect(JSON.parse(init.body as string)).toEqual({
      password: "Tr0ub4dor&3x",
    });
  });

  it("says when the password is wrong, and clears it", async () => {
    stubServer({
      "/api/login": () =>
        Response.json(
          { error: "wrong_password", message: "That password is not right." },
          { status: 401 },
        ),
    });
    renderAt("/login");
    await signInWith("wrong");
    expect(
      await screen.findByText("That password is not right."),
    ).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Password").value).toBe("");
    expect(load).not.toHaveBeenCalled();
  });

  it("says how long to wait after too many failures", async () => {
    stubServer({
      "/api/login": () =>
        Response.json(
          {
            error: "too_many_attempts",
            message: "Too many failed sign-ins. Try again in 60 seconds.",
          },
          { status: 429, headers: { "retry-after": "60" } },
        ),
    });
    renderAt("/login");
    await signInWith("Tr0ub4dor&3x");
    expect(
      await screen.findByText(
        "Too many failed sign-ins. Try again in 60 seconds.",
      ),
    ).toBeDefined();
    expect(load).not.toHaveBeenCalled();
  });

  it("asks for a password before sending anything", async () => {
    const fetch = stubServer({});
    renderAt("/login");
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in" }),
    );
    expect(await screen.findByText("Enter the password.")).toBeDefined();
    expect(callsTo(fetch, "/api/login")).toEqual([]);
  });

  it("goes to setup when there is no password yet", async () => {
    stubServer({
      "/api/login": () =>
        Response.json({ error: "setup_required" }, { status: 403 }),
    });
    renderAt("/login");
    await signInWith("anything");
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith("/setup");
    });
  });
});

describe("the login page with TOTP on", () => {
  const askForCode = () => Response.json({ secondFactor: "totp" });

  it("asks for a code after the password, then signs in with it", async () => {
    const fetch = stubServer({
      "/api/login": askForCode,
      "/api/login/totp": () => Response.json(session),
    });
    renderAt("/login");
    await signInWith("Tr0ub4dor&3x");
    const code = await screen.findByLabelText("Code");
    expect(load).not.toHaveBeenCalled();
    await userEvent.type(code, "123456");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith("/");
    });
    const [[, init]] = callsTo(fetch, "/api/login/totp") as [
      [string, RequestInit],
    ];
    expect(JSON.parse(init.body as string)).toEqual({ code: "123456" });
  });

  it("takes a recovery code", async () => {
    const fetch = stubServer({
      "/api/login": askForCode,
      "/api/login/totp": () => Response.json(session),
    });
    renderAt("/login");
    await signInWith("Tr0ub4dor&3x");
    await userEvent.type(
      await screen.findByLabelText("Code"),
      "abcd-efgh-jkmn-pqrs",
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith("/");
    });
    const [[, init]] = callsTo(fetch, "/api/login/totp") as [
      [string, RequestInit],
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      code: "abcd-efgh-jkmn-pqrs",
    });
  });

  it("says when the code is wrong, and clears it", async () => {
    stubServer({
      "/api/login": askForCode,
      "/api/login/totp": () =>
        Response.json(
          {
            error: "wrong_code",
            message: "That code is not right, or was already used.",
          },
          { status: 401 },
        ),
    });
    renderAt("/login");
    await signInWith("Tr0ub4dor&3x");
    await userEvent.type(await screen.findByLabelText("Code"), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("That code is not right, or was already used."),
    ).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>("Code").value).toBe("");
    expect(load).not.toHaveBeenCalled();
  });

  it("goes back to the password when the sign-in has expired", async () => {
    stubServer({
      "/api/login": askForCode,
      "/api/login/totp": () =>
        Response.json(
          { error: "sign_in_expired", message: "Enter the password again." },
          { status: 401 },
        ),
    });
    renderAt("/login");
    await signInWith("Tr0ub4dor&3x");
    await userEvent.type(await screen.findByLabelText("Code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("That took too long. Enter the password again."),
    ).toBeDefined();
    expect(screen.getByLabelText("Password")).toBeDefined();
  });
});

describe("the session in the app", () => {
  it("signs out with the session's CSRF token", async () => {
    const fetch = stubServer({
      "/api/session": () => Response.json(session),
      "/api/logout": () => new Response(null, { status: 204 }),
    });
    renderAt("/");
    const button = await screen.findByRole("button", { name: "Sign out" });
    await vi.waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    await userEvent.click(button);
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith("/login");
    });
    const [[, init]] = callsTo(fetch, "/api/logout") as [[string, RequestInit]];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-token-1");
  });

  it("signs out everywhere", async () => {
    const fetch = stubServer({
      "/api/session": () => Response.json(session),
      "/api/logout/everywhere": () => Response.json(signedOutEverywhere),
    });
    renderAt("/");
    const button = await screen.findByRole("button", {
      name: "Sign out everywhere",
    });
    await vi.waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    await userEvent.click(button);
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith("/login");
    });
    const [[, init]] = callsTo(fetch, "/api/logout/everywhere") as [
      [string, RequestInit],
    ];
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-token-1");
  });

  it("keeps the names of what still signs in for the login page, and nothing else", async () => {
    stubServer({
      "/api/session": () => Response.json(session),
      "/api/logout/everywhere": () => Response.json(signedOutEverywhere),
    });
    renderAt("/");
    const button = await screen.findByRole("button", {
      name: "Sign out everywhere",
    });
    await vi.waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    await userEvent.click(button);
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith("/login");
    });
    const kept = sessionStorage.getItem(stillSignInKey);
    expect(JSON.parse(kept ?? "null")).toEqual({
      passwords: ["Owner", "Sam"],
      apiKeys: ["My laptop"],
    });
    // Names only: not even the ids.
    expect(kept).not.toContain("laptop-key");
  });

  it("keeps nothing when only this session signs out", async () => {
    stubServer({
      "/api/session": () => Response.json(session),
      "/api/logout": () => new Response(null, { status: 204 }),
    });
    renderAt("/");
    const button = await screen.findByRole("button", { name: "Sign out" });
    await vi.waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    await userEvent.click(button);
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith("/login");
    });
    expect(sessionStorage.getItem(stillSignInKey)).toBeNull();
  });

  it("goes to the login page when the session has ended", async () => {
    stubServer({
      "/api/session": () =>
        Response.json({ error: "unauthorized" }, { status: 401 }),
    });
    renderAt("/notices");
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith("/login");
    });
  });
});

describe("the login page after signing out everywhere", () => {
  const notice = async () => within(await screen.findByRole("status"));

  it("says once what still signs in, by name", async () => {
    stubServer({});
    sessionStorage.setItem(
      stillSignInKey,
      JSON.stringify({ passwords: ["Owner", "Sam"], apiKeys: ["My laptop"] }),
    );
    renderAt("/login");
    const status = await notice();
    expect(status.getByText("You are signed out everywhere.")).toBeDefined();
    expect(
      status.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["Owner", "Sam", "My laptop"]);
    expect(
      within(status.getByRole("list", { name: "Owner passwords" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Owner", "Sam"]);
    expect(
      within(status.getByRole("list", { name: "API keys with UI access" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["My laptop"]);
    expect(
      status.getByText(
        "Sign in and remove any you do not recognise in API Key Management.",
      ),
    ).toBeDefined();
    // It is said once.
    expect(sessionStorage.getItem(stillSignInKey)).toBeNull();
    cleanup();
    renderAt("/login");
    await screen.findByLabelText("Password");
    expect(screen.queryByText("You are signed out everywhere.")).toBeNull();
  });

  it("says when no API key signs in", async () => {
    stubServer({});
    sessionStorage.setItem(
      stillSignInKey,
      JSON.stringify({ passwords: ["Owner"], apiKeys: [] }),
    );
    renderAt("/login");
    const status = await notice();
    expect(status.getByText("None.")).toBeDefined();
    expect(
      status.queryByRole("list", { name: "API keys with UI access" }),
    ).toBeNull();
  });

  it("says nothing of a sign-in without it", async () => {
    stubServer({});
    renderAt("/login");
    await screen.findByLabelText("Password");
    expect(screen.queryByText("You are signed out everywhere.")).toBeNull();
  });
});

describe("signing in with an API key", () => {
  it("signs in with a key that has UI access, then loads the app", async () => {
    const fetch = stubServer({
      "/api/login/api-key": () =>
        Response.json({ ...session, gatewayKeyId: "laptop-key" }),
    });
    renderAt("/login");
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Use an API key instead",
      }),
    );
    await userEvent.type(
      screen.getByLabelText("API key"),
      "aio_gk_laptopkey000000000000000000000000000000",
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith("/");
    });
    expect(callsTo(fetch, "/api/login/api-key")).toHaveLength(1);
  });

  it("says when the key cannot sign in, and goes back to the password", async () => {
    stubServer({
      "/api/login/api-key": () =>
        Response.json(
          {
            error: "wrong_api_key",
            message:
              "That API key cannot sign in: it is not one in use, enabled, with UI access.",
          },
          { status: 401 },
        ),
    });
    renderAt("/login");
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Use an API key instead",
      }),
    );
    await userEvent.type(screen.getByLabelText("API key"), "aio_gk_proxyonly");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That API key cannot sign in: it is not one in use, enabled, with UI access.",
    );
    expect(load).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Use the password instead" }),
    );
    expect(await screen.findByLabelText("Password")).toBeDefined();
  });
});
