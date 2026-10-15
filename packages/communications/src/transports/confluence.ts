import {
  confluenceCredentialsSchema,
  type ConfluenceCredentials,
  type OutboundMessage,
} from "@ai-office/shared";

import { confluenceStorage, escapeXml, parseMarkdown } from "../markdown.ts";
import {
  DeliveryError,
  retryAfterMs,
  fetchOwnerUrl,
  type ConnectionTransport,
} from "./transport.ts";

// Confluence (PRD FR-91, FR-92), a publishing destination: each finished
// Batch's Wrap-up report becomes a child page of the Owner's parent page,
// in their space, through Confluence Cloud's REST API (v2) with an
// Atlassian account's email and API token. With a running changelog, each
// merged pull request is an entry on one "AI Office changelog" page there,
// made with the first. Both are idempotent, so a retry after a lost answer
// never makes a second page or entry: a report's page is looked for by its
// title (unique in a space) before it is made, and an entry by its pull
// request's link. "Send test" only reads: the space and the parent page.
// Nothing Confluence sends back is acted on beyond those ids (FR-95).

/** The changelog page's title. */
export const changelogTitle = "AI Office changelog";

/** A changelog entry for a merged pull request, as a line of a page. */
export function changelogLine(message: OutboundMessage): {
  readonly date: string;
  readonly floor: string | null;
  readonly title: string;
  readonly url: string | null;
} {
  return {
    date: message.occurredAt.slice(0, 10),
    floor: message.floor?.name ?? null,
    title: message.title,
    url: message.githubUrl,
  };
}

/** A changelog entry in Confluence's storage format. */
export function confluenceChangelogEntry(message: OutboundMessage): string {
  const line = changelogLine(message);
  const title =
    line.url === null
      ? escapeXml(line.title)
      : `<a href="${escapeXml(line.url)}">${escapeXml(line.title)}</a>`;
  return `<p><strong>${escapeXml(line.date)}</strong>${
    line.floor === null ? "" : ` · ${escapeXml(line.floor)}`
  } · ${title}</p>`;
}

export interface ConfluenceTransportOptions {
  /** How long one request may take; 20 seconds by default. */
  readonly timeoutMs?: number;
}

interface PageSummary {
  readonly id: string;
  readonly title: string;
}

