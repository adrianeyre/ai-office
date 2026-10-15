import {
  defaultCommunicationsAgentAvatar,
  type CommunicationsAgent,
  type Connection,
  type ConnectionDelivery,
  type GoogleSignIn,
} from "@ai-office/shared";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browser } from "./api.ts";
import { App } from "./app.tsx";
import { deliveryOutcome, deliveryRulesText } from "./connections-page.tsx";
import { createAppRouter } from "./router.tsx";
import { location } from "./totp-settings.tsx";

// The Connections page (PRD FR-90, FR-93), against a stubbed server that
// behaves as the API does: a Connection's credentials go in once, when it
// is added, and are never sent back. Google sign-in (FR-91): the OAuth
// client's secret likewise; signing in goes to Google's consent screen,
// and Google's redirect back is handed to the API once.

const webhookUrl = "https://hooks.example.com/T01/B02/s3cr3t-path";

interface Sent {
  method: string;
  url: string;
  body: unknown;
  csrf: string | null;
}

const delivered = (title: string, test: boolean): ConnectionDelivery => ({
  id: `delivery-${title}`,
  message: {
    kind: test ? "test" : "action_notice",
    title,
    floor: null,
    aiOfficeUrl: "https://office.example.com/notices",
    githubUrl: null,
    occurredAt: "2026-10-10T09:00:00.000Z",
  },
  test,
  status: "delivered",
  attempts: 1,
  createdAt: "2026-10-10T09:00:00.000Z",
  nextAttemptAt: null,
  lastAttemptAt: "2026-10-10T09:00:00.000Z",
  deliveredAt: "2026-10-10T09:00:01.000Z",
  error: null,
});

function stubServer() {
  const connections: Connection[] = [];
  const deliveries = new Map<string, ConnectionDelivery[]>();
  let agent: CommunicationsAgent = {
    name: "Grace",
    role: "communications",
    avatar: defaultCommunicationsAgentAvatar,
    aiProvider: "Claude",
    model: "claude-opus-5-5",
    modelOverride: null,
    enabled: true,
    createdAt: "2026-10-10T08:00:00.000Z",
  };
  const sheetsScope = "https://www.googleapis.com/auth/spreadsheets";
  let google: GoogleSignIn = {
    status: "not_configured",
    clientId: null,
    redirectUri: "http://localhost:3046/admin/connections/google",
    services: [],
    scopes: [],
    grantedScopes: [],
    missingServices: [],
    signedInAt: null,
  };
  const sent: Sent[] = [];
  const json = (body: unknown, status = 200) =>
    Promise.resolve(Response.json(body, { status }));
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body: unknown =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (method !== "GET") {
        sent.push({
          method,
          url,
          body,
          csrf: new Headers(init?.headers).get("x-csrf-token"),
        });
      }
      const [, , , id, action] = url.split("/");
      if (url === "/api/session") {
        return json({
          csrfToken: "csrf-token-1",
          expiresAt: "2026-10-15T12:00:00.000Z",
        });
      }
      if (url === "/api/communications-agent") {
        if (method === "PATCH") {
          agent = { ...agent, ...(body as Partial<CommunicationsAgent>) };
        }
        return json(agent);
      }
      if (url === "/api/floors") {
        return json({ floors: [] });
      }
      if (url === "/api/ai-providers") {
        return json({ aiProviders: [] });
      }
      if (url === "/api/google") {
        return json(google);
      }
      if (url === "/api/google/client") {
        google = {
          ...google,
          status: "signed_out",
          clientId: (body as { clientId: string }).clientId,
        };
        return json(google);
      }
      if (url === "/api/google/sign-in" && method === "POST") {
        return json({
          url: "https://accounts.google.com/o/oauth2/v2/auth?state=state-1",
        });
      }
      if (url === "/api/google/sign-in" && method === "DELETE") {
        google = { ...google, status: "signed_out", grantedScopes: [] };
        return json(google);
      }
      if (url === "/api/google/sign-in/complete") {
        if ((body as { state: string }).state !== "state-1") {
          return json(
            {
              error: "google_sign_in_not_found",
              message:
                "That sign-in is unknown, finished or too old: sign in to Google again.",
            },
            404,
          );
        }
        google = {
          ...google,
          status: "signed_in",
          grantedScopes: [sheetsScope],
          signedInAt: "2026-10-10T09:30:00.000Z",
        };
        return json(google);
      }
      if (url === "/api/connections") {
        if (method === "POST") {
          const request = body as {
            type: Connection["type"];
            name: string;
            rules: Connection["rules"];
            detailLevel?: Connection["detailLevel"];
          };
          if (request.type === "google_sheets") {
            google = { ...google, services: ["sheets"], scopes: [sheetsScope] };
          }
          const connection: Connection = {
            id: `connection-${String(connections.length + 1)}`,
            name: request.name,
            type: request.type,
            rules: request.rules,
            detailLevel: request.detailLevel ?? "titles_and_summaries",
            hint: "hooks.example.com",
            details: ["Signed with HMAC-SHA256"],
            paused: false,
            status: "ok",
            consecutiveFailures: 0,
            lastDelivery: null,
            createdAt: "2026-10-10T09:00:00.000Z",
          };
          connections.push(connection);
          return json(connection, 201);
        }
        return json({ connections });
      }
      const index = connections.findIndex((connection) => connection.id === id);
      const connection = connections[index];
      if (connection === undefined) {
        return json({ error: "connection_not_found" }, 404);
      }
      if (action === "test") {
        const delivery = delivered("Test message from AI Office", true);
        deliveries.set(connection.id, [delivery]);
        connections[index] = { ...connection, lastDelivery: delivery };
        return json({
          delivered: true,
          error: null,
          connection: connections[index],
        });
      }
      if (action === "deliveries") {
        return json({ deliveries: deliveries.get(connection.id) ?? [] });
      }
      if (method === "PATCH") {
        connections[index] = {
          ...connection,
          ...(body as Partial<Connection>),
        };
        return json(connections[index]);
      }
      if (method === "DELETE") {
        connections.splice(index, 1);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return json({}, 404);
    }),
  );
  return { sent, connections };
}

