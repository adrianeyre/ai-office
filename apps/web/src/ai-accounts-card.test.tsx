import type { AiAccount } from "@ai-office/shared";
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
import { eventSources, type EventSourceLike } from "./event-stream.ts";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The AI Accounts in AI Settings (PRD FR-35, FR-36), against a stubbed server
// that behaves as the API does: it never sends a credential back.

const key = "sk-ant-api03-webtestkey-Zx8Yw7Vu6Ts5Rq4Po3Nm2Lk1";

interface Sent {
  method: string;
  url: string;
  body: unknown;
  csrf: string | null;
}

/** What the stub's sign-in gives an account: a token valid for 8 hours. */
const freshToken = {
  tokenHealth: "valid",
  tokenExpiresAt: "2026-10-09T20:00:00.000Z",
  reauthenticationNeeded: false,
  limitReason: null,
  limitedUntil: null,
  usage: { fiveHour: null, weekly: null },
  fiveHourPauseThreshold: null,
  weeklyPauseThreshold: null,
} as const;

const authorizeUrl =
  "https://claude.ai/oauth/authorize?code=true&client_id=client&code_challenge=abc&code_challenge_method=S256";

/** The name the next subscription signed in to is added under. */
const pendingName = "Claude Max";

function stubServer(initial: AiAccount[] = []) {
  let accounts = [...initial];
  let next = initial.length;
  /** The subscription the next sign-in adds. */
  let pending = { name: pendingName, aiProvider: "Claude" };
  const sent: Sent[] = [];
  /** Each account's series asked for, by its query. */
  const series: Record<string, string>[] = [];
  /** The account a sign-in finished on AI Office's own callback added. */
  let calledBack: AiAccount | undefined;
  const byPriority = () =>
    [...accounts].sort(
      (a, b) =>
        a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
    );
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "/api/ai-accounts/oauth/login-1") {
        return Promise.resolve(
          Response.json(
            calledBack === undefined
              ? { status: "pending" }
              : { status: "done", account: calledBack, added: true },
          ),
        );
      }
      if (url.startsWith("/api/ai-accounts") && method !== "GET") {
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined;
        sent.push({
          method,
          url,
          body,
          csrf: new Headers(init?.headers).get("x-csrf-token"),
        });
        const id = decodeURIComponent(url.split("/")[3] ?? "");
        if (method === "POST" && url === "/api/ai-accounts/oauth") {
          // xAI's and Qwen's are device logins: a code to approve,
          // nothing to paste.
          const device = (
            {
              Grok: [
                "https://accounts.x.ai/device?user_code=WXYZ-1234",
                "WXYZ-1234",
              ],
              Qwen: [
                "https://chat.qwen.ai/authorize?user_code=QWEN-1234",
                "QWEN-1234",
              ],
            } as Partial<Record<string, [string, string]>>
          )[String(body?.["aiProvider"])];
          if (device !== undefined) {
            pending = {
              name: String(body?.["name"]),
              aiProvider: String(body?.["aiProvider"]),
            };
            return Promise.resolve(
              Response.json(
                {
                  loginId: "login-1",
                  authorizeUrl: device[0],
                  userCode: device[1],
                  expiresAt: "2026-10-09T12:10:00.000Z",
                },
                { status: 201 },
              ),
            );
          }
          pending = {
            name: String(body?.["name"]),
            aiProvider: String(body?.["aiProvider"]),
          };
          return Promise.resolve(
            Response.json(
              {
                loginId: "login-1",
                authorizeUrl: `${authorizeUrl}&state=new`,
                expiresAt: "2026-10-09T12:15:00.000Z",
              },
              { status: 201 },
            ),
          );
        }
        if (method === "POST" && url === "/api/ai-accounts/import") {
          next += 1;
          const account: AiAccount = {
            ...work,
            id: `account-${String(next)}`,
            name: String(body?.["name"]),
            aiProvider: String(body?.["aiProvider"]),
            accountType: "oauth",
            ...freshToken,
          };
          accounts.push(account);
          return Promise.resolve(Response.json(account, { status: 201 }));
        }
        if (method === "POST" && url.endsWith("/refresh-usage")) {
          accounts = accounts.map((account) =>
            account.id === id
              ? {
                  ...account,
                  usage: {
                    fiveHour: {
                      utilization: 41,
                      resetsAt: "2026-10-09T15:00:00.000Z",
                    },
                    weekly: {
                      utilization: 63.5,
                      resetsAt: "2026-10-14T09:00:00.000Z",
                    },
                  },
                }
              : account,
          );
          return Promise.resolve(
            Response.json(accounts.find((account) => account.id === id)),
          );
        }
        if (method === "POST" && url.endsWith("/reset-limits")) {
          accounts = accounts.map((account) =>
            account.id === id
              ? {
                  ...account,
                  limitReason: null,
                  limitedUntil: null,
                  usage: { fiveHour: null, weekly: null },
                }
              : account,
          );
          return Promise.resolve(
            Response.json(accounts.find((account) => account.id === id)),
          );
        }
        if (method === "POST" && url.endsWith("/reauthenticate")) {
          return Promise.resolve(
            Response.json(
              {
                loginId: `login-${id}`,
                authorizeUrl: `${authorizeUrl}&state=again`,
                expiresAt: "2026-10-09T12:15:00.000Z",
              },
              { status: 201 },
            ),
          );
        }
        if (method === "POST" && url.startsWith("/api/ai-accounts/oauth/")) {
          // Signing in again: the account it was for gets a fresh token.
          const again = accounts.find(
            (account) => url === `/api/ai-accounts/oauth/login-${account.id}`,
          );
          if (again !== undefined) {
            accounts = accounts.map((account) =>
              account === again ? { ...account, ...freshToken } : account,
            );
            return Promise.resolve(
              Response.json(accounts.find(({ id: each }) => each === again.id)),
            );
          }
          next += 1;
          const account: AiAccount = {
            ...work,
            id: `account-${String(next)}`,
            name: pending.name,
            aiProvider: pending.aiProvider,
            accountType: "oauth",
            priority:
              Math.max(0, ...accounts.map(({ priority }) => priority)) + 1,
            ...freshToken,
          };
          accounts.push(account);
          return Promise.resolve(Response.json(account, { status: 201 }));
        }
        if (method === "POST") {
          // As the API does, it keeps the key and never sends it back.
          const rest = body as Record<string, string>;
          if (accounts.some((account) => account.name === rest["name"])) {
            return Promise.resolve(
              Response.json(
                {
                  error: "ai_account_name_taken",
                  message: `Another AI Account is already called "${rest["name"] ?? ""}".`,
                },
                { status: 409 },
              ),
            );
          }
          next += 1;
          const account: AiAccount = {
            id: `account-${String(next)}`,
            name: rest["name"] ?? "",
            aiProvider: "Claude",
            accountType:
              rest["accountType"] === "bedrock" ||
              rest["accountType"] === "vertex"
                ? rest["accountType"]
                : "api_key",
            endpointUrl: rest["endpointUrl"] ?? null,
            region: rest["region"] ?? null,
            projectId:
              rest["accountType"] === "vertex"
                ? (rest["projectId"] ?? "from-the-key")
                : null,
            priority:
              Math.max(0, ...accounts.map(({ priority }) => priority)) + 1,
            paused: false,
            tokenHealth: null,
            tokenExpiresAt: null,
            reauthenticationNeeded: false,
            limitReason: null,
            limitedUntil: null,
            usage: { fiveHour: null, weekly: null },
            fiveHourPauseThreshold: null,
            weeklyPauseThreshold: null,
            forcedModel: null,
            extraUsage: null,
            createdAt: `2026-10-09T12:00:0${String(next)}.000Z`,
            updatedAt: `2026-10-09T12:00:0${String(next)}.000Z`,
          };
          accounts.push(account);
          return Promise.resolve(Response.json(account, { status: 201 }));
        }
        if (method === "PATCH") {
          accounts = accounts.map((account) =>
            account.id === id ? { ...account, ...(body as object) } : account,
          );
          return Promise.resolve(
            Response.json(accounts.find((account) => account.id === id)),
          );
        }
        accounts = accounts.filter((account) => account.id !== id);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "/api/ai-accounts") {
        return Promise.resolve(Response.json({ accounts: byPriority() }));
      }
      if (url.endsWith("/usage")) {
        // An API key's AI Provider reports no usage windows.
        return Promise.resolve(
          Response.json({
            usage: url.includes("account-work") ? [] : usageHistory,
          }),
        );
      }
      if (url.startsWith("/api/analytics/series?")) {
        const query = new URL(url, "http://localhost").searchParams;
        series.push(Object.fromEntries(query));
        return Promise.resolve(
          Response.json(seriesOf(query.get("from") ?? "")),
        );
      }
      if (url === "/api/session") {
        return Promise.resolve(
          Response.json({
            csrfToken: "csrf-token-1",
            expiresAt: "2026-10-15T12:00:00.000Z",
            // ALLOWED_INTERNAL_HOSTS, as the server sends it (ADR 0007):
            // the Owner's own Ollama, GPU box and LiteLLM.
            allowedInternalHosts: ["localhost", ".lan", ".corp"],
          }),
        );
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  return {
    sent,
    series,
    /** Finishes the sign-in as AI Office's callback would. */
    callBack() {
      next += 1;
      calledBack = {
        ...work,
        id: `account-${String(next)}`,
        name: pending.name,
        aiProvider: pending.aiProvider,
        accountType: "oauth",
        ...freshToken,
      };
      accounts.push(calledBack);
    },
    /** Changes an account as the server would, without the page knowing. */
    change(id: string, fields: Partial<AiAccount>) {
      accounts = accounts.map((account) =>
        account.id === id ? { ...account, ...fields } : account,
      );
    },
  };
}

