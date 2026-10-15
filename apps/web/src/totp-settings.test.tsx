import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { isLocalhost, location } from "./totp-settings.tsx";

const session = {
  csrfToken: "csrf-token-1",
  expiresAt: "2026-10-15T12:00:00.000Z",
};
const recoveryCodes = Array.from(
  { length: 10 },
  (_, index) => `abcd-efgh-jkmn-${String(index).padStart(4, "0")}`,
);

type Handler = (init?: RequestInit) => Response;

/** A signed-in server whose TOTP is `enabled`, plus `handlers`. */
function stubServer(
  totp: { enabled: boolean; recoveryCodesLeft: number },
  handlers: Record<string, Handler> = {},
  signedInWith: object = session,
) {
  const state = { totp };
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    (url, init) => {
      const handler = handlers[url];
      if (handler !== undefined) {
        return Promise.resolve(handler(init));
      }
      if (url === "/api/session") {
        return Promise.resolve(Response.json(signedInWith));
      }
      if (url === "/api/totp") {
        return Promise.resolve(Response.json(state.totp));
      }
      return Promise.resolve(Response.json({ status: "ok", database: "up" }));
    },
  );
  vi.stubGlobal("fetch", fetch);
  return { fetch, state };
}

const bodyOf = (fetch: ReturnType<typeof stubServer>["fetch"], url: string) => {
  const call = fetch.mock.calls.find(([called]) => called === url);
  const init = call?.[1];
  return {
    body: JSON.parse(init?.body as string) as unknown,
    csrf: new Headers(init?.headers).get("x-csrf-token"),
  };
};

function renderAdmin() {
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
}

const setup = () =>
  Response.json({
    secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    otpauthUrl: "otpauth://totp/AI%20Office:Owner?secret=JBSWY3DP",
    qrCode: "data:image/svg+xml;base64,PHN2Zy8+",
  });

/** Clicks Turn on TOTP, once it can be, for the current password step. */
async function turnOn(settings: Awaited<ReturnType<typeof card>>) {
  const button = await settings.findByRole("button", { name: "Turn on TOTP" });
  await vi.waitFor(() => {
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
  await userEvent.click(button);
  return within(settings.getByRole("form", { name: "Turn on TOTP" }));
}

/** The TOTP card of the admin page. */
async function card() {
  const heading = await screen.findByRole("heading", {
    name: "Two-step sign-in (TOTP)",
  });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The TOTP heading is not in a card.");
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

describe("isLocalhost", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "office.localhost",
    "127.0.0.1",
    "127.8.9.10",
    "[::1]",
    "::1",
  ])("is true for %s", (hostname) => {
    expect(isLocalhost(hostname)).toBe(true);
  });

  it.each([
    "office.example.com",
    "192.168.1.20",
    "10.0.0.5",
    "[2001:db8::1]",
    "localhost.example.com",
    "127.0.0.1.nip.io",
  ])("is false for %s", (hostname) => {
    expect(isLocalhost(hostname)).toBe(false);
  });
});

