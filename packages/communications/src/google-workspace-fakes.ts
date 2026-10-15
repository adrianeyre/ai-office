import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";

import { send } from "./publishing-fakes.ts";

// The fake Google's Drive, Docs and Slides APIs, for the Google Docs,
// Slides and Drive Connections' contract tests (PRD §9: a contract suite
// per Connection type against local fakes). `serveFakeGoogle` serves them
// beside its OAuth endpoints and Sheets API, once it has checked the
// access token and its `drive` scope. They keep in memory what the real
// services keep: Drive's folders and files with their private properties,
// searched as Drive's `q` does; a file uploaded as HTML converted into a
// document, as Drive converts it; a document's text, its bold and links
// and its revision, changed by `insertText` and `updateTextStyle`; and a
// deck's slides and their placeholders, changed by `createSlide`,
// `insertText`, `updateTextStyle` and `deleteObject`, each batch whole or
// not at all. A write can be carried out with its answer lost.

type Json = Record<string, unknown>;

/** A file in the fake Drive. */
export interface FakeDriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly parents: readonly string[];
  readonly appProperties: Readonly<Record<string, string>>;
  /** What was uploaded, for a file that is not Google's own. */
  readonly content: Buffer | undefined;
}

/** A run of a document's text: bold or not, a link or not. */
export interface FakeDocRun {
  readonly text: string;
  readonly bold: boolean;
  readonly link: string | undefined;
}

/** A paragraph of a document: its style (`HEADING_1`, `NORMAL_TEXT`…) and runs. */
export interface FakeDocParagraph {
  readonly style: string;
  readonly text: string;
  readonly runs: readonly FakeDocRun[];
}

/** A text box on a slide: its placeholder, its text, and its bold and links. */
export interface FakeSlideText {
  readonly objectId: string;
  readonly placeholder: string;
  readonly text: string;
  readonly bold: readonly string[];
  readonly links: readonly { readonly text: string; readonly url: string }[];
}

export interface FakeSlideView {
  readonly objectId: string;
  readonly layout: string;
  readonly texts: readonly FakeSlideText[];
}

interface Char {
  readonly c: string;
  bold: boolean;
  link: string | undefined;
  /** At a newline: the paragraph's style. */
  style?: string;
}

interface Shape {
  readonly objectId: string;
  readonly placeholder: string;
  text: Char[];
}

interface FakeSlide {
  readonly objectId: string;
  readonly layout: string;
  readonly shapes: Shape[];
}

const folderType = "application/vnd.google-apps.folder";
const documentType = "application/vnd.google-apps.document";
const presentationType = "application/vnd.google-apps.presentation";

/** The placeholders each layout has, in order. */
const layouts: Readonly<Record<string, readonly string[]>> = {
  TITLE: ["CENTERED_TITLE", "SUBTITLE"],
  TITLE_AND_BODY: ["TITLE", "BODY"],
};

/** A JSON value that should be a string: it, or `fallback`. */
const asString = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

/**
 * A string's UTF-16 code units, one each: Docs and Slides count their
 * indices in them.
 */
const units = (value: string): string[] =>
  Array.from({ length: value.length }, (_, index) => value.charAt(index));

const newId = (): string => `1${randomBytes(24).toString("base64url")}`;

const entities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
};