/** Puts `text` in a field at once, as pasting it would: quicker than typing. */
async function fill(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  text: string,
) {
  await user.click(field);
  await user.paste(text);
}

function renderPage(path = "/general-settings/connections") {
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: [path] }))}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(location, "hostname").mockReturnValue("localhost");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Connections page", () => {
  it("adds a webhook Connection, whose credentials are sent once and never shown", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await fill(user, within(form).getByLabelText("Name"), "Team chat");
    await fill(
      user,
      within(form).getByLabelText("Webhook address"),
      webhookUrl,
    );
    await fill(
      user,
      within(form).getByLabelText("Signing secret (optional)"),
      "whsec-0123456789abcdef",
    );
    await user.click(within(form).getByLabelText("Info Notices"));
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    await within(form).findByText(
      "Added Team chat. Send it a test to check it works.",
    );
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/connections",
        body: {
          type: "webhook",
          name: "Team chat",
          rules: {
            actionNotices: true,
            infoNotices: true,
            workComplete: true,
            floorIds: [],
          },
          credentials: { url: webhookUrl, secret: "whsec-0123456789abcdef" },
        },
        csrf: "csrf-token-1",
      },
    ]);
    // The form forgets them, and the list never had them.
    expect(
      within(form).getByLabelText<HTMLInputElement>("Webhook address").value,
    ).toBe("");
    expect(
      within(form).getByLabelText<HTMLInputElement>("Signing secret (optional)")
        .value,
    ).toBe("");
    const item = await screen.findByRole("listitem", { name: "Team chat" });
    expect(item.textContent).toContain("hooks.example.com");
    expect(item.textContent).toContain("Signed with HMAC-SHA256");
    expect(document.body.textContent).not.toContain("s3cr3t-path");
  });

  it("adds a Slack Connection with a bot token and a channel", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await user.selectOptions(within(form).getByLabelText("Type"), "slack");
    await fill(user, within(form).getByLabelText("Name"), "Ops Slack");
    expect(
      within(form).getByLabelText("Incoming webhook address"),
    ).toBeTruthy();
    await user.selectOptions(
      within(form).getByLabelText("Sends through"),
      "bot",
    );
    await fill(
      user,
      within(form).getByLabelText("Bot token"),
      "xoxb-1111111111-web-test-token",
    );
    await fill(user, within(form).getByLabelText("Channel or user"), "#ops");
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    await within(form).findByText(
      "Added Ops Slack. Send it a test to check it works.",
    );
    expect(sent.map(({ body }) => body)).toEqual([
      {
        type: "slack",
        name: "Ops Slack",
        rules: {
          actionNotices: true,
          infoNotices: false,
          workComplete: true,
          floorIds: [],
        },
        credentials: {
          mode: "bot",
          botToken: "xoxb-1111111111-web-test-token",
          channel: "#ops",
        },
      },
    ]);
    expect(
      within(form).getByLabelText<HTMLInputElement>("Bot token").value,
    ).toBe("");
  });

  it("adds an email Connection with an SMTP server and several addresses", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await user.selectOptions(within(form).getByLabelText("Type"), "email");
    await fill(user, within(form).getByLabelText("Name"), "Email");
    await fill(
      user,
      within(form).getByLabelText("SMTP server"),
      "smtp.example.com",
    );
    expect(within(form).getByLabelText<HTMLInputElement>("Port").value).toBe(
      "587",
    );
    expect(within(form).getByLabelText<HTMLSelectElement>("TLS").value).toBe(
      "starttls",
    );
    await fill(
      user,
      within(form).getByLabelText("Username (optional)"),
      "ai-office@example.com",
    );
    await fill(
      user,
      within(form).getByLabelText("Password (optional)"),
      "app-password-9f8e7d",
    );
    await fill(
      user,
      within(form).getByLabelText("From"),
      "ai-office@example.com",
    );
    await fill(
      user,
      within(form).getByLabelText("To"),
      "owner@example.com, ops@example.com",
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    await within(form).findByText(
      "Added Email. Send it a test to check it works.",
    );
    expect(sent.map(({ body }) => body)).toEqual([
      {
        type: "email",
        name: "Email",
        rules: {
          actionNotices: true,
          infoNotices: false,
          workComplete: true,
          floorIds: [],
        },
        credentials: {
          host: "smtp.example.com",
          port: 587,
          tls: "starttls",
          username: "ai-office@example.com",
          password: "app-password-9f8e7d",
          from: "ai-office@example.com",
          to: ["owner@example.com", "ops@example.com"],
        },
      },
    ]);
    expect(
      within(form).getByLabelText<HTMLInputElement>("Password (optional)")
        .value,
    ).toBe("");
  });

  it("refuses an email Connection with a username but no password", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await user.selectOptions(within(form).getByLabelText("Type"), "email");
    await fill(user, within(form).getByLabelText("Name"), "Email");
    await fill(
      user,
      within(form).getByLabelText("SMTP server"),
      "smtp.example.com",
    );
    await fill(user, within(form).getByLabelText("Username (optional)"), "me");
    await fill(user, within(form).getByLabelText("From"), "me@example.com");
    await fill(user, within(form).getByLabelText("To"), "you@example.com");
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    expect((await within(form).findByRole("alert")).textContent).toContain(
      "Give both a username and a password, or neither.",
    );
    expect(sent).toEqual([]);
  });

  it("adds an ntfy Connection with a server, a topic and an access token", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await user.selectOptions(within(form).getByLabelText("Type"), "ntfy");
    await fill(user, within(form).getByLabelText("Name"), "Phone");
    expect(within(form).getByLabelText<HTMLInputElement>("Server").value).toBe(
      "https://ntfy.sh",
    );
    await fill(user, within(form).getByLabelText("Topic"), "ai-office-4471");
    await fill(
      user,
      within(form).getByLabelText("Access token (optional)"),
      "tk_webtesttoken0123456789abcdefg",
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    await within(form).findByText(
      "Added Phone. Send it a test to check it works.",
    );
    expect(sent.map(({ body }) => body)).toEqual([
      {
        type: "ntfy",
        name: "Phone",
        rules: {
          actionNotices: true,
          infoNotices: false,
          workComplete: true,
          floorIds: [],
        },
        credentials: {
          server: "https://ntfy.sh",
          topic: "ai-office-4471",
          accessToken: "tk_webtesttoken0123456789abcdefg",
        },
      },
    ]);
    expect(
      within(form).getByLabelText<HTMLInputElement>("Access token (optional)")
        .value,
    ).toBe("");
    expect(within(form).getByLabelText<HTMLInputElement>("Topic").value).toBe(
      "",
    );
  });

  it("adds a Pushover Connection, and refuses a key of the wrong shape", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await user.selectOptions(within(form).getByLabelText("Type"), "pushover");
    await fill(user, within(form).getByLabelText("Name"), "Pushover");
    await fill(
      user,
      within(form).getByLabelText("Application token"),
      "azGDORePK8gMaC0QOYAMyEEuzJnyUi",
    );
    await fill(user, within(form).getByLabelText("User key"), "too-short");
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    expect((await within(form).findByRole("alert")).textContent).toContain(
      "The user key is 30 letters and digits.",
    );
    expect(sent).toEqual([]);
    await user.clear(within(form).getByLabelText("User key"));
    await fill(
      user,
      within(form).getByLabelText("User key"),
      "uQiRzpo4DXghDmr9QzzfQu27cmVRsG",
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    await within(form).findByText(
      "Added Pushover. Send it a test to check it works.",
    );
    expect(sent.map(({ body }) => body)).toMatchObject([
      {
        type: "pushover",
        name: "Pushover",
        credentials: {
          applicationToken: "azGDORePK8gMaC0QOYAMyEEuzJnyUi",
          userKey: "uQiRzpo4DXghDmr9QzzfQu27cmVRsG",
        },
      },
    ]);
  });

  it("adds a Confluence publishing destination with a running changelog: Floors and a changelog its only rules", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await user.selectOptions(within(form).getByLabelText("Type"), "confluence");
    await fill(user, within(form).getByLabelText("Name"), "Wiki");
    await fill(
      user,
      within(form).getByLabelText("Site address"),
      "https://example.atlassian.net",
    );
    await fill(
      user,
      within(form).getByLabelText("Atlassian account email"),
      "owner@example.com",
    );
    await fill(
      user,
      within(form).getByLabelText("API token"),
      "ATATT3xFfGF0-confluence-api-token-0123456789",
    );
    await fill(user, within(form).getByLabelText("Space key"), "ENG");
    await fill(user, within(form).getByLabelText("Parent page id"), "123456");
    // Its rules: Wrap-up reports, a changelog and Floors; no triggers,
    // quiet hours or Digest.
    expect(within(form).queryByLabelText("Action Notices")).toBeNull();
    expect(within(form).queryByText("Quiet hours")).toBeNull();
    expect(
      within(form).getByText(
        /A page for each finished Batch, with its Wrap-up report/,
      ),
    ).toBeTruthy();
    await user.click(
      within(form).getByLabelText(
        "A running changelog: an entry for each merged pull request",
      ),
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    await within(form).findByText(
      "Added Wiki. Send it a test to check it works.",
    );
    expect(sent.map(({ body }) => body)).toEqual([
      {
        type: "confluence",
        name: "Wiki",
        rules: {
          actionNotices: false,
          infoNotices: false,
          workComplete: false,
          floorIds: [],
          changelog: true,
        },
        credentials: {
          siteUrl: "https://example.atlassian.net",
          email: "owner@example.com",
          apiToken: "ATATT3xFfGF0-confluence-api-token-0123456789",
          spaceKey: "ENG",
          parentPageId: "123456",
        },
      },
    ]);
    expect(
      within(form).getByLabelText<HTMLInputElement>("API token").value,
    ).toBe("");
  });

  it("adds a Notion publishing destination in a database, and refuses a token of the wrong shape", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await user.selectOptions(within(form).getByLabelText("Type"), "notion");
    await fill(user, within(form).getByLabelText("Name"), "Notes");
    await fill(user, within(form).getByLabelText("Integration token"), "nope");
    await user.selectOptions(
      within(form).getByLabelText("Publish to"),
      "database",
    );
    await fill(
      user,
      within(form).getByLabelText("Parent page or database id"),
      "AAAABBBB-CCCC-DDDD-EEEE-FFFF00001111",
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    expect((await within(form).findByRole("alert")).textContent).toContain(
      "An integration token starts secret_ or ntn_.",
    );
    expect(sent).toEqual([]);
    await user.clear(within(form).getByLabelText("Integration token"));
    await fill(
      user,
      within(form).getByLabelText("Integration token"),
      "ntn_fakeNotionIntegrationToken0123456789AB",
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    await within(form).findByText(
      "Added Notes. Send it a test to check it works.",
    );
    expect(sent.map(({ body }) => body)).toMatchObject([
      {
        type: "notion",
        name: "Notes",
        rules: { changelog: false, actionNotices: false },
        credentials: {
          token: "ntn_fakeNotionIntegrationToken0123456789AB",
          parentType: "database",
          parentId: "aaaabbbbccccddddeeeeffff00001111",
        },
      },
    ]);
  });

  it("adds a Google Sheets work log by the spreadsheet's address, with a row per Notice: Floors and Notices its only rules", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await user.selectOptions(
      within(form).getByLabelText("Type"),
      "google_sheets",
    );
    // A work log's rules: no triggers, quiet hours, Digest or changelog.
    expect(within(form).queryByLabelText("Action Notices")).toBeNull();
    expect(within(form).queryByText(/running changelog/)).toBeNull();
    await fill(user, within(form).getByLabelText("Name"), "Work log");
    await fill(
      user,
      within(form).getByLabelText("Spreadsheet address or id"),
      "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc/edit#gid=0",
    );
    expect(within(form).getByLabelText<HTMLInputElement>("Tab").value).toBe(
      "Work log",
    );
    await user.click(within(form).getByLabelText("A row for each Notice too"));
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    await within(form).findByText(
      "Added Work log. Send it a test to check it works.",
    );
    expect(sent.map(({ body }) => body)).toEqual([
      {
        type: "google_sheets",
        name: "Work log",
        rules: {
          actionNotices: false,
          infoNotices: false,
          workComplete: false,
          floorIds: [],
          notices: true,
        },
        credentials: {
          spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc",
          tab: "Work log",
        },
      },
    ]);
    // Google sign-in now asks for Sheets' scope.
    expect(
      await screen.findByText("https://www.googleapis.com/auth/spreadsheets"),
    ).toBeTruthy();
  });

  it("adds Google Docs with a running changelog by the folder's address; Slides and Drive keep none", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    const folder = "1DocsFolder_AbCdEfGhIjKlMnOpQrStUv";
    const changelog =
      "A running changelog: an entry for each merged pull request";
    await user.selectOptions(
      within(form).getByLabelText("Type"),
      "google_docs",
    );
    // A publishing destination's rules: no triggers, quiet hours or Digest.
    expect(within(form).queryByLabelText("Action Notices")).toBeNull();
    expect(within(form).queryByText("Quiet hours")).toBeNull();
    expect(
      within(form).getByText(
        /A document for each finished Batch, with its Wrap-up report/,
      ),
    ).toBeTruthy();
    await fill(user, within(form).getByLabelText("Name"), "Docs");
    await fill(
      user,
      within(form).getByLabelText("Folder address or id"),
      "https://drive.google.com/file/d/not-a-folder",
    );
    await user.click(within(form).getByLabelText(changelog));
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    expect((await within(form).findByRole("alert")).textContent).toContain(
      "Give the folder's address, https://drive.google.com/drive/folders/…, or the id in it.",
    );
    expect(sent).toEqual([]);
    await user.clear(within(form).getByLabelText("Folder address or id"));
    await fill(
      user,
      within(form).getByLabelText("Folder address or id"),
      `https://drive.google.com/drive/folders/${folder}?usp=sharing`,
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    await within(form).findByText(
      "Added Docs. Send it a test to check it works.",
    );

    // Slides: a deck, and no changelog to offer.
    await user.selectOptions(
      within(form).getByLabelText("Type"),
      "google_slides",
    );
    expect(within(form).queryByLabelText(changelog)).toBeNull();
    expect(
      within(form).getByText(/A short deck for each finished Batch/),
    ).toBeTruthy();
    // Drive: Markdown and PDF files, and no changelog either.
    await user.selectOptions(
      within(form).getByLabelText("Type"),
      "google_drive",
    );
    expect(within(form).queryByLabelText(changelog)).toBeNull();
    expect(
      within(form).getByText(/saved as a Markdown and a PDF file/),
    ).toBeTruthy();
    await fill(user, within(form).getByLabelText("Name"), "Files");
    await fill(
      user,
      within(form).getByLabelText("Folder address or id"),
      folder,
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    await within(form).findByText(
      "Added Files. Send it a test to check it works.",
    );
    expect(sent.map(({ body }) => body)).toEqual([
      {
        type: "google_docs",
        name: "Docs",
        rules: {
          actionNotices: false,
          infoNotices: false,
          workComplete: false,
          floorIds: [],
          changelog: true,
        },
        credentials: { folderId: folder },
      },
      {
        type: "google_drive",
        name: "Files",
        rules: {
          actionNotices: false,
          infoNotices: false,
          workComplete: false,
          floorIds: [],
          changelog: false,
        },
        credentials: { folderId: folder },
      },
    ]);
  });

  it("adds Google Calendar by the calendar's address, with no changelog to offer", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    const calendarId = "c_0123456789abcdef@group.calendar.google.com";
    await user.selectOptions(
      within(form).getByLabelText("Type"),
      "google_calendar",
    );
    // A publishing destination's rules: its Floors only.
    expect(within(form).queryByLabelText("Action Notices")).toBeNull();
    expect(within(form).queryByText("Quiet hours")).toBeNull();
    expect(
      within(form).queryByLabelText(
        "A running changelog: an entry for each merged pull request",
      ),
    ).toBeNull();
    expect(
      within(form).getByText(
        /An event on the calendar for each Batch, from its start to its finish, with a link to its Plan/,
      ),
    ).toBeTruthy();
    await fill(user, within(form).getByLabelText("Name"), "Batches");
    await fill(
      user,
      within(form).getByLabelText("Calendar id or address"),
      "https://calendar.google.com/calendar/u/0/r",
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    expect((await within(form).findByRole("alert")).textContent).toContain(
      "Give the calendar's id, from its settings (Integrate calendar), such as …@group.calendar.google.com, or primary.",
    );
    expect(sent).toEqual([]);
    await user.clear(within(form).getByLabelText("Calendar id or address"));
    await fill(
      user,
      within(form).getByLabelText("Calendar id or address"),
      `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(calendarId)}&ctz=Europe%2FLondon`,
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    await within(form).findByText(
      "Added Batches. Send it a test to check it works.",
    );
    expect(sent.map(({ body }) => body)).toEqual([
      {
        type: "google_calendar",
        name: "Batches",
        rules: {
          actionNotices: false,
          infoNotices: false,
          workComplete: false,
          floorIds: [],
          changelog: false,
        },
        // Its id, read from the address.
        credentials: { calendarId },
      },
    ]);
  });

  it("enters Google sign-in's OAuth client, its secret sent once and cleared, then goes to Google's consent screen", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    const load = vi.spyOn(browser, "load").mockImplementation(() => undefined);
    renderPage();
    const client = await screen.findByRole("form", { name: "OAuth client" });
    expect(
      await screen.findByText(
        "Not set up: enter the OAuth client you registered in Google Cloud.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("http://localhost:3046/admin/connections/google"),
    ).toBeTruthy();
    await fill(user, within(client).getByLabelText("Client ID"), "nope");
    await fill(
      user,
      within(client).getByLabelText("Client secret"),
      "GOCSPX-pageClientSecret0123456789",
    );
    await user.click(
      within(client).getByRole("button", { name: "Save the OAuth client" }),
    );
    expect((await within(client).findByRole("alert")).textContent).toContain(
      "A client ID ends .apps.googleusercontent.com.",
    );
    expect(sent).toEqual([]);
    await user.clear(within(client).getByLabelText("Client ID"));
    await fill(
      user,
      within(client).getByLabelText("Client ID"),
      "1234-page.apps.googleusercontent.com",
    );
    await user.click(
      within(client).getByRole("button", { name: "Save the OAuth client" }),
    );
    await within(client).findByText("The OAuth client was saved.");
    expect(sent).toEqual([
      {
        method: "PUT",
        url: "/api/google/client",
        body: {
          clientId: "1234-page.apps.googleusercontent.com",
          clientSecret: "GOCSPX-pageClientSecret0123456789",
        },
        csrf: "csrf-token-1",
      },
    ]);
    expect(
      within(client).getByLabelText<HTMLInputElement>("Client secret").value,
    ).toBe("");
    expect(document.body.textContent).not.toContain(
      "GOCSPX-pageClientSecret0123456789",
    );
    // Nothing to ask for before a Google Connection.
    const signIn = await screen.findByRole("button", {
      name: "Sign in to Google",
    });
    expect((signIn as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Nothing yet: add a Google Connection first."),
    ).toBeTruthy();

    const form = screen.getByRole("form", { name: "Add a Connection" });
    await user.selectOptions(
      within(form).getByLabelText("Type"),
      "google_sheets",
    );
    await fill(user, within(form).getByLabelText("Name"), "Work log");
    await fill(
      user,
      within(form).getByLabelText("Spreadsheet address or id"),
      "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc",
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    await within(form).findByText(/Added Work log/);
    await screen.findByText("https://www.googleapis.com/auth/spreadsheets");
    await user.click(screen.getByRole("button", { name: "Sign in to Google" }));
    expect(load).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/v2/auth?state=state-1",
    );
  });

  it("hands Google's redirect back to the API once, and says the account is signed in", async () => {
    const { sent } = stubServer();
    renderPage("/admin/connections/google?code=4%2F0code&state=state-1");
    expect(await screen.findByText(/^Signed in \d.*\.$/)).toBeTruthy();
    expect(sent).toEqual([
      {
        method: "POST",
        url: "/api/google/sign-in/complete",
        body: { code: "4/0code", state: "state-1" },
        csrf: "csrf-token-1",
      },
    ]);
    expect(
      screen.getByRole("link", { name: "Back to Connections" }),
    ).toBeTruthy();
  });

  it("says why Google's redirect could not finish the sign-in", async () => {
    stubServer();
    renderPage("/admin/connections/google?error=access_denied&state=other");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That sign-in is unknown, finished or too old: sign in to Google again.",
    );
  });

  it("adds a Connection at links only, with quiet hours and a daily Digest", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await fill(user, within(form).getByLabelText("Name"), "Team chat");
    await fill(
      user,
      within(form).getByLabelText("Webhook address"),
      webhookUrl,
    );
    await user.selectOptions(
      within(form).getByLabelText("Detail"),
      "links_only",
    );
    await user.click(
      within(form).getByLabelText("Hold messages in quiet hours"),
    );
    expect(within(form).getByLabelText<HTMLInputElement>("From").value).toBe(
      "22:00",
    );
    expect(within(form).getByLabelText<HTMLInputElement>("Until").value).toBe(
      "07:00",
    );
    const quietZone = within(form).getAllByLabelText("Time zone")[0];
    if (quietZone === undefined) {
      throw new Error("No time zone for the quiet hours.");
    }
    await user.clear(quietZone);
    await fill(user, quietZone, "Europe/London");
    await user.click(within(form).getByLabelText("Let action Notices through"));
    await user.selectOptions(
      within(form).getByLabelText("Send a Digest"),
      "daily",
    );
    const digestZone = within(form).getAllByLabelText("Time zone")[1];
    if (digestZone === undefined) {
      throw new Error("No time zone for the Digest.");
    }
    await user.clear(digestZone);
    await fill(user, digestZone, "Europe/London");
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    await within(form).findByText(
      "Added Team chat. Send it a test to check it works.",
    );
    expect(sent.map(({ body }) => body)).toEqual([
      {
        type: "webhook",
        name: "Team chat",
        detailLevel: "links_only",
        rules: {
          actionNotices: true,
          infoNotices: false,
          workComplete: true,
          floorIds: [],
          quietHours: {
            start: "22:00",
            end: "07:00",
            timeZone: "Europe/London",
            actionNotices: false,
          },
          digest: {
            frequency: "daily",
            at: "08:00",
            timeZone: "Europe/London",
          },
        },
        credentials: { url: webhookUrl },
      },
    ]);
    const item = await screen.findByRole("listitem", { name: "Team chat" });
    expect(item.textContent).toContain(
      "Links only · Quiet 22:00–07:00 (Europe/London) · Daily Digest at 08:00 (Europe/London)",
    );
  });

  it("refuses a time zone it does not know", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await fill(user, within(form).getByLabelText("Name"), "Team chat");
    await fill(
      user,
      within(form).getByLabelText("Webhook address"),
      webhookUrl,
    );
    await user.selectOptions(
      within(form).getByLabelText("Send a Digest"),
      "daily",
    );
    const zone = within(form).getByLabelText("Time zone");
    await user.clear(zone);
    await fill(user, zone, "Europe/Atlantis");
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    expect((await within(form).findByRole("alert")).textContent).toContain(
      "Choose a time zone such as Europe/London.",
    );
    expect(sent).toEqual([]);
  });

  it("changes a Connection's detail level and turns its Digest off", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await fill(user, within(form).getByLabelText("Name"), "Team chat");
    await fill(
      user,
      within(form).getByLabelText("Webhook address"),
      webhookUrl,
    );
    await user.selectOptions(
      within(form).getByLabelText("Send a Digest"),
      "hourly",
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    const item = await screen.findByRole("listitem", { name: "Team chat" });
    expect(item.textContent).toContain("Titles and summaries · Hourly Digest");
    await user.click(
      within(item).getByRole("button", { name: "Edit Team chat" }),
    );
    const edit = within(item).getByRole("form", { name: "Edit Team chat" });
    await user.selectOptions(
      within(edit).getByLabelText("Detail"),
      "links_only",
    );
    await user.selectOptions(
      within(edit).getByLabelText("Send a Digest"),
      "none",
    );
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    await within(item).findByText("Links only");
    expect(sent.at(-1)).toMatchObject({
      method: "PATCH",
      url: "/api/connections/connection-1",
      body: {
        name: "Team chat",
        detailLevel: "links_only",
        rules: {
          actionNotices: true,
          infoNotices: false,
          workComplete: true,
          floorIds: [],
        },
      },
    });
    expect((sent.at(-1)?.body as { rules: object }).rules).not.toHaveProperty(
      "digest",
    );
  });

  it("refuses a webhook address that is not http or https", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await fill(user, within(form).getByLabelText("Name"), "Team chat");
    await fill(
      user,
      within(form).getByLabelText("Webhook address"),
      "ftp://example.com",
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    expect((await within(form).findByRole("alert")).textContent).toContain(
      "Give the webhook's address, starting https:// (or http://).",
    );
    expect(sent).toEqual([]);
  });

  it("sends a test, renames, pauses, resumes and deletes a Connection, with its log", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", { name: "Add a Connection" });
    await fill(user, within(form).getByLabelText("Name"), "Team chat");
    await fill(
      user,
      within(form).getByLabelText("Webhook address"),
      webhookUrl,
    );
    await user.click(
      within(form).getByRole("button", { name: "Add Connection" }),
    );
    const item = await screen.findByRole("listitem", { name: "Team chat" });

    await user.click(
      within(item).getByRole("button", { name: "Send test to Team chat" }),
    );
    expect((await within(item).findByRole("status")).textContent).toContain(
      "The test message was delivered.",
    );
    await user.click(
      within(item).getByRole("button", { name: "Show recent deliveries" }),
    );
    const log = await within(item).findByRole("list", {
      name: "Recent deliveries",
    });
    expect(log.textContent).toContain("Test message from AI Office");
    expect(log.textContent).toContain("Test delivered");

    await user.click(
      within(item).getByRole("button", { name: "Pause Team chat" }),
    );
    await within(item).findByRole("button", { name: "Resume Team chat" });
    expect(item.textContent).toContain("Status: Paused");
    await user.click(
      within(item).getByRole("button", { name: "Resume Team chat" }),
    );
    await within(item).findByRole("button", { name: "Pause Team chat" });

    await user.click(
      within(item).getByRole("button", { name: "Edit Team chat" }),
    );
    const edit = within(item).getByRole("form", { name: "Edit Team chat" });
    await user.clear(within(edit).getByLabelText("Name"));
    await fill(user, within(edit).getByLabelText("Name"), "Ops chat");
    await user.click(within(edit).getByLabelText(/^Work complete/));
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    const renamed = await screen.findByRole("listitem", { name: "Ops chat" });

    await user.click(
      within(renamed).getByRole("button", { name: "Delete Ops chat" }),
    );
    await user.click(
      within(renamed).getByRole("button", { name: "Yes, delete Ops chat" }),
    );
    await screen.findByText("No Connections yet.");
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "POST /api/connections",
      "POST /api/connections/connection-1/test",
      "PATCH /api/connections/connection-1",
      "PATCH /api/connections/connection-1",
      "PATCH /api/connections/connection-1",
      "DELETE /api/connections/connection-1",
    ]);
    expect(sent.slice(2, 5).map(({ body }) => body)).toEqual([
      { paused: true },
      { paused: false },
      {
        name: "Ops chat",
        rules: {
          actionNotices: true,
          infoNotices: false,
          workComplete: false,
          floorIds: [],
        },
      },
    ]);
  });

  it("pauses the Communications Agent", async () => {
    const user = userEvent.setup();
    const { sent } = stubServer();
    renderPage();
    const form = await screen.findByRole("form", {
      name: "Communications Agent",
    });
    expect(within(form).getByLabelText<HTMLInputElement>("Name").value).toBe(
      "Grace",
    );
    await user.selectOptions(within(form).getByLabelText("Status"), "paused");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await within(form).findByText("Saved.");
    expect(sent).toEqual([
      {
        method: "PATCH",
        url: "/api/communications-agent",
        body: {
          name: "Grace",
          enabled: false,
          aiProvider: "Claude",
          modelOverride: null,
        },
        csrf: "csrf-token-1",
      },
    ]);
  });

  it("is linked from Admin", async () => {
    stubServer();
    renderPage("/general-settings");
    const heading = await screen.findByRole("heading", {
      name: "Communications",
    });
    const card = heading.closest<HTMLElement>("[data-slot=card]");
    expect(
      within(card ?? document.body)
        .getByRole("link", { name: "Manage Connections" })
        .getAttribute("href"),
    ).toBe("/general-settings/connections");
  });
});