const work: AiAccount = {
  id: "account-work",
  name: "Work",
  aiProvider: "Claude",
  accountType: "api_key",
  endpointUrl: null,
  region: null,
  projectId: null,
  priority: 1,
  paused: false,
  tokenHealth: null,
  tokenExpiresAt: null,
  reauthenticationNeeded: false,
  limitReason: null,
  limitedUntil: null,
  usage: { fiveHour: null, weekly: null },
  fiveHourPauseThreshold: null,
  weeklyPauseThreshold: null,
  forcedModel: null,
  extraUsage: null,
  createdAt: "2026-10-09T11:00:00.000Z",
  updatedAt: "2026-10-09T11:00:00.000Z",
};

/** The totals of an hour, or of a week, through one account. */
const totals = (requests: number, tokens: number) => ({
  requests,
  errors: 0,
  errorRate: 0,
  inputTokens: tokens,
  outputTokens: 0,
  cacheReadTokens: tokens * 10,
  cacheWriteTokens: 0,
  tokens,
  estimatedCostUsd: 0,
  averageLatencyMs: requests === 0 ? null : 100,
  averageTimeToFirstByteMs: null,
  keepAliveRequests: 0,
  keepAliveCostUsd: 0,
});

/**
 * An account's week by the hour, as the stubbed server answers it: two
 * requests of 1,200 tokens in its last hour, none before.
 */
const seriesOf = (from: string) => ({
  bucket: "hour",
  totals: totals(2, 1_200),
  points: Array.from({ length: 168 }, (_, index) => ({
    at: new Date(Date.parse(from) + index * 3_600_000).toISOString(),
    ...(index === 167 ? totals(2, 1_200) : totals(0, 0)),
  })),
});

/** Each account's usage history, as the stubbed server answers it. */
const usageHistory = [
  {
    window: "five_hour",
    utilization: 82,
    resetsAt: "2026-10-09T14:00:00.000Z",
    observedAt: "2026-10-09T12:00:00.000Z",
  },
  {
    window: "weekly",
    utilization: 36.4,
    resetsAt: "2026-10-12T09:00:00.000Z",
    observedAt: "2026-10-09T12:00:00.000Z",
  },
];

const max: AiAccount = {
  ...work,
  id: "account-max",
  name: "Claude Max",
  accountType: "oauth",
  priority: 2,
  tokenHealth: "expiring",
  tokenExpiresAt: "2026-10-09T12:10:00.000Z",
  reauthenticationNeeded: true,
  // A Claude subscription offers extra usage; it is off.
  extraUsage: false,
};

