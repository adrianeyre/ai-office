import type { GitHubConnection } from "@ai-office/shared";
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

// The GitHub card of Floor Settings (ADR 0011), against a stubbed server:
// GitHub Apps and access tokens added, disabled and removed there.

const pem =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAwxyz\n-----END RSA PRIVATE KEY-----";
const writer = "github_pat_11AAAAAAA0writer9f3c";
const reader = "github_pat_11AAAAAAA0reader7b2e";

interface Sent {
  method: string;
  url: string;
  body: unknown;
  csrf: string | null;
}

function stubServer(initial: GitHubConnection[] = []) {
  const connections = [...initial];
  const sent: Sent[] = [];
  let ids = 0;
  const added = (connection: Omit<GitHubConnection, "id" | "createdAt">) => {
    const made = {
      ...connection,
      id: `connection-${String(++ids)}`,
      createdAt: "2026-10-14T12:00:00.000Z",
    };
    connections.push(made);
    return Response.json(made, { status: 201 });
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        sent.push({
          method,
          url,
          body:
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as unknown)
              : undefined,
          csrf: new Headers(init?.headers).get("x-csrf-token"),
        });
      }
      if (url === "/api/github/connections") {
        return Promise.resolve(
          Response.json({
            connections: [
              ...connections.filter(({ kind }) => kind === "app"),
              ...connections.filter(({ kind }) => kind !== "app"),
            ],
          }),
        );
      }
      if (url === "/api/github/connections/apps") {
        const body = JSON.parse(init?.body as string) as {
          name?: string;
          appId: string;
        };
        return Promise.resolve(
          added({
            kind: "app",
            name: body.name ?? `GitHub App ${body.appId}`,
            appId: body.appId,
            hint: "wxyz",
            enabled: true,
          }),
        );
      }
      if (url === "/api/github/connections/access-tokens") {
        const body = JSON.parse(init?.body as string) as { name?: string };
        return Promise.resolve(
          added({
            kind: "access-token",
            name: body.name ?? "Access token …9f3c",
            appId: null,
            hint: "9f3c",
            enabled: true,
          }),
        );
      }
      const one = /^\/api\/github\/connections\/(.+)$/.exec(url);
      if (one !== null) {
        const at = connections.findIndex(({ id }) => id === one[1]);
        if (method === "DELETE") {
          connections.splice(at, 1);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        const kept = connections[at];
        if (kept !== undefined) {
          const changed = {
            ...kept,
            ...(JSON.parse(init?.body as string) as object),
          };
          connections[at] = changed;
          return Promise.resolve(Response.json(changed));
        }
      }
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({
            csrfToken: "csrf-token-1",
            expiresAt: "2026-10-15T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/floors") {
        return Promise.resolve(Response.json({ floors: [] }));
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  return { sent };
}

async function card() {
  render(
    <App
      router={createAppRouter(
        createMemoryHistory({ initialEntries: ["/floor-settings"] }),
      )}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  const heading = await screen.findByRole("heading", { name: "GitHub" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The GitHub heading is not in a card.");
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

describe("the GitHub card in Floor Settings", () => {
  it("says none is set up yet", async () => {
    stubServer();
    const github = await card();
    expect(
      await github.findByText(
        "No GitHub App or access token yet: add one to add Floors.",
      ),
    ).toBeDefined();
  });

  it("adds a GitHub App, with the CSRF token, and lists it without its key", async () => {
    const { sent } = stubServer();
    const github = await card();
    const form = within(github.getByRole("form", { name: "Add a GitHub App" }));
    await userEvent.type(form.getByLabelText("App ID"), "123456");
    await userEvent.click(form.getByLabelText("Private key"));
    await userEvent.paste(pem);
    await userEvent.click(form.getByRole("button", { name: "Add GitHub App" }));

    expect((await form.findByRole("status")).textContent).toBe(
      "Added GitHub App 123456.",
    );
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/github/connections/apps",
        body: { appId: "123456", privateKey: pem },
        csrf: "csrf-token-1",
      },
    ]);
    const row = await github.findByRole("listitem", {
      name: "GitHub App 123456",
    });
    expect(row.textContent).toContain("App ID 123456 · key …wxyz");
    expect(row.textContent).not.toContain("MIIE");
    expect(form.getByLabelText<HTMLTextAreaElement>("Private key").value).toBe(
      "",
    );
  });

  it("adds an access token with its read-only partner, refusing the same token twice before sending it", async () => {
    const { sent } = stubServer();
    const github = await card();
    const form = within(
      github.getByRole("form", { name: "Add an access token" }),
    );
    const token = form.getByLabelText<HTMLInputElement>("Access token");
    expect(token.type).toBe("password");
    await userEvent.type(token, writer);
    await userEvent.type(form.getByLabelText("Read-only access token"), writer);
    await userEvent.click(
      form.getByRole("button", { name: "Add access token" }),
    );
    expect((await form.findByRole("alert")).textContent).toContain(
      "The read-only token must be another token",
    );
    expect(sent).toEqual([]);

    await userEvent.clear(form.getByLabelText("Read-only access token"));
    await userEvent.type(form.getByLabelText("Read-only access token"), reader);
    await userEvent.type(form.getByLabelText("Name (optional)"), "Mine");
    await userEvent.click(
      form.getByRole("button", { name: "Add access token" }),
    );
    expect(await github.findByRole("listitem", { name: "Mine" })).toBeDefined();
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/github/connections/access-tokens",
        body: { name: "Mine", token: writer, readOnlyToken: reader },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("disables and removes one", async () => {
    const { sent } = stubServer([
      {
        id: "app-1",
        kind: "app",
        name: "Acme",
        appId: "7",
        hint: "wxyz",
        enabled: true,
        createdAt: "2026-10-14T12:00:00.000Z",
      },
    ]);
    const github = await card();
    const row = within(await github.findByRole("listitem", { name: "Acme" }));
    await userEvent.click(row.getByRole("button", { name: "Disable Acme" }));
    expect(await row.findByText("Disabled")).toBeDefined();
    await userEvent.click(row.getByRole("button", { name: "Remove Acme" }));
    await userEvent.click(
      row.getByRole("button", { name: "Yes, remove Acme" }),
    );
    await waitFor(() => {
      expect(github.queryByRole("listitem", { name: "Acme" })).toBeNull();
    });
    expect(sent).toEqual([
      {
        method: "PATCH",
        url: "/api/github/connections/app-1",
        body: { enabled: false },
        csrf: "csrf-token-1",
      },
      {
        method: "DELETE",
        url: "/api/github/connections/app-1",
        body: undefined,
        csrf: "csrf-token-1",
      },
    ]);
  });
});
