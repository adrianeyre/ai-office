import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Retention in Admin (PRD §7, FR-65), against a stubbed server.

const defaults = {
  requestBodiesDays: 7,
  requestMetadataDays: 90,
  activityDays: 365,
  connectionDeliveriesDays: 90,
};

function stubServer() {
  const state = { retention: defaults };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/retention" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as typeof defaults;
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        state.retention = body;
        return Promise.resolve(Response.json(state.retention));
      }
      if (url === "/api/office/retention") {
        return Promise.resolve(Response.json(state.retention));
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
  const heading = await screen.findByRole("heading", { name: "Retention" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Retention heading is not in a card.");
  }
  return within(element);
}

const bodiesLabel = "Request and response bodies (days)";
const metadataLabel = "Requests and usage (days)";
const activityLabel = "Activity Feed and Notices (days)";
const deliveriesLabel = "Connection deliveries (days)";

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("retention in Admin", () => {
  it("shows the defaults: 7 days, 90 days, a year and 90 days", async () => {
    stubServer();
    const view = await card();
    expect(
      (await view.findByLabelText<HTMLInputElement>(bodiesLabel)).value,
    ).toBe("7");
    expect(view.getByLabelText<HTMLInputElement>(metadataLabel).value).toBe(
      "90",
    );
    expect(view.getByLabelText<HTMLInputElement>(activityLabel).value).toBe(
      "365",
    );
    expect(view.getByLabelText<HTMLInputElement>(deliveriesLabel).value).toBe(
      "90",
    );
  });

  it("sets each period", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const set = async (label: string, value: string) => {
      const input = view.getByLabelText(label);
      await user.clear(input);
      await user.type(input, value);
    };
    await view.findByLabelText(bodiesLabel);
    await set(bodiesLabel, "2");
    await set(metadataLabel, "40");
    await set(activityLabel, "730");
    await set(deliveriesLabel, "30");
    await user.click(view.getByRole("button", { name: "Save retention" }));

    expect((await view.findByRole("status")).textContent).toBe(
      "Saved. Anything older is deleted now.",
    );
    expect(puts).toEqual([
      {
        body: {
          requestBodiesDays: 2,
          requestMetadataDays: 40,
          activityDays: 730,
          connectionDeliveriesDays: 30,
        },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("says what is wrong with periods it cannot take", async () => {
    const { puts } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    const activity = await view.findByLabelText(activityLabel);
    await user.clear(activity);
    await user.type(activity, "7");
    await user.click(view.getByRole("button", { name: "Save retention" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "The Activity Feed is kept for at least 30 days.",
    );
    const bodies = view.getByLabelText(bodiesLabel);
    await user.clear(activity);
    await user.type(activity, "365");
    await user.clear(bodies);
    await user.type(bodies, "120");
    await user.click(view.getByRole("button", { name: "Save retention" }));
    expect((await view.findByRole("alert")).textContent).toBe(
      "Bodies go with their request, so keep them no longer than requests' records.",
    );
    expect(puts).toEqual([]);
  });
});
