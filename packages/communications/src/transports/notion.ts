import {
  notionCredentialsSchema,
  type NotionCredentials,
  type OutboundMessage,
} from "@ai-office/shared";

import { notionBlocks, notionRichText, parseMarkdown } from "../markdown.ts";
import { changelogLine, changelogTitle } from "./confluence.ts";
import {
  DeliveryError,
  retryAfterMs,
  unreachable,
  type ConnectionTransport,
} from "./transport.ts";

// Notion (PRD FR-91, FR-92), a publishing destination: each finished
// Batch's Wrap-up report becomes a page under the Owner's parent page, or
// in their database, through Notion's API with an internal integration's
// token (the parent shared with the integration). With a running
// changelog, each merged pull request is an entry on one "AI Office
// changelog" page there, made with the first. Both are idempotent, so a
// retry after a lost answer never makes a second page or entry: a report's
// page is looked for by its title before it is made, and an entry by its
// pull request's link. "Send test" only reads the parent. Nothing Notion
// sends back is acted on beyond those ids (FR-95).

/** The Notion API version these requests are written for. */
export const notionVersion = "2022-06-28";

/** The most blocks Notion takes in one request. */
const blocksPerRequest = 100;

/** A changelog entry as a Notion block. */
export function notionChangelogEntry(
  message: OutboundMessage,
): Record<string, unknown> {
  const line = changelogLine(message);
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: notionRichText([
        { text: line.date, bold: true },
        { text: line.floor === null ? " · " : ` · ${line.floor} · ` },
        line.url === null
          ? { text: line.title }
          : { text: line.title, link: line.url },
      ]),
    },
  };
}

export interface NotionTransportOptions {
  /** Notion's API; `https://api.notion.com` by default. */
  readonly apiUrl?: string;
  /** How long one request may take; 20 seconds by default. */
  readonly timeoutMs?: number;
}

type Json = Record<string, unknown>;

/** The rich text of a block, whatever its type. */
const richTextOf = (block: Json): Json[] => {
  const type = block["type"];
  const content =
    typeof type === "string" ? (block[type] as Json | undefined) : undefined;
  return (content?.["rich_text"] ?? []) as Json[];
};