const decode = (text: string): string =>
  text.replaceAll(/&(#\d+|amp|lt|gt|quot);/g, (_, entity: string) =>
    entity.startsWith("#")
      ? String.fromCodePoint(Number(entity.slice(1)))
      : (entities[entity] ?? ""),
  );

/**
 * HTML as Drive converts it into a document: headings, paragraphs, list
 * items and table rows are paragraphs (a row's cells split by tabs), with
 * bold and links kept. What is in `<head>` is not text.
 */
export function htmlToDocument(html: string): Char[] {
  const chars: Char[] = [];
  let bold = 0;
  const links: string[] = [];
  let head = false;
  const styles: Readonly<Record<string, string>> = {
    h1: "HEADING_1",
    h2: "HEADING_2",
    h3: "HEADING_3",
    p: "NORMAL_TEXT",
    li: "NORMAL_TEXT",
    tr: "NORMAL_TEXT",
  };
  for (const [, closing, tag = "", attributes = "", text] of html.matchAll(
    /<!(?:[^>]*)>|<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g,
  )) {
    if (text !== undefined) {
      if (!head) {
        for (const c of units(decode(text))) {
          chars.push({ c, bold: bold > 0, link: links.at(-1) });
        }
      }
      continue;
    }
    const name = tag.toLowerCase();
    const closes = closing === "/";
    if (name === "head") {
      head = !closes;
    } else if (name === "strong" || name === "b") {
      bold += closes ? -1 : 1;
    } else if (name === "a") {
      if (closes) {
        links.pop();
      } else {
        links.push(decode(/href="([^"]*)"/.exec(attributes)?.[1] ?? ""));
      }
    } else if (closes && (name === "td" || name === "th")) {
      chars.push({ c: "\t", bold: false, link: undefined });
    } else if (closes && styles[name] !== undefined) {
      if (name === "tr" && chars.at(-1)?.c === "\t") {
        chars.pop();
      }
      chars.push({
        c: "\n",
        bold: false,
        link: undefined,
        style: styles[name],
      });
    }
  }
  if (chars.at(-1)?.c !== "\n") {
    chars.push({ c: "\n", bold: false, link: undefined, style: "NORMAL_TEXT" });
  }
  return chars;
}

/** Characters as runs of the same bold and link. */
const runsOf = (chars: readonly Char[]): FakeDocRun[] => {
  const runs: FakeDocRun[] = [];
  for (const { c, bold, link } of chars) {
    const last = runs.at(-1);
    if (last?.bold === bold && last.link === link) {
      runs[runs.length - 1] = { ...last, text: last.text + c };
    } else {
      runs.push({ text: c, bold, link });
    }
  }
  return runs;
};

/** A document's characters as paragraphs, each ending at its newline. */
const paragraphsOf = (chars: readonly Char[]): Char[][] => {
  const paragraphs: Char[][] = [];
  let paragraph: Char[] = [];
  for (const char of chars) {
    paragraph.push(char);
    if (char.c === "\n") {
      paragraphs.push(paragraph);
      paragraph = [];
    }
  }
  return paragraphs;
};

class BadRequest extends Error {}

/** What a Docs `updateTextStyle` or Slides' sets on characters. */
function applyStyle(
  chars: Char[],
  start: number,
  end: number,
  style: Json,
  fields: unknown,
): void {
  if (
    typeof fields !== "string" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > chars.length ||
    start >= end
  ) {
    throw new BadRequest("Invalid range or fields.");
  }
  const named = fields.split(",").map((field) => field.trim());
  for (const field of named) {
    if (field !== "bold" && field !== "link") {
      throw new BadRequest(`Unsupported field: ${field}.`);
    }
  }
  for (const char of chars.slice(start, end)) {
    if (named.includes("bold")) {
      char.bold = style["bold"] === true;
    }
    if (named.includes("link")) {
      const url = (style["link"] as Json | undefined)?.["url"];
      char.link = typeof url === "string" ? url : undefined;
    }
  }
}

/** The fake Drive, Docs and Slides, as `serveFakeGoogle` serves them. */
export function fakeWorkspace(
  folders: readonly { readonly id: string; readonly name: string }[],
) {
  let created = 0;
  const files = new Map<
    string,
    FakeDriveFile & { readonly createdAt: number; trashed: boolean }
  >(
    folders.map(({ id, name }) => [
      id,
      {
        id,
        name,
        mimeType: folderType,
        parents: [],
        appProperties: {},
        content: undefined,
        createdAt: (created += 1),
        trashed: false,
      },
    ]),
  );
  const documents = new Map<string, { revision: number; chars: Char[] }>();
  const presentations = new Map<string, FakeSlide[]>();

  const notFound = (response: ServerResponse, id: string) => {
    send(response, 404, {
      error: {
        code: 404,
        message: `File not found: ${id}.`,
        errors: [{ reason: "notFound", message: `File not found: ${id}.` }],
      },
    });
  };

  /** Makes a file in a folder, as Drive does: 404 for a folder it cannot find. */
  const make = (
    response: ServerResponse,
    metadata: Json,
    content: { readonly type: string; readonly bytes: Buffer } | undefined,
  ): string | undefined => {
    const parents = (metadata["parents"] ?? []) as string[];
    const [parent] = parents;
    const folder = parent === undefined ? undefined : files.get(parent);
    if (folder?.mimeType !== folderType || folder.trashed) {
      notFound(response, String(parent));
      return undefined;
    }
    const mimeType = asString(metadata["mimeType"], "");
    const id = newId();
    const properties = (metadata["appProperties"] ?? {}) as Record<
      string,
      string
    >;
    for (const [key, value] of Object.entries(properties)) {
      if (Buffer.byteLength(key + value) > 124) {
        throw new BadRequest("A property's key and value exceed 124 bytes.");
      }
    }
    files.set(id, {
      id,
      name: asString(metadata["name"], "Untitled"),
      mimeType,
      parents,
      appProperties: { ...properties },
      content:
        mimeType === documentType || mimeType === presentationType
          ? undefined
          : content?.bytes,
      createdAt: (created += 1),
      trashed: false,
    });
    if (mimeType === documentType) {
      documents.set(id, {
        revision: 1,
        chars:
          content === undefined
            ? [{ c: "\n", bold: false, link: undefined, style: "NORMAL_TEXT" }]
            : content.type.startsWith("text/html")
              ? htmlToDocument(content.bytes.toString("utf8"))
              : units(content.bytes.toString("utf8")).map((c) => ({
                  c,
                  bold: false,
                  link: undefined,
                })),
      });
    }
    if (mimeType === presentationType) {
      // A new deck has one title slide, as Google makes it.
      presentations.set(id, [
        {
          objectId: "p",
          layout: "TITLE",
          shapes: [
            { objectId: "i0", placeholder: "CENTERED_TITLE", text: [] },
            { objectId: "i1", placeholder: "SUBTITLE", text: [] },
          ],
        },
      ]);
    }
    return id;
  };

  /** A multipart/related upload's metadata and media. */
  const multipart = (
    contentType: string,
    bytes: Buffer,
  ): { metadata: Json; media: { type: string; bytes: Buffer } } => {
    const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
    if (boundary === undefined) {
      throw new BadRequest("Multipart upload without a boundary.");
    }
    const parts: { type: string; bytes: Buffer }[] = [];
    const delimiter = Buffer.from(`--${boundary}`);
    let at = bytes.indexOf(delimiter);
    while (at !== -1) {
      const start = at + delimiter.length;
      if (bytes.subarray(start, start + 2).toString() === "--") {
        break;
      }
      const next = bytes.indexOf(delimiter, start);
      if (next === -1) {
        throw new BadRequest("Multipart upload without its closing boundary.");
      }
      const part = bytes.subarray(start + 2, next - 2);
      const split = part.indexOf("\r\n\r\n");
      const headers = part.subarray(0, split).toString("utf8");
      parts.push({
        type: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1] ?? "",
        bytes: part.subarray(split + 4),
      });
      at = next;
    }
    const [metadata, media] = parts;
    if (
      metadata === undefined ||
      media === undefined ||
      !metadata.type.startsWith("application/json")
    ) {
      throw new BadRequest(
        "A multipart upload is its metadata, then its media.",
      );
    }
    return {
      metadata: JSON.parse(metadata.bytes.toString("utf8")) as Json,
      media,
    };
  };

  /** Drive's search, for the `q` AI Office writes. */
  const search = (q: string) => {
    const unquote = (value: string) => value.replaceAll(/\\(.)/g, "$1");
    const parent = /'((?:\\.|[^'\\])*)' in parents/.exec(q)?.[1];
    const property =
      /appProperties has \{ key='((?:\\.|[^'\\])*)' and value='((?:\\.|[^'\\])*)' \}/.exec(
        q,
      );
    return [...files.values()]
      .filter(
        (file) =>
          (parent === undefined || file.parents.includes(unquote(parent))) &&
          (property === null ||
            file.appProperties[unquote(property[1] ?? "")] ===
              unquote(property[2] ?? "")) &&
          (!q.includes("trashed = false") || !file.trashed),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  };

  const documentJson = (
    id: string,
    document: { revision: number; chars: Char[] },
  ) => {
    let index = 1;
    return {
      documentId: id,
      title: files.get(id)?.name,
      revisionId: `rev-${String(document.revision)}`,
      body: {
        content: [
          { endIndex: 1, sectionBreak: {} },
          ...paragraphsOf(document.chars).map((paragraph) => {
            const startIndex = index;
            const elements = runsOf(paragraph).map((run) => {
              const element = {
                startIndex: index,
                endIndex: index + run.text.length,
                textRun: {
                  content: run.text,
                  textStyle: {
                    ...(run.bold ? { bold: true } : {}),
                    ...(run.link === undefined
                      ? {}
                      : { link: { url: run.link } }),
                  },
                },
              };
              index += run.text.length;
              return element;
            });
            return {
              startIndex,
              endIndex: index,
              paragraph: {
                elements,
                paragraphStyle: {
                  namedStyleType: paragraph.at(-1)?.style ?? "NORMAL_TEXT",
                },
              },
            };
          }),
        ],
      },
    };
  };

  /** A Docs batch update, applied whole or not at all. */
  const updateDocument = (
    document: { revision: number; chars: Char[] },
    body: Json,
  ) => {
    const required = (body["writeControl"] as Json | undefined)?.[
      "requiredRevisionId"
    ];
    if (
      required !== undefined &&
      required !== `rev-${String(document.revision)}`
    ) {
      throw new BadRequest(
        "The required revision ID does not match the latest.",
      );
    }
    const chars = document.chars.map((char) => ({ ...char }));
    for (const request of (body["requests"] ?? []) as Json[]) {
      const insert = request["insertText"] as Json | undefined;
      const style = request["updateTextStyle"] as Json | undefined;
      if (insert !== undefined) {
        const index = Number(
          (insert["location"] as Json | undefined)?.["index"],
        );
        const text = asString(insert["text"], "");
        if (
          !Number.isInteger(index) ||
          index < 1 ||
          index > chars.length ||
          text === ""
        ) {
          throw new BadRequest(
            "Index must be inside the existing paragraph bounds.",
          );
        }
        // Inserted text takes on the style of the character before it.
        const before = chars[index - 2];
        chars.splice(
          index - 1,
          0,
          ...units(text).map((c) => ({
            c,
            bold: before?.bold ?? false,
            link: before?.link,
            ...(c === "\n" ? { style: "NORMAL_TEXT" } : {}),
          })),
        );
      } else if (style !== undefined) {
        const range = (style["range"] ?? {}) as Json;
        applyStyle(
          chars,
          Number(range["startIndex"]) - 1,
          Number(range["endIndex"]) - 1,
          (style["textStyle"] ?? {}) as Json,
          style["fields"],
        );
      } else {
        throw new BadRequest("Unsupported request.");
      }
    }
    if (chars.at(-1)?.c !== "\n") {
      throw new BadRequest("The document must end with a newline.");
    }
    document.chars = chars;
    document.revision += 1;
  };

  /** A Slides batch update, applied whole or not at all. */
  const updatePresentation = (id: string, body: Json) => {
    const slides = (presentations.get(id) ?? []).map((slide) => ({
      ...slide,
      shapes: slide.shapes.map((shape) => ({
        ...shape,
        text: shape.text.map((char) => ({ ...char })),
      })),
    }));
    const ids = () =>
      new Set(
        slides.flatMap((slide) => [
          slide.objectId,
          ...slide.shapes.map(({ objectId }) => objectId),
        ]),
      );
    const shape = (objectId: unknown) => {
      const found = slides
        .flatMap((slide) => slide.shapes)
        .find((one) => one.objectId === objectId);
      if (found === undefined) {
        throw new BadRequest(
          `The object (${String(objectId)}) could not be found.`,
        );
      }
      return found;
    };
    for (const request of (body["requests"] ?? []) as Json[]) {
      const create = request["createSlide"] as Json | undefined;
      const insert = request["insertText"] as Json | undefined;
      const style = request["updateTextStyle"] as Json | undefined;
      const remove = request["deleteObject"] as Json | undefined;
      if (create !== undefined) {
        const objectId = asString(create["objectId"], newId());
        const layout = String(
          (create["slideLayoutReference"] as Json | undefined)?.[
            "predefinedLayout"
          ],
        );
        const placeholders = layouts[layout];
        if (
          placeholders === undefined ||
          ids().has(objectId) ||
          objectId.length < 5
        ) {
          throw new BadRequest(`Invalid createSlide: ${objectId}.`);
        }
        const mappings = (create["placeholderIdMappings"] ?? []) as Json[];
        const shapes = placeholders.map((placeholder) => ({
          objectId: asString(
            mappings.find(
              (mapping) =>
                (mapping["layoutPlaceholder"] as Json | undefined)?.["type"] ===
                placeholder,
            )?.["objectId"],
            newId(),
          ),
          placeholder,
          text: [] as Char[],
        }));
        for (const mapping of mappings) {
          const type = (mapping["layoutPlaceholder"] as Json | undefined)?.[
            "type"
          ];
          if (!placeholders.includes(String(type))) {
            throw new BadRequest(
              `The layout has no ${String(type)} placeholder.`,
            );
          }
          if (ids().has(String(mapping["objectId"]))) {
            throw new BadRequest(
              `The object ID ${String(mapping["objectId"])} is in use.`,
            );
          }
        }
        const at = Number(create["insertionIndex"] ?? slides.length);
        slides.splice(Math.min(at, slides.length), 0, {
          objectId,
          layout,
          shapes,
        });
      } else if (insert !== undefined) {
        const target = shape(insert["objectId"]);
        const text = asString(insert["text"], "");
        const index = Number(insert["insertionIndex"] ?? 0);
        if (text === "" || index < 0 || index > target.text.length) {
          throw new BadRequest("Invalid insertText.");
        }
        target.text.splice(
          index,
          0,
          ...units(text).map((c) => ({ c, bold: false, link: undefined })),
        );
      } else if (style !== undefined) {
        const target = shape(style["objectId"]);
        const range = (style["textRange"] ?? {}) as Json;
        if (range["type"] !== "FIXED_RANGE") {
          throw new BadRequest("Only fixed ranges.");
        }
        applyStyle(
          target.text,
          Number(range["startIndex"]),
          Number(range["endIndex"]),
          (style["style"] ?? {}) as Json,
          style["fields"],
        );
      } else if (remove !== undefined) {
        const at = slides.findIndex(
          (slide) => slide.objectId === remove["objectId"],
        );
        if (at === -1) {
          throw new BadRequest(
            `The object (${String(remove["objectId"])}) could not be found.`,
          );
        }
        slides.splice(at, 1);
      } else {
        throw new BadRequest("Unsupported request.");
      }
    }
    presentations.set(id, slides);
  };

  const slideView = (slide: FakeSlide): FakeSlideView => ({
    objectId: slide.objectId,
    layout: slide.layout,
    texts: slide.shapes.map((one) => ({
      objectId: one.objectId,
      placeholder: one.placeholder,
      text: one.text.map(({ c }) => c).join(""),
      bold: runsOf(one.text)
        .filter((run) => run.bold)
        .map((run) => run.text),
      links: runsOf(one.text).flatMap((run) =>
        run.link === undefined ? [] : [{ text: run.text, url: run.link }],
      ),
    })),
  });

  return {
    /** Whether `pathname` is Drive's, Docs' or Slides'. */
    handles: (pathname: string): boolean =>
      /^\/(drive\/v3|upload\/drive\/v3)\/files|^\/v1\/(documents|presentations)\//.test(
        pathname,
      ),

    /** Answers a request to Drive, Docs or Slides; `lost` loses a write's answer. */
    handle(
      method: string,
      url: URL,
      contentType: string,
      raw: string,
      bytes: Buffer,
      response: ServerResponse,
      lost: () => boolean,
    ): void {
      const path = url.pathname;
      const done = (status: number, body: unknown) => {
        if (status === 200 && method !== "GET" && lost()) {
          send(response, 502, { error: { code: 502, message: "Bad gateway" } });
          return;
        }
        send(response, status, body);
      };
      try {
        if (method === "GET" && path === "/drive/v3/files") {
          done(200, {
            files: search(url.searchParams.get("q") ?? "").map((file) => ({
              id: file.id,
              mimeType: file.mimeType,
            })),
          });
          return;
        }
        const file = /^\/drive\/v3\/files\/([^/]+)$/.exec(path)?.[1];
        if (method === "GET" && file !== undefined) {
          const found = files.get(decodeURIComponent(file));
          if (found === undefined) {
            notFound(response, file);
            return;
          }
          done(200, {
            id: found.id,
            name: found.name,
            mimeType: found.mimeType,
            trashed: found.trashed,
          });
          return;
        }
        if (method === "POST" && path === "/upload/drive/v3/files") {
          if (url.searchParams.get("uploadType") !== "multipart") {
            throw new BadRequest("Only multipart uploads.");
          }
          const { metadata, media } = multipart(contentType, bytes);
          const id = make(response, metadata, media);
          if (id !== undefined) {
            done(200, { id });
          }
          return;
        }
        if (method === "POST" && path === "/drive/v3/files") {
          const id = make(response, JSON.parse(raw) as Json, undefined);
          if (id !== undefined) {
            done(200, { id });
          }
          return;
        }
        const document = /^\/v1\/documents\/([^/:]+)(:batchUpdate)?$/.exec(
          path,
        );
        if (document !== null) {
          const id = decodeURIComponent(document[1] ?? "");
          const found = documents.get(id);
          if (found === undefined) {
            notFound(response, id);
            return;
          }
          if (method === "GET" && document[2] === undefined) {
            done(200, documentJson(id, found));
            return;
          }
          if (method === "POST" && document[2] !== undefined) {
            updateDocument(found, JSON.parse(raw) as Json);
            done(200, { documentId: id, replies: [] });
            return;
          }
        }
        const deck = /^\/v1\/presentations\/([^/:]+)(:batchUpdate)?$/.exec(
          path,
        );
        if (deck !== null) {
          const id = decodeURIComponent(deck[1] ?? "");
          const found = presentations.get(id);
          if (found === undefined) {
            notFound(response, id);
            return;
          }
          if (method === "GET" && deck[2] === undefined) {
            done(200, {
              presentationId: id,
              slides: found.map((slide) => ({ objectId: slide.objectId })),
            });
            return;
          }
          if (method === "POST" && deck[2] !== undefined) {
            updatePresentation(id, JSON.parse(raw) as Json);
            done(200, { presentationId: id, replies: [] });
            return;
          }
        }
        send(response, 404, { error: { code: 404, message: "Not found." } });
      } catch (error) {
        if (error instanceof BadRequest) {
          send(response, 400, {
            error: {
              code: 400,
              message: error.message,
              status: "INVALID_ARGUMENT",
            },
          });
          return;
        }
        throw error;
      }
    },

    /** The files in a folder (not in the bin), oldest first. */
    files: (folderId: string): FakeDriveFile[] =>
      search(`'${folderId}' in parents and trashed = false`).map(
        ({ id, name, mimeType, parents, appProperties, content }) => ({
          id,
          name,
          mimeType,
          parents,
          appProperties,
          content,
        }),
      ),

    /** A document's paragraphs. */
    document: (documentId: string): FakeDocParagraph[] | undefined => {
      const found = documents.get(documentId);
      return found === undefined
        ? undefined
        : paragraphsOf(found.chars).map((paragraph) => ({
            style: paragraph.at(-1)?.style ?? "NORMAL_TEXT",
            text: paragraph
              .map(({ c }) => c)
              .join("")
              .replace(/\n$/, ""),
            runs: runsOf(paragraph.filter(({ c }) => c !== "\n")),
          }));
    },

    /** A deck's slides, in order. */
    presentation: (presentationId: string): FakeSlideView[] | undefined =>
      presentations.get(presentationId)?.map(slideView),
  };
}
