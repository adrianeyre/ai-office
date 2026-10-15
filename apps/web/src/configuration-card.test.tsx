import type { Configuration, ConfigurationPreview } from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// Configuration export and import in Admin (PRD FR-65), against a stubbed
// server: the export is a download; an import is previewed, then applied.

const configuration: Configuration = {
  format: "ai-office.configuration",
  version: 1,
  exportedAt: "2026-10-10T09:00:00.000Z",
  office: {
    gitIdentity: null,
    intake: { ownerLogin: "adrianeyre", intervalSeconds: 60 },
    sandboxes: { concurrencyLimit: 3 },
    requestBodies: { store: true },
    loadBalancing: { strategy: "session", sessionWindowMinutes: 300 },
    retries: {
      attempts: 3,
      delayMs: 500,
      multiplier: 2,
      circuitBreakerThreshold: 5,
      circuitBreakerCooldownSeconds: 60,
    },
    usageThrottling: { fiveHourPacing: false, weeklyPacing: false },
    promptCache: { ttl: "as_sent" },
    tokenCaps: { daily: 5_000_000, monthly: 100_000_000 },
    retention: {
      requestBodiesDays: 7,
      requestMetadataDays: 90,
      activityDays: 365,
      connectionDeliveriesDays: 90,
    },
  },
  aiProviders: [],
  modelPrices: [],
  officeMemory: "",
  skills: [],
  roles: [],
  floorTemplates: [],
  floors: [],
};

function stubServer(preview: ConfigurationPreview) {
  const posts: { url: string; body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (
        url.startsWith("/api/configuration/import") &&
        init?.method === "POST"
      ) {
        posts.push({
          url,
          body: JSON.parse(init.body as string) as unknown,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        if (url.endsWith("/import") && preview.problems.length > 0) {
          return Promise.resolve(
            Response.json(
              {
                error: "configuration_conflicts",
                message: "The configuration was not imported: it has problems.",
                problems: preview.problems,
              },
              { status: 409 },
            ),
          );
        }
        return Promise.resolve(Response.json(preview));
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
  return { posts };
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
  const heading = await screen.findByRole("heading", { name: "Configuration" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Configuration heading is not in a card.");
  }
  const view = within(element);
  // Files can be chosen once the session is read.
  await vi.waitFor(() => {
    expect(
      view.getByLabelText<HTMLInputElement>("Import a configuration").disabled,
    ).toBe(false);
  });
  return view;
}

const file = (content: string, name = "ai-office-configuration.json") =>
  new File([content], name, { type: "application/json" });

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("configuration in Admin", () => {
  it("downloads the export", async () => {
    stubServer({ changes: [], problems: [] });
    const view = await card();
    const link = view.getByRole("link", { name: "Export configuration" });
    expect(link.getAttribute("href")).toBe("/api/configuration/export");
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("previews an import, then applies it", async () => {
    const { posts } = stubServer({
      changes: [
        {
          area: "floor",
          subject: "web-shop",
          action: "add",
          fields: [],
          note: "adrianeyre/web-shop, with 4 Agents.",
        },
        {
          area: "office",
          subject: "sandboxes",
          action: "change",
          fields: ["concurrencyLimit"],
          note: null,
        },
        {
          area: "skill",
          subject: "release-notes",
          action: "add",
          fields: [],
          note: "It waits for your review before it is enabled.",
        },
      ],
      problems: [],
    });
    const user = userEvent.setup();
    const view = await card();
    await user.upload(
      view.getByLabelText("Import a configuration"),
      file(JSON.stringify(configuration)),
    );

    expect(
      await view.findByText(
        "What importing ai-office-configuration.json would do",
      ),
    ).toBeDefined();
    const floors = view.getByRole("region", { name: "Floors" });
    expect(floors.textContent).toContain(
      "Add web-shop adrianeyre/web-shop, with 4 Agents.",
    );
    expect(
      view.getByRole("region", { name: "Office settings" }).textContent,
    ).toContain("Change sandboxes: concurrencyLimit");
    expect(view.getByRole("region", { name: "Skills" }).textContent).toContain(
      "It waits for your review before it is enabled.",
    );
    expect(posts.map(({ url }) => url)).toEqual([
      "/api/configuration/import/preview",
    ]);

    await user.click(
      view.getByRole("button", { name: "Import these changes" }),
    );
    expect((await view.findByRole("status")).textContent).toBe(
      "Imported: 3 changes.",
    );
    expect(posts).toEqual([
      {
        url: "/api/configuration/import/preview",
        body: configuration,
        csrf: "csrf-token-1",
      },
      {
        url: "/api/configuration/import",
        body: configuration,
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("shows what stops an import, and does not offer it", async () => {
    stubServer({
      changes: [],
      problems: [
        "adrianeyre/web-shop is the Floor web-shop here, not shop-again.",
      ],
    });
    const user = userEvent.setup();
    const view = await card();
    await user.upload(
      view.getByLabelText("Import a configuration"),
      file(JSON.stringify(configuration)),
    );
    expect(
      (await view.findByText(/is the Floor web-shop here/)).textContent,
    ).toBe("adrianeyre/web-shop is the Floor web-shop here, not shop-again.");
    expect(
      view.getByRole<HTMLButtonElement>("button", {
        name: "Import these changes",
      }).disabled,
    ).toBe(true);
  });

  it("says when a file is not an export, without sending it", async () => {
    const { posts } = stubServer({ changes: [], problems: [] });
    const user = userEvent.setup();
    const view = await card();
    await user.upload(
      view.getByLabelText("Import a configuration"),
      file("not json", "notes.json"),
    );
    expect((await view.findByRole("alert")).textContent).toBe(
      "notes.json is not JSON.",
    );
    await user.upload(
      view.getByLabelText("Import a configuration"),
      file(JSON.stringify({ format: "something-else" })),
    );
    expect((await view.findByRole("alert")).textContent).toContain(
      "This is not an AI Office configuration export.",
    );
    expect(posts).toEqual([]);
  });
});
