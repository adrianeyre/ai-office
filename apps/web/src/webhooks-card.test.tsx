import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The GitHub App's webhooks in Admin (PRD FR-8), against a stubbed server.

const secret = "the-app-webhook-secret-0123456789";

function stubServer() {
  const state = { enabled: false, secretSet: false };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/webhooks" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as {
          enabled: boolean;
          secret?: string;
        };
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        if (body.enabled && !state.secretSet && body.secret === undefined) {
          return Promise.resolve(
            Response.json(
              {
                error: "webhook_secret_required",
                message:
                  "Give the webhook secret to turn webhooks on: the one set on the GitHub App.",
              },
              { status: 400 },
            ),
          );
        }
        state.enabled = body.enabled;
        state.secretSet ||= body.secret !== undefined;
        return Promise.resolve(Response.json(state));
      }
      if (url === "/api/office/webhooks") {
        return Promise.resolve(Response.json(state));
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
  const heading = await screen.findByRole("heading", {
    name: "GitHub webhooks",
  });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The GitHub webhooks heading is not in a card.");
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

describe("GitHub webhooks in Admin", () => {
  it("are off, and say where GitHub delivers and which events to send", async () => {
    stubServer();
    const webhooks = await card();
    expect(
      (
        await webhooks.findByLabelText<HTMLInputElement>(
          "Take the GitHub App's webhooks",
        )
      ).checked,
    ).toBe(false);
    expect(webhooks.getByText(/\/api\/github\/webhooks$/).tagName).toBe("CODE");
    expect(
      webhooks.getByText(
        /Issues, Label, Pull request, Check run, Check suite\./,
      ),
    ).toBeDefined();
  });

  it("are turned on with a secret, which is not shown again", async () => {
    const { puts } = stubServer();
    const webhooks = await card();
    await userEvent.click(
      await webhooks.findByLabelText("Take the GitHub App's webhooks"),
    );
    const input = webhooks.getByLabelText<HTMLInputElement>("Webhook secret");
    expect(input.type).toBe("password");
    await userEvent.type(input, secret);
    await userEvent.click(
      webhooks.getByRole("button", { name: "Save webhooks" }),
    );

    expect((await webhooks.findByRole("status")).textContent).toBe("Saved.");
    expect(puts).toEqual([
      { body: { enabled: true, secret }, csrf: "csrf-token-1" },
    ]);
    expect(input.value).toBe("");
    expect(
      await webhooks.findByText(/A secret is kept\. Leave this empty/),
    ).toBeDefined();
  });

  it("say why they cannot be turned on without a secret", async () => {
    stubServer();
    const webhooks = await card();
    await userEvent.click(
      await webhooks.findByLabelText("Take the GitHub App's webhooks"),
    );
    await userEvent.click(
      webhooks.getByRole("button", { name: "Save webhooks" }),
    );
    expect((await webhooks.findByRole("alert")).textContent).toContain(
      "Give the webhook secret to turn webhooks on",
    );
  });

  it("refuse too short a secret before sending it", async () => {
    const { puts } = stubServer();
    const webhooks = await card();
    await userEvent.type(
      await webhooks.findByLabelText("Webhook secret"),
      "short",
    );
    await userEvent.click(
      webhooks.getByRole("button", { name: "Save webhooks" }),
    );
    expect((await webhooks.findByRole("alert")).textContent).toContain(
      "The webhook secret is at least 20 characters.",
    );
    expect(puts).toEqual([]);
  });
});