async function card(path = "/ai-settings") {
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  const heading = await screen.findByRole("heading", { name: "AI Accounts" });
  const element = heading.closest<HTMLElement>("[data-slot=card]");
  if (element === null) {
    throw new Error("The AI Accounts heading is not in a card.");
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

describe("the AI Accounts in AI Settings", () => {
  it("says when there are none", async () => {
    stubServer();
    const view = await card();
    expect(await view.findByText(/No AI Accounts yet/)).toBeTruthy();
  });

  it("adds an Anthropic Console API key, then clears the key from the page", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await view.findByText(/No AI Accounts yet/);

    const type = view.getByLabelText<HTMLSelectElement>("Account type");
    expect(type.selectedOptions[0]?.textContent).toBe(
      "Anthropic Console API key",
    );
    const keyField = view.getByLabelText<HTMLInputElement>("API key");
    expect(keyField.type).toBe("password");
    await user.type(view.getByLabelText("Name"), "Work");
    await user.type(keyField, key);
    await user.click(view.getByRole("button", { name: "Add AI Account" }));

    expect((await view.findByRole("status")).textContent).toContain(
      "Added Work. Its key is stored encrypted and will not be shown again.",
    );
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/ai-accounts",
        body: {
          name: "Work",
          aiProvider: "Claude",
          accountType: "api_key",
          credential: key,
          endpointUrl: null,
        },
        csrf: "csrf-token-1",
      },
    ]);
    const row = await view.findByRole("listitem", { name: "Work" });
    expect(row.textContent).toContain(
      "WorkActiveAnthropic Console API key · Priority 1",
    );
    expect(keyField.value).toBe("");
    expect(document.body.innerHTML).not.toContain(key);
  });

  it("shows why an account was not added", async () => {
    stubServer([work]);
    const user = userEvent.setup();
    const view = await card();
    await view.findByRole("listitem", { name: "Work" });

    await user.click(view.getByRole("button", { name: "Add AI Account" }));
    expect((await view.findByRole("alert")).textContent).toContain(
      "Give the AI Account a name.Enter the API key.",
    );

    await user.type(view.getByLabelText("Name"), "Work");
    await user.type(view.getByLabelText("API key"), key);
    await user.type(
      view.getByLabelText("Custom endpoint URL"),
      "https://proxy.example",
    );
    await user.click(view.getByRole("button", { name: "Add AI Account" }));
    expect((await view.findByRole("alert")).textContent).toContain(
      'Another AI Account is already called "Work".',
    );
  });

  it("pauses, resumes, renames and reprioritises an account", async () => {
    const { sent } = stubServer([
      work,
      {
        ...work,
        id: "account-personal",
        name: "Personal",
        priority: 2,
        endpointUrl: "https://proxy.example/anthropic",
      },
    ]);
    const user = userEvent.setup();
    const view = await card();
    const list = await view.findByRole("list", { name: "Claude accounts" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Work", "Personal"]);
    expect(
      within(list).getByRole("listitem", { name: "Personal" }).textContent,
    ).toContain("https://proxy.example/anthropic");

    await user.click(view.getByRole("button", { name: "Pause Work" }));
    expect(
      await view.findByRole("button", { name: "Resume Work" }),
    ).toBeTruthy();
    expect(view.getByRole("listitem", { name: "Work" }).textContent).toContain(
      "Paused",
    );
    await user.click(view.getByRole("button", { name: "Resume Work" }));
    await view.findByRole("button", { name: "Pause Work" });

    await user.click(view.getByRole("button", { name: "Edit Work" }));
    const form = view.getByRole("form", { name: "Edit Work" });
    await user.clear(within(form).getByLabelText("Name"));
    await user.type(within(form).getByLabelText("Name"), "Work (team)");
    await user.clear(within(form).getByLabelText("Priority"));
    await user.type(within(form).getByLabelText("Priority"), "3");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    await view.findByRole("listitem", { name: "Work (team)" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Personal", "Work (team)"]);
    expect(sent.map(({ method, url, body }) => [method, url, body])).toEqual([
      ["PATCH", "/api/ai-accounts/account-work", { paused: true }],
      ["PATCH", "/api/ai-accounts/account-work", { paused: false }],
      [
        "PATCH",
        "/api/ai-accounts/account-work",
        { name: "Work (team)", priority: 3 },
      ],
    ]);
  });

  it("deletes an account once the Owner confirms", async () => {
    const { sent } = stubServer([work]);
    const user = userEvent.setup();
    const view = await card();
    await view.findByRole("listitem", { name: "Work" });

    await user.click(view.getByRole("button", { name: "Delete Work" }));
    await user.click(view.getByRole("button", { name: "Cancel" }));
    expect(sent).toEqual([]);

    await user.click(view.getByRole("button", { name: "Delete Work" }));
    await user.click(view.getByRole("button", { name: "Yes, delete Work" }));
    expect(await view.findByText(/No AI Accounts yet/)).toBeTruthy();
    expect(sent).toEqual([
      {
        method: "DELETE",
        url: "/api/ai-accounts/account-work",
        body: undefined,
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("warns about the terms, then adds a Claude subscription through its sign-in", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await view.findByText(/No AI Accounts yet/);

    await user.selectOptions(
      view.getByLabelText("Account type"),
      "Claude subscription (Pro or Max)",
    );
    // A subscription has no key to type, and its terms come first.
    expect(view.queryByLabelText("API key")).toBeNull();
    expect(
      view.getByRole("note", { name: "The AI Provider's terms" }).textContent,
    ).toContain(
      "Anthropic's terms allow a Claude subscription to be used only through Claude Code.",
    );
    await user.type(view.getByLabelText("Name"), "Claude Max");
    await user.click(view.getByRole("button", { name: "Sign in to Claude" }));
    expect((await view.findByRole("alert")).textContent).toContain(
      "Confirm you have read the AI Provider's terms for subscriptions.",
    );
    expect(sent).toEqual([]);

    await user.click(view.getByRole("checkbox"));
    await user.click(view.getByRole("button", { name: "Sign in to Claude" }));
    const steps = await view.findByRole("form", {
      name: "Sign in to the subscription",
    });
    const page = within(steps).getByRole("link", {
      name: "Open Claude's sign-in page",
    });
    expect(page.getAttribute("href")).toBe(`${authorizeUrl}&state=new`);
    expect(page.getAttribute("target")).toBe("_blank");

    const code = "the-code-from-the-page#new";
    await user.type(within(steps).getByLabelText("Sign-in code"), code);
    await user.click(
      within(steps).getByRole("button", { name: "Finish signing in" }),
    );
    expect((await view.findByRole("status")).textContent).toContain(
      "Added Claude Max. It serves only Claude Code;",
    );
    expect(sent.map(({ method, url, body }) => [method, url, body])).toEqual([
      [
        "POST",
        "/api/ai-accounts/oauth",
        { name: "Claude Max", aiProvider: "Claude", acceptedTerms: true },
      ],
      ["POST", "/api/ai-accounts/oauth/login-1", { code }],
    ]);
    const row = await view.findByRole("listitem", { name: "Claude Max" });
    expect(row.textContent).toContain("Token valid until");
    expect(row.textContent).toContain(
      "Claude subscription (Pro or Max) · Priority 1 · Serves only Claude Code",
    );
    expect(document.body.innerHTML).not.toContain("the-code-from-the-page");
  });

  it("warns about OpenAI's terms, then adds a ChatGPT subscription with the address its sign-in ended on", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await view.findByText(/No AI Accounts yet/);

    await user.selectOptions(
      view.getByLabelText("Account type"),
      "ChatGPT subscription (Plus, Pro or Business), for Codex",
    );
    expect(view.queryByLabelText("API key")).toBeNull();
    expect(
      view.getByRole("note", { name: "The AI Provider's terms" }).textContent,
    ).toContain(
      "OpenAI's terms allow a ChatGPT subscription to be used for coding only through Codex",
    );
    // No CLI login to import: it signs in only.
    expect(view.queryByText(/Import an existing/)).toBeNull();
    await user.type(view.getByLabelText("Name"), "ChatGPT Plus");
    await user.click(view.getByRole("checkbox"));
    await user.click(view.getByRole("button", { name: "Sign in to OpenAI" }));
    const steps = await view.findByRole("form", {
      name: "Sign in to the subscription",
    });
    expect(
      within(steps).getByRole("link", { name: "Open OpenAI's sign-in page" }),
    ).toBeDefined();
    expect(steps.textContent).toContain("localhost:1455");

    const address =
      "http://localhost:1455/auth/callback?code=ac_the-code&scope=openid&state=new";
    await user.type(
      within(steps).getByLabelText("Address the sign-in ended on"),
      address,
    );
    await user.click(
      within(steps).getByRole("button", { name: "Finish signing in" }),
    );
    expect((await view.findByRole("status")).textContent).toContain(
      "Added ChatGPT Plus. It serves only Codex;",
    );
    expect(sent.map(({ method, url, body }) => [method, url, body])).toEqual([
      [
        "POST",
        "/api/ai-accounts/oauth",
        { name: "ChatGPT Plus", aiProvider: "ChatGPT", acceptedTerms: true },
      ],
      ["POST", "/api/ai-accounts/oauth/login-1", { code: address }],
    ]);
    const row = await view.findByRole("listitem", { name: "ChatGPT Plus" });
    expect(row.textContent).toContain("Token valid until");
    expect(row.textContent).toContain("Serves only Codex");
    expect(document.body.innerHTML).not.toContain("ac_the-code");
  });

  it("says a ChatGPT sign-in's callback page will not load when AI Office runs on another host, and to paste its address", async () => {
    vi.spyOn(location, "hostname").mockReturnValue(
      "ai-office.example.internal",
    );
    stubServer();
    const user = userEvent.setup();
    const view = await card();
    await view.findByText(/No AI Accounts yet/);
    await user.selectOptions(
      view.getByLabelText("Account type"),
      "ChatGPT subscription (Plus, Pro or Business), for Codex",
    );
    await user.type(view.getByLabelText("Name"), "ChatGPT Plus");
    await user.click(view.getByRole("checkbox"));
    await user.click(view.getByRole("button", { name: "Sign in to OpenAI" }));
    const steps = await view.findByRole("form", {
      name: "Sign in to the subscription",
    });
    expect(steps.textContent).toContain("This site can't be reached");
    expect(steps.textContent).toContain(
      "AI Office runs on ai-office.example.internal, not this computer.",
    );
    expect(steps.textContent).not.toContain("this finishes by itself");
    expect(
      within(steps).getByLabelText("Address the sign-in ended on"),
    ).toBeDefined();
  });

  it("finishes a ChatGPT sign-in by itself once AI Office's callback has", async () => {
    const server = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await view.findByText(/No AI Accounts yet/);
    await user.selectOptions(
      view.getByLabelText("Account type"),
      "ChatGPT subscription (Plus, Pro or Business), for Codex",
    );
    await user.type(view.getByLabelText("Name"), "ChatGPT Plus");
    await user.click(view.getByRole("checkbox"));
    await user.click(view.getByRole("button", { name: "Sign in to OpenAI" }));
    const steps = await view.findByRole("form", {
      name: "Sign in to the subscription",
    });
    expect(steps.textContent).toContain("this finishes by itself");
    // The browser lands on localhost:1455, which AI Office serves.
    server.callBack();
    expect(
      (await view.findByRole("status", {}, { timeout: 5000 })).textContent,
    ).toContain("Added ChatGPT Plus.");
    expect(
      await view.findByRole("listitem", { name: "ChatGPT Plus" }),
    ).toBeDefined();
    // Nothing was pasted.
    expect(server.sent.map(({ method, url }) => [method, url])).toEqual([
      ["POST", "/api/ai-accounts/oauth"],
    ]);
  });

  it("shows a subscription's token health live", async () => {
    const streams: (EventSourceLike & { send(data: unknown): void })[] = [];
    vi.spyOn(eventSources, "open").mockImplementation(() => {
      const source = {
        readyState: 1,
        onopen: null as EventSourceLike["onopen"],
        onmessage: null as EventSourceLike["onmessage"],
        onerror: null as EventSourceLike["onerror"],
        close: () => undefined,
        send(data: unknown) {
          source.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify(data) }),
          );
        },
      };
      streams.push(source);
      return source;
    });
    const server = stubServer([{ ...max, reauthenticationNeeded: false }]);
    const view = await card();
    const row = await view.findByRole("listitem", { name: "Claude Max" });
    expect(row.textContent).toContain("Token expiring");

    // The Gateway refreshed it, and says so.
    server.change("account-max", freshToken);
    for (const stream of streams) {
      stream.send({
        id: 7,
        occurredAt: "2026-10-09T12:05:00.000Z",
        event: {
          type: "ai_account.token_health",
          version: 1,
          aiAccountId: "account-max",
          name: "Claude Max",
          health: "valid",
          expiresAt: freshToken.tokenExpiresAt,
          reauthenticationNeeded: false,
        },
      });
    }
    await waitFor(() => {
      expect(
        view.getByRole("listitem", { name: "Claude Max" }).textContent,
      ).toContain("Token valid until");
    });
  });

  it("shows an account held back, live, and brings up an AI Provider's accounts from a Notice's link", async () => {
    const streams: (EventSourceLike & { send(data: unknown): void })[] = [];
    vi.spyOn(eventSources, "open").mockImplementation(() => {
      const source = {
        readyState: 1,
        onopen: null as EventSourceLike["onopen"],
        onmessage: null as EventSourceLike["onmessage"],
        onerror: null as EventSourceLike["onerror"],
        close: () => undefined,
        send(data: unknown) {
          source.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify(data) }),
          );
        },
      };
      streams.push(source);
      return source;
    });
    const until = "2026-10-09T13:00:00.000Z";
    const server = stubServer([work]);
    const view = await card("/ai-settings?aiProvider=Claude");
    const row = await view.findByRole("listitem", { name: "Work" });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.textContent).not.toContain("Rate-limited");

    server.change("account-work", {
      limitReason: "rate_limited",
      limitedUntil: until,
    });
    for (const stream of streams) {
      stream.send({
        id: 8,
        occurredAt: "2026-10-09T12:05:00.000Z",
        event: {
          type: "ai_account.limit_changed",
          version: 1,
          aiAccountId: "account-work",
          name: "Work",
          aiProvider: "Claude",
          reason: "rate_limited",
          until,
          providerAvailable: false,
        },
      });
    }
    await waitFor(() => {
      expect(
        view.getByRole("listitem", { name: "Work" }).textContent,
      ).toContain(`Rate-limited until ${new Date(until).toLocaleString()}`);
    });
  });

  it("draws each usage window full width, marking where an even pace would be by now", async () => {
    // Two hours into a five-hour window that resets at 14:00: 40%.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T11:00:00.000Z"));
    try {
      stubServer([
        {
          ...max,
          reauthenticationNeeded: false,
          usage: {
            fiveHour: { utilization: 55, resetsAt: "2026-10-09T14:00:00.000Z" },
            weekly: { utilization: 10, resetsAt: "2026-10-09T10:00:00.000Z" },
          },
          fiveHourPauseThreshold: 80,
        },
      ]);
      const view = await card();
      const row = await view.findByRole("listitem", { name: "Claude Max" });
      const usage = within(row).getByRole("list", {
        name: "Claude Max's usage",
      });
      expect(usage.textContent).toContain("even pace 40% · pauses at 80%");
      const meter = within(row).getByRole("meter", {
        name: "5-hour window used",
      });
      expect(meter.getAttribute("aria-valuetext")).toBe(
        "55% used; an even pace would be 40%",
      );
      expect(meter.className).toContain("w-full");
      // A window whose reset has passed has no pace to mark.
      expect(
        within(row)
          .getByRole("meter", { name: "Weekly window used" })
          .getAttribute("aria-valuetext"),
      ).toBe("10% used");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows usage windows and their history, sets pause thresholds, and force-resets", async () => {
    const limited: AiAccount = {
      ...max,
      reauthenticationNeeded: false,
      limitReason: "usage_threshold",
      limitedUntil: "2026-10-09T14:00:00.000Z",
      usage: {
        fiveHour: { utilization: 82, resetsAt: "2026-10-09T14:00:00.000Z" },
        weekly: null,
      },
      fiveHourPauseThreshold: 80,
    };
    const { sent } = stubServer([limited]);
    const user = userEvent.setup();
    const view = await card();
    const row = await view.findByRole("listitem", { name: "Claude Max" });
    const usage = within(row).getByRole("list", {
      name: "Claude Max's usage",
    });
    expect(usage.textContent).toContain("5-hour:82%, resets");
    expect(usage.textContent).toContain("pauses at 80%");
    expect(row.textContent).toContain("Paused at its usage threshold until");
    expect(
      within(row)
        .getByRole<HTMLMeterElement>("meter", {
          name: "5-hour window used",
        })
        .getAttribute("aria-valuenow"),
    ).toBe("82");

    // The history, each change of its windows.
    await user.click(
      within(row).getByRole("button", { name: "Claude Max's usage history" }),
    );
    const table = await within(row).findByRole("table", {
      name: "Claude Max's usage history",
    });
    expect(
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((tr) =>
          within(tr)
            .getAllByRole("cell")
            .slice(1, 3)
            .map((td) => td.textContent),
        ),
    ).toEqual([
      ["5-hour", "82%"],
      ["Weekly", "36.4%"],
    ]);

    // Thresholds: the weekly one set, the five-hour one removed.
    await user.click(view.getByRole("button", { name: "Edit Claude Max" }));
    const form = view.getByRole("form", { name: "Edit Claude Max" });
    await user.clear(
      within(form).getByLabelText("Pause at (% of the 5-hour window)"),
    );
    await user.type(
      within(form).getByLabelText("Pause at (% of the weekly window)"),
      "90",
    );
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sent.at(-1)).toMatchObject({
        method: "PATCH",
        url: "/api/ai-accounts/account-max",
        body: { fiveHourPauseThreshold: null, weeklyPauseThreshold: 90 },
      });
    });

    // Force-reset: it serves again at once.
    await user.click(
      await view.findByRole("button", { name: "Reset Claude Max's limits" }),
    );
    await waitFor(() => {
      expect(
        view.getByRole("listitem", { name: "Claude Max" }).textContent,
      ).not.toContain("Paused at its usage threshold");
    });
    expect(sent.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/ai-accounts/account-max/reset-limits",
      csrf: "csrf-token-1",
    });
    expect(
      view.queryByRole("button", { name: "Reset Claude Max's limits" }),
    ).toBeNull();
  });

  it("shows a Claude subscription's five-hour and weekly usage, and reads it again on demand", async () => {
    const { sent } = stubServer([
      { ...max, ...freshToken },
      { ...work, id: "account-work" },
    ]);
    const user = userEvent.setup();
    const view = await card();
    const row = await view.findByRole("listitem", { name: "Claude Max" });
    // Both windows, even before Anthropic has said anything.
    const usage = within(row).getByRole("list", { name: "Claude Max's usage" });
    expect(usage.textContent).toContain("5-hour:not reported");
    expect(usage.textContent).toContain("Weekly:not reported");
    // An API key has no usage windows to read.
    const key = view.getByRole("listitem", { name: "Work" });
    expect(
      within(key).queryByRole("list", { name: "Work's usage" }),
    ).toBeNull();
    expect(
      within(key).queryByRole("button", { name: "Refresh Work's usage" }),
    ).toBeNull();

    await user.click(
      within(row).getByRole("button", { name: "Refresh Claude Max's usage" }),
    );
    await waitFor(() => {
      expect(
        view.getByRole("list", { name: "Claude Max's usage" }).textContent,
      ).toContain("5-hour:41%, resets");
    });
    expect(
      view.getByRole("list", { name: "Claude Max's usage" }).textContent,
    ).toContain("Weekly:63.5%, resets");
    expect(sent.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/ai-accounts/account-max/refresh-usage",
      csrf: "csrf-token-1",
    });
  });

  it("gives every kind of account a usage bar: windows, rate limits, credit, or its share of the Gateway's tokens today", async () => {
    const today = { tokens: 1000, gatewayTokens: 4000 };
    const inAMinute = new Date(Date.now() + 60_000).toISOString();
    stubServer([
      // A Claude subscription: its 5-hour and weekly windows, as before.
      {
        ...max,
        ...freshToken,
        reauthenticationNeeded: false,
        usage: {
          fiveHour: { utilization: 41, resetsAt: inAMinute },
          weekly: null,
        },
        tokensToday: today,
      },
      // An API key whose answers carry rate-limit headers.
      {
        ...work,
        rateLimits: {
          requests: { limit: 50, remaining: 40, resetsAt: inAMinute },
          tokens: null,
          inputTokens: { limit: 30_000, remaining: 7500, resetsAt: null },
          outputTokens: null,
          observedAt: "2026-10-09T11:59:00.000Z",
        },
        balance: null,
        tokensToday: today,
      },
      // A prepaid key with a limit, and one with a balance only.
      {
        ...work,
        id: "account-openrouter",
        name: "OpenRouter",
        aiProvider: "OpenRouter",
        priority: 3,
        rateLimits: null,
        balance: {
          currency: "USD",
          used: 2.5,
          limit: 10,
          remaining: 7.5,
          observedAt: "2026-10-09T11:55:00.000Z",
        },
        tokensToday: today,
      },
      {
        ...work,
        id: "account-deepseek",
        name: "DeepSeek",
        aiProvider: "DeepSeek",
        priority: 4,
        rateLimits: null,
        balance: {
          currency: "USD",
          used: null,
          limit: null,
          remaining: 15.4,
          observedAt: "2026-10-09T11:55:00.000Z",
        },
        tokensToday: today,
      },
      // Nothing to report: its share of the Gateway's day.
      {
        ...work,
        id: "account-ollama",
        name: "Ollama",
        aiProvider: "Ollama",
        accountType: "endpoint",
        endpointUrl: "http://localhost:11434",
        priority: 5,
        rateLimits: null,
        balance: null,
        tokensToday: today,
      },
    ]);
    const view = await card();
    const meters = (name: string) =>
      within(view.getByRole("listitem", { name }))
        .getAllByRole("meter")
        .map((meter) => [
          meter.getAttribute("aria-label"),
          meter.getAttribute("aria-valuenow"),
        ]);
    await view.findByRole("listitem", { name: "Ollama" });

    expect(meters("Claude Max")).toEqual([["5-hour window used", "41"]]);
    expect(meters("Work")).toEqual([
      ["Requests left this minute", "80"],
      ["Input tokens left this minute", "25"],
    ]);
    expect(meters("OpenRouter")).toEqual([["Credit used", "25"]]);
    // A balance without a limit has no bar of its own.
    expect(meters("DeepSeek")).toEqual([
      ["Share of the AI Gateway's tokens today", "25"],
    ]);
    expect(
      view.getByRole("list", { name: "DeepSeek's limits and credit" })
        .textContent,
    ).toContain("Credit: US$15.40 left");
    expect(meters("Ollama")).toEqual([
      ["Share of the AI Gateway's tokens today", "25"],
    ]);
    // Never mistaken for a limit of its AI Provider's.
    expect(
      view.getByRole("list", { name: "Ollama's limits and credit" })
        .textContent,
    ).toContain("not a limit from its AI Provider");
    // Its credit can be read again now, as a Claude subscription's usage.
    expect(
      view.getByRole("button", { name: "Refresh OpenRouter's usage" }),
    ).toBeDefined();
    expect(
      view.queryByRole("button", { name: "Refresh Work's usage" }),
    ).toBeNull();
  });

  it("shows a ChatGPT subscription's usage windows once Codex has reported them", async () => {
    stubServer([
      {
        ...work,
        ...freshToken,
        id: "account-codex",
        name: "Codex plan",
        aiProvider: "ChatGPT",
        accountType: "oauth",
        usage: {
          fiveHour: { utilization: 23, resetsAt: "2099-10-09T15:27:00.000Z" },
          weekly: { utilization: 41, resetsAt: "2099-10-12T23:54:00.000Z" },
        },
      },
    ]);
    const view = await card();
    const row = await view.findByRole("listitem", { name: "Codex plan" });
    expect(
      within(row)
        .getByRole("meter", { name: "5-hour window used" })
        .getAttribute("aria-valuenow"),
    ).toBe("23");
    expect(
      within(row)
        .getByRole("meter", { name: "Weekly window used" })
        .getAttribute("aria-valuenow"),
    ).toBe("41");
    // Its usage endpoint (what Codex's `/status` reads) is read on demand.
    expect(
      within(row).getByRole("button", { name: "Refresh Codex plan's usage" }),
    ).toBeTruthy();
  });

  it("shows a ChatGPT subscription's usage windows before anything has been reported, and refreshes them", async () => {
    const { sent } = stubServer([
      {
        ...work,
        ...freshToken,
        id: "account-codex",
        name: "Codex plan",
        aiProvider: "ChatGPT",
        accountType: "oauth",
        usage: { fiveHour: null, weekly: null },
      },
    ]);
    const user = userEvent.setup();
    const view = await card();
    const row = await view.findByRole("listitem", { name: "Codex plan" });
    // Both windows, as a Claude subscription's, waiting to be read.
    expect(
      within(row).getByRole("list", { name: "Codex plan's usage" }).textContent,
    ).toMatch(/5-hour:\s*not reported.*Weekly:\s*not reported/);
    await user.click(
      within(row).getByRole("button", { name: "Refresh Codex plan's usage" }),
    );
    expect(sent.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/ai-accounts/account-codex/refresh-usage",
      csrf: "csrf-token-1",
    });
  });

  it("groups the accounts by AI Provider, in priority order, each boxed by how it stands", async () => {
    stubServer([
      { ...work, id: "a-work", name: "Work", priority: 4 },
      {
        ...work,
        ...freshToken,
        id: "a-codex",
        name: "Codex plan",
        aiProvider: "ChatGPT",
        accountType: "oauth",
        priority: 1,
        paused: true,
      },
      {
        ...work,
        id: "a-console",
        name: "Console",
        priority: 0,
      },
      {
        ...max,
        id: "a-max",
        name: "Claude Max",
        priority: 2,
      },
      {
        ...work,
        id: "a-deepseek",
        name: "Cheap",
        aiProvider: "DeepSeek",
        priority: 3,
        limitReason: "circuit_open",
        limitedUntil: "2099-10-09T15:00:00.000Z",
      },
    ]);
    const view = await card();
    await view.findByRole("listitem", { name: "Cheap" });
    const list = view.getByRole("list", { name: "AI Accounts" });

    // A heading for each AI Provider, the one with the first account at the
    // top; within each, priority 0 first.
    expect(
      within(list)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Claude", "ChatGPT", "DeepSeek"]);
    // Its accounts alone, not their usage windows' items.
    const names = (aiProvider: string) =>
      [
        ...view.getByRole("list", { name: `${aiProvider} accounts` }).children,
      ].map((item) => item.getAttribute("aria-label"));
    expect(names("Claude")).toEqual(["Console", "Claude Max", "Work"]);
    expect(names("ChatGPT")).toEqual(["Codex plan"]);
    expect(names("DeepSeek")).toEqual(["Cheap"]);

    // Enabled green, paused orange, failing red.
    const row = (name: string) => view.getByRole("listitem", { name });
    expect(row("Console").dataset["status"]).toBe("enabled");
    expect(row("Console").className).toContain(
      "border-l-tone-success-foreground",
    );
    expect(row("Codex plan").dataset["status"]).toBe("paused");
    expect(row("Codex plan").className).toContain(
      "border-l-tone-warning-foreground",
    );
    // Signed out, or failing.
    expect(row("Claude Max").dataset["status"]).toBe("error");
    expect(row("Cheap").dataset["status"]).toBe("error");
    expect(row("Cheap").className).toContain("border-l-tone-danger-foreground");

    // Each account's actions sit directly below its title, whatever its
    // AI Provider: the details take the full width.
    for (const name of ["Console", "Codex plan", "Cheap"]) {
      const [details, actions] = [...row(name).children];
      expect(details?.className).toContain("w-full");
      expect(
        within(actions as HTMLElement).getByRole("button", {
          name: `Edit ${name}`,
        }),
      ).toBeTruthy();
    }
  });

  it("charts every account's tokens and requests over the last week, and its usage windows where they are reported", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T12:30:00.000Z"));
    try {
      const { series } = stubServer([
        { ...max, ...freshToken },
        { ...work, id: "account-work" },
      ]);
      const user = userEvent.setup();
      const view = await card();

      // An API key: its tokens and requests, from the Gateway's history.
      const key = await view.findByRole("listitem", { name: "Work" });
      await user.click(
        within(key).getByRole("button", { name: "Work's usage history" }),
      );
      const tokens = await within(key).findByRole("group", {
        name: /^Work's tokens\./,
      });
      // A week of hours, labelled by the day.
      expect(within(tokens).getByText("3 Oct")).toBeTruthy();
      expect(within(tokens).getByText("9 Oct")).toBeTruthy();
      expect(within(tokens).queryByText("13:00")).toBeNull();
      expect(
        within(key).getByRole("group", { name: /^Work's requests\./ }),
      ).toBeTruthy();
      expect(key.textContent).toContain("1.2K input and output in all");
      expect(series).toContainEqual({
        from: "2026-10-02T13:00:00.000Z",
        to: "2026-10-09T13:00:00.000Z",
        bucket: "hour",
        aiAccountId: "account-work",
      });
      // Each chart has its table.
      expect(
        within(key).getAllByText("Show as a table").length,
      ).toBeGreaterThanOrEqual(2);
      // It has no usage windows to chart.
      expect(
        within(key).queryByRole("group", { name: /^Work's usage windows\./ }),
      ).toBeNull();
      expect(key.textContent).toContain(
        "No usage window reported in the last week.",
      );

      // A subscription: its usage windows charted too.
      const row = view.getByRole("listitem", { name: "Claude Max" });
      await user.click(
        within(row).getByRole("button", { name: "Claude Max's usage history" }),
      );
      expect(
        await within(row).findByRole("group", {
          name: /^Claude Max's usage windows\./,
        }),
      ).toBeTruthy();
      expect(
        within(row).getByRole("group", { name: /^Claude Max's tokens\./ }),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a threshold it cannot take", async () => {
    const { sent } = stubServer([work]);
    const user = userEvent.setup();
    const view = await card();
    await user.click(await view.findByRole("button", { name: "Edit Work" }));
    const form = view.getByRole("form", { name: "Edit Work" });
    await user.type(
      within(form).getByLabelText("Pause at (% of the 5-hour window)"),
      "120",
    );
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "The five-hour pause threshold is at most 100%.",
    );
    expect(sent).toEqual([]);
  });

  it("forces a Model, and turns a Claude subscription's extra usage on", async () => {
    const { sent } = stubServer([
      work,
      { ...max, reauthenticationNeeded: false },
    ]);
    const user = userEvent.setup();
    const view = await card();
    const row = await view.findByRole("listitem", { name: "Claude Max" });
    expect(row.textContent).toContain("Extra usage off");

    await user.click(view.getByRole("button", { name: "Edit Claude Max" }));
    const form = view.getByRole("form", { name: "Edit Claude Max" });
    await user.type(
      within(form).getByLabelText("Forced Model"),
      "claude-sonnet-5-5",
    );
    const extraUsage = within(form).getByRole<HTMLInputElement>("checkbox", {
      name: /Extra usage: go on past the plan's limits/,
    });
    expect(extraUsage.checked).toBe(false);
    await user.click(extraUsage);
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sent.at(-1)).toEqual({
        method: "PATCH",
        url: "/api/ai-accounts/account-max",
        body: { forcedModel: "claude-sonnet-5-5", extraUsage: true },
        csrf: "csrf-token-1",
      });
    });
    const changed = await view.findByRole("listitem", { name: "Claude Max" });
    await waitFor(() => {
      expect(changed.textContent).toContain("Always sent claude-sonnet-5-5");
    });
    expect(changed.textContent).toContain("Extra usage on");

    // Emptied, the forced Model goes; an API key has no extra usage to offer.
    await user.click(view.getByRole("button", { name: "Edit Claude Max" }));
    const again = view.getByRole("form", { name: "Edit Claude Max" });
    await user.clear(within(again).getByLabelText("Forced Model"));
    await user.click(within(again).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sent.at(-1)).toMatchObject({ body: { forcedModel: null } });
    });
    await user.click(view.getByRole("button", { name: "Edit Work" }));
    const workForm = view.getByRole("form", { name: "Edit Work" });
    expect(within(workForm).queryByRole("checkbox")).toBeNull();
    expect(
      view.getByRole("listitem", { name: "Work" }).textContent,
    ).not.toContain("Extra usage");
  });

  it("shows why a forced Model was refused", async () => {
    stubServer([work]);
    const fetchStub = vi.mocked(fetch);
    const answer = fetchStub.getMockImplementation();
    fetchStub.mockImplementation((url, init) =>
      init?.method === "PATCH"
        ? Promise.resolve(
            Response.json(
              {
                error: "forced_model_mismatch",
                message: "grok-4 is Grok's, but Work is a Claude account.",
              },
              { status: 400 },
            ),
          )
        : (answer?.(url, init) ?? Promise.reject(new Error("No stub."))),
    );
    const user = userEvent.setup();
    const view = await card();
    await user.click(await view.findByRole("button", { name: "Edit Work" }));
    const form = view.getByRole("form", { name: "Edit Work" });
    await user.type(within(form).getByLabelText("Forced Model"), "grok-4");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "grok-4 is Grok's, but Work is a Claude account.",
    );
  });

  it("adds an xAI API key", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.selectOptions(
      await view.findByLabelText("Account type"),
      "xAI API key",
    );
    await user.type(view.getByLabelText("Name"), "xAI");
    await user.type(
      view.getByLabelText("API key"),
      "xai-webtestkey-0123456789",
    );
    expect(
      view.getByLabelText<HTMLInputElement>("Custom endpoint URL").placeholder,
    ).toBe("https://api.x.ai");
    await user.click(view.getByRole("button", { name: "Add AI Account" }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toEqual({
      name: "xAI",
      aiProvider: "Grok",
      accountType: "api_key",
      credential: "xai-webtestkey-0123456789",
      endpointUrl: null,
    });
  });

  it("adds a Gemini API key", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.selectOptions(
      await view.findByLabelText("Account type"),
      "Gemini API key (Google AI Studio)",
    );
    await user.type(view.getByLabelText("Name"), "Gemini");
    await user.type(
      view.getByLabelText("API key"),
      "AIzaSyWebTestKey0123456789",
    );
    expect(
      view.getByLabelText<HTMLInputElement>("Custom endpoint URL").placeholder,
    ).toBe("https://generativelanguage.googleapis.com");
    await user.click(view.getByRole("button", { name: "Add AI Account" }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toEqual({
      name: "Gemini",
      aiProvider: "Gemini",
      accountType: "api_key",
      credential: "AIzaSyWebTestKey0123456789",
      endpointUrl: null,
    });
  });

  it.each([
    ["OpenRouter API key", "OpenRouter", "https://openrouter.ai"],
    ["DeepSeek API key", "DeepSeek", "https://api.deepseek.com"],
    ["Z.ai API key", "Z.ai", "https://api.z.ai"],
    ["MiniMax API key", "Minimax", "https://api.minimax.io"],
    ["Kimi API key (Moonshot AI)", "Kimi", "https://api.moonshot.ai"],
  ])("adds the kind “%s”", async (label, aiProvider, endpoint) => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.selectOptions(await view.findByLabelText("Account type"), label);
    await user.type(view.getByLabelText("Name"), aiProvider);
    await user.type(view.getByLabelText("API key"), "sk-webTestKey0123456789");
    expect(view.getByLabelText<HTMLInputElement>("API key").type).toBe(
      "password",
    );
    expect(
      view.getByLabelText<HTMLInputElement>("Custom endpoint URL").placeholder,
    ).toBe(endpoint);
    await user.click(view.getByRole("button", { name: "Add AI Account" }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toEqual({
      name: aiProvider,
      aiProvider,
      accountType: "api_key",
      credential: "sk-webTestKey0123456789",
      endpointUrl: null,
    });
    // The key leaves the page once it is saved.
    await waitFor(() => {
      expect(view.getByLabelText<HTMLInputElement>("API key").value).toBe("");
    });
  });

  it("adds an Ollama Cloud API key", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.selectOptions(
      await view.findByLabelText("Account type"),
      "Ollama Cloud API key",
    );
    await user.type(view.getByLabelText("Name"), "Ollama Cloud");
    await user.type(view.getByLabelText("API key"), "ollamaWebTestKey0123");
    expect(
      view.getByLabelText<HTMLInputElement>("Custom endpoint URL").placeholder,
    ).toBe("https://ollama.com");
    await user.click(view.getByRole("button", { name: "Add AI Account" }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toEqual({
      name: "Ollama Cloud",
      aiProvider: "Ollama",
      accountType: "api_key",
      credential: "ollamaWebTestKey0123",
      endpointUrl: null,
    });
  });

  it("adds the Owner's own Ollama, sent no key", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.selectOptions(
      await view.findByLabelText("Account type"),
      "Ollama (your own server)",
    );
    await user.type(view.getByLabelText("Name"), "Ollama");
    const server = view.getByLabelText<HTMLInputElement>("Server URL");
    expect(server.placeholder).toBe("http://localhost:11434");
    expect(view.getByText(/host\.docker\.internal:11434/)).toBeDefined();
    await user.click(view.getByRole("button", { name: "Add AI Account" }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toEqual({
      name: "Ollama",
      aiProvider: "Ollama",
      accountType: "endpoint",
      endpointUrl: null,
      credential: null,
    });
    expect((await view.findByRole("status")).textContent).toBe(
      "Added Ollama. It is sent no key.",
    );
  });

  it.each([
    [
      "Anthropic-compatible endpoint",
      "Anthropic-compatible",
      "https://llm.example.com/anthropic",
      "https://litellm.corp/anthropic",
    ],
    [
      "OpenAI-compatible endpoint",
      "OpenAI-compatible",
      "https://llm.example.com/v1",
      "http://gpu-box.lan:8000/v1",
    ],
  ])(
    "adds an %s at its URL, with a key if it asks for one",
    async (label, aiProvider, placeholder, endpointUrl) => {
      const { sent } = stubServer();
      const user = userEvent.setup();
      const view = await card();
      await user.selectOptions(
        await view.findByLabelText("Account type"),
        label,
      );
      await user.type(view.getByLabelText("Name"), aiProvider);
      const endpoint = view.getByLabelText<HTMLInputElement>("Endpoint URL");
      expect(endpoint.placeholder).toBe(placeholder);
      // It has no address of its own.
      await user.click(view.getByRole("button", { name: "Add AI Account" }));
      expect((await view.findByRole("alert")).textContent).toBe(
        "Enter the endpoint's URL.",
      );
      expect(sent).toEqual([]);
      await user.type(endpoint, endpointUrl);
      await user.type(view.getByLabelText("API key"), "sk-endpoint0123456789");
      await user.click(view.getByRole("button", { name: "Add AI Account" }));
      await waitFor(() => {
        expect(sent).toHaveLength(1);
      });
      expect(sent[0]?.body).toEqual({
        name: aiProvider,
        aiProvider,
        accountType: "endpoint",
        endpointUrl,
        credential: "sk-endpoint0123456789",
      });
      // The key leaves the page once it is saved.
      await waitFor(() => {
        expect(view.getByLabelText<HTMLInputElement>("API key").value).toBe("");
      });
    },
  );

  it("adds a Qwen sign-in through Qwen Code's device login", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.selectOptions(
      await view.findByLabelText("Account type"),
      "Qwen sign-in (Qwen Code's free tier)",
    );
    expect(view.getByRole("note").textContent).toContain(
      "only for requests from opencode",
    );
    await user.type(view.getByLabelText("Name"), "Qwen");
    await user.click(
      view.getByLabelText(
        "I have read this, and will use the subscription only through opencode.",
      ),
    );
    await user.click(view.getByRole("button", { name: "Sign in to Qwen" }));
    const steps = await view.findByRole("form", {
      name: "Sign in to the subscription",
    });
    expect(steps.textContent).toContain("QWEN-1234");
    expect(within(steps).queryByLabelText("Sign-in code")).toBeNull();
    await user.click(
      within(steps).getByRole("button", { name: "Finish signing in" }),
    );
    expect((await view.findByRole("status")).textContent).toContain(
      "Added Qwen. It serves only opencode;",
    );
    expect(sent.map(({ url, body }) => [url, body])).toEqual([
      [
        "/api/ai-accounts/oauth",
        { name: "Qwen", aiProvider: "Qwen", acceptedTerms: true },
      ],
      ["/api/ai-accounts/oauth/login-1", {}],
    ]);
  });

  it("adds an AWS Bedrock account with an IAM access key", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.selectOptions(
      await view.findByLabelText("Account type"),
      "AWS Bedrock (IAM credentials or profile)",
    );
    expect(view.queryByLabelText("API key")).toBeNull();
    await user.type(view.getByLabelText("Name"), "Bedrock");
    await user.type(view.getByLabelText("AWS region"), "eu-west-1");
    await user.type(
      view.getByLabelText("Access key ID"),
      "AKIAWEBTEST000000001",
    );
    await user.type(
      view.getByLabelText("Secret access key"),
      "webTestSecretAccessKey/0123456789",
    );
    expect(
      view.getByLabelText<HTMLInputElement>("Secret access key").type,
    ).toBe("password");
    expect(
      view.getByLabelText<HTMLInputElement>("Custom endpoint URL").placeholder,
    ).toBe("https://bedrock-mantle.{region}.api.aws");
    await user.click(view.getByRole("button", { name: "Add AI Account" }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toEqual({
      name: "Bedrock",
      aiProvider: "Claude",
      accountType: "bedrock",
      region: "eu-west-1",
      awsCredentials: {
        accessKeyId: "AKIAWEBTEST000000001",
        secretAccessKey: "webTestSecretAccessKey/0123456789",
        sessionToken: null,
      },
      endpointUrl: null,
    });
    expect((await view.findByRole("status")).textContent).toBe(
      "Added Bedrock. Its credentials are stored encrypted and will not be shown again.",
    );
    // The secret leaves the page with the form's values.
    expect(view.queryByLabelText("Secret access key")).toBeNull();
    const row = await view.findByRole("listitem", { name: "Bedrock" });
    expect(row.textContent).toContain(
      "AWS Bedrock (IAM credentials or profile)",
    );
    expect(row.textContent).toContain("Region eu-west-1");
  });

  it("adds an AWS Bedrock account with a profile, and says what is wrong first", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.selectOptions(
      await view.findByLabelText("Account type"),
      "AWS Bedrock (IAM credentials or profile)",
    );
    await user.type(view.getByLabelText("Name"), "Bedrock");
    await user.click(
      view.getByLabelText("A profile in the server's AWS files (~/.aws)"),
    );
    expect(view.queryByLabelText("Secret access key")).toBeNull();
    await user.type(view.getByLabelText("AWS profile"), "ai-office");
    await user.click(view.getByRole("button", { name: "Add AI Account" }));
    expect((await view.findByRole("alert")).textContent).toContain(
      "Enter the AWS region, such as us-east-1.",
    );
    expect(sent).toHaveLength(0);
    await user.type(view.getByLabelText("AWS region"), "us-east-1");
    await user.click(view.getByRole("button", { name: "Add AI Account" }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toEqual({
      name: "Bedrock",
      aiProvider: "Claude",
      accountType: "bedrock",
      region: "us-east-1",
      awsCredentials: { profile: "ai-office" },
      endpointUrl: null,
    });
    expect((await view.findByRole("status")).textContent).toBe(
      "Added Bedrock. It signs with the profile's key, read from the server's AWS files each time.",
    );
  });

  it("adds a Google Vertex AI account with a service account's key", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.selectOptions(
      await view.findByLabelText("Account type"),
      "Google Vertex AI (service account)",
    );
    await user.type(view.getByLabelText("Name"), "Vertex");
    await user.type(view.getByLabelText("Vertex AI region"), "global");
    const serviceAccount = JSON.stringify({
      type: "service_account",
      project_id: "ai-office-web",
      private_key:
        "-----BEGIN PRIVATE KEY-----\nMIIEwebTestKey\n-----END PRIVATE KEY-----\n",
      client_email: "ai-office@ai-office-web.iam.gserviceaccount.com",
    });
    // Pasted, as it is copied from the key file.
    await user.click(view.getByLabelText("Service account key (JSON)"));
    await user.paste(serviceAccount);
    await user.click(view.getByRole("button", { name: "Add AI Account" }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    // The key file's text, as the API reads it.
    expect(sent[0]?.body).toEqual({
      name: "Vertex",
      aiProvider: "Claude",
      accountType: "vertex",
      region: "global",
      projectId: null,
      serviceAccount,
      endpointUrl: null,
    });
    expect(view.queryByLabelText("Service account key (JSON)")).toBeNull();
    const row = await view.findByRole("listitem", { name: "Vertex" });
    expect(row.textContent).toContain("Google Vertex AI (service account)");
    expect(row.textContent).toContain("Region global");
    expect(row.textContent).toContain("Project from-the-key");
  });

  it("refuses what is not a service account's key before sending it", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.selectOptions(
      await view.findByLabelText("Account type"),
      "Google Vertex AI (service account)",
    );
    await user.type(view.getByLabelText("Name"), "Vertex");
    await user.type(view.getByLabelText("Vertex AI region"), "us-east5");
    await user.click(view.getByLabelText("Service account key (JSON)"));
    await user.paste('{"type":"authorized_user"}');
    await user.click(view.getByRole("button", { name: "Add AI Account" }));
    expect((await view.findByRole("alert")).textContent).toContain(
      "That is not a service account key: its type is not service_account.",
    );
    expect(sent).toHaveLength(0);
  });

  it("adds a Grok subscription through xAI's device sign-in", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.selectOptions(
      await view.findByLabelText("Account type"),
      "Grok subscription (xAI sign-in, or a Grok CLI login)",
    );
    expect(view.getByRole("note").textContent).toContain(
      "only for requests from opencode",
    );
    await user.type(view.getByLabelText("Name"), "SuperGrok");
    await user.click(
      view.getByLabelText(
        "I have read this, and will use the subscription only through opencode.",
      ),
    );
    await user.click(view.getByRole("button", { name: "Sign in to xAI" }));

    const steps = await view.findByRole("form", {
      name: "Sign in to the subscription",
    });
    expect(steps.textContent).toContain("WXYZ-1234");
    expect(
      within(steps)
        .getByRole("link", { name: /Open xAI's sign-in page/ })
        .getAttribute("href"),
    ).toBe("https://accounts.x.ai/device?user_code=WXYZ-1234");
    // Nothing to paste: the code is approved on xAI's page.
    expect(within(steps).queryByLabelText("Sign-in code")).toBeNull();
    await user.click(
      within(steps).getByRole("button", { name: "Finish signing in" }),
    );
    expect((await view.findByRole("status")).textContent).toContain(
      "Added SuperGrok. It serves only opencode;",
    );
    expect(sent.map(({ url, body }) => [url, body])).toEqual([
      [
        "/api/ai-accounts/oauth",
        { name: "SuperGrok", aiProvider: "Grok", acceptedTerms: true },
      ],
      ["/api/ai-accounts/oauth/login-1", {}],
    ]);
  });

  it("imports a Grok CLI login, and clears it from the page", async () => {
    const { sent } = stubServer();
    const user = userEvent.setup();
    const view = await card();
    await user.selectOptions(
      await view.findByLabelText("Account type"),
      "Grok subscription (xAI sign-in, or a Grok CLI login)",
    );
    await user.click(view.getByLabelText("Import an existing Grok CLI login"));
    await user.type(view.getByLabelText("Name"), "Grok CLI");
    const file = '{{"access_token":"xai-access","refresh_token":"xai-refresh"}';
    await user.type(
      view.getByLabelText("Grok CLI login (~/.grok/auth.json)"),
      file,
    );
    await user.click(
      view.getByLabelText(
        "I have read this, and will use the subscription only through opencode.",
      ),
    );
    await user.click(view.getByRole("button", { name: "Import login" }));
    expect((await view.findByRole("status")).textContent).toContain(
      "Imported Grok CLI.",
    );
    expect(sent).toMatchObject([
      {
        url: "/api/ai-accounts/import",
        body: {
          name: "Grok CLI",
          aiProvider: "Grok",
          acceptedTerms: true,
          login: '{"access_token":"xai-access","refresh_token":"xai-refresh"}',
        },
        csrf: "csrf-token-1",
      },
    ]);
    expect(document.body.innerHTML).not.toContain("xai-refresh");
    expect(
      (await view.findByRole("listitem", { name: "Grok CLI" })).textContent,
    ).toContain("Serves only opencode");
  });

  it("signs a subscription in again, brought up by a Notice's link", async () => {
    const { sent } = stubServer([work, max]);
    const user = userEvent.setup();
    const view = await card("/ai-settings?reauthenticate=account-max");
    const row = await view.findByRole("listitem", { name: "Claude Max" });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.textContent).toContain("Sign in again: token expires");
    // A key has nothing to sign in to.
    expect(
      view.queryByRole("button", { name: "Sign in to Work again" }),
    ).toBeNull();

    await user.click(
      view.getByRole("button", { name: "Sign in to Claude Max again" }),
    );
    const steps = await view.findByRole("form", {
      name: "Sign in to Claude Max",
    });
    await user.type(
      within(steps).getByLabelText("Sign-in code"),
      "again#again",
    );
    await user.click(
      within(steps).getByRole("button", { name: "Finish signing in" }),
    );
    expect((await view.findByRole("status")).textContent).toBe(
      "Signed in to Claude Max again.",
    );
    await waitFor(() => {
      expect(
        view.getByRole("listitem", { name: "Claude Max" }).textContent,
      ).toContain("Token valid until");
    });
    expect(sent.map(({ method, url }) => [method, url])).toEqual([
      ["POST", "/api/ai-accounts/account-max/reauthenticate"],
      ["POST", "/api/ai-accounts/oauth/login-account-max"],
    ]);
  });
});