describe("the TOTP settings", () => {
  it("recommend TOTP when the page is not served from localhost", async () => {
    vi.mocked(location.hostname).mockReturnValue("office.example.com");
    stubServer({ enabled: false, recoveryCodesLeft: 0 });
    renderAdmin();
    const settings = await card();
    expect(await settings.findByText("TOTP is off.")).toBeDefined();
    expect(settings.getByRole("note").textContent).toContain(
      "Turning on TOTP is recommended.",
    );
  });

  it("do not nag on localhost, nor once TOTP is on", async () => {
    stubServer({ enabled: false, recoveryCodesLeft: 0 });
    renderAdmin();
    const settings = await card();
    await settings.findByText("TOTP is off.");
    expect(settings.queryByRole("note")).toBeNull();
    cleanup();

    vi.mocked(location.hostname).mockReturnValue("office.example.com");
    stubServer({ enabled: true, recoveryCodesLeft: 7 });
    renderAdmin();
    const on = await card();
    expect(
      await on.findByText("TOTP is on. 7 of 10 recovery codes are left."),
    ).toBeDefined();
    expect(on.queryByRole("note")).toBeNull();
  });

  it("turn TOTP on: QR code and secret, a code, then the recovery codes once", async () => {
    const { fetch, state } = stubServer(
      { enabled: false, recoveryCodesLeft: 0 },
      {
        "/api/totp/setup": () =>
          Response.json({
            secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
            otpauthUrl: "otpauth://totp/AI%20Office:Owner?secret=JBSWY3DP",
            qrCode: "data:image/svg+xml;base64,PHN2Zy8+",
          }),
        "/api/totp/enable": () => {
          state.totp = { enabled: true, recoveryCodesLeft: 10 };
          return Response.json({ recoveryCodes });
        },
      },
    );
    renderAdmin();
    const settings = await card();
    const prove = await turnOn(settings);
    // It asks for the current password first.
    expect(settings.queryByRole("img", { name: /QR code/ })).toBeNull();
    await userEvent.type(
      prove.getByLabelText("Your current password"),
      "Tr0ub4dor&3x",
    );
    await userEvent.click(prove.getByRole("button", { name: "Continue" }));

    const qr = await settings.findByRole("img", { name: /QR code/ });
    expect(qr.getAttribute("src")).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(
      settings.getByText("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"),
    ).toBeDefined();
    expect(bodyOf(fetch, "/api/totp/setup")).toEqual({
      body: { currentPassword: "Tr0ub4dor&3x" },
      csrf: "csrf-token-1",
    });

    await userEvent.type(
      settings.getByLabelText("Code from the app"),
      "123456",
    );
    await userEvent.click(
      settings.getByRole("button", { name: "Turn on TOTP" }),
    );
    const list = await settings.findByRole("list", { name: "Recovery codes" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(recoveryCodes);
    expect(bodyOf(fetch, "/api/totp/enable")).toEqual({
      body: { code: "123456" },
      csrf: "csrf-token-1",
    });

    await userEvent.click(
      settings.getByRole("button", { name: "I have saved them" }),
    );
    expect(
      await settings.findByText(
        "TOTP is on. 10 of 10 recovery codes are left.",
      ),
    ).toBeDefined();
    expect(settings.queryByRole("list", { name: "Recovery codes" })).toBeNull();
  });

  it("say when the confirming code is wrong", async () => {
    stubServer(
      { enabled: false, recoveryCodesLeft: 0 },
      {
        "/api/totp/setup": () =>
          Response.json({
            secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
            otpauthUrl: "otpauth://totp/x",
            qrCode: "data:image/svg+xml;base64,PHN2Zy8+",
          }),
        "/api/totp/enable": () =>
          Response.json(
            { error: "wrong_code", message: "That code is not right." },
            { status: 422 },
          ),
      },
    );
    renderAdmin();
    const settings = await card();
    const prove = await turnOn(settings);
    await userEvent.type(
      prove.getByLabelText("Your current password"),
      "Tr0ub4dor&3x",
    );
    await userEvent.click(prove.getByRole("button", { name: "Continue" }));
    await userEvent.type(
      await settings.findByLabelText("Code from the app"),
      "000000",
    );
    await userEvent.click(
      settings.getByRole("button", { name: "Turn on TOTP" }),
    );
    expect(await settings.findByText("That code is not right.")).toBeDefined();
  });

  it("ask for the current password before setting TOTP up", async () => {
    const { fetch } = stubServer(
      { enabled: false, recoveryCodesLeft: 0 },
      { "/api/totp/setup": setup },
    );
    renderAdmin();
    const settings = await card();
    const prove = await turnOn(settings);
    const current = prove.getByLabelText("Your current password");
    expect(current.getAttribute("type")).toBe("password");
    expect(current.getAttribute("autocomplete")).toBe("current-password");
    // TOTP is off, so there is no code to ask for.
    expect(
      prove.queryByLabelText("Code from your authenticator app"),
    ).toBeNull();
    await userEvent.click(prove.getByRole("button", { name: "Continue" }));
    expect((await prove.findByRole("alert")).textContent).toBe(
      "Enter your current password.",
    );
    expect(
      fetch.mock.calls.filter(([url]) => url === "/api/totp/setup"),
    ).toEqual([]);

    // Cancel goes back, forgetting it.
    await userEvent.click(prove.getByRole("button", { name: "Cancel" }));
    expect(await settings.findByText("TOTP is off.")).toBeDefined();
  });

  it("say when the current password is wrong, and stay on that step", async () => {
    stubServer(
      { enabled: false, recoveryCodesLeft: 0 },
      {
        "/api/totp/setup": () =>
          Response.json(
            {
              error: "wrong_password",
              message: "That is not your current password.",
            },
            { status: 422 },
          ),
      },
    );
    renderAdmin();
    const settings = await card();
    const prove = await turnOn(settings);
    await userEvent.type(prove.getByLabelText("Your current password"), "nope");
    await userEvent.click(prove.getByRole("button", { name: "Continue" }));
    expect((await prove.findByRole("alert")).textContent).toBe(
      "That is not your current password.",
    );
    expect(
      prove.getByLabelText<HTMLInputElement>("Your current password").value,
    ).toBe("");
    expect(settings.queryByRole("img", { name: /QR code/ })).toBeNull();
  });

  it("say the server's message when it refuses too many attempts", async () => {
    stubServer(
      { enabled: false, recoveryCodesLeft: 0 },
      {
        "/api/totp/setup": () =>
          Response.json(
            {
              error: "too_many_attempts",
              message: "Too many failed sign-ins. Try again in 60 seconds.",
            },
            { status: 429, headers: { "retry-after": "60" } },
          ),
      },
    );
    renderAdmin();
    const settings = await card();
    const prove = await turnOn(settings);
    await userEvent.type(
      prove.getByLabelText("Your current password"),
      "Tr0ub4dor&3x",
    );
    await userEvent.click(prove.getByRole("button", { name: "Continue" }));
    expect((await prove.findByRole("alert")).textContent).toBe(
      "Too many failed sign-ins. Try again in 60 seconds.",
    );
  });

  it("tell a session begun with an API key that it cannot turn TOTP on", async () => {
    const { fetch } = stubServer(
      { enabled: false, recoveryCodesLeft: 0 },
      { "/api/totp/setup": setup },
      { ...session, gatewayKeyId: "laptop-key" },
    );
    renderAdmin();
    const settings = await card();
    const prove = await turnOn(settings);
    expect(prove.getByRole("note").textContent).toContain(
      "You signed in with an API key, so you cannot do this here",
    );
    expect(prove.queryByLabelText("Your current password")).toBeNull();
    expect(
      prove.getByRole<HTMLButtonElement>("button", { name: "Continue" })
        .disabled,
    ).toBe(true);
    expect(
      fetch.mock.calls.filter(([url]) => url === "/api/totp/setup"),
    ).toEqual([]);
  });

  it("turn TOTP off with a current code", async () => {
    const { fetch, state } = stubServer(
      { enabled: true, recoveryCodesLeft: 10 },
      {
        "/api/totp/disable": () => {
          state.totp = { enabled: false, recoveryCodesLeft: 0 };
          return new Response(null, { status: 204 });
        },
      },
    );
    renderAdmin();
    const settings = await card();
    await userEvent.click(
      await settings.findByRole("button", { name: "Turn off TOTP" }),
    );
    await userEvent.type(
      settings.getByLabelText("Code from the app, or a recovery code"),
      "654321",
    );
    await userEvent.click(
      settings.getByRole("button", { name: "Turn off TOTP" }),
    );
    expect(await settings.findByText("TOTP is off.")).toBeDefined();
    expect(bodyOf(fetch, "/api/totp/disable")).toEqual({
      body: { code: "654321" },
      csrf: "csrf-token-1",
    });
  });
});