export function confluenceTransport(
  options: ConfluenceTransportOptions = {},
): ConnectionTransport<ConfluenceCredentials> {
  const timeoutMs = options.timeoutMs ?? 20_000;

  /** Calls Confluence's v2 API; its JSON answer, or a `DeliveryError`. */
  const call = async (
    credentials: ConfluenceCredentials,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const url = `${credentials.siteUrl.replace(/\/+$/, "")}/wiki/api/v2${path}`;
    const response = await fetchOwnerUrl("Confluence", url, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Basic ${Buffer.from(
          `${credentials.email}:${credentials.apiToken}`,
        ).toString("base64")}`,
        "user-agent": "AI-Office",
        ...(body === undefined
          ? {}
          : { "content-type": "application/json; charset=utf-8" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (response.ok) {
      return { status: response.status, json };
    }
    const status = String(response.status);
    switch (response.status) {
      case 401:
        throw new DeliveryError(
          `Confluence refused the email and API token (${status}).`,
        );
      case 403:
        throw new DeliveryError(
          `The Atlassian account may not do that in this space (${status}).`,
        );
      case 404:
        throw new DeliveryError(
          `Confluence cannot find the space or the parent page (${status}).`,
        );
      case 429: {
        const wait = retryAfterMs(response.headers.get("retry-after"));
        throw new DeliveryError(
          "Confluence is rate-limiting this Connection (429).",
          wait === undefined ? {} : { retryAfterMs: wait },
        );
      }
      default:
        throw Object.assign(
          new DeliveryError(`Confluence answered ${status}.`),
          { status: response.status },
        );
    }
  };

  const spaceIdOf = async (credentials: ConfluenceCredentials) => {
    const { json } = await call(
      credentials,
      "GET",
      `/spaces?keys=${encodeURIComponent(credentials.spaceKey)}`,
    );
    const [space] = (json["results"] ?? []) as { id?: unknown }[];
    if (typeof space?.id !== "string") {
      throw new DeliveryError(
        `Confluence has no space with the key ${credentials.spaceKey}.`,
      );
    }
    return space.id;
  };

  const findPage = async (
    credentials: ConfluenceCredentials,
    spaceId: string,
    title: string,
  ): Promise<PageSummary | undefined> => {
    const { json } = await call(
      credentials,
      "GET",
      `/pages?space-id=${encodeURIComponent(spaceId)}&title=${encodeURIComponent(title)}&status=current`,
    );
    return ((json["results"] ?? []) as PageSummary[]).find(
      (page) => page.title === title,
    );
  };

  /** Makes a page under the parent, unless one has its title: its id. */
  const ensurePage = async (
    credentials: ConfluenceCredentials,
    spaceId: string,
    title: string,
    storage: string,
  ): Promise<string> => {
    const found = await findPage(credentials, spaceId, title);
    if (found !== undefined) {
      return found.id;
    }
    try {
      const { json } = await call(credentials, "POST", "/pages", {
        spaceId,
        status: "current",
        title,
        parentId: credentials.parentPageId,
        body: { representation: "storage", value: storage },
      });
      return String(json["id"]);
    } catch (error) {
      // Made meanwhile (titles are unique in a space): that page stands.
      const again =
        (error as { status?: number }).status === 400
          ? await findPage(credentials, spaceId, title)
          : undefined;
      if (again !== undefined) {
        return again.id;
      }
      throw error;
    }
  };

  const appendEntry = async (
    credentials: ConfluenceCredentials,
    pageId: string,
    message: OutboundMessage,
  ): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      const { json } = await call(
        credentials,
        "GET",
        `/pages/${encodeURIComponent(pageId)}?body-format=storage`,
      );
      const value =
        (json["body"] as { storage?: { value?: string } } | undefined)?.storage
          ?.value ?? "";
      const version =
        (json["version"] as { number?: number } | undefined)?.number ?? 1;
      // An entry is its pull request's link: one already there stands.
      if (
        message.githubUrl !== null &&
        value.includes(`href="${escapeXml(message.githubUrl)}"`)
      ) {
        return;
      }
      try {
        await call(credentials, "PUT", `/pages/${encodeURIComponent(pageId)}`, {
          id: pageId,
          status: "current",
          title: changelogTitle,
          body: {
            representation: "storage",
            value: `${value}${confluenceChangelogEntry(message)}`,
          },
          version: {
            number: version + 1,
            message: "AI Office changelog entry",
          },
        });
        return;
      } catch (error) {
        // Edited meanwhile: read it again, once.
        if ((error as { status?: number }).status !== 409 || attempt > 0) {
          throw error;
        }
      }
    }
  };

  return {
    credentials: confluenceCredentialsSchema,

    describe(credentials) {
      return {
        hint: new URL(credentials.siteUrl).host,
        settings: {
          email: credentials.email,
          spaceKey: credentials.spaceKey,
          parentPageId: credentials.parentPageId,
        },
      };
    },

    // The site, the account, the space and the page are not secret.
    secrets: (credentials) => [credentials.apiToken],

    details(settings) {
      return [
        `Space ${String(settings["spaceKey"])}, under page ${String(settings["parentPageId"])}`,
        `As ${String(settings["email"])}`,
      ];
    },

    async send(delivery, { credentials }) {
      const spaceId = await spaceIdOf(credentials);
      const { message } = delivery;
      if (delivery.test) {
        await call(
          credentials,
          "GET",
          `/pages/${encodeURIComponent(credentials.parentPageId)}`,
        );
        return;
      }
      switch (message.kind) {
        case "report":
          await ensurePage(
            credentials,
            spaceId,
            message.title,
            confluenceStorage(parseMarkdown(message.document ?? message.title)),
          );
          return;
        case "changelog": {
          const pageId = await ensurePage(
            credentials,
            spaceId,
            changelogTitle,
            `<p>${escapeXml("Each pull request AI Office merges, newest last.")}</p>`,
          );
          await appendEntry(credentials, pageId, message);
          return;
        }
        default:
          throw new DeliveryError(
            "A Confluence Connection publishes Wrap-up reports and changelog entries only.",
          );
      }
    },
  };
}
