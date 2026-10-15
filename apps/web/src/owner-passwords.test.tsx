import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The Owner's passwords in API Key Management, against a stubbed server:
// one per person who signs in, each with a name, nickname and time zone.
// Adding one needs a fresh proof of the Owner (A1-3).

const first = {
  id: "first",
  first: true,
  name: "Owner",
  nickname: "",
  timeZone: "Europe/London",
  createdAt: null,
  lastUsedAt: null,
};

const session = {
  csrfToken: "csrf-token-1",
  expiresAt: "2026-10-15T12:00:00.000Z",
};

function stubServer({
  signedInWith = session,
  totp = { enabled: false, recoveryCodesLeft: 0 },
  refuseAdding,
}: {
  signedInWith?: object;
  totp?: { enabled: boolean; recoveryCodesLeft: number };
  /** The answer to `POST /api/owner-passwords`, instead of adding it. */
  refuseAdding?: () => Response;
} = {}) {
  let passwords: object[] = [first];
  const sent: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        const body: unknown =
          init?.body === undefined
            ? undefined
            : JSON.parse(init.body as string);
        sent.push({ method, url, body });
        if (method === "POST") {
          if (refuseAdding !== undefined) {
            return Promise.resolve(refuseAdding());
          }
          const settings = { ...(body as Record<string, unknown>) };
          delete settings["password"];
          delete settings["currentPassword"];
          delete settings["code"];
          const added = {
            id: "sam",
            first: false,
            nickname: "",
            timeZone: "Europe/London",
            ...settings,
            createdAt: "2026-10-10T12:00:00.000Z",
            lastUsedAt: null,
          };
          passwords = [...passwords, added];
          return Promise.resolve(Response.json(added, { status: 201 }));
        }
        if (method === "PUT") {
          const updated = { ...first, ...(body as object) };
          passwords = [updated, ...passwords.slice(1)];
          return Promise.resolve(Response.json(updated));
        }
        passwords = passwords.slice(0, 1);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      switch (url) {
        case "/api/session":
          return Promise.resolve(Response.json(signedInWith));
        case "/api/totp":
          return Promise.resolve(Response.json(totp));
        case "/api/owner-passwords":
          return Promise.resolve(Response.json({ passwords }));
        case "/api/gateway-keys":
          return Promise.resolve(Response.json({ keys: [] }));
        case "/api/gateway-keys/usage":
          return Promise.resolve(Response.json({ usage: [] }));
        default:
          return Promise.resolve(Response.json({}, { status: 404 }));
      }
    }),
  );
  return { sent };
}