export function notionTransport(
  options: NotionTransportOptions = {},
): ConnectionTransport<NotionCredentials> {
  const apiUrl = (options.apiUrl ?? "https://api.notion.com").replace(
    /\/+$/,
    "",
  );
  const timeoutMs = options.timeoutMs ?? 20_000;

  /** Calls Notion's API; its JSON answer, or a `DeliveryError`. */
  const call = async (
    credentials: NotionCredentials,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<Json> => {
    let response: Response;
    try {
      response = await fetch(`${apiUrl}/v1${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credentials.token}`,
          "notion-version": notionVersion,
          "user-agent": "AI-Office",
          ...(body === undefined
            ? {}
            : { "content-type": "application/json; charset=utf-8" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw unreachable("Notion", error);
    }
    const json = (await response.json().catch(() => ({}))) as Json;
    if (response.ok) {
      return json;
    }
    const status = String(response.status);
    const said =
      typeof json["message"] === "string" ? `: ${json["message"]}` : "";
    switch (response.status) {
      case 401:
        throw new DeliveryError(
          `Notion refused the integration token (${status}).`,
        );
      case 403:
      case 404:
        throw new DeliveryError(
          `Notion cannot reach the parent ${credentials.parentType}: share it with the integration (${status}).`,
        );
      case 429: {
        const wait = retryAfterMs(response.headers.get("retry-after"));
        throw new DeliveryError(
          "Notion is rate-limiting this Connection (429).",
          wait === undefined ? {} : { retryAfterMs: wait },
        );
      }
      default:
        throw new DeliveryError(
          `Notion answered ${status}${said.slice(0, 300)}.`,
        );
    }
  };

  /** The parent, as a new page names it. */
  const parentOf = (credentials: NotionCredentials) =>
    credentials.parentType === "page"
      ? { page_id: credentials.parentId }
      : { database_id: credentials.parentId };

  /** A database's title property's name; a page's is `title`. */
  const titleProperty = async (
    credentials: NotionCredentials,
  ): Promise<string> => {
    if (credentials.parentType === "page") {
      return "title";
    }
    const database = await call(
      credentials,
      "GET",
      `/databases/${credentials.parentId}`,
    );
    const properties = (database["properties"] ?? {}) as Record<string, Json>;
    const [name] =
      Object.entries(properties).find(
        ([, property]) => property["type"] === "title",
      ) ?? [];
    if (name === undefined) {
      throw new DeliveryError("The Notion database has no title property.");
    }
    return name;
  };

  /** Every child block of a block, following Notion's pages of results. */
  const children = async (
    credentials: NotionCredentials,
    blockId: string,
  ): Promise<Json[]> => {
    const all: Json[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await call(
        credentials,
        "GET",
        `/blocks/${blockId}/children?page_size=100${
          cursor === undefined
            ? ""
            : `&start_cursor=${encodeURIComponent(cursor)}`
        }`,
      );
      all.push(...((page["results"] ?? []) as Json[]));
      if (
        page["has_more"] !== true ||
        typeof page["next_cursor"] !== "string"
      ) {
        return all;
      }
      cursor = page["next_cursor"];
    }
  };

  /** The page with `title` in the parent, if there is one. */
  const findPage = async (
    credentials: NotionCredentials,
    property: string,
    title: string,
  ): Promise<string | undefined> => {
    if (credentials.parentType === "page") {
      const found = (await children(credentials, credentials.parentId)).find(
        (block) =>
          block["type"] === "child_page" &&
          (block["child_page"] as Json | undefined)?.["title"] === title,
      );
      return typeof found?.["id"] === "string" ? found["id"] : undefined;
    }
    const answer = await call(
      credentials,
      "POST",
      `/databases/${credentials.parentId}/query`,
      { filter: { property, title: { equals: title } }, page_size: 1 },
    );
    const [found] = (answer["results"] ?? []) as Json[];
    return typeof found?.["id"] === "string" ? found["id"] : undefined;
  };

  /** Makes a page in the parent, unless one has its title: its id. */
  const ensurePage = async (
    credentials: NotionCredentials,
    title: string,
    blocks: readonly Json[],
  ): Promise<string> => {
    const property = await titleProperty(credentials);
    const found = await findPage(credentials, property, title);
    if (found !== undefined) {
      return found;
    }
    const made = await call(credentials, "POST", "/pages", {
      parent: parentOf(credentials),
      properties: {
        [property]: { title: [{ type: "text", text: { content: title } }] },
      },
      children: blocks.slice(0, blocksPerRequest),
    });
    const id = String(made["id"]);
    for (
      let at = blocksPerRequest;
      at < blocks.length;
      at += blocksPerRequest
    ) {
      await call(credentials, "PATCH", `/blocks/${id}/children`, {
        children: blocks.slice(at, at + blocksPerRequest),
      });
    }
    return id;
  };

  return {
    credentials: notionCredentialsSchema,

    describe(credentials) {
      return {
        hint: `${credentials.parentType} ${credentials.parentId.slice(0, 8)}…`,
        settings: {
          parentType: credentials.parentType,
          parentId: credentials.parentId,
        },
      };
    },

    // The parent's id is not secret; the token is.
    secrets: (credentials) => [credentials.token],

    details(settings) {
      return [
        settings["parentType"] === "database"
          ? `In database ${String(settings["parentId"])}`
          : `Under page ${String(settings["parentId"])}`,
      ];
    },

    async send(delivery, { credentials }) {
      const { message } = delivery;
      if (delivery.test) {
        await call(
          credentials,
          "GET",
          `/${credentials.parentType === "page" ? "pages" : "databases"}/${credentials.parentId}`,
        );
        return;
      }
      switch (message.kind) {
        case "report":
          await ensurePage(
            credentials,
            message.title,
            notionBlocks(parseMarkdown(message.document ?? message.title)),
          );
          return;
        case "changelog": {
          const pageId = await ensurePage(credentials, changelogTitle, [
            {
              object: "block",
              type: "paragraph",
              paragraph: {
                rich_text: notionRichText([
                  { text: "Each pull request AI Office merges, newest last." },
                ]),
              },
            },
          ]);
          // An entry is its pull request's link: one already there stands.
          const listed = await children(credentials, pageId);
          if (
            message.githubUrl !== null &&
            listed.some((block) =>
              richTextOf(block).some(
                (text) =>
                  (
                    (text["text"] as Json | undefined)?.["link"] as
                      Json | null | undefined
                  )?.["url"] === message.githubUrl,
              ),
            )
          ) {
            return;
          }
          await call(credentials, "PATCH", `/blocks/${pageId}/children`, {
            children: [notionChangelogEntry(message)],
          });
          return;
        }
        default:
          throw new DeliveryError(
            "A Notion Connection publishes Wrap-up reports and changelog entries only.",
          );
      }
    },
  };
}