describe("a delivery's outcome", () => {
  const queued = delivered("Pull request #14 merged", false);

  it("says when quiet hours hold it, and when a Digest summarised it", () => {
    expect(
      deliveryOutcome({
        ...queued,
        status: "pending",
        attempts: 0,
        deliveredAt: null,
        lastAttemptAt: null,
        nextAttemptAt: "2026-10-11T06:00:00.000Z",
      }),
    ).toBe(
      `Action Notice held for quiet hours until ${new Date("2026-10-11T06:00:00.000Z").toLocaleString()}`,
    );
    expect(
      deliveryOutcome({
        ...queued,
        status: "pending",
        attempts: 0,
        deliveredAt: null,
        lastAttemptAt: null,
        nextAttemptAt: queued.createdAt,
      }),
    ).toBe("Action Notice waiting to be sent");
    expect(
      deliveryOutcome({
        ...queued,
        status: "summarised",
        deliveredAt: null,
        nextAttemptAt: null,
      }),
    ).toBe("Action Notice held for quiet hours, then summarised in a Digest");
  });

  it("names a Connection's quiet hours when action Notices are let through", () => {
    expect(
      deliveryRulesText({
        id: "connection-1",
        name: "Phone",
        type: "ntfy",
        rules: {
          actionNotices: true,
          infoNotices: false,
          workComplete: true,
          floorIds: [],
          quietHours: {
            start: "23:00",
            end: "06:30",
            timeZone: "Europe/Paris",
            actionNotices: true,
          },
        },
        detailLevel: "titles_and_summaries",
        hint: "ntfy.sh",
        details: [],
        paused: false,
        status: "ok",
        consecutiveFailures: 0,
        lastDelivery: null,
        createdAt: "2026-10-10T09:00:00.000Z",
      }),
    ).toBe(
      "Titles and summaries · Quiet 23:00–06:30 (Europe/Paris), action Notices let through",
    );
  });

  it("names a publishing destination's Wrap-up reports and changelog", () => {
    const wiki = {
      id: "connection-2",
      name: "Wiki",
      type: "confluence" as const,
      rules: {
        actionNotices: false,
        infoNotices: false,
        workComplete: false,
        floorIds: [],
        changelog: true,
      },
      detailLevel: "links_only" as const,
      hint: "example.atlassian.net",
      details: [],
      paused: false,
      status: "ok" as const,
      consecutiveFailures: 0,
      lastDelivery: null,
      createdAt: "2026-10-10T09:00:00.000Z",
    };
    expect(deliveryRulesText(wiki)).toBe(
      "Links only · Wrap-up reports · Running changelog",
    );
    expect(
      deliveryRulesText({
        ...wiki,
        rules: { ...wiki.rules, changelog: false },
      }),
    ).toBe("Links only · Wrap-up reports");
    const google = { ...wiki, detailLevel: "titles_and_summaries" as const };
    expect(deliveryRulesText({ ...google, type: "google_docs" as const })).toBe(
      "Titles and summaries · Wrap-up reports · Running changelog",
    );
    expect(
      deliveryRulesText({
        ...google,
        type: "google_slides" as const,
        rules: { ...wiki.rules, changelog: false },
      }),
    ).toBe("Titles and summaries · Wrap-up decks");
    expect(
      deliveryRulesText({
        ...google,
        type: "google_drive" as const,
        rules: { ...wiki.rules, changelog: false },
      }),
    ).toBe("Titles and summaries · Wrap-up reports as Markdown and PDF files");
    expect(
      deliveryRulesText({
        ...google,
        type: "google_calendar" as const,
        rules: { ...wiki.rules, changelog: false },
      }),
    ).toBe("Titles and summaries · An event per Batch");
  });

  it("names a work log's rows", () => {
    const log = {
      id: "connection-3",
      name: "Work log",
      type: "google_sheets" as const,
      rules: {
        actionNotices: false,
        infoNotices: false,
        workComplete: false,
        floorIds: [],
        notices: true,
      },
      detailLevel: "titles_and_summaries" as const,
      hint: '"Work log" in 1AbCdEfG…',
      details: [],
      paused: false,
      status: "ok" as const,
      consecutiveFailures: 0,
      lastDelivery: null,
      createdAt: "2026-10-10T09:00:00.000Z",
    };
    expect(deliveryRulesText(log)).toBe(
      "Titles and summaries · A row per completed issue · A row per Notice",
    );
  });
});