async function passwordCard(name: string) {
  const heading = await screen.findByRole("heading", { level: 3, name });
  const card = heading.closest<HTMLElement>("[data-slot=card]");
  if (card === null) {
    throw new Error(`${name} is not in a card.`);
  }
  return within(card);
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

function renderPage(path = "/api-keys") {
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
}

describe("the Owner's passwords in API Key Management", () => {
  it("shows the first password, signed in with, and names it", async () => {
    const { sent } = stubServer();
    renderPage();
    const owner = await passwordCard("Owner");
    expect(owner.getByText("You are signed in with it")).toBeDefined();
    expect(owner.queryByRole("button", { name: /^Remove/ })).toBeNull();
    const form = within(
      owner.getByRole("form", { name: "Owner's password settings" }),
    );
    expect(form.getByLabelText<HTMLSelectElement>("Time zone").value).toBe(
      "Europe/London",
    );
    await userEvent.clear(form.getByLabelText("Name"));
    await userEvent.type(form.getByLabelText("Name"), "Adrian");
    await userEvent.type(form.getByLabelText("Nickname"), "Ade");
    expect(
      form.getByText(/^Hi, Ade\. Good (morning|afternoon|evening)\.$/),
    ).toBeDefined();
    await userEvent.click(form.getByRole("button", { name: "Save Owner" }));
    expect(await form.findByRole("status")).toBeDefined();
    expect(sent).toEqual([
      {
        method: "PUT",
        url: "/api/owner-passwords/first",
        body: { name: "Adrian", nickname: "Ade", timeZone: "Europe/London" },
      },
    ]);
  });

  it("adds a password for someone else, refusing a weak one, and removes it", async () => {
    const { sent } = stubServer();
    renderPage();
    const add = within(
      await screen.findByRole("form", { name: "Add an Owner password" }),
    );
    await userEvent.type(add.getByLabelText("Name"), "Sam");
    await userEvent.type(add.getByLabelText("Password"), "short");
    await userEvent.click(add.getByRole("button", { name: "Add password" }));
    expect((await add.findByRole("alert")).textContent).toContain(
      "Use at least 12 characters.",
    );
    expect(sent).toEqual([]);

    await userEvent.clear(add.getByLabelText("Password"));
    await userEvent.type(
      add.getByLabelText("Password"),
      "Correct-Horse-Battery-9",
    );
    // Its nickname and time zone, as each password's settings have.
    await userEvent.type(add.getByLabelText("Nickname"), "Sammy");
    await userEvent.selectOptions(
      add.getByLabelText("Time zone"),
      "America/New_York",
    );
    await userEvent.type(
      add.getByLabelText("Your current password"),
      "Tr0ub4dor&3x",
    );
    await userEvent.click(add.getByRole("button", { name: "Add password" }));
    expect((await add.findByRole("status")).textContent).toContain(
      "Added Sam's password.",
    );
    const sam = await passwordCard("Sam");
    await userEvent.click(
      sam.getByRole("button", { name: "Remove Sam's password" }),
    );
    await userEvent.click(
      sam.getByRole("button", { name: "Remove Sam's password" }),
    );
    await vi.waitFor(() => {
      expect(sent.map(({ method }) => method)).toEqual(["POST", "DELETE"]);
    });
    expect(sent[0]?.body).toEqual({
      name: "Sam",
      nickname: "Sammy",
      timeZone: "America/New_York",
      password: "Correct-Horse-Battery-9",
      currentPassword: "Tr0ub4dor&3x",
    });
    // What was typed is forgotten once it is added.
    expect(
      add.getByLabelText<HTMLInputElement>("Your current password").value,
    ).toBe("");
  });

  it("asks for the current password before sending anything", async () => {
    const { sent } = stubServer();
    renderPage();
    const add = within(
      await screen.findByRole("form", { name: "Add an Owner password" }),
    );
    const current = add.getByLabelText("Your current password");
    expect(current.getAttribute("type")).toBe("password");
    expect(current.getAttribute("autocomplete")).toBe("current-password");
    expect(current.getAttribute("aria-describedby")).toBe(
      "new-password-proof-current-password-hint",
    );
    await userEvent.type(add.getByLabelText("Name"), "Sam");
    await userEvent.type(
      add.getByLabelText("Password"),
      "Correct-Horse-Battery-9",
    );
    await userEvent.click(add.getByRole("button", { name: "Add password" }));
    expect((await add.findByRole("alert")).textContent).toBe(
      "Enter your current password.",
    );
    expect(current.getAttribute("aria-invalid")).toBe("true");
    expect(sent).toEqual([]);
  });

  it("sends a code from the authenticator app too when TOTP is on", async () => {
    const { sent } = stubServer({
      totp: { enabled: true, recoveryCodesLeft: 10 },
    });
    renderPage();
    const add = within(
      await screen.findByRole("form", { name: "Add an Owner password" }),
    );
    const code = await add.findByLabelText("Code from your authenticator app");
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    await userEvent.type(add.getByLabelText("Name"), "Sam");
    await userEvent.type(
      add.getByLabelText("Password"),
      "Correct-Horse-Battery-9",
    );
    await userEvent.type(
      add.getByLabelText("Your current password"),
      "Tr0ub4dor&3x",
    );
    await userEvent.click(add.getByRole("button", { name: "Add password" }));
    expect((await add.findByRole("alert")).textContent).toBe("Enter the code.");
    expect(sent).toEqual([]);

    await userEvent.type(code, "123456");
    await userEvent.click(add.getByRole("button", { name: "Add password" }));
    expect((await add.findByRole("status")).textContent).toContain(
      "Added Sam's password.",
    );
    expect(sent[0]?.body).toMatchObject({
      name: "Sam",
      password: "Correct-Horse-Battery-9",
      currentPassword: "Tr0ub4dor&3x",
      code: "123456",
    });
  });

  it.each([
    [
      "a wrong current password",
      Response.json(
        {
          error: "wrong_password",
          message: "That is not your current password.",
        },
        { status: 422 },
      ),
      "That is not your current password.",
    ],
    [
      "a wrong code",
      Response.json(
        {
          error: "wrong_code",
          message: "That code is not right, or was already used.",
        },
        { status: 422 },
      ),
      "That code is not right, or was already used.",
    ],
    [
      "a missing proof",
      Response.json(
        {
          error: "proof_required",
          message:
            "This adds a way to sign in: confirm it with your current password and a code from your authenticator app.",
        },
        { status: 403 },
      ),
      "This adds a way to sign in: confirm it with your current password and a code from your authenticator app.",
    ],
    [
      "too many attempts",
      Response.json(
        {
          error: "too_many_attempts",
          message: "Too many failed sign-ins. Try again in 60 seconds.",
        },
        { status: 429, headers: { "retry-after": "60" } },
      ),
      "Too many failed sign-ins. Try again in 60 seconds.",
    ],
  ])("says so when the server refuses %s", async (_, answer, message) => {
    const { sent } = stubServer({
      totp: { enabled: true, recoveryCodesLeft: 10 },
      refuseAdding: () => answer,
    });
    renderPage();
    const add = within(
      await screen.findByRole("form", { name: "Add an Owner password" }),
    );
    await userEvent.type(add.getByLabelText("Name"), "Sam");
    await userEvent.type(
      add.getByLabelText("Password"),
      "Correct-Horse-Battery-9",
    );
    await userEvent.type(
      add.getByLabelText("Your current password"),
      "not-it-at-all",
    );
    await userEvent.type(
      await add.findByLabelText("Code from your authenticator app"),
      "000000",
    );
    await userEvent.click(add.getByRole("button", { name: "Add password" }));
    expect((await add.findByRole("alert")).textContent).toBe(message);
    expect(add.queryByRole("status")).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("changes the first password with proof of it, refusing a weak one first (A1-9)", async () => {
    const { sent } = stubServer();
    renderPage();
    const owner = await passwordCard("Owner");
    expect(
      owner.getByText(
        "Set at setup; it cannot be removed, but it can be changed.",
      ),
    ).toBeDefined();
    await userEvent.click(
      owner.getByRole("button", { name: "Change Owner's password" }),
    );
    const change = within(
      owner.getByRole("form", { name: "Change Owner's password" }),
    );
    await userEvent.type(change.getByLabelText("New password"), "short");
    await userEvent.click(
      change.getByRole("button", { name: "Change Owner's password" }),
    );
    expect((await change.findByRole("alert")).textContent).toContain(
      "Use at least 12 characters.",
    );
    await userEvent.clear(change.getByLabelText("New password"));
    await userEvent.type(
      change.getByLabelText("New password"),
      "Correct-Horse-Battery-9",
    );
    await userEvent.click(
      change.getByRole("button", { name: "Change Owner's password" }),
    );
    expect((await change.findByRole("alert")).textContent).toBe(
      "Enter your current password.",
    );
    expect(sent).toEqual([]);
    await userEvent.type(
      change.getByLabelText("Your current password"),
      "Tr0ub4dor&3x",
    );
    await userEvent.click(
      change.getByRole("button", { name: "Change Owner's password" }),
    );
    expect((await owner.findByRole("status")).textContent).toContain(
      "Changed Owner's password.",
    );
    expect(sent).toEqual([
      {
        method: "PUT",
        url: "/api/owner-passwords/first",
        body: {
          name: "Owner",
          nickname: "",
          timeZone: "Europe/London",
          password: "Correct-Horse-Battery-9",
          currentPassword: "Tr0ub4dor&3x",
        },
      },
    ]);
  });

  it("tells a session begun with an API key that it cannot add one", async () => {
    const { sent } = stubServer({
      signedInWith: { ...session, gatewayKeyId: "laptop-key" },
    });
    renderPage();
    const add = within(
      await screen.findByRole("form", { name: "Add an Owner password" }),
    );
    expect((await add.findByRole("note")).textContent).toContain(
      "You signed in with an API key, so you cannot do this here",
    );
    expect(add.queryByLabelText("Your current password")).toBeNull();
    expect(
      add.getByRole<HTMLButtonElement>("button", { name: "Add password" })
        .disabled,
    ).toBe(true);
    expect(sent).toEqual([]);
  });

  it("is no longer in General Settings", async () => {
    stubServer();
    renderPage("/general-settings");
    await screen.findByRole("heading", { level: 1, name: "General Settings" });
    expect(screen.queryByRole("form", { name: "Your profile" })).toBeNull();
  });
});
