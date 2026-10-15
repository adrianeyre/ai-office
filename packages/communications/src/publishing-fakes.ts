import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

// Fake Confluence and Notion APIs for the publishing destinations'
// contract tests (PRD §9: a contract suite per Connection type against
// local fakes). Each answers the requests AI Office makes as the real
// service does, from what it keeps in memory: authentication, the shapes
// of pages and blocks and their limits, duplicate titles in a Confluence
// space, page versions, and 429s with `Retry-After`. Each can also carry
// out a write but lose its answer, as a dropped connection would, to show
// that a retry makes nothing twice.

type Json = Record<string, unknown>;

const bodyOf = (request: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
  });

export const send = (
  response: ServerResponse,
  status: number,
  body: unknown,
) => {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
};

interface Listening {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export async function listen(
  handle: (
    request: IncomingMessage,
    response: ServerResponse,
    raw: string,
    bytes: Buffer,
  ) => void,
): Promise<Listening> {
  const server = createServer((request, response) => {
    void bodyOf(request).then((bytes) => {
      handle(request, response, bytes.toString("utf8"), bytes);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The faults a fake can be told to make. */
export interface Faults {
  rateLimit(count: number, retryAfterSeconds: number): void;
  /** The next write is carried out, but answered 502, as if its answer were lost. */
  loseNextAnswer(): void;
}

export function faults() {
  let limited = { count: 0, retryAfter: 0 };
  let lose = false;
  return {
    control: {
      rateLimit(count: number, retryAfterSeconds: number) {
        limited = { count, retryAfter: retryAfterSeconds };
      },
      loseNextAnswer() {
        lose = true;
      },
    } satisfies Faults,
    /** Answers a 429 if one is due; true if it did. */
    limit(response: ServerResponse): boolean {
      if (limited.count === 0) {
        return false;
      }
      limited = { ...limited, count: limited.count - 1 };
      response
        .writeHead(429, { "retry-after": String(limited.retryAfter) })
        .end();
      return true;
    },
    /** Whether this write's answer is lost; it is still carried out. */
    lost(): boolean {
      const was = lose;
      lose = false;
      return was;
    },
  };
}

/** A page in the fake Confluence. */
export interface ConfluencePage {
  readonly id: string;
  readonly spaceId: string;
  title: string;
  readonly parentId: string | null;
  /** Its body, in the storage format. */
  body: string;
  version: number;
}

export interface FakeConfluence extends Faults {
  /** The site's address, as a Confluence Connection's `siteUrl`. */
  readonly url: string;
  /** Every page, the parent page first. */
  readonly pages: ConfluencePage[];
  /** The pages made under a page, oldest first. */
  childrenOf(pageId: string): ConfluencePage[];
  /** Every request, as method and path. */
  readonly requests: { readonly method: string; readonly path: string }[];
  close(): Promise<void>;
}

/**
 * A fake Confluence Cloud (REST API v2): one site, with the spaces given,
 * the parent page, and Basic authentication by `email` and `apiToken`.
 * Page titles are unique in a space (a duplicate is a 400), and an update
 * must name the page's next version (otherwise 409).
 */
export async function serveFakeConfluence(options: {
  readonly email: string;
  readonly apiToken: string;
  readonly spaces: readonly { readonly key: string; readonly id: string }[];
  readonly parentPageId: string;
}): Promise<FakeConfluence> {
  const fault = faults();
  const [home] = options.spaces;
  const pages: ConfluencePage[] = [
    {
      id: options.parentPageId,
      spaceId: home?.id ?? "1",
      title: "Engineering",
      parentId: null,
      body: "<p>The team's home.</p>",
      version: 1,
    },
  ];
  let nextId = 900_001;
  const requests: { method: string; path: string }[] = [];
  const authorization = `Basic ${Buffer.from(
    `${options.email}:${options.apiToken}`,
  ).toString("base64")}`;
  const pageJson = (page: ConfluencePage, withBody: boolean) => ({
    id: page.id,
    status: "current",
    title: page.title,
    spaceId: page.spaceId,
    parentId: page.parentId,
    version: { number: page.version },
    ...(withBody
      ? { body: { storage: { representation: "storage", value: page.body } } }
      : {}),
    _links: { webui: `/spaces/x/pages/${page.id}` },
  });
  const listening = await listen((request, response, raw) => {
    const url = new URL(request.url ?? "/", "http://confluence.invalid");
    requests.push({ method: request.method ?? "GET", path: url.pathname });
    if (fault.limit(response)) {
      return;
    }
    if (request.headers.authorization !== authorization) {
      send(response, 401, {
        message: "Client must be authenticated to access this resource.",
      });
      return;
    }
    const path = url.pathname.replace(/^\/wiki\/api\/v2/, "");
    if (request.method === "GET" && path === "/spaces") {
      const keys = (url.searchParams.get("keys") ?? "").split(",");
      send(response, 200, {
        results: options.spaces
          .filter(({ key }) => keys.includes(key))
          .map(({ key, id }) => ({ id, key, name: key })),
      });
      return;
    }
    if (request.method === "GET" && path === "/pages") {
      const spaceId = url.searchParams.get("space-id");
      const title = url.searchParams.get("title");
      send(response, 200, {
        results: pages
          .filter(
            (page) =>
              (spaceId === null || page.spaceId === spaceId) &&
              (title === null || page.title === title),
          )
          .map((page) => pageJson(page, false)),
      });
      return;
    }
    const one = /^\/pages\/(\d+)$/.exec(path);
    if (request.method === "GET" && one !== null) {
      const page = pages.find(({ id }) => id === one[1]);
      if (page === undefined) {
        send(response, 404, { errors: [{ status: 404, title: "Not Found" }] });
        return;
      }
      send(
        response,
        200,
        pageJson(page, url.searchParams.get("body-format") === "storage"),
      );
      return;
    }
    let body: Json;
    try {
      body = JSON.parse(raw) as Json;
    } catch {
      send(response, 400, { errors: [{ status: 400, title: "Invalid JSON" }] });
      return;
    }
    const storage = body["body"] as Json | undefined;
    const value = storage?.["value"];
    const badBody =
      storage?.["representation"] !== "storage" ||
      typeof value !== "string" ||
      /<script/i.test(value);
    if (request.method === "POST" && path === "/pages") {
      const spaceId = body["spaceId"];
      const parentId = body["parentId"];
      const title = body["title"];
      if (
        !options.spaces.some(({ id }) => id === spaceId) ||
        typeof title !== "string" ||
        title.trim() === "" ||
        title.length > 255 ||
        badBody
      ) {
        send(response, 400, {
          errors: [{ status: 400, title: "Invalid page" }],
        });
        return;
      }
      if (!pages.some(({ id }) => id === parentId)) {
        send(response, 404, {
          errors: [{ status: 404, title: "Parent not found" }],
        });
        return;
      }
      if (
        pages.some((page) => page.spaceId === spaceId && page.title === title)
      ) {
        send(response, 400, {
          errors: [
            {
              status: 400,
              title:
                "A page with this title already exists: A page already exists with the same TITLE in this space",
            },
          ],
        });
        return;
      }
      const page: ConfluencePage = {
        id: String(nextId),
        spaceId: String(spaceId),
        title,
        parentId: String(parentId),
        body: value,
        version: 1,
      };
      nextId += 1;
      pages.push(page);
      if (fault.lost()) {
        send(response, 502, { message: "Bad gateway" });
        return;
      }
      send(response, 200, pageJson(page, true));
      return;
    }
    if (request.method === "PUT" && one !== null) {
      const page = pages.find(({ id }) => id === one[1]);
      if (page === undefined) {
        send(response, 404, { errors: [{ status: 404, title: "Not Found" }] });
        return;
      }
      const version = (body["version"] as Json | undefined)?.["number"];
      if (version !== page.version + 1) {
        send(response, 409, {
          errors: [
            { status: 409, title: "Version must be incremented on update." },
          ],
        });
        return;
      }
      if (badBody || typeof body["title"] !== "string") {
        send(response, 400, {
          errors: [{ status: 400, title: "Invalid page" }],
        });
        return;
      }
      page.title = body["title"];
      page.body = value;
      page.version = version;
      if (fault.lost()) {
        send(response, 502, { message: "Bad gateway" });
        return;
      }
      send(response, 200, pageJson(page, true));
      return;
    }
    send(response, 404, { errors: [{ status: 404, title: "Not Found" }] });
  });
  return {
    ...fault.control,
    url: listening.url,
    pages,
    childrenOf: (pageId) => pages.filter(({ parentId }) => parentId === pageId),
    requests,
    close: listening.close,
  };
}

/** A page in the fake Notion, made through its API. */
export interface NotionPage {
  readonly id: string;
  readonly parent:
    | { readonly type: "page_id"; readonly page_id: string }
    | { readonly type: "database_id"; readonly database_id: string };
  readonly title: string;
  /** Its blocks, in order: as given, with ids. */
  readonly blocks: Json[];
}

export interface FakeNotion extends Faults {
  /** Notion's API, as the Notion transport's `apiUrl`. */
  readonly apiUrl: string;
  /** Every page made, oldest first. */
  readonly pages: NotionPage[];
  /** Every request, as method and path. */
  readonly requests: { readonly method: string; readonly path: string }[];
  close(): Promise<void>;
}

/** The blocks the fake Notion takes, and the rich text each holds. */
const blockTypes = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "table",
]);

/** Why `block` is not one Notion takes, if it is not. */
function blockProblem(block: Json): string | undefined {
  const type = block["type"];
  if (typeof type !== "string" || !blockTypes.has(type)) {
    return `body.children[].type should be a known block type, not ${String(type)}.`;
  }
  const content = block[type] as Json | undefined;
  const texts: Json[][] =
    type === "table"
      ? ((content?.["children"] ?? []) as Json[]).flatMap(
          (row) =>
            ((row["table_row"] as Json | undefined)?.["cells"] ??
              []) as Json[][],
        )
      : [(content?.["rich_text"] ?? []) as Json[]];
  if (type === "table") {
    const width = content?.["table_width"];
    const rows = (content?.["children"] ?? []) as Json[];
    if (
      rows.some(
        (row) =>
          (
            ((row["table_row"] as Json | undefined)?.["cells"] ??
              []) as unknown[]
          ).length !== width,
      )
    ) {
      return "Number of cells in table row must match the table width.";
    }
  }
  for (const text of texts.flat()) {
    const inner = text["text"] as Json | undefined;
    const words = inner?.["content"];
    if (typeof words !== "string" || words.length > 2000) {
      return "body.children[].rich_text[].text.content.length should be ≤ 2000.";
    }
    const link = inner?.["link"] as Json | null | undefined;
    if (
      link !== null &&
      link !== undefined &&
      !/^https?:\/\//.test(String(link["url"]))
    ) {
      return "Invalid URL for link.";
    }
  }
  return undefined;
}

/**
 * A fake Notion API (version 2022-06-28): the parent pages and databases
 * given, shared with one integration, whose token is a bearer token.
 * Pages made under a page are its `child_page` blocks; a database's are
 * found by querying its title property. At most 100 blocks a request,
 * 2000 characters a rich text item. Lists of children come `pageSize` at
 * a time.
 */
export async function serveFakeNotion(options: {
  readonly token: string;
  readonly parentPages?: readonly string[];
  readonly databases?: readonly {
    readonly id: string;
    readonly titleProperty: string;
  }[];
  readonly pageSize?: number;
}): Promise<FakeNotion> {
  const fault = faults();
  const pageSize = options.pageSize ?? 100;
  const pages: NotionPage[] = [];
  const childrenOf = new Map<string, Json[]>(
    (options.parentPages ?? []).map((id) => [id, []]),
  );
  const databases = new Map(
    (options.databases ?? []).map(({ id, titleProperty }) => [
      id,
      titleProperty,
    ]),
  );
  const requests: { method: string; path: string }[] = [];
  const compact = (id: string) => id.replaceAll("-", "");
  const newId = () => randomUUID();
  const error = (
    response: ServerResponse,
    status: number,
    code: string,
    message: string,
  ) => {
    send(response, status, { object: "error", status, code, message });
  };
  const withIds = (blocks: readonly Json[]) =>
    blocks.map((block) => ({ ...block, id: newId(), has_children: false }));
  const listening = await listen((request, response, raw) => {
    const url = new URL(request.url ?? "/", "http://notion.invalid");
    requests.push({ method: request.method ?? "GET", path: url.pathname });
    if (fault.limit(response)) {
      return;
    }
    if (request.headers.authorization !== `Bearer ${options.token}`) {
      error(response, 401, "unauthorized", "API token is invalid.");
      return;
    }
    if (request.headers["notion-version"] !== "2022-06-28") {
      error(
        response,
        400,
        "missing_version",
        "Notion-Version header failed validation.",
      );
      return;
    }
    const path = url.pathname.replace(/^\/v1/, "");
    const segment = (pattern: RegExp) => {
      const match = pattern.exec(path);
      return match === null ? undefined : compact(match[1] ?? "");
    };
    const pageId = segment(/^\/pages\/([0-9a-f-]+)$/);
    if (request.method === "GET" && pageId !== undefined) {
      const known =
        childrenOf.has(pageId) ||
        pages.some(({ id }) => compact(id) === pageId);
      if (!known) {
        error(
          response,
          404,
          "object_not_found",
          `Could not find page with ID: ${pageId}.`,
        );
        return;
      }
      send(response, 200, { object: "page", id: pageId });
      return;
    }
    const databaseId = segment(/^\/databases\/([0-9a-f-]+)$/);
    if (request.method === "GET" && databaseId !== undefined) {
      const titleProperty = databases.get(databaseId);
      if (titleProperty === undefined) {
        error(
          response,
          404,
          "object_not_found",
          `Could not find database with ID: ${databaseId}.`,
        );
        return;
      }
      send(response, 200, {
        object: "database",
        id: databaseId,
        properties: {
          Status: { id: "s", type: "select", select: { options: [] } },
          [titleProperty]: { id: "title", type: "title", title: {} },
        },
      });
      return;
    }
    const blockId = segment(/^\/blocks\/([0-9a-f-]+)\/children$/);
    if (request.method === "GET" && blockId !== undefined) {
      const children = childrenOf.get(blockId);
      if (children === undefined) {
        error(
          response,
          404,
          "object_not_found",
          `Could not find block with ID: ${blockId}.`,
        );
        return;
      }
      const start = Number(url.searchParams.get("start_cursor") ?? "0");
      const size = Math.min(
        pageSize,
        Number(url.searchParams.get("page_size") ?? "100"),
      );
      const results = children.slice(start, start + size);
      const more = start + size < children.length;
      send(response, 200, {
        object: "list",
        results,
        has_more: more,
        next_cursor: more ? String(start + size) : null,
      });
      return;
    }
    let body: Json;
    try {
      body = JSON.parse(raw) as Json;
    } catch {
      error(response, 400, "invalid_json", "Error parsing JSON body.");
      return;
    }
    const children = (body["children"] ?? []) as Json[];
    if (!Array.isArray(children) || children.length > 100) {
      error(
        response,
        400,
        "validation_error",
        "body.children.length should be ≤ 100.",
      );
      return;
    }
    const problem = children
      .map(blockProblem)
      .find((each) => each !== undefined);
    if (problem !== undefined) {
      error(response, 400, "validation_error", problem);
      return;
    }
    if (request.method === "PATCH" && blockId !== undefined) {
      const kept = childrenOf.get(blockId);
      if (kept === undefined) {
        error(
          response,
          404,
          "object_not_found",
          `Could not find block with ID: ${blockId}.`,
        );
        return;
      }
      const added = withIds(children);
      kept.push(...added);
      const page = pages.find(({ id }) => compact(id) === blockId);
      page?.blocks.push(...added);
      if (fault.lost()) {
        send(response, 502, { message: "Bad gateway" });
        return;
      }
      send(response, 200, { object: "list", results: added });
      return;
    }
    const queried = segment(/^\/databases\/([0-9a-f-]+)\/query$/);
    if (request.method === "POST" && queried !== undefined) {
      const titleProperty = databases.get(queried);
      if (titleProperty === undefined) {
        error(
          response,
          404,
          "object_not_found",
          `Could not find database with ID: ${queried}.`,
        );
        return;
      }
      const filter = body["filter"] as Json | undefined;
      const wanted = (filter?.["title"] as Json | undefined)?.["equals"];
      if (
        filter?.["property"] !== titleProperty ||
        typeof wanted !== "string"
      ) {
        error(
          response,
          400,
          "validation_error",
          "Could not find property in filter.",
        );
        return;
      }
      send(response, 200, {
        object: "list",
        results: pages
          .filter(
            (page) =>
              page.parent.type === "database_id" &&
              page.parent.database_id === queried &&
              page.title === wanted,
          )
          .map(({ id }) => ({ object: "page", id })),
        has_more: false,
        next_cursor: null,
      });
      return;
    }
    if (request.method === "POST" && path === "/pages") {
      const parent = body["parent"] as Json | undefined;
      const underPage =
        typeof parent?.["page_id"] === "string"
          ? compact(parent["page_id"])
          : undefined;
      const inDatabase =
        typeof parent?.["database_id"] === "string"
          ? compact(parent["database_id"])
          : undefined;
      if (
        (underPage === undefined || !childrenOf.has(underPage)) &&
        (inDatabase === undefined || !databases.has(inDatabase))
      ) {
        error(
          response,
          404,
          "object_not_found",
          "Could not find the parent page or database.",
        );
        return;
      }
      const property =
        inDatabase === undefined ? "title" : (databases.get(inDatabase) ?? "");
      const properties = (body["properties"] ?? {}) as Json;
      const title = ((properties[property] as Json | undefined)?.["title"] ??
        []) as Json[];
      if (
        Object.keys(properties).some((key) => key !== property) ||
        title.length === 0
      ) {
        error(
          response,
          400,
          "validation_error",
          `body.properties should have only ${property}.`,
        );
        return;
      }
      const id = newId();
      const page: NotionPage = {
        id,
        parent:
          inDatabase === undefined
            ? { type: "page_id", page_id: underPage ?? "" }
            : { type: "database_id", database_id: inDatabase },
        title: title
          .map((text) => {
            const content = (text["text"] as Json | undefined)?.["content"];
            return typeof content === "string" ? content : "";
          })
          .join(""),
        blocks: withIds(children),
      };
      pages.push(page);
      childrenOf.set(compact(id), [...page.blocks]);
      if (underPage !== undefined) {
        childrenOf.get(underPage)?.push({
          object: "block",
          id,
          type: "child_page",
          child_page: { title: page.title },
          has_children: true,
        });
      }
      if (fault.lost()) {
        send(response, 502, { message: "Bad gateway" });
        return;
      }
      send(response, 200, { object: "page", id });
      return;
    }
    error(response, 400, "invalid_request_url", "Invalid request URL.");
  });
  return {
    ...fault.control,
    apiUrl: listening.url,
    pages,
    requests,
    close: listening.close,
  };
}
