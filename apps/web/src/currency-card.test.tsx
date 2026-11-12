import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app.tsx";
import { formatMoney, useMoney } from "./money.ts";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The currency costs are shown in, in General Settings, against a stubbed
// server: British pounds until the Owner chooses another, converted at the
// day's rate or the Owner's own.

const rates = { USD: 1, GBP: 0.75, EUR: 0.86, JPY: 150 };

function stubServer(initial: { currency: string; manualRate: number | null }) {
  const state = {
    ...initial,
    rates: rates as Record<string, number> | null,
    ratesUpdatedAt: "2026-11-12T00:00:00.000Z" as string | null,
  };
  const puts: { body: unknown; csrf: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/office/currency" && init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as {
          currency: string;
          manualRate: number | null;
        };
        puts.push({
          body,
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        Object.assign(state, body);
        return Promise.resolve(Response.json(state));
      }
      if (url === "/api/office/currency") {
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
  return { puts, state };
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
  const heading = await screen.findByRole("heading", { name: "Currency" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The Currency heading is not in a card.");
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

// General Settings is a long page: it takes a while to render.
describe("the Currency card", { timeout: 20_000 }, () => {
  it("shows British pounds at the day's rate until the Owner chooses another", async () => {
    stubServer({ currency: "GBP", manualRate: null });
    const currency = await card();

    const select = await currency.findByRole<HTMLSelectElement>("combobox", {
      name: "Currency",
    });
    expect(select.value).toBe("GBP");
    expect(
      currency.getByText("Today, one US dollar is 0.75 GBP."),
    ).toBeDefined();
    expect(
      currency.getByText(/A cost of \$1\.00 shows as £0\.75\./),
    ).toBeDefined();
    // Every currency in the world is offered.
    expect(select.options.length).toBeGreaterThan(150);
  });

  it("saves another currency, and the Owner's own rate", async () => {
    const { puts } = stubServer({ currency: "GBP", manualRate: null });
    const user = userEvent.setup();
    const currency = await card();

    await user.selectOptions(
      await currency.findByRole("combobox", { name: "Currency" }),
      "EUR",
    );
    await user.type(
      currency.getByLabelText("Your own rate (one US dollar in EUR)"),
      "0.9",
    );
    await user.click(currency.getByRole("button", { name: "Save currency" }));

    expect(
      await currency.findByText(
        "Saved. Every cost is now shown in Euro (EUR).",
      ),
    ).toBeDefined();
    expect(puts).toEqual([
      {
        body: { currency: "EUR", manualRate: 0.9 },
        csrf: "csrf-token-1",
      },
    ]);
    expect(
      currency.getByText(/A cost of \$1\.00 shows as €0\.90\./),
    ).toBeDefined();
  });
});

/** A cost, as a page shows it. */
function Cost({ usd }: { usd: number }) {
  return <span>{formatMoney(usd, useMoney())}</span>;
}

describe("a cost on any page", () => {
  const renderCost = () =>
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Cost usd={10} />
      </QueryClientProvider>,
    );

  it("is shown in the office's currency", async () => {
    stubServer({ currency: "JPY", manualRate: null });
    renderCost();

    expect(await screen.findByText("¥1,500")).toBeDefined();
  });

  it("is shown in US dollars while there is no rate", async () => {
    const { state } = stubServer({ currency: "GBP", manualRate: null });
    state.rates = null;
    state.ratesUpdatedAt = null;
    renderCost();

    expect(await screen.findByText("$10.00")).toBeDefined();
  });
});
